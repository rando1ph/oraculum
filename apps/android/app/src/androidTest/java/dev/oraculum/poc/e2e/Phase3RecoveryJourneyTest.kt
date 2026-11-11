package dev.oraculum.poc.e2e

import android.graphics.Bitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.test.espresso.Espresso
import androidx.test.platform.app.InstrumentationRegistry
import dev.oraculum.poc.MainActivity
import dev.oraculum.poc.gateway.EventCursor
import dev.oraculum.poc.gateway.GatewayClient
import dev.oraculum.poc.gateway.GatewayEndpoint
import dev.oraculum.poc.gateway.GatewayEventListener
import dev.oraculum.poc.gateway.GatewayException
import dev.oraculum.poc.ui.PocUiState
import dev.oraculum.poc.storage.CacheScope
import dev.oraculum.poc.storage.StateDatabase
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.*
import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Opt-in Phase 3 recovery methods. The external runner controls the isolated fixture between methods. */
class Phase3RecoveryJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val model get() = compose.activity.model
    private val state get() = model.state.value
    private val directory get() = File(context.filesDir, "phase3-evidence").apply { mkdirs() }
    private val recoveryCheckpoint get() = File(directory, "recovery-checkpoint.json")

    private fun input(): JSONObject {
        val file = File(context.noBackupFilesDir, "phase3-e2e.json")
        assumeTrue("Opt-in private Phase 3 fixture input required", file.isFile)
        return JSONObject(file.readText())
    }
    private fun checkpoint() = JSONObject(File(directory, "checkpoint.json").readText())
    private fun until(description: String, timeout: Long = 120_000, check: (PocUiState) -> Boolean) {
        val deadline = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < deadline) {
            compose.waitForIdle()
            if (check(state)) return
            Thread.sleep(80)
        }
        fail("$description; connection=${state.connectionLabel}; error=${state.error}; canSend=${state.canSend}; canStop=${state.canStop}; canResume=${state.canResume}; unresolved=${state.unresolvedOperations.size}")
    }
    private fun screenshot(name: String) {
        compose.waitForIdle()
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
    private fun record(name: String, extra: JSONObject = JSONObject()) {
        File(directory, "$name.json").writeText(extra.put("passed", true).put("threadId", state.selectedThreadId)
            .put("projectId", state.selectedProjectId).put("online", state.online).put("messages", state.messages.size).toString(2))
    }

    /** Precondition: fixture offline. This changes only the dedicated thread's local draft. */
    @Test fun offlineCacheDraftAndNoWrite() {
        input()
        val initial = checkpoint()
        until("Offline native history restored without mutation") {
            !it.online && !it.busy && it.paired && it.selectedThreadId == initial.getString("threadId") && it.messages.isNotEmpty()
        }
        val beforeUnknown = state.unresolvedOperations.map { it.operationId }.toSet()
        val previousDraft = state.draft
        val originalIds = state.messages.map { it.id }
        assertFalse(state.canSend)
        assertFalse(state.canStop)
        assertFalse(state.canResume)
        compose.onNodeWithTag("draft").performTextReplacement("P3_OFFLINE_DRAFT_DO_NOT_SEND")
        Espresso.closeSoftKeyboard()
        compose.onNodeWithTag("send").assertIsDisplayed().assertIsNotEnabled()
        until("Offline draft is editable while safety gates remain closed") { it.draft == "P3_OFFLINE_DRAFT_DO_NOT_SEND" && !it.canSend && !it.busy }
        assertDurableDraft("P3_OFFLINE_DRAFT_DO_NOT_SEND")
        assertEquals(beforeUnknown, state.unresolvedOperations.map { it.operationId }.toSet())
        assertEquals(originalIds, state.messages.map { it.id })
        recoveryCheckpoint.writeText(JSONObject().put("threadId", state.selectedThreadId).put("projectId", state.selectedProjectId)
            .put("previousDraft", previousDraft).put("draft", state.draft).put("messageIds", JSONArray(originalIds)).toString())
        screenshot("20-offline-draft-readonly")
        record("recovery-offline", JSONObject().put("pendingOperationCountUnchanged", true))
    }

    /** Precondition: fixture online again; optional process restart before this method. No resume or send is dispatched. */
    @Test fun onlineRestoresOriginalThreadWithoutSendingDraft() {
        input()
        val saved = JSONObject(recoveryCheckpoint.readText())
        compose.runOnIdle { model.reconnect() }
        until("Online read-only restoration of original thread and draft") {
            it.online && it.paired && !it.busy && it.selectedThreadId == saved.getString("threadId") &&
                it.draft == saved.getString("draft") && it.messages.isNotEmpty()
        }
        assertFalse("Reconnection must not send the local draft", state.messages.any { it.role == "user" && it.text == saved.getString("draft") })
        assertFalse("No turn was requested by this journey", state.canStop)
        screenshot("21-reconnected-original-thread")
        record("recovery-online", JSONObject().put("draftNotSent", true).put("canResume", state.canResume))
    }

    /** Precondition: restartGateway control completed. The only mutation in this method is the visible Resume click. */
    @Test fun newEpochRequiresExplicitResume() {
        input()
        val saved = checkpoint()
        until("Changed Gateway epoch restores history but requires explicit native resume") {
            it.online && it.paired && !it.busy && it.selectedThreadId == saved.getString("threadId") && it.messages.isNotEmpty() && it.canResume
        }
        assertFalse("Epoch recovery cannot silently make an unloaded thread writable", state.canSend)
        assertFalse("Epoch recovery cannot start a Turn", state.canStop)
        assertTrue("Do not resume around an existing unresolved operation", state.unresolvedOperations.isEmpty())
        if (state.draft.isBlank()) compose.runOnIdle { model.draftChange("P3_EPOCH_LOCAL_DRAFT_DO_NOT_SEND") }
        val draft = state.draft
        val messageIds = state.messages.map { it.id }.toSet()
        File(directory, "epoch-before-explicit-resume.json").writeText(JSONObject().put("ready", true)
            .put("threadId", state.selectedThreadId).put("canSend", state.canSend).put("canResume", state.canResume).toString())
        screenshot("22-epoch-explicit-resume-required")
        compose.onNodeWithTag("resume").assertIsDisplayed().assertIsEnabled().performClick()
        until("Explicit Resume receipt and current native snapshot converge") { it.online && !it.busy && !it.canResume && it.canSend }
        assertEquals(draft, state.draft)
        assertEquals(messageIds, state.messages.map { it.id }.toSet())
        assertFalse(state.canStop)
        screenshot("23-epoch-explicit-resume-complete")
        record("recovery-epoch-resume", JSONObject().put("explicitUiResume", true).put("messageIdsUnchanged", true))
    }

    /** Authenticated, read-only protocol probes. They neither replace the UI stream nor modify a thread. */
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
                fail("An unissued history cursor must be rejected")
            } catch (error: GatewayException) { assertTrue("Gateway reports cursor invalidation", error.code.contains("CURSOR")) }
            val connection = CompletableDeferred<JsonObject>()
            val socket = client.openEvents(EventCursor(capabilities.getValue("epoch").jsonPrimitive.content, 9_007_199_254_740_991L),
                object : GatewayEventListener {
                    override fun onConnection(message: JsonObject) { connection.complete(message) }
                    override fun onFailure(error: GatewayException) { connection.completeExceptionally(error) }
                })
            try { assertTrue(withTimeout(15_000) { connection.await() }.getValue("resetRequired").jsonPrimitive.boolean) }
            finally { socket.close() }
            record("recovery-invalid-cursors", JSONObject().put("historyRejected", true).put("wssResetRequired", true))
        } finally { client.disconnect() }
    }

    /** Root advances injected GatewayAuth time only after ready, then writes the private trigger over ADB stdin. */
    @Test fun issuedAccessRenewsAfterControlledExpiry() {
        input()
        val saved = checkpoint()
        until("Existing access established before controlled expiry") {
            it.online && it.paired && !it.busy && it.selectedThreadId == saved.getString("threadId") && it.messages.isNotEmpty()
        }
        val draft = state.draft
        val unknownIds = state.unresolvedOperations.map { it.operationId }.toSet()
        val trigger = File(context.noBackupFilesDir, "phase3-access-expired")
        trigger.delete()
        File(directory, "phase3-access-expiry-ready.json").writeText("{\"ready\":true}")
        val deadline = System.currentTimeMillis() + 90_000
        while (!trigger.exists() && System.currentTimeMillis() < deadline) Thread.sleep(100)
        assertTrue("External controller must advance the fixture auth clock after ready", trigger.exists())
        trigger.delete()
        compose.runOnIdle { model.refresh() }
        until("Original identity renews short access during read-only refresh") {
            assertTrue("Access expiry must not discard long-term pairing", it.paired)
            it.online && !it.busy && it.selectedThreadId == saved.getString("threadId") && it.messages.isNotEmpty()
        }
        assertEquals(draft, state.draft)
        assertEquals(unknownIds, state.unresolvedOperations.map { it.operationId }.toSet())
        assertFalse(state.canStop)
        record("recovery-access-renewal", JSONObject().put("controlledClockExpiry", true).put("repaired", false))
    }

    private fun assertDurableDraft(text: String) = runBlocking {
        val reader = GatewayClient(context)
        val identity = checkNotNull(reader.savedIdentity(GatewayEndpoint.parse(state.endpoint)))
        val scope = CacheScope(identity.endpoint, identity.installationId, identity.deviceId).key
        val database = StateDatabase.open(context)
        try {
            withTimeout(5_000) {
                while (database.state().draft(scope, checkNotNull(state.selectedProjectId), checkNotNull(state.selectedThreadId))?.text != text) delay(50)
            }
        } finally { database.close(); reader.disconnect() }
    }
}
