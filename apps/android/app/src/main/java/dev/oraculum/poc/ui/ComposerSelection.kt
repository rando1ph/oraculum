package dev.oraculum.poc.ui

/** Display confirmed values without turning an inherited setting into an explicit override. */
internal fun composerPermissionLabel(state: PocUiState): String {
    if (state.permissionPreset != "native") return permissionPresetLabel(state.permissionPreset) ?: "权限"
    return permissionPresetLabel(state.actualPermissionPreset)
        ?: state.permissionReadback?.let(::permissionReadbackLabel)
        ?: sandboxLabel(state.nativeDefaults?.sandboxMode?.value)
        ?: "权限"
}

internal fun composerModelId(state: PocUiState): String? =
    state.selectedModel.visibleValue() ?: state.actualModel.visibleValue() ?: state.nativeDefaults?.model.visibleValue()

internal fun composerModelLabel(state: PocUiState): String {
    val id = composerModelId(state) ?: return "模型"
    return state.models.firstOrNull { it.id == id }?.label.visibleValue() ?: id
}

internal fun composerEffort(state: PocUiState): String? {
    state.selectedEffort.visibleValue()?.let { return it }
    val model = composerModelId(state) ?: return null
    if (state.actualModel.visibleValue() == model) state.actualEffort.visibleValue()?.let { return it }
    return state.nativeDefaults?.takeIf { it.model.visibleValue() == model }?.effort.visibleValue()
}

internal fun composerModelAndEffortLabel(state: PocUiState): String =
    listOfNotNull(composerModelLabel(state), composerEffort(state)).joinToString(" · ")

internal fun permissionReadbackLabel(readback: PermissionReadbackUi): String =
    permissionPresetLabel(readback.preset) ?: sandboxLabel(readback.sandboxType) ?: "自定义权限"

private fun permissionPresetLabel(preset: String?): String? = when (preset) {
    "read-only" -> "只读"
    "auto" -> "Auto"
    "full-access" -> "Full access"
    else -> null
}

private fun sandboxLabel(sandbox: String?): String? = when (sandbox) {
    "read-only", "readOnly" -> "只读"
    "workspace-write", "workspaceWrite" -> "工作区写入"
    "danger-full-access", "dangerFullAccess" -> "完整主机权限"
    else -> null
}

private fun String?.visibleValue(): String? = this?.takeIf { it.isNotBlank() }
