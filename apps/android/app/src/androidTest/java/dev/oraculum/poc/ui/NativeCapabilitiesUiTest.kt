@file:Suppress("DEPRECATION")

package dev.oraculum.poc.ui

import androidx.activity.ComponentActivity
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsProperties
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

    @Suppress("DEPRECATION")
    @Test fun copyRemainsAvailableWithoutMutationCapabilities() {
        var copied: AnnotatedString? = null
        val clipboard = object : ClipboardManager {
            override fun setText(annotatedString: AnnotatedString) { copied = annotatedString }
            override fun getText(): AnnotatedString? = copied
        }
        renderContent { CompositionLocalProvider(LocalClipboardManager provides clipboard) {
            OraculumScreen(fixture(), PocActions())
        } }
        compose.onNodeWithTag("thread-tools").assertDoesNotExist()
        compose.onNodeWithTag("conversation-bottom").assertDoesNotExist()
        compose.onNodeWithTag("turn-tools-$turnId").performClick()
        compose.onNodeWithTag("fork-turn-$turnId").assertDoesNotExist()
        compose.onNodeWithTag("revert-turn-$turnId").assertDoesNotExist()
        compose.onNodeWithTag("copy-turn-$turnId").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals("Fixture answer", copied?.text) }
        compose.onNodeWithTag("navigation").performClick()
        compose.onNodeWithTag("thread-${thread.id}").assertIsDisplayed()
        compose.onNodeWithTag("thread-menu-${thread.id}").assertDoesNotExist()
        compose.onNodeWithTag("archived-threads-toggle").assertDoesNotExist()
    }

    @Test fun answerWithoutNativeTurnIdCanBeCopiedButCannotMutateHistory() {
        var copied: AnnotatedString? = null
        var mutations = 0
        val clipboard = object : ClipboardManager {
            override fun setText(annotatedString: AnnotatedString) { copied = annotatedString }
            override fun getText(): AnnotatedString? = copied
        }
        val state = fixture(setOf("thread.fork", "thread.revert"))
        val actions = PocActions(onForkThread = { mutations++ }, onRevertThread = { mutations++ })
        renderContent { CompositionLocalProvider(LocalClipboardManager provides clipboard) {
            TurnToolsMenu("", state, actions, copyText = "Fixture orphan answer", menuKey = "orphan-fixture")
        } }
        compose.onNodeWithTag("turn-tools-orphan-fixture").performClick()
        compose.onNodeWithTag("fork-turn-orphan-fixture").assertDoesNotExist()
        compose.onNodeWithTag("revert-turn-orphan-fixture").assertDoesNotExist()
        compose.onNodeWithTag("copy-turn-orphan-fixture").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals("Fixture orphan answer", copied?.text); assertEquals(0, mutations) }
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

    @Test fun archivesRemainInCollapsedSettingsAndUseTheirIndependentList() {
        val archived = ThreadOption("archived-fixture", "Archived fixture", archived = true)
        val restored = mutableListOf<String>()
        val archiveRequests = mutableListOf<Boolean>()
        var loadMore = 0
        val state = fixture(setOf("thread.unarchive")).copy(
            threads = listOf(thread, archived), archivedThreads = listOf(archived),
            archivedThreadsLoaded = true, canLoadMoreArchivedThreads = true)
        render(state, PocActions(onUnarchiveThread = { restored += it },
            onShowArchivedThreads = { archiveRequests += it },
            onLoadMoreArchivedThreads = { loadMore++ }))
        compose.onNodeWithTag("navigation").performClick()
        compose.onNodeWithTag("thread-${thread.id}").assertIsDisplayed()
        compose.onNodeWithTag("thread-${archived.id}").assertDoesNotExist()
        compose.onNodeWithTag("archived-threads-toggle").assertDoesNotExist()
        compose.onNodeWithTag("settings").performClick()
        compose.onNodeWithTag("settings-archives-toggle").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("settings-archives").assertDoesNotExist()
        compose.onNodeWithTag("thread-${archived.id}").assertDoesNotExist()
        compose.onNodeWithTag("settings-archives-toggle").performClick()
        compose.runOnIdle { assertEquals(listOf(true), archiveRequests) }
        compose.onNodeWithTag("thread-${archived.id}").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("load-more-archived-threads").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(1, loadMore) }
        compose.onNodeWithTag("thread-menu-${archived.id}").performScrollTo().performClick()
        compose.onNodeWithTag("thread-archive-${archived.id}").assertDoesNotExist()
        compose.onNodeWithTag("thread-restore-${archived.id}").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(listOf(archived.id), restored) }
    }

    @Test fun threadAndTurnToolsPreserveIdsAndConfirmHistoryChanges() {
        val forks = mutableListOf<String?>()
        val reverted = mutableListOf<String>()
        var compactions = 0
        val state = fixture(setOf("thread.fork", "thread.compact", "thread.revert"))
        val actions = PocActions(onForkThread = { forks += it }, onCompactThread = { compactions++ },
            onRevertThread = { reverted += it })
        render(state, actions)
        compose.onNodeWithTag("thread-tools").assertDoesNotExist()
        compose.onNodeWithTag("composer-add").performClick()
        compose.onNodeWithTag("files_pick").assertExists()
        compose.onNodeWithTag("composer-files").assertDoesNotExist()
        compose.onNodeWithTag("composer-navigation").assertDoesNotExist()
        compose.onNodeWithTag("fork-thread").performClick()
        compose.runOnIdle { assertEquals(listOf<String?>(null), forks) }
        compose.onNodeWithTag("turn-tools-$turnId").performClick()
        val copy = compose.onNodeWithTag("copy-turn-$turnId").assertIsEnabled().fetchSemanticsNode().boundsInRoot
        val fork = compose.onNodeWithTag("fork-turn-$turnId").assertIsEnabled().fetchSemanticsNode().boundsInRoot
        val revert = compose.onNodeWithTag("revert-turn-$turnId").assertIsEnabled().fetchSemanticsNode().boundsInRoot
        assertTrue("Copy leads the destructive history actions", copy.bottom <= fork.top && fork.bottom <= revert.top)
        compose.onNodeWithTag("fork-turn-$turnId").performClick()
        compose.runOnIdle { assertEquals(listOf(null, turnId), forks) }
        compose.onNodeWithTag("composer-add").performClick()
        compose.onNodeWithTag("compact-thread").performClick()
        compose.onNodeWithTag("compact-thread").assertDoesNotExist()
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
            1 -> OraculumScreen(state, actions)
            else -> TurnToolsMenu(turnId, state, actions, copyText = "Fixture answer")
        } }
        compose.onNodeWithTag("thread-menu-${thread.id}").performClick()
        compose.onNodeWithTag("thread-rename-${thread.id}").assertIsNotEnabled()
        compose.onNodeWithTag("thread-archive-${thread.id}").assertIsNotEnabled()
        compose.onNodeWithTag("thread-delete-${thread.id}").assertIsNotEnabled()
        compose.runOnIdle { pane.value = 1 }
        compose.onNodeWithTag("thread-tools").assertDoesNotExist()
        compose.onNodeWithTag("composer-add").performClick()
        compose.onNodeWithTag("fork-thread").assertIsNotEnabled()
        compose.onNodeWithTag("compact-thread").assertIsNotEnabled()
        compose.runOnIdle { pane.value = 2 }
        compose.onNodeWithTag("turn-tools-$turnId").performClick()
        compose.onNodeWithTag("copy-turn-$turnId").assertIsEnabled()
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
        val progress = compose.onNodeWithTag("account-quota-progress-primary", useUnmergedTree = true)
            .assertIsDisplayed().fetchSemanticsNode().config[SemanticsProperties.ProgressBarRangeInfo]
        assertEquals("The bar represents remaining quota", .65f, progress.current, .0001f)
        compose.onNodeWithTag("account-quota-progress-secondary", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("account-quota").performClick()
        compose.onNodeWithTag("account-details").assertIsDisplayed()
        compose.onNodeWithText("剩余 65%").assertIsDisplayed()
        compose.onNodeWithText("剩余 35%").assertDoesNotExist()
        compose.onNodeWithText("剩余 0%").assertDoesNotExist()
    }

    @Test fun missingQuotaRemainsUnknownWithoutInventingZero() {
        val state = mutableStateOf(fixture())
        renderContent { AccountQuotaFooter(state.value, PocActions()) }
        compose.onNodeWithText("暂不可用").assertIsDisplayed()
        compose.onNodeWithTag("account-quota-progress-primary", useUnmergedTree = true).assertDoesNotExist()
        compose.runOnIdle { state.value = state.value.copy(accountRateLimits = AccountRateLimits(
            limited = false, rateLimits = RateLimitsClass(primary = RateLimitsRateLimitWindow(
                usedPercent = 101, windowDurationMins = 300)),
            readAt = 0, source = AccountRateLimitsSource.NativeRateLimits)) }
        compose.onNodeWithText("5 小时 未知").assertIsDisplayed()
        compose.onNodeWithTag("account-quota-progress-primary", useUnmergedTree = true).assertDoesNotExist()
        compose.runOnIdle { state.value = state.value.copy(accountRateLimits = null) }
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

    @Test fun inheritedChipsShowKnownValuesWithoutCreatingOverrides() {
        var overrides = 0
        val defaults = NativeDefaults(approvalPolicy = ApprovalPolicy.OnRequest, effort = "ultra",
            model = "model-fixture", origins = Origins(), readAt = 0,
            sandboxMode = SandboxMode.WorkspaceWrite, source = NativeDefaultsSource.NativeConfig)
        val state = fixture().copy(selectedModel = null, selectedEffort = null,
            permissionPreset = "native", nativeDefaults = defaults)
        render(state, PocActions(onSelectModel = { overrides++ }, onSelectEffort = { overrides++ },
            onSelectPermission = { _, _ -> overrides++ }))
        compose.onNodeWithTag("permission-picker").assertTextContains("工作区写入")
        compose.onNodeWithTag("model-picker").assertTextContains("Fixture model · ultra")
        compose.onNodeWithText("原生").assertDoesNotExist()
        compose.runOnIdle { assertEquals(0, overrides) }
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
