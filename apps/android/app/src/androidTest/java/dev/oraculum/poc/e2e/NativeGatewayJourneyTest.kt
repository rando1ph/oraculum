package dev.oraculum.poc.e2e

import android.graphics.Bitmap
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.test.espresso.Espresso
import androidx.test.platform.app.InstrumentationRegistry
import dev.oraculum.poc.MainActivity
import dev.oraculum.poc.gateway.GatewayClient
import dev.oraculum.poc.gateway.GatewayEndpoint
import dev.oraculum.poc.gateway.GatewayException
import dev.oraculum.poc.gateway.EventCursor
import dev.oraculum.poc.gateway.GatewayEventListener
import dev.oraculum.poc.ui.PocUiState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.*
import java.io.File
import java.util.UUID
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Opt-in real Gateway/Codex journey. Private input is streamed over adb stdin, never APK assets. */
class NativeGatewayJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val model get() = compose.activity.model
    private val state get() = model.state.value
    private val directory get() = File(context.filesDir, "phase2-evidence").apply { mkdirs() }
    private fun input(): JSONObject {
        val file = File(context.noBackupFilesDir, "phase2-e2e.json")
        assumeTrue("Opt-in private fixture input required", file.isFile)
        return JSONObject(file.readText())
    }
    private fun until(timeout: Long = 120_000, description: String, check: (PocUiState) -> Boolean) {
        val end = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < end) {
            compose.waitForIdle() // Advance Compose frames while observing asynchronous app state.
            if (check(state)) return
            Thread.sleep(50)
        }
        fail("$description; connection=${state.connectionLabel}; error=${state.error}; execution=${state.executionLabel}; anchor=${state.readIndex}:${state.readOffset}")
    }
    private fun screenshot(name: String) {
        compose.waitForIdle()
        Thread.sleep(300) // Let platform dialog/IME transitions finish before taking real pixels.
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        checkNotNull(bitmap) { "Real emulator screenshot unavailable" }
        File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
    private fun record(name: String, extra: JSONObject = JSONObject()) {
        val value = extra.put("passed", true).put("threadId", state.selectedThreadId)
            .put("online", state.online).put("messageCount", state.messages.size)
        File(directory, "$name.json").writeText(value.toString(2))
    }
    private fun checkpoint() = JSONObject(File(directory, "checkpoint.json").readText())

    @Test fun initialPairRegisterChatStop() {
        val config = input()
        until(description = "Fresh app ready") { !it.busy }
        if (state.endpoint != config.getString("endpoint")) {
            compose.runOnIdle { model.endpointChange(config.getString("endpoint")) }
        }
        if (!state.paired) {
            compose.onNodeWithTag("endpoint").performTextReplacement(config.getString("endpoint"))
            compose.onNodeWithTag("pair-code").performTextReplacement(config.getString("pairCode"))
            compose.onNodeWithTag("pair").performClick()
        } else compose.runOnIdle { model.reconnect() }
        until(description = "HTTPS pairing and WSS ready") { it.online && it.paired && !it.busy }
        compose.onNodeWithTag("navigation").performClick()
        if (state.projects.isEmpty()) {
            compose.onNodeWithTag("register_project").performClick()
            compose.onNodeWithTag("project_path").performScrollTo().performTextReplacement(config.getString("projectRelativePath"))
            compose.onNodeWithTag("confirm_register").performScrollTo().performClick()
        }
        until(description = "Registered dedicated project") { it.projects.isNotEmpty() && !it.busy }
        compose.onNodeWithTag("project-${state.projects.single().id}").performScrollTo().performClick()
        until(description = "Dedicated project selected") { it.selectedProjectId != null && !it.busy }
        compose.onNodeWithTag("new-thread").performScrollTo().performClick()
        until(description = "Explicit native thread creation") { it.selectedThreadId != null && !it.busy }
        screenshot("01-paired-native-thread")
        compose.onNodeWithTag("draft").performTextReplacement("Write 80 short numbered greetings in English, then finish with P2_NATIVE_OK. Do not use tools.")
        until(description = "New native thread ready for explicit send") { it.canSend }
        compose.onNodeWithTag("send").assertIsEnabled().performClick()
        var sawStreaming = false
        var sawIncrement = false
        val streamLengths = mutableMapOf<String, Int>()
        until(240_000, "Real streaming response completed") {
            it.messages.filter { m -> m.role == "assistant" && (m.status.contains("流") || m.status.contains("stream", true)) }.forEach { m ->
                sawStreaming = true
                val previous = streamLengths.put(m.id, m.text.length)
                if (previous != null && previous > 1 && m.text.length > previous) sawIncrement = true
            }
            it.messages.any { m -> m.role == "assistant" && m.text.contains("P2_NATIVE_OK") } && !it.canStop && !it.busy
        }
        assertTrue("Real native stream was presented", sawStreaming)
        assertTrue("UI text grew for the same native Item before completion", sawIncrement)
        screenshot("02-real-codex-response")
        compose.onNodeWithTag("draft").performTextReplacement("Write 500 numbered short sentences about trees. Do not use tools.")
        compose.onNodeWithTag("send").performClick()
        until(description = "Observed native active Turn can stop") { it.canStop }
        compose.onNodeWithTag("stop").assertIsEnabled().performClick()
        until(description = "Native interruption converged") { !it.canStop && !it.busy }
        compose.onNodeWithTag("draft").performTextReplacement("LOCAL_DRAFT_DO_NOT_SEND")
        Espresso.closeSoftKeyboard()
        val assistantIndex = state.messages.indexOfFirst { it.role == "assistant" && it.text.contains("P2_NATIVE_OK") }
        assertTrue(assistantIndex > 0)
        compose.onNodeWithTag("conversation").performScrollToIndex(assistantIndex + if (state.canLoadMore) 1 else 0)
        compose.onNodeWithTag("conversation").performTouchInput { swipeUp() }
        compose.waitForIdle() // Settle the fling before recording its durable reading position.
        Thread.sleep(600)
        File(directory, "checkpoint.json").writeText(JSONObject().put("projectId", state.selectedProjectId)
            .put("threadId", state.selectedThreadId).put("draft", state.draft).put("messages", state.messages.size)
            .put("readIndex", state.readIndex).put("readOffset", state.readOffset).toString())
        screenshot("03-native-stop-and-draft")
        record("initial", JSONObject().put("observedUiStreaming", sawStreaming).put("observedUiIncrement", sawIncrement))
    }

    @Test fun stabilizeReadingCheckpoint() {
        input()
        val saved = checkpoint()
        until(description = "Existing real conversation restored before reading checkpoint") {
            it.online && !it.busy && it.selectedThreadId == saved.getString("threadId") && it.messages.isNotEmpty()
        }
        val before = JSONObject().put("previousCheckpointIndex", saved.getInt("readIndex"))
            .put("previousCheckpointOffset", saved.getInt("readOffset"))
            .put("restoredIndex", state.readIndex).put("restoredOffset", state.readOffset)
        val index = state.messages.indexOfFirst { it.role == "assistant" && it.text.contains("P2_NATIVE_OK") }
        assertTrue(index >= 0)
        compose.onNodeWithTag("conversation").performScrollToIndex(index + if (state.canLoadMore) 1 else 0)
        compose.onNodeWithTag("conversation").performTouchInput { swipeUp() }
        compose.waitForIdle()
        Thread.sleep(600)
        saved.put("readIndex", state.readIndex).put("readOffset", state.readOffset)
        File(directory, "checkpoint.json").writeText(saved.toString())
        record("reading-checkpoint", before.put("settledIndex", state.readIndex).put("settledOffset", state.readOffset))
    }

    @Test fun wrongCertificateAndPairingRejected() = runBlocking {
        val config = input()
        val client = GatewayClient(context)
        try {
            client.health(GatewayEndpoint.parse(config.getString("wrongTlsEndpoint")))
            fail("Untrusted TLS certificate must be rejected")
        } catch (error: GatewayException) {
            assertTrue("TLS failure classification", error.code.contains("TLS"))
        }
        val endpoint = GatewayEndpoint.parse(config.getString("endpoint"))
        try {
            client.pair(endpoint, "AAAAAAAAAAAAAAAAAAAAAAAAAAA")
            fail("Invalid one-time pairing code must be rejected")
        } catch (error: GatewayException) {
            assertTrue(error.httpStatus == 401 || error.httpStatus == 403 || error.code == "INVALID_PAIRING")
        }
        assertFalse(client.savedIdentity(endpoint)?.paired ?: false)
        client.disconnect()
        record("wrong-certificate-pairing")
    }

    @Test fun restoreAfterProcessOrEmulatorRestart() {
        input()
        val saved = checkpoint()
        until(description = "Restored identity, thread and local draft") {
            it.paired && it.selectedThreadId == saved.getString("threadId") && it.draft == saved.getString("draft") && it.messages.isNotEmpty()
        }
        assertTrue("No automatic sending", state.messages.none { it.text == "LOCAL_DRAFT_DO_NOT_SEND" })
        until(description = "Nonzero native reading anchor restored") { it.readIndex == saved.getInt("readIndex") && it.readOffset == saved.getInt("readOffset") }
        screenshot("04-restart-restored")
        record("restart")
    }

    @Test fun offlineCacheDraftAndNoWrite() {
        input()
        val saved = checkpoint()
        until(description = "Offline last conversation restored") { !it.online && it.selectedThreadId == saved.getString("threadId") && it.messages.isNotEmpty() }
        assertFalse(state.canSend)
        assertFalse(state.canStop)
        assertFalse(state.canResume)
        compose.onNodeWithTag("draft").performTextReplacement("LOCAL_OFFLINE_DRAFT_DO_NOT_SEND")
        Thread.sleep(600)
        saved.put("draft", state.draft)
        File(directory, "checkpoint.json").writeText(saved.toString())
        screenshot("05-offline-cache-and-draft")
        record("offline")
    }

    @Test fun reconnectAndRebuildCache() {
        input()
        val saved = checkpoint()
        compose.runOnIdle { model.reconnect() }
        until(description = "Reconnected and reconciled native state") { it.online && !it.busy && it.selectedThreadId == saved.getString("threadId") && it.messages.isNotEmpty() }
        val messageIds = state.messages.map { it.id }.toSet()
        compose.runOnIdle { model.clearCache() }
        until(description = "Native cache reconstruction") { it.online && !it.busy && it.messages.map { m -> m.id }.toSet().containsAll(messageIds) }
        assertEquals(saved.getString("draft"), state.draft)
        screenshot("06-reconnected-cache-rebuilt")
        record("rebuild")
    }

    @Test fun newEpochRequiresExplicitResume() {
        input()
        val saved = checkpoint()
        until(description = "New Gateway epoch restored read-only native history") {
            it.online && !it.busy && it.selectedThreadId == saved.getString("threadId") && it.messages.isNotEmpty() && it.canResume
        }
        assertFalse("Unloaded native thread cannot send", state.canSend)
        compose.onNodeWithTag("resume").assertIsEnabled().performClick()
        until(description = "Explicit native resume accepted") { it.online && !it.busy && !it.canResume && it.canSend }
        assertEquals(saved.getString("draft"), state.draft)
        screenshot("11-new-epoch-explicit-resume")
        record("epoch-resume")
    }

    @Test fun expiredAccessRenewsWithoutPairingOrWrite() {
        input()
        until(description = "Connected before controlled access expiry") { it.online && it.paired && !it.busy && it.messages.isNotEmpty() }
        val selected = state.selectedThreadId
        val draft = state.draft
        val trigger = File(context.noBackupFilesDir, "phase2-access-expired")
        trigger.delete()
        File(directory, "access-expiry-ready.json").writeText("{\"ready\":true}")
        val deadline = System.currentTimeMillis() + 90_000
        while (!trigger.exists() && System.currentTimeMillis() < deadline) Thread.sleep(100)
        assertTrue("External fixture clock advanced after access was issued", trigger.exists())
        trigger.delete()
        compose.runOnIdle { model.refresh() }
        until(description = "Access refreshed with original paired identity") {
            assertTrue("Short access expiry must not discard pairing", it.paired)
            it.online && !it.busy && it.selectedThreadId == selected && it.messages.isNotEmpty()
        }
        assertEquals(draft, state.draft)
        screenshot("12-access-renewed")
        record("access-renewed")
    }

    @Test fun revokedDeviceIsReadOnly() {
        val config = input()
        compose.runOnIdle { model.reconnect() }
        until(description = "CLI revoked identity refused") { !it.online && !it.busy && it.error != null }
        assertFalse(state.canSend)
        assertFalse(state.canResume)
        assertFalse(state.canStop)
        assertFalse("Revoked identity cannot remain authenticated", state.paired)
        val client = GatewayClient(context)
        try {
            runBlocking { client.connect(GatewayEndpoint.parse(config.getString("endpoint"))) }
            fail("Fresh access exchange with revoked credentials must fail")
        } catch (error: GatewayException) {
            assertTrue("Revocation is an identity refusal, not a network failure", error.authInvalid)
        } finally { client.disconnect() }
        screenshot("07-revoked-device")
        record("revoked")
    }

    @Test fun liveRevocationClosesAccessAndEvents() {
        input()
        until(description = "Paired HTTP and WSS connected before CLI revocation") { it.online && it.paired && !it.busy }
        File(directory, "revocation-ready.json").writeText("{\"ready\":true}")
        until(description = "CLI revocation invalidated live connection and identity") { !it.online && !it.paired && !it.busy }
        assertFalse(state.canSend)
        assertFalse(state.canStop)
        assertFalse(state.canResume)
        screenshot("13-live-device-revocation")
        record("live-revocation")
    }

    @Test fun invalidProjectPathDoesNotCreateUnknown() {
        input()
        until(description = "Online before invalid project input") { it.online && it.paired && !it.busy }
        compose.runOnIdle { model.registerProject("acceptance", "does-not-exist-phase2") }
        until(description = "Invalid directory rejected before write intent") { !it.busy && it.error != null }
        assertNull("Invalid directory must not create a global unknown barrier", state.unknownWarning)
        record("invalid-project")
    }

    @Test fun invalidHistoryAndEventCursorsResetReadOnly() = runBlocking {
        val config = input()
        val saved = checkpoint()
        val client = GatewayClient(context)
        try {
            val capabilities = client.connect(GatewayEndpoint.parse(config.getString("endpoint")))
            try {
                client.post("threads/${GatewayClient.segment(saved.getString("threadId"))}/history/query", buildJsonObject {
                    put("projectId", saved.getString("projectId")); put("cursor", UUID.randomUUID().toString()); put("limit", 5)
                })
                fail("Unissued history cursor must be rejected")
            } catch (error: GatewayException) {
                assertTrue("Explicit invalid history cursor", error.code.contains("CURSOR"))
            }
            val connection = CompletableDeferred<JsonObject>()
            val socket = client.openEvents(EventCursor(capabilities.getValue("epoch").jsonPrimitive.content, 9_007_199_254_740_991L),
                object : GatewayEventListener {
                    override fun onConnection(message: JsonObject) { connection.complete(message) }
                    override fun onFailure(error: GatewayException) { connection.completeExceptionally(error) }
                })
            try { assertTrue(withTimeout(15_000) { connection.await() }.getValue("resetRequired").jsonPrimitive.boolean) }
            finally { socket.close() }
            record("invalid-cursors", JSONObject().put("realGatewayHistoryRejected", true).put("realWssResetRequired", true))
        } finally { client.disconnect() }
    }

    @Test fun lostWriteAcknowledgementStaysUnknown() {
        input()
        until(description = "Online before explicit lost-ack send") { it.online && !it.busy && it.selectedThreadId != null }
        compose.onNodeWithTag("draft").performTextReplacement("Reply with exactly P2_ACK_ONCE. Do not use tools.")
        compose.onNodeWithTag("send").assertIsEnabled().performClick()
        until(description = "Lost acknowledgement persisted as unknown") { !it.online && it.unknownWarning != null && !it.busy }
        assertFalse(state.canSend)
        assertFalse(state.canResume)
        screenshot("08-lost-ack-unknown")
        record("lost-ack")
    }

    @Test fun unknownSurvivesRestartOffline() {
        input()
        until(description = "Unknown survived process restart offline") { !it.online && it.unknownWarning != null && !it.busy }
        assertFalse(state.canSend)
        assertFalse(state.canResume)
        screenshot("09-unknown-restart")
        record("unknown-restart")
    }

    @Test fun reconcileUnknownByQueryWithoutResend() {
        input()
        compose.runOnIdle { model.reconnect() }
        until(description = "Original operation resolved by receipt query") { it.online && it.unknownWarning == null && !it.busy && it.messages.any { m -> m.role != "user" && m.text.contains("P2_ACK_ONCE") } }
        val saved = checkpoint().put("draft", state.draft)
        File(directory, "checkpoint.json").writeText(saved.toString())
        screenshot("10-unknown-reconciled")
        record("unknown-reconciled")
    }
}
