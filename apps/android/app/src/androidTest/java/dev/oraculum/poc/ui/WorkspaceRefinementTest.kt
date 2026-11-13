package dev.oraculum.poc.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Isolated rendering checks: no ViewModel, Gateway, preferences, or screenshot capture. */
class WorkspaceRefinementTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun fixture(): PocUiState {
        val completed = TurnMetadataUi(status = "completed", durationMs = 1000)
        return PocUiState(
            paired = true, online = true, selectedProjectId = "project", selectedThreadId = "thread",
            projects = listOf(ProjectOption("project", "Fixture project")),
            threads = listOf(ThreadOption("thread", "Fixture thread")),
            userLabel = "Fixture user", assistantLabel = "Fixture assistant",
            models = listOf(ModelOption("model", "Fixture model", listOf("low", "high", "ultra"))),
            selectedModel = "model", selectedEffort = "low",
            messages = listOf(
                ChatMessage("user", "user", "Fixture request", turnId = "turn", turn = completed),
                ChatMessage("process", "commandExecution", "Fixture execution", turnId = "turn", turn = completed),
                ChatMessage("answer", "assistant", "Fixture answer", phase = "final_answer", turnId = "turn", turn = completed),
            ),
        )
    }

    private fun render(actions: PocActions = PocActions()) {
        compose.setContent { OraculumTheme(mode = "oled") { OraculumScreen(fixture(), actions) } }
    }

    @Test fun assistantHeaderPrecedesExecutionSummaryAndAnswer() {
        render()
        val header = compose.onNodeWithTag("assistant-header-turn").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val summary = compose.onNodeWithTag("turn-summary-turn").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val answer = compose.onNodeWithTag("message_answer").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertTrue("Execution summary belongs below the assistant header", header.bottom <= summary.top)
        assertTrue("Answer belongs below its execution summary", summary.bottom <= answer.top)
        compose.onAllNodesWithText("Fixture assistant", useUnmergedTree = true).assertCountEquals(1)
        compose.onNodeWithText("Fixture execution").assertDoesNotExist()
    }

    @Test fun sidebarQuotaSitsImmediatelyAboveAccountSettings() {
        render()
        compose.onNodeWithTag("navigation").performClick()
        val quota = compose.onNodeWithTag("account-quota").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val settings = compose.onNodeWithTag("settings").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertTrue("Quota must be above account settings", quota.bottom <= settings.top)
        val density = compose.activity.resources.displayMetrics.density
        assertTrue("Quota stays adjacent to the account row", settings.top - quota.bottom < 48f * density)
    }

    @Test fun skillsTabComesAfterUsageAndKeepsSessionUsageSeparate() {
        render()
        compose.onNodeWithTag("inspector").performClick()
        compose.onNodeWithTag("inspector-extensions").performScrollTo().assertIsDisplayed()
        val skills = compose.onNodeWithTag("inspector-extensions").fetchSemanticsNode().boundsInRoot
        val usage = compose.onNodeWithTag("inspector-usage").fetchSemanticsNode().boundsInRoot
        assertTrue("Skills is placed to the right of usage", skills.left > usage.left)
        compose.onNodeWithText("Skills").assertIsDisplayed()
        compose.onNodeWithText("账户额度暂未提供。").assertDoesNotExist()
    }

    @Test fun reasoningOptionsAreVerticalAndUnsupportedUltraCannotBeSubmitted() {
        var chosenEffort: String? = null
        render(PocActions(onSelectEffort = { chosenEffort = it }))
        compose.onNodeWithTag("model-picker").performClick()
        compose.onNodeWithTag("choose-effort").performClick()
        val low = compose.onNodeWithTag("effort-low").assertIsEnabled().fetchSemanticsNode().boundsInRoot
        val high = compose.onNodeWithTag("effort-high").assertIsEnabled().fetchSemanticsNode().boundsInRoot
        val ultra = compose.onNodeWithTag("effort-ultra").assertIsNotEnabled().fetchSemanticsNode().boundsInRoot
        assertTrue(low.bottom <= high.top)
        assertTrue(high.bottom <= ultra.top)
        assertNull(chosenEffort)
        compose.onNodeWithTag("effort-low").performClick()
        compose.runOnIdle { assertEquals("low", chosenEffort) }
        compose.onNodeWithTag("model-sheet").assertDoesNotExist()
    }

    @Test fun nativeModelDefaultReturnsEmptyOverrideWithoutSending() {
        var chosenModel: String? = null
        var sends = 0
        render(PocActions(onSelectModel = { chosenModel = it }, onSend = { sends++ }))
        compose.onNodeWithTag("model-picker").performClick()
        compose.onNodeWithTag("choose-model").performClick()
        compose.onNodeWithTag("model-native-default").performClick()
        compose.runOnIdle {
            assertEquals("", chosenModel)
            assertEquals(0, sends)
        }
        compose.onNodeWithTag("model-sheet").assertDoesNotExist()
    }
}
