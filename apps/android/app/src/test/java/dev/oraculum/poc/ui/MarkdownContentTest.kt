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
}
