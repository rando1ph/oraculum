package dev.oraculum.poc.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import dev.oraculum.poc.storage.ACCENT_COLOR_KEYS
import org.junit.Assert.*
import org.junit.Test

class AccentContrastTest {
    @Test fun everyAccentKeepsReadableTextAndOledBlack() {
        assertEquals(ACCENT_COLOR_KEYS, accentOptions.map { it.key }.toSet())
        for (mode in listOf("light", "dark", "oled")) for (accent in accentOptions) {
            val scheme = oraculumColorScheme(mode, accent.key)
            for ((foreground, background) in listOf(scheme.onPrimary to scheme.primary, scheme.onPrimaryContainer to scheme.primaryContainer,
                scheme.primary to scheme.surface, scheme.onSurface to scheme.surface)) {
                val first = foreground.luminance(); val second = background.luminance()
                val contrast = (maxOf(first, second) + .05f) / (minOf(first, second) + .05f)
                assertTrue("$mode/${accent.key} contrast=$contrast", contrast >= 4.5f)
            }
            if (mode == "oled") { assertEquals(Color.Black, scheme.background); assertEquals(Color.Black, scheme.surface) }
        }
    }

    @Test fun unknownAccentUsesDefaultPalette() {
        assertEquals(oraculumColorScheme("light", "matcha"), oraculumColorScheme("light", "unknown"))
    }
}
