@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package dev.oraculum.poc.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.oraculum.poc.repository.boundedContentPreview
import dev.oraculum.poc.repository.CONTENT_PREVIEW_NOTICE
import dev.oraculum.poc.files.FilesActions
import dev.oraculum.poc.files.FilesPanel
import dev.oraculum.poc.files.FilesUiState
import java.text.DateFormat
import java.util.Date

@Composable
internal fun ColumnScope.ModelPanel(state: PocUiState, actions: PocActions, onClose: () -> Unit) {
    PanelHeading("模型与思考强度", onClose)
    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        OraculumCard(CardRole.Inset) {
            SectionLabel("当前原生模型", OraculumSymbol.Model)
            Text(state.actualModel ?: "尚未确认", style = MaterialTheme.typography.titleMedium)
            MutedText(state.actualEffort ?: "默认思考强度")
        }
        MutedText("设置用于下一次执行，选项来自 Gateway 的可用模型。")
        if (state.models.isEmpty()) MutedText("尚未取得可用模型。连接后刷新状态。")
        if (state.modelsLimited) MutedText("当前仅显示 Gateway 已返回的模型页；模型目录尚未完整加载。")
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            state.models.forEach { model ->
                NavigationRow(model.label, model.description, state.selectedModel == model.id, "model-${model.id}", !state.busy, symbol = OraculumSymbol.Model) { actions.onSelectModel(model.id) }
            }
        }
        state.models.firstOrNull { it.id == state.selectedModel }?.let { model ->
            SectionLabel("思考强度", OraculumSymbol.Tune)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                model.efforts.forEach { effort ->
                    FilterChip(selected = state.selectedEffort == effort, onClick = { actions.onSelectEffort(effort) }, enabled = !state.busy,
                        label = { Text(effort) }, leadingIcon = { OraculumIcon(if (state.selectedEffort == effort) OraculumSymbol.Check else OraculumSymbol.Tune) },
                        modifier = Modifier.heightIn(min = 48.dp).testTag("effort-$effort"))
                }
            }
            if (model.efforts.isEmpty()) MutedText("此模型未提供可选思考强度。")
        }
    }
}

@Composable
internal fun ColumnScope.PermissionPanel(state: PocUiState, actions: PocActions, onClose: () -> Unit) {
    var confirmFull by remember { mutableStateOf(false) }
    PanelHeading("执行权限", onClose)
    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        MutedText("以下选择用于下一次执行；不会改写主机默认配置。")
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            NavigationRow("Read only", "只读沙箱；写入和受限操作仍遵循原生审批。", state.permissionPreset == "read-only", "permission-read-only", !state.busy, symbol = OraculumSymbol.Shield, detailMaxLines = Int.MAX_VALUE) { actions.onSelectPermission("read-only", false) }
            NavigationRow("Auto", "允许在工作区内写入；需要提升权限的操作交由原生审批。", state.permissionPreset == "auto", "permission-auto", !state.busy, symbol = OraculumSymbol.Folder, detailMaxLines = Int.MAX_VALUE) { actions.onSelectPermission("auto", false) }
            NavigationRow("Full access", "取消沙箱限制，可能修改工作区以外文件并访问网络。", state.permissionPreset == "full-access", "permission-full-access", !state.busy, symbol = OraculumSymbol.Warning, detailMaxLines = Int.MAX_VALUE) { confirmFull = true }
        }
        OraculumCard(CardRole.Inset) {
            SectionLabel("最近原生回读", OraculumSymbol.History)
            state.permissionReadback?.let { readback ->
                Text("沙箱：${readback.sandboxType}\n审批策略：${readback.approvalPolicy}\n预设映射：${readback.preset ?: "自定义/未映射"}", style = MaterialTheme.typography.bodyMedium)
                MutedText("来源：${readback.source}\n时间：${DateFormat.getDateTimeInstance().format(Date(readback.observedAt))}")
            } ?: MutedText("无有效回读，当前权限未知")
        }
    }
    if (confirmFull) AlertDialog(onDismissRequest = { confirmFull = false }, icon = { OraculumIcon(OraculumSymbol.Warning) }, title = { Text("启用 Full access？") },
        text = { Text("下一次执行将使用完整主机权限，且可能无需逐次审批。请仅对你信任的任务启用。") },
        confirmButton = { TextButton({ actions.onSelectPermission("full-access", true); confirmFull = false }, Modifier.testTag("confirm-full-access")) { Text("确认启用") } },
        dismissButton = { TextButton({ confirmFull = false }) { Text("取消") } })
}

@Composable
internal fun ColumnScope.InspectorPanel(state: PocUiState, actions: PocActions, tab: String, onTab: (String) -> Unit,
    filesState: FilesUiState, filesActions: FilesActions, onClose: (() -> Unit)?) {
    PanelHeading("Inspector", onClose)
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf(Triple("diff", "Diff", OraculumSymbol.Difference), Triple("output", "输出", OraculumSymbol.Terminal), Triple("files", "文件", OraculumSymbol.Folder),
            Triple("usage", "用量", OraculumSymbol.DataUsage), Triple("extensions", "扩展", OraculumSymbol.Extension)).forEach { (id, label, symbol) ->
            FilterChip(selected = id == tab, onClick = { onTab(id) }, label = { Text(label) }, leadingIcon = { OraculumIcon(symbol) },
                modifier = Modifier.heightIn(min = 48.dp).testTag("inspector-$id"))
        }
    }
    HorizontalDivider(Modifier.padding(top = 8.dp))
    if (tab == "files") {
        Box(Modifier.weight(1f).fillMaxWidth()) { FilesPanel(filesState, filesActions) }
    } else {
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (tab == "diff") {
                SectionLabel("当前原生 Diff", OraculumSymbol.Difference)
                state.inspector.diff?.takeIf { it.isNotBlank() }?.let { DiffContent(it) } ?: PanelEmptyState(OraculumSymbol.Difference, "此会话尚无可用 Diff。")
            }
            if (tab == "output") {
                OraculumCard(CardRole.Inset) {
                    SectionLabel("执行状态", if (state.canStop) OraculumSymbol.Terminal else OraculumSymbol.Info)
                    Text(state.executionLabel.ifBlank { "尚无正在执行的 Turn" }, style = MaterialTheme.typography.titleSmall)
                }
                if (state.interactions.isNotEmpty()) {
                    SectionLabel("等待你的处理", OraculumSymbol.Shield)
                    state.interactions.forEach { interaction -> NativeInteractionPanel(interaction, state.online && !state.busy && state.unknownWarning == null,
                        onApproveFileChange = { response, digest -> actions.onRespondFileChange(interaction.id, response, digest) }) { actions.onRespondInteraction(interaction.id, it) } }
                }
                if (state.inspector.plan.isNotEmpty()) {
                    SectionLabel("原生 Plan 更新", OraculumSymbol.Description)
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { state.inspector.plan.forEach { InspectorEntryCard(it, state, actions) } }
                }
                SectionLabel("执行记录", OraculumSymbol.Terminal)
                if (state.inspector.execution.isEmpty()) PanelEmptyState(OraculumSymbol.Terminal, "尚无已加载的工具执行记录。")
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { state.inspector.execution.forEach { InspectorEntryCard(it, state, actions) } }
                if (state.inspector.agents.isNotEmpty()) {
                    SectionLabel("子代理活动", OraculumSymbol.Person)
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { state.inspector.agents.forEach { InspectorEntryCard(it, state, actions) } }
                }
            }
            if (tab == "usage") {
                SectionLabel("会话用量", OraculumSymbol.DataUsage)
                state.inspector.usage?.let { usage ->
                    val preview = remember(usage) { boundedContentPreview(sequenceOf(usage)) }
                    OraculumCard {
                        if (preview.truncated) MutedText(CONTENT_PREVIEW_NOTICE)
                        // The projection already formats the actual native values. No estimates or inferred percentages.
                        SelectionContainer {
                            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                                preview.text.lines().forEach { line ->
                                    val separator = line.indexOf('：')
                                    if (separator > 0) {
                                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                            Text(line.take(separator), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                            Text(line.substring(separator + 1), style = MaterialTheme.typography.titleMedium.copy(fontFeatureSettings = "tnum"))
                                        }
                                    } else Text(line, style = MaterialTheme.typography.bodyMedium)
                                }
                            }
                        }
                    }
                } ?: PanelEmptyState(OraculumSymbol.DataUsage, "当前原生状态尚未提供 token / 上下文用量。")
                MutedText("账户额度未由当前 Gateway 公开。")
            }
            if (tab == "extensions") {
                SectionLabel("受支持的扩展", OraculumSymbol.Extension)
                if (state.inspector.extensions.isEmpty()) PanelEmptyState(OraculumSymbol.Extension, "尚未获取扩展状态。刷新后显示 Gateway 支持的只读信息。")
                state.inspector.extensions.forEach { section ->
                    OraculumCard {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            OraculumIcon(OraculumSymbol.Extension, tint = MaterialTheme.colorScheme.primary)
                            Text(section.kind, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                            NativeStatusLabel(section.status)
                        }
                        section.reason?.let { MutedText(it) }
                        section.entries.forEach { entry ->
                            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                            Text(entry.title, fontWeight = FontWeight.Medium, style = MaterialTheme.typography.bodyMedium)
                            if (entry.body.isNotBlank()) MutedText(entry.body)
                        }
                        if (section.entries.isEmpty() && section.status == "available") MutedText("没有返回可显示条目。")
                        if (section.limited) MutedText("当前结果受限，并非完整清单。")
                    }
                }
                state.inspector.limitations.forEach { MutedText(it) }
            }
            state.inspector.detailTitle?.let { title ->
                SectionLabel("完整 Item 详情", OraculumSymbol.Code)
                IdentifierRow("Item", title)
                state.inspector.detailProgress?.let { MutedText(it) }
                state.inspector.detailText?.let { CodeBlock(it, "完整 Item") }
            }
            OutlinedButton(actions.onRefreshInspector, enabled = state.online && !state.busy, modifier = Modifier.fillMaxWidth().testTag("refresh-inspector")) {
                ActionLabel(OraculumSymbol.Refresh, "刷新真实状态")
            }
        }
    }
}

@Composable
private fun InspectorEntryCard(entry: InspectorEntry, state: PocUiState, actions: PocActions) {
    var expanded by rememberSaveable(entry.id) { mutableStateOf(false) }
    val isTurn = entry.id.startsWith("turn:") && entry.title == "Turn ${entry.turnId}"
    val title = if (isTurn) "执行轮次" else when (entry.title) {
        "commandExecution" -> "命令执行"
        "fileChange" -> "文件变更"
        "reasoning" -> "思考过程"
        "webSearch" -> "网页搜索"
        "mcpToolCall" -> "MCP 工具"
        "dynamicToolCall" -> "工具调用"
        "plan" -> "执行计划"
        else -> entry.title
    }
    val symbol = when { isTurn -> OraculumSymbol.History; entry.title == "commandExecution" -> OraculumSymbol.Terminal; entry.title == "fileChange" -> OraculumSymbol.Difference; else -> OraculumSymbol.Description }
    OraculumCard(CardRole.Process, contentPadding = PaddingValues(12.dp)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable { expanded = !expanded }.semantics {
            role = Role.Button
            stateDescription = if (expanded) "已展开" else "已收起"
        }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OraculumIcon(symbol, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(title, style = MaterialTheme.typography.titleSmall, maxLines = if (expanded) Int.MAX_VALUE else 2, overflow = TextOverflow.Ellipsis)
                if (entry.status.isNotBlank()) NativeStatusLabel(entry.status)
            }
            OraculumIcon(if (expanded) OraculumSymbol.ExpandLess else OraculumSymbol.ExpandMore)
        }
        // A native Turn error remains visible even with its technical details collapsed.
        if (isTurn && entry.body.isNotBlank()) Text(entry.body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        if (!expanded && entry.title == "commandExecution" && entry.body.isNotBlank()) Text(entry.body.lineSequence().first(), maxLines = 1, overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (expanded) {
            if (!isTurn && title != entry.title) MutedText("原生类型：${entry.title}")
            if (entry.turnId.isNotBlank()) IdentifierRow("Turn", entry.turnId)
            if (entry.itemId.isNotBlank()) IdentifierRow("Item", entry.itemId)
            if (entry.turnId.isBlank() && entry.itemId.isBlank()) IdentifierRow("记录", entry.id)
            if (entry.body.isNotBlank() && !isTurn) MarkdownContent(entry.body)
            if (entry.detailsRequired) OutlinedButton({ actions.onLoadItemDetail(entry.turnId, entry.itemId) }, enabled = state.online && !state.busy, modifier = Modifier.fillMaxWidth()) {
                ActionLabel(OraculumSymbol.Description, "读取完整详情")
            }
        } else {
            val identifier = entry.itemId.ifBlank { entry.turnId }.ifBlank { entry.id }
            Text(identifier.take(8) + if (identifier.length > 8) "…" + identifier.takeLast(4) else "", style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun IdentifierRow(label: String, value: String) {
    val clipboard = LocalClipboardManager.current
    var expanded by rememberSaveable(value) { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).clickable { expanded = !expanded }.heightIn(min = 48.dp).padding(vertical = 6.dp).semantics {
            role = Role.Button
            stateDescription = if (expanded) "已展开完整标识" else "已缩略标识，点击展开"
        }, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            SelectionContainer { Text(value, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace,
                maxLines = if (expanded) Int.MAX_VALUE else 1, overflow = TextOverflow.Ellipsis) }
        }
        IconButton({ clipboard.setText(AnnotatedString(value)) }, Modifier.size(48.dp)) { OraculumIcon(OraculumSymbol.Copy, "复制 $label 标识") }
    }
}

@Composable
private fun NativeStatusLabel(status: String) {
    val symbol = when (status) {
        "completed", "available" -> OraculumSymbol.Check
        "failed", "error" -> OraculumSymbol.Error
        "inProgress", "in_progress", "running" -> OraculumSymbol.Terminal
        "interrupted", "cancelled" -> OraculumSymbol.Stop
        else -> OraculumSymbol.Info
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        OraculumIcon(symbol, tint = if (status in listOf("failed", "error")) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, size = 16.dp)
        Text(status, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun PanelEmptyState(symbol: OraculumSymbol, text: String) {
    OraculumCard(CardRole.Inset) {
        OraculumIcon(symbol, tint = MaterialTheme.colorScheme.onSurfaceVariant, size = 24.dp)
        MutedText(text)
    }
}

@Composable
private fun ActionLabel(symbol: OraculumSymbol, text: String) {
    OraculumIcon(symbol)
    Spacer(Modifier.width(8.dp))
    Text(text)
}

@Composable
private fun DiffContent(diff: String) {
    val preview = remember(diff) { boundedContentPreview(sequenceOf(diff)) }
    val clipboard = LocalClipboardManager.current
    ReadingContent {
        val dark = MaterialTheme.colorScheme.background.red < .3f
        OraculumCard(CardRole.Inset, contentPadding = PaddingValues(0.dp)) {
            Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OraculumIcon(OraculumSymbol.Difference, tint = MaterialTheme.colorScheme.primary)
                Text("Unified Diff", Modifier.weight(1f), style = MaterialTheme.typography.labelMedium)
                IconButton({ clipboard.setText(AnnotatedString(preview.text)) }, Modifier.size(48.dp)) { OraculumIcon(OraculumSymbol.Copy, "复制已显示 Diff") }
            }
            HorizontalDivider()
            if (preview.truncated) Text(CONTENT_PREVIEW_NOTICE, Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            SelectionContainer {
                Column(Modifier.horizontalScroll(rememberScrollState()).padding(12.dp).semantics { contentDescription = "Diff，可横向滚动；加号表示新增，减号表示删除" }) {
                    // The shared whole-view budget bounds this to 256 rows / 64 Ki characters.
                    preview.text.lineSequence().forEach { line ->
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
internal fun ColumnScope.SettingsPanel(state: PocUiState, actions: PocActions, notificationEnabled: Boolean, onNotifications: () -> Unit, onClose: () -> Unit) {
    var clearCacheOpen by remember { mutableStateOf(false) }
    var userLabel by remember(state.userLabel) { mutableStateOf(state.userLabel) }
    var assistantLabel by remember(state.assistantLabel) { mutableStateOf(state.assistantLabel) }
    var readingScale by remember(state.readingScale) { mutableFloatStateOf(state.readingScale) }
    PanelHeading("设置", onClose)
    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        SectionLabel("外观", OraculumSymbol.Palette)
        OraculumCard {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("light" to "Light", "dark" to "Dark", "oled" to "OLED Dark").forEach { (mode, label) ->
                    FilterChip(selected = state.themeMode == mode, onClick = { actions.onThemeChange(mode) }, label = { Text(label) },
                        leadingIcon = { OraculumIcon(if (state.themeMode == mode) OraculumSymbol.Check else OraculumSymbol.Palette) },
                        modifier = Modifier.heightIn(min = 48.dp).testTag("theme-$mode"))
                }
            }
            HorizontalDivider()
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OraculumIcon(OraculumSymbol.TextSize)
                Text("消息与代码字号", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                Text("${(readingScale * 100).toInt()}%", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            }
            Slider(readingScale, { readingScale = it }, valueRange = .85f..1.4f, steps = 10,
                onValueChangeFinished = { actions.onReadingScaleChange(readingScale) },
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("reading-scale").semantics { contentDescription = "阅读字号" })
            MutedText("仅调整消息与代码阅读字号；其余控件遵循 Android 系统字体缩放。偏好仅保存在本机。")
        }
        SectionLabel("称呼与身份", OraculumSymbol.Person)
        OraculumCard {
            OutlinedTextField(userLabel, { if (it.length <= 40) userLabel = it }, label = { Text("你的称呼") }, singleLine = true,
                leadingIcon = { OraculumIcon(OraculumSymbol.Person) }, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth().testTag("identity-user"))
            OutlinedTextField(assistantLabel, { if (it.length <= 40) assistantLabel = it }, label = { Text("助手称呼") }, singleLine = true,
                leadingIcon = { OracleEyeMark() }, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth().testTag("identity-assistant"))
            FilledTonalButton({ actions.onIdentityLabelsChange(userLabel, assistantLabel) }, enabled = userLabel.isNotBlank() && assistantLabel.isNotBlank(),
                modifier = Modifier.fillMaxWidth().testTag("identity-save")) { ActionLabel(OraculumSymbol.Check, "保存称呼") }
            MutedText("称呼仅用于本机显示，不改变 Codex 身份或发送给模型。")
        }
        SectionLabel("通知", OraculumSymbol.Notifications)
        OraculumCard {
            Text(if (notificationEnabled) "系统通知已开启" else "系统通知尚未开启", style = MaterialTheme.typography.titleSmall)
            OutlinedButton(onNotifications, Modifier.fillMaxWidth().testTag("notification-settings")) { ActionLabel(OraculumSymbol.Notifications, if (notificationEnabled) "管理通知" else "开启系统通知") }
            MutedText("应用在前台或按 Home 后进程与连接仍存活时，可提醒执行完成、审批和错误。进程回收、强制停止或系统省电限制后不能保证送达；回到应用会重新读取真实状态。")
        }
        SectionLabel("Gateway 连接", if (state.online) OraculumSymbol.Wifi else OraculumSymbol.WifiOff)
        OraculumCard {
            Text(state.connectionLabel, style = MaterialTheme.typography.titleSmall)
            SelectionContainer { Text(state.endpoint.ifBlank { "尚未设置 HTTPS 地址" }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            if (!state.online && !state.busy) OutlinedTextField(state.endpoint, actions.onEndpointChange, label = { Text("HTTPS 地址") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), modifier = Modifier.fillMaxWidth().testTag("settings-endpoint"))
            if (state.paired) {
                OutlinedButton(actions.onReconnect, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { ActionLabel(OraculumSymbol.Wifi, "重新连接") }
                OutlinedButton(actions.onRefresh, enabled = state.online && !state.busy, modifier = Modifier.fillMaxWidth()) { ActionLabel(OraculumSymbol.Refresh, "刷新原生状态") }
                HorizontalDivider()
                TextButton({ clearCacheOpen = true }, enabled = !state.busy, modifier = Modifier.fillMaxWidth().testTag("clear-cache")) { ActionLabel(OraculumSymbol.Delete, "清理可重建历史缓存") }
                TextButton(actions.onDisconnect, modifier = Modifier.fillMaxWidth()) { ActionLabel(OraculumSymbol.WifiOff, "断开连接") }
            } else MutedText("使用主机 CLI 生成的一次性配对码。设备凭据仅保存在本机安全存储。")
        }
    }
    if (clearCacheOpen) AlertDialog(onDismissRequest = { clearCacheOpen = false }, icon = { OraculumIcon(OraculumSymbol.Delete) }, title = { Text("清理历史缓存？") },
        text = { Text("项目、会话和消息缓存可以联网重建。未发送草稿、发送回执与未知操作记录将保留。") },
        confirmButton = { TextButton({ actions.onClearCache(); clearCacheOpen = false }, Modifier.testTag("confirm-clear-cache")) { Text("清理缓存") } },
        dismissButton = { TextButton({ clearCacheOpen = false }) { Text("取消") } })
}

@Composable
internal fun ColumnScope.UnknownRecoveryPanel(state: PocUiState, actions: PocActions, onClose: () -> Unit) {
    PanelHeading("操作结果待确认", onClose)
    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        OraculumCard(CardRole.Attention) {
            SectionLabel("发送屏障已保留", OraculumSymbol.Warning)
            Text("请求可能已经到达 Codex。为避免重复执行，确认结果前会保留发送屏障。", style = MaterialTheme.typography.bodyMedium)
            state.unknownWarning?.let { MutedText(it) }
        }
        state.operationStatusMessage?.let { Notice(it) }
        if (state.unresolvedOperations.isEmpty()) MutedText("当前摘要未包含操作详情。请恢复连接并刷新原生状态。")
        state.unresolvedOperations.forEach { operation ->
            OraculumCard {
                SectionLabel(operation.kind, OraculumSymbol.History)
                val project = state.projects.firstOrNull { it.id == operation.projectId }
                val thread = state.threads.firstOrNull { it.id == operation.threadId }
                Text("项目：${project?.label ?: operation.projectId}", style = MaterialTheme.typography.bodyMedium)
                Text("会话：${thread?.label ?: operation.threadId ?: "尚未确认"}", style = MaterialTheme.typography.bodyMedium)
                SelectionContainer {
                    Text("最后状态：${operation.status}\n投递状态：${operation.delivery}\n创建时间：${DateFormat.getDateTimeInstance().format(Date(operation.createdAt))}", style = MaterialTheme.typography.bodySmall)
                }
                IdentifierRow("operationId", operation.operationId)
                operation.nativeTurnId?.let { IdentifierRow("原生 Turn", it) }
                Text("影响范围：${if (operation.threadId == null) "此项目及关联操作" else "此会话及关联操作"}", style = MaterialTheme.typography.bodySmall)
                OutlinedButton({ actions.onQueryOperation(operation.operationId) }, enabled = state.online && !state.busy,
                    modifier = Modifier.fillMaxWidth().testTag("query-operation-${operation.operationId}")) { ActionLabel(OraculumSymbol.Search, "查询原回执") }
                OutlinedButton({ actions.onRefreshOperationThread(operation.operationId) }, enabled = state.online && !state.busy,
                    modifier = Modifier.fillMaxWidth().testTag("refresh-operation-${operation.operationId}")) { ActionLabel(OraculumSymbol.Refresh, "只读刷新原生线程") }
                if (state.canStop && operation.threadId == state.selectedThreadId) OutlinedButton(actions.onStop, enabled = state.online,
                    modifier = Modifier.fillMaxWidth().testTag("unknown-stop")) { ActionLabel(OraculumSymbol.Stop, "停止已确认的活动 Turn") }
            }
        }
        MutedText("只有 Gateway / Codex 的事实能确认接受或拒绝。404、无回执、断网和清理缓存都不表示请求未发送。")
        MutedText("若仍无法确认，请在主机侧检查对应原生线程、Turn 和 Gateway 回执；保留 operationId 供人工核查。不要重新配对、重新注册或换设备重发同一请求。")
        OutlinedButton(actions.onRefresh, enabled = state.online && !state.busy, modifier = Modifier.fillMaxWidth()) { ActionLabel(OraculumSymbol.Refresh, "刷新可读状态") }
    }
}
