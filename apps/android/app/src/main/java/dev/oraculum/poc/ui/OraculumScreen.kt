@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package dev.oraculum.poc.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.oraculum.poc.R
import dev.oraculum.poc.files.AttachmentChips
import dev.oraculum.poc.files.AttachmentPickerButton
import dev.oraculum.poc.files.FilesActions
import dev.oraculum.poc.files.FilesPanel
import dev.oraculum.poc.files.FilesUiState
import kotlinx.coroutines.flow.distinctUntilChanged
import java.text.DateFormat
import java.util.Date

@Composable
fun OraculumScreen(
    state: PocUiState,
    actions: PocActions,
    filesState: FilesUiState = FilesUiState(),
    filesActions: FilesActions = FilesActions(),
    notificationEnabled: Boolean = false,
    onNotificationSettings: () -> Unit = {},
) {
    var panel by rememberSaveable { mutableStateOf<String?>(null) }
    var inspectorTab by rememberSaveable { mutableStateOf("output") }
    val keyboardController = LocalSoftwareKeyboardController.current
    LaunchedEffect(panel) { if (panel != null) keyboardController?.hide() }
    val selectedThread = state.threads.firstOrNull { it.id == state.selectedThreadId }
    val selectedProject = state.projects.firstOrNull { it.id == state.selectedProjectId }
    LaunchedEffect(state.navigationRequest) {
        if (state.navigationRequest?.startsWith("inspector:") == true) { panel = "inspector"; inspectorTab = "output" }
        else if (state.navigationRequest?.startsWith("conversation:") == true) panel = null
    }
    BackHandler(enabled = panel != null) { panel = null }
    BoxWithConstraints(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
        // A useful conversation remains at least 400dp wide beside the inspector.
        val imeHeight = with(LocalDensity.current) { WindowInsets.ime.getBottom(this).toDp() }
        val compactViewport = maxHeight - imeHeight < 450.dp
        val composerHeight = ((maxHeight - imeHeight - 76.dp) * .62f).coerceIn(104.dp, 320.dp)
        val persistentInspector = maxWidth >= 1000.dp && state.paired && state.selectedThreadId != null
        Row(Modifier.fillMaxSize()) {
            Scaffold(modifier = Modifier.weight(1f), containerColor = MaterialTheme.colorScheme.background,
                topBar = {
                    Surface(color = MaterialTheme.colorScheme.background) {
                        Column(Modifier.statusBarsPadding().padding(horizontal = 12.dp, vertical = 6.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                IconButton(onClick = { panel = "navigation" }, enabled = state.paired,
                                    modifier = Modifier.size(48.dp).testTag("navigation").semantics { contentDescription = "打开项目与会话导航" }) {
                                    Surface(shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainerHigh) {
                                        Image(painterResource(R.drawable.oracle_eye_mark), contentDescription = null, modifier = Modifier.size(44.dp).padding(10.dp))
                                    }
                                }
                                Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                                    Text(selectedThread?.label ?: "神谕 · Oraculum", maxLines = 1, overflow = TextOverflow.Ellipsis,
                                        style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                    Text(selectedProject?.label ?: "你的 Codex 工作区", maxLines = 1, overflow = TextOverflow.Ellipsis,
                                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                if (state.paired) GlyphButton("inspector", "打开 Inspector", "inspector", onClick = { panel = "inspector"; actions.onRefreshInspector() })
                                else GlyphButton("settings", "设置", "settings", onClick = { panel = "settings" })
                            }
                            if (!compactViewport) Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 12.dp)) {
                                Box(Modifier.size(6.dp).background(if (state.online) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.outline, CircleShape))
                                Text(state.connectionLabel, Modifier.padding(start = 8.dp).weight(1f), style = MaterialTheme.typography.labelSmall,
                                    maxLines = 2, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                if (state.paired && !state.online) TextButton(actions.onReconnect, enabled = !state.busy, modifier = Modifier.testTag("reconnect")) { Text("重连") }
                                if (state.paired) GlyphButton("settings", "设置", "settings", onClick = { panel = "settings" })
                            }
                            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 4.dp))
                        }
                    }
                },
                bottomBar = {
                    if (state.paired && state.selectedThreadId != null) Composer(state, actions, filesState, filesActions, composerHeight, compactViewport, onOptions = { panel = it })
                },
            ) { padding ->
                Column(Modifier.fillMaxSize().padding(padding)) {
                    state.error?.let { Notice(it, true) }
                    val pendingInteractions = state.interactions.count { it.status == "pending" }
                    if (pendingInteractions > 0) Surface(color = MaterialTheme.colorScheme.secondaryContainer) {
                        TextButton({ panel = "inspector"; inspectorTab = "output" }, Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("pending-interactions")) {
                            Text("$pendingInteractions 个请求等待处理 · 查看")
                        }
                    }
                    if (state.unknownWarning != null || state.unresolvedOperations.isNotEmpty()) {
                        Surface(color = MaterialTheme.colorScheme.errorContainer) {
                            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text("有操作结果尚未确认，发送已暂停", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onErrorContainer)
                                TextButton({ panel = "unknown" }, Modifier.testTag("unknown-recovery")) { Text("查看与对账", color = MaterialTheme.colorScheme.onErrorContainer) }
                            }
                        }
                    }
                    when {
                        !state.paired -> PairingForm(state, actions, Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp))
                        state.selectedThreadId == null -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.Center) {
                            Image(painterResource(R.drawable.oracle_eye_mark), null, Modifier.size(64.dp).padding(bottom = 16.dp))
                            Text("从一个想法开始", style = MaterialTheme.typography.headlineLarge)
                            Spacer(Modifier.height(12.dp))
                            Text(if (state.online) "打开项目与会话，继续你的工作。" else "离线时可阅读已缓存会话，草稿留在本机。", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.height(24.dp))
                            Button({ panel = "navigation" }, Modifier.heightIn(min = 48.dp).testTag("choose_thread")) { Text("打开项目与会话") }
                        }
                        else -> {
                            state.historyWarning?.let { Notice(it) }
                            Conversation(state, actions, Modifier.weight(1f))
                        }
                    }
                }
            }
            if (persistentInspector) {
                VerticalDivider()
                Surface(Modifier.width(360.dp).fillMaxHeight(), color = MaterialTheme.colorScheme.surfaceContainerLow) {
                    Column(Modifier.statusBarsPadding().navigationBarsPadding()) {
                        InspectorPanel(state, actions, inspectorTab, { inspectorTab = it }, filesState, filesActions, onClose = null)
                    }
                }
            }
        }
        if (panel != null) {
            val activePanel = panel!!
            SidePanel(fromLeft = activePanel == "navigation", onDismiss = { panel = null }) {
                when (activePanel) {
                    "navigation" -> NavigationPanel(state, actions, onDismiss = { panel = null }, onSettings = { panel = "settings" })
                    "inspector" -> InspectorPanel(state, actions, inspectorTab, { inspectorTab = it }, filesState, filesActions) { panel = null }
                    "settings" -> SettingsPanel(state, actions, notificationEnabled, onNotificationSettings) { panel = null }
                    "unknown" -> UnknownRecoveryPanel(state, actions) { panel = null }
                    "model" -> ModelPanel(state, actions) { panel = null }
                    "permission" -> PermissionPanel(state, actions) { panel = null }
                }
            }
        }
    }
}

@Composable
private fun SidePanel(fromLeft: Boolean, onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val view = LocalView.current
        val light = MaterialTheme.colorScheme.surface.luminance() > .5f
        SideEffect {
            (view.parent as? DialogWindowProvider)?.window?.let { window ->
                WindowCompat.getInsetsController(window, view).apply {
                    isAppearanceLightStatusBars = light
                    isAppearanceLightNavigationBars = light
                }
            }
        }
        BoxWithConstraints(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
            val panelWidth = (maxWidth * if (fromLeft) .88f else .94f).coerceAtMost(520.dp)
            Row(Modifier.fillMaxSize()) {
                if (!fromLeft) Box(Modifier.weight(1f).fillMaxHeight().clickable(onClick = onDismiss).semantics { contentDescription = "关闭面板" })
                Surface(Modifier.width(panelWidth).fillMaxHeight(), color = MaterialTheme.colorScheme.surfaceContainerLow,
                    shape = if (fromLeft) RoundedCornerShape(topEnd = 28.dp, bottomEnd = 28.dp) else RoundedCornerShape(topStart = 28.dp, bottomStart = 28.dp)) {
                    Column(Modifier.statusBarsPadding().navigationBarsPadding().imePadding(), content = content)
                }
                if (fromLeft) Box(Modifier.weight(1f).fillMaxHeight().clickable(onClick = onDismiss).semantics { contentDescription = "关闭面板" })
            }
        }
    }
}

@Composable
private fun PanelHeading(title: String, onClose: (() -> Unit)?) {
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, Modifier.weight(1f), style = MaterialTheme.typography.headlineSmall, maxLines = 2)
        if (onClose != null) GlyphButton("close", "关闭面板", "close-panel", onClick = onClose)
    }
}

@Composable
private fun PairingForm(state: PocUiState, actions: PocActions, modifier: Modifier) {
    var code by remember { mutableStateOf("") }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("连接你的 Gateway", style = MaterialTheme.typography.headlineSmall)
        Text("填写 HTTPS 地址，再输入主机 CLI 生成的一次性配对码。", color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(state.endpoint, actions.onEndpointChange, label = { Text("HTTPS 地址") },
            placeholder = { Text("https://gateway.example/") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), enabled = !state.busy,
            modifier = Modifier.fillMaxWidth().testTag("endpoint"), shape = RoundedCornerShape(16.dp))
        OutlinedTextField(code, { code = it }, label = { Text("一次性配对码") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(), enabled = !state.busy, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth().testTag("pair-code"), shape = RoundedCornerShape(16.dp))
        Button({ val pairingCode = code; code = ""; actions.onPair(pairingCode) }, enabled = !state.busy && state.endpoint.isNotBlank() && code.isNotBlank(),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("pair")) { Text("配对并连接") }
    }
}

@Composable
private fun ColumnScope.NavigationPanel(state: PocUiState, actions: PocActions, onDismiss: () -> Unit, onSettings: () -> Unit) {
    var filter by rememberSaveable { mutableStateOf("") }
    var registerOpen by rememberSaveable { mutableStateOf(false) }
    var relativePath by rememberSaveable { mutableStateOf("") }
    var rootId by remember(state.roots) { mutableStateOf(state.roots.firstOrNull()?.id.orEmpty()) }
    val canWrite = state.online && !state.busy && state.unknownWarning == null && state.unresolvedOperations.isEmpty()
    PanelHeading("工作区", onDismiss)
    Button({ actions.onCreateThread(); onDismiss() }, enabled = canWrite && state.selectedProjectId != null, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).heightIn(min = 48.dp).testTag("new-thread")) { Text("＋ 新建会话") }
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(filter, { filter = it }, placeholder = { Text("筛选已加载的项目与会话") }, singleLine = true,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("filter-navigation"), shape = RoundedCornerShape(24.dp))
    LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { SectionLabel("项目") }
        items(state.projects.filter { filter.isBlank() || it.label.contains(filter, true) || it.detail.contains(filter, true) }, key = { "project-${it.id}" }) { project ->
            NavigationRow(project.label, project.detail, project.id == state.selectedProjectId, "project-${project.id}", !state.busy) { actions.onSelectProject(project.id) }
        }
        if (state.projects.isEmpty()) item { MutedText("还没有注册的项目。") }
        item {
            TextButton({ registerOpen = !registerOpen }, enabled = canWrite, modifier = Modifier.fillMaxWidth().testTag("register_project")) { Text(if (registerOpen) "收起目录浏览" else "＋ 注册项目目录") }
        }
        if (registerOpen) item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                MutedText("仅浏览主机已授权的目录")
                state.roots.forEach { root ->
                    FilterChip(selected = rootId == root.id, onClick = { rootId = root.id; relativePath = ""; actions.onBrowseDirectory(root.id, "") }, label = { Text(root.label) }, modifier = Modifier.heightIn(min = 48.dp))
                }
                OutlinedTextField(relativePath, { relativePath = it }, label = { Text("根目录下的相对路径") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("project_path"))
                OutlinedButton({ actions.onBrowseDirectory(rootId, relativePath) }, enabled = state.online && !state.busy && rootId.isNotBlank(), modifier = Modifier.fillMaxWidth().testTag("browse-directories")) { Text("浏览目录") }
                if (state.directory.rootId == rootId) {
                    MutedText("当前目录：${state.directory.path.ifBlank { "/" }}")
                    if (state.directory.path.isNotBlank()) TextButton({ val parent = state.directory.path.substringBeforeLast('/', ""); relativePath = parent; actions.onBrowseDirectory(rootId, parent) }) { Text("返回上级目录") }
                    state.directory.entries.forEach { entry ->
                        TextButton({ relativePath = entry.path; actions.onBrowseDirectory(rootId, entry.path) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("▸ ${entry.name}", Modifier.fillMaxWidth()) }
                    }
                    if (state.directory.canLoadMore) OutlinedButton(actions.onLoadMoreDirectories, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("继续加载目录") }
                    if (state.directory.limited) MutedText("目录列表受限，只展示当前已加载部分。")
                }
                Button({ actions.onRegisterProject(rootId, relativePath); registerOpen = false }, enabled = canWrite && rootId.isNotBlank() && relativePath.isNotBlank(), modifier = Modifier.fillMaxWidth().testTag("confirm_register")) { Text("注册这个目录") }
            }
        }
        item { HorizontalDivider(Modifier.padding(vertical = 8.dp)); SectionLabel("会话") }
        items(state.threads.filter { filter.isBlank() || it.label.contains(filter, true) || it.detail.contains(filter, true) }, key = { "thread-${it.id}" }) { thread ->
            NavigationRow(thread.label, thread.detail, thread.id == state.selectedThreadId, "thread-${thread.id}", !state.busy) { actions.onSelectThread(thread.id); onDismiss() }
        }
        if (state.threads.isEmpty()) item { MutedText(if (state.selectedProjectId == null) "选择项目后查看会话。" else "还没有可用会话。") }
        if (state.canLoadMoreThreads) item { OutlinedButton(actions.onLoadMoreThreads, enabled = state.online && !state.busy, modifier = Modifier.fillMaxWidth().testTag("load-more-threads")) { Text("加载更多会话") } }
        item { MutedText("筛选仅覆盖当前已加载列表。") }
        item { TextButton(actions.onRefresh, enabled = state.online && !state.busy, modifier = Modifier.fillMaxWidth()) { Text("刷新列表") } }
    }
    HorizontalDivider()
    TextButton(onSettings, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) { Text("设置与连接") }
}

@Composable
private fun NavigationRow(title: String, detail: String, selected: Boolean, tag: String, enabled: Boolean, onClick: () -> Unit) {
    Surface(onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag(tag).semantics { this.selected = selected },
        color = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainerLow, shape = RoundedCornerShape(16.dp)) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleSmall, color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
            if (detail.isNotBlank()) Text(detail, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun Conversation(state: PocUiState, actions: PocActions, modifier: Modifier) {
    val headerCount = if (state.canLoadMore) 1 else 0
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = state.readIndex.coerceAtLeast(0) + headerCount, initialFirstVisibleItemScrollOffset = state.readOffset.coerceAtLeast(0))
    var restoredThread by remember { mutableStateOf<String?>(null) }
    val followingEnd by remember { derivedStateOf {
        val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
        lastVisible >= listState.layoutInfo.totalItemsCount - 2
    } }
    LaunchedEffect(state.messages.lastOrNull()?.text, state.interactions.size) {
        if (restoredThread == state.selectedThreadId && followingEnd && state.messages.isNotEmpty()) {
            listState.scrollToItem((headerCount + state.messages.size + state.interactions.size - 1).coerceAtLeast(0))
        }
    }
    LaunchedEffect(state.selectedThreadId, state.messages.isEmpty()) {
        if (state.messages.isNotEmpty() && restoredThread != state.selectedThreadId) {
            listState.scrollToItem(state.readIndex.coerceIn(0, state.messages.lastIndex) + headerCount, state.readOffset.coerceAtLeast(0))
            restoredThread = state.selectedThreadId
        }
    }
    LaunchedEffect(listState, state.selectedThreadId, headerCount) {
        snapshotFlow { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }.distinctUntilChanged().collect { (index, offset) ->
            if (restoredThread == state.selectedThreadId) actions.onReadPosition((index - headerCount).coerceAtLeast(0), if (index < headerCount) 0 else offset)
        }
    }
    LazyColumn(modifier.fillMaxWidth().testTag("conversation"), state = listState, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        if (state.canLoadMore) item(key = "history_controls") {
            OutlinedButton(actions.onLoadMore, enabled = state.online && !state.busy, modifier = Modifier.fillMaxWidth().testTag("load-more")) { Text("加载更早历史") }
        }
        if (state.messages.isEmpty()) item(key = "empty") {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("准备就绪", style = MaterialTheme.typography.headlineSmall)
                MutedText(if (state.online) "描述你想完成的工作。只有点击发送才会开始执行。" else "还没有缓存消息。联网后读取原生历史；草稿可以继续编辑。")
            }
        }
        items(state.messages, key = { it.id }) { message ->
            val process = message.role !in listOf("user", "assistant")
            var expanded by rememberSaveable(message.id) { mutableStateOf(false) }
            Card(colors = CardDefaults.cardColors(containerColor = if (message.role == "user") MaterialTheme.colorScheme.surfaceContainerLow else MaterialTheme.colorScheme.surfaceContainer),
                modifier = Modifier.fillMaxWidth().testTag("message_${message.id}"), shape = RoundedCornerShape(24.dp)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (message.role == "assistant") {
                            Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primaryContainer) {
                                Image(painterResource(R.drawable.oracle_eye_mark), null, Modifier.size(32.dp).padding(7.dp))
                            }
                            Spacer(Modifier.width(10.dp))
                        }
                        if (message.role == "user") {
                            Surface(shape = CircleShape, color = MaterialTheme.colorScheme.secondaryContainer) {
                                Box(Modifier.size(32.dp), contentAlignment = Alignment.Center) {
                                    Text(state.userLabel.take(1), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSecondaryContainer)
                                }
                            }
                            Spacer(Modifier.width(10.dp))
                        }
                        Text(when (message.role) { "user" -> state.userLabel; "assistant" -> state.assistantLabel; else -> message.role },
                            color = if (process) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                            style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                        if (message.status.isNotBlank()) Text(message.status, Modifier.padding(start = 8.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (process) TextButton({ expanded = !expanded }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(if (expanded) "收起执行内容" else "查看执行内容") }
                    if (!process || expanded) MarkdownContent(message.text)
                    if (message.detailsRequired) OutlinedButton({ actions.onLoadItemDetail(message.turnId, message.id) }, enabled = state.online && !state.busy,
                        modifier = Modifier.fillMaxWidth().testTag("detail-${message.id}")) { Text("读取完整 Item 详情") }
                }
            }
        }
        items(state.interactions, key = { "interaction-${it.id}" }) { interaction ->
            NativeInteractionPanel(interaction, state.online && !state.busy && state.unknownWarning == null) { response -> actions.onRespondInteraction(interaction.id, response) }
        }
    }
}

@Composable
private fun Composer(state: PocUiState, actions: PocActions, filesState: FilesUiState, filesActions: FilesActions,
    maximumHeight: Dp, compact: Boolean, onOptions: (String) -> Unit) {
    Column(Modifier.navigationBarsPadding().imePadding().padding(horizontal = 12.dp, vertical = 6.dp)) {
        Surface(shape = RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
            Column(Modifier.heightIn(max = maximumHeight).padding(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                // Only the content area scrolls; send/stop remain outside it in a 48dp toolbar.
                Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                    if (!compact && state.executionLabel.isNotBlank()) Text(state.executionLabel, Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
                    OutlinedTextField(state.draft, actions.onDraftChange,
                        placeholder = { Text(if (state.online) "给 Codex 发送消息…" else "离线草稿 · 联网后手动发送") },
                        minLines = if (compact) 1 else 2, maxLines = if (compact) 3 else 5,
                        modifier = Modifier.fillMaxWidth().testTag("draft"), shape = RoundedCornerShape(20.dp),
                        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Color.Transparent, unfocusedBorderColor = Color.Transparent))
                    if (filesState.attachments.isNotEmpty() || filesState.hasUnknown) {
                        AttachmentChips(filesState, filesActions, compact = true)
                        if (state.draft.isBlank()) MutedText("添加文字说明后发送附件。")
                    }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
                    AttachmentPickerButton(filesState, filesActions)
                    TextButton({ onOptions("permission") }, modifier = Modifier.heightIn(min = 48.dp).widthIn(max = 92.dp).testTag("permission-picker")) {
                        Text(when (state.permissionPreset) { "full-access" -> "Full"; "auto" -> "Auto"; else -> "只读" }, maxLines = 1)
                    }
                    TextButton({ onOptions("model") }, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("model-picker")) {
                        Text(listOfNotNull(state.models.firstOrNull { it.id == state.selectedModel }?.label ?: state.selectedModel ?: "模型", state.selectedEffort).joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (state.canResume) TextButton(actions.onResume, enabled = state.online && !state.busy, modifier = Modifier.heightIn(min = 48.dp).testTag("resume")) { Text("恢复", maxLines = 1) }
                    if (state.canStop) FilledTonalIconButton(actions.onStop, enabled = state.online, modifier = Modifier.size(48.dp).testTag("stop").semantics { contentDescription = "停止执行" }) { Glyph("close", MaterialTheme.colorScheme.onSurface) }
                    else FilledIconButton(actions.onSend, enabled = state.canSend && state.online && state.draft.isNotBlank(), modifier = Modifier.size(48.dp).testTag("send").semantics { contentDescription = "发送消息" }) { Glyph("send", MaterialTheme.colorScheme.onPrimary) }
                }
            }
        }
    }
}

@Composable
private fun ColumnScope.ModelPanel(state: PocUiState, actions: PocActions, onClose: () -> Unit) {
    PanelHeading("模型与思考强度", onClose)
    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        MutedText("设置用于下一次执行，选项来自 Gateway 的可用模型。")
        Text("当前原生模型：${state.actualModel ?: "尚未确认"} · ${state.actualEffort ?: "默认思考强度"}", style = MaterialTheme.typography.bodySmall)
        if (state.models.isEmpty()) MutedText("尚未取得可用模型。连接后刷新状态。")
        state.models.forEach { model ->
            NavigationRow(model.label, model.description, state.selectedModel == model.id, "model-${model.id}", !state.busy) { actions.onSelectModel(model.id) }
        }
        state.models.firstOrNull { it.id == state.selectedModel }?.let { model ->
            HorizontalDivider(); SectionLabel("思考强度")
            model.efforts.forEach { effort ->
                NavigationRow(effort, "", state.selectedEffort == effort, "effort-$effort", !state.busy) { actions.onSelectEffort(effort) }
            }
            if (model.efforts.isEmpty()) MutedText("此模型未提供可选思考强度。")
        }
    }
}

@Composable
private fun ColumnScope.PermissionPanel(state: PocUiState, actions: PocActions, onClose: () -> Unit) {
    var confirmFull by remember { mutableStateOf(false) }
    PanelHeading("执行权限", onClose)
    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        MutedText("以下选择用于下一次执行；不会改写主机默认配置。")
        state.permissionReadback?.let { readback ->
            Text("最近原生回读", style = MaterialTheme.typography.titleSmall)
            Text("来源：${readback.source}\n时间：${DateFormat.getDateTimeInstance().format(Date(readback.observedAt))}\n沙箱：${readback.sandboxType}\n审批策略：${readback.approvalPolicy}\n预设映射：${readback.preset ?: "自定义/未映射"}", style = MaterialTheme.typography.bodySmall)
        } ?: Text("无有效回读，当前权限未知", style = MaterialTheme.typography.bodySmall)
        NavigationRow("Read only", "只读沙箱；写入和受限操作仍遵循原生审批。", state.permissionPreset == "read-only", "permission-read-only", !state.busy) { actions.onSelectPermission("read-only", false) }
        NavigationRow("Auto", "允许在工作区内写入；需要提升权限的操作交由原生审批。", state.permissionPreset == "auto", "permission-auto", !state.busy) { actions.onSelectPermission("auto", false) }
        NavigationRow("Full access", "取消沙箱限制，可能修改工作区以外文件并访问网络。", state.permissionPreset == "full-access", "permission-full-access", !state.busy) { confirmFull = true }
    }
    if (confirmFull) AlertDialog(onDismissRequest = { confirmFull = false }, title = { Text("启用 Full access？") },
        text = { Text("下一次执行将使用完整主机权限，且可能无需逐次审批。请仅对你信任的任务启用。") },
        confirmButton = { TextButton({ actions.onSelectPermission("full-access", true); confirmFull = false }, Modifier.testTag("confirm-full-access")) { Text("确认启用") } },
        dismissButton = { TextButton({ confirmFull = false }) { Text("取消") } })
}

@Composable
private fun ColumnScope.InspectorPanel(state: PocUiState, actions: PocActions, tab: String, onTab: (String) -> Unit,
    filesState: FilesUiState, filesActions: FilesActions, onClose: (() -> Unit)?) {
    PanelHeading("Inspector", onClose)
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf("diff" to "Diff", "output" to "输出", "files" to "文件", "usage" to "用量", "extensions" to "扩展").forEach { (id, label) ->
            FilterChip(selected = id == tab, onClick = { onTab(id) }, label = { Text(label) }, modifier = Modifier.heightIn(min = 48.dp).testTag("inspector-$id"))
        }
    }
    HorizontalDivider(Modifier.padding(top = 8.dp))
    if (tab == "files") {
        Box(Modifier.weight(1f).fillMaxWidth()) { FilesPanel(filesState, filesActions) }
    } else {
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (tab == "diff") {
                SectionLabel("当前原生 Diff")
                state.inspector.diff?.takeIf { it.isNotBlank() }?.let { DiffContent(it) } ?: MutedText("此会话尚无可用 Diff。")
            }
            if (tab == "output") {
                SectionLabel("执行状态")
                Text(state.executionLabel.ifBlank { "尚无正在执行的 Turn" })
                if (state.interactions.isNotEmpty()) {
                    SectionLabel("等待你的处理")
                    state.interactions.forEach { interaction -> NativeInteractionPanel(interaction, state.online && !state.busy && state.unknownWarning == null) { actions.onRespondInteraction(interaction.id, it) } }
                }
                if (state.inspector.plan.isNotEmpty()) { SectionLabel("原生 Plan 更新"); state.inspector.plan.forEach { InspectorEntryCard(it, state, actions) } }
                if (state.inspector.execution.isEmpty()) MutedText("尚无已加载的工具执行记录。")
                state.inspector.execution.forEach { InspectorEntryCard(it, state, actions) }
                if (state.inspector.agents.isNotEmpty()) { SectionLabel("子代理活动"); state.inspector.agents.forEach { InspectorEntryCard(it, state, actions) } }
            }
            if (tab == "usage") {
                SectionLabel("会话用量")
                state.inspector.usage?.let { CodeBlock(it, "原生用量") } ?: MutedText("当前原生状态尚未提供 token / 上下文用量。")
                MutedText("账户额度未由当前 Gateway 公开。")
            }
            if (tab == "extensions") {
                SectionLabel("受支持的扩展")
                if (state.inspector.extensions.isEmpty()) MutedText("尚未获取扩展状态。刷新后显示 Gateway 支持的只读信息。")
                state.inspector.extensions.forEach { section ->
                    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainer) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(section.kind, style = MaterialTheme.typography.titleMedium)
                            MutedText(section.status)
                            section.reason?.let { MutedText(it) }
                            section.entries.forEach { entry -> Text(entry.title, fontWeight = FontWeight.Medium); if (entry.body.isNotBlank()) MutedText(entry.body) }
                            if (section.entries.isEmpty() && section.status == "available") MutedText("没有返回可显示条目。")
                            if (section.limited) MutedText("当前结果受限，并非完整清单。")
                        }
                    }
                }
                state.inspector.limitations.forEach { MutedText(it) }
            }
            state.inspector.detailTitle?.let { title ->
                HorizontalDivider(); SectionLabel(title)
                state.inspector.detailProgress?.let { MutedText(it) }
                state.inspector.detailText?.let { CodeBlock(it, "完整 Item") }
            }
            OutlinedButton(actions.onRefreshInspector, enabled = state.online && !state.busy, modifier = Modifier.fillMaxWidth().testTag("refresh-inspector")) { Text("刷新真实状态") }
        }
    }
}

@Composable
private fun InspectorEntryCard(entry: InspectorEntry, state: PocUiState, actions: PocActions) {
    var expanded by rememberSaveable(entry.id) { mutableStateOf(false) }
    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton({ expanded = !expanded }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Column(Modifier.fillMaxWidth()) { Text(entry.title, fontWeight = FontWeight.SemiBold); if (entry.status.isNotBlank()) MutedText(entry.status) }
            }
            if (expanded) {
                MarkdownContent(entry.body)
                if (entry.detailsRequired) OutlinedButton({ actions.onLoadItemDetail(entry.turnId, entry.itemId) }, enabled = state.online && !state.busy, modifier = Modifier.fillMaxWidth()) { Text("读取完整详情") }
            }
        }
    }
}

@Composable
private fun DiffContent(diff: String) {
    ReadingContent {
        val dark = MaterialTheme.colorScheme.background.red < .3f
        Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = RoundedCornerShape(16.dp)) {
            SelectionContainer {
                Column(Modifier.horizontalScroll(rememberScrollState()).padding(12.dp).semantics { contentDescription = "Diff，可横向滚动；加号表示新增，减号表示删除" }) {
                    diff.lines().forEach { line ->
                        val added = line.startsWith('+') && !line.startsWith("+++")
                        val removed = line.startsWith('-') && !line.startsWith("---")
                        val color = when { added -> if (dark) Color(0xFFB8E986) else Color(0xFF315500); removed -> if (dark) Color(0xFFFCA5A5) else Color(0xFF9A2424); else -> MaterialTheme.colorScheme.onSurface }
                        Text(line, Modifier.fillMaxWidth().background(when { added -> Color(0xFF74A12E).copy(alpha = .18f); removed -> Color(0xFFEF4444).copy(alpha = .14f); else -> Color.Transparent }).padding(horizontal = 4.dp, vertical = 2.dp),
                            color = color, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, softWrap = false)
                    }
                }
            }
        }
    }
}

@Composable
private fun ColumnScope.SettingsPanel(state: PocUiState, actions: PocActions, notificationEnabled: Boolean, onNotifications: () -> Unit, onClose: () -> Unit) {
    var clearCacheOpen by remember { mutableStateOf(false) }
    var userLabel by remember(state.userLabel) { mutableStateOf(state.userLabel) }
    var assistantLabel by remember(state.assistantLabel) { mutableStateOf(state.assistantLabel) }
    var readingScale by remember(state.readingScale) { mutableFloatStateOf(state.readingScale) }
    PanelHeading("设置", onClose)
    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        SectionLabel("外观")
        listOf("light" to "Light · 浅色", "dark" to "Dark · 抹茶暗色", "oled" to "OLED Dark · 纯黑").forEach { (mode, label) ->
            NavigationRow(label, "", state.themeMode == mode, "theme-$mode", true) { actions.onThemeChange(mode) }
        }
        Text("消息与代码字号 · ${(readingScale * 100).toInt()}%", style = MaterialTheme.typography.titleSmall)
        Slider(readingScale, { readingScale = it }, valueRange = .85f..1.4f, steps = 10,
            onValueChangeFinished = { actions.onReadingScaleChange(readingScale) },
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("reading-scale").semantics { contentDescription = "阅读字号" })
        MutedText("仅调整消息与代码阅读字号；其余控件遵循 Android 系统字体缩放。偏好仅保存在本机。")
        HorizontalDivider()
        SectionLabel("称呼与身份")
        OutlinedTextField(userLabel, { if (it.length <= 40) userLabel = it }, label = { Text("你的称呼") }, singleLine = true,
            modifier = Modifier.fillMaxWidth().testTag("identity-user"))
        OutlinedTextField(assistantLabel, { if (it.length <= 40) assistantLabel = it }, label = { Text("助手称呼") }, singleLine = true,
            modifier = Modifier.fillMaxWidth().testTag("identity-assistant"))
        Button({ actions.onIdentityLabelsChange(userLabel, assistantLabel) }, enabled = userLabel.isNotBlank() && assistantLabel.isNotBlank(),
            modifier = Modifier.fillMaxWidth().testTag("identity-save")) { Text("保存称呼") }
        MutedText("称呼仅用于本机显示，不改变 Codex 身份或发送给模型。")
        HorizontalDivider()
        SectionLabel("通知")
        Text(if (notificationEnabled) "系统通知已开启" else "系统通知尚未开启")
        OutlinedButton(onNotifications, Modifier.fillMaxWidth().testTag("notification-settings")) { Text(if (notificationEnabled) "管理通知" else "开启系统通知") }
        MutedText("应用在前台或按 Home 后进程与连接仍存活时，可提醒执行完成、审批和错误。进程回收、强制停止或系统省电限制后不能保证送达；回到应用会重新读取真实状态。")
        HorizontalDivider()
        SectionLabel("Gateway 连接")
        SelectionContainer { Text(state.endpoint.ifBlank { "尚未设置 HTTPS 地址" }, style = MaterialTheme.typography.bodySmall) }
        Text(state.connectionLabel)
        if (!state.online && !state.busy) OutlinedTextField(state.endpoint, actions.onEndpointChange, label = { Text("HTTPS 地址") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), modifier = Modifier.fillMaxWidth().testTag("settings-endpoint"))
        if (state.paired) {
            OutlinedButton(actions.onReconnect, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("重新连接") }
            OutlinedButton(actions.onRefresh, enabled = state.online && !state.busy, modifier = Modifier.fillMaxWidth()) { Text("刷新原生状态") }
            OutlinedButton({ clearCacheOpen = true }, enabled = !state.busy, modifier = Modifier.fillMaxWidth().testTag("clear-cache")) { Text("清理可重建历史缓存") }
            TextButton(actions.onDisconnect, modifier = Modifier.fillMaxWidth()) { Text("断开连接") }
        } else MutedText("使用主机 CLI 生成的一次性配对码。设备凭据仅保存在本机安全存储。")
    }
    if (clearCacheOpen) AlertDialog(onDismissRequest = { clearCacheOpen = false }, title = { Text("清理历史缓存？") },
        text = { Text("项目、会话和消息缓存可以联网重建。未发送草稿、发送回执与未知操作记录将保留。") },
        confirmButton = { TextButton({ actions.onClearCache(); clearCacheOpen = false }, Modifier.testTag("confirm-clear-cache")) { Text("清理缓存") } },
        dismissButton = { TextButton({ clearCacheOpen = false }) { Text("取消") } })
}

@Composable
private fun ColumnScope.UnknownRecoveryPanel(state: PocUiState, actions: PocActions, onClose: () -> Unit) {
    PanelHeading("操作结果待确认", onClose)
    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("请求可能已经到达 Codex。为避免重复执行，确认结果前会保留发送屏障。", style = MaterialTheme.typography.bodyLarge)
        state.unknownWarning?.let { MutedText(it) }
        state.operationStatusMessage?.let { Notice(it) }
        if (state.unresolvedOperations.isEmpty()) MutedText("当前摘要未包含操作详情。请恢复连接并刷新原生状态。")
        state.unresolvedOperations.forEach { operation ->
            Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = RoundedCornerShape(20.dp)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(operation.kind, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
                    val project = state.projects.firstOrNull { it.id == operation.projectId }
                    val thread = state.threads.firstOrNull { it.id == operation.threadId }
                    Text("项目：${project?.label ?: operation.projectId}")
                    Text("会话：${thread?.label ?: operation.threadId ?: "尚未确认"}")
                    SelectionContainer {
                        Text("operationId：${operation.operationId}\n创建时间：${DateFormat.getDateTimeInstance().format(Date(operation.createdAt))}\n最后状态：${operation.status}\n投递状态：${operation.delivery}", style = MaterialTheme.typography.bodySmall)
                    }
                    operation.nativeTurnId?.let { MutedText("原生 Turn：$it") }
                    Text("影响范围：${if (operation.threadId == null) "此项目及关联操作" else "此会话及关联操作"}", style = MaterialTheme.typography.bodySmall)
                    OutlinedButton({ actions.onQueryOperation(operation.operationId) }, enabled = state.online && !state.busy,
                        modifier = Modifier.fillMaxWidth().testTag("query-operation-${operation.operationId}")) { Text("查询原回执") }
                    OutlinedButton({ actions.onRefreshOperationThread(operation.operationId) }, enabled = state.online && !state.busy,
                        modifier = Modifier.fillMaxWidth().testTag("refresh-operation-${operation.operationId}")) { Text("只读刷新原生线程") }
                    if (state.canStop && operation.threadId == state.selectedThreadId) OutlinedButton(actions.onStop, enabled = state.online,
                        modifier = Modifier.fillMaxWidth().testTag("unknown-stop")) { Text("停止已确认的活动 Turn") }
                }
            }
        }
        MutedText("只有 Gateway / Codex 的事实能确认接受或拒绝。404、无回执、断网和清理缓存都不表示请求未发送。")
        MutedText("若仍无法确认，请在主机侧检查对应原生线程、Turn 和 Gateway 回执；保留 operationId 供人工核查。不要重新配对、重新注册或换设备重发同一请求。")
        OutlinedButton(actions.onRefresh, enabled = state.online && !state.busy, modifier = Modifier.fillMaxWidth()) { Text("刷新可读状态") }
    }
}

@Composable
private fun Notice(text: String, isError: Boolean = false) {
    Surface(color = if (isError) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surfaceContainerHigh) {
        SelectionContainer {
            Text(text, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), color = if (isError) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun SectionLabel(text: String) { Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary) }

@Composable
private fun MutedText(text: String) { Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }

@Composable
private fun GlyphButton(kind: String, description: String, tag: String, onClick: () -> Unit) {
    IconButton(onClick, Modifier.size(48.dp).testTag(tag).semantics { contentDescription = description }) {
        Glyph(kind, MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Small native vector marks; no network font or additional icon dependency. */
@Composable
private fun Glyph(kind: String, color: Color) {
    Canvas(Modifier.size(24.dp)) {
        val u = size.width / 24f
        fun line(x1: Float, y1: Float, x2: Float, y2: Float) = drawLine(color, Offset(x1 * u, y1 * u), Offset(x2 * u, y2 * u), 1.8f * u)
        when (kind) {
            "close" -> { line(6f, 6f, 18f, 18f); line(18f, 6f, 6f, 18f) }
            "send" -> { line(12f, 20f, 12f, 4f); line(5f, 11f, 12f, 4f); line(12f, 4f, 19f, 11f) }
            "settings" -> {
                drawCircle(color, radius = 7f * u, style = Stroke(1.8f * u)); drawCircle(color, radius = 2.5f * u, style = Stroke(1.8f * u))
                line(12f, 2f, 12f, 5f); line(12f, 19f, 12f, 22f); line(2f, 12f, 5f, 12f); line(19f, 12f, 22f, 12f)
            }
            else -> {
                val path = Path().apply { moveTo(4f * u, 4f * u); lineTo(20f * u, 4f * u); lineTo(20f * u, 20f * u); lineTo(4f * u, 20f * u); close() }
                drawPath(path, color, style = Stroke(1.8f * u)); line(14f, 4f, 14f, 20f)
            }
        }
    }
}
