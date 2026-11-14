package dev.oraculum.poc.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Compact, anchored sort controls; each list keeps its own local preference. */
@Composable
internal fun NavigationSortButton(
    selection: NavigationSort,
    tag: String,
    label: String,
    hasCreatedAt: Boolean,
    hasUpdatedAt: Boolean,
    onSelect: (NavigationSort) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        IconButton({ expanded = true }, Modifier.size(48.dp).testTag(tag)) {
            OraculumIcon(OraculumSymbol.Sort, label, size = 20.dp)
        }
        DropdownMenu(expanded, { expanded = false }, modifier = Modifier.width(208.dp),
            containerColor = if (LocalOledTheme.current) Color.Black else MaterialTheme.colorScheme.surfaceContainer,
            tonalElevation = if (LocalOledTheme.current) 0.dp else MenuDefaults.TonalElevation) {
            NavigationSort.entries.forEach { sort ->
                val enabled = when (sort) {
                    NavigationSort.CreatedNewest -> hasCreatedAt
                    NavigationSort.UpdatedNewest -> hasUpdatedAt
                    else -> true
                }
                val selected = sort == selection
                DropdownMenuItem(
                    text = { Text(when (sort) {
                        NavigationSort.CreatedNewest -> "创建时间"
                        NavigationSort.UpdatedNewest -> "最近修改"
                        NavigationSort.NameAscending -> "名称 A–Z"
                        NavigationSort.NameDescending -> "名称 Z–A"
                    }, color = if (selected) MaterialTheme.colorScheme.primary else Color.Unspecified) },
                    leadingIcon = { OraculumIcon(when (sort) {
                        NavigationSort.CreatedNewest -> OraculumSymbol.History
                        NavigationSort.UpdatedNewest -> OraculumSymbol.Refresh
                        else -> OraculumSymbol.Sort
                    }, size = 18.dp) },
                    trailingIcon = { if (selected) OraculumIcon(OraculumSymbol.Check,
                        tint = MaterialTheme.colorScheme.primary, size = 18.dp) },
                    enabled = enabled,
                    modifier = Modifier.testTag("$tag-${sort.name}").semantics { this.selected = selected },
                    onClick = { expanded = false; onSelect(sort) },
                )
            }
            if (!hasCreatedAt && !hasUpdatedAt) Text("暂无时间信息",
                Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** Keep the selected surface, with an intentionally unavailable placeholder for future actions. */
@Composable
internal fun NativeProjectRow(project: ProjectOption, state: PocUiState, onSelect: () -> Unit) {
    val selected = project.id == state.selectedProjectId
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
            IconButton({}, enabled = false, modifier = Modifier.size(48.dp).testTag("project-menu-${project.id}")) {
                OraculumIcon(OraculumSymbol.More, "项目选项 ${project.label}", size = 24.dp)
            }
        }
    }
}
