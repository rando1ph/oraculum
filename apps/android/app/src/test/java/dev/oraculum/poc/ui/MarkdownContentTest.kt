package dev.oraculum.poc.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownContentTest {
    @Test fun identifiersKeepTheirLiteralUnderscores() {
        val text = "P3_NATIVE_OK snake__case__identifier 用户_名称_字段"
        val tokens = markdownInlineTokens(text)
        assertEquals(text, tokens.joinToString("") { it.text })
        assertTrue(tokens.all { it.kind == "text" })
    }

    @Test fun standaloneEmphasisStillWorksWithoutChangingInlineCode() {
        val tokens = markdownInlineTokens("_强调_ __strong__ `P3_NATIVE_OK` *italic*")
        assertEquals(listOf("emphasis", "strong", "code", "emphasis"), tokens.filter { it.kind != "text" }.map { it.kind })
        assertEquals("P3_NATIVE_OK", tokens.single { it.kind == "code" }.text)
    }

    @Test fun escapedUnderscoresRemainInert() {
        assertTrue(markdownInlineTokens("\\_literal_").all { it.kind == "text" })
    }

    @Test fun unclosedCodeFenceKeepsMarkdownLiteral() {
        val blocks = markdownBlocks("```kotlin\n# literal heading\nP3_NATIVE_OK")
        assertEquals(1, blocks.size)
        assertEquals("code", blocks.single().kind)
        assertEquals(listOf("# literal heading", "P3_NATIVE_OK"), blocks.single().lines)
    }

    @Test fun gfmTableAlignmentAndNestedTasksAreRetained() {
        val blocks = markdownBlocks("| A | B |\n| :--- | ---: |\n| one | two |\n\n  - [x] ready")
        assertEquals("table", blocks.first().kind)
        assertEquals("left,right", blocks.first().label)
        assertEquals("task", blocks.last().kind)
        assertEquals(1, blocks.last().depth)
        assertEquals("☑", blocks.last().label)
    }
    @Test fun shortLineFloodDoesNotCreateAnUnboundedComposeBlockList() {
        val blocks = markdownBlocks("x\n".repeat(64 * 1024))
        assertTrue(blocks.size <= MARKDOWN_PREVIEW_MAX_BLOCKS + 1)
        assertEquals("notice", blocks.last().kind)
        assertTrue(blocks.last().lines.single().contains("预览截断"))
    }

    @Test fun hugeSingleLineAndWideTablesHaveExplicitPreviewLimits() {
        val blocks = markdownBlocks("x".repeat(128 * 1024))
        assertEquals("notice", blocks.last().kind)
        assertTrue(blocks.first().lines.single().length <= dev.oraculum.poc.repository.CONTENT_PREVIEW_MAX_CHARACTERS)
        val wideTable = "|" + " A |".repeat(1000) + "\n|" + " --- |".repeat(1000) + "\n|" + " value |".repeat(1000)
        val table = markdownBlocks(wideTable)
        assertEquals("notice", table.last().kind)
        assertTrue(table.first().label.split(',').size <= MARKDOWN_PREVIEW_MAX_TABLE_COLUMNS)
    }

    @Test fun tableRowsShareOneCellBudgetAcrossTheMessage() {
        val table = "| A | B |\n| --- | --- |\n" + "| x | y |\n".repeat(1000)
        val blocks = markdownBlocks(table)
        val cells = blocks.filter { it.kind == "table" }.sumOf { block -> block.lines.size * block.label.split(',').size }
        assertTrue(cells <= MARKDOWN_PREVIEW_MAX_TABLE_CELLS)
        assertEquals("notice", blocks.last().kind)
    }

}
