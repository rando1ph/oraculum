package dev.oraculum.poc.ui

import org.junit.Assert.*
import org.junit.Test

class ConversationPresentationTest {
    private fun turn(status: String = "completed") = listOf(
        ChatMessage("user", "user", "request", turnId = "turn", turn = TurnMetadataUi(status)),
        ChatMessage("progress", "assistant", "checking", turnId = "turn", phase = "commentary", turn = TurnMetadataUi(status)),
        ChatMessage("command", "commandExecution", "output", turnId = "turn", turn = TurnMetadataUi(status)),
        ChatMessage("answer", "assistant", "answer", turnId = "turn", phase = "final_answer", turn = TurnMetadataUi(status)),
    )

    @Test fun completedTurnFoldsOnlyProgressAndKeepsFinalAnswerAndSourceAnchors() {
        val rows = conversationRows(turn(), emptySet(), emptySet(), false)
        assertEquals(listOf("user", "answer"), rows.mapNotNull { it.message?.id })
        val summary = rows.single { it.turn != null }
        assertTrue(summary.canCollapse)
        assertFalse(summary.expanded)
        assertEquals(2, summary.processCount)
        assertEquals(3, rows[rows.rowForSourceIndex(3)].sourceIndex)
        assertEquals("answer", rows[rows.rowForSourceIndex(2)].message?.id)
        val expanded = conversationRows(turn(), setOf("turn"), emptySet(), false)
        assertEquals(turn().map { it.id }, expanded.mapNotNull { it.message?.id })
        assertEquals("command", expanded[expanded.rowForSourceIndex(2)].message?.id)
    }

    @Test fun failedInterruptedAndUnconfirmedTurnsRemainExpanded() {
        for (status in listOf("inProgress", "failed", "interrupted", "unknown")) {
            val rows = conversationRows(turn(status), emptySet(), emptySet(), false)
            assertEquals(status, 4, rows.count { it.message != null })
            assertFalse(rows.single { it.turn != null }.canCollapse)
        }
        val withoutStatus = turn().map { it.copy(turn = null) }
        assertEquals(4, conversationRows(withoutStatus, emptySet(), emptySet(), false).count { it.message != null })
    }

    @Test fun pendingApprovalPreventsFoldingItsTurnAndUnscopedApprovalIsConservative() {
        assertEquals(4, conversationRows(turn(), emptySet(), setOf("turn"), false).count { it.message != null })
        assertEquals(4, conversationRows(turn(), emptySet(), emptySet(), true).count { it.message != null })
        assertEquals(2, conversationRows(turn(), emptySet(), setOf("different-turn"), false).count { it.message != null })
    }

    @Test fun UnknownAssistantPhaseAndExecutionFailuresAreNeverHidden() {
        val messages = turn().map { when (it.id) {
            "progress" -> it.copy(phase = null)
            "command" -> it.copy(needsAttention = true)
            else -> it
        } }
        assertEquals(4, conversationRows(messages, emptySet(), emptySet(), false).count { it.message != null })
        assertFalse(isProcessMessage(ChatMessage("review", "exitedReviewMode", "review")))
    }

    @Test fun OnlyTheKnownNormalEmptyNoticeIsSuppressed() {
        assertTrue(isNormalEmptyHistoryNotice("新会话历史尚未生成，可发送首条消息"))
        assertFalse(isNormalEmptyHistoryNotice("原生状态暂未稳定；自动校正已暂停"))
        assertFalse(isNormalEmptyHistoryNotice("历史缓存已清除；草稿与未知操作保留"))
        assertNull(composerExecutionNotice(PocUiState(executionLabel = "原生状态已校正")))
        assertEquals("正在同步会话…", composerExecutionNotice(PocUiState(executionLabel = "正在校正原生状态")))
    }
}
