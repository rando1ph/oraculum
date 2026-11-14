package dev.oraculum.poc.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.oraculum.poc.repository.boundedContentPreview
import dev.oraculum.poc.repository.CONTENT_PREVIEW_NOTICE
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal data class MarkdownBlock(val kind: String, val lines: List<String>, val label: String = "", val depth: Int = 0, val copyText: String? = null)

internal const val MARKDOWN_PREVIEW_MAX_BLOCKS = 128
internal const val MARKDOWN_PREVIEW_MAX_TABLE_COLUMNS = 8
internal const val MARKDOWN_PREVIEW_MAX_TABLE_CELLS = 128
private val tableCellSeparator = Regex("(?<!\\\\)\\|")

private fun isMarkdownTableSeparator(line: String): Boolean {
    val cells = line.trim().removePrefix("|").removeSuffix("|")
        .split('|', limit = MARKDOWN_PREVIEW_MAX_TABLE_COLUMNS + 1).take(MARKDOWN_PREVIEW_MAX_TABLE_COLUMNS)
    return cells.isNotEmpty() && cells.all { cell ->
        val marker = cell.trim().removePrefix(":").removeSuffix(":")
        marker.length >= 3 && marker.all { it == '-' }
    }
}

/** A local presentation parser: no HTML, remote image loads, script or command execution. */
internal fun markdownBlocks(text: String): List<MarkdownBlock> {
    val preview = boundedContentPreview(sequenceOf(text))
    val lines = preview.text.replace("\r\n", "\n").split('\n')
    val result = mutableListOf<MarkdownBlock>()
    var truncated = preview.truncated
    var tableCellsRemaining = MARKDOWN_PREVIEW_MAX_TABLE_CELLS
    var i = 0
    parse@ while (i < lines.size && result.size < MARKDOWN_PREVIEW_MAX_BLOCKS) {
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
            i + 1 < lines.size && line.contains('|') && isMarkdownTableSeparator(lines[i + 1]) -> {
                val separators = lines[i + 1].trim().removePrefix("|").removeSuffix("|")
                    .split('|', limit = MARKDOWN_PREVIEW_MAX_TABLE_COLUMNS + 1)
                if (separators.size > MARKDOWN_PREVIEW_MAX_TABLE_COLUMNS) truncated = true
                val columns = separators.take(MARKDOWN_PREVIEW_MAX_TABLE_COLUMNS)
                if (tableCellsRemaining < columns.size) { truncated = true; break@parse }
                val alignment = columns.joinToString(",") {
                    val marker = it.trim()
                    when { marker.startsWith(':') && marker.endsWith(':') -> "center"; marker.endsWith(':') -> "right"; else -> "left" }
                }
                val table = mutableListOf(line)
                tableCellsRemaining -= columns.size
                i += 2
                while (i < lines.size && lines[i].contains('|') && lines[i].isNotBlank()) {
                    if (tableCellsRemaining < columns.size) { truncated = true; break }
                    val cells = lines[i].trim().removePrefix("|").removeSuffix("|").split(tableCellSeparator, columns.size + 1)
                    if (cells.size > columns.size) truncated = true
                    table += lines[i++]
                    tableCellsRemaining -= columns.size
                }
                result += MarkdownBlock("table", table, alignment)
                if (i < lines.size && lines[i].contains('|') && lines[i].isNotBlank()) break@parse
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
    if (i < lines.size || truncated) result += MarkdownBlock("notice", listOf(CONTENT_PREVIEW_NOTICE))
    return result
}

@Composable
fun MarkdownContent(text: String, modifier: Modifier = Modifier, complete: Boolean = false) {
    val immediate = remember(text, complete) {
        if (!complete) markdownBlocks(text) else if (text.length <= 64 * 1024) fullMarkdownBlocks(text) else null
    }
    val parsed by produceState(immediate, text, complete) {
        value = immediate ?: withContext(Dispatchers.Default) { fullMarkdownBlocks(text) }
    }
    ReadingContent {
        val blocks = parsed
        if (blocks == null) {
            LinearProgressIndicator(modifier.fillMaxWidth())
            return@ReadingContent
        }
        Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            blocks.forEach { block ->
                when (block.kind) {
                    "code" -> CodeBlock(block.lines.joinToString("\n"), block.label, complete = complete, copyText = block.copyText)
                    "table" -> MarkdownTable(block.lines, block.label.split(','))
                    "rule" -> HorizontalDivider(Modifier.padding(vertical = 4.dp))
                    "notice" -> Text(block.lines.single(), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                    "heading" -> InlineMarkdown(block.lines.first(), style = when (block.label) {
                        "1" -> MaterialTheme.typography.headlineLarge
                        "2" -> MaterialTheme.typography.headlineSmall
                        "3" -> MaterialTheme.typography.titleLarge
                        "4" -> MaterialTheme.typography.titleMedium
                        else -> MaterialTheme.typography.titleSmall
                    }.copy(fontWeight = FontWeight.SemiBold))
                    "quote" -> Row(Modifier.height(IntrinsicSize.Min).background(if (LocalOledTheme.current) Color.Black else MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(8.dp)).padding(12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(Modifier.width(3.dp).fillMaxHeight().background(MaterialTheme.colorScheme.primary, RoundedCornerShape(2.dp)))
                        InlineMarkdown(block.lines.first(), Modifier.weight(1f))
                    }
                    "list", "task" -> Row(Modifier.padding(start = (block.depth.coerceAtMost(4) * 12).dp).semantics {
                        if (block.kind == "task") stateDescription = if (block.label == "☑") "已完成任务" else "未完成任务"
                    }, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(block.label, color = MaterialTheme.colorScheme.primary)
                        InlineMarkdown(block.lines.first(), Modifier.weight(1f))
                    }
                    else -> InlineMarkdown(block.lines.joinToString("\n"))
                }
            }
        }
    }
}

@Composable
private fun MarkdownTable(lines: List<String>, alignments: List<String>) {
    val rows = remember(lines, alignments) { lines.map {
        it.trim().removePrefix("|").removeSuffix("|").split(tableCellSeparator, MARKDOWN_PREVIEW_MAX_TABLE_COLUMNS + 1)
            .take(alignments.size.coerceAtMost(MARKDOWN_PREVIEW_MAX_TABLE_COLUMNS)).map { cell -> cell.trim().replace("\\|", "|") }
    } }
    Surface(color = if (LocalOledTheme.current) Color.Black else MaterialTheme.colorScheme.surfaceContainerLowest, shape = RoundedCornerShape(10.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f))) {
        Column(Modifier.horizontalScroll(rememberScrollState()).semantics { contentDescription = "表格，可横向滚动" }.padding(8.dp)) {
            rows.forEachIndexed { rowIndex, row ->
                Row {
                    row.forEachIndexed { column, cell ->
                        Box(Modifier.width(176.dp).padding(horizontal = 8.dp, vertical = 6.dp)) {
                            InlineMarkdown(cell, Modifier.fillMaxWidth(), style = MaterialTheme.typography.bodyMedium.copy(
                                fontWeight = if (rowIndex == 0) FontWeight.SemiBold else FontWeight.Normal,
                                color = if (rowIndex == 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                                textAlign = when (alignments.getOrNull(column)) { "center" -> TextAlign.Center; "right" -> TextAlign.End; else -> TextAlign.Start }))
                        }
                    }
                }
                if (rowIndex == 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
            }
        }
    }
}

@Composable
internal fun CodeBlock(text: String, language: String = "", modifier: Modifier = Modifier, complete: Boolean = false, copyText: String? = null) {
    val clipboard = LocalClipboardManager.current
    val preview = remember(text, complete) { if (complete) null else boundedContentPreview(sequenceOf(text)) }
    val content = preview?.text ?: text
    val truncated = preview?.truncated == true
    val lines = remember(content) { content.lines() }
    var expanded by rememberSaveable(text) { mutableStateOf(false) }
    val canExpand = lines.size > 12
    val displayedText = if (canExpand && !expanded) lines.take(12).joinToString("\n") else content
    var copied by remember(text) { mutableStateOf(false) }
    ReadingContent {
        Surface(modifier.fillMaxWidth(), color = if (LocalOledTheme.current) Color.Black else MaterialTheme.colorScheme.surfaceContainerLowest,
            shape = RoundedCornerShape(10.dp), border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))) {
            Column {
                Row(Modifier.fillMaxWidth().background(if (LocalOledTheme.current) Color.Black else MaterialTheme.colorScheme.surfaceContainerLow).padding(start = 12.dp, end = 4.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OraculumIcon(OraculumSymbol.Code, tint = MaterialTheme.colorScheme.primary, size = 18.dp)
                    Column(Modifier.weight(1f).padding(vertical = 8.dp)) {
                        Text(language.ifBlank { "代码" }, style = MaterialTheme.typography.labelMedium.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold), maxLines = 1,
                            overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurface)
                        if (canExpand) Text("${lines.size} 行${if (truncated) "预览" else ""}", style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    IconButton(onClick = { clipboard.setText(AnnotatedString(copyText ?: content)); copied = true }, modifier = Modifier.size(48.dp)) {
                        OraculumIcon(if (copied) OraculumSymbol.Check else OraculumSymbol.Copy,
                            contentDescription = if (copied) "代码已复制" else if (truncated) "复制代码预览" else "复制代码",
                            tint = if (copied) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, size = 18.dp)
                    }
                    if (canExpand) IconButton(onClick = { expanded = !expanded }, modifier = Modifier.size(48.dp).semantics {
                        stateDescription = if (expanded) "代码已展开" else "代码已折叠"
                    }) {
                        OraculumIcon(if (expanded) OraculumSymbol.ExpandLess else OraculumSymbol.ExpandMore,
                            contentDescription = if (expanded) "收起代码" else if (complete) "展开代码" else "展开代码预览", size = 18.dp)
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f))
                if (truncated) Text(CONTENT_PREVIEW_NOTICE, Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                SelectionContainer {
                    Text(displayedText, Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(14.dp).semantics { contentDescription = "代码，可横向滚动" },
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, lineHeight = MaterialTheme.typography.bodySmall.lineHeight * 1.15f), softWrap = false)
                }
                if (canExpand && !expanded) TextButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    OraculumIcon(OraculumSymbol.ExpandMore, size = 18.dp)
                    Spacer(Modifier.width(8.dp))
                    Text("展开其余 ${lines.size - 12} 行${if (truncated) "预览" else ""}")
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
    inlineMarkdownPattern.findAll(text).take(256).forEach { match ->
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
