package dev.oraculum.poc.notifications

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

class NotificationPolicyTest {
    @Test fun terminalNativeTurnFactsChooseImportanceAndRouteWithoutCopyingPrivateOutput() {
        val completed = classifyNotification(SCOPE, turn("completed"))!!
        assertEquals(NoticeKind.TURN, completed.kind)
        assertEquals(NotificationRoute(SCOPE, PROJECT, THREAD, "execution"), completed.route)
        assertEquals(NoticeKind.TURN, classifyNotification(SCOPE, turn("interrupted"))!!.kind)
        val failed = classifyNotification(SCOPE, turn("failed"))!!
        assertEquals(NoticeKind.ERROR, failed.kind)
        assertFalse(failed.text.contains("private provider error"))
        assertEquals(completed.nativeKey, failed.nativeKey)
    }

    @Test fun pendingInteractionsNotifyAndOtherDeviceResolutionCancelsTheSameNativeNotice() {
        val opened = classifyNotification(SCOPE, interaction("interaction.opened", "pending"))!!
        assertEquals(NoticeKind.ATTENTION, opened.kind)
        assertEquals("approvals", opened.route.inspector)
        for (status in listOf("submitted", "unknown", "resolved")) {
            val resolved = classifyNotification(SCOPE, interaction("interaction.resolved", status, 2))!!
            assertTrue(resolved.cancel)
            assertEquals(opened.nativeKey, resolved.nativeKey)
        }
        assertNull(classifyNotification(SCOPE, interaction("interaction.opened", "resolved")))
        assertNull(classifyNotification(SCOPE, interaction("interaction.resolved", "pending")))
    }

    @Test fun malformedTruncatedUnscopedAndUnsupportedEventsNeverBecomeNotices() {
        assertNull(classifyNotification(SCOPE, turn("inProgress")))
        assertNull(classifyNotification(SCOPE, turn("future-status")))
        assertNull(classifyNotification(SCOPE, turn("completed", truncated = true)))
        assertNull(classifyNotification(SCOPE, turn("completed", threadInPayload = "other-thread")))
        assertNull(classifyNotification(SCOPE, event("native.state", buildJsonObject { put("method", "turn/completed") })))
        assertNull(classifyNotification(SCOPE, event("operation.changed", buildJsonObject { put("status", "unknown") })))
        assertNull(classifyNotification(SCOPE, event("item.completed", buildJsonObject { put("type", "agentMessage") })))
        assertNull(classifyNotification(SCOPE, turn("completed", seq = 0)))
        assertNull(classifyNotification(SCOPE, turn("completed", seq = 9_007_199_254_740_992L)))
        assertNull(classifyNotification(SCOPE, interaction("interaction.opened", "pending", projectInPayload = OTHER)))
        assertNull(classifyNotification(SCOPE, interaction("interaction.opened", "pending", epochInPayload = OTHER)))
        assertNull(classifyNotification(SCOPE, interaction("interaction.opened", "pending", kind = "future-action")))
    }

    @Test fun replaySequenceAndNativeIdentityAreIndependentAndScopeIsolated() {
        val first = classifyNotification(SCOPE, turn("completed"))!!
        val replay = classifyNotification(SCOPE, turn("completed", seq = 9))!!
        assertNotEquals(first.eventKey, replay.eventKey)
        assertEquals(first.nativeKey, replay.nativeKey)
        val epochReset = classifyNotification(SCOPE, turn("completed", epoch = OTHER))!!
        assertNotEquals(first.eventKey, epochReset.eventKey)
        assertEquals(first.nativeKey, epochReset.nativeKey)
        val otherScope = classifyNotification("another-endpoint/device", turn("completed"))!!
        assertNotEquals(first.nativeKey, otherScope.nativeKey)
        assertNotEquals(first.eventKey, otherScope.eventKey)
        assertFalse(first.nativeKey.contains(THREAD))
        assertEquals(64, first.nativeKey.length)
    }

    private fun turn(status: String, seq: Long = 1, epoch: String = EPOCH, truncated: Boolean = false, threadInPayload: String = THREAD) =
        event("native.state", buildJsonObject {
            put("method", "turn/completed"); put("truncated", truncated)
            put("data", buildJsonObject {
                put("threadId", threadInPayload)
                put("turn", buildJsonObject {
                    put("id", "native-turn"); put("status", status)
                    put("error", buildJsonObject { put("message", "private provider error") })
                })
            })
        }, seq, epoch)

    private fun interaction(eventKind: String, status: String, seq: Long = 1, projectInPayload: String = PROJECT,
                            epochInPayload: String = EPOCH, kind: String = "command") = event(eventKind, buildJsonObject {
        put("interactionId", INTERACTION); put("projectId", projectInPayload); put("threadId", THREAD)
        put("turnId", "native-turn"); put("epoch", epochInPayload); put("generation", 1)
        put("kind", kind); put("status", status); put("request", buildJsonObject { put("command", "private command") })
    }, seq)

    private fun event(kind: String, payload: JsonObject, seq: Long = 1, epoch: String = EPOCH) = buildJsonObject {
        put("installationId", INSTALLATION); put("epoch", epoch); put("seq", seq); put("kind", kind); put("impact", "state")
        put("scope", buildJsonObject { put("projectId", PROJECT); put("threadId", THREAD) }); put("payload", payload)
    }

    companion object {
        private const val SCOPE = "https://gateway.invalid/base/:installation:device"
        private const val PROJECT = "12345678-1234-4123-8123-123456789abc"
        private const val INSTALLATION = "22345678-1234-4123-8123-123456789abc"
        private const val EPOCH = "32345678-1234-4123-8123-123456789abc"
        private const val INTERACTION = "42345678-1234-4123-8123-123456789abc"
        private const val OTHER = "52345678-1234-4123-8123-123456789abc"
        private const val THREAD = "native-thread"
    }
}
