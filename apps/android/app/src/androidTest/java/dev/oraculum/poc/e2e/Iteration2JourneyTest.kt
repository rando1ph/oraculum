package dev.oraculum.poc.e2e

import android.app.NotificationManager
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import android.os.Process
import android.service.notification.StatusBarNotification
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.espresso.Espresso
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import dev.oraculum.poc.MainActivity
import dev.oraculum.poc.notifications.GatewayNotifications
import dev.oraculum.poc.notifications.noticeHash
import dev.oraculum.poc.storage.ClientPreferences
import dev.oraculum.poc.storage.AvatarStore
import dev.oraculum.poc.storage.StateDatabase
import dev.oraculum.poc.ui.PocUiState
import java.io.File
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
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
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
            Espresso.pressBack() // Never clear the user's multi-connection cache for a visual check.
            compose.onNodeWithTag("close-panel").performClick()

            compose.onNodeWithTag("composer-add").performClick()
            compose.onNodeWithTag("files_pick").assertIsDisplayed()
            compose.onNodeWithTag("composer-files").assertIsDisplayed()
            compose.onNodeWithTag("composer-navigation").assertIsDisplayed()
            screenshot("i2-09-composer-actions")
            compose.onNodeWithTag("composer-files").performClick()
            compose.onNodeWithTag("files_panel").assertIsDisplayed()
            screenshot("i2-10-composer-project-files")
            Espresso.pressBack()

            compose.onNodeWithTag("model-picker").performClick()
            compose.onNodeWithTag("model-sheet").assertIsDisplayed()
            screenshot("i2-11-model-effort-sheet")
            compose.onNodeWithTag("choose-model").performClick()
            val selected = state.models.firstOrNull { it.id == state.selectedModel } ?: state.models.first()
            compose.onNodeWithTag("model-${selected.id}").performScrollTo().assertIsDisplayed()
            screenshot("i2-12-model-catalog")
            Espresso.pressBack()
            compose.onNodeWithTag("model-sheet").assertDoesNotExist()
            compose.onNodeWithTag("permission-picker").performClick()
            compose.onNodeWithTag("permission-sheet").assertIsDisplayed()
            screenshot("i2-13-permission-sheet")
            compose.onNodeWithTag("permission-full-access").performScrollTo().performClick()
            compose.onNodeWithTag("confirm-full-access").assertIsDisplayed()
            assertEquals(before.permissionPreset, state.permissionPreset)
            screenshot("i2-14-full-access-confirmation")
            Espresso.pressBack()
            Espresso.pressBack()
            compose.onNodeWithTag("permission-sheet").assertDoesNotExist()

            compose.runOnIdle { model.refreshInspector() }
            until("Real extension read completed") { !it.busy }
            compose.onNodeWithTag("inspector").performClick()
            compose.onNodeWithTag("inspector-extensions").performScrollTo().performClick()
            screenshot("i2-15-mcp-capabilities")
            compose.onNodeWithTag("inspector-usage").performScrollTo().performClick()
            screenshot("i2-16-native-usage")
            Espresso.pressBack()
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

    /** Replaces only an absent avatar; an existing personal image is never overwritten. */
    @Test fun avatarSystemPickerAndPrivatePersistence() {
        connected()
        val before = state
        openSettings()
        compose.onNodeWithTag("avatar-pick").performScrollTo().performClick()
        waitForDocumentsUi()
        Espresso.pressBack()
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
        Espresso.pressBack()
        assertOriginalDraftPreserved()
        record("i2-native-approval", JSONObject().put("kind", request.kind).put("decision", decision))
    }

    /** Actual Home background delivery in the same live process; no force-stop/death claim. */
    @Test fun homeBackgroundNotification() {
        connected()
        assertFalse("A previous background write must be inspected, never resent for this stage",
            File(directory, "background-intent.json").exists())
        val activity = compose.activity
        val initialModel = activity.model
        val checkpoint = checkpoint()
        val thread = checkpoint.getString("threadId")
        val project = checkpoint.getString("projectId")
        val previousDraft = state.draft
        val beforeMessages = state.messages.map { it.id }.toSet()
        val processId = Process.myPid()
        val manager = context.getSystemService(NotificationManager::class.java)
        assertTrue("Actual Android notification permission must already be enabled", manager.areNotificationsEnabled())
        val existingNotifications = manager.activeNotifications.map { it.key }.toSet()
        val scope = checkNotNull(runBlocking { ClientPreferences(context).snapshot().scopeKey })
        var routed: MainActivity? = null
        try {
            sendOnce("background", "Use the shell exactly once to execute sleep 8; printf 'I2_BACKGROUND\\n'. This only waits and prints a fixed marker. Do not read or modify files. After the command finishes, reply I2_BACKGROUND_DONE in one short Chinese sentence.")
            waitObserved("Explicit real native Turn active before Home") { initialModel.state.value.canStop }
            val launcher = shell("cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME")
                .lineSequence().map(String::trim).lastOrNull { it.matches(Regex("^[A-Za-z0-9_.]+/[A-Za-z0-9_.$]+$")) }
                ?.substringBefore('/') ?: error("Cannot identify current Home launcher")
            shell("input keyevent KEYCODE_HOME")
            waitObserved("Home stopped the Activity and displayed the actual launcher", 20_000) {
                lifecycleStage(activity) == Stage.STOPPED &&
                    instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() == launcher
            }
            val backgroundAt = System.currentTimeMillis()
            waitObserved("Actual command and final answer received while stopped", 240_000) {
                assertEquals("The app process must remain alive in this scenario", processId, Process.myPid())
                assertEquals("Do not return to the app before completion", Stage.STOPPED, lifecycleStage(activity))
                initialModel.state.value.let { current -> !current.busy && !current.canStop &&
                    current.messages.any { it.id !in beforeMessages && it.role == "assistant" && it.text.contains("I2_BACKGROUND_DONE") } &&
                    current.messages.any { it.id !in beforeMessages && it.role == "commandExecution" && it.text.contains("I2_BACKGROUND") }
                }
            }
            val answer = initialModel.state.value.messages.last {
                it.id !in beforeMessages && it.role == "assistant" && it.text.contains("I2_BACKGROUND_DONE")
            }
            val tag = noticeHash(scope, project, thread, "turn", answer.turnId)
            var notification: StatusBarNotification? = null
            waitObserved("Own native Turn notification posted after Home", 15_000) {
                assertEquals(Stage.STOPPED, lifecycleStage(activity))
                notification = manager.activeNotifications.firstOrNull {
                    it.packageName == context.packageName && it.key !in existingNotifications && it.tag == tag &&
                        it.notification.channelId == GatewayNotifications.TURNS_CHANNEL && it.postTime >= backgroundAt
                }
                notification != null
            }
            val delivered = checkNotNull(notification)
            val title = delivered.notification.extras.getCharSequence(android.app.Notification.EXTRA_TITLE)?.toString()
            assertEquals("Codex 执行完成", title)
            // Invoke the exact real notification PendingIntent. The notification shade
            // is deliberately not captured because it could contain unrelated private notices.
            checkNotNull(delivered.notification.contentIntent).send()
            waitObserved("Actual notification routes to the dedicated thread", 60_000) {
                routed = currentResumedActivity()
                routed?.model?.state?.value?.let {
                    it.online && !it.busy && it.selectedProjectId == project && it.selectedThreadId == thread &&
                        it.navigationRequest?.startsWith("inspector:") == true
                } == true
            }
            assertEquals(processId, Process.myPid())
            instrumentation.waitForIdleSync()
            val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
            try { File(directory, "i2-31-background-notification-routed.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) } }
            finally { bitmap.recycle() }
            assertOriginalDraftPreserved()
            val build = context.assets.open("oraculum-build.json").bufferedReader().use { JSONObject(it.readText()) }
            File(directory, "i2-background-notification.json").writeText(JSONObject().put("passed", true).put("build", build)
                .put("projectId", project).put("threadId", thread).put("nativeTurnId", answer.turnId)
                .put("activityStoppedBeforeCompletion", true).put("sameProcessAlive", true)
                .put("exactNativeTurnNotificationMatched", true).put("notificationTitle", title)
                .put("notificationChannel", delivered.notification.channelId)
                .put("ownActiveNotificationCount", manager.activeNotifications.count { it.packageName == context.packageName })
                .put("actualPendingIntentRouted", true).put("notificationShadeCaptured", false)
                .put("processDeathOrForceStopTested", false).toString(2))
        } finally {
            // Return the device to this test app after a failure as well, without touching
            // another app's data or restarting the native operation.
            if (currentResumedActivity() == null) instrumentation.runOnMainSync {
                context.startActivity(Intent(context, MainActivity::class.java).setAction(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_LAUNCHER)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
            }
            waitObserved("Test app foreground restored after Home", 20_000) { currentResumedActivity() != null }
            val restored = checkNotNull(currentResumedActivity())
            // Restore only this harness's dedicated draft, never a newly selected user thread.
            val restoredState = restored.model.state.value
            if (restoredState.selectedThreadId == thread && !restoredState.canStop &&
                restoredState.unresolvedOperations.none { it.threadId == thread })
                instrumentation.runOnMainSync { restored.model.draftChange(previousDraft) }
        }
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

    private fun waitForDocumentsUi() {
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            if (instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString()?.contains("documentsui") == true) return
            Thread.sleep(100)
        }
        fail("Android system DocumentsUI did not open")
    }

    private fun lifecycleStage(activity: MainActivity): Stage? {
        var stage: Stage? = null
        instrumentation.runOnMainSync { stage = ActivityLifecycleMonitorRegistry.getInstance().getLifecycleStageOf(activity) }
        return stage
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
        if (findSystemNode(instrumentation.uiAutomation.rootInActiveWindow, setOf(name)) == null) {
            clickSystemNode(setOf("Show roots", "Open navigation drawer", "显示根目录", "打开导航抽屉"))
            clickSystemNode(setOf("Phase 3 test files"))
        }
        clickSystemNode(setOf(name))
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            if (instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() == context.packageName) return
            if (findSystemNode(instrumentation.uiAutomation.rootInActiveWindow, setOf("Open", "打开")) != null) clickSystemNode(setOf("Open", "打开"))
            Thread.sleep(100)
        }
        fail("System picker did not return the test image")
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
