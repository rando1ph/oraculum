package dev.oraculum.poc.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** A single-line wordmark with reversed lettering, like an inked intaglio seal. */
@Composable
internal fun NavigationBrand(modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    val textMeasurer = rememberTextMeasurer()
    val sealStyle = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Bold, fontSize = 9.5.sp, lineHeight = 12.sp, letterSpacing = .8.sp)
    BoxWithConstraints(modifier.testTag("navigation-brand").semantics(mergeDescendants = true) { heading() }) {
        val compact = maxWidth < 180.dp
        Row(verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(if (compact) 6.dp else 8.dp)) {
            OracleEyeMark(size = if (compact) 32.dp else 40.dp, variant = OracleEyeVariant.Full)
            Text("神谕", style = MaterialTheme.typography.titleLarge.copy(
                fontSize = if (compact) 16.sp else 18.sp, fontWeight = FontWeight.SemiBold),
                maxLines = 1, softWrap = false, modifier = Modifier.testTag("navigation-brand-title"))
            Surface(Modifier.weight(1f, fill = false).testTag("navigation-brand-seal"),
                shape = RoundedCornerShape(4.dp), color = colors.primary, contentColor = colors.onPrimary,
                tonalElevation = 0.dp, shadowElevation = 0.dp) {
                BoxWithConstraints(Modifier.padding(2.dp)
                    .border(.5.dp, colors.onPrimary.copy(alpha = .28f), RoundedCornerShape(2.dp))
                    .padding(horizontal = 5.dp, vertical = 3.dp), contentAlignment = Alignment.Center) {
                    // Fit the whole wordmark rather than ellipsizing it beside the two fixed touch targets.
                    val naturalWidth = textMeasurer.measure("ORACULUM", style = sealStyle, maxLines = 1,
                        softWrap = false).size.width.coerceAtLeast(1)
                    val scale = ((constraints.maxWidth - 1).coerceAtLeast(1).toFloat() / naturalWidth).coerceAtMost(1f)
                    Text("ORACULUM", style = sealStyle.copy(fontSize = sealStyle.fontSize * scale,
                        lineHeight = sealStyle.lineHeight * scale, letterSpacing = sealStyle.letterSpacing * scale),
                        maxLines = 1, softWrap = false)
                }
            }
        }
    }
}
