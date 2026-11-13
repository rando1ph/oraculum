package dev.oraculum.poc.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/** The shape and surface roles are shared by all three native colour modes. */
object OraculumTokens {
    val CompactSpacing = 8.dp
    val ContentSpacing = 12.dp
    val PageSpacing = 16.dp
    val MinimumTouchTarget = 48.dp
    // Refined Monolith Geometry: architectural, precise, reduced bubble bloat
    val ContentShape = RoundedCornerShape(16.dp)
    val UserShape = RoundedCornerShape(topStart = 16.dp, topEnd = 4.dp, bottomEnd = 16.dp, bottomStart = 16.dp)
    val ProcessShape = RoundedCornerShape(10.dp)
    val InsetShape = RoundedCornerShape(10.dp)
    val PanelShape = RoundedCornerShape(24.dp)
}

enum class CardRole { Content, User, Process, Inset, Attention }

/**
 * Content is a reading surface; User has a quieter, asymmetric silhouette;
 * Process is a compact secondary group; Inset is the deepest code/detail plane.
 * Attention is reserved for a decision that needs the user's response.
 */
@Composable
fun OraculumCard(
    role: CardRole = CardRole.Content,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(16.dp),
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val color = when (role) {
        CardRole.Content -> colors.surfaceContainer
        CardRole.User -> colors.surfaceContainerLow
        CardRole.Process -> colors.surfaceContainerLowest
        CardRole.Inset -> colors.surfaceContainerLowest
        CardRole.Attention -> colors.secondaryContainer
    }
    val shape = when (role) {
        CardRole.Content, CardRole.Attention -> OraculumTokens.ContentShape
        CardRole.User -> OraculumTokens.UserShape
        CardRole.Process -> OraculumTokens.ProcessShape
        CardRole.Inset -> OraculumTokens.InsetShape
    }
    val border = when (role) {
        CardRole.Inset -> BorderStroke(1.dp, colors.outlineVariant.copy(alpha = 0.5f))
        CardRole.Process -> BorderStroke(1.dp, colors.outlineVariant.copy(alpha = 0.35f))
        CardRole.User -> BorderStroke(1.dp, colors.outlineVariant.copy(alpha = 0.25f))
        CardRole.Content -> BorderStroke(1.dp, colors.outlineVariant.copy(alpha = 0.15f))
        CardRole.Attention -> BorderStroke(1.dp, colors.primary.copy(alpha = 0.6f))
    }
    Surface(
        modifier = modifier,
        shape = shape,
        color = color,
        contentColor = if (role == CardRole.Attention) colors.onSecondaryContainer else colors.onSurface,
        border = border,
    ) {
        Column(Modifier.padding(contentPadding), verticalArrangement = Arrangement.spacedBy(OraculumTokens.CompactSpacing), content = content)
    }
}

@Composable
internal fun MessageContainer(
    embedded: Boolean,
    role: CardRole,
    modifier: Modifier,
    contentPadding: PaddingValues,
    content: @Composable ColumnScope.() -> Unit,
) {
    if (embedded) Column(modifier.padding(contentPadding),
        verticalArrangement = Arrangement.spacedBy(OraculumTokens.CompactSpacing), content = content)
    else OraculumCard(role, modifier, contentPadding, content)
}

@Composable
fun SectionLabel(
    text: String,
    symbol: OraculumSymbol? = null,
    modifier: Modifier = Modifier,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        if (symbol != null) {
            OraculumIcon(symbol, tint = MaterialTheme.colorScheme.primary, size = 18.dp)
            Spacer(Modifier.width(8.dp))
        }
        Text(text, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        trailing?.invoke()
    }
}
