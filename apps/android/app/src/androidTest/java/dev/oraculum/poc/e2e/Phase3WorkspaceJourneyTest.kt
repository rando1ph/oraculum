package dev.oraculum.poc.e2e

import android.app.NotificationManager
import android.content.Context
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.espresso.Espresso
import androidx.test.platform.app.InstrumentationRegistry
import dev.oraculum.poc.MainActivity
import dev.oraculum.poc.ui.PocUiState
import java.io.File
import java.nio.file.Paths
import java.util.UUID
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Stateful, opt-in journeys. Run named methods in the documented order, never as a random suite. */
class Phase3WorkspaceJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val model get() = compose.activity.model
    private val state get() = model.state.value
    private val directory get() = File(context.filesDir, "phase3-evidence").apply { mkdirs() }

    private fun input(): JSONObject {
        val file = File(context.noBackupFilesDir, "phase3-e2e.json")
        assumeTrue("Opt-in Phase 3 private fixture input required", file.isFile)
        return JSONObject(file.readText())
    }

    private fun until(description: String, timeout: Long = 120_000, frames: Boolean = true, check: (PocUiState) -> Boolean) {
        val deadline = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < deadline) {
            if (frames) compose.waitForIdle()
            if (check(state)) return
            Thread.sleep(80)
        }
        fail("$description; connection=${state.connectionLabel}; error=${state.error}; execution=${state.executionLabel}; canSend=${state.canSend}; canStop=${state.canStop}; canResume=${state.canResume}; unresolved=${state.unresolvedOperations.size}; history=${state.historyWarning}")
    }

    private fun screenshot(name: String) {
        compose.waitForIdle()
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private fun record(name: String, extra: JSONObject = JSONObject()) {
        File(directory, "$name.json").writeText(extra.put("passed", true).put("threadId", state.selectedThreadId)
            .put("projectId", state.selectedProjectId).put("theme", state.themeMode).put("messages", state.messages.size).toString(2))
    }

    private fun connected() {
        input()
        until("Online dedicated Phase 3 thread") { it.online && it.paired && !it.busy && it.selectedThreadId != null }
        assertEquals(JSONObject(File(directory, "checkpoint.json").readText()).getString("threadId"), state.selectedThreadId)
    }

    private fun send(text: String) {
        compose.onNodeWithTag("draft").performTextReplacement(text)
        Espresso.closeSoftKeyboard()
        until("Explicit send enabled") { it.canSend }
        compose.onNodeWithTag("send").assertIsEnabled().performClick()
    }

    @Test fun pairRegisterAndReadNativeThread() {
        val config = input()
        until("Prior app initialization settled") { !it.busy }
        if (state.endpoint != config.getString("endpoint")) {
            assertFalse("Do not replace an active endpoint", state.online)
            compose.runOnIdle { model.endpointChange(config.getString("endpoint")) }
        }
        if (!state.paired) {
            compose.onNodeWithTag("endpoint").performTextReplacement(config.getString("endpoint"))
            compose.onNodeWithTag("pair-code").performTextReplacement(config.getString("pairCode"))
            compose.onNodeWithTag("pair").performClick()
        } else compose.runOnIdle { model.reconnect() }
        until("New isolated endpoint paired") { it.online && it.paired && !it.busy }
        if (state.projects.isEmpty()) {
            compose.runOnIdle { model.registerProject(config.getString("rootId"), config.getString("projectRelativePath")) }
        }
        until("Dedicated fixture project registered") { it.projects.size == 1 && !it.busy }
        compose.runOnIdle { model.selectProject(state.projects.single().id) }
        until("Project selected") { it.selectedProjectId != null && !it.busy }
        compose.onNodeWithTag("navigation").performClick()
        compose.onNodeWithTag("new-thread").assertIsDisplayed().performClick()
        until("Native thread created explicitly") { it.selectedThreadId != null && !it.busy }
        send("Reply with P3_NATIVE_OK followed by a short Markdown heading, a three-item checklist and a fenced Kotlin code block. Do not use tools.")
        until("Real Codex response completed", 240_000) {
            !it.canStop && !it.busy && it.messages.any { m -> m.role == "assistant" && m.text.contains("P3_NATIVE_OK") }
        }
        assertTrue("Models must come from Gateway", state.models.isNotEmpty())
        compose.runOnIdle { model.draftChange("P3_LOCAL_DRAFT_DO_NOT_SEND") }
        until("Native completed snapshot converged to writable state with an unsent local draft") { !it.busy && it.canSend }
        File(directory, "checkpoint.json").writeText(JSONObject().put("projectId", state.selectedProjectId)
            .put("threadId", state.selectedThreadId).put("draft", state.draft).toString())
        screenshot("01-native-workspace")
        record("native-initial")
    }

    @Test fun panelsThemesAndImePreserveDraft() {
        connected()
        val thread = state.selectedThreadId
        val draft = state.draft
        val originalTheme = state.themeMode
        val originalHardwareIme = shell("settings get secure show_ime_with_hard_keyboard").trim().toIntOrNull()
        try {
            for (theme in listOf("light", "dark", "oled")) {
                compose.onNodeWithTag("settings").performClick()
                compose.onNodeWithTag("theme-$theme").performScrollTo().performClick()
                until("Theme $theme applied") { it.themeMode == theme }
                Espresso.pressBack()
                screenshot("02-theme-$theme")
            }
            compose.onNodeWithTag("navigation").performClick()
            screenshot("03-navigation")
            Espresso.pressBack()
            compose.onNodeWithTag("draft").assertExists()
            compose.onNodeWithTag("inspector").performClick()
            screenshot("04-inspector")
            Espresso.pressBack()
            // This Emulator has a hardware keyboard. Temporarily request the real
            // software IME too; restore the user's exact setting in finally.
            shell("settings put secure show_ime_with_hard_keyboard 1")
            compose.onNodeWithTag("draft").performTextReplacement(draft + "\nIME 检查")
            compose.onNodeWithTag("draft").performClick()
            waitForStableIme()
            compose.onNodeWithTag("draft").assertIsDisplayed()
            compose.onNodeWithTag("send").assertIsDisplayed()
            screenshot("05-native-ime")
            assertNotNull("The actual IME window must still be visible after screenshot", visibleImeBounds())
            Espresso.closeSoftKeyboard()
            assertEquals(thread, state.selectedThreadId)
            assertEquals(draft + "\nIME 检查", state.draft)
            compose.runOnIdle { model.draftChange(draft) }
            record("panels-themes-ime", JSONObject().put("themeModes", 3).put("threadPreserved", true))
        } finally {
            shell(if (originalHardwareIme == null) "settings delete secure show_ime_with_hard_keyboard"
                else "settings put secure show_ime_with_hard_keyboard $originalHardwareIme")
            compose.runOnIdle { model.themeChange(originalTheme); model.draftChange(draft) }
        }
    }

    /** A read-only recovery/capture step for an already completed initial journey; never starts a Turn. */
    @Test fun captureSettledNativeWorkspace() {
        connected()
        if (state.draft.isBlank()) compose.runOnIdle { model.draftChange("P3_LOCAL_DRAFT_DO_NOT_SEND") }
        until("Existing real completed thread snapshot converged") { !it.busy && it.canSend && !it.canStop }
        compose.onNodeWithTag("send").assertIsDisplayed().assertIsEnabled()
        screenshot("01b-native-workspace-settled")
        record("native-snapshot-settled", JSONObject().put("canSendAfterSnapshot", true))
    }

    @Test fun landscapeAndLargeFontPreserveWorkspace() {
        connected()
        val thread = state.selectedThreadId
        val draft = state.draft
        val oldOrientation = compose.activity.requestedOrientation
        val oldScale = shell("settings get system font_scale").trim().toFloatOrNull()
        try {
            shell("settings put system font_scale 2.0")
            compose.runOnIdle { compose.activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
            until("Landscape configuration applied") { compose.activity.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE }
            compose.onNodeWithTag("draft").assertIsDisplayed()
            compose.onNodeWithTag("send").assertIsDisplayed()
            compose.onNodeWithTag("inspector").performClick()
            screenshot("06-landscape-large-font")
            Espresso.pressBack()
            assertEquals(thread, state.selectedThreadId)
            assertEquals(draft, state.draft)
            assertTrue(compose.activity.resources.configuration.fontScale >= 1.9f)
            record("landscape-large-font", JSONObject().put("fontScale", compose.activity.resources.configuration.fontScale))
        } finally {
            shell(if (oldScale == null) "settings delete system font_scale" else "settings put system font_scale $oldScale")
            compose.runOnIdle { compose.activity.requestedOrientation = oldOrientation }
        }
    }

    @Test fun actualNativeApprovalCanBeDeclined() {
        connected()
        fun actionable(interaction: dev.oraculum.poc.repository.InteractionUi) = interaction.status == "pending" &&
            interaction.supported && interaction.decisions.any { it == "decline" || it == "cancel" }
        if (state.interactions.none(::actionable)) {
            assertTrue("An existing pending interaction must be inspected instead of starting another Turn", state.interactions.none { it.status == "pending" })
            assertFalse("An already active native Turn must be inspected before requesting a new one", state.canStop)
            compose.runOnIdle { model.selectPermission("read-only", false) }
            send("For this isolated acceptance test, use the shell to write the exact text P3_APPROVAL to the relative file phase3-approval.txt in the current test project. Request sandbox escalation when required; do not use another writing method and do not bypass approval. If denied or cancelled, stop and explain the outcome.")
        }
        until("Actual native approval offers denial or cancellation", 180_000) { it.interactions.any(::actionable) }
        val interaction = state.interactions.first(::actionable)
        val decision = if ("decline" in interaction.decisions) "decline" else "cancel"
        assertEquals(state.selectedThreadId, interaction.threadId)
        compose.onNodeWithTag("pending-interactions").performClick()
        compose.onAllNodesWithTag("interaction_${interaction.id}_$decision").onLast().performScrollTo()
        screenshot("07-real-native-approval-$decision")
        compose.onAllNodesWithTag("interaction_${interaction.id}_$decision").onLast().performClick()
        until("Native approval resolved and turn finished", 180_000) { !it.canStop && !it.busy && it.interactions.none { current -> current.id == interaction.id && current.status == "pending" } }
        Espresso.pressBack()
        record("native-approval", JSONObject().put("interactionId", interaction.id).put("kind", interaction.kind).put("decision", decision))
    }

    /** Positive file approval is limited to the exact complete native patch in this disposable project. */
    @Test fun actualNativeFileChangeCanBeReviewedAndAccepted() {
        connected()
        val config = input()
        val checkpoint = JSONObject(File(directory, "checkpoint.json").readText())
        assertEquals(config.getString("endpoint"), state.endpoint)
        assertEquals(checkpoint.getString("projectId"), state.selectedProjectId)
        val project = state.projects.single { it.id == state.selectedProjectId }
        val projectPath = Paths.get(project.detail).normalize()
        assertTrue("Only an absolute canonical test project is eligible", projectPath.isAbsolute)
        assertTrue("Only the fixture's disposable project is eligible", projectPath.parent.fileName.toString().startsWith("oraculum-android-v2-"))
        assertEquals(config.getString("projectRelativePath"), projectPath.fileName.toString())
        assertTrue("Inspect existing pending requests before starting this journey", state.interactions.none { it.status == "pending" })
        assertTrue("Unknown operations must remain blocking", state.unresolvedOperations.isEmpty())
        assertFalse("A prior native Turn must finish first", state.canStop)
        assertTrue("This approval test must not claim any attachment", model.files.state.value.attachments.isEmpty())
        val previousPermission = state.permissionPreset
        val previousDraft = state.draft
        val previousMessageIds = state.messages.map { it.id }.toSet()
        val marker = "P3_FILECHANGE_APPROVED_${UUID.randomUUID().toString().replace("-", "")}"
        val expectedPath = projectPath.resolve("phase3-approved.txt").toString()
        File(directory, "filechange-approval-request.json").writeText(JSONObject()
            .put("projectId", state.selectedProjectId).put("threadId", state.selectedThreadId)
            .put("relativePath", "phase3-approved.txt").put("marker", marker).toString(2))
        try {
            compose.runOnIdle { model.selectPermission("read-only", false) }
            assertEquals("read-only", state.permissionPreset)
            send("In this disposable test project, use only apply_patch to create the new relative file phase3-approved.txt with exactly one line: $marker. Request the native file-change approval required by the read-only sandbox and wait for the user decision. Do not use shell commands, other tools, another writing method, or modify any other path. If apply_patch or its approval is unavailable, stop and explain; do not bypass it. After the approved patch succeeds, reply with $marker.")
            until("Actual native fileChange approval with complete verified context", 180_000) {
                assertTrue("A command or other interaction cannot substitute for native fileChange approval",
                    it.interactions.none { request -> request.status == "pending" && request.kind != "fileChange" })
                it.interactions.any { request -> request.kind == "fileChange" && request.status == "pending" &&
                    request.supported && request.fileChangeContext != null && "accept" in request.decisions }
            }
            val interaction = state.interactions.single { it.kind == "fileChange" && it.status == "pending" }
            val review = checkNotNull(interaction.fileChangeContext)
            assertEquals(state.selectedProjectId, review.scope.projectId)
            assertEquals(state.selectedThreadId, review.scope.threadId)
            assertEquals(interaction.epoch, review.scope.epoch)
            assertTrue(interaction.generation > 0)
            assertEquals((interaction.request["turnId"] as? JsonPrimitive)?.content, review.turnId)
            assertEquals((interaction.request["itemId"] as? JsonPrimitive)?.content, review.itemId)
            assertTrue("No unstable remainder-of-session grant may be approved",
                interaction.request["grantRoot"] == null || interaction.request["grantRoot"] == JsonNull)
            assertTrue("Review digest must bind the actual native content", Regex("[a-f0-9]{64}").matches(review.digest))
            val change = review.changes.single()
            assertEquals("Only the exact new test file may be approved", expectedPath, change.path)
            assertEquals("add", change.kind)
            assertNull(change.movePath)
            assertTrue("Complete native Diff must contain this invocation's unique marker", change.diff.contains(marker))
            assertTrue("The single-line acceptance patch must remain small", change.diff.toByteArray(Charsets.UTF_8).size <= 1024)
            compose.onNodeWithTag("pending-interactions").performClick()
            val accept = compose.onAllNodesWithTag("interaction_${interaction.id}_accept").onLast()
            accept.performScrollTo().assertIsDisplayed().assertIsEnabled()
            val current = state.interactions.single { it.id == interaction.id }
            assertEquals(interaction.generation, current.generation)
            assertEquals(review.digest, current.fileChangeContext?.digest)
            screenshot("07c-real-filechange-reviewed")
            accept.performClick()
            until("Approved native fileChange and a new assistant reply completed", 240_000) {
                !it.canStop && !it.busy && it.error == null &&
                    it.interactions.none { request -> request.id == interaction.id && request.status == "pending" } &&
                    it.messages.any { message -> message.id !in previousMessageIds && message.turnId == review.turnId &&
                        message.role == "assistant" && message.status.isEmpty() && message.text.contains(marker) }
            }
            Espresso.pressBack()
            compose.runOnIdle { model.draftChange(previousDraft.ifBlank { "P3_APPROVAL_LOCAL_DRAFT_DO_NOT_SEND" }) }
            until("Approved Turn terminal snapshot converged without another send") { it.canSend && !it.canStop && !it.busy && it.error == null }
            screenshot("07d-real-filechange-approved")
            record("native-filechange-approved", JSONObject().put("interactionId", interaction.id)
                .put("turnId", review.turnId).put("itemId", review.itemId).put("generation", interaction.generation)
                .put("digest", review.digest).put("relativePath", "phase3-approved.txt").put("marker", marker)
                .put("decision", "accept").put("verifiedNativeContext", true).put("currentTerminalSnapshot", true))
        } finally {
            compose.runOnIdle {
                model.selectPermission(previousPermission, previousPermission == "full-access")
                model.draftChange(previousDraft)
            }
        }
    }

    /** Continue only this harness's existing native request; never creates a replacement Turn. */
    @Test fun nativeFileChangeWithoutReviewEvidenceCannotBeAccepted() {
        connected()
        val config = input()
        val checkpoint = JSONObject(File(directory, "checkpoint.json").readText())
        val saved = JSONObject(File(directory, "filechange-approval-request.json").readText())
        assertEquals(config.getString("endpoint"), state.endpoint)
        assertEquals(checkpoint.getString("projectId"), state.selectedProjectId)
        assertEquals(saved.getString("projectId"), state.selectedProjectId)
        assertEquals(saved.getString("threadId"), state.selectedThreadId)
        assertEquals("phase3-approved.txt", saved.getString("relativePath"))
        val marker = saved.getString("marker")
        assertTrue("Only the saved positive journey's unique marker is eligible", Regex("P3_FILECHANGE_APPROVED_[a-f0-9]{32}").matches(marker))
        val projectPath = Paths.get(state.projects.single { it.id == state.selectedProjectId }.detail).normalize()
        assertTrue(projectPath.isAbsolute)
        assertTrue(projectPath.parent.fileName.toString().startsWith("oraculum-android-v2-"))
        assertEquals(config.getString("projectRelativePath"), projectPath.fileName.toString())
        assertTrue("Never respond around unresolved writes", state.unresolvedOperations.isEmpty())
        val interaction = state.interactions.single { it.status == "pending" }
        assertEquals("fileChange", interaction.kind)
        assertEquals(state.selectedProjectId, interaction.projectId)
        assertEquals(state.selectedThreadId, interaction.threadId)
        val turn = checkNotNull((interaction.request["turnId"] as? JsonPrimitive)?.content)
        assertTrue("The original native Turn must contain this saved test prompt", state.messages.any {
            it.turnId == turn && it.role == "user" && it.text.contains(marker) && it.text.contains("phase3-approved.txt")
        })
        assertNull("This negative journey requires genuinely absent native review evidence", interaction.fileChangeContext)
        assertFalse("Missing evidence cannot expose an accept decision", "accept" in interaction.decisions)
        assertTrue(interaction.supported)
        val decision = when {
            "cancel" in interaction.decisions -> "cancel"
            "decline" in interaction.decisions -> "decline"
            else -> throw AssertionError("Native request offers no supported negative action; leave it untouched")
        }
        val previousDraft = state.draft
        try {
            compose.onNodeWithTag("pending-interactions").performClick()
            val acceptTag = "interaction_${interaction.id}_accept"
            val acceptNodes = compose.onAllNodesWithTag(acceptTag).fetchSemanticsNodes()
            if (acceptNodes.isEmpty()) compose.onNodeWithTag(acceptTag).assertDoesNotExist()
            else acceptNodes.indices.forEach { compose.onAllNodesWithTag(acceptTag)[it].assertIsNotEnabled() }
            val deny = compose.onAllNodesWithTag("interaction_${interaction.id}_$decision").onLast()
            deny.performScrollTo().assertIsDisplayed().assertIsEnabled()
            val current = state.interactions.single { it.id == interaction.id }
            assertEquals(interaction.generation, current.generation)
            assertNull(current.fileChangeContext)
            assertFalse("accept" in current.decisions)
            screenshot("07e-filechange-evidence-unavailable")
            deny.performClick()
            until("Original native fileChange was cancelled or declined and became terminal", 180_000) {
                it.online && !it.busy && !it.canStop && it.error == null && it.unresolvedOperations.isEmpty() &&
                    it.interactions.none { request -> request.id == interaction.id && request.status == "pending" }
            }
            Espresso.pressBack()
            compose.runOnIdle { model.draftChange(previousDraft.ifBlank { "P3_NEGATIVE_APPROVAL_DRAFT_DO_NOT_SEND" }) }
            until("Original cancelled Turn has a current terminal snapshot") { !it.busy && it.canSend && !it.canStop && it.error == null }
            screenshot("07f-filechange-safely-cancelled")
            record("native-filechange-missing-evidence-blocked", JSONObject().put("interactionId", interaction.id)
                .put("turnId", turn).put("generation", interaction.generation).put("marker", marker)
                .put("decision", decision).put("reviewEvidenceAbsent", true).put("positiveApprovalBlocked", true)
                .put("originalRequestOnly", true).put("currentTerminalSnapshot", true))
        } finally { compose.runOnIdle { model.draftChange(previousDraft) } }
    }

    @Test fun realToolsDiffUsageAndExtensions() {
        connected()
        val previousPermission = state.permissionPreset
        try {
            compose.runOnIdle { model.selectPermission("auto", false) }
            val previousMessageIds = state.messages.map { it.id }.toSet()
            send("In this disposable acceptance project only, use apply_patch to create phase3-output.md containing a Markdown heading 'Phase 3', a two-row table, and the marker P3_FILE_DIFF_OK. Then read that same relative file with a shell command and report P3_FILE_DIFF_OK. Do not modify any other file or any host configuration.")
            until("Real file change turn finished", 240_000) {
                !it.canStop && !it.busy && it.error == null && it.messages.any { message ->
                    message.id !in previousMessageIds && message.role == "assistant" && message.text.contains("P3_FILE_DIFF_OK") }
            }
            compose.runOnIdle { model.refreshInspector() }
            until("Real tool and usage projection available") { !it.busy && it.inspector.execution.isNotEmpty() && it.inspector.usage != null }
            assertTrue("Native file change supplies actual diff", !state.inspector.diff.isNullOrBlank())
            assertTrue("Read-only extensions supplied by Gateway", state.inspector.extensions.isNotEmpty())
            compose.onNodeWithTag("inspector").performClick()
            compose.onNodeWithTag("inspector-diff").performClick()
            screenshot("07a-real-diff")
            compose.onNodeWithTag("inspector-usage").performClick()
            screenshot("07b-real-usage")
            Espresso.pressBack()
            record("tools-diff-usage-extensions", JSONObject().put("executionItems", state.inspector.execution.size)
                .put("extensions", state.inspector.extensions.size).put("hasActualDiff", true).put("hasActualUsage", true))
        } finally { compose.runOnIdle { model.selectPermission(previousPermission, previousPermission == "full-access") } }
    }

    @Test fun nativeNotificationPermissionDenyThenGrant() {
        connected()
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        assertFalse("Start before the native permission has been granted; do not reset existing grants", manager.areNotificationsEnabled())
        compose.onNodeWithTag("settings").performClick()
        compose.onNodeWithTag("notification-settings").performScrollTo().performClick()
        val deny = waitForSystemNode("Native Android notification permission prompt") { node ->
            node.viewIdResourceName?.endsWith(":id/permission_deny_button") == true
        }
        screenshot("17-notification-permission-prompt")
        clickSystemNode(deny)
        until("Native denial leaves notifications disabled") {
            !manager.areNotificationsEnabled() && instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() == context.packageName
        }
        screenshot("18-notification-permission-denied")
        compose.onNodeWithTag("notification-settings").performScrollTo().performClick()
        val grant = waitForSystemNode("Native allow button or system notification switch") { node ->
            node.viewIdResourceName?.endsWith(":id/permission_allow_button") == true ||
                (node.packageName?.toString() == "com.android.settings" && node.isCheckable && !node.isChecked &&
                    node.className?.toString()?.contains("Switch", true) == true)
        }
        clickSystemNode(grant)
        until("Native permission grant enabled notifications") { manager.areNotificationsEnabled() }
        if (instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() == "com.android.settings") {
            instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        }
        until("Returned to actual app settings") { instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() == context.packageName }
        screenshot("19-notification-permission-enabled")
        Espresso.pressBack()
        record("notification-native-deny-grant", JSONObject().put("deniedThenGrantedThroughSystemUi", true))
    }

    @Test fun lostAcknowledgementShowsDurableUnknown() {
        connected()
        until("Settled attachment scope loaded before explicit claim") {
            model.files.state.value.threadId == it.selectedThreadId && !model.files.state.value.busy
        }
        val attachmentIds = model.files.state.value.attachments.filter { it.status == "ready" }.map { it.id }.toSet()
        assertEquals("Prepare exactly one real uploaded attachment before the lost Turn ACK journey", 1, attachmentIds.size)
        assertFalse(model.files.state.value.hasUnknown)
        send("Reply exactly P3_ACK_ONCE. Do not use tools.")
        until("Lost real response preserves durable operation and attachment claim") {
            !it.online && !it.busy && it.unresolvedOperations.isNotEmpty() && model.files.state.value.hasUnknown &&
                attachmentIds.all { id -> model.files.state.value.attachments.any { attachment -> attachment.id == id && attachment.status == "held" } }
        }
        val operation = state.unresolvedOperations.single { it.kind == "turn.start" }
        assertEquals(state.selectedProjectId, operation.projectId)
        assertEquals(state.selectedThreadId, operation.threadId)
        assertTrue(operation.operationId.isNotBlank())
        assertTrue(operation.createdAt > 0)
        assertFalse(state.canSend)
        assertFalse(state.canResume)
        File(directory, "unknown-checkpoint.json").writeText(JSONObject().put("operationId", operation.operationId)
            .put("attachmentIds", JSONArray(attachmentIds.toList())).toString())
        screenshot("09-unknown-details")
        record("unknown-lost-ack", JSONObject().put("operationId", operation.operationId).put("delivery", operation.delivery)
            .put("heldAttachmentCount", attachmentIds.size))
    }

    @Test fun unknownSurvivesProcessRestartWithoutResend() {
        input()
        val saved = JSONObject(File(directory, "unknown-checkpoint.json").readText())
        val id = saved.getString("operationId")
        val attachments = saved.getJSONArray("attachmentIds")
        val attachmentIds = (0 until attachments.length()).map { attachments.getString(it) }.toSet()
        assertTrue(attachmentIds.isNotEmpty())
        until("Offline operation and attachment claim unknown restored") {
            !it.online && !it.busy && it.unresolvedOperations.any { op -> op.operationId == id } &&
                model.files.state.value.hasUnknown && attachmentIds.all { attachmentId ->
                    model.files.state.value.attachments.any { attachment -> attachment.id == attachmentId && attachment.status == "held" }
                }
        }
        assertFalse(state.canSend)
        assertFalse(state.canResume)
        compose.onNodeWithTag("navigation").performClick()
        Espresso.pressBack()
        assertTrue(state.unresolvedOperations.any { it.operationId == id })
        screenshot("10-unknown-restored")
        record("unknown-process-restart", JSONObject().put("operationId", id).put("heldAttachmentCount", attachmentIds.size))
    }

    @Test fun unknownReconcilesOnlyWithOriginalReceipt() {
        input()
        val saved = JSONObject(File(directory, "unknown-checkpoint.json").readText())
        val id = saved.getString("operationId")
        val attachments = saved.getJSONArray("attachmentIds")
        val attachmentIds = (0 until attachments.length()).map { attachments.getString(it) }.toSet()
        assertTrue(attachmentIds.isNotEmpty())
        compose.runOnIdle { model.reconnect() }
        until("Original operation resolved by real receipt", 180_000) {
            it.online && !it.busy && it.unresolvedOperations.none { op -> op.operationId == id } &&
                it.messages.any { message -> message.role == "assistant" && message.text.contains("P3_ACK_ONCE") } &&
                model.files.state.value.threadId == it.selectedThreadId && !model.files.state.value.busy && !model.files.state.value.hasUnknown &&
                model.files.state.value.attachments.none { attachment -> attachment.id in attachmentIds }
        }
        assertNull(state.unknownWarning)
        record("unknown-original-receipt", JSONObject().put("operationId", id).put("claimedAttachmentsSettled", attachmentIds.size))
    }

    private fun shell(command: String): String = instrumentation.uiAutomation.executeShellCommand(command).use {
        android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().readText()
    }

    private fun visibleImeBounds(): Rect? {
        val window = instrumentation.uiAutomation.windows.firstOrNull {
            it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD && it.root?.isVisibleToUser == true
        } ?: return null
        return Rect().also(window::getBoundsInScreen).takeUnless { it.isEmpty || it.height() < 100 }
    }

    private fun waitForStableIme() {
        val automation = instrumentation.uiAutomation
        automation.serviceInfo = automation.serviceInfo.apply {
            flags = flags or android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        }
        var lastGeometry: String? = null
        var stableSamples = 0
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            compose.waitForIdle()
            val bounds = visibleImeBounds()
            val insets = androidx.core.view.ViewCompat.getRootWindowInsets(compose.activity.window.decorView)
            val imeHeight = insets?.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime())?.bottom ?: 0
            val visible = insets?.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime()) == true
            val geometry = if (visible && imeHeight > 100 && bounds != null) "$imeHeight:${bounds.flattenToString()}" else null
            stableSamples = if (geometry != null && geometry == lastGeometry) stableSamples + 1 else 0
            if (stableSamples >= 4) return
            lastGeometry = geometry
            Thread.sleep(100) // Poll actual window geometry; no fixed animation sleep is used.
        }
        fail("Native keyboard window and IME insets never became visibly stable")
    }

    private fun waitForSystemNode(description: String, matches: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo {
        fun find(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
            if (node == null) return null
            if (node.isVisibleToUser && matches(node)) return node
            for (index in 0 until node.childCount) find(node.getChild(index))?.let { return it }
            return null
        }
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            find(instrumentation.uiAutomation.rootInActiveWindow)?.let { return it }
            Thread.sleep(100)
        }
        fail(description)
        throw AssertionError(description)
    }

    private fun clickSystemNode(start: AccessibilityNodeInfo) {
        var node: AccessibilityNodeInfo? = start
        while (node != null) {
            if (node.isClickable && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return
            node = node.parent
        }
        fail("Native system control could not be clicked")
    }
}
