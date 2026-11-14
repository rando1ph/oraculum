package dev.oraculum.poc.ui

import java.nio.charset.StandardCharsets
import org.junit.Assert.*
import org.junit.Test

class BranchThreadTitleTest {
    @Test fun originalTitleIsPrefixedAndTrimmed() {
        assertEquals("Branch · Original conversation", branchThreadTitle("  Original conversation  "))
    }

    @Test fun blankOrControlOnlyTitleUsesTheVisibleFallback() {
        listOf("", "   ", "\t\n\r\u0000\u007f").forEach {
            assertEquals("Branch · 新会话", branchThreadTitle(it))
        }
    }

    @Test fun controlCharactersAreRemovedFromNativeNameWrites() {
        val title = branchThreadTitle("First\n\u0000line\t\u007fend")
        assertEquals("Branch · First line end", title)
        assertFalse(title.any { it.code in 0..31 || it.code == 127 })
    }

    @Test fun longAsciiTitleFitsBothNativeLimits() {
        val title = branchThreadTitle("a".repeat(500))
        assertEquals(200, title.length)
        assertEquals(200, title.codePointCount(0, title.length))
        assertTrue(title.startsWith("Branch · "))
    }

    @Test fun supplementaryCharactersStayIntactWithinUtf16AndCodePointLimits() {
        val title = branchThreadTitle("😀".repeat(300))
        assertTrue(title.startsWith("Branch · "))
        assertTrue(title.length <= 200)
        assertTrue(title.codePointCount(0, title.length) <= 200)
        assertTrue("Truncation preserves valid Unicode", StandardCharsets.UTF_8.newEncoder().canEncode(title))
        assertTrue(title.endsWith("😀"))
    }

    @Test fun utf16BoundaryNeverLeavesHalfOfTheNextCharacter() {
        val title = branchThreadTitle("a".repeat(190) + "😀" + "tail")
        assertEquals("Branch · " + "a".repeat(190), title)
        assertTrue(title.length <= 200)
        assertTrue(StandardCharsets.UTF_8.newEncoder().canEncode(title))
    }
}
