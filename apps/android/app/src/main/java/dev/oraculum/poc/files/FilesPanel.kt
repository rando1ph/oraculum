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
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

@Composable
fun FilesPanel(state: FilesUiState, actions: FilesActions) {
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(state.preview?.mime ?: "application/octet-stream")) { uri -> uri?.let(actions.save) }
    Column(Modifier.fillMaxSize().testTag("files_panel").verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("项目文件与成果", style = MaterialTheme.typography.titleLarge)
        Text("仅显示 Gateway 授权的项目文件。下载会校验类型、大小、摘要和授权有效期。", style = MaterialTheme.typography.bodySmall)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton({ actions.browse("") }, enabled = state.readable && !state.busy, modifier = Modifier.testTag("files_refresh")) { Text("刷新文件") }
            if (state.path.isNotEmpty()) TextButton({ actions.browse(state.path.substringBeforeLast('/', "")) }, enabled = state.readable && !state.busy) { Text("上一级") }
        }
        Text(if (state.path.isEmpty()) "项目根目录" else state.path, style = MaterialTheme.typography.labelMedium)
        if (!state.readable) Text("连接并选择可用项目后可浏览文件。", color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (state.entries.isEmpty() && state.readable && !state.busy) Text("点击刷新读取文件。空目录或不支持的文件类型不会显示。", style = MaterialTheme.typography.bodySmall)
        state.entries.forEach { row ->
            Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = MaterialTheme.shapes.medium,
                modifier = Modifier.fillMaxWidth().testTag("file_${row.name}").clickable(enabled = state.readable && !state.busy) { actions.select(row) }) {
                Column(Modifier.padding(14.dp)) {
                    Text((if (row.directory) "▸  " else "▤  ") + row.name, style = MaterialTheme.typography.titleSmall)
                    Text(if (row.directory) "文件夹" else "${formatSize(row.size)} · ${row.mime}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        if (state.nextCursor != null) TextButton(actions.loadMore, enabled = !state.busy && state.readable) { Text("加载更多文件") }
        if (state.limited) Text("此目录条目过多；列表已按 Gateway 扫描上限截断。", style = MaterialTheme.typography.bodySmall)
        HorizontalDivider()
        AttachmentChips(state, actions)
        state.preview?.let { preview ->
            HorizontalDivider()
            Column(Modifier.testTag("files_preview"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(preview.name, style = MaterialTheme.typography.titleMedium)
                Text("${formatSize(preview.size)} · 摘要已验证", style = MaterialTheme.typography.labelMedium)
                FilePreviewContent(preview)
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(actions.open, modifier = Modifier.testTag("files_open")) { Text("系统打开") }
                    OutlinedButton(actions.share, modifier = Modifier.testTag("files_share")) { Text("分享") }
                    OutlinedButton({ actions.beginSave(); saver.launch(preview.name) }, enabled = !state.busy, modifier = Modifier.testTag("files_save")) { Text("保存") }
                    TextButton(actions.closePreview) { Text("关闭预览") }
                }
            }
        }
        state.progress?.let { progress ->
            Text(progress.label, style = MaterialTheme.typography.labelLarge)
            LinearProgressIndicator(progress = { if (progress.total > 0) (progress.completed.toFloat() / progress.total).coerceIn(0f, 1f) else 0f }, modifier = Modifier.fillMaxWidth())
            Text("${formatSize(progress.completed)} / ${formatSize(progress.total)}", style = MaterialTheme.typography.bodySmall)
        }
        if (state.busy) TextButton(actions.cancel, modifier = Modifier.testTag("files_cancel")) { Text("取消当前传输") }
        state.message?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium) }
    }
}

@Composable
fun AttachmentChips(state: FilesUiState, actions: FilesActions, compact: Boolean = false) {
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments(), actions.pick)
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (!compact) Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton({ actions.beginPick(); picker.launch(FileTransferPolicy.types.values.distinct().toTypedArray()) },
                enabled = state.writable && !state.busy && !state.hasUnknown, modifier = Modifier.testTag("files_pick")) { Text("添加附件") }
            if (state.attachments.isNotEmpty()) TextButton(actions.reconcile, enabled = state.readable && !state.busy,
                modifier = Modifier.testTag("files_reconcile")) { Text("核对附件") }
        }
        if (state.attachments.isNotEmpty()) {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                state.attachments.forEach { attachment ->
                    Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.medium,
                        modifier = Modifier.widthIn(min = 120.dp, max = 220.dp).testTag("attachment_${attachment.name}")) {
                        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            if (!compact) attachment.previewFile?.let { file -> Thumbnail(file, attachment.name) }
                            Text(attachment.name, style = MaterialTheme.typography.labelLarge)
                            Text("${formatSize(attachment.size)} · ${attachmentStatus(attachment.status)}", style = MaterialTheme.typography.bodySmall)
                            if (attachment.removable && !compact) TextButton({ actions.remove(attachment.id) }, enabled = state.writable && !state.busy) { Text("移除") }
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
        Text("+", style = MaterialTheme.typography.headlineMedium)
    }
}

@Composable
private fun Thumbnail(file: File, label: String) {
    val bitmap by produceState<Bitmap?>(null, file) { value = withContext(Dispatchers.IO) { boundedBitmap(file, 360) } }
    DisposableEffect(bitmap) { onDispose { bitmap?.recycle() } }
    bitmap?.let { Image(it.asImageBitmap(), contentDescription = "附件预览：$label", modifier = Modifier.size(84.dp)) }
}

@Composable
private fun FilePreviewContent(preview: FilePreview) {
    var failure by remember(preview.file) { mutableStateOf(false) }
    if (preview.mime.startsWith("image/")) {
        val bitmap by produceState<Bitmap?>(null, preview.file) {
            value = withContext(Dispatchers.IO) { boundedBitmap(preview.file, 2048) }; failure = value == null
        }
        DisposableEffect(bitmap) { onDispose { bitmap?.recycle() } }
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
        DisposableEffect(bitmap) { onDispose { bitmap?.recycle() } }
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
