@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package dev.oraculum.poc.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
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
    var chooseModel by remember { mutableStateOf(false) }
    val selected = state.models.firstOrNull { it.id == state.selectedModel }
    PanelHeading("模型与思考强度", onClose)
    Column(Modifier.heightIn(max = 560.dp).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        MutedText("用于下一次执行")
        OraculumCard(CardRole.Inset) {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(enabled = state.models.isNotEmpty()) { chooseModel = !chooseModel }
                .testTag("choose-model").semantics { role = Role.Button; stateDescription = if (chooseModel) "已展开模型列表" else "已收起模型列表" },
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OraculumIcon(OraculumSymbol.Model, tint = MaterialTheme.colorScheme.primary)
                Text(selected?.label ?: "选择模型", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                OraculumIcon(if (chooseModel) OraculumSymbol.ExpandLess else OraculumSymbol.ExpandMore)
            }
            selected?.let { model ->
                if (model.description.isNotBlank()) Text(model.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text("思考强度", style = MaterialTheme.typography.labelLarge)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    model.efforts.forEach { effort ->
                        FilterChip(selected = state.selectedEffort == effort, onClick = { actions.onSelectEffort(effort) }, enabled = !state.busy,
                            label = { Text(effort) }, modifier = Modifier.heightIn(min = 48.dp).testTag("effort-$effort"))
                    }
                }
                if (model.efforts.isEmpty()) MutedText("此模型使用默认思考强度。")
            }
        }
        if (chooseModel || selected == null) {
            state.models.forEach { model ->
                NavigationRow(model.label, "", state.selectedModel == model.id, "model-${model.id}", !state.busy) {
                    actions.onSelectModel(model.id); chooseModel = false
                }
            }
        }
        if (state.models.isEmpty()) MutedText("连接后刷新可用模型。")
        if (state.modelsLimited) MutedText("这里只显示已加载的可用模型。")
        state.actualModel?.let { actual ->
            MutedText("最近执行：$actual${state.actualEffort?.let { " · $it" }.orEmpty()}")
        }
    }
}

@Composable
internal fun ColumnScope.PermissionPanel(state: PocUiState, actions: PocActions, onClose: () -> Unit) {
    var confirmFull by remember { mutableStateOf(false) }
    var details by remember { mutableStateOf(false) }
    PanelHeading("执行权限", onClose)
    Column(Modifier.heightIn(max = 560.dp).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("下一次执行", style = MaterialTheme.typography.titleSmall)
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            NavigationRow("Read only", "只读沙箱；写入和受限操作仍遵循原生审批。", state.permissionPreset == "read-only", "permission-read-only", !state.busy, symbol = OraculumSymbol.Shield, detailMaxLines = Int.MAX_VALUE) { actions.onSelectPermission("read-only", false) }
            NavigationRow("Auto", "允许工作区内写入；提升权限仍需原生审批。", state.permissionPreset == "auto", "permission-auto", !state.busy, symbol = OraculumSymbol.Folder, detailMaxLines = Int.MAX_VALUE) { actions.onSelectPermission("auto", false) }
            NavigationRow("Full access", "取消沙箱限制，可修改工作区外文件并访问网络。", state.permissionPreset == "full-access", "permission-full-access", !state.busy, symbol = OraculumSymbol.Warning, detailMaxLines = Int.MAX_VALUE) { confirmFull = true }
        }
        HorizontalDivider()
        val readback = state.permissionReadback
        Text("最近确认：${when (readback?.preset) { "read-only" -> "Read only"; "auto" -> "Auto"; "full-access" -> "Full access"; else -> if (readback == null) "尚无执行记录" else "自定义权限" }}", style = MaterialTheme.typography.bodyMedium)
        MutedText("上方选择不会改写主机默认配置；实际权限以执行时确认的状态为准。")
        if (readback != null) {
            TextButton({ details = !details }) { Text(if (details) "收起权限详情" else "权限详情") }
            if (details) OraculumCard(CardRole.Inset) {
                Text("沙箱：${readback.sandboxType}\n审批策略：${readback.approvalPolicy}", style = MaterialTheme.typography.bodySmall)
                MutedText("${DateFormat.getDateTimeInstance().format(Date(readback.observedAt))} · ${readback.source}")
            }
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
        listOf(Triple("diff", "Diff", OraculumSymbol.Difference), Triple("output", "输出", OraculumSymbol.Terminal),
            Triple("files", "文件", OraculumSymbol.Folder), Triple("usage", "用量", OraculumSymbol.DataUsage),
            Triple("extensions", "Skills", OraculumSymbol.Extension)).forEach { (id, label, symbol) ->
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
                state.inspector.tokenUsage?.let { TokenUsageCard(it) }
                    ?: PanelEmptyState(OraculumSymbol.DataUsage, "本次尚未取得用量。执行后如有返回，将在这里显示。")
            }
            if (tab == "extensions") {
                SectionLabel("Skills", OraculumSymbol.Extension)
                if (state.inspector.extensions.isEmpty()) PanelEmptyState(OraculumSymbol.Extension, "连接后刷新，查看可用的 Skills 与扩展。")
                state.inspector.extensions.sortedBy { listOf("skills", "mcp", "apps", "plugins").indexOf(it.kind).let { index -> if (index < 0) Int.MAX_VALUE else index } }.forEach { section ->
                    OraculumCard {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            OraculumIcon(OraculumSymbol.Extension, tint = MaterialTheme.colorScheme.primary)
                            Text(extensionSectionTitle(section.kind), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                            Text(if (section.status == "available") "${section.entries.size} 项" else if (section.reason == "STABILITY_UNVERIFIED") "暂未开放" else "暂不可用", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (section.status != "available") MutedText(extensionUnavailableReason(section.kind, section.reason))
                        section.entries.forEach { entry ->
                            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                            Text(entry.title, fontWeight = FontWeight.Medium, style = MaterialTheme.typography.bodyMedium)
                            extensionEntryDescription(entry.body).takeIf { it.isNotBlank() }?.let { MutedText(it) }
                        }
                        if (section.entries.isEmpty() && section.status == "available") MutedText("尚无已配置的${extensionSectionTitle(section.kind)}。")
                        if (section.limited) MutedText("显示已取得的结果，清单可能不完整。")
                    }
                }
            }
            state.inspector.detailTitle?.let { title ->
                SectionLabel("完整 Item 详情", OraculumSymbol.Code)
                IdentifierRow("Item", title)
                state.inspector.detailProgress?.let { MutedText(it) }
                state.inspector.detailText?.let { CodeBlock(it, "完整 Item") }
            }
            OutlinedButton(actions.onRefreshInspector, enabled = state.online && !state.busy, modifier = Modifier.fillMaxWidth().testTag("refresh-inspector")) {
                ActionLabel(OraculumSymbol.Refresh, "刷新")
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
    var storageOpen by remember { mutableStateOf(false) }
    var notificationDetails by remember { mutableStateOf(false) }
    var userLabel by remember(state.userLabel) { mutableStateOf(state.userLabel) }
    var assistantLabel by remember(state.assistantLabel) { mutableStateOf(state.assistantLabel) }
    var readingScale by remember(state.readingScale) { mutableFloatStateOf(state.readingScale) }
    PanelHeading("设置", onClose)
    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        SectionLabel("外观", OraculumSymbol.Palette)
        OraculumCard {
            ThemeSelector(state.themeMode, actions.onThemeChange)
            HorizontalDivider()
            Text("强调色", style = MaterialTheme.typography.titleSmall)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                accentOptions.forEach { accent ->
                    FilterChip(selected = state.accentColor == accent.key, onClick = { actions.onAccentChange(accent.key) },
                        label = { Text(accent.label) }, leadingIcon = {
                            Box(Modifier.size(18.dp).background(if (state.themeMode == "light") accent.light else accent.dark, CircleShape))
                        }, modifier = Modifier.heightIn(min = 48.dp).testTag("accent-${accent.key}"))
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
            MutedText("其余控件遵循系统字号。")
        }
        SectionLabel("称呼与身份", OraculumSymbol.Person)
        OraculumCard {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                UserAvatar(state.avatarFileName, userLabel.ifBlank { state.userLabel }, Modifier.testTag("avatar-preview"), 56.dp)
                Column(Modifier.weight(1f)) {
                    Text(userLabel.ifBlank { state.userLabel }, style = MaterialTheme.typography.titleMedium)
                    Text("你的本机显示身份", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(actions.onPickAvatar, Modifier.testTag("avatar-pick")) { Text(if (state.avatarFileName == null) "选择头像" else "更换头像") }
                if (state.avatarFileName != null) TextButton(actions.onRemoveAvatar, Modifier.testTag("avatar-remove")) { Text("移除头像") }
            }
            OutlinedTextField(userLabel, { if (it.length <= 40) userLabel = it }, label = { Text("你的称呼") }, singleLine = true,
                leadingIcon = { OraculumIcon(OraculumSymbol.Person) }, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth().testTag("identity-user"))
            OutlinedTextField(assistantLabel, { if (it.length <= 40) assistantLabel = it }, label = { Text("助手称呼") }, singleLine = true,
                leadingIcon = { OracleEyeMark() }, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth().testTag("identity-assistant"))
            FilledTonalButton({ actions.onIdentityLabelsChange(userLabel, assistantLabel) }, enabled = userLabel.isNotBlank() && assistantLabel.isNotBlank(),
                modifier = Modifier.fillMaxWidth().testTag("identity-save")) { ActionLabel(OraculumSymbol.Check, "保存称呼") }
            MutedText("头像自动保存到本机，仅用于显示。称呼与头像不会发送给模型。")
        }
        SectionLabel("通知", OraculumSymbol.Notifications)
        OraculumCard {
            Text(if (notificationEnabled) "系统通知已开启" else "系统通知尚未开启", style = MaterialTheme.typography.titleSmall)
            OutlinedButton(onNotifications, Modifier.fillMaxWidth().testTag("notification-settings")) { ActionLabel(OraculumSymbol.Notifications, if (notificationEnabled) "管理通知" else "开启通知") }
            TextButton({ notificationDetails = !notificationDetails }) { Text(if (notificationDetails) "收起提醒说明" else "提醒何时可用") }
            if (notificationDetails) MutedText("应用或后台进程与连接仍存活时可提醒完成、审批和错误。系统回收、强制停止或省电限制后可能无法送达；返回应用会重新读取状态。")
        }
        SectionLabel("Gateway 连接", if (state.online) OraculumSymbol.Wifi else OraculumSymbol.WifiOff)
        OraculumCard {
            Text(if (state.online) "已连接" else state.connectionLabel, style = MaterialTheme.typography.titleSmall)
            SelectionContainer { Text(state.endpoint.ifBlank { "尚未设置 HTTPS 地址" }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            if (!state.online && !state.busy) OutlinedTextField(state.endpoint, actions.onEndpointChange, label = { Text("HTTPS 地址") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), modifier = Modifier.fillMaxWidth().testTag("settings-endpoint"))
            if (state.paired) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(actions.onReconnect, enabled = !state.busy, modifier = Modifier.weight(1f)) { ActionLabel(OraculumSymbol.Wifi, if (state.online) "重连" else "连接") }
                    OutlinedButton(actions.onRefresh, enabled = state.online && !state.busy, modifier = Modifier.weight(1f)) { ActionLabel(OraculumSymbol.Refresh, "刷新") }
                }
                if (state.busy) MutedText("正在处理，请稍候。")
                else if (!state.online) MutedText("连接后可刷新会话。")
                TextButton(actions.onDisconnect, modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant)) { Text("断开连接") }
            } else MutedText("首次连接需要主机生成的配对码。")
        }
        OraculumCard(CardRole.Inset) {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable { storageOpen = !storageOpen }.testTag("storage-settings")
                .semantics { role = Role.Button; stateDescription = if (storageOpen) "已展开" else "已收起" }, verticalAlignment = Alignment.CenterVertically) {
                Text("存储与修复", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                OraculumIcon(if (storageOpen) OraculumSymbol.ExpandLess else OraculumSymbol.ExpandMore)
            }
            if (storageOpen) {
                MutedText("历史缓存用于离线阅读。显示异常或需要释放空间时，可清理后联网重新读取；不会删除主机上的真实会话。")
                TextButton({ clearCacheOpen = true }, enabled = !state.busy, modifier = Modifier.fillMaxWidth().testTag("clear-cache")) { ActionLabel(OraculumSymbol.Delete, "清理历史缓存") }
            }
        }
    }
    if (clearCacheOpen) AlertDialog(onDismissRequest = { clearCacheOpen = false }, icon = { OraculumIcon(OraculumSymbol.Delete) }, title = { Text("清理本机历史缓存？") },
        text = { Text("清理本机保存的项目、会话列表与消息缓存，联网后重新读取。主机真实会话、未发送草稿、发送回执与未知操作记录都会保留。离线时将暂时无法查看已清理的历史。") },
        confirmButton = { TextButton({ actions.onClearCache(); clearCacheOpen = false }, Modifier.testTag("confirm-clear-cache")) { Text("清理缓存") } },
        dismissButton = { TextButton({ clearCacheOpen = false }) { Text("取消") } })
}

@Composable
private fun ThemeSelector(selected: String, onSelect: (String) -> Unit) {
    val options = listOf("light" to "Light", "dark" to "Dark", "oled" to "OLED Dark")
    val fontScale = LocalDensity.current.fontScale
    BoxWithConstraints {
        val compact = maxWidth >= 270.dp && fontScale <= 1.35f
        if (compact) {
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(14.dp)).selectableGroup()) {
                options.forEach { (mode, label) ->
                    ThemeChoice(mode, label, selected == mode, onSelect, Modifier.weight(1f))
                }
            }
        } else Column(Modifier.fillMaxWidth().selectableGroup(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            options.forEach { (mode, label) -> ThemeChoice(mode, label, selected == mode, onSelect, Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))) }
        }
    }
}

@Composable
private fun ThemeChoice(mode: String, label: String, selected: Boolean, onSelect: (String) -> Unit, modifier: Modifier) {
    Box(modifier.background(if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerLow)
        .selectable(selected, onClick = { onSelect(mode) }, role = Role.RadioButton).heightIn(min = 48.dp).padding(horizontal = 5.dp, vertical = 10.dp).testTag("theme-$mode"),
        contentAlignment = Alignment.Center) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface)
    }
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
