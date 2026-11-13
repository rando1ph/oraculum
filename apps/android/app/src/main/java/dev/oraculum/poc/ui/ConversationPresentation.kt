package dev.oraculum.poc.ui

/** Display rows retain their source-message index so folding does not replace reading anchors. */
internal data class ConversationRow(
    val key: String,
    val sourceIndex: Int,
    val message: ChatMessage? = null,
    val turnId: String = "",
    val turn: TurnMetadataUi? = null,
    val processCount: Int = 0,
    val canCollapse: Boolean = false,
    val expanded: Boolean = false,
    val children: List<ConversationRow> = emptyList(),
)

/** As in the original native projection, unknown assistant phases remain visible. */
internal fun isProcessMessage(message: ChatMessage): Boolean =
    message.role !in setOf("user", "exitedReviewMode") && (message.role != "assistant" || message.phase == "commentary")

internal fun conversationRows(messages: List<ChatMessage>, expandedTurns: Set<String>, pendingTurns: Set<String>, unscopedPending: Boolean): List<ConversationRow> {
    val turns = messages.filter { it.turnId.isNotEmpty() }.groupBy { it.turnId }
    val emitted = mutableSetOf<String>()
    return buildList {
        messages.forEachIndexed { index, message ->
            val turnMessages = turns[message.turnId].orEmpty()
            val turn = turnMessages.lastOrNull { it.turn != null }?.turn
            val canCollapse = turn?.status == "completed" && !unscopedPending && message.turnId !in pendingTurns
            val expanded = !canCollapse || message.turnId in expandedTurns
            if (message.role != "user" && turn != null && emitted.add(message.turnId)) {
                add(ConversationRow("turn-${message.turnId}", index, turnId = message.turnId, turn = turn,
                    processCount = turnMessages.count(::isProcessMessage), canCollapse = canCollapse, expanded = expanded))
            }
            if (!isProcessMessage(message) || expanded || message.needsAttention) {
                add(ConversationRow("message-${message.id}", index, message = message))
            }
        }
    }
}

/** Wrap only contiguous rows of the same turn; never pull content across a user message. */
internal fun groupConversationRows(rows: List<ConversationRow>): List<ConversationRow> = buildList {
    var index = 0
    while (index < rows.size) {
        val row = rows[index++]
        if (row.turn == null) {
            add(row)
        } else {
            val children = mutableListOf<ConversationRow>()
            while (index < rows.size) {
                val next = rows[index]
                if (next.message?.role == "user" || next.message?.turnId != row.turnId) break
                children.add(next)
                index++
            }
            add(row.copy(children = children))
        }
    }
}

internal fun List<ConversationRow>.rowForSourceIndex(sourceIndex: Int): Int =
    indexOfFirst { row ->
        row.sourceIndex >= sourceIndex || row.children.any { it.sourceIndex >= sourceIndex }
    }.takeIf { it >= 0 } ?: lastIndex.coerceAtLeast(0)

internal fun isNormalEmptyHistoryNotice(text: String): Boolean = text == "新会话历史尚未生成，可发送首条消息"

internal fun composerExecutionNotice(state: PocUiState): String? = when {
    state.canStop || state.executionLabel == "原生 Turn 正在执行" -> "正在执行"
    state.canResume -> "恢复会话后可继续发送"
    state.executionLabel == "正在校正原生状态" -> "正在同步会话…"
    state.executionLabel == "原生会话未加载 · 点击恢复后才能发送" -> "会话尚未加载"
    state.executionLabel.isBlank() || isNormalEmptyHistoryNotice(state.executionLabel) ||
        state.executionLabel == "原生状态已校正" || state.executionLabel.startsWith("离线 ·") -> null
    else -> state.executionLabel
}

internal fun formatTurnDuration(ms: Long): String {
    val seconds = (ms.coerceAtLeast(0) / 1000)
    return listOfNotNull((seconds / 3600).takeIf { it > 0 }?.let { "$it 小时" },
        ((seconds / 60) % 60).takeIf { it > 0 }?.let { "$it 分" }, "${seconds % 60} 秒").joinToString(" ")
}
