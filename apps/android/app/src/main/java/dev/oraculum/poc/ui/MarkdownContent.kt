package dev.oraculum.poc.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

internal data class MarkdownBlock(val kind: String, val lines: List<String>, val label: String = "", val depth: Int = 0)

/** A local presentation parser: no HTML, remote image loads, script or command execution. */
internal fun markdownBlocks(text: String): List<MarkdownBlock> {
    val lines = text.replace("\r\n", "\n").split('\n')
    val result = mutableListOf<MarkdownBlock>()
    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        val fence = Regex("^\\s*(`{3,}|~{3,})(.*)$").find(line)
        when {
            line.isBlank() -> i++
            fence != null -> {
                val token = fence.groupValues[1]
                val code = mutableListOf<String>()
                i++
                while (i < lines.size && !lines[i].trimStart().startsWith(token)) code += lines[i++]
                if (i < lines.size) i++
                result += MarkdownBlock("code", code, fence.groupValues[2].trim())
            }
            i + 1 < lines.size && line.contains('|') && Regex("^\\s*\\|?\\s*:?-{3,}:?\\s*(\\|\\s*:?-{3,}:?\\s*)+\\|?\\s*$").matches(lines[i + 1]) -> {
                val table = mutableListOf(line)
                val alignment = lines[i + 1].trim().removePrefix("|").removeSuffix("|").split('|').joinToString(",") {
                    val marker = it.trim()
                    when { marker.startsWith(':') && marker.endsWith(':') -> "center"; marker.endsWith(':') -> "right"; else -> "left" }
                }
                i += 2
                while (i < lines.size && lines[i].contains('|') && lines[i].isNotBlank()) table += lines[i++]
                result += MarkdownBlock("table", table, alignment)
            }
            Regex("^\\s*([-*_])(?:\\s*\\1){2,}\\s*$").matches(line) -> { result += MarkdownBlock("rule", emptyList()); i++ }
            Regex("^#{1,6}\\s").containsMatchIn(line) -> { result += MarkdownBlock("heading", listOf(line.replaceFirst(Regex("^#{1,6}\\s+"), "").replace(Regex("\\s+#+\\s*$"), "")), line.takeWhile { it == '#' }.length.toString()); i++ }
            line.trimStart().startsWith('>') -> { result += MarkdownBlock("quote", listOf(line.trimStart().removePrefix(">").trimStart())); i++ }
            Regex("^\\s*[-*+] \\[[ xX]] ").containsMatchIn(line) -> {
                val match = Regex("^\\s*[-*+] \\[([ xX])] (.*)$").find(line)!!
                result += MarkdownBlock("task", listOf(match.groupValues[2]), if (match.groupValues[1].isBlank()) "☐" else "☑", line.takeWhile { it == ' ' || it == '\t' }.sumOf { if (it == '\t') 4 else 1 } / 2); i++
            }
            Regex("^\\s*(?:[-*+] |\\d+[.)] )").containsMatchIn(line) -> {
                val match = Regex("^\\s*([-*+]|\\d+[.)]) (.*)$").find(line)!!
                result += MarkdownBlock("list", listOf(match.groupValues[2]), if (match.groupValues[1] in listOf("-", "*", "+")) "•" else match.groupValues[1], line.takeWhile { it == ' ' || it == '\t' }.sumOf { if (it == '\t') 4 else 1 } / 2); i++
            }
            else -> { result += MarkdownBlock("text", listOf(line)); i++ }
        }
    }
    return result
}

@Composable
fun MarkdownContent(text: String, modifier: Modifier = Modifier) {
    ReadingContent {
        val blocks = remember(text) { markdownBlocks(text) }
        Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            blocks.forEach { block ->
                when (block.kind) {
                    "code" -> CodeBlock(block.lines.joinToString("\n"), block.label)
                    "table" -> MarkdownTable(block.lines, block.label.split(','))
                    "rule" -> HorizontalDivider(Modifier.padding(vertical = 4.dp))
                    "heading" -> InlineMarkdown(block.lines.first(), style = when (block.label) {
                        "1" -> MaterialTheme.typography.headlineLarge
                        "2" -> MaterialTheme.typography.headlineSmall
                        "3" -> MaterialTheme.typography.titleLarge
                        "4" -> MaterialTheme.typography.titleMedium
                        else -> MaterialTheme.typography.titleSmall
                    }.copy(fontWeight = FontWeight.SemiBold))
                    "quote" -> Row(Modifier.background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(8.dp)).padding(12.dp)) {
                        Text("│", color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(end = 8.dp))
                        InlineMarkdown(block.lines.first(), Modifier.weight(1f))
                    }
                    "list", "task" -> Row(Modifier.padding(start = (block.depth.coerceAtMost(4) * 12).dp).semantics {
                        if (block.kind == "task") stateDescription = if (block.label == "☑") "已完成任务" else "未完成任务"
                    }, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(block.label, color = MaterialTheme.colorScheme.primary)
                        InlineMarkdown(block.lines.first(), Modifier.weight(1f))
                    }
                    else -> InlineMarkdown(block.lines.first())
                }
            }
        }
    }
}

@Composable
private fun MarkdownTable(lines: List<String>, alignments: List<String>) {
    val rows = remember(lines) { lines.map { it.trim().removePrefix("|").removeSuffix("|").split(Regex("(?<!\\\\)\\|")).map { cell -> cell.trim().replace("\\|", "|") } } }
    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = RoundedCornerShape(12.dp)) {
        Column(Modifier.horizontalScroll(rememberScrollState()).semantics { contentDescription = "表格，可横向滚动" }.padding(8.dp)) {
            rows.forEachIndexed { rowIndex, row ->
                Row {
                    row.forEachIndexed { column, cell ->
                        Box(Modifier.width(176.dp).padding(8.dp)) {
                            InlineMarkdown(cell, Modifier.fillMaxWidth(), style = MaterialTheme.typography.bodyMedium.copy(
                                fontWeight = if (rowIndex == 0) FontWeight.Bold else FontWeight.Normal,
                                textAlign = when (alignments.getOrNull(column)) { "center" -> TextAlign.Center; "right" -> TextAlign.End; else -> TextAlign.Start }))
                        }
                    }
                }
                if (rowIndex == 0) HorizontalDivider()
            }
        }
    }
}

@Composable
internal fun CodeBlock(text: String, language: String = "", modifier: Modifier = Modifier) {
    val clipboard = LocalClipboardManager.current
    var copied by remember(text) { mutableStateOf(false) }
    ReadingContent {
        Surface(modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceContainerHigh,
            shape = RoundedCornerShape(16.dp), border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
            Column {
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(language.ifBlank { "代码" }, Modifier.padding(vertical = 16.dp).weight(1f), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                    TextButton(onClick = { clipboard.setText(AnnotatedString(text)); copied = true }, modifier = Modifier.heightIn(min = 48.dp)) { Text(if (copied) "已复制" else "复制") }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                SelectionContainer {
                    Text(text, Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(16.dp).semantics { contentDescription = "代码，可横向滚动" },
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, lineHeight = MaterialTheme.typography.bodySmall.lineHeight * 1.125f), softWrap = false)
                }
            }
        }
    }
}

internal data class MarkdownInlineToken(val kind: String, val text: String, val destination: String? = null)

// Underscores inside identifiers are literal (CommonMark intraword rule).
private val inlineMarkdownPattern = Regex("""(?<!\\)(\[([^]\n]+)]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|(?<![\p{L}\p{N}_])__([^_]+)__(?![\p{L}\p{N}_])|~~([^~]+)~~|(?<!\*)\*([^*]+)\*(?!\*)|(?<![\p{L}\p{N}_])_([^_]+)_(?![\p{L}\p{N}_]))""")

internal fun markdownInlineTokens(text: String): List<MarkdownInlineToken> = buildList {
    var cursor = 0
    inlineMarkdownPattern.findAll(text).forEach { match ->
        if (match.range.first > cursor) add(MarkdownInlineToken("text", text.substring(cursor, match.range.first)))
        add(when {
            match.groupValues[2].isNotEmpty() -> MarkdownInlineToken("link", match.groupValues[2], match.groupValues[3])
            match.groupValues[4].isNotEmpty() -> MarkdownInlineToken("code", match.groupValues[4])
            match.groupValues[5].isNotEmpty() || match.groupValues[6].isNotEmpty() -> MarkdownInlineToken("strong", match.groupValues[5].ifBlank { match.groupValues[6] })
            match.groupValues[7].isNotEmpty() -> MarkdownInlineToken("strike", match.groupValues[7])
            else -> MarkdownInlineToken("emphasis", match.groupValues[8].ifBlank { match.groupValues[9] })
        })
        cursor = match.range.last + 1
    }
    if (cursor < text.length) add(MarkdownInlineToken("text", text.substring(cursor)))
}

@Composable
private fun InlineMarkdown(text: String, modifier: Modifier = Modifier, style: TextStyle = MaterialTheme.typography.bodyMedium) {
    val primary = MaterialTheme.colorScheme.primary
    val foreground = MaterialTheme.colorScheme.onSurface
    val uriHandler = LocalUriHandler.current
    val annotated = remember(text, primary) {
        buildAnnotatedString {
            markdownInlineTokens(text).forEach { token ->
                when (token.kind) {
                    "link" -> {
                        val url = token.destination.orEmpty()
                        val safe = Regex("^(https?://|mailto:)", RegexOption.IGNORE_CASE).containsMatchIn(url)
                        if (safe) withLink(LinkAnnotation.Clickable(url, TextLinkStyles(SpanStyle(color = primary, textDecoration = TextDecoration.Underline))) {
                            runCatching { uriHandler.openUri(url) }
                        }) { append(token.text) }
                        else append(token.text)
                    }
                    "code" -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = primary)) { append(token.text) }
                    "strong" -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(token.text) }
                    "strike" -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(token.text) }
                    "emphasis" -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(token.text) }
                    else -> append(token.text)
                }
            }
        }
    }
    SelectionContainer {
        // Compose supplies accessible link semantics; only explicit safe links can open.
        Text(annotated, modifier, style = style.copy(color = foreground))
    }
}
