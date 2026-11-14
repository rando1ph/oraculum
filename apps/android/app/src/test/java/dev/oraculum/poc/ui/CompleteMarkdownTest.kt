package dev.oraculum.poc.ui

import org.junit.Assert.*
import org.junit.Test

class CompleteMarkdownTest {
    @Test fun completeDocumentRetainsTailBeyondEveryPreviewLimit() {
        val text = (1..400).joinToString("\n\n") { "paragraph-$it " + "x".repeat(200) } + "\n\nEND-OF-DOCUMENT"
        val blocks = fullMarkdownBlocks(text)
        assertTrue(text.length > 64 * 1024)
        assertTrue(blocks.size > 128)
        assertEquals("END-OF-DOCUMENT", blocks.last().lines.single())
        assertEquals(text, blocks.joinToString("\n\n") { it.lines.joinToString("\n") })
        assertFalse(blocks.any { it.kind == "notice" })
        assertTrue(blocks.all { it.lines.joinToString("\n").length <= 4096 })
    }

    @Test fun consecutiveShortLinesAreAggregatedWithoutLosingTheirLineBreaks() {
        val text = (1..20_000).joinToString("\n") { "line-$it" }
        val blocks = fullMarkdownBlocks(text)
        assertTrue(blocks.size < 100)
        assertEquals(text, blocks.joinToString("\n") { it.lines.joinToString("\n") })
        assertTrue(blocks.all { it.kind == "text" && it.lines.joinToString("\n").length <= 4096 })
    }

    @Test fun overlongRuleUsesBoundedReadableText() {
        val text = "-".repeat(70_000)
        val blocks = fullMarkdownBlocks(text)
        assertEquals(text, blocks.joinToString("") { it.lines.single() })
        assertTrue(blocks.all { it.kind == "text" && it.lines.single().length <= 4096 })
    }

    @Test fun longLineIsSplitWithoutLosingCharactersOrSeparatingSurrogatePairs() {
        val text = "x".repeat(4095) + "😀" + "y".repeat(90_000) + "TAIL"
        val blocks = fullMarkdownBlocks(text)
        assertEquals(text, blocks.joinToString("") { it.lines.single() })
        assertTrue(blocks.all { it.lines.single().length <= 4096 })
        assertTrue(blocks.none { it.lines.single().firstOrNull()?.isLowSurrogate() == true ||
            it.lines.single().lastOrNull()?.isHighSurrogate() == true })
    }

    @Test fun fencedCodeKeepsEveryLineAndSplitsIntoBoundedLayoutUnits() {
        val body = (1..500).joinToString("\n") { "line-$it " + "x".repeat(200) } + "\nCODE-END"
        val blocks = fullMarkdownBlocks("```kotlin\n$body\n```")
        assertTrue(blocks.size > 1)
        assertTrue(blocks.all { it.kind == "code" && it.label == "kotlin" })
        assertEquals(body, blocks.joinToString("") { it.lines.joinToString("\n") })
        assertTrue(blocks.all { it.lines.size <= 128 && it.lines.joinToString("\n").length <= 16 * 1024 })
        assertTrue(blocks.last().lines.last().endsWith("CODE-END"))
        assertEquals(body, blocks.first().copyText)
        blocks.forEach { assertSame(blocks.first().copyText, it.copyText) }
    }

    @Test fun tableOverflowFallsBackToReadableSourceWithoutDroppingColumnsOrRows() {
        val wide = "| " + (1..9).joinToString(" | ") { "column-$it" } + " |\n|" + (1..9).joinToString("|") { "---" } + "|\n|" +
            (1..9).joinToString("|") { "value-$it" } + "|"
        val tall = "|head|\n|---|\n" + (1..300).joinToString("\n") { "|row-$it|" }
        for (source in listOf(wide, tall)) {
            val blocks = fullMarkdownBlocks(source)
            assertTrue(blocks.all { it.kind == "code" })
            assertEquals(source, blocks.joinToString("") { it.lines.joinToString("\n") })
            assertFalse(blocks.any { it.kind == "notice" })
            assertEquals(source, blocks.first().copyText)
            blocks.forEach { assertSame(blocks.first().copyText, it.copyText) }
        }
    }

    @Test fun oversizedOrderedListMarkerCannotEscapeTheLayoutBudget() {
        val text = "1".repeat(20_000) + ". body-end"
        val blocks = fullMarkdownBlocks(text)
        assertEquals(text, blocks.joinToString("") { it.lines.single() })
        assertTrue(blocks.all { it.kind == "text" && it.lines.single().length <= 4096 })
    }

    @Test fun smallTableAndMarkdownFormattingRemainStructured() {
        val blocks = fullMarkdownBlocks("# Title ###\n> quote\n- item\n- [x] task\n|left|right|\n|:---|---:|\n|one|two|")
        assertEquals(listOf("heading", "quote", "list", "task", "table"), blocks.map { it.kind })
        assertEquals("Title", blocks[0].lines.single())
        assertEquals("1", blocks[0].label)
        assertEquals("☑", blocks[3].label)
        assertEquals("left,right", blocks[4].label)
        assertEquals(listOf("|left|right|", "|one|two|"), blocks[4].lines)
    }
}
