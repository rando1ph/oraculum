package dev.oraculum.poc.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Button
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.IconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Read-only directory browsing; the host owns registration and closing the secondary card. */
@Composable
internal fun ProjectDirectoryCard(
    state: PocUiState,
    actions: PocActions,
    onCancel: () -> Unit,
    onRegister: (String, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var rootMenu by remember { mutableStateOf(false) }
    val directory = state.directory
    val root = state.roots.firstOrNull { it.id == directory.rootId }
    val canBrowse = state.online && !state.busy
    val hasWriteBarrier = state.unknownWarning != null || state.unresolvedOperations.isNotEmpty()
    val directoryRegistrable = root != null && directory.path.isNotBlank() && directory.canRegister
    val canRegister = canBrowse && !hasWriteBarrier && directoryRegistrable
    val currentPath = when {
        root == null -> "尚未选择"
        directory.path.isBlank() -> root.label
        else -> "${root.label.trimEnd('/')}/${directory.path}"
    }

    Surface(modifier.fillMaxSize().testTag("project-directory-card"),
        color = if (LocalOledTheme.current) Color.Black else MaterialTheme.colorScheme.surfaceContainerLow) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                SelectionContainer(Modifier.weight(1f)) {
                    Text("当前目录: $currentPath" + if (root != null) "（相对路径）" else "",
                        Modifier.fillMaxWidth().testTag("project-directory-current").semantics { heading() },
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
                }
                if (state.roots.size > 1) Box {
                    IconButton({ rootMenu = true }, enabled = canBrowse,
                        modifier = Modifier.size(48.dp).testTag("project-directory-roots")) {
                        OraculumIcon(OraculumSymbol.Folder, "切换授权目录")
                    }
                    DropdownMenu(rootMenu, { rootMenu = false },
                        containerColor = if (LocalOledTheme.current) Color.Black else MaterialTheme.colorScheme.surfaceContainer,
                        tonalElevation = if (LocalOledTheme.current) 0.dp else MenuDefaults.TonalElevation) {
                        state.roots.forEach { option ->
                            DropdownMenuItem(text = { Text(option.label) }, enabled = canBrowse,
                                modifier = Modifier.testTag("project-directory-root-${option.id}"),
                                onClick = { rootMenu = false; actions.onBrowseDirectory(option.id, "") })
                        }
                    }
                }
            }
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            state.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            if (!state.online) Text("离线，联网后继续浏览", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .5f))
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                if (root != null && directory.path.isNotBlank()) item(key = "parent") {
                    TextButton({ actions.onBrowseDirectory(root.id, directory.path.substringBeforeLast('/', "")) },
                        enabled = canBrowse, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("project-directory-parent")) {
                        OraculumIcon(OraculumSymbol.ChevronRight, modifier = Modifier.rotate(180f), size = 20.dp)
                        Text("返回上级", Modifier.weight(1f).padding(start = 8.dp), color = MaterialTheme.colorScheme.onSurface)
                    }
                }
                if (root != null) items(directory.entries, key = { "entry-${it.path}" }) { entry ->
                    TextButton({ actions.onBrowseDirectory(root.id, entry.path) }, enabled = canBrowse,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("project-directory-entry-${entry.path}")) {
                        OraculumIcon(OraculumSymbol.Folder, tint = MaterialTheme.colorScheme.onSurfaceVariant, size = 20.dp)
                        Text(entry.name, Modifier.weight(1f).padding(horizontal = 8.dp), maxLines = 2,
                            overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurface)
                        OraculumIcon(OraculumSymbol.ChevronRight, size = 18.dp, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (!state.busy && (root == null || directory.entries.isEmpty())) item(key = "empty") {
                    Text(when {
                        state.roots.isEmpty() -> "尚无可用的授权目录"
                        root == null -> "选择授权目录开始浏览"
                        else -> "此目录没有子目录"
                    }, Modifier.padding(vertical = 12.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (root != null && directory.canLoadMore) item(key = "more") {
                    TextButton(actions.onLoadMoreDirectories, enabled = canBrowse,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("project-directory-more")) { Text("加载更多目录") }
                }
                if (root != null && directory.limited) item(key = "limited") {
                    Text("目录清单可能不完整", Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (hasWriteBarrier) Text("确认待处理操作后可注册", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            else if (!state.busy && root != null && !directoryRegistrable) Text(
                if (directory.path.isBlank()) "请选择项目子目录" else "当前目录不可注册",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onCancel, Modifier.weight(1f).heightIn(min = 48.dp).testTag("project-directory-cancel")) { Text("取消") }
                Button({ onRegister(directory.rootId, directory.path) }, enabled = canRegister,
                    modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("project-directory-register")) { Text("注册") }
            }
        }
    }
}
