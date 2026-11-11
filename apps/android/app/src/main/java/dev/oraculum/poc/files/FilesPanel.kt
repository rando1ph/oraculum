package dev.oraculum.poc.files

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.oraculum.poc.ui.CardRole
import dev.oraculum.poc.ui.OraculumCard
import dev.oraculum.poc.ui.OraculumIcon
import dev.oraculum.poc.ui.OraculumSymbol
import dev.oraculum.poc.ui.SectionLabel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

@Composable
fun FilesPanel(state: FilesUiState, actions: FilesActions) {
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(state.preview?.mime ?: "application/octet-stream")) { uri -> uri?.let(actions.save) }
    Column(Modifier.fillMaxSize().testTag("files_panel").verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionLabel("项目文件与成果", OraculumSymbol.Folder)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton({ actions.browse("") }, enabled = state.readable && !state.busy, modifier = Modifier.heightIn(min = 48.dp).testTag("files_refresh")) {
                FileActionLabel(OraculumSymbol.Refresh, "刷新文件")
            }
            if (state.path.isNotEmpty()) TextButton({ actions.browse(state.path.substringBeforeLast('/', "")) }, enabled = state.readable && !state.busy, modifier = Modifier.heightIn(min = 48.dp)) {
                FileActionLabel(OraculumSymbol.ArrowBack, "上一级")
            }
        }
        Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.small) {
            Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OraculumIcon(OraculumSymbol.Folder, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                SelectionContainer { Text(if (state.path.isEmpty()) "项目根目录" else state.path, style = MaterialTheme.typography.labelMedium) }
            }
        }
        if (!state.readable) Text("连接并选择可用项目后可浏览文件。", color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (state.entries.isEmpty() && state.readable && !state.busy) Text("点击刷新读取文件。空目录或不支持的文件类型不会显示。", style = MaterialTheme.typography.bodySmall)
        if (state.entries.isNotEmpty()) Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = MaterialTheme.shapes.large) {
            Column {
                state.entries.forEachIndexed { index, row ->
                    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).testTag("file_${row.name}")
                        .clickable(enabled = state.readable && !state.busy) { actions.select(row) }.padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        OraculumIcon(if (row.directory) OraculumSymbol.Folder else OraculumSymbol.Description,
                            tint = if (row.directory) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(row.name, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text(if (row.directory) "文件夹" else "${formatSize(row.size)} · ${row.mime}", style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        OraculumIcon(OraculumSymbol.ChevronRight, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (index < state.entries.lastIndex) HorizontalDivider(Modifier.padding(start = 44.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .5f))
                }
            }
        }
        if (state.nextCursor != null) TextButton(actions.loadMore, enabled = !state.busy && state.readable, modifier = Modifier.heightIn(min = 48.dp)) { FileActionLabel(OraculumSymbol.ExpandMore, "加载更多文件") }
        if (state.limited) Text("此目录条目过多；列表已按 Gateway 扫描上限截断。", style = MaterialTheme.typography.bodySmall)
        state.preview?.let { preview ->
            OraculumCard(role = CardRole.Inset, modifier = Modifier.testTag("files_preview"), contentPadding = PaddingValues(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(preview.name, style = MaterialTheme.typography.titleSmall)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            OraculumIcon(OraculumSymbol.Check, size = 16.dp, tint = MaterialTheme.colorScheme.primary)
                            Text("${formatSize(preview.size)} · 摘要已验证", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    IconButton(actions.closePreview, modifier = Modifier.size(48.dp)) { OraculumIcon(OraculumSymbol.Close, "关闭预览") }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                FilePreviewContent(preview)
                Button({ actions.beginSave(); saver.launch(preview.name) }, enabled = !state.busy,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("files_save")) { FileActionLabel(OraculumSymbol.Download, "保存到设备") }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(actions.open, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("files_open")) { FileActionLabel(OraculumSymbol.OpenInNew, "系统打开") }
                    OutlinedButton(actions.share, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("files_share")) { FileActionLabel(OraculumSymbol.Share, "分享") }
                }
            }
        }
        SectionLabel("本机附件", OraculumSymbol.AttachFile)
        AttachmentChips(state, actions)
        state.progress?.let { progress ->
            Text(progress.label, style = MaterialTheme.typography.labelLarge)
            LinearProgressIndicator(progress = { if (progress.total > 0) (progress.completed.toFloat() / progress.total).coerceIn(0f, 1f) else 0f }, modifier = Modifier.fillMaxWidth())
            Text("${formatSize(progress.completed)} / ${formatSize(progress.total)}", style = MaterialTheme.typography.bodySmall)
        }
        if (state.busy) TextButton(actions.cancel, modifier = Modifier.heightIn(min = 48.dp).testTag("files_cancel")) { FileActionLabel(OraculumSymbol.Close, "取消当前传输") }
        state.message?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OraculumIcon(OraculumSymbol.Shield, tint = MaterialTheme.colorScheme.onSurfaceVariant, size = 18.dp)
            Text("仅显示 Gateway 授权的项目文件。下载会校验类型、大小、摘要和授权有效期。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
fun AttachmentChips(state: FilesUiState, actions: FilesActions, compact: Boolean = false) {
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments(), actions.pick)
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (!compact) Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton({ actions.beginPick(); picker.launch(FileTransferPolicy.types.values.distinct().toTypedArray()) },
                enabled = state.writable && !state.busy && !state.hasUnknown, modifier = Modifier.heightIn(min = 48.dp).testTag("files_pick")) { FileActionLabel(OraculumSymbol.AttachFile, "添加附件") }
            if (state.attachments.isNotEmpty()) TextButton(actions.reconcile, enabled = state.readable && !state.busy,
                modifier = Modifier.heightIn(min = 48.dp).testTag("files_reconcile")) { FileActionLabel(OraculumSymbol.Refresh, "核对附件") }
        }
        if (state.attachments.isNotEmpty()) {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                state.attachments.forEach { attachment ->
                    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium,
                        modifier = Modifier.widthIn(min = 120.dp, max = 220.dp).testTag("attachment_${attachment.name}")) {
                        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            if (!compact) attachment.previewFile?.let { file -> Thumbnail(file, attachment.name) }
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                OraculumIcon(OraculumSymbol.AttachFile, tint = MaterialTheme.colorScheme.primary, size = 18.dp)
                                Text(attachment.name, style = MaterialTheme.typography.labelLarge, maxLines = if (compact) 2 else Int.MAX_VALUE, overflow = TextOverflow.Ellipsis)
                            }
                            Text("${formatSize(attachment.size)} · ${attachmentStatus(attachment.status)}", style = MaterialTheme.typography.bodySmall)
                            if (attachment.removable && !compact) TextButton({ actions.remove(attachment.id) }, enabled = state.writable && !state.busy, modifier = Modifier.heightIn(min = 48.dp)) { FileActionLabel(OraculumSymbol.Delete, "移除") }
                        }
                    }
                }
            }
        }
        if (state.hasUnknown) Text("附件操作结果未知。请核对回执；应用不会重新上传、认领或发送。", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        if (state.writable && !compact) Text("最多 ${state.countLimit} 个；单文件 ${formatSize(state.fileLimit)}，草稿总量 ${formatSize(state.batchLimit)}。", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
fun AttachmentPickerButton(state: FilesUiState, actions: FilesActions, modifier: Modifier = Modifier) {
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments(), actions.pick)
    IconButton({ actions.beginPick(); picker.launch(FileTransferPolicy.types.values.distinct().toTypedArray()) },
        enabled = state.writable && !state.busy && !state.hasUnknown,
        modifier = modifier.size(48.dp).testTag("files_pick").semantics { contentDescription = "添加图片或文档附件" }) {
        OraculumIcon(OraculumSymbol.AttachFile, size = 24.dp)
    }
}

@Composable
private fun RowScope.FileActionLabel(symbol: OraculumSymbol, text: String) {
    OraculumIcon(symbol)
    Spacer(Modifier.width(6.dp))
    Text(text)
}

@Composable
private fun Thumbnail(file: File, label: String) {
    val bitmap by produceState<Bitmap?>(null, file) { value = withContext(Dispatchers.IO) { boundedBitmap(file, 360) } }
    // Image/BitmapPainter retains these pixels for drawing. Let GC release them after
    // all UI references disappear; disposing a state-keyed effect can recycle the
    // newly decoded value, and composition disposal is not a rendering fence.
    bitmap?.let { Image(it.asImageBitmap(), contentDescription = "附件预览：$label", modifier = Modifier.size(84.dp)) }
}

@Composable
private fun FilePreviewContent(preview: FilePreview) {
    var failure by remember(preview.file) { mutableStateOf(false) }
    if (preview.mime.startsWith("image/")) {
        val bitmap by produceState<Bitmap?>(null, preview.file) {
            value = withContext(Dispatchers.IO) { boundedBitmap(preview.file, 2048) }; failure = value == null
        }
        bitmap?.let { Image(it.asImageBitmap(), "成果图片：${preview.name}", Modifier.fillMaxWidth().heightIn(max = 360.dp)) }
    } else if (preview.mime == "application/pdf" && preview.size <= 16L * 1024 * 1024) {
        val bitmap by produceState<Bitmap?>(null, preview.file) {
            value = withContext(Dispatchers.IO) { runCatching {
                ParcelFileDescriptor.open(preview.file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
                    PdfRenderer(descriptor).use { renderer ->
                        require(renderer.pageCount > 0)
                        renderer.openPage(0).use { page ->
                            require(page.width > 0 && page.height > 0)
                            val factor = minOf(1f, 1600f / maxOf(page.width, page.height))
                            Bitmap.createBitmap((page.width * factor).toInt().coerceAtLeast(1), (page.height * factor).toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888).also {
                                it.eraseColor(android.graphics.Color.WHITE); page.render(it, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                            }
                        }
                    }
                }
            }.getOrNull() }; failure = value == null
        }
        bitmap?.let { Image(it.asImageBitmap(), "PDF 第一页：${preview.name}", Modifier.fillMaxWidth().heightIn(max = 420.dp)) }
        Text("预览第 1 页；使用系统打开阅读完整 PDF。", style = MaterialTheme.typography.bodySmall)
    } else if (preview.mime.startsWith("text/") && preview.size <= FileTransferPolicy.MAX_TEXT_PREVIEW) {
        val text by produceState<String?>(null, preview.file) { value = withContext(Dispatchers.IO) {
            runCatching {
                require(preview.file.length() == preview.size)
                val bytes = preview.file.inputStream().use { input ->
                    val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
                    while (true) { val n = input.read(buffer); if (n < 0) break; require(output.size() + n <= FileTransferPolicy.MAX_TEXT_PREVIEW); output.write(buffer, 0, n) }
                    output.toByteArray()
                }
                require(bytes.size <= FileTransferPolicy.MAX_TEXT_PREVIEW && !bytes.contains(0))
                Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
            }.getOrNull()
        }; failure = value == null }
        text?.let { SelectionContainer { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.fillMaxWidth().heightIn(max = 360.dp).verticalScroll(rememberScrollState())) } }
    } else Text("此文档提供已验证下载；使用系统打开或保存。", style = MaterialTheme.typography.bodyMedium)
    if (failure) Text("无法安全生成预览。可保存后使用兼容应用打开。", color = MaterialTheme.colorScheme.error)
}

private fun boundedBitmap(file: File, dimension: Int): Bitmap? = runCatching {
    require(file.length() <= FileTransferPolicy.MAX_UPLOAD)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    require(bounds.outWidth in 1..16384 && bounds.outHeight in 1..16384 && bounds.outWidth.toLong() * bounds.outHeight <= 40_000_000)
    var sample = 1
    while (bounds.outWidth / sample > dimension || bounds.outHeight / sample > dimension) sample *= 2
    BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
}.getOrNull()
private fun formatSize(bytes: Long) = when { bytes >= 1024 * 1024 -> "%.1f MB".format(bytes / (1024.0 * 1024)); bytes >= 1024 -> "%.1f KB".format(bytes / 1024.0); else -> "$bytes B" }
private fun attachmentStatus(status: String) = when (status) {
    "ready" -> "可发送"; "selected" -> "尚未上传"; "unknown" -> "上传结果未知"; "held" -> "认领结果待核对"
    "sent" -> "已发送"; "deleting" -> "删除结果待核对"; "expired" -> "已过期"; "rejected" -> "上传被拒绝"; else -> "待核对"
}
