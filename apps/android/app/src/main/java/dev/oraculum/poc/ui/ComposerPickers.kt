package dev.oraculum.poc.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

/** Each menu belongs to the button's Box, so it stays anchored to the composer. */
@Composable
internal fun ModelPickerMenu(state: PocUiState, actions: PocActions, expanded: Boolean, onDismiss: () -> Unit) {
    var page by remember(expanded) { mutableStateOf("root") }
    val model = state.models.firstOrNull { it.id == state.selectedModel }
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
                state.models.forEach { option ->
                    PickerChoice(option.label, state.selectedModel == option.id, !state.busy, "model-${option.id}") {
                        actions.onSelectModel(option.id); onDismiss()
                    }
                }
                if (state.models.isEmpty()) DropdownMenuItem(text = { Text("连接后刷新可用模型") }, enabled = false, onClick = {})
                if (state.modelsLimited) DropdownMenuItem(text = { Text("仅显示已加载模型") }, enabled = false, onClick = {})
            }
            "efforts" -> {
                model?.efforts.orEmpty().forEach { effort ->
                    PickerChoice(effort, state.selectedEffort == effort, !state.busy, "effort-$effort") {
                        actions.onSelectEffort(effort); onDismiss()
                    }
                }
                if (model?.efforts.isNullOrEmpty()) DropdownMenuItem(text = { Text("默认") }, enabled = false, onClick = {})
            }
            else -> {
                DropdownMenuItem(text = { Text("模型") }, trailingIcon = {
                    Text(model?.label ?: state.selectedModel ?: "未选择", style = MaterialTheme.typography.labelMedium)
                }, onClick = { page = "models" }, modifier = Modifier.testTag("choose-model"))
                DropdownMenuItem(text = { Text("思考强度") }, trailingIcon = {
                    Text(state.selectedEffort ?: "默认", style = MaterialTheme.typography.labelMedium)
                }, onClick = { page = "efforts" }, modifier = Modifier.testTag("choose-effort"))
            }
        }
    }
}

@Composable
internal fun PermissionPickerMenu(state: PocUiState, actions: PocActions, expanded: Boolean, onDismiss: () -> Unit) {
    var confirmFull by remember { mutableStateOf(false) }
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss,
        modifier = Modifier.width(240.dp).testTag("permission-sheet"),
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = OraculumTokens.ContentShape) {
        PickerChoice("只读", state.permissionPreset == "read-only", !state.busy, "permission-read-only") {
            actions.onSelectPermission("read-only", false); onDismiss()
        }
        PickerChoice("Auto", state.permissionPreset == "auto", !state.busy, "permission-auto") {
            actions.onSelectPermission("auto", false); onDismiss()
        }
        PickerChoice("Full access", state.permissionPreset == "full-access", !state.busy, "permission-full-access") {
            onDismiss(); confirmFull = true
        }
        state.permissionReadback?.let { readback ->
            HorizontalDivider()
            DropdownMenuItem(text = { Text("最近确认：${when (readback.preset) {
                "read-only" -> "只读"; "auto" -> "Auto"; "full-access" -> "Full access"; else -> "自定义权限"
            }}", style = MaterialTheme.typography.labelSmall) }, enabled = false, onClick = {})
        }
    }
    if (confirmFull) AlertDialog(onDismissRequest = { confirmFull = false },
        icon = { OraculumIcon(OraculumSymbol.Warning) }, title = { Text("启用 Full access？") },
        text = { Text("下一次执行将使用完整主机权限，且可能无需逐次审批。请仅对你信任的任务启用。") },
        confirmButton = { TextButton({
            actions.onSelectPermission("full-access", true); confirmFull = false
        }, Modifier.testTag("confirm-full-access")) { Text("确认启用") } },
        dismissButton = { TextButton({ confirmFull = false }) { Text("取消") } })
}

@Composable
private fun PickerChoice(label: String, selected: Boolean, enabled: Boolean, tag: String, onClick: () -> Unit) {
    DropdownMenuItem(text = { Text(label) }, onClick = onClick, enabled = enabled,
        trailingIcon = { if (selected) OraculumIcon(OraculumSymbol.Check, "已选择", tint = MaterialTheme.colorScheme.primary) },
        modifier = Modifier.testTag(tag))
}
