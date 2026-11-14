@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class, androidx.compose.material3.ExperimentalMaterial3Api::class)

package dev.oraculum.poc.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.oraculum.poc.repository.boundedContentPreview
import dev.oraculum.poc.repository.CONTENT_PREVIEW_NOTICE
import dev.oraculum.poc.files.AttachmentChips
import dev.oraculum.poc.files.FileTransferPolicy
import dev.oraculum.poc.files.FilesActions
import dev.oraculum.poc.files.FilesPanel
import dev.oraculum.poc.files.FilesUiState
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
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
        val sheetMaximumHeight = maxHeight * .9f
        val persistentInspector = maxWidth >= 1000.dp && state.paired && state.selectedThreadId != null
        Row(Modifier.fillMaxSize()) {
            Scaffold(modifier = Modifier.weight(1f), containerColor = MaterialTheme.colorScheme.background,
                topBar = {
                    Surface(color = MaterialTheme.colorScheme.background) {
                        Column(Modifier.statusBarsPadding().padding(horizontal = 12.dp, vertical = 6.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                IconButton(onClick = { panel = "navigation" },
                                    modifier = Modifier.size(48.dp).testTag("navigation").semantics { contentDescription = "打开项目与会话导航" }) {
                                    Surface(shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainerHigh,
                                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.35f))) {
                                        OracleEyeMark(modifier = Modifier.padding(10.dp), size = 24.dp)
                                    }
                                }
                                Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                                    Text(selectedThread?.label ?: "神谕 · Oraculum", maxLines = 1, overflow = TextOverflow.Ellipsis,
                                        style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                        if (state.paired) Box(Modifier.size(6.dp).background(if (state.online) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.outline, CircleShape)
                                            .semantics { contentDescription = if (state.online) "已连接" else "离线" })
                                        Text(selectedProject?.label ?: "你的 Codex 助手", maxLines = 1, overflow = TextOverflow.Ellipsis,
                                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                }
                                if (state.paired) GlyphButton("inspector", "打开 Inspector", "inspector", onClick = { panel = "inspector"; actions.onRefreshInspector() })
                            }
                            if (state.paired && !state.online) Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 12.dp)) {
                                OraculumIcon(OraculumSymbol.WifiOff, tint = MaterialTheme.colorScheme.onSurfaceVariant, size = 16.dp)
                                Text("连接已断开 · 草稿已保留", Modifier.padding(start = 8.dp).weight(1f), style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                                TextButton(actions.onReconnect, enabled = !state.busy, modifier = Modifier.testTag("reconnect")) { Text("重连") }
                            }
                            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 4.dp))
                        }
                    }
                },
                bottomBar = {
                    if (state.paired && state.selectedThreadId != null) Composer(state, actions, filesState, filesActions, composerHeight, compactViewport)
                },
            ) { padding ->
                Column(Modifier.fillMaxSize().padding(padding)) {
                    state.error?.let { Notice(it, true) }
                    state.operationStatusMessage?.let { Notice(it) }
                    val pendingInteractions = state.interactions.count { it.status == "pending" }
                    if (pendingInteractions > 0) Surface(color = MaterialTheme.colorScheme.secondaryContainer) {
                        TextButton({ panel = "approval" }, Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("pending-interactions")) {
                            Text("$pendingInteractions 个请求等待处理 · 查看")
                        }
                    }
                    // A durably reserved write is briefly unresolved while its request is in flight.
                    // Its write gate remains closed; reserve the recovery alarm for a settled unknown.
                    if (!state.busy && (state.unknownWarning != null || state.unresolvedOperations.isNotEmpty())) {
                        Surface(color = MaterialTheme.colorScheme.errorContainer) {
                            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(if (state.unknownWarning != null) "此会话有操作待确认，暂不能发送" else "其他操作有待确认结果", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onErrorContainer)
                                TextButton({ panel = "unknown" }, Modifier.testTag("unknown-recovery")) { Text("查看与对账", color = MaterialTheme.colorScheme.onErrorContainer) }
                            }
                        }
                    }
                    when {
                        !state.paired -> PairingForm(state, actions, Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp))
                        state.selectedThreadId == null -> EmptyConversation(state, Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                            Button({ panel = "navigation" }, Modifier.heightIn(min = 48.dp).testTag("choose_thread")) { Text("打开项目与会话") }
                        }
                        else -> {
                            state.historyWarning?.takeUnless(::isNormalEmptyHistoryNotice)?.let { Notice(it) }
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
            if (activePanel in setOf("model", "permission", "approval")) {
                ModalBottomSheet(onDismissRequest = { panel = null }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
                    containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
                    modifier = Modifier.semantics { testTagsAsResourceId = true }.testTag("$activePanel-sheet")) {
                    Column(Modifier.fillMaxWidth().heightIn(max = sheetMaximumHeight).imePadding()) {
                        when (activePanel) {
                            "model" -> ModelPanel(state, actions) { panel = null }
                            "permission" -> PermissionPanel(state, actions) { panel = null }
                            else -> {
                                PanelHeading("待处理请求") { panel = null }
                                Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                    state.interactions.filter { it.status != "resolved" }.forEach { interaction ->
                                        NativeInteractionPanel(interaction, state.online && !state.busy && state.unknownWarning == null,
                                            onApproveFileChange = { response, digest -> actions.onRespondFileChange(interaction.id, response, digest) }) { response -> actions.onRespondInteraction(interaction.id, response) }
                                    }
                                    if (state.interactions.none { it.status != "resolved" }) MutedText("当前没有待处理请求。")
                                }
                            }
                        }
                    }
                }
            } else SidePanel(fromLeft = activePanel == "navigation", onDismiss = { panel = null }) {
                when (activePanel) {
                    "navigation" -> NavigationPanel(state, actions, onDismiss = { panel = null }, onSettings = { panel = "settings" })
                    "inspector" -> InspectorPanel(state, actions, inspectorTab, { inspectorTab = it }, filesState, filesActions) { panel = null }
                    "settings" -> SettingsPanel(state, actions, notificationEnabled, onNotificationSettings) { panel = null }
                    "unknown" -> UnknownRecoveryPanel(state, actions) { panel = null }
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
internal fun PanelHeading(title: String, onClose: (() -> Unit)?) {
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleLarge, maxLines = 2)
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
    var searchOpen by rememberSaveable { mutableStateOf(false) }
    var projectsExpanded by rememberSaveable { mutableStateOf(true) }
    var threadsExpanded by rememberSaveable { mutableStateOf(true) }
    val activeThreads = state.threads.filterNot { it.archived }
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 12.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        OracleEyeMark(size = 28.dp)
        Column(Modifier.weight(1f).padding(start = 12.dp)) {
            Text("神谕", style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
            Text("Oraculum", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        IconButton({ searchOpen = !searchOpen; if (!searchOpen) filter = "" }, Modifier.size(48.dp).testTag("toggle-navigation-search")) {
            OraculumIcon(OraculumSymbol.Search, "筛选已加载的项目与会话", size = 24.dp)
        }
        GlyphButton("close", "关闭面板", "close-panel", onDismiss)
    }
    if (searchOpen) {
        Surface(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                OraculumIcon(OraculumSymbol.Search, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                BasicTextField(filter, { filter = it }, singleLine = true,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = androidx.compose.ui.graphics.SolidColor(MaterialTheme.colorScheme.primary),
                    modifier = Modifier.weight(1f).heightIn(min = 48.dp).padding(horizontal = 8.dp).testTag("filter-navigation").semantics { contentDescription = "筛选已加载的项目与会话" },
                    decorationBox = { field -> Box(contentAlignment = Alignment.CenterStart) { if (filter.isEmpty()) Text("筛选已加载列表", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant); field() } })
                IconButton({ filter = ""; searchOpen = false }, Modifier.size(48.dp)) { OraculumIcon(OraculumSymbol.Close, "关闭筛选") }
            }
        }
    }
    LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("navigation-list"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        item(key = "projects-heading") {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                NavigationSectionToggle("项目", projectsExpanded, "navigation-projects-toggle", Modifier.weight(1f)) { projectsExpanded = !projectsExpanded }
                IconButton({ projectsExpanded = true; registerOpen = !registerOpen }, enabled = canWrite,
                    modifier = Modifier.size(48.dp).testTag("register_project")) {
                    OraculumIcon(OraculumSymbol.Folder, if (registerOpen) "收起目录浏览" else "注册项目目录", size = 20.dp)
                }
            }
        }
        if (projectsExpanded) {
            items(state.projects.filter { filter.isBlank() || it.label.contains(filter, true) || it.detail.contains(filter, true) }, key = { "project-${it.id}" }) { project ->
                NavigationRow(project.label, project.detail, project.id == state.selectedProjectId, "project-${project.id}", !state.busy, symbol = OraculumSymbol.Folder, detailMaxLines = 1) { actions.onSelectProject(project.id) }
            }
            if (state.projects.isEmpty()) item { MutedText("暂无项目") }
            if (registerOpen) item(key = "register-project-form") {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    MutedText("浏览已授权目录")
                    state.roots.forEach { root ->
                        FilterChip(selected = rootId == root.id, onClick = { rootId = root.id; relativePath = ""; actions.onBrowseDirectory(root.id, "") }, label = { Text(root.label) }, modifier = Modifier.heightIn(min = 48.dp))
                    }
                    OutlinedTextField(relativePath, { relativePath = it }, label = { Text("相对路径") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("project_path"))
                    OutlinedButton({ actions.onBrowseDirectory(rootId, relativePath) }, enabled = state.online && !state.busy && rootId.isNotBlank(), modifier = Modifier.fillMaxWidth().testTag("browse-directories")) { Text("浏览目录") }
                    if (state.directory.rootId == rootId) {
                        MutedText("当前目录：${state.directory.path.ifBlank { "/" }}")
                        if (state.directory.path.isNotBlank()) TextButton({ val parent = state.directory.path.substringBeforeLast('/', ""); relativePath = parent; actions.onBrowseDirectory(rootId, parent) }) { Text("返回上级") }
                        state.directory.entries.forEach { entry ->
                            TextButton({ relativePath = entry.path; actions.onBrowseDirectory(rootId, entry.path) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { OraculumIcon(OraculumSymbol.Folder); Spacer(Modifier.width(8.dp)); Text(entry.name, Modifier.weight(1f)); OraculumIcon(OraculumSymbol.ChevronRight) }
                        }
                        if (state.directory.canLoadMore) OutlinedButton(actions.onLoadMoreDirectories, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("加载更多") }
                        if (state.directory.limited) MutedText("目录清单可能不完整")
                    }
                    Button({ actions.onRegisterProject(rootId, relativePath); registerOpen = false }, enabled = canWrite && rootId.isNotBlank() && relativePath.isNotBlank(), modifier = Modifier.fillMaxWidth().testTag("confirm_register")) { Text("注册目录") }
                }
            }
        }
        item(key = "threads-heading") {
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                NavigationSectionToggle("会话", threadsExpanded, "navigation-threads-toggle", Modifier.weight(1f)) { threadsExpanded = !threadsExpanded }
                IconButton({ actions.onCreateThread(); onDismiss() }, enabled = state.canCreateThread,
                    modifier = Modifier.size(48.dp).testTag("new-thread")) { OraculumIcon(OraculumSymbol.Add, "新建会话", size = 20.dp) }
                IconButton(actions.onRefresh, enabled = state.online && !state.busy,
                    modifier = Modifier.size(48.dp).testTag("refresh-navigation")) { OraculumIcon(OraculumSymbol.Refresh, "刷新项目与会话", size = 20.dp) }
            }
        }
        if (threadsExpanded) {
            items(activeThreads.filter { filter.isBlank() || it.label.contains(filter, true) || it.detail.contains(filter, true) }, key = { "thread-${it.id}" }) { thread ->
                NativeThreadRow(thread, state, actions) { actions.onSelectThread(thread.id); onDismiss() }
            }
            if (activeThreads.isEmpty()) item { MutedText(if (state.selectedProjectId == null) "选择项目后查看会话" else "暂无会话") }
            if (state.canLoadMoreThreads) item { OutlinedButton(actions.onLoadMoreThreads, enabled = state.online && !state.busy, modifier = Modifier.fillMaxWidth().testTag("load-more-threads")) { Text("加载更多会话") } }
        }
        if (searchOpen) item { MutedText("仅筛选已加载内容") }
    }
    HorizontalDivider()
    AccountQuotaFooter(state, actions)
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        UserAvatar(state.avatarFileName, state.userLabel, size = 28.dp)
        Column(Modifier.weight(1f).padding(start = 8.dp)) {
            Text(state.userLabel, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(if (state.online) "已连接" else "离线缓存", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        TextButton(onSettings, modifier = Modifier.heightIn(min = 48.dp).testTag("settings")) { OraculumIcon(OraculumSymbol.Settings); Spacer(Modifier.width(8.dp)); Text("设置") }
    }
}

@Composable
private fun NavigationSectionToggle(title: String, expanded: Boolean, tag: String, modifier: Modifier = Modifier, onToggle: () -> Unit) {
    Row(modifier.heightIn(min = 48.dp).clickable(onClick = onToggle).testTag(tag).semantics {
        heading()
        role = Role.Button
        stateDescription = if (expanded) "已展开" else "已收起"
    }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        OraculumIcon(if (expanded) OraculumSymbol.ExpandMore else OraculumSymbol.ChevronRight,
            tint = MaterialTheme.colorScheme.onSurfaceVariant, size = 18.dp)
        Text(title, style = MaterialTheme.typography.titleSmall)
    }
}

@Composable
internal fun NavigationRow(title: String, detail: String, selected: Boolean, tag: String, enabled: Boolean,
    symbol: OraculumSymbol? = null, detailMaxLines: Int = 2, onClick: () -> Unit) {
    Surface(onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag(tag).semantics { this.selected = selected },
        color = if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent, shape = RoundedCornerShape(16.dp)) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (symbol != null) OraculumIcon(symbol, tint = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleSmall,
                    color = if (selected) MaterialTheme.colorScheme.onSecondaryContainer else MaterialTheme.colorScheme.onSurface)
                if (detail.isNotBlank()) Text(detail, maxLines = detailMaxLines, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (selected) OraculumIcon(OraculumSymbol.Check, tint = MaterialTheme.colorScheme.primary, size = 18.dp)
        }
    }
}

@Composable
private fun EmptyConversation(state: PocUiState, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    Column(modifier.padding(horizontal = 28.dp, vertical = 24.dp).testTag("empty-brand"),
        verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Surface(shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainerLow,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.25f)),
            modifier = Modifier.padding(bottom = 24.dp)) {
            OracleEyeMark(contentDescription = "神谕之眼", modifier = Modifier.padding(20.dp), size = 88.dp, variant = OracleEyeVariant.Full)
        }
        Spacer(Modifier.height(20.dp))
        Text(when {
            state.selectedProjectId == null -> "万象无疆，诸界未名。"
            state.selectedThreadId == null -> "万象俯首，静候神谕。"
            else -> "谕令未书，万象屏息。"
        }, style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.SemiBold), textAlign = TextAlign.Center)
        Spacer(Modifier.height(10.dp))
        Text(when {
            !state.online -> "离线时可阅读缓存，草稿保留在本机。"
            state.selectedThreadId == null -> "选择项目，继续会话或开启新的工作。"
            else -> "写下你的想法，或添加文件一起开始。"
        }, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        if (action != null) { Spacer(Modifier.height(24.dp)); action() }
    }
}

@Composable
private fun Conversation(state: PocUiState, actions: PocActions, modifier: Modifier) {
    val headerCount = if (state.canLoadMore) 1 else 0
    var expandedTurns by rememberSaveable(state.selectedThreadId) { mutableStateOf(emptyList<String>()) }
    val pending = state.interactions.filter { it.status != "resolved" }
    val pendingTurnIds = pending.map { (it.request["turnId"] as? JsonPrimitive)?.contentOrNull?.takeIf(String::isNotBlank) }
    val rows = groupConversationRows(conversationRows(state.messages, expandedTurns.toSet(), pendingTurnIds.filterNotNull().toSet(), pendingTurnIds.any { it == null }))
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = rows.rowForSourceIndex(state.readIndex.coerceAtLeast(0)) + headerCount, initialFirstVisibleItemScrollOffset = state.readOffset.coerceAtLeast(0))
    var restoredThread by remember { mutableStateOf<String?>(null) }
    val followingEnd by remember { derivedStateOf {
        val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
        lastVisible >= listState.layoutInfo.totalItemsCount - 2
    } }
    LaunchedEffect(state.messages.lastOrNull()?.text, state.interactions.size) {
        if (restoredThread == state.selectedThreadId && followingEnd && rows.isNotEmpty()) {
            listState.scrollToItem((headerCount + rows.size + state.interactions.size - 1).coerceAtLeast(0))
        }
    }
    LaunchedEffect(state.selectedThreadId, state.messages.isEmpty()) {
        if (rows.isNotEmpty() && restoredThread != state.selectedThreadId) {
            listState.scrollToItem(rows.rowForSourceIndex(state.readIndex.coerceAtLeast(0)) + headerCount, state.readOffset.coerceAtLeast(0))
            restoredThread = state.selectedThreadId
        }
    }
    val currentRows by rememberUpdatedState(rows)
    LaunchedEffect(listState, state.selectedThreadId, headerCount) {
        snapshotFlow { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }.distinctUntilChanged().collect { (index, offset) ->
            if (restoredThread == state.selectedThreadId) {
                val sourceIndex = currentRows.getOrNull((index - headerCount).coerceAtLeast(0))?.sourceIndex ?: currentRows.lastOrNull()?.sourceIndex ?: 0
                actions.onReadPosition(sourceIndex, if (index < headerCount) 0 else offset)
            }
        }
    }
    LazyColumn(modifier.fillMaxWidth().testTag("conversation"), state = listState, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (state.canLoadMore) item(key = "history_controls") {
            OutlinedButton(actions.onLoadMore, enabled = state.online && !state.busy, modifier = Modifier.fillMaxWidth().testTag("load-more")) { Text("加载更早历史") }
        }
        if (state.messages.isEmpty() && state.interactions.isEmpty()) item(key = "empty") {
            EmptyConversation(state, Modifier.fillParentMaxHeight(.85f).fillMaxWidth())
        }
        items(rows, key = { it.key }) { row ->
            if (row.message != null) MessageCard(row.message, state, actions)
            else OraculumCard(CardRole.Content, Modifier.fillMaxWidth(), PaddingValues(0.dp)) {
                val answer = row.children.mapNotNull { it.message }.firstOrNull { it.role == "assistant" && !isProcessMessage(it) }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    MessageHeader(answer ?: ChatMessage(row.key, "assistant", "", timestampMillis = row.turn?.startedAtMillis),
                        state, modifier = Modifier.weight(1f).testTag("assistant-header-${row.turnId}").padding(start = 16.dp, end = 4.dp, top = 12.dp))
                    TurnToolsMenu(row.turnId, state, actions)
                }
                TurnSummary(row) {
                    expandedTurns = if (row.turnId in expandedTurns) expandedTurns - row.turnId else expandedTurns + row.turnId
                }
                row.children.forEach { child ->
                    child.message?.let { MessageCard(it, state, actions, embedded = true, showHeader = it.id != answer?.id) }
                }
            }
        }
        items(state.interactions, key = { "interaction-${it.id}" }) { interaction ->
            NativeInteractionPanel(interaction, state.online && !state.busy && state.unknownWarning == null,
                onApproveFileChange = { response, digest -> actions.onRespondFileChange(interaction.id, response, digest) }) { response -> actions.onRespondInteraction(interaction.id, response) }
        }
    }
}

@Composable
private fun TurnSummary(row: ConversationRow, toggle: () -> Unit) {
    val turn = row.turn ?: return
    val label = when (turn.status) { "completed" -> "已完成"; "failed" -> "执行失败"; "interrupted" -> "已停止"; "inProgress" -> "执行中"; else -> "本轮执行" }
    val usage = turn.usage
    val tokens = usage?.totalTokens?.let { "用量 ${java.text.NumberFormat.getIntegerInstance().format(it)}" }
    val details = listOfNotNull(turn.durationMs?.let { formatTurnDuration(it) }, tokens)
    val collapsible = row.canCollapse && row.processCount > 0
    Surface(color = Color.Transparent,
        modifier = Modifier.fillMaxWidth().testTag("turn-summary-${row.turnId}").then(if (collapsible) Modifier.clickable(onClick = toggle) else Modifier)
            .semantics { if (collapsible) { role = Role.Button; stateDescription = if (row.expanded) "已展开" else "已收起" } }) {
        Column(Modifier.padding(horizontal = 14.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.heightIn(min = if (collapsible) 40.dp else 24.dp)) {
                Box(Modifier.size(8.dp).background(if (turn.status == "completed") MaterialTheme.colorScheme.primary else if (turn.status == "failed") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.tertiary, CircleShape))
                Text((listOf(label) + details).joinToString(" · "), Modifier.weight(1f), style = MaterialTheme.typography.labelMedium.copy(fontFamily = FontFamily.Monospace), color = MaterialTheme.colorScheme.onSurface)
                if (collapsible) OraculumIcon(if (row.expanded) OraculumSymbol.ExpandLess else OraculumSymbol.ExpandMore,
                    if (row.expanded) "收起本轮执行过程" else "展开本轮执行过程", size = 18.dp, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            val counts = listOfNotNull(row.processCount.takeIf { it > 0 }?.let { "$it 项执行记录" },
                usage?.cachedInputTokens?.let { "缓存读取 ${java.text.NumberFormat.getIntegerInstance().format(it)}" })
            if (counts.isNotEmpty()) Text(counts.joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val times = listOfNotNull(turn.startedAtMillis?.let { "开始 ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(it))}" },
                turn.completedAtMillis?.let { "结束 ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(it))}" })
            if (row.expanded && times.isNotEmpty()) Text(times.joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f))
        }
    }
}

@Composable
private fun MessageHeader(message: ChatMessage, state: PocUiState, expanded: Boolean = false,
    onToggle: () -> Unit = {}, modifier: Modifier = Modifier) {
    val process = isProcessMessage(message)
    val user = message.role == "user"
    var copied by remember(message.text) { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        when {
            process -> OraculumIcon(when (message.role) { "reasoning" -> OraculumSymbol.Model; "commandExecution" -> OraculumSymbol.Terminal; else -> OraculumSymbol.Code }, tint = MaterialTheme.colorScheme.onSurfaceVariant, size = 18.dp)
            user -> UserAvatar(state.avatarFileName, state.userLabel, size = 26.dp)
            else -> Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)) { OracleEyeMark(modifier = Modifier.padding(5.dp), tint = MaterialTheme.colorScheme.primary, size = 18.dp) }
        }
        Column(Modifier.weight(1f)) {
            Text(when (message.role) { "user" -> state.userLabel; "assistant" -> state.assistantLabel; "reasoning" -> "思考过程"; "commandExecution" -> "命令执行"; "fileChange" -> "文件变更"; else -> message.role },
                style = if (process || user) MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold) else MaterialTheme.typography.titleSmall,
                color = if (user) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
            if (message.status.isNotBlank()) Text(message.status, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            message.timestampMillis?.let { Text(DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(it)), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)) }
        }
        if (process) IconButton(onToggle, Modifier.size(48.dp).semantics { stateDescription = if (expanded) "已展开" else "已收起" }) {
            OraculumIcon(if (expanded) OraculumSymbol.ExpandLess else OraculumSymbol.ExpandMore, if (expanded) "收起执行内容" else "查看执行内容", size = 18.dp)
        } else if (!user && message.text.isNotBlank()) IconButton({ clipboard.setText(AnnotatedString(message.text)); copied = true }, Modifier.size(48.dp)) {
            OraculumIcon(if (copied) OraculumSymbol.Check else OraculumSymbol.Copy, if (copied) "已复制答案" else "复制答案", tint = if (copied) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, size = 18.dp)
        }
    }
}

@Composable
private fun MessageCard(message: ChatMessage, state: PocUiState, actions: PocActions, embedded: Boolean = false, showHeader: Boolean = true) {
    val process = isProcessMessage(message)
    val user = message.role == "user"
    var expanded by rememberSaveable(message.id) { mutableStateOf(message.needsAttention || (process && message.turn?.status != "completed")) }
    LaunchedEffect(message.needsAttention) { if (message.needsAttention) expanded = true }
    MessageContainer(embedded = embedded, role = when { process -> CardRole.Process; user -> CardRole.User; else -> CardRole.Content },
        modifier = Modifier.fillMaxWidth().testTag("message_${message.id}"),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = if (process) 6.dp else 12.dp)) {
        if (showHeader) MessageHeader(message, state, expanded, { expanded = !expanded })
        if (!process || expanded) MarkdownContent(message.text)
        if (message.detailsRequired) OutlinedButton({ actions.onLoadItemDetail(message.turnId, message.id) }, enabled = state.online && !state.busy,
            modifier = Modifier.fillMaxWidth().testTag("detail-${message.id}")) { OraculumIcon(OraculumSymbol.Description); Spacer(Modifier.width(8.dp)); Text("查看完整内容") }
    }
}

@Composable
private fun Composer(state: PocUiState, actions: PocActions, filesState: FilesUiState, filesActions: FilesActions,
    maximumHeight: Dp, compact: Boolean) {
    var addMenu by remember { mutableStateOf(false) }
    var compactConfirmation by rememberSaveable(state.selectedThreadId) { mutableStateOf(false) }
    val canManageThread = state.selectedThreadId != null && state.canManageThread && state.online && !state.busy && state.unknownWarning == null && state.unresolvedOperations.isEmpty()
    var pickerMenu by remember { mutableStateOf<String?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments(), filesActions.pick)
    val hasText = state.draft.isNotBlank()
    val steering = state.activeTurnId != null && "turn.steer" in state.capabilityNames
    val canSubmit = state.online && hasText && if (steering) state.canSteer && filesState.attachments.isEmpty() && !filesState.hasUnknown else state.canSend
    val border = BorderStroke(1.dp, if (hasText) MaterialTheme.colorScheme.primary.copy(alpha = 0.4f) else MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.3f))
    Column(Modifier.navigationBarsPadding().imePadding().padding(horizontal = 12.dp, vertical = 6.dp)) {
        Surface(shape = OraculumTokens.PanelShape, color = MaterialTheme.colorScheme.surfaceContainerHigh, border = border) {
            Column(Modifier.heightIn(max = maximumHeight).padding(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                // Only the content area scrolls; send/stop remain outside it in a 48dp toolbar.
                Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                    val executionNotice = composerExecutionNotice(state)
                    if (executionNotice != null) Row(Modifier.padding(horizontal = 8.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        OraculumIcon(if (state.canStop) OraculumSymbol.Terminal else OraculumSymbol.Info, tint = MaterialTheme.colorScheme.onSurfaceVariant, size = 16.dp)
                        Text(executionNotice, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    OutlinedTextField(state.draft, actions.onDraftChange,
                        placeholder = { Text(if (!state.online) "离线草稿 · 联网后手动发送" else if (steering) "补充当前执行的指令…" else if (filesState.attachments.isNotEmpty()) "为附件添加说明…" else "给 Codex 发送消息…") },
                        minLines = 1, maxLines = if (compact) 2 else 4,
                        modifier = Modifier.fillMaxWidth().testTag("draft"), shape = RoundedCornerShape(16.dp),
                        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Color.Transparent, unfocusedBorderColor = Color.Transparent))
                    if (filesState.attachments.isNotEmpty() || filesState.hasUnknown) {
                        AttachmentChips(filesState, filesActions, compact = true)
                    }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box {
                        IconButton({ addMenu = true }, modifier = Modifier.size(48.dp).testTag("composer-add").semantics { contentDescription = "附件与会话操作" }) {
                            OraculumIcon(OraculumSymbol.Add, size = 22.dp, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        DropdownMenu(expanded = addMenu, onDismissRequest = { addMenu = false }) {
                            DropdownMenuItem(text = { Text("图片或文档") }, leadingIcon = { OraculumIcon(OraculumSymbol.AttachFile) },
                                enabled = filesState.writable && !filesState.busy && !filesState.hasUnknown,
                                modifier = Modifier.testTag("files_pick"), onClick = { addMenu = false; filesActions.beginPick(); picker.launch(FileTransferPolicy.types.values.distinct().toTypedArray()) })
                            if ("thread.fork" in state.capabilityNames) DropdownMenuItem(text = { Text("分叉为新会话") },
                                enabled = canManageThread, modifier = Modifier.testTag("fork-thread"),
                                onClick = { addMenu = false; actions.onForkThread(null) })
                            if ("thread.compact" in state.capabilityNames) DropdownMenuItem(text = { Text("压缩上下文") },
                                enabled = canManageThread, modifier = Modifier.testTag("compact-thread"),
                                onClick = { addMenu = false; compactConfirmation = true })
                        }
                    }
                    Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                        Box {
                            TextButton({ pickerMenu = "permission"; addMenu = false }, contentPadding = PaddingValues(horizontal = 8.dp),
                                modifier = Modifier.heightIn(min = 48.dp).testTag("permission-picker").semantics { contentDescription = "选择执行权限" }) {
                                OraculumIcon(OraculumSymbol.Shield, size = 16.dp, tint = MaterialTheme.colorScheme.primary)
                                Spacer(Modifier.width(4.dp))
                                Text(composerPermissionLabel(state), maxLines = 1, style = MaterialTheme.typography.labelMedium)
                            }
                            PermissionPickerMenu(state, actions, pickerMenu == "permission") { pickerMenu = null }
                        }
                        Box(Modifier.weight(1f)) {
                            TextButton({ pickerMenu = "model"; addMenu = false }, contentPadding = PaddingValues(horizontal = 8.dp),
                                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("model-picker").semantics { contentDescription = "选择模型与思考强度" }) {
                                OraculumIcon(OraculumSymbol.Tune, size = 16.dp, tint = MaterialTheme.colorScheme.primary)
                                Spacer(Modifier.width(4.dp))
                                Text(composerModelAndEffortLabel(state), maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    style = MaterialTheme.typography.labelMedium)
                            }
                            ModelPickerMenu(state, actions, pickerMenu == "model") { pickerMenu = null }
                        }
                    }
                    if (state.canResume) TextButton(actions.onResume, enabled = state.online && !state.busy, modifier = Modifier.heightIn(min = 48.dp).testTag("resume")) { OraculumIcon(OraculumSymbol.Refresh, "恢复会话") }
                    if (state.canStop) FilledTonalIconButton(actions.onStop, enabled = state.online, modifier = Modifier.size(48.dp).testTag("stop").semantics { contentDescription = "停止执行" }) { Glyph("stop", MaterialTheme.colorScheme.onSurface) }
                    if (!state.canStop || steering) FilledIconButton(if (steering) actions.onSteer else actions.onSend, enabled = canSubmit,
                        colors = IconButtonDefaults.filledIconButtonColors(
                            containerColor = if (canSubmit) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerHighest,
                            contentColor = if (canSubmit) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)),
                        modifier = Modifier.size(48.dp).testTag(if (steering) "steer" else "send").semantics { contentDescription = if (steering) "补充本轮指令" else "发送消息" }) { Glyph("send", LocalContentColor.current) }
                }
            }
        }
    }
    if (compactConfirmation) AlertDialog(onDismissRequest = { compactConfirmation = false }, title = { Text("压缩上下文？") },
        text = { Text("整理当前会话上下文，工作区文件不受影响。") },
        confirmButton = { TextButton({ actions.onCompactThread(); compactConfirmation = false },
            enabled = canManageThread && "thread.compact" in state.capabilityNames,
            modifier = Modifier.testTag("confirm-compact-thread")) { Text("开始压缩") } },
        dismissButton = { TextButton({ compactConfirmation = false }) { Text("取消") } })
}

@Composable
internal fun Notice(text: String, isError: Boolean = false) {
    Surface(color = if (isError) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surfaceContainerHigh) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
            OraculumIcon(if (isError) OraculumSymbol.Error else OraculumSymbol.Info,
                tint = if (isError) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSurfaceVariant)
            SelectionContainer {
                Text(text, color = if (isError) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
internal fun MutedText(text: String) { Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }

@Composable
internal fun GlyphButton(kind: String, description: String, tag: String, onClick: () -> Unit) {
    IconButton(onClick, Modifier.size(48.dp).testTag(tag).semantics { contentDescription = description }) {
        Glyph(kind, MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Icons resolve to a local, reviewed Material Symbols Outlined resource. */
@Composable
private fun Glyph(kind: String, color: Color) {
    OraculumIcon(when (kind) {
        "close" -> OraculumSymbol.Close
        "send" -> OraculumSymbol.Send
        "stop" -> OraculumSymbol.Stop
        "settings" -> OraculumSymbol.Settings
        else -> OraculumSymbol.ViewSidebar
    }, tint = color, size = 24.dp)
}
