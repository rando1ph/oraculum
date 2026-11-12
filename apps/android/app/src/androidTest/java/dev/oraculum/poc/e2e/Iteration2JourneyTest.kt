package dev.oraculum.poc.e2e

import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import android.view.Choreographer
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.espresso.Espresso
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import dev.oraculum.poc.MainActivity
import dev.oraculum.poc.storage.ClientPreferences
import dev.oraculum.poc.storage.AvatarStore
import dev.oraculum.poc.storage.StateDatabase
import dev.oraculum.poc.ui.PocUiState
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/**
 * Opt-in OnePlus acceptance. Run individual methods in order, never as a random suite.
 * Required private input: no_backup/iteration2-e2e.json {endpoint, projectId}.
 * Pairing, endpoint, credentials, original drafts and unknown receipts are never reset.
 * Write-intent checkpoints are persisted BEFORE explicit test actions. Rerunning a
 * failed stage reads its original result; it never dispatches another create/send.
 * External runner controls only the dedicated Gateway between offline/online stages.
 */
class Iteration2JourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val model get() = compose.activity.model
    private val state get() = model.state.value
    private val directory get() = File(context.filesDir, "iteration2-evidence").apply { mkdirs() }
    private val checkpointFile get() = File(directory, "checkpoint.json")
    // Original user text stays outside the screenshot/evidence export directory.
    private val originalFile get() = File(context.noBackupFilesDir, "iteration2-original-state.json")

    private fun input(): JSONObject {
        val file = File(context.noBackupFilesDir, "iteration2-e2e.json")
        assumeTrue("Private Iteration 2 input required", file.isFile)
        return JSONObject(file.readText())
    }

    private fun until(description: String, timeout: Long = 120_000, check: (PocUiState) -> Boolean) {
        val deadline = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < deadline) {
            compose.waitForIdle()
            if (check(state)) return
            Thread.sleep(80) // Poll the observed condition, not an assumed animation delay.
        }
        fail("$description; online=${state.online}, busy=${state.busy}, canSend=${state.canSend}, canStop=${state.canStop}, unresolved=${state.unresolvedOperations.size}")
    }

    private fun screenshot(name: String) {
        compose.waitForIdle()
        captureStableScreenshot(name)
    }

    /** Compose idleness does not finish Android dialog-window/compositor animations. */
    private fun captureStableScreenshot(name: String) {
        // Accessibility quietness and pixel equality are separate checks: a live
        // event stream may prevent the former while the actual frame is stable.
        try { instrumentation.uiAutomation.waitForIdle(500, 5_000) } catch (_: TimeoutException) { }
        val attempts = File(context.noBackupFilesDir, "iteration2-capture-attempts").apply { mkdirs() }
        var previous: Bitmap? = null
        var stableSamples = 0
        try {
            repeat(20) {
                val frame = CountDownLatch(1)
                instrumentation.runOnMainSync { Choreographer.getInstance().postFrameCallback { frame.countDown() } }
                assertTrue("Display frame did not arrive", frame.await(2, TimeUnit.SECONDS))
                val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
                if (it == 0) File(attempts, "$name-first.png").outputStream().use { output -> bitmap.compress(Bitmap.CompressFormat.PNG, 100, output) }
                stableSamples = if (previous?.sameAs(bitmap) == true) stableSamples + 1 else 0
                previous?.recycle()
                previous = bitmap
                if (stableSamples >= 2) {
                    File(attempts, "$name-last.png").outputStream().use { output -> bitmap.compress(Bitmap.CompressFormat.PNG, 100, output) }
                    File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                    return
                }
            }
            previous?.let { bitmap -> File(attempts, "$name-last.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) } }
            fail("Rendered pixels did not settle; transition screenshot was not saved")
        } finally { previous?.recycle() }
    }

    private fun record(name: String, extra: JSONObject = JSONObject()) {
        val build = context.assets.open("oraculum-build.json").bufferedReader().use { JSONObject(it.readText()) }
        File(directory, "$name.json").writeText(extra.put("passed", true).put("build", build)
            .put("projectId", state.selectedProjectId).put("threadId", state.selectedThreadId)
            .put("messageCount", state.messages.size).toString(2))
    }

    private fun checkpoint(): JSONObject {
        assertTrue("Run prepareAndSendNativeTurn first", checkpointFile.isFile)
        return JSONObject(checkpointFile.readText())
    }

    private fun connected(settled: Boolean = true) {
        val config = input()
        val saved = checkpoint()
        until("Previously paired dedicated test thread restored") {
            it.paired && it.online && !it.busy && it.selectedProjectId == config.getString("projectId") &&
                it.selectedThreadId == saved.getString("threadId") && (!settled || !it.canStop)
        }
        assertEquals("Never replace the existing endpoint", config.getString("endpoint"), state.endpoint)
        assertTrue("Resolve unknown operations by their original receipts before this stage", state.unresolvedOperations.isEmpty())
        if (settled) assertTrue("An actual pending request must be reviewed first", state.interactions.none { it.status == "pending" })
        assertOriginalDraftPreserved()
    }

    private fun preserveOriginal() = runBlocking {
        if (originalFile.isFile) return@runBlocking
        val saved = ClientPreferences(context).snapshot()
        val originalScope = saved.scopeKey
        val originalProject = saved.projectId
        val originalThread = saved.threadId
        val database = StateDatabase.open(context)
        try {
            val draft = if (originalScope != null && originalProject != null && originalThread != null)
                database.state().draft(originalScope, originalProject, originalThread) else null
            originalFile.writeText(JSONObject().put("endpoint", saved.endpoint)
                .put("scopeKey", saved.scopeKey ?: JSONObject.NULL).put("projectId", saved.projectId ?: JSONObject.NULL)
                .put("threadId", saved.threadId ?: JSONObject.NULL).put("draftExists", draft != null)
                .put("draft", draft?.text ?: JSONObject.NULL).put("visibleDraft", state.draft)
                .put("themeMode", saved.themeMode).put("accentColor", saved.accentColor)
                .put("avatarFileName", saved.avatarFileName ?: JSONObject.NULL)
                .put("userLabel", saved.userLabel).put("assistantLabel", saved.assistantLabel)
                .put("readingScale", saved.readingScale).toString(2))
        } finally { database.close() }
    }

    private fun assertOriginalDraftPreserved() = runBlocking {
        assertTrue("Original local selection must be recorded before test writes", originalFile.isFile)
        val original = JSONObject(originalFile.readText())
        if (listOf("scopeKey", "projectId", "threadId").any { original.isNull(it) }) return@runBlocking
        val database = StateDatabase.open(context)
        try {
            val current = database.state().draft(original.getString("scopeKey"), original.getString("projectId"), original.getString("threadId"))
            assertEquals("Original draft existence must be preserved", original.getBoolean("draftExists"), current != null)
            if (current != null) assertEquals("Never replace the user's original draft", original.getString("draft"), current.text)
        } finally { database.close() }
    }

    private fun sendOnce(stage: String, prompt: String, allowTestAttachment: Boolean = false) {
        assertEquals(checkpoint().getString("threadId"), state.selectedThreadId)
        val intent = File(directory, "$stage-intent.json")
        if (intent.isFile) return // Read the original outcome; no implicit retry, even after a timeout.
        assertFalse("Do not start around an active native Turn", state.canStop)
        assertTrue(state.unresolvedOperations.isEmpty())
        if (!allowTestAttachment) assertTrue("Test messages must not claim unrelated attachments", model.files.state.value.attachments.isEmpty())
        compose.onNodeWithTag("draft").performTextReplacement(prompt)
        Espresso.closeSoftKeyboard()
        until("Dedicated test draft writable before explicit send") { it.canSend && !it.busy }
        intent.writeText(JSONObject().put("threadId", state.selectedThreadId).put("requestedAt", System.currentTimeMillis())
            .put("beforeMessageIds", JSONArray(state.messages.map { it.id })).toString())
        compose.onNodeWithTag("send").assertIsDisplayed().assertIsEnabled().performClick()
    }

    private fun openSettings() {
        compose.onNodeWithTag("settings").assertDoesNotExist()
        compose.onNodeWithTag("navigation").performClick()
        compose.onNodeWithTag("settings").assertIsDisplayed().performClick()
        compose.onNodeWithTag("theme-dark").assertExists()
    }

    @Test fun prepareAndSendNativeTurn() {
        val config = input()
        until("Existing paired app initialized") { it.paired && !it.busy }
        assertEquals(config.getString("endpoint"), state.endpoint)
        preserveOriginal()
        if (!state.online) compose.runOnIdle { model.reconnect() }
        until("Existing identity connected") { it.paired && it.online && !it.busy && it.projects.any { p -> p.id == config.getString("projectId") } }
        if (!checkpointFile.isFile) {
            val creationIntent = File(directory, "create-intent.json")
            assertFalse("A prior create may have executed: inspect its original receipt; do not create again", creationIntent.exists())
            if (state.selectedProjectId != config.getString("projectId")) {
                compose.runOnIdle { model.selectProject(config.getString("projectId")) }
                until("Dedicated existing project selected") { it.selectedProjectId == config.getString("projectId") && !it.busy }
            }
            assertTrue("Do not bypass existing unknown writes", state.unresolvedOperations.isEmpty())
            assertFalse(state.canStop)
            assertTrue("Use only the actual advertised model catalog", state.models.isNotEmpty())
            val selected = state.models.firstOrNull { it.id.contains("mini", ignoreCase = true) }
                ?: state.models.firstOrNull { it.id == state.selectedModel } ?: state.models.first()
            compose.runOnIdle {
                model.selectModel(selected.id)
                selected.efforts.firstOrNull { it == "low" }?.let(model::selectEffort)
                model.selectPermission("read-only", false)
            }
            val prior = state.selectedThreadId
            creationIntent.writeText(JSONObject().put("projectId", config.getString("projectId"))
                .put("requestedAt", System.currentTimeMillis()).toString())
            compose.runOnIdle { model.createThread() }
            until("Exactly one explicit native thread created") { !it.busy && it.selectedThreadId != null && it.selectedThreadId != prior }
            checkpointFile.writeText(JSONObject().put("projectId", state.selectedProjectId).put("threadId", state.selectedThreadId)
                .put("model", selected.id).toString(2))
            compose.onNodeWithTag("empty-brand").assertIsDisplayed()
            screenshot("i2-01-native-empty-state")
        } else {
            val saved = checkpoint()
            assertEquals(config.getString("projectId"), saved.getString("projectId"))
            if (state.selectedThreadId != saved.getString("threadId")) {
                compose.runOnIdle { model.selectThread(saved.getString("threadId")) }
                until("Original test thread selected without creating another") { !it.busy && it.selectedThreadId == saved.getString("threadId") }
            }
        }
        sendOnce("initial", "Reply with I2_NATIVE_OK, a short Chinese greeting, and exactly one fenced Kotlin code block containing val ready = true. Do not use tools or modify files.")
        until("Actual native initial reply completed", 240_000) {
            !it.busy && !it.canStop && it.messages.any { m -> m.role == "assistant" && m.text.contains("I2_NATIVE_OK") }
        }
        compose.runOnIdle { model.draftChange("I2_LOCAL_DRAFT_DO_NOT_SEND") }
        until("Writable completed state with dedicated unsent draft") { it.canSend && !it.busy }
        screenshot("i2-02-native-conversation")
        assertOriginalDraftPreserved()
        record("i2-initial", JSONObject().put("existingPairingReused", true).put("originalDraftPreserved", true))
    }

    @Test fun visualPanels() {
        connected()
        val before = state
        val preferences = runBlocking { ClientPreferences(context).snapshot() }
        try {
            openSettings()
            if (compose.activity.resources.configuration.fontScale <= 1.1f &&
                compose.activity.resources.configuration.screenWidthDp >= 350) {
                val tops = listOf("light", "dark", "oled").map {
                    compose.onNodeWithTag("theme-$it").assertIsDisplayed().fetchSemanticsNode().boundsInRoot.top
                }
                assertTrue("Three theme choices share a row at ordinary phone width and font scale",
                    checkNotNull(tops.maxOrNull()) - checkNotNull(tops.minOrNull()) <= compose.activity.resources.displayMetrics.density)
            }
            for (theme in listOf("light", "dark", "oled")) {
                compose.onNodeWithTag("theme-$theme").performScrollTo().performClick()
                until("Theme saved") { it.themeMode == theme && !it.busy }
                screenshot("i2-03-settings-$theme")
            }
            compose.onNodeWithTag("accent-ocean").performScrollTo().performClick()
            until("Accent applied and persisted") { it.accentColor == "ocean" && !it.busy }
            assertEquals("ocean", runBlocking { ClientPreferences(context).snapshot().accentColor })
            screenshot("i2-04-settings-accent")
            compose.onNodeWithTag("identity-user").performScrollTo().performTextReplacement("I2 测试用户")
            Espresso.closeSoftKeyboard()
            compose.onNodeWithTag("identity-save").performScrollTo().performClick()
            until("Local nickname saved") { it.userLabel == "I2 测试用户" && !it.busy }
            compose.onNodeWithTag("avatar-pick").performScrollTo().assertIsDisplayed()
            screenshot("i2-05-settings-identity")
            compose.onNodeWithTag("notification-settings").performScrollTo().assertIsDisplayed()
            screenshot("i2-06-settings-notifications")
            compose.onNodeWithTag("storage-settings").performScrollTo().performClick()
            compose.onNodeWithTag("clear-cache").performScrollTo().assertIsDisplayed()
            screenshot("i2-07-gateway-storage")
            compose.onNodeWithTag("clear-cache").performClick()
            compose.onNodeWithTag("confirm-clear-cache").assertIsDisplayed()
            screenshot("i2-08-cache-confirmation")
            systemBackUntilGone("confirm-clear-cache") // Never clear a cache for a visual check.
            compose.onNodeWithTag("close-panel").performClick()

            compose.onNodeWithTag("composer-add").performClick()
            compose.onNodeWithTag("files_pick").assertIsDisplayed()
            compose.onNodeWithTag("composer-files").assertIsDisplayed()
            compose.onNodeWithTag("composer-navigation").assertIsDisplayed()
            screenshot("i2-09-composer-actions")
            compose.onNodeWithTag("composer-files").performClick()
            compose.onNodeWithTag("files_panel").assertIsDisplayed()
            screenshot("i2-10-composer-project-files")
            systemBackUntilGone("files_panel")

            compose.onNodeWithTag("model-picker").performClick()
            compose.onNodeWithTag("model-sheet").assertIsDisplayed()
            screenshot("i2-11-model-effort-sheet")
            compose.onNodeWithTag("choose-model").performClick()
            val selected = state.models.firstOrNull { it.id == state.selectedModel } ?: state.models.first()
            compose.onNodeWithTag("model-${selected.id}").performScrollTo().assertIsDisplayed()
            screenshot("i2-12-model-catalog")
            systemBackUntilGone("model-sheet")
            compose.onNodeWithTag("model-sheet").assertDoesNotExist()
            compose.onNodeWithTag("permission-picker").performClick()
            compose.onNodeWithTag("permission-sheet").assertIsDisplayed()
            screenshot("i2-13-permission-sheet")
            compose.onNodeWithTag("permission-full-access").performScrollTo().performClick()
            compose.onNodeWithTag("confirm-full-access").assertIsDisplayed()
            assertEquals(before.permissionPreset, state.permissionPreset)
            screenshot("i2-14-full-access-confirmation")
            systemBackUntilGone("confirm-full-access")
            systemBackUntilGone("permission-sheet")
            compose.onNodeWithTag("permission-sheet").assertDoesNotExist()

            compose.runOnIdle { model.refreshInspector() }
            until("Real extension read completed") { !it.busy }
            compose.onNodeWithTag("inspector").performClick()
            compose.onNodeWithTag("inspector-extensions").performScrollTo().performClick()
            screenshot("i2-15-mcp-capabilities")
            compose.onNodeWithTag("inspector-usage").performScrollTo().performClick()
            screenshot("i2-16-native-usage")
            systemBackUntilGone("close-panel")
            assertEquals(before.selectedThreadId, state.selectedThreadId)
            assertEquals(before.draft, state.draft)
            assertEquals(before.selectedModel, state.selectedModel)
            assertEquals(before.selectedEffort, state.selectedEffort)
            assertEquals(before.permissionPreset, state.permissionPreset)
            assertOriginalDraftPreserved()
            record("i2-visual-panels", JSONObject().put("cacheConfirmationCancelled", true)
                .put("fullAccessCancelled", true).put("originalDraftPreserved", true))
        } finally {
            compose.runOnIdle { model.themeChange(preferences.themeMode) }
            until("Original theme restored") { it.themeMode == preferences.themeMode && !it.busy }
            compose.runOnIdle { model.accentChange(preferences.accentColor) }
            until("Original accent restored") { it.accentColor == preferences.accentColor && !it.busy }
            compose.runOnIdle { model.identityLabelsChange(preferences.userLabel, preferences.assistantLabel) }
            until("Original local labels restored") { it.userLabel == preferences.userLabel && it.assistantLabel == preferences.assistantLabel && !it.busy }
        }
    }

    /** Explicit local next-Turn choices from the real catalog; no native write is issued. */
    @Test fun modelAndEffortSelection() {
        connected()
        val before = state
        val chosen = state.models.firstOrNull { it.efforts.isNotEmpty() && it.id.contains("mini", ignoreCase = true) }
            ?: state.models.firstOrNull { it.efforts.isNotEmpty() }
        assertNotNull("A real advertised model with supported effort is required", chosen)
        val selected = checkNotNull(chosen)
        val effort = selected.efforts.firstOrNull { it == "low" } ?: selected.defaultEffort?.takeIf { it in selected.efforts }
            ?: selected.efforts.first()
        compose.onNodeWithTag("model-picker").performClick()
        compose.onNodeWithTag("model-sheet").assertIsDisplayed()
        if (state.selectedModel != null) compose.onNodeWithTag("choose-model").performClick()
        compose.onNodeWithTag("model-${selected.id}").performScrollTo().performClick()
        until("Real model selected for the next Turn") { it.selectedModel == selected.id }
        compose.onNodeWithTag("effort-$effort").performScrollTo().performClick()
        until("Supported reasoning effort selected") { it.selectedEffort == effort }
        compose.onNodeWithTag("choose-model").performScrollTo().assertIsDisplayed()
        screenshot("i2-32-model-effort-selected")
        systemBackUntilGone("model-sheet")
        assertEquals(before.selectedThreadId, state.selectedThreadId)
        assertEquals(before.draft, state.draft)
        assertEquals(before.permissionPreset, state.permissionPreset)
        assertFalse(state.canStop)
        assertOriginalDraftPreserved()
        record("i2-model-effort-selection", JSONObject().put("actualCatalogModel", selected.id).put("supportedEffort", effort)
            .put("localNextTurnChoiceOnly", true).put("nativeWriteIssued", false)
            .put("choiceRetained", true))
    }

    /** Replaces only an absent avatar; an existing personal image is never overwritten. */
    @Test fun avatarSystemPickerAndPrivatePersistence() {
        connected()
        val before = state
        openSettings()
        compose.onNodeWithTag("avatar-pick").performScrollTo().performClick()
        waitForDocumentsUi()
        // DocumentsUI owns the foreground here; Espresso requires a resumed
        // Activity in the target process and cannot dispatch this system Back.
        shell("input keyevent KEYCODE_BACK")
        waitForOwnForeground("Avatar picker cancellation returned to the app")
        assertEquals(before.avatarFileName, state.avatarFileName)
        if (before.avatarFileName != null) {
            compose.onNodeWithTag("close-panel").performClick()
            record("i2-avatar-existing-preserved", JSONObject().put("pickerCancellationVerified", true).put("replacementSkipped", true))
            return
        }
        var imported: String? = null
        try {
            compose.onNodeWithTag("avatar-pick").performScrollTo().performClick()
            chooseTestDocument("phase3-image.png")
            until("SAF image copied into app-private avatar storage") { it.avatarFileName != null && !it.busy }
            val name = checkNotNull(state.avatarFileName)
            imported = name
            assertTrue(File(context.filesDir, "identity-avatars-v2/$name").isFile)
            assertEquals(name, runBlocking { ClientPreferences(context).snapshot().avatarFileName })
            compose.onNodeWithTag("avatar-preview").performScrollTo().assertIsDisplayed()
            screenshot("i2-17-custom-avatar")
            assertTrue("A local identity image must never become a Gateway attachment", model.files.state.value.attachments.isEmpty())
            compose.onNodeWithTag("close-panel").performClick()
            compose.onNodeWithTag("conversation").performScrollToIndex(0)
            screenshot("i2-18-avatar-conversation")
            record("i2-avatar-saf", JSONObject().put("actualSystemPicker", true).put("privateCopyPersisted", true))
        } finally {
            runBlocking { ClientPreferences(context).saveAvatar(null) }
            compose.runOnIdle { model.refreshLocalAvatar() }
            until("Original default avatar restored") { it.avatarFileName == null && !it.busy }
            imported?.let { AvatarStore(context).delete(it) }
        }
    }

    @Test fun toolsTurnAndCollapse() {
        connected()
        val draft = state.draft
        sendOnce("tools", "Use the shell exactly once to execute printf 'I2_TOOL_OK\\n'. This command only prints a fixed marker; do not read or modify any files. Then reply I2_TOOLS_DONE in one short Chinese sentence.")
        until("Real command and final reply completed", 240_000) {
            !it.busy && !it.canStop && it.messages.any { m -> m.role == "assistant" && m.text.contains("I2_TOOLS_DONE") } &&
                it.messages.any { m -> m.role == "commandExecution" && m.text.contains("I2_TOOL_OK") }
        }
        // Completion can precede the authoritative post-Turn snapshot. A local
        // draft makes the existing canSend gate observable without sending it.
        compose.runOnIdle { model.draftChange(draft.ifBlank { "I2_VISUAL_DRAFT_DO_NOT_SEND" }) }
        until("Completed native snapshot is current before visual capture") { it.canSend && !it.busy && !it.canStop }
        val answer = state.messages.last { it.role == "assistant" && it.text.contains("I2_TOOLS_DONE") }
        val summaryTag = "turn-summary-${answer.turnId}"
        compose.onNodeWithTag("conversation").performScrollToNode(hasTestTag(summaryTag))
        val summary = compose.onNodeWithTag(summaryTag).assertIsDisplayed().assertHasClickAction()
        val collapsed = summary.fetchSemanticsNode().config[SemanticsProperties.StateDescription]
        assertEquals("已收起", collapsed)
        screenshot("i2-19-turn-completed-collapsed")
        summary.performClick()
        val expanded = summary.fetchSemanticsNode().config[SemanticsProperties.StateDescription]
        assertNotEquals("The completed process summary must expand", collapsed, expanded)
        screenshot("i2-20-turn-process-expanded")
        summary.performClick()
        assertEquals(collapsed, summary.fetchSemanticsNode().config[SemanticsProperties.StateDescription])
        compose.onNodeWithTag("conversation").performScrollToNode(hasTestTag("message_${answer.id}"))
        compose.onNodeWithTag("message_${answer.id}").assertIsDisplayed()
        screenshot("i2-21-final-answer-visible")
        compose.runOnIdle { model.draftChange(draft) }
        assertOriginalDraftPreserved()
        record("i2-turn-collapse", JSONObject().put("turnId", answer.turnId).put("finalAnswerVisible", true)
            .put("actualCommandObserved", true).put("collapsedState", collapsed).put("expandedState", expanded))
    }

    /** Only cancels/declines a native request generated for this dedicated checkpoint. */
    @Test fun actualNativeApprovalCanBeCancelled() {
        connected(settled = false)
        fun actionable(request: dev.oraculum.poc.repository.InteractionUi) = request.status == "pending" &&
            request.supported && request.decisions.any { it == "cancel" || it == "decline" }
        if (state.interactions.none(::actionable)) {
            assertTrue(state.interactions.none { it.status == "pending" })
            compose.runOnIdle { model.selectPermission("read-only", false) }
            sendOnce("approval", "For this isolated UI approval test, request shell sandbox escalation to write I2_APPROVAL_TEST to the relative file iteration2-approval.txt in the current dedicated test project. Wait for the native user decision. Do not use another write method, read other files, or bypass approval. If cancelled or denied, stop and explain briefly.")
        }
        until("Actual native cancellable approval received", 180_000) { it.interactions.any(::actionable) }
        val request = state.interactions.first(::actionable)
        assertEquals(checkpoint().getString("threadId"), request.threadId)
        val decision = if ("cancel" in request.decisions) "cancel" else "decline"
        compose.onNodeWithTag("pending-interactions").performClick()
        compose.onNodeWithTag("approval-sheet").assertIsDisplayed()
        val button = compose.onAllNodesWithTag("interaction_${request.id}_$decision").onLast()
        button.performScrollTo().assertIsDisplayed().assertIsEnabled()
        screenshot("i2-22-real-native-approval")
        button.performClick()
        until("Native cancellation resolved without another reply", 180_000) {
            !it.busy && !it.canStop && it.interactions.none { r -> r.id == request.id && r.status == "pending" }
        }
        systemBackUntilGone("approval-sheet")
        assertOriginalDraftPreserved()
        record("i2-native-approval", JSONObject().put("kind", request.kind).put("decision", decision))
    }

    /** Root arms dropNextTurnReply first: upload succeeds, then one real Turn reply is discarded. */
    @Test fun prepareUnknownDraftAndSend() {
        connected()
        until("Dedicated attachment scope loaded") {
            model.files.state.value.threadId == it.selectedThreadId && !model.files.state.value.busy
        }
        val attachmentIntent = File(directory, "unknown-attachment-intent.json")
        if (!attachmentIntent.exists()) {
            assertTrue("No unrelated attachment may be claimed", model.files.state.value.attachments.isEmpty())
            attachmentIntent.writeText(JSONObject().put("threadId", state.selectedThreadId)
                .put("requestedAt", System.currentTimeMillis()).toString())
            compose.onNodeWithTag("composer-add").performClick()
            compose.onNodeWithTag("files_pick").performClick()
            chooseTestDocument("phase3-note.txt")
        }
        until("One real SAF test document ready; no automatic repeat upload") {
            !model.files.state.value.busy && model.files.state.value.attachments.size == 1 &&
                model.files.state.value.attachments.single().let { a -> a.name == "phase3-note.txt" && a.status == "ready" }
        }
        val attachment = model.files.state.value.attachments.single()
        val prompt = "Reply exactly I2_ACK_ONCE. The attached document is only an attachment-delivery test; do not use tools or read it."
        File(directory, "unknown-pre-send.json").writeText(JSONObject().put("threadId", state.selectedThreadId)
            .put("attachmentId", attachment.id).put("draft", prompt).toString(2))
        screenshot("i2-27-real-attachment-ready")
        sendOnce("unknown-send", prompt, allowTestAttachment = true)
        until("Lost real response retains original operation, draft and attachment claim", 180_000) {
            !it.online && !it.busy && it.unresolvedOperations.any { op -> op.kind == "turn.start" && op.threadId == it.selectedThreadId } &&
                model.files.state.value.hasUnknown && model.files.state.value.attachments.any { a -> a.id == attachment.id && a.status == "held" }
        }
        val operation = state.unresolvedOperations.single { it.kind == "turn.start" && it.threadId == state.selectedThreadId }
        assertFalse(state.canSend)
        assertFalse(state.canResume)
        assertEquals(prompt, state.draft)
        assertDurableTestDraft(prompt)
        File(directory, "unknown-checkpoint.json").writeText(JSONObject().put("operationId", operation.operationId)
            .put("attachmentId", attachment.id).put("draft", state.draft).put("threadId", state.selectedThreadId).toString(2))
        screenshot("i2-28-unknown-write-held")
        assertOriginalDraftPreserved()
        record("i2-unknown-held", JSONObject().put("operationId", operation.operationId)
            .put("attachmentHeld", true).put("draftRetained", true))
    }

    /** Root restarts only the app process while the proxy remains offline. */
    @Test fun unknownAfterProcessRestart() {
        input()
        val saved = JSONObject(File(directory, "unknown-checkpoint.json").readText())
        until("Same unknown operation and held attachment restored offline") {
            !it.online && !it.busy && it.paired && it.selectedThreadId == saved.getString("threadId") &&
                it.unresolvedOperations.any { op -> op.operationId == saved.getString("operationId") } &&
                model.files.state.value.hasUnknown && model.files.state.value.attachments.any { a ->
                    a.id == saved.getString("attachmentId") && a.status == "held"
                }
        }
        assertEquals(saved.getString("draft"), state.draft)
        assertFalse(state.canSend)
        assertFalse(state.canResume)
        compose.onNodeWithTag("send").assertIsNotEnabled()
        screenshot("i2-29-unknown-process-restored")
        assertOriginalDraftPreserved()
        record("i2-unknown-restart", JSONObject().put("operationId", saved.getString("operationId"))
            .put("attachmentHeld", true).put("noSendInvoked", true))
    }

    /** Root reopens the same proxy; the original Gateway receipt is the only resolution. */
    @Test fun reconcileKnownReceipt() {
        input()
        val saved = JSONObject(File(directory, "unknown-checkpoint.json").readText())
        compose.runOnIdle { model.reconnect() }
        until("Original operation receipt resolves without a second send", 180_000) {
            it.online && !it.busy && !it.canStop && it.selectedThreadId == saved.getString("threadId") &&
                it.unresolvedOperations.none { op -> op.operationId == saved.getString("operationId") } &&
                it.messages.any { m -> m.role == "assistant" && m.text.contains("I2_ACK_ONCE") } &&
                model.files.state.value.threadId == it.selectedThreadId && !model.files.state.value.busy &&
                !model.files.state.value.hasUnknown && model.files.state.value.attachments.none { a -> a.id == saved.getString("attachmentId") }
        }
        assertNull(state.unknownWarning)
        assertEquals("Only one test user message is present", 1,
            state.messages.count { it.role == "user" && it.text.contains("Reply exactly I2_ACK_ONCE") })
        screenshot("i2-30-original-receipt-reconciled")
        assertOriginalDraftPreserved()
        record("i2-known-receipt", JSONObject().put("operationId", saved.getString("operationId"))
            .put("attachmentSettled", true).put("noSendInvoked", true))
    }

    /** A missing Gateway receipt is evidence of uncertainty, never permission to send again. */
    @Test fun unrecordedReceiptKeepsOriginalUnknown() {
        input()
        val saved = JSONObject(File(directory, "unknown-checkpoint.json").readText())
        val operationId = saved.getString("operationId")
        compose.runOnIdle { model.reconnect() }
        until("Original unknown operation and held attachment survive read-only reconnect") {
            it.online && it.paired && !it.busy && !it.canStop &&
                it.selectedThreadId == saved.getString("threadId") &&
                it.unresolvedOperations.any { op -> op.operationId == operationId && op.status == "unknown" } &&
                model.files.state.value.threadId == it.selectedThreadId && !model.files.state.value.busy &&
                model.files.state.value.hasUnknown && model.files.state.value.attachments.any { attachment ->
                    attachment.id == saved.getString("attachmentId") && attachment.status == "held"
                }
        }
        // Read the same operation ID once so the evidence distinguishes a missing
        // receipt from an accepted original operation. This cannot dispatch a Turn.
        compose.runOnIdle { model.queryOperation(operationId) }
        until("Original receipt is unavailable and its safety barrier remains") {
            !it.busy && it.operationStatusMessage?.contains("404") == true &&
                it.unresolvedOperations.any { op -> op.operationId == operationId && op.status == "unknown" }
        }
        assertEquals(saved.getString("draft"), state.draft)
        assertDurableTestDraft(saved.getString("draft"))
        assertTrue(model.files.state.value.attachments.any {
            it.id == saved.getString("attachmentId") && it.status == "held"
        })
        assertFalse(state.canSend)
        assertFalse(state.canResume)
        compose.onNodeWithTag("send").assertIsNotEnabled()
        screenshot("i2-30-unrecorded-receipt-protected")
        assertOriginalDraftPreserved()
        record("i2-unrecorded-receipt", JSONObject().put("operationId", operationId)
            .put("receiptUnavailable", true).put("originalOutcomeStillUnknown", true)
            .put("attachmentHeld", true).put("acceptedResolutionProven", false).put("noSendInvoked", true))
    }

    /** External runner makes only the isolated Gateway unreachable before this method. */
    @Test fun offlineCacheAndDraft() {
        input()
        val saved = checkpoint()
        until("Offline dedicated thread restored from cache") {
            it.paired && !it.online && !it.busy && it.selectedThreadId == saved.getString("threadId") && it.messages.isNotEmpty()
        }
        val beforeIds = state.messages.map { it.id }
        val unknownIds = state.unresolvedOperations.map { it.operationId }
        compose.onNodeWithTag("draft").performTextReplacement("I2_OFFLINE_DRAFT_DO_NOT_SEND")
        Espresso.closeSoftKeyboard()
        assertFalse(state.canSend)
        compose.onNodeWithTag("send").assertIsDisplayed().assertIsNotEnabled()
        assertEquals(beforeIds, state.messages.map { it.id })
        assertEquals(unknownIds, state.unresolvedOperations.map { it.operationId })
        assertDurableTestDraft("I2_OFFLINE_DRAFT_DO_NOT_SEND")
        screenshot("i2-23-offline-draft")
        assertOriginalDraftPreserved()
        record("i2-offline", JSONObject().put("writesBlocked", true).put("originalDraftPreserved", true))
    }

    /** External runner restores the same Gateway; optional app process restart is allowed. */
    @Test fun reconnectPreservesDraft() {
        input()
        val saved = checkpoint()
        compose.runOnIdle { model.reconnect() }
        until("Original test thread and unsent draft recovered read-only") {
            it.paired && it.online && !it.busy && it.selectedThreadId == saved.getString("threadId") &&
                it.draft == "I2_OFFLINE_DRAFT_DO_NOT_SEND" && it.messages.isNotEmpty()
        }
        assertFalse(state.canStop)
        assertFalse(state.messages.any { it.role == "user" && it.text == "I2_OFFLINE_DRAFT_DO_NOT_SEND" })
        assertOriginalDraftPreserved()
        screenshot("i2-24-reconnected-draft")
        record("i2-reconnected", JSONObject().put("draftNeverSent", true))
    }

    @Test fun nativeImeAndLandscape() {
        connected()
        val before = state
        val orientation = compose.activity.requestedOrientation
        try {
            compose.onNodeWithTag("draft").performClick()
            until("Actual native IME inset visible", 15_000) {
                androidx.core.view.ViewCompat.getRootWindowInsets(compose.activity.window.decorView)
                    ?.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime()) == true
            }
            compose.onNodeWithTag("draft").assertIsDisplayed()
            compose.onNodeWithTag("send").assertIsDisplayed()
            screenshot("i2-25-native-ime")
            Espresso.closeSoftKeyboard()
            compose.runOnIdle { compose.activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
            until("Activity landscape configuration observed") {
                compose.activity.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE
            }
            compose.onNodeWithTag("draft").assertIsDisplayed()
            compose.onNodeWithTag("send").assertIsDisplayed()
            screenshot("i2-26-landscape")
            assertEquals(before.draft, state.draft)
            assertEquals(before.selectedThreadId, state.selectedThreadId)
            record("i2-ime-landscape", JSONObject().put("actualImeInsets", true).put("draftPreserved", true))
        } finally { compose.runOnIdle { compose.activity.requestedOrientation = orientation } }
    }

    /** Final stage: restore the original saved local preferences, including after an interrupted run. */
    @Test fun restoreOriginalLocalPreferences() {
        val config = input()
        assertTrue("Private original state must exist", originalFile.isFile)
        val original = JSONObject(originalFile.readText())
        until("App ready for local preference restoration") { it.paired && !it.busy && !it.canStop }
        assertEquals(config.getString("endpoint"), state.endpoint)
        assertEquals(original.getString("endpoint"), state.endpoint)
        val unknownIds = state.unresolvedOperations.map { it.operationId }.toSet()
        val protectedProject = state.selectedProjectId
        val protectedThread = state.selectedThreadId
        val protectedDraft = state.draft
        val heldAttachmentIds = model.files.state.value.attachments.filter { it.status == "held" }.map { it.id }.toSet()
        assertOriginalDraftPreserved()
        compose.runOnIdle { model.themeChange(original.getString("themeMode")) }
        until("Original theme restored from pre-test record") { it.themeMode == original.getString("themeMode") && !it.busy }
        compose.runOnIdle { model.accentChange(original.getString("accentColor")) }
        until("Original accent restored from pre-test record") { it.accentColor == original.getString("accentColor") && !it.busy }
        compose.runOnIdle { model.identityLabelsChange(original.getString("userLabel"), original.getString("assistantLabel")) }
        until("Original identity labels restored") {
            it.userLabel == original.getString("userLabel") && it.assistantLabel == original.getString("assistantLabel") && !it.busy
        }
        val scale = original.getDouble("readingScale").toFloat()
        compose.runOnIdle { model.readingScaleChange(scale) }
        until("Original reading scale restored") { it.readingScale == scale && !it.busy }
        val avatar = if (original.isNull("avatarFileName")) null else original.getString("avatarFileName")
        // Never delete or recreate an original image. Missing original bytes retain
        // their original preference and use the product's visible default fallback.
        runBlocking { ClientPreferences(context).saveAvatar(avatar) }
        compose.runOnIdle { model.refreshLocalAvatar() }
        until("Original avatar preference restored") { it.avatarFileName == avatar }
        val currentPreferences = runBlocking { ClientPreferences(context).snapshot() }
        var selectionRestored = false
        var selectionReason = if (unknownIds.isNotEmpty()) "未知操作仍受保护；保留当前会话、草稿及附件上下文"
            else "原选择未在当前真实列表中确认；保留当前测试入口"
        val oldProject = if (original.isNull("projectId")) null else original.getString("projectId")
        val oldThread = if (original.isNull("threadId")) null else original.getString("threadId")
        val sameScope = !original.isNull("scopeKey") && currentPreferences.scopeKey == original.getString("scopeKey")
        if (unknownIds.isEmpty() && sameScope && oldProject != null && state.projects.any { it.id == oldProject }) {
            if (oldThread == null) {
                compose.runOnIdle { model.selectProject(oldProject) }
                until("Original project-only selection restored") { it.selectedProjectId == oldProject && it.selectedThreadId == null && !it.busy }
                selectionRestored = true
            } else if (state.selectedProjectId == oldProject && state.threads.any { it.id == oldThread }) {
                compose.runOnIdle { model.selectThread(oldThread) }
                until("Original known thread selected read-only") { it.selectedThreadId == oldThread && !it.busy }
                selectionRestored = true
            }
        }
        if (selectionRestored) selectionReason = "原选择已通过现有项目/会话列表确认后只读恢复"
        assertEquals("Local preference cleanup must preserve every unknown operation", unknownIds,
            state.unresolvedOperations.map { it.operationId }.toSet())
        if (unknownIds.isNotEmpty()) {
            assertEquals(protectedProject, state.selectedProjectId)
            assertEquals(protectedThread, state.selectedThreadId)
            assertEquals(protectedDraft, state.draft)
            assertEquals(heldAttachmentIds,
                model.files.state.value.attachments.filter { it.status == "held" }.map { it.id }.toSet())
            assertFalse(state.canSend)
            assertFalse(state.canResume)
        }
        assertOriginalDraftPreserved()
        record("i2-restored-original-local-preferences", JSONObject().put("originalDraftPreserved", true)
            .put("originalPreferencesRestored", true).put("originalSelectionRestored", selectionRestored)
            .put("selectionReason", selectionReason).put("unknownReceiptsCleared", false)
            .put("preservedUnknownCount", unknownIds.size))
    }

    private fun waitForDocumentsUi() {
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            if (instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString()?.contains("documentsui") == true) return
            Thread.sleep(100)
        }
        fail("Android system DocumentsUI did not open")
    }

    private fun currentResumedActivity(): MainActivity? {
        var activity: MainActivity? = null
        instrumentation.runOnMainSync {
            activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                .filterIsInstance<MainActivity>().singleOrNull()
        }
        return activity
    }

    private fun waitObserved(description: String, timeout: Long = 120_000, check: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < deadline) {
            if (check()) return
            Thread.sleep(80)
        }
        fail(description)
    }

    private fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command))
            .bufferedReader().use { it.readText() }

    private fun assertDurableTestDraft(text: String) = runBlocking {
        val saved = ClientPreferences(context).snapshot()
        assertEquals(checkpoint().getString("threadId"), saved.threadId)
        val database = StateDatabase.open(context)
        try {
            withTimeout(5_000) {
                while (database.state().draft(checkNotNull(saved.scopeKey), checkNotNull(saved.projectId), checkNotNull(saved.threadId))?.text != text) delay(50)
            }
        } finally { database.close() }
    }

    private fun chooseTestDocument(name: String) {
        waitForDocumentsUi()
        useDocumentListView()
        if (findSystemNode(instrumentation.uiAutomation.rootInActiveWindow, setOf(name)) == null) {
            clickSystemNode(setOf("Show roots", "Open navigation drawer", "显示根目录", "打开导航抽屉"))
            clickSystemNode(setOf("Phase 3 test files"))
            useDocumentListView()
        }
        clickSystemNode(setOf(name))
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            if (instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() == context.packageName) {
                waitForOwnForeground("System picker returned the selected test document")
                return
            }
            if (findSystemNode(instrumentation.uiAutomation.rootInActiveWindow, setOf("Open", "打开")) != null) clickSystemNode(setOf("Open", "打开"))
            Thread.sleep(100)
        }
        fail("System picker did not return the test image")
    }

    private fun useDocumentListView() {
        // In this device's grid, a file cell exposes "name, size, date" while
        // its clickable child opens Preview. List mode exposes the exact name
        // used by the existing selector, without ever invoking that child.
        val listControl = setOf("List View")
        if (findSystemNode(instrumentation.uiAutomation.rootInActiveWindow, listControl) != null) {
            clickSystemNode(listControl)
            waitObserved("DocumentsUI switched from grid to list", 5_000) {
                findSystemNode(instrumentation.uiAutomation.rootInActiveWindow, listControl) == null
            }
        }
    }

    private fun waitForOwnForeground(description: String) {
        enableWindowInspection()
        waitObserved(description, 15_000) {
            currentResumedActivity()?.window?.decorView?.isAttachedToWindow == true &&
                ownWindowFocused()
        }
    }

    /** Dispatch via the system so a disappearing dialog cannot leave Espresso bound to an unfocused root. */
    private fun systemBackUntilGone(tag: String) {
        if (compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isEmpty()) return
        enableWindowInspection()
        shell("input keyevent KEYCODE_BACK")
        waitObserved("Dismissed $tag and returned focus to the app", 15_000) {
            currentResumedActivity() != null && ownWindowFocused() &&
                runCatching { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isEmpty() }.getOrDefault(false)
        }
    }

    private fun enableWindowInspection() {
        val automation = instrumentation.uiAutomation
        automation.serviceInfo = automation.serviceInfo.apply {
            flags = flags or android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        }
    }

    private fun ownWindowFocused(): Boolean = instrumentation.uiAutomation.windows.any {
        it.isFocused && it.root?.packageName?.toString() == context.packageName
    }

    private fun clickSystemNode(labels: Set<String>) {
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            var node = findSystemNode(instrumentation.uiAutomation.rootInActiveWindow, labels)
            while (node != null) {
                if (node.isClickable && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return
                node = node.parent
            }
            Thread.sleep(100)
        }
        fail("Required system picker control missing")
    }

    private fun findSystemNode(node: AccessibilityNodeInfo?, labels: Set<String>): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.isVisibleToUser && (node.text?.toString() in labels || node.contentDescription?.toString() in labels)) return node
        for (index in 0 until node.childCount) findSystemNode(node.getChild(index), labels)?.let { return it }
        return null
    }
}
