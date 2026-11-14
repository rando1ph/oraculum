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

    @Test fun missingPermissionDefaultsSelectAutoWithoutInventingModelDefaults() {
        val state = PocUiState(models = listOf(ModelOption("catalog", "Catalog", listOf("low"), defaultEffort = "low")))
        assertEquals("auto", composerPermissionPreset(state))
        assertEquals("Auto", composerPermissionLabel(state))
        assertEquals("模型", composerModelAndEffortLabel(state))
        assertNull(composerEffort(state))
    }

    @Test fun inheritedModelAndEffortComeFromConfirmedThreadBeforeProjectSettings() {
        val state = PocUiState(actualModel = "thread", actualEffort = "high", nativeDefaults = defaults(),
            models = listOf(ModelOption("thread", "Thread model", listOf("low", "high"), defaultEffort = "low")))
        assertEquals("Thread model · high", composerModelAndEffortLabel(state))
        assertEquals("auto", composerPermissionPreset(state))
        assertEquals("Auto", composerPermissionLabel(state))
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

    @Test fun nextRequestDefaultsDoNotBorrowThePreviousTurnsPermission() {
        val readback = PermissionReadbackUi("dangerFullAccess", "never", "full-access", 1, "thread.resume")
        val state = PocUiState(permissionReadback = readback, actualPermissionPreset = "full-access",
            nativeDefaults = defaults(sandbox = SandboxMode.ReadOnly))
        assertEquals("read-only", composerPermissionPreset(state))
        assertEquals("只读", composerPermissionLabel(state))
        assertEquals("auto", composerPermissionPreset(state.copy(nativeDefaults = null)))
        assertEquals("Auto", composerPermissionLabel(state.copy(nativeDefaults = null)))
        assertEquals("full-access", state.permissionReadback?.preset)
    }

    @Test fun explicitPermissionsOverrideEveryDefaultIncludingUnknownSettings() {
        for ((preset, label) in listOf("read-only" to "只读", "auto" to "Auto", "full-access" to "Full access")) {
            val state = PocUiState(permissionPreset = preset, nativeDefaults = defaults())
            assertEquals(preset, composerPermissionPreset(state))
            assertEquals(label, composerPermissionLabel(state))
        }
    }

    @Test fun onlyClassifiedDefaultsCanProduceFullAccessOrReadOnly() {
        val full = defaults(sandbox = SandboxMode.DangerFullAccess).copy(approvalPolicy = ApprovalPolicy.Never)
        assertEquals("full-access", composerPermissionPreset(PocUiState(nativeDefaults = full)))
        assertEquals("Full access", composerPermissionLabel(PocUiState(nativeDefaults = full)))
        assertEquals("read-only", composerPermissionPreset(PocUiState(nativeDefaults = defaults(sandbox = SandboxMode.ReadOnly))))
        assertEquals("auto", composerPermissionPreset(PocUiState(nativeDefaults = full.copy(approvalPolicy = ApprovalPolicy.OnRequest))))
        assertEquals("auto", composerPermissionPreset(PocUiState(permissionPreset = "unknown", nativeDefaults = full)))
        assertEquals("auto", composerPermissionPreset(PocUiState(nativeDefaults = defaults().copy(sandboxMode = null))))
    }

    @Test fun customReadbackFactsRemainAvailableWithoutBecomingTheSelectedPermission() {
        val custom = PermissionReadbackUi("customSandbox", "custom", null, 1, "thread.resume")
        val state = PocUiState(permissionReadback = custom, actualPermissionPreset = "full-access")
        assertEquals("auto", composerPermissionPreset(state))
        assertEquals("Auto", composerPermissionLabel(state))
        assertEquals("自定义权限", permissionReadbackLabel(custom))
        assertSame(custom, state.permissionReadback)
    }

    @Test fun configurationEffortWithoutKnownModelDoesNotAttachToUnrelatedThread() {
        val state = PocUiState(actualModel = "thread", nativeDefaults = defaults(model = null))
        assertEquals("thread", composerModelAndEffortLabel(state))
    }
}
