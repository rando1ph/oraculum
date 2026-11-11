package dev.oraculum.poc.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.distinctUntilChanged

@Composable
fun OraculumScreen(state: PocUiState, actions: PocActions) {
    var navigationOpen by rememberSaveable { mutableStateOf(false) }
    var settingsOpen by rememberSaveable { mutableStateOf(false) }
    var clearCacheOpen by remember { mutableStateOf(false) }
    val selectedThread = state.threads.firstOrNull { it.id == state.selectedThreadId }
    val selectedProject = state.projects.firstOrNull { it.id == state.selectedProjectId }

    Scaffold(
        modifier = Modifier.fillMaxSize().semantics { testTagsAsResourceId = true },
        topBar = {
            Surface(color = MaterialTheme.colorScheme.surfaceContainerLow) {
                Column(Modifier.statusBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        TextButton(onClick = { navigationOpen = true }, enabled = state.paired,
                            modifier = Modifier.testTag("navigation")) { Text("项目") }
                        Column(Modifier.weight(1f).padding(horizontal = 4.dp)) {
                            Text(selectedThread?.label ?: "神谕 · Oraculum", maxLines = 1,
                                overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium)
                            Text(selectedProject?.label ?: "Android 原生 PoC", maxLines = 1,
                                overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        TextButton(onClick = { settingsOpen = true }, modifier = Modifier.testTag("settings")) { Text("连接") }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.width(6.dp).height(6.dp).background(
                            if (state.online) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.outline,
                            RoundedCornerShape(3.dp)))
                        Text(state.connectionLabel, Modifier.padding(start = 8.dp).weight(1f),
                            style = MaterialTheme.typography.labelSmall, maxLines = 2,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (state.paired && !state.online) TextButton(onClick = actions.onReconnect,
                            enabled = !state.busy, modifier = Modifier.testTag("reconnect")) { Text("重连") }
                    }
                    if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 4.dp))
                }
            }
        },
        bottomBar = {
            if (state.paired && state.selectedThreadId != null) Composer(state, actions)
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            state.error?.let { Notice(it, isError = true) }
            state.unknownWarning?.let { Notice(it) }
            if (!state.paired) {
                PairingForm(state, actions, Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp))
            } else if (state.selectedThreadId == null) {
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
                    verticalArrangement = Arrangement.Center) {
                    Text("选择一个会话", style = MaterialTheme.typography.headlineSmall)
                    Spacer(Modifier.height(12.dp))
                    Text(if (state.online) "从已注册的项目中选择会话，或明确新建。" else "离线时可以打开已缓存的会话。连接恢复后再新建或发送。",
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(20.dp))
                    Button(onClick = { navigationOpen = true }, modifier = Modifier.testTag("choose_thread")) { Text("打开项目与会话") }
                }
            } else {
                state.historyWarning?.let { Notice(it) }
                Conversation(state, actions, Modifier.weight(1f))
            }
        }
    }
    if (navigationOpen) NavigationDialog(state, actions, onDismiss = { navigationOpen = false })
    if (settingsOpen) AlertDialog(onDismissRequest = { settingsOpen = false }, title = { Text("Gateway 连接") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SelectionContainer { Text(state.endpoint.ifBlank { "尚未设置 HTTPS 地址" }, style = MaterialTheme.typography.bodySmall) }
                Text(state.connectionLabel)
                if (!state.online && !state.busy) {
                    OutlinedTextField(state.endpoint, actions.onEndpointChange, label = { Text("HTTPS 地址") },
                        singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                        modifier = Modifier.fillMaxWidth().testTag("settings-endpoint"))
                }
                if (state.paired) {
                    OutlinedButton(actions.onReconnect, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("重新连接") }
                    OutlinedButton(actions.onRefresh, enabled = state.online && !state.busy, modifier = Modifier.fillMaxWidth()) { Text("刷新原生状态") }
                    OutlinedButton({ clearCacheOpen = true }, enabled = !state.busy, modifier = Modifier.fillMaxWidth().testTag("clear-cache")) { Text("清理可重建历史缓存") }
                    TextButton(actions.onDisconnect, modifier = Modifier.fillMaxWidth()) { Text("断开连接") }
                } else Text("使用主机 CLI 生成的一次性配对码。设备凭据仅保存在本机安全存储。")
            }
        }, confirmButton = { TextButton({ settingsOpen = false }) { Text("关闭") } })
    if (clearCacheOpen) AlertDialog(onDismissRequest = { clearCacheOpen = false }, title = { Text("清理历史缓存？") },
        text = { Text("项目、会话和消息缓存可以联网重建。未发送草稿、发送回执与未知操作记录将保留。") },
        confirmButton = { TextButton({ actions.onClearCache(); clearCacheOpen = false; settingsOpen = false }) { Text("清理缓存") } },
        dismissButton = { TextButton({ clearCacheOpen = false }) { Text("取消") } })
}

@Composable
private fun PairingForm(state: PocUiState, actions: PocActions, modifier: Modifier) {
    // Never persist the one-time code into saved instance state or screenshots.
    var code by remember { mutableStateOf("") }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("连接你的 Gateway", style = MaterialTheme.typography.headlineSmall)
        Text("填写 HTTPS 地址，再输入主机 CLI 生成的一次性配对码。", color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(state.endpoint, actions.onEndpointChange, label = { Text("HTTPS 地址") },
            placeholder = { Text("https://gateway.example/") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), enabled = !state.busy,
            modifier = Modifier.fillMaxWidth().testTag("endpoint"))
        OutlinedTextField(code, { code = it }, label = { Text("一次性配对码") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(), enabled = !state.busy,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth().testTag("pair-code"))
        Button(onClick = { val pairingCode = code; code = ""; actions.onPair(pairingCode) },
            enabled = !state.busy && state.endpoint.isNotBlank() && code.isNotBlank(),
            modifier = Modifier.fillMaxWidth().testTag("pair")) { Text("配对并连接") }
    }
}

@Composable
private fun NavigationDialog(state: PocUiState, actions: PocActions, onDismiss: () -> Unit) {
    var registerOpen by remember { mutableStateOf(false) }
    var rootId by remember(state.roots) { mutableStateOf(state.roots.firstOrNull()?.id.orEmpty()) }
    var relativePath by remember { mutableStateOf("") }
    val canWrite = state.online && !state.busy && state.unknownWarning == null
    AlertDialog(onDismissRequest = onDismiss, title = { Text("项目与会话") }, text = {
        Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("已注册项目", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            if (state.projects.isEmpty()) Text("还没有项目。连接后可从已授权目录注册。")
            state.projects.forEach { project ->
                OutlinedButton(onClick = { actions.onSelectProject(project.id) }, enabled = !state.busy,
                    modifier = Modifier.fillMaxWidth().testTag("project-${project.id}")) {
                    Column(Modifier.fillMaxWidth()) {
                        Text((if (project.id == state.selectedProjectId) "● " else "") + project.label, maxLines = 2)
                        if (project.detail.isNotBlank()) Text(project.detail, style = MaterialTheme.typography.bodySmall, maxLines = 2)
                    }
                }
            }
            TextButton({ registerOpen = !registerOpen }, enabled = canWrite, modifier = Modifier.testTag("register_project")) { Text("注册项目目录") }
            if (registerOpen) {
                Text("选择主机已授权根目录", style = MaterialTheme.typography.bodySmall)
                state.roots.forEach { root ->
                    TextButton({ rootId = root.id }, modifier = Modifier.fillMaxWidth()) { Text((if (rootId == root.id) "● " else "○ ") + root.label) }
                }
                OutlinedTextField(relativePath, { relativePath = it }, label = { Text("授权根目录下的相对子目录") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth().testTag("project_path"))
                Button({ actions.onRegisterProject(rootId, relativePath); registerOpen = false },
                    enabled = canWrite && rootId.isNotBlank() && relativePath.isNotBlank(), modifier = Modifier.testTag("confirm_register")) { Text("注册") }
            }
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            Text("会话", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            if (state.threads.isEmpty()) Text(if (state.selectedProjectId == null) "先选择项目。" else "此项目没有可用会话。")
            state.threads.forEach { thread ->
                OutlinedButton({ actions.onSelectThread(thread.id); onDismiss() }, enabled = !state.busy,
                    modifier = Modifier.fillMaxWidth().testTag("thread-${thread.id}")) {
                    Column(Modifier.fillMaxWidth()) {
                        Text((if (thread.id == state.selectedThreadId) "● " else "") + thread.label, maxLines = 2)
                        if (thread.detail.isNotBlank()) Text(thread.detail, style = MaterialTheme.typography.bodySmall, maxLines = 2)
                    }
                }
            }
            Button({ actions.onCreateThread(); onDismiss() }, enabled = canWrite && state.selectedProjectId != null,
                modifier = Modifier.fillMaxWidth().testTag("new-thread")) { Text("新建会话") }
            TextButton(actions.onRefresh, enabled = state.online && !state.busy, modifier = Modifier.fillMaxWidth()) { Text("刷新列表") }
        }
    }, confirmButton = { TextButton(onDismiss) { Text("关闭") } })
}

@Composable
private fun Conversation(state: PocUiState, actions: PocActions, modifier: Modifier) {
    val headerCount = if (state.canLoadMore) 1 else 0
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = state.readIndex.coerceAtLeast(0) + headerCount,
        initialFirstVisibleItemScrollOffset = state.readOffset.coerceAtLeast(0))
    var restoredThread by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(state.selectedThreadId, state.messages.isEmpty()) {
        if (state.messages.isNotEmpty() && restoredThread != state.selectedThreadId) {
            listState.scrollToItem(state.readIndex.coerceIn(0, state.messages.lastIndex) + headerCount, state.readOffset.coerceAtLeast(0))
            restoredThread = state.selectedThreadId
        }
    }
    LaunchedEffect(listState, state.selectedThreadId, headerCount) {
        snapshotFlow { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }
            .distinctUntilChanged().collect { (index, offset) ->
                if (restoredThread == state.selectedThreadId) {
                    actions.onReadPosition((index - headerCount).coerceAtLeast(0), if (index < headerCount) 0 else offset)
                }
            }
    }
    LazyColumn(modifier.fillMaxWidth().testTag("conversation"), state = listState,
        contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (state.canLoadMore) item(key = "history_controls") {
            OutlinedButton(actions.onLoadMore, enabled = state.online && !state.busy,
                modifier = Modifier.fillMaxWidth().testTag("load-more")) { Text("加载更早历史") }
        }
        if (state.messages.isEmpty()) item(key = "empty") {
            Text(if (state.online) "会话已准备好。输入消息后点击发送。" else "还没有缓存消息。联网后可读取原生历史；草稿可以继续编辑。",
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        items(state.messages, key = { it.id }) { message ->
            Card(colors = CardDefaults.cardColors(containerColor = if (message.role == "user")
                MaterialTheme.colorScheme.surfaceContainerLow else MaterialTheme.colorScheme.surfaceContainer),
                modifier = Modifier.fillMaxWidth().testTag("message_${message.id}"), shape = RoundedCornerShape(16.dp)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(when (message.role) { "user" -> "你"; "assistant" -> "Codex"; else -> message.role },
                            color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
                        if (message.status.isNotBlank()) Text(message.status, style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    SelectionContainer { BasicMarkdown(message.text) }
                }
            }
        }
    }
}

@Composable
private fun Composer(state: PocUiState, actions: PocActions) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Column(Modifier.navigationBarsPadding().imePadding().padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (state.executionLabel.isNotBlank()) Text(state.executionLabel, style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
            OutlinedTextField(state.draft, actions.onDraftChange, placeholder = { Text(if (state.online) "给 Codex 发消息…" else "离线草稿 · 联网后手动发送") },
                minLines = 2, maxLines = 5, modifier = Modifier.fillMaxWidth().testTag("draft"), shape = RoundedCornerShape(16.dp))
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(if (state.online) "草稿仅在本机保存" else "离线 · 只读缓存", Modifier.weight(1f),
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (state.canResume) OutlinedButton(actions.onResume, enabled = state.online && !state.busy,
                    modifier = Modifier.testTag("resume")) { Text("恢复会话") }
                if (state.canStop) OutlinedButton(actions.onStop, enabled = state.online,
                    modifier = Modifier.testTag("stop")) { Text("停止") }
                Button(actions.onSend, enabled = state.canSend && state.online && state.draft.isNotBlank(),
                    modifier = Modifier.testTag("send")) { Text("发送") }
            }
        }
    }
}

@Composable
private fun Notice(text: String, isError: Boolean = false) {
    Surface(color = if (isError) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surfaceContainerHigh) {
        SelectionContainer {
            Text(text, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                color = if (isError) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall)
        }
    }
}

/** Small, non-HTML renderer: headings, fenced code and inline emphasis remain readable. */
@Composable
private fun BasicMarkdown(text: String) {
    val color = MaterialTheme.colorScheme.primary
    val annotated = remember(text, color) {
        buildAnnotatedString {
            var inCode = false
            text.lineSequence().forEachIndexed { index, line ->
                if (index > 0) append('\n')
                if (line.trimStart().startsWith("```")) {
                    inCode = !inCode
                    withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = color)) { append(line.removePrefix("```").ifBlank { " " }) }
                } else if (inCode) {
                    withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(line) }
                } else if (Regex("^#{1,6}\\s").containsMatchIn(line)) {
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(line.replaceFirst(Regex("^#{1,6}\\s+"), "")) }
                } else {
                    var cursor = 0
                    Regex("(`[^`]+`|\\*\\*[^*]+\\*\\*)").findAll(line).forEach { match ->
                        append(line.substring(cursor, match.range.first))
                        val code = match.value.startsWith('`')
                        withStyle(if (code) SpanStyle(fontFamily = FontFamily.Monospace, color = color) else SpanStyle(fontWeight = FontWeight.Bold)) {
                            append(if (code) match.value.drop(1).dropLast(1) else match.value.drop(2).dropLast(2))
                        }
                        cursor = match.range.last + 1
                    }
                    append(line.substring(cursor))
                }
            }
        }
    }
    Text(annotated, style = MaterialTheme.typography.bodyMedium)
}
