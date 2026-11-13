package dev.oraculum.poc.repository

import dev.oraculum.poc.ui.InspectorUiState
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest
import java.util.Base64

class InspectorProjectionTest {
    private val epoch = "00000000-0000-4000-8000-000000000001"
    private val bytes = """{"id":"item-1","type":"agentMessage","text":"原生 ✓"}""".toByteArray()
    private fun chunk(offset: Int, length: Int, digest: String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }, revision: String = "r1") = buildJsonObject {
        put("epoch", epoch); put("itemId", "item-1"); put("historyRevision", revision)
        put("encoding", "base64"); put("format", "native-item-json"); put("sha256", digest)
        put("offsetBytes", offset); put("totalBytes", bytes.size)
        put("chunk", Base64.getEncoder().encodeToString(bytes.copyOfRange(offset, offset + length)))
        put("complete", offset + length == bytes.size)
        put("nextCursor", if (offset + length == bytes.size) JsonNull else JsonPrimitive("next"))
    }
    @Test fun detailsOnlyPublishAfterContiguousDigestVerifiedUtf8() {
        val accumulator = ItemDetailAccumulator("item-1", epoch)
        assertNull(accumulator.append(chunk(0, 7)))
        assertFalse(accumulator.finished)
        val item = accumulator.append(chunk(7, bytes.size - 7))
        assertEquals("原生 ✓", item?.string("text"))
        assertTrue(accumulator.finished)
    }
    @Test fun corruptDigestNeverPublishes() {
        assertThrows(IllegalArgumentException::class.java) { ItemDetailAccumulator("item-1", epoch).append(chunk(0, bytes.size, "0".repeat(64))) }
    }
    @Test fun cannotSpliceRevisionsOrOffsets() {
        val revision = ItemDetailAccumulator("item-1", epoch)
        revision.append(chunk(0, 7))
        assertThrows(IllegalArgumentException::class.java) { revision.append(chunk(7, bytes.size - 7, revision = "r2")) }
        val offsets = ItemDetailAccumulator("item-1", epoch)
        assertThrows(IllegalArgumentException::class.java) { offsets.append(chunk(1, 7)) }
        assertThrows(IllegalArgumentException::class.java) { ItemDetailAccumulator("other", epoch).append(chunk(0, bytes.size)) }
    }
    @Test fun oversizeOrWrongCompletionFailsBeforeText() {
        assertThrows(IllegalArgumentException::class.java) { ItemDetailAccumulator("item-1", epoch, 5).append(chunk(0, bytes.size)) }
        val malformed = JsonObject(chunk(0, 7) + ("complete" to JsonPrimitive(true)))
        assertThrows(IllegalArgumentException::class.java) { ItemDetailAccumulator("item-1", epoch).append(malformed) }
    }
    @Test fun modelCatalogPreservesUltraWithoutTreatingItAsGatewayWritable() {
        val models = modelOptions(Json.parseToJsonElement("""{"data":[{"id":"catalog-id","model":"actual-model","displayName":"Model","defaultReasoningEffort":"high","supportedReasoningEfforts":[{"reasoningEffort":"high"},{"reasoningEffort":"ultra"},{"reasoningEffort":"high"},{"reasoningEffort":"unknown-effort"}]}]}""").jsonObject)
        assertEquals("actual-model", models.single().id)
        assertEquals(listOf("high", "ultra"), models.single().efforts)
        assertEquals("high", models.single().defaultEffort)
        assertTrue(isWritableEffort("high"))
        assertFalse(isWritableEffort("ultra"))
        assertFalse(isWritableEffort("unknown-effort"))
    }

    @Test fun nativeUltraDefaultRemainsCatalogFactWithoutBecomingAnExplicitOverride() {
        val models = modelOptions(Json.parseToJsonElement("""{"data":[{"model":"actual-model","defaultReasoningEffort":"ultra","supportedReasoningEfforts":[{"reasoningEffort":"ultra"}]}]}""").jsonObject)
        assertEquals(listOf("ultra"), models.single().efforts)
        assertEquals("ultra", models.single().defaultEffort)
        assertNull(models.single().defaultEffort?.takeIf(::isWritableEffort))
    }

    @Test fun unknownNativeEffortCannotBecomeCatalogDefault() {
        val models = modelOptions(Json.parseToJsonElement("""{"data":[{"model":"actual-model","defaultReasoningEffort":"unknown-effort","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"unknown-effort"}]}]}""").jsonObject)
        assertEquals(listOf("low"), models.single().efforts)
        assertNull(models.single().defaultEffort)
        assertTrue(isWritableEffort("low"))
    }
    @Test fun onlyObservedKnownNativeEventsProjectUsageAndPlan() {
        val projection = InspectorProjection()
        fun event(method: String, data: JsonObject, truncated: Boolean = false) = buildJsonObject {
            put("kind", "native.state"); put("scope", buildJsonObject { put("threadId", "t") })
            put("payload", buildJsonObject { put("method", method); put("data", data); put("truncated", truncated) })
        }
        projection.event(event("thread/tokenUsage/updated", Json.parseToJsonElement("""{"turnId":"turn","tokenUsage":{"total":{"totalTokens":54},"modelContextWindow":1000}}""").jsonObject))
        projection.event(event("turn/diff/updated", buildJsonObject { put("diff", "--- old\n+++ new") }))
        projection.event(event("turn/plan/updated", Json.parseToJsonElement("""{"plan":[{"step":"verify","status":"inProgress"}]}""").jsonObject))
        projection.event(event("thread/tokenUsage/updated", Json.parseToJsonElement("""{"tokenUsage":{"total":{"totalTokens":999}}}""").jsonObject, true))
        val state = projection.state(InspectorUiState())
        assertTrue(state.usage!!.contains("54")); assertFalse(state.usage!!.contains("999"))
        assertEquals("verify", state.plan.single().title)
        assertEquals("--- old\n+++ new", state.diff)
        projection.clear()
        assertNull(projection.state(InspectorUiState()).usage)
    }
    @Test fun failedAndInterruptedTurnsRemainVisibleAfterCacheRestore() {
        val history = Json.parseToJsonElement("""{"items":[{"id":"failed-turn","status":"failed","error":{"message":"native failure"},"items":[{"id":"failed-item","type":"agentMessage","text":"partial"}]},{"id":"stopped-turn","status":"interrupted","items":[{"id":"stopped-item","type":"agentMessage","text":"stopped"}]}]}""").jsonObject
        val chat = HistoryProjection()
        chat.snapshot(history)
        val restored = HistoryProjection()
        restored.restoreCached(chat.cached())
        assertEquals(listOf("本轮失败", "本轮已停止"), restored.messages().map { it.status })
        val inspector = InspectorProjection()
        inspector.history(history)
        assertEquals(listOf("failed", "interrupted"), inspector.state(InspectorUiState()).execution.map { it.status })
        assertEquals("native failure", inspector.state(InspectorUiState()).execution.first().body)
    }
    @Test fun combinedFileChangesHaveOneAggregatePreviewBudget() {
        val projection = InspectorProjection()
        repeat(40) { index ->
            projection.item(buildJsonObject {
                put("id", "change-$index"); put("type", "fileChange")
                put("changes", buildJsonArray { add(buildJsonObject { put("path", "file-$index"); put("diff", "+" + "x".repeat(8192)) }) })
            }, "turn")
        }
        val diff = projection.state(InspectorUiState()).diff!!
        assertTrue(diff.length <= CONTENT_PREVIEW_MAX_CHARACTERS + CONTENT_PREVIEW_NOTICE.length + 2)
        assertTrue(diff.endsWith(CONTENT_PREVIEW_NOTICE))
        assertFalse(diff.contains("file-39"))
    }

    @Test fun previewStopsReadingAdditionalPartsAtAggregateBudget() {
        var partsRead = 0
        val parts = sequence {
            repeat(250) { partsRead++; yield("x".repeat(8192)) }
        }
        val preview = boundedContentPreview(parts)
        assertTrue(preview.truncated)
        assertTrue(preview.text.length <= CONTENT_PREVIEW_MAX_CHARACTERS)
        assertTrue(partsRead < 12)
    }

    @Test fun shortLineFloodAndUnicodeBoundaryRemainBounded() {
        val preview = boundedContentPreview(sequenceOf("+x\n".repeat(100_000)))
        assertTrue(preview.truncated)
        assertTrue(preview.text.lineSequence().count() <= CONTENT_PREVIEW_MAX_LINES)
        val unicode = boundedContentPreview(sequenceOf("ab😀z"), maxCharacters = 3)
        assertEquals("ab", unicode.text)
        assertTrue(unicode.truncated)
        val small = boundedContentPreview(sequenceOf("one", "two"))
        assertEquals("one\n\ntwo", small.text)
        assertFalse(small.truncated)
    }

}
