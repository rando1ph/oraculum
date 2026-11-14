package dev.oraculum.poc.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.oraculum.gateway.protocol.RateLimitsClass
import dev.oraculum.gateway.protocol.RateLimitsRateLimitWindow
import java.text.DateFormat
import java.text.NumberFormat
import java.util.Date

private fun readableTime(milliseconds: Long): String =
    runCatching { DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(milliseconds)) }.getOrDefault("时间未知")

private fun resetTime(seconds: Long?): String? = seconds?.takeIf { it in 0..Long.MAX_VALUE / 1000 }
    ?.let { "重置 " + readableTime(it * 1000) }

internal fun quotaWindowLabel(minutes: Long?, fallback: String): String = when {
    minutes == null || minutes <= 0 -> fallback
    minutes % 1440L == 0L -> "${minutes / 1440} 天"
    minutes % 60L == 0L -> "${minutes / 60} 小时"
    else -> "$minutes 分钟"
}

internal fun quotaRemaining(usedPercent: Long): Long? = usedPercent.takeIf { it in 0..100 }?.let { 100 - it }

@Composable
internal fun AccountQuotaFooter(state: PocUiState, actions: PocActions) {
    var details by rememberSaveable { mutableStateOf(false) }
    val quota = state.accountRateLimits
    val windows = listOfNotNull(quota?.rateLimits?.primary?.let { Triple("primary", "主窗口", it) },
        quota?.rateLimits?.secondary?.let { Triple("secondary", "次窗口", it) })
    val summary = windows.map { (_, label, window) ->
        "${quotaWindowLabel(window.windowDurationMins, label)} ${quotaRemaining(window.usedPercent)?.let { "$it%" } ?: "未知"}"
    }.joinToString(" · ")
    Column(Modifier.fillMaxWidth().clickable { details = true }.padding(horizontal = 16.dp, vertical = 12.dp)
        .testTag("account-quota").semantics { contentDescription = "查看账户剩余额度" },
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OraculumIcon(OraculumSymbol.DataUsage, tint = MaterialTheme.colorScheme.onSurfaceVariant, size = 18.dp)
            Text("剩余额度", Modifier.weight(1f), style = MaterialTheme.typography.labelMedium)
            if (state.accountRefreshing) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
            else Text(when {
                summary.isNotBlank() -> summary
                quota?.rateLimits?.credits?.unlimited == true -> "Credits 不限额"
                quota != null -> "查看详情"
                else -> "暂不可用"
            }, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(2f))
            OraculumIcon(OraculumSymbol.ChevronRight, size = 16.dp, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        windows.forEach { (key, label, window) ->
            quotaRemaining(window.usedPercent)?.let { remaining ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (windows.size > 1) Text(quotaWindowLabel(window.windowDurationMins, label), style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    LinearProgressIndicator(progress = { remaining / 100f },
                        modifier = Modifier.weight(1f).height(3.dp).testTag("account-quota-progress-$key"))
                }
            }
        }
        quota?.let { Text("${when { !state.online -> "离线 · "; state.accountError != null -> "更新失败 · "; else -> "" }}读取于 ${readableTime(it.readAt)}",
            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
    if (details) AlertDialog(onDismissRequest = { details = false }, modifier = Modifier.testTag("account-details"),
        title = { Text("账户额度与用量") },
        text = {
            Column(Modifier.fillMaxWidth().heightIn(max = 480.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(14.dp)) {
                if (!state.online) MutedText("离线时显示上次读取的数据。")
                state.accountError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                if (quota == null) MutedText("暂未取得账户额度。")
                quota?.let { value ->
                    QuotaSnapshot(value.rateLimits)
                    value.rateLimitsByLimitID?.values?.filter { it != value.rateLimits }?.forEach { snapshot ->
                        HorizontalDivider()
                        QuotaSnapshot(snapshot)
                    }
                    value.ordinaryUsageAllowed?.let { MutedText(if (it) "当前允许普通用量" else "当前普通用量受限") }
                    value.resetCreditsAvailable?.let { MutedText("可用重置额度：$it") }
                    if (value.limited) MutedText("当前返回的信息可能不完整。")
                    MutedText("读取于 ${readableTime(value.readAt)}")
                }
                state.accountUsage?.let { usage ->
                    HorizontalDivider()
                    Text("累计用量", style = MaterialTheme.typography.titleSmall)
                    val summaryUsage = usage.summary
                    summaryUsage.lifetimeTokens?.let { AccountFact("累计 tokens", NumberFormat.getIntegerInstance().format(it)) }
                    summaryUsage.peakDailyTokens?.let { AccountFact("单日最高 tokens", NumberFormat.getIntegerInstance().format(it)) }
                    summaryUsage.currentStreakDays?.let { AccountFact("连续使用", "$it 天") }
                    summaryUsage.longestStreakDays?.let { AccountFact("最长连续使用", "$it 天") }
                    summaryUsage.longestRunningTurnSEC?.let { AccountFact("最长执行", "$it 秒") }
                    usage.dailyUsageBuckets?.takeLast(7)?.let { days ->
                        if (days.isNotEmpty()) {
                            Text("最近返回的日用量", style = MaterialTheme.typography.labelLarge)
                            days.forEach { AccountFact(it.startDate, NumberFormat.getIntegerInstance().format(it.tokens)) }
                        }
                    }
                    if (usage.limited) MutedText("累计用量可能不完整。")
                    MutedText("读取于 ${readableTime(usage.readAt)}")
                }
            }
        },
        confirmButton = { TextButton({ details = false }) { Text("关闭") } },
        dismissButton = { TextButton(actions.onRefreshAccount, enabled = state.online && !state.accountRefreshing,
            modifier = Modifier.testTag("refresh-account")) { Text(if (state.accountRefreshing) "刷新中…" else "刷新") } })
}

@Composable
private fun QuotaSnapshot(snapshot: RateLimitsClass) {
    snapshot.limitName?.takeIf(String::isNotBlank)?.let { Text(it, style = MaterialTheme.typography.titleSmall) }
    snapshot.planType?.takeIf(String::isNotBlank)?.let { MutedText(it) }
    snapshot.primary?.let { QuotaWindow(it, "主窗口") }
    snapshot.secondary?.let { QuotaWindow(it, "次窗口") }
    snapshot.individualLimit?.let { limit ->
        val remaining = limit.remainingPercent.takeIf { it in 0..100 }
        AccountFact("独立额度", remaining?.let { "剩余 $it%" } ?: "未知")
        AccountFact("已用／上限", "${limit.used} / ${limit.limit}")
        resetTime(limit.resetsAt)?.let { MutedText(it) }
    }
    snapshot.credits?.let { credits ->
        AccountFact("Credits", when {
            credits.unlimited -> "不限额"
            credits.balance != null -> credits.balance
            credits.hasCredits -> "有可用额度"
            else -> "无可用额度"
        })
    }
    if (snapshot.spendControlReached == true) MutedText("已达到消费控制限额。")
    snapshot.rateLimitReachedType?.takeIf(String::isNotBlank)?.let { MutedText("当前限额状态：$it") }
    if (snapshot.primary == null && snapshot.secondary == null && snapshot.individualLimit == null && snapshot.credits == null)
        MutedText("本次未返回可展示的额度窗口。")
}

@Composable
private fun QuotaWindow(window: RateLimitsRateLimitWindow, fallback: String) {
    val remaining = quotaRemaining(window.usedPercent)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        AccountFact(quotaWindowLabel(window.windowDurationMins, fallback), remaining?.let { "剩余 $it%" } ?: "未知")
        if (remaining != null) LinearProgressIndicator(progress = { remaining / 100f }, modifier = Modifier.fillMaxWidth().height(4.dp))
        resetTime(window.resetsAt)?.let { MutedText(it) }
    }
}

@Composable
private fun AccountFact(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
internal fun NativeDefaultsDetails(state: PocUiState, actions: PocActions, onDismiss: () -> Unit) {
    val defaults = state.nativeDefaults
    val oled = LocalOledTheme.current
    AlertDialog(onDismissRequest = onDismiss, modifier = Modifier.testTag("native-defaults"),
        containerColor = if (oled) Color.Black else AlertDialogDefaults.containerColor,
        tonalElevation = if (oled) 0.dp else AlertDialogDefaults.TonalElevation,
        title = { Text("执行设置") },
        text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("默认设置", style = MaterialTheme.typography.titleSmall)
                state.nativeDefaultsError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                AccountFact("模型", defaults?.model ?: "尚未取得")
                AccountFact("思考强度", defaults?.effort ?: "尚未取得")
                AccountFact("沙箱", when (defaults?.sandboxMode?.value) {
                    "read-only" -> "只读"; "workspace-write" -> "工作区写入"; "danger-full-access" -> "完整主机权限"; else -> "尚未取得"
                })
                AccountFact("审批", when (defaults?.approvalPolicy?.value) {
                    "never" -> "无需审批"; "on-request" -> "按需审批"; "untrusted" -> "不受信任操作需审批"
                    "on-failure" -> "失败后审批"; "custom" -> "自定义审批"; else -> "尚未取得"
                })
                defaults?.workspaceWriteNetworkAccess?.let { AccountFact("工作区写入网络", if (it) "允许" else "不允许") }
                defaults?.let { MutedText("读取于 ${readableTime(it.readAt)}") }
                if (state.actualModel != null || state.actualEffort != null || state.permissionReadback != null) {
                    HorizontalDivider()
                    Text("当前会话", style = MaterialTheme.typography.titleSmall)
                    AccountFact("模型", state.actualModel ?: "尚未取得")
                    AccountFact("思考强度", state.actualEffort ?: "尚未取得")
                    state.permissionReadback?.let { AccountFact("权限", permissionReadbackLabel(it)) }
                }
            }
        },
        confirmButton = { TextButton(onDismiss) { Text("关闭") } },
        dismissButton = { TextButton(actions.onRefreshNativeDefaults, enabled = state.online && !state.busy) { Text("刷新") } })
}

private fun threadWriteEnabled(state: PocUiState, threadId: String): Boolean =
    state.online && !state.busy && state.unknownWarning == null && state.unresolvedOperations.isEmpty() &&
        (threadId != state.selectedThreadId || state.canManageThread)

@Composable
internal fun NativeThreadRow(thread: ThreadOption, state: PocUiState, actions: PocActions, onSelect: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    var dialog by rememberSaveable { mutableStateOf<String?>(null) }
    var name by rememberSaveable(thread.id, thread.label) { mutableStateOf(thread.label) }
    val selected = thread.id == state.selectedThreadId
    val detail = when (thread.detail) {
        "idle", "active", "notLoaded" -> ""
        "systemError" -> "会话异常"
        else -> thread.detail
    }
    val canWrite = threadWriteEnabled(state, thread.id)
    val capabilities = state.capabilityNames
    val hasMenu = listOf("thread.name.set", "thread.archive", "thread.unarchive", "thread.delete").any { it in capabilities }
    Surface(color = if (selected) MaterialTheme.colorScheme.secondaryContainer else androidx.compose.ui.graphics.Color.Transparent,
        shape = RoundedCornerShape(16.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).heightIn(min = 56.dp).clickable(enabled = !state.busy && !thread.archived, onClick = onSelect)
                .testTag("thread-${thread.id}").semantics { this.selected = selected }.padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OraculumIcon(if (thread.archived) OraculumSymbol.History else OraculumSymbol.Chat, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(thread.label, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleSmall)
                    if (detail.isNotBlank()) Text(detail, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (hasMenu) Box {
                IconButton({ menu = true }, Modifier.size(48.dp).testTag("thread-menu-${thread.id}")) {
                    Text("⋯", style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { contentDescription = "管理会话 ${thread.label}" })
                }
                DropdownMenu(menu, { menu = false }) {
                    if ("thread.name.set" in capabilities) DropdownMenuItem(text = { Text("重命名") }, enabled = canWrite,
                        modifier = Modifier.testTag("thread-rename-${thread.id}"), onClick = { menu = false; name = thread.label; dialog = "rename" })
                    if (thread.archived && "thread.unarchive" in capabilities) DropdownMenuItem(text = { Text("恢复会话") }, enabled = canWrite,
                        modifier = Modifier.testTag("thread-restore-${thread.id}"), onClick = { menu = false; actions.onUnarchiveThread(thread.id) })
                    if (!thread.archived && "thread.archive" in capabilities) DropdownMenuItem(text = { Text("归档") }, enabled = canWrite,
                        modifier = Modifier.testTag("thread-archive-${thread.id}"), onClick = { menu = false; dialog = "archive" })
                    if ("thread.delete" in capabilities) DropdownMenuItem(text = { Text("删除", color = MaterialTheme.colorScheme.error) }, enabled = canWrite,
                        modifier = Modifier.testTag("thread-delete-${thread.id}"), onClick = { menu = false; dialog = "delete" })
                }
            }
        }
    }
    if (dialog == "rename") AlertDialog(onDismissRequest = { dialog = null }, title = { Text("重命名会话") },
        text = { OutlinedTextField(name, { name = it.take(200) }, label = { Text("会话名称") }, singleLine = true, modifier = Modifier.testTag("thread-name-input")) },
        confirmButton = { TextButton({ actions.onRenameThread(thread.id, name.trim()); dialog = null }, enabled = canWrite && name.isNotBlank(),
            modifier = Modifier.testTag("confirm-thread-rename")) { Text("保存") } },
        dismissButton = { TextButton({ dialog = null }) { Text("取消") } })
    if (dialog == "archive" || dialog == "delete") {
        val deleting = dialog == "delete"
        AlertDialog(onDismissRequest = { dialog = null }, icon = { OraculumIcon(if (deleting) OraculumSymbol.Delete else OraculumSymbol.History) },
            title = { Text(if (deleting) "永久删除会话？" else "归档会话？") },
            text = { Text(if (deleting) "将永久删除「${thread.label}」及其关联的后代会话历史，无法恢复。工作区文件不会删除。"
                else "「${thread.label}」及其关联的后代会话将移入归档，可从已归档列表恢复。工作区文件不受影响。") },
            confirmButton = { TextButton({
                if (deleting) actions.onDeleteThread(thread.id) else actions.onArchiveThread(thread.id)
                dialog = null
            }, enabled = canWrite, modifier = Modifier.testTag(if (deleting) "confirm-thread-delete" else "confirm-thread-archive")) {
                Text(if (deleting) "永久删除" else "归档", color = if (deleting) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
            } },
            dismissButton = { TextButton({ dialog = null }) { Text("取消") } })
    }
}

@Composable
internal fun TurnToolsMenu(turnId: String, state: PocUiState, actions: PocActions, copyText: String, menuKey: String = turnId) {
    var menu by remember(menuKey) { mutableStateOf(false) }
    var revert by rememberSaveable(menuKey) { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    val oled = LocalOledTheme.current
    val canWrite = turnId.isNotBlank() && state.canManageThread && state.online && !state.busy && state.unknownWarning == null && state.unresolvedOperations.isEmpty()
    if (turnId.isNotBlank() || copyText.isNotBlank()) Box {
        IconButton({ menu = true }, Modifier.size(48.dp).testTag("turn-tools-$menuKey")) {
            Text("⋯", style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { contentDescription = if (turnId.isBlank()) "回答操作" else "此轮历史操作" })
        }
        DropdownMenu(menu, { menu = false },
            containerColor = if (oled) Color.Black else MaterialTheme.colorScheme.surfaceContainerHigh,
            tonalElevation = if (oled) 0.dp else MenuDefaults.TonalElevation) {
            DropdownMenuItem(text = { Text("复制") }, enabled = copyText.isNotEmpty(),
                leadingIcon = { OraculumIcon(OraculumSymbol.Copy) },
                colors = MenuDefaults.itemColors(textColor = MaterialTheme.colorScheme.primary, leadingIconColor = MaterialTheme.colorScheme.primary),
                modifier = Modifier.testTag("copy-turn-$menuKey"),
                onClick = { clipboard.setText(AnnotatedString(copyText)); menu = false })
            if (turnId.isNotBlank() && "thread.fork" in state.capabilityNames) DropdownMenuItem(text = { Text("分叉") }, enabled = canWrite,
                leadingIcon = { OraculumIcon(OraculumSymbol.Fork) },
                modifier = Modifier.testTag("fork-turn-$menuKey"), onClick = { menu = false; actions.onForkThread(turnId) })
            if (turnId.isNotBlank() && "thread.revert" in state.capabilityNames) DropdownMenuItem(text = { Text("撤回") }, enabled = canWrite,
                leadingIcon = { OraculumIcon(OraculumSymbol.History) },
                modifier = Modifier.testTag("revert-turn-$menuKey"), onClick = { menu = false; revert = true })
        }
    }
    if (revert) AlertDialog(onDismissRequest = { revert = false }, icon = { OraculumIcon(OraculumSymbol.History) },
        containerColor = if (oled) Color.Black else AlertDialogDefaults.containerColor,
        tonalElevation = if (oled) 0.dp else AlertDialogDefaults.TonalElevation,
        title = { Text("撤回此轮及后续历史？") },
        text = { Text("会话将回到此轮开始之前。此轮及之后的会话历史会被撤回；已经发生的工作区文件修改不会恢复。") },
        confirmButton = { TextButton({ actions.onRevertThread(turnId); revert = false }, enabled = canWrite,
            modifier = Modifier.testTag("confirm-revert-turn")) { Text("撤回历史") } },
        dismissButton = { TextButton({ revert = false }) { Text("取消") } })
}
