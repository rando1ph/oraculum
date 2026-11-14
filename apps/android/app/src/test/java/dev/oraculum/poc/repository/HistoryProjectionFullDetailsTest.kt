package dev.oraculum.poc.repository

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

class HistoryProjectionFullDetailsTest {
    @Test fun verifiedResponseBeyondPreviewBudgetIsShownInFull() {
        val projection = HistoryProjection()
        projection.snapshot(page(item(text = "preview")))
        val full = "神谕".repeat(20_000)
        assertTrue(full.toByteArray(Charsets.UTF_8).size > 64 * 1024)

        assertTrue(projection.applyVerifiedDetail(item(text = full), "turn"))

        val message = projection.messages().single()
        assertEquals(full, message.text)
        assertFalse(message.detailsRequired)
        assertEquals("", message.status)
        assertTrue(projection.isTerminal("item"))
    }

    @Test fun verifiedBytesDoNotDeclareAnActiveItemComplete() {
        val projection = HistoryProjection()
        projection.snapshot(page(item(), status = "inProgress"))

        assertTrue(projection.applyVerifiedDetail(item(text = "verified active response"), "turn"))

        assertFalse(projection.isTerminal("item"))
        assertFalse(projection.messages().single().detailsRequired)
        assertEquals("正在同步", projection.messages().single().status)
        assertEquals("inProgress", projection.messages().single().turn?.status)
    }

    @Test fun detailsCannotCreateAnUnknownItemOrChangeItsTurnOrType() {
        val projection = HistoryProjection()
        projection.snapshot(page(item(text = "preview")))

        assertFalse(projection.applyVerifiedDetail(item(id = "missing"), "turn"))
        assertThrows(IllegalArgumentException::class.java) {
            projection.applyVerifiedDetail(item(), "another-turn")
        }
        assertThrows(IllegalArgumentException::class.java) {
            projection.applyVerifiedDetail(item(type = "reasoning"), "turn")
        }

        assertEquals("preview", projection.messages().single().text)
        assertTrue(projection.messages().single().detailsRequired)
    }

    @Test fun fullDetailBudgetCountsUtf8AcrossItemsWithoutPartialPublication() {
        val projection = HistoryProjection(maxVerifiedBytes = 8)
        projection.snapshot(page(item(id = "a", text = "preview-a"), item(id = "b", text = "preview-b")))
        assertTrue(projection.applyVerifiedDetail(item(id = "a", text = "你好"), "turn"))

        assertThrows(IllegalArgumentException::class.java) {
            projection.applyVerifiedDetail(item(id = "b", text = "世界"), "turn")
        }

        val messages = projection.messages().associateBy { it.id }
        assertEquals("你好", messages.getValue("a").text)
        assertFalse(messages.getValue("a").detailsRequired)
        assertEquals("preview-b", messages.getValue("b").text)
        assertTrue(messages.getValue("b").detailsRequired)
    }

    @Test fun replacingTheSameVerifiedItemReusesItsBudgetAndOverflowKeepsPriorText() {
        val projection = HistoryProjection(maxVerifiedBytes = 6)
        projection.snapshot(page(item()))
        assertTrue(projection.applyVerifiedDetail(item(text = "你好"), "turn"))
        assertTrue(projection.applyVerifiedDetail(item(text = "世界"), "turn"))

        assertThrows(IllegalArgumentException::class.java) {
            projection.applyVerifiedDetail(item(text = "七个字"), "turn")
        }

        assertEquals("世界", projection.messages().single().text)
        assertFalse(projection.messages().single().detailsRequired)
    }

    @Test fun invalidationAndClearDropVerifiedTextAndKeepThePreviewTruth() {
        val projection = HistoryProjection()
        val preview = page(item(text = "bounded preview"))
        projection.snapshot(preview)
        assertTrue(projection.applyVerifiedDetail(item(text = "full response"), "turn"))

        projection.invalidate()

        assertEquals("bounded preview", projection.messages().single().text)
        assertTrue(projection.messages().single().detailsRequired)
        projection.clear()
        assertTrue(projection.messages().isEmpty())
        projection.snapshot(preview)
        assertEquals("bounded preview", projection.messages().single().text)
        assertTrue(projection.messages().single().detailsRequired)
    }

    @Test fun fullVerifiedTextNeverEntersTheOfflineCache() {
        val projection = HistoryProjection()
        projection.snapshot(page(item(text = "bounded preview")))
        val full = "unique verified body ".repeat(5_000)
        assertTrue(projection.applyVerifiedDetail(item(text = full), "turn"))

        val cache = projection.cached()
        assertFalse(cache.toString().contains(full))
        assertTrue(cache.toString().length < 8 * 1024)
        val restored = HistoryProjection()
        restored.restoreCached(cache)

        assertEquals("bounded preview", restored.messages().single().text)
        assertTrue(restored.messages().single().detailsRequired)
        assertNull(restored.activeTurnId)
    }

    @Test fun ordinarySnapshotRetainsOnlyTheSameTerminalVerifiedItem() {
        val projection = HistoryProjection()
        val preview = page(item(text = "bounded preview"))
        projection.snapshot(preview)
        assertTrue(projection.applyVerifiedDetail(item(text = "verified response"), "turn"))

        projection.snapshot(preview, preserveTerminal = true)
        assertEquals("verified response", projection.messages().single().text)
        assertFalse(projection.messages().single().detailsRequired)

        projection.snapshot(preview, preserveTerminal = false)
        assertEquals("bounded preview", projection.messages().single().text)
        assertTrue(projection.messages().single().detailsRequired)
    }

    @Test fun snapshotCannotCarryVerifiedTextToAnotherTurnOrItemType() {
        val projection = HistoryProjection()
        projection.snapshot(page(item(text = "first preview")))
        assertTrue(projection.applyVerifiedDetail(item(text = "verified response"), "turn"))

        projection.snapshot(page(item(text = "another turn preview"), turn = "another-turn"), preserveTerminal = true)
        assertEquals("another-turn", projection.messages().single().turnId)
        assertEquals("another turn preview", projection.messages().single().text)
        assertTrue(projection.messages().single().detailsRequired)

        assertTrue(projection.applyVerifiedDetail(item(text = "new verified response"), "another-turn"))
        projection.snapshot(page(item(type = "reasoning"), turn = "another-turn"), preserveTerminal = true)
        assertNotEquals("new verified response", projection.messages().single().text)
        assertEquals("reasoning", projection.messages().single().role)
        assertTrue(projection.messages().single().detailsRequired)
    }

    @Test fun activeAndRemovedItemsDoNotKeepVerifiedOverlaysAcrossSnapshots() {
        val projection = HistoryProjection()
        projection.snapshot(page(item(), status = "inProgress"))
        assertTrue(projection.applyVerifiedDetail(item(text = "active verified response"), "turn"))

        projection.snapshot(page(item(text = "new preview"), status = "inProgress"), preserveTerminal = true)
        assertEquals("new preview", projection.messages().single().text)
        assertTrue(projection.messages().single().detailsRequired)

        assertTrue(projection.applyVerifiedDetail(item(text = "another verified response"), "turn"))
        projection.snapshot(page(), preserveTerminal = true)
        assertTrue(projection.messages().isEmpty())
        projection.snapshot(page(item(text = "returned preview")), preserveTerminal = true)
        assertEquals("returned preview", projection.messages().single().text)
        assertTrue(projection.messages().single().detailsRequired)
    }

    @Test fun evictedItemsReleaseTheirVerifiedBudget() {
        val projection = HistoryProjection(maxItems = 1, maxVerifiedBytes = 6)
        projection.snapshot(page(item(id = "a")))
        assertTrue(projection.applyVerifiedDetail(item(id = "a", text = "你好"), "turn"))

        projection.applyHistory(page(item(id = "b")), older = false)

        assertEquals(listOf("b"), projection.messages().map { it.id })
        assertTrue(projection.applyVerifiedDetail(item(id = "b", text = "世界"), "turn"))
        assertEquals("世界", projection.messages().single().text)
    }

    @Test fun incompleteContentHasNoPlaceholderOrStatusWhileRealFailureAndStopRemain() {
        listOf("completed" to "", "failed" to "本轮失败", "interrupted" to "本轮已停止").forEach { (status, expected) ->
            val projection = HistoryProjection()
            projection.snapshot(page(item(text = ""), status = status))
            val incomplete = projection.messages().single()
            assertEquals("", incomplete.text)
            assertEquals(expected, incomplete.status)
            assertTrue(incomplete.detailsRequired)

            assertTrue(projection.applyVerifiedDetail(item(text = "verified response"), "turn"))
            assertEquals(expected, projection.messages().single().status)
            assertFalse(projection.messages().single().detailsRequired)
        }
    }

    private fun item(id: String = "item", text: String = "preview", type: String = "agentMessage") = buildJsonObject {
        put("id", id)
        put("type", type)
        put("text", text)
    }

    private fun page(
        vararg items: JsonObject,
        turn: String = "turn",
        status: String = "completed",
    ) = buildJsonObject {
        put("truncated", true)
        put("items", buildJsonArray {
            add(buildJsonObject {
                put("id", turn)
                put("status", status)
                put("items", buildJsonArray { items.forEach { add(it) } })
            })
        })
    }
}
