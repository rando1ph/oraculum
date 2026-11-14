package dev.oraculum.poc.repository

import org.junit.Assert.*
import org.junit.Test
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.put

class RecoveryRulesTest {
    @Test fun `terminal native item wins over late delta and stale active snapshot`() {
        val completed = mergeItem(null, "item", "turn", "agentMessage", ItemUpdate.COMPLETED, "complete")
        assertEquals(completed, mergeItem(completed, "item", "turn", "agentMessage", ItemUpdate.DELTA, "late"))
        assertEquals(completed, mergeItem(completed, "item", "turn", "agentMessage", ItemUpdate.SNAPSHOT, "stale", terminal = false))
    }

    @Test fun `recovered baseline is never appended with unpositioned stream`() {
        val recovered = mergeItem(null, "item", "turn", "agentMessage", ItemUpdate.SNAPSHOT, "partial")
        val delta = mergeItem(recovered, "item", "turn", "agentMessage", ItemUpdate.DELTA, "partial plus more")
        assertEquals("partial", delta.visibleText)
        assertEquals("partial plus more", mergeItem(delta, "item", "turn", "agentMessage", ItemUpdate.COMPLETED, "partial plus more").visibleText)
    }

    @Test fun `sequence gaps epoch and installation changes reset before applying`() {
        val position = EventPosition("installation", "epoch", 40)
        assertEquals(EventDecision.APPLY, acceptEvent(position, "installation", "epoch", 41, "item.delta", "state"))
        assertEquals(EventDecision.RESET, acceptEvent(position, "installation", "epoch", 42, "item.delta", "state"))
        assertEquals(EventDecision.RESET, acceptEvent(position, "installation", "new", 41, "item.delta", "state"))
        assertEquals(EventDecision.RESET, acceptEvent(position, "other", "epoch", 41, "item.delta", "state"))
        assertEquals(EventDecision.DUPLICATE, acceptEvent(position, "installation", "epoch", 40, "item.delta", "state"))
        assertEquals(EventDecision.INVALIDATE, acceptEvent(position, "installation", "epoch", 41, "future.kind", null))
        assertEquals(EventDecision.SKIP, acceptEvent(position, "installation", "epoch", 41, "future.kind", "informational"))
    }

    @Test fun `unknown gates project or thread and never becomes retry queue`() {
        val thread = listOf(PendingIntent("project", "thread", "turn.start", "unknown"))
        assertTrue(blocksWrite(thread, "project", "thread"))
        assertFalse(blocksWrite(thread, "project", "another"))
        assertTrue(blocksWrite(thread, "project", null))
        val create = listOf(PendingIntent("project", null, "thread.start", "unknown"))
        assertTrue(blocksWrite(create, "project", "another"))
        assertFalse(blocksWrite(create, "other-project", "another"))
        assertFalse(blocksWrite(create, "other-project", null))
        assertTrue(blocksWrite(create, "project", null))
        assertTrue(blocksWrite(listOf(PendingIntent("", null, "project.register", "unknown")), "other-project", null))
    }

    @Test fun `unrelated project events do not invalidate the selected thread but unknown scope does`() {
        assertFalse(eventAffectsSelection("other", null, "selected", "thread"))
        assertFalse(eventAffectsSelection("selected", "other-thread", "selected", "thread"))
        assertTrue(eventAffectsSelection("selected", null, "selected", "thread"))
        assertTrue(eventAffectsSelection(null, null, "selected", "thread"))
        assertTrue(eventAffectsSelection(null, "thread", "selected", "thread"))
    }

    @Test fun `overflow is explicitly incomplete rather than silently clipped`() {
        val result = mergeItem(null, "item", "turn", "agentMessage", ItemUpdate.COMPLETED, "神谕".repeat(50), maxBytes = 32)
        assertTrue(result.detailsRequired)
        assertEquals("", result.visibleText)
    }

    @Test fun `ordinary snapshot preserves continuous started stream and invalidation discards it`() {
        val history = HistoryProjection()
        fun event(kind: String, payload: String) = Json.parseToJsonElement("""{"kind":"$kind","scope":{"itemId":"item","turnId":"turn"},"payload":$payload}""").jsonObject
        history.event(event("item.started", """{"item":{"id":"item","type":"agentMessage","data":{"id":"item","type":"agentMessage","text":""}},"complete":true}"""))
        history.event(event("item.delta", """{"delta":"first"}"""))
        val snapshot = Json.parseToJsonElement("""{"items":[{"id":"turn","status":"inProgress","items":[{"id":"item","type":"agentMessage","text":"first"}]}],"truncated":false}""").jsonObject
        history.snapshot(snapshot)
        history.event(event("item.delta", """{"delta":" second"}"""))
        assertEquals("first second", history.messages().single().text)
        history.invalidate()
        history.snapshot(snapshot, preserveTerminal = false)
        history.event(event("item.delta", """{"delta":" duplicate first"}"""))
        assertEquals("first", history.messages().single().text)
        history.event(event("item.completed", """{"item":{"id":"item","type":"agentMessage","data":{"id":"item","type":"agentMessage","text":"authoritative"}},"complete":true}"""))
        history.event(event("item.delta", """{"delta":" stale"}"""))
        assertEquals("authoritative", history.messages().single().text)
    }

    @Test fun `active turn item pagination never declares active item terminal`() {
        val history = HistoryProjection()
        history.snapshot(Json.parseToJsonElement("""{"items":[{"id":"turn","status":"inProgress","items":[]}],"truncated":false}""").jsonObject)
        history.applyHistory(Json.parseToJsonElement("""{"items":[{"id":"item","type":"agentMessage","text":"partial"}],"truncated":false}""").jsonObject, "turn")
        assertEquals("正在同步", history.messages().single().status)
    }

    @Test fun `older item page remains inside its native turn chronological position`() {
        val history = HistoryProjection()
        history.snapshot(Json.parseToJsonElement("""{"items":[{"id":"A","status":"completed","items":[{"id":"a","type":"agentMessage","text":"first turn"}]},{"id":"B","status":"completed","items":[{"id":"b2","type":"agentMessage","text":"second turn later item"}]}],"truncated":false}""").jsonObject)
        history.applyHistory(Json.parseToJsonElement("""{"items":[{"id":"b1","type":"agentMessage","text":"second turn earlier item"}],"truncated":false}""").jsonObject, "B", older = true)
        assertEquals(listOf("a", "b1", "b2"), history.messages().map { it.id })
    }

    @Test fun `snapshot in flight cannot erase subsequently observed completed item`() {
        val history = HistoryProjection()
        val versionAtRead = 4L
        history.event(Json.parseToJsonElement("""{"kind":"item.completed","scope":{"itemId":"new","turnId":"turn"},"payload":{"item":{"id":"new","type":"agentMessage","data":{"id":"new","type":"agentMessage","text":"completed"}},"complete":true}}""").jsonObject)
        val oldSnapshot = Json.parseToJsonElement("""{"items":[],"truncated":false}""").jsonObject
        if (snapshotStillCurrent(7, 7, versionAtRead, 5)) history.snapshot(oldSnapshot)
        assertEquals("completed", history.messages().single().text)
        assertFalse(snapshotStillCurrent(7, 8, 5, 5))
        // A new snapshot obtained after an explicit invalidation may represent deletion/compaction.
        assertTrue(snapshotStillCurrent(8, 8, 6, 6))
        history.snapshot(oldSnapshot, preserveTerminal = false)
        assertTrue(history.messages().isEmpty())
    }

    @Test fun `synthetic long history and oversized item are visibly bounded`() {
        fun page(count: Int, text: String) = buildJsonObject {
            put("truncated", false)
            put("items", buildJsonArray { add(buildJsonObject {
                put("id", "turn"); put("status", "completed")
                put("items", buildJsonArray { repeat(count) { index -> add(buildJsonObject {
                    put("id", "item-$index"); put("type", "agentMessage"); put("text", text)
                }) } })
            }) })
        }
        val history = HistoryProjection()
        history.snapshot(page(270, "bounded"))
        assertEquals(250, history.messages().size)
        assertTrue(history.limited)
        history.snapshot(page(1, "大".repeat(30_000)), preserveTerminal = false)
        assertTrue(history.limited)
        assertEquals("内容未完整显示", history.messages().single().status)
        assertTrue(history.messages().single().text.length < 100)
    }

    @Test fun `obviously invalid registration paths fail before operation reservation`() {
        assertTrue(validProjectRelativePath("workspaces/native-poc"))
        listOf("", "/absolute", "../escape", "one/../two", "one//two", "one/", "one\\two", "one/%2e", "one/\u0000two").forEach {
            assertFalse(it, validProjectRelativePath(it))
        }
    }
}
