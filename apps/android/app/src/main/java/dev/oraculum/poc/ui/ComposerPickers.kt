package dev.oraculum.poc.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import dev.oraculum.poc.repository.isWritableEffort

/** Each menu belongs to the button's Box, so it stays anchored to the composer. */
@Composable
internal fun ModelPickerMenu(state: PocUiState, actions: PocActions, expanded: Boolean, onDismiss: () -> Unit) {
    var page by remember(expanded) { mutableStateOf("root") }
    val effectiveModel = composerModelId(state)
    val model = state.models.firstOrNull { it.id == effectiveModel }
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss,
        modifier = Modifier.width(280.dp).heightIn(max = 420.dp).testTag("model-sheet"),
        containerColor = if (LocalOledTheme.current) Color.Black else MaterialTheme.colorScheme.surfaceContainerHigh,
        tonalElevation = if (LocalOledTheme.current) 0.dp else MenuDefaults.TonalElevation,
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
    }
}

@Composable
internal fun PermissionPickerMenu(state: PocUiState, actions: PocActions, expanded: Boolean, onDismiss: () -> Unit) {
    var confirmFull by remember { mutableStateOf(false) }
    val selectedPreset = composerPermissionPreset(state)
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss,
        modifier = Modifier.width(240.dp).testTag("permission-sheet"),
        containerColor = if (LocalOledTheme.current) Color.Black else MaterialTheme.colorScheme.surfaceContainerHigh,
        tonalElevation = if (LocalOledTheme.current) 0.dp else MenuDefaults.TonalElevation,
        shape = OraculumTokens.ContentShape) {
        PickerChoice("只读", selectedPreset == "read-only", !state.busy, "permission-read-only", symbol = OraculumSymbol.ReadOnly) {
            actions.onSelectPermission("read-only", false); onDismiss()
        }
        PickerChoice("Auto", selectedPreset == "auto", !state.busy, "permission-auto", symbol = OraculumSymbol.Auto) {
            actions.onSelectPermission("auto", false); onDismiss()
        }
        PickerChoice("Full access", selectedPreset == "full-access", !state.busy, "permission-full-access", symbol = OraculumSymbol.FullAccess) {
            onDismiss(); confirmFull = true
        }
    }
    if (confirmFull) AlertDialog(onDismissRequest = { confirmFull = false },
        containerColor = if (LocalOledTheme.current) Color.Black else AlertDialogDefaults.containerColor,
        tonalElevation = if (LocalOledTheme.current) 0.dp else AlertDialogDefaults.TonalElevation,
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
private fun PickerChoice(label: String, selected: Boolean, enabled: Boolean, tag: String, availability: String? = null,
    symbol: OraculumSymbol? = null, onClick: () -> Unit) {
    DropdownMenuItem(text = { Text(label) }, onClick = onClick, enabled = enabled,
        leadingIcon = symbol?.let { icon -> { OraculumIcon(icon) } },
        trailingIcon = {
            if (availability != null) Text(availability, style = MaterialTheme.typography.labelSmall)
            else if (selected) OraculumIcon(OraculumSymbol.Check, "已选择", tint = MaterialTheme.colorScheme.primary)
        },
        modifier = Modifier.testTag(tag))
}
