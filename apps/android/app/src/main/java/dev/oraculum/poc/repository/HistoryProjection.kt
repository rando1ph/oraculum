package dev.oraculum.poc.repository

import dev.oraculum.poc.ui.ChatMessage
import kotlinx.serialization.json.*

internal fun JsonObject.string(key: String): String? = (get(key) as? JsonPrimitive)?.contentOrNull
internal fun JsonObject.obj(key: String): JsonObject? = get(key) as? JsonObject
internal fun JsonObject.array(key: String): JsonArray = get(key) as? JsonArray ?: JsonArray(emptyList())
internal fun JsonObject.flag(key: String): Boolean = (get(key) as? JsonPrimitive)?.booleanOrNull == true
internal fun JsonObject.number(key: String): Long? = (get(key) as? JsonPrimitive)?.longOrNull

/** Bounded, replaceable history projection indexed by the unchanged native Item ID. */
class HistoryProjection(private val maxItems: Int = 250) {
    private val items = linkedMapOf<String, ItemProjection>()
    private val terminalTurns = mutableMapOf<String, Boolean>()
    private val turnStatuses = mutableMapOf<String, String>()
    var limited = false
        private set
    var activeTurnId: String? = null
        private set
    fun isTerminal(itemId: String?): Boolean = itemId != null && items[itemId]?.terminal == true

    fun clear() { items.clear(); terminalTurns.clear(); turnStatuses.clear(); limited = false; activeTurnId = null }
    fun invalidate() {
        items.replaceAll { _, item -> mergeItem(item, item.id, item.turnId, item.type, ItemUpdate.GAP) }
        activeTurnId = null
    }

    fun snapshot(history: JsonObject, preserveTerminal: Boolean = true) {
        val observed = if (preserveTerminal) items.toMap() else emptyMap()
        clear()
        applyHistory(history)
        // Only preserve a concurrent terminal for IDs present in this authoritative page.
        observed.forEach { (id, value) ->
            val current = items[id]
            if (value.terminal && current != null && (!current.terminal || (current.detailsRequired && !value.detailsRequired))) items[id] = value
            // A complete started event followed by continuous deltas is already an independent,
            // appendable live projection. Keep that stream without appending any snapshot bytes.
            if (value.appendable && !value.terminal && current?.terminal != true) items[id] = value
        }
        bound()
    }

    fun applyHistory(history: JsonObject, turnId: String? = null, older: Boolean = false) {
        limited = limited || history.flag("truncated")
        val prior = if (older) LinkedHashMap(items) else null
        if (older) items.clear()
        if (turnId != null) {
            history.array("items").forEach { value -> (value as? JsonObject)?.let { applyNative(it, turnId, ItemUpdate.SNAPSHOT, terminalTurns[turnId] == true, !history.flag("truncated")) } }
        } else {
            history.array("items").forEach { value ->
                val turn = value as? JsonObject ?: return@forEach
                val id = turn.string("id") ?: return@forEach
                val status = turn.string("status")
                if (status != null) turnStatuses[id] = status
                terminalTurns[id] = status in setOf("completed", "interrupted", "failed")
                if (status == "inProgress") activeTurnId = id
                turn.array("items").forEach { item -> (item as? JsonObject)?.let {
                    applyNative(it, id, ItemUpdate.SNAPSHOT, status in setOf("completed", "interrupted", "failed"), !history.flag("truncated"))
                } }
            }
        }
        if (prior != null && turnId != null) {
            val page = LinkedHashMap(items)
            items.clear()
            var inserted = false
            prior.forEach { (id, item) ->
                if (!inserted && item.turnId == turnId) {
                    items.putAll(page)
                    inserted = true
                }
                if (items[id]?.terminal != true || item.terminal) items[id] = item
            }
            if (!inserted) items.putAll(page)
        } else prior?.forEach { (id, item) -> if (items[id]?.terminal != true || item.terminal) items[id] = item }
        bound()
    }

    fun event(event: JsonObject) {
        val scope = event.obj("scope") ?: return
        val payload = event.obj("payload") ?: return
        val id = scope.string("itemId") ?: return
        val turn = scope.string("turnId") ?: return
        when (event.string("kind")) {
            "item.delta" -> {
                val type = items[id]?.type ?: when (payload.string("nativeMethod")) {
                    "item/reasoning/textDelta" -> "reasoning"
                    "item/commandExecution/outputDelta" -> "commandExecution"
                    else -> "agentMessage"
                }
                items[id] = mergeItem(items[id], id, turn, type, ItemUpdate.DELTA, payload.string("delta").orEmpty())
            }
            "item.started", "item.completed" -> {
                val wrapper = payload.obj("item") ?: return
                val item = wrapper.obj("data") ?: return
                applyNative(item, turn, if (event.string("kind") == "item.started") ItemUpdate.STARTED else ItemUpdate.COMPLETED,
                    event.string("kind") == "item.completed", payload.flag("complete") && !wrapper.flag("truncated"))
            }
        }
        bound()
    }

    fun messages(): List<ChatMessage> = items.values.map { item ->
        ChatMessage(item.id, when (item.type) { "userMessage" -> "user"; "agentMessage" -> "assistant"; else -> item.type },
            item.visibleText.ifBlank { if (item.detailsRequired) "此内容需要读取完整详情" else "…" },
            when { item.detailsRequired -> "受限投影"; item.terminal -> when (turnStatuses[item.turnId]) { "interrupted" -> "本轮已停止"; "failed" -> "本轮失败"; else -> "" }; item.appendable -> "流式接收中"; else -> "正在校正原生状态" }, item.turnId, item.detailsRequired)
    }

    fun cached(): JsonObject = buildJsonObject {
        put("limited", limited)
        put("turnStatuses", buildJsonObject { turnStatuses.forEach { (id, status) -> put(id, status) } })
        put("items", JsonArray(items.values.map { item -> buildJsonObject {
            put("id", item.id); put("turnId", item.turnId); put("type", item.type)
            put("baseline", item.baseline); put("stream", item.stream)
            put("terminal", item.terminal); put("appendable", item.appendable)
            put("detailsRequired", item.detailsRequired)
        } }))
    }

    fun restoreCached(cache: JsonObject) {
        clear()
        limited = cache.flag("limited")
        cache.obj("turnStatuses")?.forEach { (id, status) -> (status as? JsonPrimitive)?.contentOrNull?.let { turnStatuses[id] = it } }
        cache.array("items").take(maxItems).forEach { value ->
            val item = value as? JsonObject ?: return@forEach
            val id = item.string("id") ?: return@forEach
            items[id] = ItemProjection(id, item.string("turnId").orEmpty(), item.string("type") ?: "unknown",
                item.string("baseline").orEmpty(), item.string("stream").orEmpty(), item.flag("terminal"),
                item.flag("appendable"), item.flag("detailsRequired"))
        }
        // The offline cache cannot establish an active Turn or authorize any write.
        activeTurnId = null
    }

    private fun applyNative(item: JsonObject, turn: String, update: ItemUpdate, terminal: Boolean, complete: Boolean) {
        val id = item.string("id") ?: return
        val type = item.string("type") ?: "unknown"
        items[id] = mergeItem(items[id], id, turn, type, update, nativeText(item), terminal, complete)
    }

    private fun bound() {
        if (items.values.any { it.detailsRequired }) limited = true
        while (items.size > maxItems) { items.remove(items.keys.first()); limited = true }
    }
}

private fun nativeText(item: JsonObject): String {
    fun textArray(name: String): String = item.array(name).mapNotNull { element ->
        (element as? JsonObject)?.string("text") ?: (element as? JsonPrimitive)?.contentOrNull
    }.joinToString("\n")
    return when (item.string("type")) {
        "userMessage" -> textArray("content")
        "agentMessage" -> item.string("text").orEmpty()
        "reasoning" -> textArray("summary").ifBlank { textArray("content") }.ifBlank { "思考过程" }
        "commandExecution" -> listOfNotNull(item.string("command"), item.string("aggregatedOutput")).joinToString("\n")
        "fileChange" -> item.array("changes").joinToString("\n") { (it as? JsonObject)?.string("path") ?: "文件变更" }
        "plan" -> item.string("text") ?: "原生计划更新"
        else -> item.string("text") ?: "原生事件：${item.string("type") ?: "unknown"}"
    }
}
