package dev.oraculum.poc.files

import android.net.Uri
import java.io.File

data class FileRow(val name: String, val path: String, val directory: Boolean, val size: Long, val mime: String)
data class AttachmentChip(val id: String, val name: String, val size: Long, val mime: String, val status: String,
    val removable: Boolean, val previewFile: File? = null)
data class FilePreview(val name: String, val mime: String, val size: Long, val file: File)
data class TransferProgress(val label: String, val completed: Long, val total: Long, val cancellable: Boolean = true)
data class FilesUiState(
    val projectId: String? = null, val threadId: String? = null, val path: String = "", val entries: List<FileRow> = emptyList(),
    val nextCursor: String? = null, val limited: Boolean = false, val busy: Boolean = false, val writable: Boolean = false,
    val readable: Boolean = false, val attachments: List<AttachmentChip> = emptyList(), val preview: FilePreview? = null,
    val progress: TransferProgress? = null, val message: String? = null, val hasUnknown: Boolean = false,
    val fileLimit: Long = FileTransferPolicy.MAX_UPLOAD, val batchLimit: Long = 50L * 1024 * 1024, val countLimit: Int = 6,
)
data class FilesActions(
    val browse: (String) -> Unit = {}, val loadMore: () -> Unit = {}, val select: (FileRow) -> Unit = {},
    val pick: (List<Uri>) -> Unit = {}, val remove: (String) -> Unit = {}, val reconcile: () -> Unit = {},
    val cancel: () -> Unit = {}, val closePreview: () -> Unit = {}, val open: () -> Unit = {},
    val share: () -> Unit = {}, val save: (Uri) -> Unit = {},
    val beginPick: () -> Unit = {}, val beginSave: () -> Unit = {},
)
