package dev.oraculum.poc.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import dev.oraculum.poc.repository.isWritableEffort

/** Each menu belongs to the button's Box, so it stays anchored to the composer. */
@Composable
internal fun ModelPickerMenu(state: PocUiState, actions: PocActions, expanded: Boolean, onDismiss: () -> Unit) {
    var page by remember(expanded) { mutableStateOf("root") }
    val effectiveModel = composerModelId(state)
    val model = state.models.firstOrNull { it.id == effectiveModel }
    var defaults by remember { mutableStateOf(false) }
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss,
        modifier = Modifier.width(280.dp).heightIn(max = 420.dp).testTag("model-sheet"),
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = OraculumTokens.ContentShape) {
        if (page != "root") {
            DropdownMenuItem(text = { Text(if (page == "models") "模型" else "思考强度") },
                leadingIcon = { OraculumIcon(OraculumSymbol.ArrowBack) },
                onClick = { page = "root" }, modifier = Modifier.testTag("model-menu-back"))
            HorizontalDivider()
        }
        when (page) {
            "models" -> {
                PickerChoice(defaultChoiceLabel(composerModelLabel(state.copy(selectedModel = null, selectedEffort = null)), "模型"), state.selectedModel == null, !state.busy, "model-native-default") {
                    actions.onSelectModel(""); onDismiss()
                }
                state.models.forEach { option ->
                    PickerChoice(option.label, state.selectedModel == option.id, !state.busy, "model-${option.id}") {
                        actions.onSelectModel(option.id); onDismiss()
                    }
                }
                if (state.models.isEmpty()) DropdownMenuItem(text = { Text("连接后刷新可用模型") }, enabled = false, onClick = {})
                if (state.modelsLimited) DropdownMenuItem(text = { Text("仅显示已加载模型") }, enabled = false, onClick = {})
            }
            "efforts" -> {
                if (model != null) PickerChoice(defaultChoiceLabel(composerEffort(state.copy(selectedEffort = null))), state.selectedEffort == null, !state.busy, "effort-native-default") {
                    actions.onSelectEffort(""); onDismiss()
                }
                model?.efforts.orEmpty().forEach { effort ->
                    PickerChoice(effort, state.selectedEffort == effort, !state.busy && isWritableEffort(effort, state.gatewayProtocolMinor), "effort-$effort",
                        availability = if (isWritableEffort(effort, state.gatewayProtocolMinor)) null else "暂不可用") {
                        actions.onSelectEffort(effort); onDismiss()
                    }
                }
                if (model?.efforts.isNullOrEmpty()) DropdownMenuItem(text = { Text(composerEffort(state) ?: "思考强度") }, enabled = false, onClick = {})
            }
            else -> {
                DropdownMenuItem(text = { Text("模型") }, trailingIcon = {
                    Text(composerModelLabel(state), style = MaterialTheme.typography.labelMedium)
                }, onClick = { page = "models" }, modifier = Modifier.testTag("choose-model"))
                DropdownMenuItem(text = { Text("思考强度") }, trailingIcon = {
                    Text(composerEffort(state) ?: "思考强度", style = MaterialTheme.typography.labelMedium)
                }, onClick = { page = "efforts" }, modifier = Modifier.testTag("choose-effort"))
            }
        }
        if ("config.read" in state.capabilityNames) {
            HorizontalDivider()
            DropdownMenuItem(text = { Text("设置详情") }, leadingIcon = { OraculumIcon(OraculumSymbol.Info) },
                modifier = Modifier.testTag("model-native-settings"), onClick = {
                    onDismiss(); defaults = true
                    if (state.online && !state.busy) actions.onRefreshNativeDefaults()
                })
        }
    }
    if (defaults) NativeDefaultsDetails(state, actions) { defaults = false }
}

@Composable
internal fun PermissionPickerMenu(state: PocUiState, actions: PocActions, expanded: Boolean, onDismiss: () -> Unit) {
    var confirmFull by remember { mutableStateOf(false) }
    var defaults by remember { mutableStateOf(false) }
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss,
        modifier = Modifier.width(240.dp).testTag("permission-sheet"),
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = OraculumTokens.ContentShape) {
        PickerChoice(defaultChoiceLabel(composerPermissionLabel(state.copy(permissionPreset = "native")), "权限"), state.permissionPreset == "native", !state.busy, "permission-native") {
            actions.onSelectPermission("native", false); onDismiss()
        }
        PickerChoice("只读", state.permissionPreset == "read-only", !state.busy, "permission-read-only") {
            actions.onSelectPermission("read-only", false); onDismiss()
        }
        PickerChoice("Auto", state.permissionPreset == "auto", !state.busy, "permission-auto") {
            actions.onSelectPermission("auto", false); onDismiss()
        }
        PickerChoice("Full access", state.permissionPreset == "full-access", !state.busy, "permission-full-access") {
            onDismiss(); confirmFull = true
        }
        if ("config.read" in state.capabilityNames) {
            HorizontalDivider()
            DropdownMenuItem(text = { Text("设置详情") }, leadingIcon = { OraculumIcon(OraculumSymbol.Info) },
                modifier = Modifier.testTag("permission-native-settings"), onClick = {
                    onDismiss(); defaults = true
                    if (state.online && !state.busy) actions.onRefreshNativeDefaults()
                })
        }
        state.permissionReadback?.let { readback ->
            HorizontalDivider()
            DropdownMenuItem(text = { Text("当前权限：${permissionReadbackLabel(readback)}", style = MaterialTheme.typography.labelSmall) }, enabled = false, onClick = {})
        }
    }
    if (defaults) NativeDefaultsDetails(state, actions) { defaults = false }
    if (confirmFull) AlertDialog(onDismissRequest = { confirmFull = false },
        icon = { OraculumIcon(OraculumSymbol.Warning) }, title = { Text("启用 Full access？") },
        text = { Text("下一次执行将使用完整主机权限，且可能无需逐次审批。请仅对你信任的任务启用。") },
        confirmButton = { TextButton({
            actions.onSelectPermission("full-access", true); confirmFull = false
        }, Modifier.testTag("confirm-full-access")) { Text("确认启用") } },
        dismissButton = { TextButton({ confirmFull = false }) { Text("取消") } })
}

private fun defaultChoiceLabel(value: String?, unknown: String? = null): String =
    value?.takeIf { it.isNotBlank() && it != unknown }?.let { "默认设置 · $it" } ?: "默认设置"

@Composable
private fun PickerChoice(label: String, selected: Boolean, enabled: Boolean, tag: String, availability: String? = null, onClick: () -> Unit) {
    DropdownMenuItem(text = { Text(label) }, onClick = onClick, enabled = enabled,
        trailingIcon = {
            if (availability != null) Text(availability, style = MaterialTheme.typography.labelSmall)
            else if (selected) OraculumIcon(OraculumSymbol.Check, "已选择", tint = MaterialTheme.colorScheme.primary)
        },
        modifier = Modifier.testTag(tag))
}
