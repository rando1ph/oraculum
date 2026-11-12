package dev.oraculum.poc.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.*
import java.text.NumberFormat
import kotlin.math.roundToInt

/** A ratio is shown only for compatible, known native counts. */
internal fun usageRatio(numerator: Long?, denominator: Long?): Float? =
    if (numerator != null && denominator != null && denominator > 0 && numerator in 0..denominator)
        (numerator.toDouble() / denominator.toDouble()).toFloat() else null

@Composable
internal fun TokenUsageCard(usage: TokenUsageUi) {
    val numbers = NumberFormat.getIntegerInstance()
    OraculumCard {
        Text("最近一次请求", style = MaterialTheme.typography.titleSmall)
        TokenValues(usage.last, numbers)
        usageRatio(usage.last.totalTokens, usage.modelContextWindow)?.let { ratio ->
            UsageMeter("上下文", ratio, "${numbers.format(usage.last.totalTokens)} / ${numbers.format(usage.modelContextWindow)}", "usage-context-progress")
        } ?: usage.modelContextWindow?.let { Text("上下文上限 ${numbers.format(it)} tokens", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        usageRatio(usage.last.cachedInputTokens, usage.last.inputTokens)?.let { ratio ->
            UsageMeter("缓存命中", ratio, "${numbers.format(usage.last.cachedInputTokens)} / ${numbers.format(usage.last.inputTokens)} 输入 tokens", "usage-cache-progress")
        }
        HorizontalDivider()
        Text("会话累计", style = MaterialTheme.typography.titleSmall)
        TokenValues(usage.total, numbers)
    }
}

@Composable
private fun TokenValues(counts: TokenCountsUi, numbers: NumberFormat) {
    val fields = listOf("总计" to counts.totalTokens, "输入" to counts.inputTokens, "输出" to counts.outputTokens,
        "缓存输入" to counts.cachedInputTokens, "缓存写入" to counts.cacheWriteInputTokens, "推理输出" to counts.reasoningOutputTokens)
        .filter { it.second != null }
    if (fields.isEmpty()) Text("尚未返回用量", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    else Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        fields.chunked(2).forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                row.forEach { (label, count) ->
                    Column(Modifier.weight(1f)) {
                        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(numbers.format(count), style = MaterialTheme.typography.titleMedium.copy(fontFeatureSettings = "tnum"))
                    }
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun UsageMeter(label: String, ratio: Float, detail: String, tag: String) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.semantics(mergeDescendants = true) {
        contentDescription = "$label ${(ratio * 100).roundToInt()}%，$detail"
    }) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(label, style = MaterialTheme.typography.labelMedium)
            Text("${(ratio * 100).roundToInt()}%", style = MaterialTheme.typography.labelLarge)
        }
        LinearProgressIndicator(progress = { ratio }, modifier = Modifier.fillMaxWidth().height(6.dp).testTag(tag))
        Text(detail, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

internal fun extensionSectionTitle(kind: String) = when (kind) {
    "mcp" -> "MCP 服务"
    "skills" -> "Skills"
    "apps" -> "Apps"
    "plugins" -> "Plugins"
    else -> "扩展"
}

internal fun extensionUnavailableReason(kind: String, reason: String?) = when {
    kind == "plugins" -> "当前版本暂未开放插件目录。"
    reason == "STABILITY_UNVERIFIED" -> "当前版本暂未开放此目录。"
    else -> "暂时无法读取，请刷新或检查主机连接。"
}

/** The legacy display projection contains JSON-valued lines; expose only useful named facts. */
internal fun extensionEntryDescription(body: String): String {
    val fields = body.lineSequence().mapNotNull { line ->
        val split = line.indexOf(": ")
        if (split < 1) null else runCatching { line.take(split) to Json.parseToJsonElement(line.substring(split + 2)).jsonPrimitive }.getOrNull()
    }.toMap()
    val parts = mutableListOf<String>()
    fields["description"]?.contentOrNull?.takeIf { it.isNotBlank() }?.let { parts += it }
    val counts = listOf("toolCount" to "工具", "resourceCount" to "资源").mapNotNull { (key, label) ->
        fields[key]?.longOrNull?.takeIf { it >= 0 }?.let { "$label $it" }
    }
    if (counts.isNotEmpty()) parts += counts.joinToString(" · ")
    val states = mutableListOf<String>()
    fields["enabled"]?.booleanOrNull?.let { states += if (it) "已启用" else "已停用" }
    fields["callable"]?.booleanOrNull?.let { states += if (it) "可调用" else "暂不可调用" }
    fields["status"]?.contentOrNull?.split(" / ")?.mapNotNull { when (it) {
        "ready", "connected", "running" -> "已连接"
        "authenticated", "oauth", "bearerToken" -> "已认证"
        "notLoggedIn" -> "需要登录"
        "failed", "error", "disconnected" -> "连接异常"
        else -> null
    } }?.let(states::addAll)
    if (states.isNotEmpty()) parts += states.distinct().joinToString(" · ")
    return parts.joinToString("\n")
}
