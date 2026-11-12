package dev.oraculum.poc.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Matcha Terminal DESIGN.md front-matter is the canonical dark token set. */
private val MatchaDark = darkColorScheme(
    primary = Color(0xFFA5D65D), onPrimary = Color(0xFF213600),
    primaryContainer = Color(0xFF74A12E), onPrimaryContainer = Color(0xFF1E3200),
    secondary = Color(0xFFC2C9B4), onSecondary = Color(0xFF2C3323),
    secondaryContainer = Color(0xFF454B3B), onSecondaryContainer = Color(0xFFDEE5CF),
    tertiary = Color(0xFF71DC8D), onTertiary = Color(0xFF003918),
    tertiaryContainer = Color(0xFF39A75E), onTertiaryContainer = Color(0xFF003416),
    background = Color(0xFF11140F), onBackground = Color(0xFFE0E4DA),
    surface = Color(0xFF11140F), onSurface = Color(0xFFE0E4DA),
    surfaceDim = Color(0xFF11140F), surfaceBright = Color(0xFF363A33),
    surfaceContainerLowest = Color(0xFF0B0F0A), surfaceContainerLow = Color(0xFF191D17),
    surfaceContainer = Color(0xFF1D211B), surfaceContainerHigh = Color(0xFF272B25),
    surfaceContainerHighest = Color(0xFF32362F), onSurfaceVariant = Color(0xFFC3C9B4),
    surfaceVariant = Color(0xFF32362F), surfaceTint = Color(0xFFA5D65D),
    inverseSurface = Color(0xFFE0E4DA), inverseOnSurface = Color(0xFF2D322B), inversePrimary = Color(0xFF446900),
    outline = Color(0xFF8D9380), outlineVariant = Color(0xFF434939),
    error = Color(0xFFFFB4AB), onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A), onErrorContainer = Color(0xFFFFDAD6),
)

private val MatchaLight = lightColorScheme(
    primary = Color(0xFF446900), onPrimary = Color.White,
    primaryContainer = Color(0xFFC0F275), onPrimaryContainer = Color(0xFF1E3200),
    secondary = Color(0xFF58614A), onSecondary = Color.White,
    secondaryContainer = Color(0xFFDEE5CF), onSecondaryContainer = Color(0xFF171D10),
    tertiary = Color(0xFF006D33), onTertiary = Color.White,
    tertiaryContainer = Color(0xFF8DF9A7), onTertiaryContainer = Color(0xFF00210B),
    background = Color(0xFFF8FAF1), onBackground = Color(0xFF191D17),
    surface = Color(0xFFF8FAF1), onSurface = Color(0xFF191D17),
    surfaceDim = Color(0xFFD8DDD1), surfaceBright = Color(0xFFF8FAF1),
    surfaceContainerLowest = Color.White, surfaceContainerLow = Color(0xFFF1F4E9),
    surfaceContainer = Color(0xFFEBEEE3), surfaceContainerHigh = Color(0xFFE5E8DD),
    surfaceContainerHighest = Color(0xFFDEE2D6), onSurfaceVariant = Color(0xFF434939),
    surfaceVariant = Color(0xFFDEE2D6), surfaceTint = Color(0xFF446900),
    inverseSurface = Color(0xFF2D322B), inverseOnSurface = Color(0xFFF1F4E9), inversePrimary = Color(0xFFA5D65D),
    outline = Color(0xFF737B67), outlineVariant = Color(0xFFC3C9B4),
    error = Color(0xFFBA1A1A), onError = Color.White,
    errorContainer = Color(0xFFFFDAD6), onErrorContainer = Color(0xFF410002),
)

private val MatchaOled = MatchaDark.copy(
    background = Color.Black, surface = Color.Black, surfaceDim = Color.Black,
    surfaceContainerLowest = Color.Black, surfaceContainerLow = Color(0xFF0C100B),
    surfaceContainer = Color(0xFF141912), surfaceContainerHigh = Color(0xFF20261D),
    surfaceContainerHighest = Color(0xFF2D3428), surfaceBright = Color(0xFF363E30),
    surfaceVariant = Color(0xFF2D3428),
    onBackground = Color(0xFFE9EDDF), onSurface = Color(0xFFE9EDDF),
    onSurfaceVariant = Color(0xFFCCD3BE), outlineVariant = Color(0xFF4C5541),
)

private val MatchaTypography = Typography().let { base ->
    base.copy(
        headlineLarge = base.headlineLarge.copy(fontFamily = FontFamily.SansSerif, fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.SemiBold),
        headlineSmall = base.headlineSmall.copy(fontFamily = FontFamily.SansSerif, fontSize = 20.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
        titleLarge = base.titleLarge.copy(fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
        titleMedium = base.titleMedium.copy(fontSize = 16.sp, lineHeight = 24.sp, fontWeight = FontWeight.Medium),
        titleSmall = base.titleSmall.copy(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
        bodyLarge = base.bodyLarge.copy(fontSize = 16.sp, lineHeight = 24.sp),
        bodyMedium = base.bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp),
        bodySmall = base.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp),
        labelLarge = base.labelLarge.copy(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
        labelMedium = base.labelMedium.copy(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
        labelSmall = base.labelSmall.copy(fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 16.sp),
    )
}

private val MatchaShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = OraculumTokens.InsetShape,
    medium = OraculumTokens.ProcessShape,
    large = OraculumTokens.ContentShape,
    extraLarge = OraculumTokens.PanelShape,
)

private val LocalReadingScale = staticCompositionLocalOf { 1f }

internal data class AccentOption(val key: String, val label: String, val light: Color, val dark: Color, val lightContainer: Color, val darkContainer: Color)

/** Fixed accessible pairs keep every selected accent readable in all three modes. */
internal val accentOptions = listOf(
    AccentOption("matcha", "抹茶", Color(0xFF446900), Color(0xFFA5D65D), Color(0xFFC0F275), Color(0xFF74A12E)),
    AccentOption("ocean", "海蓝", Color(0xFF005FAF), Color(0xFFA5C8FF), Color(0xFFD5E3FF), Color(0xFF004786)),
    AccentOption("violet", "紫罗兰", Color(0xFF6B45A8), Color(0xFFD3BBFF), Color(0xFFEBDCFF), Color(0xFF503182)),
    AccentOption("rose", "玫瑰", Color(0xFF9E3A60), Color(0xFFFFB0C8), Color(0xFFFFD9E3), Color(0xFF7E2248)),
    AccentOption("amber", "琥珀", Color(0xFF815600), Color(0xFFF5C15D), Color(0xFFFFDEA6), Color(0xFF624000)),
    AccentOption("teal", "青碧", Color(0xFF006B60), Color(0xFF6EDBCA), Color(0xFF8FF8E7), Color(0xFF005048)),
)

internal fun oraculumColorScheme(mode: String, accentColor: String): ColorScheme {
    val base = when (mode) { "light" -> MatchaLight; "oled" -> MatchaOled; else -> MatchaDark }
    val accent = accentOptions.firstOrNull { it.key == accentColor } ?: accentOptions.first()
    if (accent.key == "matcha") return base
    val light = mode == "light"
    return base.copy(
        primary = if (light) accent.light else accent.dark,
        onPrimary = if (light) Color.White else Color(0xFF121512),
        primaryContainer = if (light) accent.lightContainer else accent.darkContainer,
        onPrimaryContainer = if (light) Color(0xFF161A15) else Color.White,
        surfaceTint = if (light) accent.light else accent.dark,
        inversePrimary = if (light) accent.dark else accent.light,
    )
}

@Composable
fun OraculumTheme(mode: String = "dark", readingScale: Float = 1f, accentColor: String = "matcha", content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalReadingScale provides readingScale.coerceIn(.85f, 1.4f)) {
        MaterialTheme(
            colorScheme = oraculumColorScheme(mode, accentColor),
            typography = MatchaTypography,
            shapes = MatchaShapes,
            content = content,
        )
    }
}

/** Reading preference affects message/code content; controls keep the system font scale. */
@Composable
internal fun ReadingContent(content: @Composable () -> Unit) {
    val scale = LocalReadingScale.current
    val base = MaterialTheme.typography
    val typography = base.copy(
        headlineLarge = base.headlineLarge.copy(fontSize = base.headlineLarge.fontSize * scale, lineHeight = base.headlineLarge.lineHeight * scale),
        headlineSmall = base.headlineSmall.copy(fontSize = base.headlineSmall.fontSize * scale, lineHeight = base.headlineSmall.lineHeight * scale),
        titleLarge = base.titleLarge.copy(fontSize = base.titleLarge.fontSize * scale, lineHeight = base.titleLarge.lineHeight * scale),
        titleMedium = base.titleMedium.copy(fontSize = base.titleMedium.fontSize * scale, lineHeight = base.titleMedium.lineHeight * scale),
        titleSmall = base.titleSmall.copy(fontSize = base.titleSmall.fontSize * scale, lineHeight = base.titleSmall.lineHeight * scale),
        bodyLarge = base.bodyLarge.copy(fontSize = base.bodyLarge.fontSize * scale, lineHeight = base.bodyLarge.lineHeight * scale),
        bodyMedium = base.bodyMedium.copy(fontSize = base.bodyMedium.fontSize * scale, lineHeight = base.bodyMedium.lineHeight * scale),
        bodySmall = base.bodySmall.copy(fontSize = base.bodySmall.fontSize * scale, lineHeight = base.bodySmall.lineHeight * scale),
    )
    // Code blocks inside Markdown already inherit its scaled typography.
    CompositionLocalProvider(LocalReadingScale provides 1f) {
        MaterialTheme(typography = typography, content = content)
    }
}
