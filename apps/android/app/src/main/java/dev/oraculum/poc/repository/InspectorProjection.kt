package dev.oraculum.poc.repository

import dev.oraculum.gateway.protocol.Effort
import dev.oraculum.poc.ui.*
import kotlinx.serialization.json.*
import java.io.ByteArrayOutputStream
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64

/** Read-only projections never authorize execution or infer absent native facts. */
class InspectorProjection {
    private val items = linkedMapOf<String, InspectorEntry>()
    private val types = mutableMapOf<String, String>()
    private val turns = linkedMapOf<String, InspectorEntry>()
    private var eventPlan = emptyList<InspectorEntry>()
    private var eventDiff: String? = null
    private var eventUsage: String? = null
    private var eventTokenUsage: TokenUsageUi? = null
    fun clear() { items.clear(); types.clear(); turns.clear(); eventPlan = emptyList(); eventDiff = null; eventUsage = null; eventTokenUsage = null }
    /** Display cache only; never used to establish current execution state. */
    fun restoreUsage(value: JsonObject?) {
        eventTokenUsage = value?.let { cached -> cached.string("turnId")?.takeIf { it.isNotBlank() }?.let { tokenUsage(cached, it) } }
        eventUsage = eventTokenUsage?.let(::formatUsage)
    }
    fun history(history: JsonObject, turnId: String? = null, replace: Boolean = false) {
        if (replace) {
            items.clear(); types.clear(); turns.clear()
            val presentTurns = history.array("items").mapNotNull { (it as? JsonObject)?.string("id") }.toSet()
            if (turnId == null && eventTokenUsage?.turnId != null && eventTokenUsage?.turnId !in presentTurns) {
                eventTokenUsage = null; eventUsage = null
            }
        }
        if (turnId != null) history.array("items").forEach { (it as? JsonObject)?.let { item(it, turnId, history.flag("truncated")) } }
        else history.array("items").forEach { value -> (value as? JsonObject)?.let { turn ->
            val id = turn.string("id").orEmpty()
            turns[id] = InspectorEntry("turn:$id", "Turn $id", turn.obj("error")?.string("message")?.take(4096).orEmpty(), turn.string("status").orEmpty(), id)
            while (turns.size > 100) turns.remove(turns.keys.first())
            turn.array("items").forEach { (it as? JsonObject)?.let { item(it, turn.string("id").orEmpty(), history.flag("truncated")) } }
        } }
    }
    fun item(value: JsonObject, turn: String, truncated: Boolean = false) {
        val id = value.string("id") ?: return
        val type = value.string("type") ?: return
        types[id] = type
        val body = when (type) {
            "commandExecution" -> listOfNotNull(value.string("command"), value.string("aggregatedOutput")?.take(128 * 1024), value.number("exitCode")?.let { "exitCode: $it" }, value.number("durationMs")?.let { "durationMs: $it" }).joinToString("\n")
            "fileChange" -> buildString {
                for (raw in value.array("changes")) {
                    if (length >= 128 * 1024) break
                    val change = raw as? JsonObject ?: continue
                    append(change.string("path").orEmpty().take(4096)); append('\n')
                    append(change["kind"]?.let { boundedJson(it, 4096) }.orEmpty()); append('\n')
                    append(change.string("diff").orEmpty().take((128 * 1024 - length).coerceAtLeast(0))); append("\n\n")
                }
            }
            "plan" -> value.string("text")?.take(128 * 1024) ?: boundedJson(value)
            else -> boundedJson(value)
        }
        items[id] = InspectorEntry(id, type, body.take(128 * 1024), value.string("status").orEmpty(), turn, id, truncated || body.length >= 128 * 1024)
        while (items.size > 250) { val oldest = items.keys.first(); items.remove(oldest); types.remove(oldest) }
    }
    fun event(event: JsonObject) {
        val payload = event.obj("payload") ?: return
        val scope = event.obj("scope") ?: return
        if (event.string("kind") in setOf("item.started", "item.completed")) {
            val wrapper = payload.obj("item") ?: return
            wrapper.obj("data")?.let { item(it, scope.string("turnId").orEmpty(), wrapper.flag("truncated")) }
            return
        }
        if (event.string("kind") != "native.state" || payload.flag("truncated")) return
        val data = payload.obj("data") ?: return
        when (payload.string("method")) {
            "turn/plan/updated" -> eventPlan = data.array("plan").mapIndexedNotNull { i, raw -> (raw as? JsonObject)?.let { step ->
                InspectorEntry("plan:$i", step.string("step") ?: return@let null, data.string("explanation").orEmpty(), step.string("status").orEmpty())
            } }
            "turn/diff/updated" -> eventDiff = data.string("diff")?.let { boundedContentPreview(sequenceOf(it)).displayText() }
            "thread/tokenUsage/updated" -> {
                val turn = data.string("turnId")?.takeIf { it.isNotBlank() } ?: return
                if (scope.string("turnId") != null && scope.string("turnId") != turn) return
                eventTokenUsage = data.obj("tokenUsage")?.let { tokenUsage(it, turn) }
                eventUsage = eventTokenUsage?.let(::formatUsage)
            }
        }
    }
    fun state(prior: InspectorUiState): InspectorUiState = prior.copy(
        execution = turns.values.toList() + items.values.filter { types[it.id] !in setOf("userMessage", "agentMessage", "plan", "fileChange") },
        plan = eventPlan.ifEmpty { items.values.filter { types[it.id] == "plan" } },
        diff = eventDiff ?: fileChangePreview(),
        agents = items.values.filter { types[it.id]?.startsWith("collab") == true }, usage = eventUsage, tokenUsage = eventTokenUsage,
    )
    private fun fileChangePreview(): String? {
        val changes = items.values.asSequence().filter { types[it.id] == "fileChange" }
        if (changes.none()) return null
        // Stop while aggregating; never allocate the full multi-Item diff first.
        return boundedContentPreview(changes.map { it.body }).displayText()
    }
    private fun formatUsage(value: TokenUsageUi): String = buildList {
        usageLine(value.total).takeIf { it.isNotEmpty() }?.let { add("累计：$it") }
        usageLine(value.last).takeIf { it.isNotEmpty() }?.let { add("最近用量：$it") }
        value.modelContextWindow?.let { add("模型上下文窗口：$it tokens") }
    }.joinToString("\n")
    private fun usageLine(v: TokenCountsUi) = listOf(v.totalTokens to "总计", v.inputTokens to "输入", v.cachedInputTokens to "缓存输入", v.outputTokens to "输出", v.reasoningOutputTokens to "推理输出").mapNotNull { (count,label) -> count?.let { "$label $it" } }.joinToString(" · ")
}

/** Contiguous chunks must name the same immutable native Item version before any text is shown. */
class ItemDetailAccumulator(private val expectedItem: String, private val expectedEpoch: String, private val maxBytes: Int = 8 * 1024 * 1024) {
    private val bytes = ByteArrayOutputStream()
    private var digest: String? = null
    private var revision: String? = null
    private var total: Long? = null
    var finished = false
        private set
    val loadedBytes: Int get() = bytes.size()
    fun append(chunk: JsonObject): JsonObject? {
        require(!finished && chunk.string("epoch") == expectedEpoch && chunk.string("itemId") == expectedItem) { "详情身份或代次变化" }
        require(chunk.string("encoding") == "base64" && chunk.string("format") == "native-item-json") { "详情编码不受支持" }
        val incomingTotal = chunk.number("totalBytes") ?: error("详情缺少大小")
        val incomingDigest = chunk.string("sha256") ?: error("详情缺少摘要")
        val incomingRevision = chunk.string("historyRevision") ?: error("详情缺少版本")
        require(incomingTotal in 1..maxBytes.toLong() && incomingDigest.matches(Regex("[0-9a-f]{64}"))) { "详情大小或摘要无效" }
        if (total == null) { total = incomingTotal; digest = incomingDigest; revision = incomingRevision }
        require(total == incomingTotal && digest == incomingDigest && revision == incomingRevision && chunk.number("offsetBytes") == bytes.size().toLong()) { "详情版本或字节顺序变化，请重新读取" }
        val decoded = Base64.getDecoder().decode(chunk.string("chunk") ?: error("详情缺少正文"))
        require(decoded.isNotEmpty() && decoded.size <= 65536 && bytes.size().toLong() + decoded.size <= incomingTotal) { "详情字节范围无效" }
        bytes.write(decoded)
        val complete = chunk.flag("complete")
        require(complete == (bytes.size().toLong() == incomingTotal) && (chunk.string("nextCursor") == null) == complete) { "详情完成标志不一致" }
        if (!complete) return null
        val data = bytes.toByteArray()
        val actual = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
        require(actual == digest) { "详情摘要校验失败，内容未展示" }
        val text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(data)).toString()
        val item = Json.parseToJsonElement(text) as? JsonObject ?: error("详情不是原生 Item")
        require(item.string("id") == expectedItem && !item.string("type").isNullOrBlank()) { "详情原生身份不匹配" }
        finished = true
        return item
    }
}

/** A native catalog entry can be displayed before the Gateway write contract supports it. */
fun isWritableEffort(effort: String): Boolean = Effort.entries.any { it.value == effort }

fun modelOptions(page: JsonObject): List<ModelOption> {
    val knownEfforts = Effort.entries.map { it.value }.toSet() + "ultra"
    return page.array("data").mapNotNull { raw -> (raw as? JsonObject)?.let { model ->
        val id = model.string("model") ?: return@let null
        val efforts = model.array("supportedReasoningEfforts").mapNotNull { (it as? JsonObject)?.string("reasoningEffort") }
            .filter { it in knownEfforts }.distinct()
        ModelOption(id, model.string("displayName") ?: id, efforts, model.string("defaultReasoningEffort")?.takeIf { it in efforts }, model.string("description").orEmpty())
    } }
}

/** Keeps very large native values out of a single UI/layout allocation. */
private fun boundedJson(value: JsonElement, limit: Int = 128 * 1024): String = buildString {
    fun appendValue(element: JsonElement, depth: Int = 0) {
        if (length >= limit) return
        if (depth > 12) { append("…"); return }
        when (element) {
            is JsonObject -> { append('{'); element.entries.forEachIndexed { i, entry ->
                if (length < limit) { if (i > 0) append(','); append(entry.key.take(200)); append(':'); appendValue(entry.value, depth + 1) }
            }; append('}') }
            is JsonArray -> { append('['); element.forEachIndexed { i, entry -> if (length < limit) { if (i > 0) append(','); appendValue(entry, depth + 1) } }; append(']') }
            is JsonPrimitive -> append(element.content.take((limit - length).coerceAtLeast(0)))
        }
    }
    appendValue(value)
}.take(limit)

/** Whole-view budgets apply before joining/splitting, independently of native Item limits. */
internal const val CONTENT_PREVIEW_MAX_CHARACTERS = 64 * 1024
internal const val CONTENT_PREVIEW_MAX_LINES = 256
internal const val CONTENT_PREVIEW_NOTICE = "预览截断，请分段查看。可读取对应 Item 详情或打开项目文件。"
internal data class ContentPreview(val text: String, val truncated: Boolean) {
    fun displayText(): String = if (truncated) "$text\n\n$CONTENT_PREVIEW_NOTICE" else text
}

internal fun boundedContentPreview(
    parts: Sequence<String>,
    maxCharacters: Int = CONTENT_PREVIEW_MAX_CHARACTERS,
    maxLines: Int = CONTENT_PREVIEW_MAX_LINES,
): ContentPreview {
    require(maxCharacters > 0 && maxLines > 0)
    val result = StringBuilder(minOf(maxCharacters, 4096))
    var lines = 1
    var truncated = false
    fun appendWithinBudget(part: String): Boolean {
        for (character in part) {
            if (result.length == maxCharacters || (character == '\n' && lines == maxLines)) return false
            result.append(character)
            if (character == '\n') lines++
        }
        return true
    }
    var first = true
    for (part in parts) {
        if ((!first && !appendWithinBudget("\n\n")) || !appendWithinBudget(part)) { truncated = true; break }
        first = false
    }
    if (truncated && result.lastOrNull()?.isHighSurrogate() == true) result.setLength(result.length - 1)
    return ContentPreview(result.toString(), truncated)
}
