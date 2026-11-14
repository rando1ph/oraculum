package dev.oraculum.poc.ui

private const val FULL_TEXT_BLOCK_CHARACTERS = 4096
private const val FULL_CODE_BLOCK_CHARACTERS = 16 * 1024
private const val FULL_CODE_BLOCK_LINES = 128
private val fullHeading = Regex("^(#{1,6})[ \\t]+(.*)$")
private val fullTask = Regex("^([ \\t]*)[-*+] \\[([ xX])] (.*)$")
private val fullList = Regex("^([ \\t]*)([-*+]|\\d+[.)]) (.*)$")
private val fullRule = Regex("^\\s*([-*_])(?:\\s*\\1){2,}\\s*$")
private val fullCellSeparator = Regex("(?<!\\\\)\\|")

/** Full-document parsing runs off the UI thread; each emitted layout unit stays bounded. */
internal fun fullMarkdownBlocks(text: String): List<MarkdownBlock> {
    val lines = text.replace("\r\n", "\n").split('\n')
    val result = mutableListOf<MarkdownBlock>()

    fun emit(kind: String, body: String, label: String = "", depth: Int = 0, copyText: String? = if (kind == "code") body else null) {
        val maxCharacters = if (kind == "code") FULL_CODE_BLOCK_CHARACTERS else FULL_TEXT_BLOCK_CHARACTERS
        val maxLines = if (kind == "code") FULL_CODE_BLOCK_LINES else Int.MAX_VALUE
        if (body.isEmpty()) {
            result += MarkdownBlock(kind, listOf(""), label, depth, copyText)
            return
        }
        var start = 0
        while (start < body.length) {
            var end = minOf(body.length, start + maxCharacters)
            var lineCount = 1
            for (index in start until end) {
                if (body[index] == '\n' && ++lineCount > maxLines) { end = index; break }
            }
            if (end < body.length && end > start && body[end - 1].isHighSurrogate() && body[end].isLowSurrogate()) end--
            result += MarkdownBlock(kind, body.substring(start, end).split('\n'), label, depth, copyText)
            start = end
        }
    }

    fun fence(line: String): Pair<String, String>? {
        val trimmed = line.trimStart()
        val first = trimmed.firstOrNull() ?: return null
        if (first != '`' && first != '~') return null
        val count = trimmed.takeWhile { it == first }.length
        return if (count >= 3) trimmed.take(count) to trimmed.drop(count).trim() else null
    }

    fun cells(line: String): List<String> = line.trim().removePrefix("|").removeSuffix("|").split(fullCellSeparator)
    fun separator(line: String): List<String>? = cells(line).takeIf { row ->
        row.isNotEmpty() && row.all { cell ->
            val marker = cell.trim().removePrefix(":").removeSuffix(":")
            marker.length >= 3 && marker.all { it == '-' }
        }
    }
    fun depth(prefix: String): Int = prefix.sumOf { if (it == '\t') 4 else 1 } / 2
    fun isRule(line: String): Boolean = line.length <= 128 && fullRule.matches(line)
    fun startsStructured(at: Int): Boolean {
        val line = lines[at]
        return line.isBlank() || fence(line) != null || fullHeading.matches(line) ||
            line.trimStart().startsWith('>') || fullTask.matches(line) || fullList.matches(line) || isRule(line) ||
            (at + 1 < lines.size && '|' in line && separator(lines[at + 1]) != null)
    }

    var index = 0
    while (index < lines.size) {
        val line = lines[index]
        val opening = fence(line)
        val table = if (index + 1 < lines.size && '|' in line) separator(lines[index + 1]) else null
        val heading = fullHeading.matchEntire(line)
        val task = fullTask.matchEntire(line)
        val list = fullList.matchEntire(line)
        when {
            line.isBlank() -> index++
            opening != null -> {
                val start = ++index
                while (index < lines.size) {
                    val closing = lines[index].trimStart()
                    val count = closing.takeWhile { it == opening.first.first() }.length
                    if (count >= opening.first.length && closing.drop(count).isBlank()) break
                    index++
                }
                // Oversized info strings are content too: retain them in the bounded body.
                val label = opening.second.takeIf { it.length <= 128 }.orEmpty()
                val body = lines.subList(start, index).joinToString("\n")
                emit("code", if (label.isEmpty() && opening.second.isNotEmpty()) opening.second + "\n" + body else body, label, copyText = body)
                if (index < lines.size) index++
            }
            table != null -> {
                val start = index
                index += 2
                while (index < lines.size && lines[index].isNotBlank() && '|' in lines[index]) index++
                val source = lines.subList(start, index)
                val rows = listOf(source.first()) + source.drop(2)
                val columns = table.size
                val bounded = columns <= MARKDOWN_PREVIEW_MAX_TABLE_COLUMNS &&
                    rows.size * columns <= MARKDOWN_PREVIEW_MAX_TABLE_CELLS &&
                    source.sumOf { it.length.toLong() + 1 } <= FULL_CODE_BLOCK_CHARACTERS &&
                    rows.all { row -> cells(row).size <= columns }
                if (bounded) {
                    val alignment = table.joinToString(",") { cell ->
                        val marker = cell.trim()
                        when { marker.startsWith(':') && marker.endsWith(':') -> "center"; marker.endsWith(':') -> "right"; else -> "left" }
                    }
                    result += MarkdownBlock("table", rows, alignment)
                } else emit("code", source.joinToString("\n"))
            }
            isRule(line) -> { result += MarkdownBlock("rule", emptyList()); index++ }
            heading != null -> { emit("heading", heading.groupValues[2].replace(Regex("\\s+#+\\s*$"), ""), heading.groupValues[1].length.toString()); index++ }
            line.trimStart().startsWith('>') -> { emit("quote", line.trimStart().removePrefix(">").trimStart()); index++ }
            task != null -> {
                emit("task", task.groupValues[3], if (task.groupValues[2].isBlank()) "☐" else "☑", depth(task.groupValues[1]))
                index++
            }
            list != null -> {
                val marker = list.groupValues[2]
                if (marker.length > 32) emit("text", line)
                else emit("list", list.groupValues[3], if (marker in listOf("-", "*", "+")) "•" else marker, depth(list.groupValues[1]))
                index++
            }
            else -> {
                val start = index++
                var characters = line.length
                while (index < lines.size && characters + 1L + lines[index].length <= FULL_TEXT_BLOCK_CHARACTERS && !startsStructured(index)) {
                    characters += 1 + lines[index].length
                    index++
                }
                emit("text", lines.subList(start, index).joinToString("\n"))
            }
        }
    }
    return result
}
