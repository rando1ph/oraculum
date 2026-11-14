package dev.oraculum.poc.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import dev.oraculum.gateway.protocol.AccountRateLimits
import dev.oraculum.gateway.protocol.AccountRateLimitsSource
import dev.oraculum.gateway.protocol.ApprovalPolicy
import dev.oraculum.gateway.protocol.NativeDefaults
import dev.oraculum.gateway.protocol.NativeDefaultsSource
import dev.oraculum.gateway.protocol.Origins
import dev.oraculum.gateway.protocol.RateLimitsClass
import dev.oraculum.gateway.protocol.RateLimitsRateLimitWindow
import dev.oraculum.gateway.protocol.SandboxMode
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Fixture-only UI checks: no Gateway, ViewModel, preferences, files, or screenshot capture. */
class NativeCapabilitiesUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val thread = ThreadOption("thread-fixture", "Fixture conversation")
    private val turnId = "turn-fixture"

    private fun fixture(capabilities: Set<String> = emptySet()) = PocUiState(
        paired = true, online = true, gatewayProtocolMinor = 1,
        selectedProjectId = "project-fixture", selectedThreadId = thread.id,
        projects = listOf(ProjectOption("project-fixture", "Fixture project")),
        threads = listOf(thread), capabilityNames = capabilities, canManageThread = true,
        models = listOf(ModelOption("model-fixture", "Fixture model", listOf("low", "high", "ultra"))),
        selectedModel = "model-fixture", selectedEffort = "low",
        messages = listOf(ChatMessage("answer-fixture", "assistant", "Fixture answer", turnId = turnId,
            phase = "final_answer", turn = TurnMetadataUi(status = "completed"))),
    )

    private fun render(state: PocUiState = fixture(), actions: PocActions = PocActions()) =
        renderContent { OraculumScreen(state, actions) }

    private fun renderContent(content: @Composable () -> Unit) {
        compose.setContent { OraculumTheme(mode = "oled") { Surface { content() } } }
    }

    @Test fun unsupportedThreadActionsAreAbsentFromConversationAndSidebar() {
        render()
        compose.onNodeWithTag("thread-tools").assertDoesNotExist()
        compose.onNodeWithTag("turn-tools-$turnId").assertDoesNotExist()
        compose.onNodeWithTag("navigation").performClick()
        compose.onNodeWithTag("thread-${thread.id}").assertIsDisplayed()
        compose.onNodeWithTag("thread-menu-${thread.id}").assertDoesNotExist()
        compose.onNodeWithTag("archived-threads-toggle").assertDoesNotExist()
    }

    @Test fun onlyAdvertisedLifecycleActionsAppear() {
        val state = fixture(setOf("thread.name.set"))
        renderContent { NativeThreadRow(thread, state, PocActions()) {} }
        compose.onNodeWithTag("thread-menu-${thread.id}").performClick()
        compose.onNodeWithTag("thread-rename-${thread.id}").assertIsEnabled()
        compose.onNodeWithTag("thread-archive-${thread.id}").assertDoesNotExist()
        compose.onNodeWithTag("thread-restore-${thread.id}").assertDoesNotExist()
        compose.onNodeWithTag("thread-delete-${thread.id}").assertDoesNotExist()
    }

    @Test fun permanentDeletionRequiresConfirmationAndCancelNeverDispatches() {
        val deleted = mutableListOf<String>()
        val state = fixture(setOf("thread.delete"))
        renderContent { NativeThreadRow(thread, state, PocActions(onDeleteThread = { deleted += it })) {} }
        compose.onNodeWithTag("thread-menu-${thread.id}").performClick()
        compose.onNodeWithTag("thread-delete-${thread.id}").performClick()
        compose.runOnIdle { assertTrue(deleted.isEmpty()) }
        compose.onNodeWithText("取消").performClick()
        compose.runOnIdle { assertTrue(deleted.isEmpty()) }
        compose.onNodeWithTag("confirm-thread-delete").assertDoesNotExist()
        compose.onNodeWithTag("thread-menu-${thread.id}").performClick()
        compose.onNodeWithTag("thread-delete-${thread.id}").performClick()
        compose.onNodeWithTag("confirm-thread-delete").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(listOf(thread.id), deleted) }
    }

    @Test fun renameAndArchiveDispatchOnlyTheirConfirmedActions() {
        var renamed: Pair<String, String>? = null
        val archived = mutableListOf<String>()
        val state = fixture(setOf("thread.name.set", "thread.archive"))
        val actions = PocActions(onRenameThread = { id, name -> renamed = id to name },
            onArchiveThread = { archived += it })
        renderContent { NativeThreadRow(thread, state, actions) {} }
        compose.onNodeWithTag("thread-menu-${thread.id}").performClick()
        compose.onNodeWithTag("thread-rename-${thread.id}").performClick()
        compose.onNodeWithTag("thread-name-input").performTextReplacement("Renamed fixture")
        compose.runOnIdle { assertNull(renamed) }
        compose.onNodeWithTag("confirm-thread-rename").performClick()
        compose.runOnIdle { assertEquals(thread.id to "Renamed fixture", renamed) }
        compose.onNodeWithTag("thread-menu-${thread.id}").performClick()
        compose.onNodeWithTag("thread-archive-${thread.id}").performClick()
        compose.runOnIdle { assertTrue(archived.isEmpty()) }
        compose.onNodeWithTag("confirm-thread-archive").performClick()
        compose.runOnIdle { assertEquals(listOf(thread.id), archived) }
    }

    @Test fun archivedSidebarRestoresAnOpaqueThreadAndCanReturnToActiveList() {
        val restored = mutableListOf<String>()
        var requestedArchived: Boolean? = null
        val state = fixture(setOf("thread.unarchive")).copy(
            showArchivedThreads = true, threads = listOf(thread.copy(archived = true)))
        render(state, PocActions(onUnarchiveThread = { restored += it },
            onShowArchivedThreads = { requestedArchived = it }))
        compose.onNodeWithTag("navigation").performClick()
        compose.onNodeWithTag("archived-threads-toggle").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(false, requestedArchived) }
        compose.onNodeWithTag("thread-menu-${thread.id}").performClick()
        compose.onNodeWithTag("thread-archive-${thread.id}").assertDoesNotExist()
        compose.onNodeWithTag("thread-restore-${thread.id}").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(listOf(thread.id), restored) }
    }

    @Test fun threadAndTurnToolsPreserveIdsAndConfirmHistoryChanges() {
        val forks = mutableListOf<String?>()
        val reverted = mutableListOf<String>()
        var compactions = 0
        val state = fixture(setOf("thread.fork", "thread.compact", "thread.revert"))
        val actions = PocActions(onForkThread = { forks += it }, onCompactThread = { compactions++ },
            onRevertThread = { reverted += it })
        renderContent { Column {
            ThreadToolsMenu(state, actions)
            TurnToolsMenu(turnId, state, actions)
        } }
        compose.onNodeWithTag("thread-tools").performClick()
        compose.onNodeWithTag("fork-thread").performClick()
        compose.runOnIdle { assertEquals(listOf<String?>(null), forks) }
        compose.onNodeWithTag("turn-tools-$turnId").performClick()
        compose.onNodeWithTag("fork-turn-$turnId").performClick()
        compose.runOnIdle { assertEquals(listOf(null, turnId), forks) }
        compose.onNodeWithTag("thread-tools").performClick()
        compose.onNodeWithTag("compact-thread").performClick()
        compose.runOnIdle { assertEquals(0, compactions) }
        compose.onNodeWithTag("confirm-compact-thread").performClick()
        compose.runOnIdle { assertEquals(1, compactions) }
        compose.onNodeWithTag("turn-tools-$turnId").performClick()
        compose.onNodeWithTag("revert-turn-$turnId").performClick()
        compose.runOnIdle { assertTrue(reverted.isEmpty()) }
        compose.onNodeWithTag("confirm-revert-turn").performClick()
        compose.runOnIdle { assertEquals(listOf(turnId), reverted) }
    }

    @Test fun unresolvedWriteDisablesLifecycleAndHistoryActions() {
        var mutations = 0
        val pane = mutableStateOf(0)
        val state = fixture(setOf("thread.name.set", "thread.archive", "thread.delete",
            "thread.fork", "thread.compact", "thread.revert")).copy(
            unknownWarning = "Fixture operation requires reconciliation",
            unresolvedOperations = listOf(UnknownOperationUi("operation-fixture", "thread.archive",
                "project-fixture", thread.id, 0, "unknown", "unknown")))
        val actions = PocActions(onRenameThread = { _, _ -> mutations++ },
            onArchiveThread = { mutations++ }, onDeleteThread = { mutations++ },
            onForkThread = { mutations++ }, onCompactThread = { mutations++ },
            onRevertThread = { mutations++ })
        renderContent { when (pane.value) {
            0 -> NativeThreadRow(thread, state, actions) {}
            1 -> ThreadToolsMenu(state, actions)
            else -> TurnToolsMenu(turnId, state, actions)
        } }
        compose.onNodeWithTag("thread-menu-${thread.id}").performClick()
        compose.onNodeWithTag("thread-rename-${thread.id}").assertIsNotEnabled()
        compose.onNodeWithTag("thread-archive-${thread.id}").assertIsNotEnabled()
        compose.onNodeWithTag("thread-delete-${thread.id}").assertIsNotEnabled()
        compose.runOnIdle { pane.value = 1 }
        compose.onNodeWithTag("thread-tools").performClick()
        compose.onNodeWithTag("fork-thread").assertIsNotEnabled()
        compose.onNodeWithTag("compact-thread").assertIsNotEnabled()
        compose.runOnIdle { pane.value = 2 }
        compose.onNodeWithTag("turn-tools-$turnId").performClick()
        compose.onNodeWithTag("fork-turn-$turnId").assertIsNotEnabled()
        compose.onNodeWithTag("revert-turn-$turnId").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(0, mutations) }
    }

    @Test fun quotaDisplaysActualRemainingRatherThanUsedPercent() {
        val quota = AccountRateLimits(limited = false, rateLimits = RateLimitsClass(
            primary = RateLimitsRateLimitWindow(usedPercent = 35, windowDurationMins = 300)),
            readAt = 0, source = AccountRateLimitsSource.NativeRateLimits)
        renderContent { AccountQuotaFooter(fixture().copy(accountRateLimits = quota), PocActions()) }
        compose.onNodeWithText("5 小时 65%").assertIsDisplayed()
        compose.onNodeWithTag("account-quota").performClick()
        compose.onNodeWithTag("account-details").assertIsDisplayed()
        compose.onNodeWithText("剩余 65%").assertIsDisplayed()
        compose.onNodeWithText("剩余 35%").assertDoesNotExist()
        compose.onNodeWithText("剩余 0%").assertDoesNotExist()
    }

    @Test fun missingQuotaRemainsUnknownWithoutInventingZero() {
        renderContent { AccountQuotaFooter(fixture(), PocActions()) }
        compose.onNodeWithText("暂不可用").assertIsDisplayed()
        compose.onNodeWithTag("account-quota").performClick()
        compose.onNodeWithText("暂未取得账户额度。").assertIsDisplayed()
        compose.onNodeWithText("剩余 0%").assertDoesNotExist()
        compose.runOnIdle {
            assertNull(quotaRemaining(101))
            assertNull(quotaRemaining(-1))
        }
    }

    @Test fun protocol21AdvertisedUltraIsSelectableWithoutSending() {
        var effort: String? = null
        var sends = 0
        render(actions = PocActions(onSelectEffort = { effort = it }, onSend = { sends++ }))
        compose.onNodeWithTag("model-picker").performClick()
        compose.onNodeWithTag("choose-effort").performClick()
        val high = compose.onNodeWithTag("effort-high").assertIsEnabled().fetchSemanticsNode().boundsInRoot
        val ultra = compose.onNodeWithTag("effort-ultra").assertIsEnabled().fetchSemanticsNode().boundsInRoot
        assertTrue("Reasoning levels remain a vertical list", high.bottom <= ultra.top)
        compose.onNodeWithTag("effort-ultra").performClick()
        compose.runOnIdle { assertEquals("ultra", effort); assertEquals(0, sends) }
    }

    @Test fun nativePermissionSelectionClearsTheOverrideWithoutSending() {
        var selected: Pair<String, Boolean>? = null
        var sends = 0
        render(fixture().copy(permissionPreset = "read-only"), PocActions(
            onSelectPermission = { preset, confirmed -> selected = preset to confirmed },
            onSend = { sends++ }))
        compose.onNodeWithTag("permission-picker").performClick()
        compose.onNodeWithTag("permission-native-settings").assertDoesNotExist()
        compose.onNodeWithTag("permission-native").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals("native" to false, selected); assertEquals(0, sends) }
    }

    @Test fun nativeConfigurationIsAccessibleThroughTheAnchoredPicker() {
        var refreshes = 0
        val defaults = NativeDefaults(approvalPolicy = ApprovalPolicy.OnRequest, effort = "ultra",
            model = "Fixture native model", origins = Origins(), readAt = 0,
            sandboxMode = SandboxMode.WorkspaceWrite, source = NativeDefaultsSource.NativeConfig)
        render(fixture(setOf("config.read")).copy(nativeDefaults = defaults),
            PocActions(onRefreshNativeDefaults = { refreshes++ }))
        compose.onNodeWithTag("permission-picker").performClick()
        compose.onNodeWithTag("permission-native-settings").performClick()
        compose.onNodeWithTag("native-defaults").assertIsDisplayed()
        compose.onNodeWithText("Fixture native model").assertIsDisplayed()
        compose.onNodeWithText("ultra").assertIsDisplayed()
        compose.runOnIdle { assertEquals(1, refreshes) }
    }

    @Test fun activeTurnComposerSteersWithoutStartingAnotherTurn() {
        var steers = 0
        var sends = 0
        val state = fixture(setOf("turn.steer")).copy(activeTurnId = turnId,
            canSteer = true, canStop = true, canSend = false, draft = "Fixture follow-up")
        render(state, PocActions(onSteer = { steers++ }, onSend = { sends++ }))
        compose.onNodeWithTag("send").assertDoesNotExist()
        compose.onNodeWithTag("steer").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(1, steers); assertEquals(0, sends) }
    }

    @Test fun extensionHeadersKeepLargeCatalogsCollapsedAndExposeStatus() {
        val state = fixture(setOf("extensions.read")).copy(inspector = InspectorUiState(extensions = listOf(
            ExtensionSectionUi("skills", "available", entries = List(84) {
                InspectorEntry("skill-$it", "Fixture skill $it", "Fixture skill description $it")
            }),
            ExtensionSectionUi("mcp", "available", entries = List(9) {
                InspectorEntry("mcp-$it", "Fixture MCP $it", "Fixture MCP description $it")
            }, limited = true),
            ExtensionSectionUi("apps", "unavailable", reason = "NATIVE_TIMEOUT"),
        )))
        render(state)
        compose.onNodeWithTag("inspector").performClick()
        compose.onNodeWithTag("inspector-extensions").performScrollTo().performClick()
        compose.onNodeWithTag("extensions-skills-toggle").assertIsDisplayed()
        compose.onNodeWithTag("extensions-mcp-toggle").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("84 项").assertExists()
        compose.onNodeWithText("9 项").assertIsDisplayed()
        compose.onNodeWithText("Fixture skill 0").assertDoesNotExist()
        compose.onNodeWithText("Fixture skill description 0").assertDoesNotExist()
        compose.onNodeWithText("Fixture MCP 0").assertDoesNotExist()
        compose.onNodeWithTag("extensions-apps-toggle").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("暂不可用").assertExists()
        compose.onNodeWithText("读取超时，请稍后刷新。").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("显示已取得的结果，清单可能不完整。").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("extensions-mcp-toggle").performScrollTo().performClick()
        compose.onNodeWithText("Fixture MCP 0").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Fixture skill 0").assertDoesNotExist()
    }

    @Test fun unresolvedSteeringHasNoSendFallback() {
        var steers = 0
        var sends = 0
        val state = fixture(setOf("turn.steer")).copy(activeTurnId = turnId,
            canSteer = false, canStop = true, canSend = false, draft = "Fixture follow-up",
            unknownWarning = "Fixture operation requires reconciliation")
        render(state, PocActions(onSteer = { steers++ }, onSend = { sends++ }))
        compose.onNodeWithTag("steer").assertIsNotEnabled()
        compose.onNodeWithTag("send").assertDoesNotExist()
        compose.runOnIdle { assertEquals(0, steers); assertEquals(0, sends) }
    }
}
