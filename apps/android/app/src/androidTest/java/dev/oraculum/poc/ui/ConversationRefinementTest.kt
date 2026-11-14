package dev.oraculum.poc.ui

import androidx.activity.ComponentActivity
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import dev.oraculum.poc.repository.CONTENT_PREVIEW_NOTICE
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Isolated behavior checks; no Gateway, device files, screenshots, or image goldens. */
class ConversationRefinementTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun fixture() = PocUiState(
        paired = true, online = true, selectedProjectId = "project", selectedThreadId = "thread",
        projects = listOf(ProjectOption("project", "Fixture project")),
        threads = listOf(ThreadOption("thread", "Fixture conversation")),
        draft = "Preserved fixture draft",
        messages = listOf(ChatMessage("answer", "assistant", "Fixture answer", turnId = "turn",
            turn = TurnMetadataUi(status = "completed"))),
    )

    private fun render(content: @Composable () -> Unit) {
        compose.setContent { OraculumTheme(mode = "oled") { Surface { content() } } }
    }

    @Test fun directoryBrowsingUsesReturnedPathsAndRegistersTheReviewedDirectory() {
        val browsed = mutableListOf<Pair<String, String>>()
        var registered: Pair<String, String>? = null
        var more = 0
        var cancellations = 0
        val state = mutableStateOf(fixture().copy(
            roots = listOf(RootOption("root-a", "Fixture root A"), RootOption("root-b", "Fixture root B")),
            directory = DirectoryUiState("root-a", "workspace",
                listOf(DirectoryOption("docs", "workspace/docs")), canRegister = true, canLoadMore = true),
        ))
        val actions = PocActions(onBrowseDirectory = { root, path ->
            browsed += root to path
            state.value = state.value.copy(directory = DirectoryUiState(root, path,
                entries = if (path == "workspace") listOf(DirectoryOption("docs", "workspace/docs")) else emptyList(),
                canRegister = path.isNotBlank()))
        }, onLoadMoreDirectories = { more++ })
        render { ProjectDirectoryCard(state.value, actions, onCancel = { cancellations++ },
            onRegister = { root, path -> registered = root to path }) }
        compose.onNodeWithTag("project-directory-card").assertIsDisplayed()
        compose.onNodeWithTag("project_path").assertDoesNotExist()
        compose.onNodeWithTag("project-directory-more").performClick()
        compose.runOnIdle { assertEquals(1, more); assertNull(registered) }
        compose.onNodeWithTag("project-directory-entry-workspace/docs").performClick()
        compose.onNodeWithTag("project-directory-current").assertTextContains("Fixture root A / workspace/docs")
        compose.onNodeWithTag("project-directory-register").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals("root-a" to "workspace/docs", registered) }
        compose.onNodeWithTag("project-directory-parent").performClick()
        compose.onNodeWithTag("project-directory-root-root-b").performClick()
        compose.onNodeWithTag("project-directory-current").assertTextContains("Fixture root B")
        compose.onNodeWithTag("project-directory-register").assertIsNotEnabled()
        compose.onNodeWithTag("project-directory-cancel").performClick()
        compose.runOnIdle {
            assertEquals(listOf("root-a" to "workspace/docs", "root-a" to "workspace", "root-b" to ""), browsed)
            assertEquals(1, cancellations)
        }
    }

    @Test fun pendingWriteAllowsReadOnlyBrowsingButBlocksRegistration() {
        val browsed = mutableListOf<Pair<String, String>>()
        var registrations = 0
        val state = fixture().copy(unknownWarning = "Fixture operation requires reconciliation",
            roots = listOf(RootOption("root", "Fixture root")),
            directory = DirectoryUiState("root", "workspace",
                listOf(DirectoryOption("docs", "workspace/docs")), canRegister = true))
        render { ProjectDirectoryCard(state, PocActions(onBrowseDirectory = { root, path -> browsed += root to path }),
            onCancel = {}, onRegister = { _, _ -> registrations++ }) }
        compose.onNodeWithTag("project-directory-register").assertIsNotEnabled()
        compose.onNodeWithTag("project-directory-entry-workspace/docs").assertIsEnabled().performClick()
        compose.runOnIdle {
            assertEquals(listOf("root" to "workspace/docs"), browsed)
            assertEquals(0, registrations)
        }
    }

    @Test fun pullToRefreshUsesConversationReadActionAndPreservesTheDraft() {
        var refreshes = 0
        var sends = 0
        val state = mutableStateOf(fixture())
        render { OraculumScreen(state.value, PocActions(onRefreshConversation = {
            refreshes++
            state.value = state.value.copy(conversationRefreshing = true)
        }, onSend = { sends++ })) }
        compose.onNodeWithTag("conversation").performTouchInput { swipeDown() }
        compose.onNodeWithTag("conversation-refresh-indicator").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(1, refreshes)
            assertEquals("Preserved fixture draft", state.value.draft)
            assertEquals(0, sends)
        }
        compose.onNodeWithTag("conversation").performTouchInput { swipeDown() }
        compose.runOnIdle { assertEquals(1, refreshes) }
        compose.onNodeWithTag("draft").assertTextContains("Preserved fixture draft")
    }

    @Test fun returnToBottomReachesTheEndOfOneTallAnswerAndThenDisappears() {
        val text = List(140) { "Fixture answer paragraph $it extends the same assistant card." }
            .joinToString("\n\n") + "\n\nNewest fixture answer"
        val answer = ChatMessage("long-answer", "assistant", text, turnId = "long-turn",
            turn = TurnMetadataUi(status = "completed"))
        render { OraculumScreen(fixture().copy(messages = listOf(answer), readIndex = 0), PocActions()) }
        compose.onNodeWithTag("conversation-bottom").assertIsDisplayed()
        compose.onNodeWithText("Newest fixture answer").assertIsNotDisplayed()
        compose.onNodeWithTag("conversation-bottom").performClick()
        compose.onNodeWithText("Newest fixture answer").assertIsDisplayed()
        compose.onNodeWithTag("conversation-bottom").assertDoesNotExist()
    }

    @Test fun completeConversationRendererKeepsTheTailBeyondLegacyPreviewBounds() {
        val marker = "FIXTURE_COMPLETE_STREAM_TAIL_70K"
        val paragraphs = List(110) { "Fixture complete paragraph $it " + "x".repeat(500) }
        val codeLines = List(128) { "// fixture code line $it " + "x".repeat(80) }
        val code = codeLines.joinToString("\n")
        val text = paragraphs.joinToString("\n\n") + "\n\n```text\n" + code + "\n```\n\n" + marker
        assertTrue(text.length > 64 * 1024)
        assertTrue(text.lineSequence().count() > 256)
        assertTrue(paragraphs.all { it.length <= 4 * 1024 })
        assertEquals(128, codeLines.size)
        assertTrue(code.length <= 16 * 1024)
        val answer = ChatMessage("complete-answer", "assistant", text, turnId = "complete-turn",
            status = "内容未完整显示", detailsRequired = true, turn = TurnMetadataUi(status = "completed"))
        render { OraculumScreen(fixture().copy(messages = listOf(answer), readIndex = 0), PocActions()) }
        compose.waitUntil(timeoutMillis = 30_000) {
            compose.onAllNodesWithText(marker).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("conversation-bottom").assertIsDisplayed().performClick()
        compose.waitUntil(timeoutMillis = 30_000) {
            runCatching { compose.onNodeWithText(marker).assertIsDisplayed() }.isSuccess
        }
        compose.onNodeWithTag("conversation-bottom").assertDoesNotExist()
        compose.onNodeWithText(CONTENT_PREVIEW_NOTICE, substring = true).assertDoesNotExist()
        compose.onNodeWithText("查看完整内容").assertDoesNotExist()
        compose.onNodeWithText("内容未完整显示").assertDoesNotExist()
        compose.onNodeWithTag("detail-complete-answer").assertDoesNotExist()
    }

    @Test fun completeMarkdownDisplaysEveryLineInAnAggregatedParagraph() {
        val text = "Fixture first line\nFixture second line\nFixture paragraph tail"
        render { MarkdownContent(text, complete = true) }
        compose.onNodeWithText(text).assertIsDisplayed()
    }

    @Test fun ordinaryConversationOmitsLegacyFullDetailActionsAndWarnings() {
        var detailReads = 0
        val answer = ChatMessage("answer", "assistant", "Fixture visible answer",
            status = "内容未完整显示", turnId = "turn", detailsRequired = true,
            turn = TurnMetadataUi(status = "completed"))
        render { OraculumScreen(fixture().copy(messages = listOf(answer)),
            PocActions(onLoadItemDetail = { _, _ -> detailReads++ })) }
        compose.onNodeWithText("Fixture visible answer").assertIsDisplayed()
        compose.onNodeWithText("内容未完整显示").assertDoesNotExist()
        compose.onNodeWithText("查看完整内容").assertDoesNotExist()
        compose.onNodeWithTag("detail-answer").assertDoesNotExist()
        compose.runOnIdle { assertEquals(0, detailReads) }
    }

    @Test fun oledContextHasBlackBackgroundAndRetainsAVisibleOutlineColor() {
        val mode = mutableStateOf("oled")
        var oled = false
        var background = Color.Unspecified
        var outline = Color.Unspecified
        compose.setContent { OraculumTheme(mode = mode.value) {
            val currentOled = LocalOledTheme.current
            val colors = MaterialTheme.colorScheme
            SideEffect { oled = currentOled; background = colors.background; outline = colors.outlineVariant }
            OraculumCard { Text("Fixture reading surface") }
        } }
        compose.runOnIdle {
            assertTrue(oled)
            assertEquals(Color.Black, background)
            assertTrue("Borders retain contrast on black", outline.luminance() > Color.Black.luminance())
            mode.value = "dark"
        }
        compose.runOnIdle {
            assertFalse(oled)
            assertNotEquals(Color.Black, background)
        }
    }
}
