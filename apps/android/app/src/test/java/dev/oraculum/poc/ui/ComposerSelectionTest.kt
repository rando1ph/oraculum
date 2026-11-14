package dev.oraculum.poc.ui

import dev.oraculum.gateway.protocol.ApprovalPolicy
import dev.oraculum.gateway.protocol.NativeDefaults
import dev.oraculum.gateway.protocol.NativeDefaultsSource
import dev.oraculum.gateway.protocol.Origins
import dev.oraculum.gateway.protocol.SandboxMode
import org.junit.Assert.*
import org.junit.Test

class ComposerSelectionTest {
    private fun defaults(model: String? = "configured", effort: String? = "ultra",
        sandbox: SandboxMode? = SandboxMode.WorkspaceWrite) = NativeDefaults(
        approvalPolicy = ApprovalPolicy.OnRequest, effort = effort, model = model, origins = Origins(),
        readAt = 1, sandboxMode = sandbox, source = NativeDefaultsSource.NativeConfig, workspaceWriteNetworkAccess = true,
    )

    @Test fun missingFactsStayNeutralRatherThanImplyReadOnlyOrCatalogDefaults() {
        val state = PocUiState(models = listOf(ModelOption("catalog", "Catalog", listOf("low"), defaultEffort = "low")))
        assertEquals("权限", composerPermissionLabel(state))
        assertEquals("模型", composerModelAndEffortLabel(state))
        assertNull(composerEffort(state))
    }

    @Test fun inheritedModelAndEffortComeFromConfirmedThreadBeforeProjectSettings() {
        val state = PocUiState(actualModel = "thread", actualEffort = "high", nativeDefaults = defaults(),
            models = listOf(ModelOption("thread", "Thread model", listOf("low", "high"), defaultEffort = "low")))
        assertEquals("Thread model · high", composerModelAndEffortLabel(state))
        assertEquals("工作区写入", composerPermissionLabel(state))
    }

    @Test fun explicitModelNeverBorrowEffortFromDifferentThreadOrProjectModel() {
        val state = PocUiState(selectedModel = "chosen", actualModel = "thread", actualEffort = "high", nativeDefaults = defaults(),
            models = listOf(ModelOption("chosen", "Chosen", listOf("low"), defaultEffort = "low")))
        assertEquals("Chosen", composerModelAndEffortLabel(state))
        assertEquals("Chosen · low", composerModelAndEffortLabel(state.copy(selectedEffort = "low")))
    }

    @Test fun matchingProjectEffortIsUsedWhenNoMatchingThreadEffortWasReturned() {
        val state = PocUiState(selectedModel = "configured", actualModel = "old", actualEffort = "high", nativeDefaults = defaults())
        assertEquals("configured · ultra", composerModelAndEffortLabel(state))
        assertEquals("configured · ultra", composerModelAndEffortLabel(state.copy(actualModel = "configured", actualEffort = null)))
    }

    @Test fun permissionUsesExplicitChoiceThenConfirmedReadbackAndNeverInventsAuto() {
        val readback = PermissionReadbackUi("dangerFullAccess", "never", "full-access", 1, "thread.resume")
        val state = PocUiState(permissionReadback = readback, actualPermissionPreset = "full-access", nativeDefaults = defaults())
        assertEquals("Full access", composerPermissionLabel(state))
        assertEquals("只读", composerPermissionLabel(state.copy(permissionPreset = "read-only")))
        assertEquals("Auto", composerPermissionLabel(state.copy(permissionPreset = "auto")))
        assertEquals("自定义权限", composerPermissionLabel(state.copy(actualPermissionPreset = null,
            permissionReadback = readback.copy(sandboxType = "customSandbox", preset = null))))
    }

    @Test fun configurationEffortWithoutKnownModelDoesNotAttachToUnrelatedThread() {
        val state = PocUiState(actualModel = "thread", nativeDefaults = defaults(model = null))
        assertEquals("thread", composerModelAndEffortLabel(state))
    }
}
