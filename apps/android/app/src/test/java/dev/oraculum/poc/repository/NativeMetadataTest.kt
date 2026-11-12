package dev.oraculum.poc.repository

import dev.oraculum.poc.ui.InspectorUiState
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class NativeMetadataTest {
    private fun json(value: String) = Json.parseToJsonElement(value).jsonObject
    private fun history(status: String = "completed") = json("""{"items":[{"id":"turn","status":"$status","startedAt":1700000000,"completedAt":1700000002,"durationMs":2150,"items":[{"id":"u","type":"userMessage","content":[{"text":"hello"}]},{"id":"r","type":"reasoning","summary":["thinking"]},{"id":"c","type":"agentMessage","phase":"commentary","text":"working"},{"id":"a","type":"agentMessage","phase":"final_answer","text":"answer"}]}]}""")
    private fun event(method: String, data: String, turn: String = "turn", truncated: Boolean = false) = json("""{"kind":"native.state","scope":{"threadId":"thread","turnId":"$turn"},"payload":{"method":"$method","truncated":$truncated,"data":$data}}""")
    private val usageData = """{"threadId":"thread","turnId":"turn","tokenUsage":{"total":{"totalTokens":1500},"last":{"totalTokens":150,"inputTokens":100,"cachedInputTokens":60,"outputTokens":50},"modelContextWindow":1000}}"""

    @Test fun nativeTurnSecondsAndMillisecondsStayDistinctAndMessageTimesAreNotInvented() {
        val projection = HistoryProjection()
        projection.snapshot(history())
        val messages = projection.messages()
        assertEquals(1700000000000L, messages.last().turn?.startedAtMillis)
        assertEquals(1700000002000L, messages.last().turn?.completedAtMillis)
        assertEquals(2150L, messages.last().turn?.durationMs)
        assertTrue(messages.all { it.timestampMillis == null })
        assertEquals("commentary", messages[2].phase)
        assertEquals("final_answer", messages[3].phase)
    }

    @Test fun producerItemTimeSurvivesSnapshotAndOfflineRestoreWithoutBecomingTurnTime() {
        val projection = HistoryProjection()
        projection.snapshot(JsonObject(history() + ("itemTimings" to json("""{"u":{"startedAtMs":1700000000123},"a":{"completedAtMs":1700000002345}}"""))))
        projection.snapshot(history()) // native full-read fallback has no item envelope timing
        val restored = HistoryProjection()
        restored.restoreCached(projection.cached())
        assertEquals(1700000000123L, restored.messages().first().timestampMillis)
        assertEquals(1700000002345L, restored.messages().last().timestampMillis)
        assertNull(restored.activeTurnId)
        restored.snapshot(json("""{"items":[{"id":"other","status":"completed","items":[{"id":"new","type":"agentMessage","text":"new"}]}]}"""))
        assertNull(restored.messages().single().timestampMillis)
    }

    @Test fun usageIsScopedToTheNativeTurnAndSurvivesReadbackAndCache() {
        val projection = HistoryProjection()
        projection.snapshot(history())
        projection.event(event("thread/tokenUsage/updated", usageData))
        projection.snapshot(history())
        val restored = HistoryProjection()
        restored.restoreCached(projection.cached())
        assertEquals(150L, restored.messages().last().turn?.usage?.totalTokens)
        assertEquals(60L, restored.messages().last().turn?.usage?.cachedInputTokens)
        val inspector = InspectorProjection()
        inspector.restoreUsage(restored.cachedTokenUsage())
        assertEquals(1500L, inspector.state(InspectorUiState()).tokenUsage?.total?.totalTokens)
        assertEquals(150L, inspector.state(InspectorUiState()).tokenUsage?.last?.totalTokens)
        inspector.history(json("""{"items":[{"id":"other","status":"completed","items":[]}]}"""), replace = true)
        assertNull(inspector.state(InspectorUiState()).tokenUsage)
        restored.snapshot(json("""{"items":[{"id":"other","status":"completed","items":[{"id":"new","type":"agentMessage","text":"new"}]}]}"""))
        assertNull(restored.messages().single().turn?.usage)
        assertNull(restored.cachedTokenUsage())
    }

    @Test fun mismatchedOrTruncatedUsageDoesNotAttachToTurn() {
        val projection = HistoryProjection()
        projection.snapshot(history())
        projection.event(event("thread/tokenUsage/updated", usageData, turn = "other"))
        projection.event(event("thread/tokenUsage/updated", usageData, truncated = true))
        assertNull(projection.messages().last().turn?.usage)
    }

    @Test fun authoritativeTurnReplacementClearsInspectorCountersButPaginationDoesNot() {
        val inspector = InspectorProjection()
        inspector.event(event("thread/tokenUsage/updated", usageData))
        inspector.history(history(), replace = true)
        assertEquals(1500L, inspector.state(InspectorUiState()).tokenUsage?.total?.totalTokens)
        // An older page does not replace the selected head and cannot invalidate its usage.
        inspector.history(json("""{"items":[{"id":"older","status":"completed","items":[]}]}"""))
        assertEquals(1500L, inspector.state(InspectorUiState()).tokenUsage?.total?.totalTokens)
        inspector.history(json("""{"items":[{"id":"older-item","type":"agentMessage","text":"old"}]}"""), turnId = "older")
        assertEquals(1500L, inspector.state(InspectorUiState()).tokenUsage?.total?.totalTokens)
        // Current authoritative history replaced by a rollback/compaction has no originating Turn.
        inspector.history(json("""{"items":[{"id":"remaining","status":"completed","items":[]}]}"""), replace = true)
        assertNull(inspector.state(InspectorUiState()).tokenUsage)
        assertNull(inspector.state(InspectorUiState()).usage)
    }

    @Test fun unscopedUsageCannotOutliveAuthoritativeHistoryBecauseItIsNotAccepted() {
        val inspector = InspectorProjection()
        inspector.event(event("thread/tokenUsage/updated", """{"tokenUsage":{"total":{"totalTokens":1500}}}"""))
        assertNull(inspector.state(InspectorUiState()).tokenUsage)
        inspector.restoreUsage(json("""{"total":{"totalTokens":1500}}"""))
        assertNull(inspector.state(InspectorUiState()).usage)
    }

    @Test fun completionMetadataIsAvailableBeforeSnapshotWithoutAuthorizingWrites() {
        val projection = HistoryProjection()
        projection.snapshot(history("inProgress"))
        assertNull(projection.messages().last().turn?.durationMs)
        projection.event(event("turn/completed", """{"turn":{"id":"turn","status":"completed","startedAt":1700000000,"completedAt":1700000002,"durationMs":2025}}"""))
        assertEquals("completed", projection.messages().last().turn?.status)
        assertEquals(2025L, projection.messages().last().turn?.durationMs)
    }

    @Test fun invalidNativeCountersAndTimesRemainUnknown() {
        assertNull(tokenUsage(json("""{"total":{"totalTokens":-1,"inputTokens":"12","outputTokens":1.2},"last":{"cachedInputTokens":9007199254740992},"modelContextWindow":0}""")))
        val turn = nativeTurnMetadata(json("""{"status":"completed","startedAt":1700000000000,"completedAt":1700000000001,"durationMs":-1}"""))
        assertNull(turn.startedAtMillis); assertNull(turn.completedAtMillis); assertNull(turn.durationMs)
        assertEquals(2000L, nativeTurnMetadata(json("""{"status":"completed","startedAt":1700000000,"completedAt":1700000002}""")).durationMs)
        assertNull(nativeTurnMetadata(json("""{"status":"completed","startedAt":1700000002,"completedAt":1700000000}""")).durationMs)
    }

    @Test fun actualToolFailuresRemainVisibleAndUnknownAssistantPhaseStaysUnknown() {
        val projection = HistoryProjection()
        projection.snapshot(json("""{"items":[{"id":"turn","status":"completed","items":[{"id":"bad","type":"commandExecution","exitCode":1,"command":"false"},{"id":"unknown","type":"agentMessage","text":"answer","phase":null}]}]}"""))
        assertTrue(projection.messages().first().needsAttention)
        assertNull(projection.messages().last().phase)
        val restored = HistoryProjection(); restored.restoreCached(projection.cached())
        assertTrue(restored.messages().first().needsAttention)
    }

    @Test fun liveNativeItemLifecycleTimeIsPreservedThroughReadback() {
        val projection = HistoryProjection()
        projection.event(json("""{"kind":"item.completed","scope":{"itemId":"a","turnId":"turn"},"payload":{"complete":true,"completedAtMs":1700000002345,"item":{"data":{"id":"a","type":"agentMessage","text":"answer","phase":"final_answer"}}}}"""))
        projection.snapshot(history())
        assertEquals(1700000002345L, projection.messages().last().timestampMillis)
    }
}
