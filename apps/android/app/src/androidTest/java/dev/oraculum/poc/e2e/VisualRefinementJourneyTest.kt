package dev.oraculum.poc.e2e

import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.espresso.Espresso
import androidx.test.platform.app.InstrumentationRegistry
import dev.oraculum.poc.MainActivity
import dev.oraculum.poc.ui.PocUiState
import dev.oraculum.poc.ui.markdownBlocks
import java.io.File
import java.util.UUID
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/**
 * Opt-in visual acceptance of the actual Activity and its real Phase 3 Gateway.
 * Run named methods after Phase3WorkspaceJourneyTest has created its checkpoint.
 * These tests do not seed synthetic UI state or start native Turns. The approval
 * method only declines/cancels an already pending request in the checkpoint thread.
 */
class VisualRefinementJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val model get() = compose.activity.model
    private val state get() = model.state.value
    private val directory get() = File(context.filesDir, "phase3-evidence").apply { mkdirs() }

    private fun until(description: String, timeout: Long = 120_000, check: (PocUiState) -> Boolean) {
        val deadline = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < deadline) {
            compose.waitForIdle()
            if (check(state)) return
            Thread.sleep(80)
        }
        fail("$description; online=${state.online}, busy=${state.busy}, canSend=${state.canSend}, canStop=${state.canStop}")
    }

    private fun connected(requireSettled: Boolean = true) {
        val input = File(context.noBackupFilesDir, "phase3-e2e.json")
        assumeTrue("Opt-in Phase 3 private fixture input required", input.isFile)
        val config = JSONObject(input.readText())
        val checkpointFile = File(directory, "checkpoint.json")
        assertTrue("Run pairRegisterAndReadNativeThread first", checkpointFile.isFile)
        val checkpoint = JSONObject(checkpointFile.readText())
        until("Online dedicated Phase 3 checkpoint") {
            it.paired && it.online && !it.busy && it.selectedThreadId != null && (!requireSettled || !it.canStop)
        }
        assertEquals(config.getString("endpoint"), state.endpoint)
        assertEquals(checkpoint.getString("projectId"), state.selectedProjectId)
        assertEquals(checkpoint.getString("threadId"), state.selectedThreadId)
        assertTrue("Unresolved writes must be reconciled before read-only visual journeys", state.unresolvedOperations.isEmpty())
        if (requireSettled) assertTrue("Resolve pending native requests before read-only visual journeys",
            state.interactions.none { it.status == "pending" })
    }

    private fun screenshot(name: String) {
        compose.waitForIdle()
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private fun record(name: String, extra: JSONObject = JSONObject()) {
        val build = context.assets.open("oraculum-build.json").bufferedReader().use { JSONObject(it.readText()) }
        File(directory, "$name.json").writeText(extra.put("passed", true)
            .put("build", build).put("threadId", state.selectedThreadId)
            .put("fontScale", compose.activity.resources.configuration.fontScale).toString(2))
    }

    private fun assertAction(tag: String, description: String? = null) {
        val node = compose.onNodeWithTag(tag).assertIsDisplayed().assertHasClickAction()
        if (description != null) node.assertContentDescriptionContains(description)
        assertTouchTarget(node)
    }

    private fun assertTouchTarget(node: SemanticsNodeInteraction) {
        val bounds = node.fetchSemanticsNode().boundsInRoot
        val minimum = 48f * compose.activity.resources.displayMetrics.density - 1f
        assertTrue("Touch target width must remain at least 48 dp", bounds.width >= minimum)
        assertTrue("Touch target height must remain at least 48 dp", bounds.height >= minimum)
    }

    private fun assertSelectionPreserved(before: PocUiState) {
        assertEquals(before.selectedProjectId, state.selectedProjectId)
        assertEquals(before.selectedThreadId, state.selectedThreadId)
        assertEquals(before.draft, state.draft)
        assertEquals(before.selectedModel, state.selectedModel)
        assertEquals(before.selectedEffort, state.selectedEffort)
        assertEquals(before.permissionPreset, state.permissionPreset)
        assertEquals(before.messages.map { it.id }, state.messages.map { it.id })
    }

    @Test fun navigationFilterStaysLocalAndReversible() {
        connected()
        val before = state
        assertTrue(before.projects.isNotEmpty())
        assertTrue(before.threads.isNotEmpty())
        compose.onNodeWithTag("navigation").performClick()
        compose.onNodeWithTag("filter-navigation").assertDoesNotExist()
        compose.onNodeWithText("工作区", substring = false).assertDoesNotExist()
        assertAction("toggle-navigation-search", "筛选已加载的项目与会话")
        assertAction("new-thread")
        assertAction("close-panel", "关闭面板")
        screenshot("visual-01-navigation-compact")

        compose.onNodeWithTag("toggle-navigation-search").performClick()
        compose.onNodeWithTag("filter-navigation").assertIsDisplayed()
            .assertContentDescriptionContains("筛选已加载的项目与会话")
        val unmatched = "visual-absent-${UUID.randomUUID()}"
        assertTrue(before.projects.none { it.label.contains(unmatched) || it.detail.contains(unmatched) })
        assertTrue(before.threads.none { it.label.contains(unmatched) || it.detail.contains(unmatched) })
        compose.onNodeWithTag("filter-navigation").performTextReplacement(unmatched)
        Espresso.closeSoftKeyboard()
        before.projects.forEach { compose.onNodeWithTag("project-${it.id}").assertDoesNotExist() }
        before.threads.forEach { compose.onNodeWithTag("thread-${it.id}").assertDoesNotExist() }
        compose.onNodeWithText("筛选仅覆盖当前已加载列表。").performScrollTo().assertIsDisplayed()
        screenshot("visual-02-navigation-local-filter")
        // Filtering changes only rendered rows; it does not replace the loaded
        // catalog, select another thread, create a thread, or submit the draft.
        assertEquals(before.projects, state.projects)
        assertEquals(before.threads, state.threads)
        assertSelectionPreserved(before)
        compose.onNodeWithTag("toggle-navigation-search").performClick()
        compose.onNodeWithTag("filter-navigation").assertDoesNotExist()
        compose.onNodeWithTag("navigation-list").performScrollToNode(hasTestTag("project-${before.selectedProjectId}"))
        compose.onNodeWithTag("project-${before.selectedProjectId}").assertIsSelected()
        compose.onNodeWithTag("close-panel").performClick()
        compose.onNodeWithTag("draft").assertIsDisplayed()
        assertSelectionPreserved(before)
        record("visual-navigation", JSONObject().put("localFilteringOnly", true).put("collapsedByDefault", true))
    }

    @Test fun settingsModelPermissionAndCodeEvidence() {
        connected()
        val before = state
        compose.onNodeWithTag("settings").performClick()
        compose.onNodeWithTag("theme-dark").assertExists()
        assertAction("close-panel", "关闭面板")
        screenshot("visual-03-settings-appearance")
        compose.onNodeWithTag("identity-save").performScrollTo().assertIsDisplayed()
        screenshot("visual-04-settings-identity")
        compose.onNodeWithTag("notification-settings").performScrollTo().assertIsDisplayed()
        screenshot("visual-05-settings-notifications")
        compose.onNodeWithTag("close-panel").performClick()

        assertTrue("Models must be the actual Gateway catalog", state.models.isNotEmpty())
        compose.onNodeWithTag("model-picker").performClick()
        val selectedModel = before.models.firstOrNull { it.id == before.selectedModel } ?: before.models.first()
        compose.onNodeWithTag("model-${selectedModel.id}").performScrollTo().assertIsDisplayed()
        screenshot("visual-06-models")
        if (selectedModel.id == before.selectedModel && selectedModel.efforts.isNotEmpty()) {
            compose.onNodeWithTag("effort-${selectedModel.efforts.first()}").performScrollTo().assertIsDisplayed()
            screenshot("visual-07-reasoning-effort")
        }
        compose.onNodeWithTag("close-panel").performClick()

        compose.onNodeWithTag("permission-picker").performClick()
        compose.onNodeWithTag("permission-read-only").performScrollTo().assertIsDisplayed()
        screenshot("visual-08-permissions")
        compose.onNodeWithTag("permission-full-access").performScrollTo().performClick()
        compose.onNodeWithTag("confirm-full-access").assertIsDisplayed().assertHasClickAction()
        screenshot("visual-09-full-access-confirmation")
        // Opening the warning is not a permission grant. Back must leave the
        // native permission choice unchanged, including its existing readback.
        assertEquals(before.permissionPreset, state.permissionPreset)
        Espresso.pressBack()
        compose.onNodeWithTag("close-panel").performClick()
        assertSelectionPreserved(before)

        val source = state.messages.firstOrNull { message ->
            message.role == "assistant" && markdownBlocks(message.text).count { it.kind == "code" } == 1 &&
                markdownBlocks(message.text).any { it.kind == "code" && it.lines.size in 1..8 }
        }
        assertNotNull("The real initial Codex reply must contain a short fenced code block; do not fabricate it", source)
        val message = checkNotNull(source)
        val code = markdownBlocks(message.text).single { it.kind == "code" }.lines.joinToString("\n")
        compose.onNodeWithTag("conversation").performScrollToNode(hasTestTag("message_${message.id}"))
        val withinMessage = hasAnyAncestor(hasTestTag("message_${message.id}"))
        val body = compose.onNode(hasContentDescription("代码，可横向滚动") and withinMessage, useUnmergedTree = true)
        body.performScrollTo().assertTextEquals(code).assertIsDisplayed()
        val copy = compose.onNode(hasContentDescription("复制代码") and withinMessage)
        copy.assertIsDisplayed().assertHasClickAction()
        assertTouchTarget(copy)
        val codeNode = body.fetchSemanticsNode()
        val viewport = compose.onNodeWithTag("conversation").fetchSemanticsNode().boundsInRoot
        assertTrue("The complete short code body must fit the captured conversation viewport",
            codeNode.boundsInRoot.top >= viewport.top - 1 && codeNode.boundsInRoot.bottom <= viewport.bottom + 1 &&
                codeNode.boundsInRoot.height + 1 >= codeNode.size.height)
        screenshot("visual-10-native-code-block")
        assertSelectionPreserved(before)
        record("visual-options-code", JSONObject().put("realCodeMessageId", message.id)
            .put("permissionConfirmationCancelled", true).put("nativeChoicesUnchanged", true))
    }

    @Test fun largeFontActionsRemainReachable() {
        connected()
        val before = state
        assertTrue("Retain the unsent checkpoint draft for send reachability", before.draft.isNotBlank())
        val oldScale = shell("settings get system font_scale").trim().toFloatOrNull()
        try {
            shell("settings put system font_scale 2.0")
            until("System 200 percent font applied") { compose.activity.resources.configuration.fontScale >= 1.9f }
            compose.onNodeWithTag("draft").assertIsDisplayed()
            assertAction("send", "发送消息")
            until("Foreground snapshot converges after font configuration change") { it.online && !it.busy && it.canSend }
            compose.onNodeWithTag("send").assertIsEnabled()
            assertAction("navigation", "打开项目与会话导航")
            assertAction("inspector", "打开 Inspector")
            screenshot("visual-11-large-font-conversation")
            compose.onNodeWithTag("navigation").performClick()
            assertAction("close-panel", "关闭面板")
            assertAction("toggle-navigation-search", "筛选已加载的项目与会话")
            assertAction("new-thread")
            screenshot("visual-12-large-font-navigation")
            compose.onNodeWithTag("close-panel").performClick()
            compose.onNodeWithTag("permission-picker").assertIsDisplayed().performClick()
            assertAction("close-panel", "关闭面板")
            compose.onNodeWithTag("permission-full-access").performScrollTo().performClick()
            val confirmation = compose.onNodeWithTag("confirm-full-access").assertIsDisplayed().assertHasClickAction()
            confirmation.assertTextContains("确认启用")
            assertTouchTarget(confirmation)
            screenshot("visual-13-large-font-permission-confirmation")
            Espresso.pressBack()
            compose.onNodeWithTag("close-panel").performClick()
            assertSelectionPreserved(before)
            record("visual-large-font", JSONObject().put("minimumActionTargetDp", 48)
                .put("sendNotActivated", true).put("permissionConfirmationCancelled", true))
        } finally {
            shell(if (oldScale == null) "settings delete system font_scale" else "settings put system font_scale $oldScale")
        }
    }

    /** Run only while a real dedicated native approval is already pending. */
    @Test fun pendingApprovalAtLargeFontCanBeDeclined() {
        connected(requireSettled = false)
        val interaction = state.interactions.firstOrNull { request ->
            request.threadId == state.selectedThreadId && request.status == "pending" && request.supported &&
                request.decisions.any { it == "decline" || it == "cancel" }
        }
        assertNotNull("A real native pending request is required; this capture must not create or simulate one", interaction)
        val request = checkNotNull(interaction)
        val decision = if ("decline" in request.decisions) "decline" else "cancel"
        val oldScale = shell("settings get system font_scale").trim().toFloatOrNull()
        try {
            shell("settings put system font_scale 2.0")
            until("System 200 percent font applied") { compose.activity.resources.configuration.fontScale >= 1.9f }
            compose.onNodeWithTag("pending-interactions").performClick()
            assertAction("close-panel", "关闭面板")
            val action = compose.onAllNodesWithTag("interaction_${request.id}_$decision").onLast()
            action.performScrollTo().assertIsDisplayed().assertIsEnabled().assertHasClickAction()
            assertTouchTarget(action)
            screenshot("visual-14-large-font-native-approval")
            action.performClick()
            until("Original native request declined/cancelled and Turn settled", 180_000) {
                !it.busy && !it.canStop && it.interactions.none { current -> current.id == request.id && current.status == "pending" }
            }
            compose.onNodeWithTag("close-panel").performClick()
            record("visual-large-font-approval", JSONObject().put("interactionId", request.id).put("decision", decision))
        } finally {
            shell(if (oldScale == null) "settings delete system font_scale" else "settings put system font_scale $oldScale")
        }
    }

    private fun shell(command: String): String = instrumentation.uiAutomation.executeShellCommand(command).use {
        android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().readText()
    }
}
