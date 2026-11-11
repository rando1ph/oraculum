package dev.oraculum.poc.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Read-only Stitch Matcha Terminal tokens; full Light / Dark / OLED is Phase 3.
private val MatchaColors = darkColorScheme(
    primary = Color(0xFFA5D65D), onPrimary = Color(0xFF213600),
    primaryContainer = Color(0xFF74A12E), onPrimaryContainer = Color(0xFF1E3200),
    secondary = Color(0xFFC2C9B4), onSecondary = Color(0xFF2C3323),
    tertiary = Color(0xFF71DC8D), background = Color(0xFF11140F),
    surface = Color(0xFF11140F), surfaceContainer = Color(0xFF1D211B),
    surfaceContainerLow = Color(0xFF191D17), surfaceContainerHigh = Color(0xFF272B25),
    onSurface = Color(0xFFE0E4DA), onSurfaceVariant = Color(0xFFC3C9B4),
    outline = Color(0xFF8D9380), outlineVariant = Color(0xFF434939),
    error = Color(0xFFFFB4AB), errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6),
)

@Composable
fun OraculumTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = MatchaColors, content = content)
}
