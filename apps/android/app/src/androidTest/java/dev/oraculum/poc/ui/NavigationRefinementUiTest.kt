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
        threads = listOf(ThreadOption("thread-fixture", "Fixture conversation", createdAt = 10, updatedAt = 20)),
        messages = listOf(ChatMessage("answer-fixture", "assistant", "Fixture answer",
            turnId = "turn-fixture", turn = TurnMetadataUi(status = "completed"))),
    )

    @Test fun sortMenusKeepCallbacksIndependentAndDisableMissingProjectDates() {
        val state = mutableStateOf(fixture())
        val projectChoices = mutableListOf<NavigationSort>()
        val threadChoices = mutableListOf<NavigationSort>()
        compose.setContent { OraculumTheme(mode = "oled") {
            OraculumScreen(state.value, PocActions(
                onProjectSortChange = { projectChoices += it; state.value = state.value.copy(projectSort = it) },
                onThreadSortChange = { threadChoices += it; state.value = state.value.copy(threadSort = it) },
            ))
        } }
        compose.onNodeWithTag("navigation").performClick()
        compose.onNodeWithTag("sort-projects").performScrollTo().performClick()
        compose.onNodeWithTag("sort-projects-CreatedNewest").assertIsNotEnabled().performTouchInput { click() }
        compose.onNodeWithTag("sort-projects-UpdatedNewest").assertIsNotEnabled()
        compose.onNodeWithTag("sort-projects-NameAscending").assertIsEnabled()
        compose.runOnIdle { assertTrue(projectChoices.isEmpty()); assertTrue(threadChoices.isEmpty()) }
        compose.onNodeWithTag("sort-projects-NameDescending").assertIsEnabled().performClick()
        compose.runOnIdle {
            assertEquals(listOf(NavigationSort.NameDescending), projectChoices)
            assertTrue(threadChoices.isEmpty())
        }
        compose.onNodeWithTag("sort-projects").performClick()
        compose.onNodeWithTag("sort-projects-NameDescending").assertIsSelected()
        compose.onNodeWithTag("sort-projects-NameAscending").performClick()

        compose.onNodeWithTag("sort-threads").performScrollTo().performClick()
        NavigationSort.entries.forEach {
            compose.onNodeWithTag("sort-threads-${it.name}").assertIsEnabled()
        }
        compose.onNodeWithTag("sort-threads-UpdatedNewest").performClick()
        compose.onNodeWithTag("sort-threads").performClick()
        compose.onNodeWithTag("sort-threads-UpdatedNewest").assertIsSelected()
        compose.onNodeWithTag("sort-threads-CreatedNewest").performClick()
        compose.runOnIdle {
            assertEquals(listOf(NavigationSort.NameDescending, NavigationSort.NameAscending), projectChoices)
            assertEquals(listOf(NavigationSort.UpdatedNewest, NavigationSort.CreatedNewest), threadChoices)
        }
    }

    @Test fun disabledProjectOverflowDoesNotSelectItsProject() {
        val selected = mutableListOf<String>()
        compose.setContent { OraculumTheme(mode = "oled") {
            OraculumScreen(fixture(), PocActions(onSelectProject = { selected += it }))
        } }
        compose.onNodeWithTag("navigation").performClick()
        compose.onNodeWithTag("project-project-alpha").assertIsSelected()
        compose.onNodeWithTag("project-project-zulu").assertIsNotSelected()
        compose.onNodeWithTag("project-menu-project-zulu").assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle { assertTrue(selected.isEmpty()) }
        compose.onNodeWithTag("project-project-alpha").assertIsSelected()
        compose.onNodeWithTag("project-project-zulu").performClick()
        compose.runOnIdle { assertEquals(listOf("project-zulu"), selected) }
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
