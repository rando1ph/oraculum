package dev.oraculum.poc.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import dev.oraculum.gateway.protocol.ApprovalPolicy
import dev.oraculum.gateway.protocol.NativeDefaults
import dev.oraculum.gateway.protocol.NativeDefaultsSource
import dev.oraculum.gateway.protocol.Origins
import dev.oraculum.gateway.protocol.SandboxMode
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Fixture-only interaction checks; no ViewModel, Gateway, preferences, files, or device settings. */
class NavigationRefinementUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun fixture() = PocUiState(
        paired = true, online = true, gatewayProtocolMinor = 1,
        selectedProjectId = "project-alpha", selectedThreadId = "thread-fixture",
        projects = listOf(ProjectOption("project-alpha", "Alpha project"),
            ProjectOption("project-zulu", "Zulu project")),
        threads = listOf(ThreadOption("thread-fixture", "Fixture conversation")), capabilityNames = setOf("projects"),
        messages = listOf(ChatMessage("answer-fixture", "assistant", "Fixture answer",
            turnId = "turn-fixture", turn = TurnMetadataUi(status = "completed"))),
    )

    @Test fun navigationHasNoSortingControlsAndPreservesGatewayThreadOrder() {
        val state = fixture().copy(projects = fixture().projects.reversed(), threads = listOf(
            ThreadOption("z", "Zulu conversation"), ThreadOption("a", "Alpha conversation")))
        compose.setContent { OraculumTheme(mode = "oled") { OraculumScreen(state, PocActions()) } }
        compose.onNodeWithTag("navigation").performClick()
        compose.onNodeWithTag("sort-projects").assertDoesNotExist()
        compose.onNodeWithTag("sort-threads").assertDoesNotExist()
        assertTrue(compose.onNodeWithTag("project-project-alpha").fetchSemanticsNode().boundsInRoot.top <
            compose.onNodeWithTag("project-project-zulu").fetchSemanticsNode().boundsInRoot.top)
        assertTrue(compose.onNodeWithTag("thread-z").fetchSemanticsNode().boundsInRoot.top <
            compose.onNodeWithTag("thread-a").fetchSemanticsNode().boundsInRoot.top)
    }

    @Test fun projectDeletionRequiresConfirmationAndDoesNotSelectTheTarget() {
        val deleted = mutableListOf<String>()
        val selected = mutableListOf<String>()
        compose.setContent { OraculumTheme(mode = "oled") {
            OraculumScreen(fixture(), PocActions(onSelectProject = { selected += it }, onDeleteProject = { deleted += it }))
        } }
        compose.onNodeWithTag("navigation").performClick()
        compose.onNodeWithTag("project-menu-project-zulu").performClick()
        compose.onNodeWithTag("delete-project-project-zulu").assertIsEnabled().performClick()
        compose.onNodeWithText("实际文件夹和 Codex 会话历史会保留。", substring = true).assertIsDisplayed()
        compose.runOnIdle { assertTrue(deleted.isEmpty()); assertTrue(selected.isEmpty()) }
        compose.onNodeWithText("取消").performClick()
        compose.runOnIdle { assertTrue(deleted.isEmpty()) }
        compose.onNodeWithTag("project-menu-project-zulu").performClick()
        compose.onNodeWithTag("delete-project-project-zulu").performClick()
        compose.onNodeWithTag("confirm-delete-project-project-zulu").performClick()
        compose.runOnIdle { assertEquals(listOf("project-zulu"), deleted); assertTrue(selected.isEmpty()) }
        compose.onNodeWithTag("project-project-alpha").assertIsSelected()
    }

    @Test fun projectDeleteConfirmationRechecksOfflineBusyAndUnknownState() {
        val state = mutableStateOf(fixture())
        val deleted = mutableListOf<String>()
        compose.setContent { OraculumTheme(mode = "oled") {
            OraculumScreen(state.value, PocActions(onDeleteProject = { deleted += it }))
        } }
        compose.onNodeWithTag("navigation").performClick()
        compose.onNodeWithTag("project-menu-project-zulu").performClick()
        compose.onNodeWithTag("delete-project-project-zulu").performClick()
        compose.runOnIdle { state.value = state.value.copy(online = false) }
        compose.onNodeWithTag("confirm-delete-project-project-zulu").assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle { state.value = state.value.copy(online = true, unknownWarning = "待确认请求") }
        compose.onNodeWithTag("confirm-delete-project-project-zulu").assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle { state.value = state.value.copy(unknownWarning = null, busy = true) }
        compose.onNodeWithTag("confirm-delete-project-project-zulu").assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle { assertTrue(deleted.isEmpty()); state.value = state.value.copy(busy = false) }
        compose.onNodeWithTag("confirm-delete-project-project-zulu").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(listOf("project-zulu"), deleted) }
    }

    @Test fun permissionDefaultsUseConcretePresetsAndFullAccessStillRequiresConfirmation() {
        val state = mutableStateOf(fixture())
        val choices = mutableListOf<Pair<String, Boolean>>()
        var sends = 0
        compose.setContent { OraculumTheme(mode = "oled") {
            OraculumScreen(state.value, PocActions(
                onSelectPermission = { preset, confirmed -> choices += preset to confirmed },
                onSend = { sends++ },
            ))
        } }
        compose.onNodeWithTag("permission-picker").assertTextContains("Auto")
        compose.onNodeWithTag("permission-icon-auto", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithTag("permission-picker").performClick()
        compose.onNodeWithTag("permission-native").assertDoesNotExist()
        compose.onNodeWithTag("permission-native-settings").assertDoesNotExist()
        compose.onNodeWithTag("permission-read-only").assertIsEnabled()
        compose.onNodeWithTag("permission-full-access").assertIsEnabled()
        compose.onNodeWithTag("permission-auto").performClick()
        compose.runOnIdle {
            assertEquals(listOf("auto" to false), choices)
            state.value = state.value.copy(nativeDefaults = defaults(SandboxMode.ReadOnly, ApprovalPolicy.OnRequest))
        }
        compose.onNodeWithTag("permission-picker").assertTextContains("只读")
        compose.onNodeWithTag("permission-icon-read-only", useUnmergedTree = true).assertIsDisplayed()
        compose.runOnIdle {
            state.value = state.value.copy(nativeDefaults = defaults(SandboxMode.DangerFullAccess, ApprovalPolicy.Never))
        }
        compose.onNodeWithTag("permission-picker").assertTextContains("Full access")
        compose.onNodeWithTag("permission-icon-full-access", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithTag("permission-picker").performClick()
        compose.onNodeWithTag("permission-full-access").performClick()
        compose.onNodeWithTag("confirm-full-access").assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf("auto" to false), choices); assertEquals(0, sends) }
        compose.onNodeWithText("取消").performClick()
        compose.runOnIdle { assertEquals(listOf("auto" to false), choices) }
        compose.onNodeWithTag("permission-picker").performClick()
        compose.onNodeWithTag("permission-full-access").performClick()
        compose.onNodeWithTag("confirm-full-access").performClick()
        compose.runOnIdle {
            assertEquals(listOf("auto" to false, "full-access" to true), choices)
            assertEquals(0, sends)
        }
    }

    private fun defaults(sandbox: SandboxMode, approval: ApprovalPolicy) = NativeDefaults(
        sandboxMode = sandbox, approvalPolicy = approval, origins = Origins(),
        readAt = 0, source = NativeDefaultsSource.NativeConfig,
    )
}
