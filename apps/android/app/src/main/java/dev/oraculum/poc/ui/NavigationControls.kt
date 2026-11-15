package dev.oraculum.poc.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
internal fun NativeProjectRow(project: ProjectOption, state: PocUiState, actions: PocActions, onSelect: () -> Unit) {
    var menu by remember(project.id) { mutableStateOf(false) }
    var confirmDelete by rememberSaveable(project.id) { mutableStateOf(false) }
    val selected = project.id == state.selectedProjectId
    val canDelete = state.online && !state.busy && "projects" in state.capabilityNames &&
        state.unknownWarning == null && state.unresolvedOperations.isEmpty() && state.projects.any { it.id == project.id }
    Surface(color = if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent,
        shape = RoundedCornerShape(16.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).heightIn(min = 56.dp).clickable(enabled = !state.busy, onClick = onSelect)
                .testTag("project-${project.id}").semantics { this.selected = selected }
                .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OraculumIcon(OraculumSymbol.Folder,
                    tint = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(project.label, maxLines = 2, overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.titleSmall)
                    if (project.detail.isNotBlank()) Text(project.detail, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Box {
                IconButton({ menu = true }, enabled = !state.busy,
                    modifier = Modifier.size(48.dp).testTag("project-menu-${project.id}")) {
                    OraculumIcon(OraculumSymbol.More, "项目选项 ${project.label}", size = 24.dp)
                }
                DropdownMenu(menu, { menu = false },
                    containerColor = if (LocalOledTheme.current) Color.Black else MaterialTheme.colorScheme.surfaceContainer,
                    tonalElevation = if (LocalOledTheme.current) 0.dp else MenuDefaults.TonalElevation) {
                    DropdownMenuItem(text = { Text("删除项目", color = if (canDelete) MaterialTheme.colorScheme.error else Color.Unspecified) },
                        leadingIcon = { OraculumIcon(OraculumSymbol.Delete) }, enabled = canDelete,
                        modifier = Modifier.testTag("delete-project-${project.id}"),
                        onClick = { menu = false; confirmDelete = true })
                }
            }
        }
    }
    if (confirmDelete) AlertDialog(onDismissRequest = { confirmDelete = false },
        containerColor = if (LocalOledTheme.current) Color.Black else AlertDialogDefaults.containerColor,
        tonalElevation = if (LocalOledTheme.current) 0.dp else AlertDialogDefaults.TonalElevation,
        title = { Text("删除项目？") },
        text = { Text("“${project.label}”将从项目列表中移除，实际文件夹和 Codex 会话历史会保留。") },
        confirmButton = { TextButton({
            confirmDelete = false
            actions.onDeleteProject(project.id)
        }, enabled = canDelete, modifier = Modifier.testTag("confirm-delete-project-${project.id}")) {
            Text("删除项目", color = if (canDelete) MaterialTheme.colorScheme.error else Color.Unspecified)
        } },
        dismissButton = { TextButton({ confirmDelete = false }) { Text("取消") } })
}
