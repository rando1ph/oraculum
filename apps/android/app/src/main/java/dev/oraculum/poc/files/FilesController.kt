package dev.oraculum.poc.files

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import dev.oraculum.poc.gateway.GatewayClient
import dev.oraculum.poc.gateway.GatewayException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import kotlin.coroutines.coroutineContext

/** UI only coordinates authorized Gateway IO. Unknown uploads/claims are never a replay queue. */
class FilesController(
    context: Context, private val gateway: GatewayClient, private val coroutineScope: CoroutineScope,
    private val beginWrite: suspend (operationId: String, kind: String, projectId: String, threadId: String) -> Unit,
    private val acceptReceipt: suspend (JsonObject) -> Unit,
    private val beforeDispatch: () -> Unit,
    private val notDispatched: suspend (String) -> Unit = {},
) {
    private val context = context.applicationContext
    private val store = AttachmentStateStore(context)
    private val lock = Mutex()
    private val mutations = Mutex()
    private val _state = MutableStateFlow(FilesUiState())
    val state: StateFlow<FilesUiState> = _state.asStateFlow()
    private var draft: AttachmentDraft? = null
    private var boundScope: String? = null
    private var currentJob: Job? = null
    private var generation = 0L
    private var storageSafe = true
    private var pickerGeneration: Long? = null
    private var saveSelection: FilePreview? = null
    private val previews = PreviewCache(File(context.cacheDir, "artifact-shares"))
    fun actions() = FilesActions(::browse, ::loadMore, ::select, ::pick, ::remove, ::reconcile, ::cancel, ::closePreview, ::open, ::share, ::save,
        { pickerGeneration = generation }, { saveSelection = state.value.preview })

    suspend fun bind(scopeKey: String, projectId: String?, threadId: String?, online: Boolean, capabilities: JsonObject? = null) = lock.withLock {
        val changed = boundScope != scopeKey || state.value.projectId != projectId || state.value.threadId != threadId
        if (changed) {
            generation++; currentJob?.cancel()
            mutations.withLock {
                boundScope = scopeKey; draft = null; storageSafe = true
                _state.value = FilesUiState(projectId = projectId, threadId = threadId)
                if (projectId != null && threadId != null) {
                    try { draft = withContext(Dispatchers.IO) { store.read(scopeKey, projectId, threadId) } }
                    catch (_: Exception) { storageSafe = false; _state.update { it.copy(message = "附件安全状态无法读取。已保留原文件并停止上传和发送，请修复本机存储。") } }
                }
            }
        }
        val limits = capabilities?.get("limits") as? JsonObject
        fun limit(key: String, fallback: Long) = (limits?.get(key) as? JsonPrimitive)?.longOrNull?.coerceIn(1, fallback) ?: fallback
        val list = (capabilities?.get("capabilities") as? JsonArray).orEmpty()
        fun supported(name: String) = list.any { (it as? JsonObject)?.get("name")?.jsonPrimitive?.content == name && it.jsonObject["supported"]?.jsonPrimitive?.booleanOrNull == true }
        _state.update { it.copy(readable = online && projectId != null && supported("files"),
            writable = online && threadId != null && storageSafe && supported("attachments"), fileLimit = limit("attachmentFileBytes", FileTransferPolicy.MAX_UPLOAD),
            batchLimit = limit("attachmentBatchBytes", 50L * 1024 * 1024), countLimit = limit("attachmentBatchCount", 6).toInt()) }
        publishDraft()
        if (changed) {
            val protected = protectedPreviews()
            withContext(Dispatchers.IO) { previews.clean(protected) }
        }
    }

    fun browse(path: String = "") = runAction {
        check(state.value.readable); require(FileTransferPolicy.relativePath(path, true))
        val pid = requireNotNull(state.value.projectId); val expected = generation
        val response = gateway.post("projects/${GatewayClient.segment(pid)}/files/query", buildJsonObject { put("path", path); put("limit", 80) })
        checkGeneration(expected)
        val page = response.getValue("data").jsonObject
        val rows = parseRows(page, path)
        _state.update { it.copy(path = path, entries = rows, nextCursor = page.nullable("nextCursor"), limited = page["limited"]?.jsonPrimitive?.boolean == true) }
    }
    fun loadMore() = runAction {
        check(state.value.readable)
        val cursor = state.value.nextCursor ?: return@runAction
        val path = state.value.path; val pid = requireNotNull(state.value.projectId); val expected = generation
        val response = gateway.post("projects/${GatewayClient.segment(pid)}/files/query", buildJsonObject { put("path", path); put("limit", 80); put("cursor", cursor) })
        checkGeneration(expected); val page = response.getValue("data").jsonObject
        _state.update { it.copy(entries = (it.entries + parseRows(page, path)).distinctBy(FileRow::path), nextCursor = page.nullable("nextCursor")) }
    }
    private fun parseRows(page: JsonObject, path: String): List<FileRow> {
        require(page.getValue("path").jsonPrimitive.content == path)
        return page.getValue("entries").jsonArray.map { value ->
            val row = value.jsonObject; val name = row.getValue("name").jsonPrimitive.content
            val relative = row.getValue("path").jsonPrimitive.content; val directory = row.getValue("directory").jsonPrimitive.boolean
            val size = row.getValue("size").jsonPrimitive.long; val mime = row.getValue("mime").jsonPrimitive.content
            require(FileTransferPolicy.safeName(name) && relative == listOf(path, name).filter(String::isNotEmpty).joinToString("/") &&
                FileTransferPolicy.relativePath(relative) && size in 0..FileTransferPolicy.MAX_DOWNLOAD)
            if (!directory) require(FileTransferPolicy.canonicalMime(name, mime, false) == mime)
            FileRow(name, relative, directory, size, mime)
        }
    }
    fun select(row: FileRow) {
        if (row.directory) { browse(row.path); return }
        runAction {
            check(state.value.readable); require(state.value.entries.contains(row))
            val pid = requireNotNull(state.value.projectId); val tid = state.value.threadId; val expected = generation
            val result = gateway.post("projects/${GatewayClient.segment(pid)}/files/select", buildJsonObject { put("path", row.path); tid?.let { put("threadId", it) } })
            checkGeneration(expected); val data = result.getValue("data").jsonObject
            val grant = HostFileGrant(data.getValue("fileId").jsonPrimitive.content, data.getValue("projectId").jsonPrimitive.content,
                data.nullable("threadId"), data.getValue("path").jsonPrimitive.content, data.getValue("name").jsonPrimitive.content,
                data.getValue("mime").jsonPrimitive.content, data.getValue("size").jsonPrimitive.long, data.getValue("expiresAt").jsonPrimitive.long)
            require(grant.projectId == pid && grant.threadId == tid && grant.path == row.path && grant.mime == row.mime && grant.size == row.size)
            val protected = protectedPreviews()
            val target = withContext(Dispatchers.IO) { previews.reserve(grant.size, protected) }
            try {
                gateway.downloadFile(grant, target) { done, total -> progress("下载 ${row.name}", done, total, expected) }
                checkGeneration(expected)
                withContext(Dispatchers.IO) { previews.retain(target) }
                _state.update { it.copy(preview = FilePreview(grant.name, grant.mime, grant.size, target)) }
            } catch (error: Throwable) { target.delete(); throw error }
        }
    }
    fun pick(uris: List<Uri>) {
        val pickedAt = pickerGeneration
        pickerGeneration = null
        if (uris.isEmpty()) return // Picker cancellation does not mutate a draft or start network IO.
        if (pickedAt != null && pickedAt != generation) {
            _state.update { it.copy(message = "选择器打开期间会话已改变，请在当前会话重新选择附件。") }; return
        }
        runAction {
            check(state.value.writable); require(uris.size <= state.value.countLimit && uris.distinct().size == uris.size)
            val expected = generation
            for (uri in uris) { coroutineContext.ensureActive(); checkGeneration(expected); copyAndUpload(uri, expected) }
        }
    }
    private suspend fun copyAndUpload(uri: Uri, expected: Long) {
        require(uri.scheme == "content" && !uri.authority.isNullOrBlank() && uri.authority != context.packageName + ".artifacts") { "请选择系统文件选择器中的图片或文档。" }
        val selected = requireNotNull(draft); val liveRows = selected.rows.filter { it.draftId == selected.draft && it.status !in setOf("sent", "expired", "rejected") }
        require(liveRows.size < state.value.countLimit) { "当前草稿附件数量已达到 Gateway 限额。" }
        require(liveRows.none { it.status in setOf("unknown", "held", "deleting") }) { "请先核对未知附件操作。" }
        val metadata = withContext(Dispatchers.IO) {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                require(cursor.moveToFirst()); val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                require(nameIndex >= 0 && !cursor.isNull(nameIndex))
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                cursor.getString(nameIndex) to if (sizeIndex < 0 || cursor.isNull(sizeIndex)) null else cursor.getLong(sizeIndex)
            } ?: error("文件 URI 已失效或授权已撤销。")
        }
        val mime = withContext(Dispatchers.IO) { FileTransferPolicy.canonicalMime(metadata.first, context.contentResolver.getType(uri), true) }
        val remaining = state.value.batchLimit - liveRows.sumOf { it.size }
        val limit = minOf(state.value.fileLimit, remaining)
        require(limit > 0 && (metadata.second == null || metadata.second!! in 1..limit)) { "附件超过 Gateway 文件或草稿总量限制。" }
        val localId = UUID.randomUUID().toString(); val file = store.payload(localId)
        var reservedOperation: String? = null
        var dispatchPermitted = false
        var rowCommitted = false
        val copied = try {
            withContext(Dispatchers.IO) {
                // Temporary SAF permission is used only during this bounded copy; no URI is persisted.
                context.contentResolver.openInputStream(uri)?.use { input -> FileOutputStream(file).use { output ->
                    val result = FileTransferPolicy.copyBounded(input, output, limit) { done, total ->
                        coroutineContext.ensureActive(); progress("读取 ${metadata.first}", done, total, expected)
                    }; output.fd.sync(); result
                } } ?: error("文件 URI 已失效或授权已撤销。")
            }
        } catch (error: Throwable) { file.delete(); throw error }
        try {
            checkGeneration(expected); require(metadata.second == null || copied.first == metadata.second) { "选择的文件在读取期间发生变化。" }
            val operationId = UUID.randomUUID().toString()
            reservedOperation = operationId
            var row = AttachmentLocal(localId, selected.draft, metadata.first, mime, copied.first, copied.second, "selected", operationId)
            updateDraft(onCommitted = { rowCommitted = true }) { it.copy(rows = it.rows + row) }
            beginWrite(operationId, "attachment.upload", selected.project, selected.thread)
            row = row.copy(status = "unknown"); replaceRow(row)
            val response = gateway.uploadAttachment(buildJsonObject {
                put("operationId", operationId); put("projectId", selected.project); put("threadId", selected.thread); put("draftId", selected.draft)
                put("name", row.name); put("mime", mime); put("size", row.size)
            }, file, { checkGeneration(expected); beforeDispatch(); dispatchPermitted = true }) { done, total -> progress("上传 ${row.name}", done, total, expected) }
            acceptReceipt(response); checkGeneration(expected)
            reconcileRow(row)
        } catch (error: Throwable) {
            if (!dispatchPermitted) reservedOperation?.let { withContext(NonCancellable) { rejectForDraft(it, selected); notDispatched(it) } }
            // If no durable row was created, no server request could have started.
            if (!rowCommitted) file.delete()
            throw error
        }
    }
    fun remove(id: String) = runAction {
        check(state.value.writable); val selected = requireNotNull(draft)
        val row = selected.rows.first { it.localId == id }; require(row.status in setOf("selected", "ready", "rejected", "expired"))
        if (row.remoteId == null || row.status in setOf("selected", "rejected", "expired")) {
            updateDraft { it.copy(rows = it.rows.filterNot { item -> item.localId == id }) }; withContext(Dispatchers.IO) { store.payload(id).delete() }; return@runAction
        }
        val op = UUID.randomUUID().toString(); val expected = generation
        var dispatched = false
        val response = try {
            beginWrite(op, "attachment.delete", selected.project, selected.thread)
            checkGeneration(expected)
            replaceRow(row.copy(status = "deleting", deleteOperation = op))
            gateway.delete("attachments/${GatewayClient.segment(row.remoteId)}", buildJsonObject {
                put("operationId", op); put("projectId", selected.project); put("threadId", selected.thread); put("draftId", row.draftId)
            }) { checkGeneration(expected); beforeDispatch(); dispatched = true }
        } catch (error: Throwable) {
            if (!dispatched) withContext(NonCancellable) { rejectForDraft(op, selected); notDispatched(op) }
            throw error
        }
        acceptReceipt(response); checkGeneration(expected); reconcileRow(requireNotNull(draft).rows.first { it.localId == id })
    }
    fun reconcile() = runAction {
        check(state.value.readable)
        requireNotNull(draft).rows.filter { it.status !in setOf("sent", "expired", "selected", "rejected") }.forEach { reconcileRow(it) }
        _state.update { it.copy(message = if (it.hasUnknown) "已查询真实回执；尚不能证明结果的附件继续保留，不会重新上传或发送。" else "附件回执已核对。") }
    }
    private suspend fun reconcileRow(initial: AttachmentLocal) {
        val expected = generation
        val operation = initial.deleteOperation ?: initial.claimOperation ?: initial.uploadOperation
        val response = gateway.get("operations/${GatewayClient.segment(operation)}")
        checkGeneration(expected); val data = response.getValue("data").jsonObject
        // The normal operation tracker receives the same authoritative receipt.
        acceptReceipt(buildJsonObject { response.forEach { (key, value) -> if (key != "data") put(key, value) }; put("operation", data) })
        val status = data.getValue("status").jsonPrimitive.content
        if (initial.claimOperation != null && initial.deleteOperation == null) {
            settleClaim(operation, status, data.nullable("delivery") ?: "unknown"); return
        }
        var row = requireNotNull(draft).rows.firstOrNull { it.localId == initial.localId } ?: return
        if (initial.deleteOperation != null) {
            if (status == "accepted") row = row.copy(status = "expired")
            else if (status == "rejected" && data.nullable("delivery") == "notSent") row = row.copy(status = "ready", deleteOperation = null)
        } else if (status == "accepted") {
            val remote = data["attachment"] as? JsonObject ?: error("上传已确认但附件元数据不可用；已保留安全屏障。")
            val selected = requireNotNull(draft)
            require(remote.nullable("projectId") == selected.project && remote.nullable("threadId") == selected.thread &&
                remote.nullable("draftId") == row.draftId && remote.nullable("name") == row.name && remote.nullable("mime") == row.mime &&
                remote["size"]?.jsonPrimitive?.longOrNull == row.size && remote.nullable("digest") == row.digest)
            val remoteState = remote.getValue("state").jsonPrimitive.content
            require(remoteState in setOf("ready", "sent", "unknown", "held", "expired"))
            row = row.copy(remoteId = remote.getValue("id").jsonPrimitive.content, status = remoteState,
                expiresAt = remote["expiresAt"]?.jsonPrimitive?.longOrNull)
        } else if (status == "rejected") row = row.copy(status = "rejected")
        replaceRow(row)
    }
    /** Must run after the turn operation UUID is committed and before its single HTTP dispatch. */
    suspend fun claimForSend(operationId: String): JsonObject = lock.withLock {
        check(storageSafe) { "附件安全状态不可用，已停止发送。" }
        check(!state.value.busy) { "请等待文件操作完成后发送。" }
        val selected = draft ?: return@withLock buildJsonObject { }
        val rows = selected.rows.filter { it.draftId == selected.draft && it.status !in setOf("sent", "expired", "rejected") }
        require(rows.none { it.status != "ready" } && rows.all { (it.expiresAt ?: 0) > System.currentTimeMillis() && it.remoteId != null }) {
            "附件尚未准备好、已过期或结果未知，请先核对附件。"
        }
        if (rows.isEmpty()) return@withLock buildJsonObject { }
        updateDraft { it.copy(rows = it.rows.map { row -> if (row in rows) row.copy(status = "held", claimOperation = operationId) else row }) }
        buildJsonObject { put("draftId", selected.draft); put("attachmentIds", JsonArray(rows.map { JsonPrimitive(it.remoteId!!) })) }
    }
    suspend fun settleClaim(operationId: String, status: String, delivery: String) {
        val selected = draft ?: return
        if (selected.rows.none { it.claimOperation == operationId }) return
        val newState = when { status == "accepted" -> "sent"; status == "rejected" && delivery == "notSent" -> "ready"; else -> "held" }
        updateDraft { it.copy(draft = if (newState == "sent" && it.rows.any { row -> row.draftId == it.draft && row.claimOperation == operationId }) UUID.randomUUID().toString() else it.draft,
            rows = it.rows.map { row -> if (row.claimOperation == operationId && row.status !in setOf("sent", "expired"))
                row.copy(status = newState, claimOperation = if (newState == "ready") null else operationId) else row }) }
    }
    /** Only invoke at a locally proven cutpoint before the binary/business request was dispatched. */
    suspend fun rejectBeforeDispatch(operationId: String) {
        rejectForDraft(operationId, draft ?: return)
    }
    private suspend fun rejectForDraft(operationId: String, owner: AttachmentDraft) = mutations.withLock {
        fun matching(value: AttachmentDraft?) = value != null && value.scope == owner.scope && value.project == owner.project && value.thread == owner.thread
        val current = if (matching(draft)) requireNotNull(draft) else withContext(Dispatchers.IO) { store.read(owner.scope, owner.project, owner.thread) }
        val next = current.copy(rows = current.rows.map { row -> when {
            row.status in setOf("sent", "expired") -> row
            row.deleteOperation == operationId -> row.copy(status = "ready", deleteOperation = null)
            row.claimOperation == operationId -> row.copy(status = "ready", claimOperation = null)
            row.uploadOperation == operationId && row.remoteId == null -> row.copy(status = "rejected")
            else -> row
        } })
        withContext(NonCancellable) {
            val committed = withContext(Dispatchers.IO) { store.write(next) }
            if (matching(draft)) { draft = committed; publishDraft() }
        }
    }
    private suspend fun replaceRow(row: AttachmentLocal) = updateDraft { it.copy(rows = it.rows.map { prior ->
        if (prior.localId == row.localId && prior.status !in setOf("sent", "expired")) row else prior }) }
    private suspend fun updateDraft(onCommitted: () -> Unit = {}, transform: (AttachmentDraft) -> AttachmentDraft) = mutations.withLock {
        val previous = requireNotNull(draft); val expected = generation; val next = transform(previous)
        checkGeneration(expected)
        withContext(NonCancellable) {
            val committed = withContext(Dispatchers.IO) { store.write(next) }
            // Commit memory with the atomic file even if cancellation arrives during disk sync.
            // No callback or network request occurs under this lock.
            draft = committed; publishDraft(); onCommitted()
        }
    }
    private fun publishDraft() {
        val rows = draft?.rows.orEmpty().filter { it.status !in setOf("sent", "expired") }
        _state.update { it.copy(attachments = rows.map { row -> AttachmentChip(row.localId, row.name, row.size, row.mime, row.status,
            row.status in setOf("selected", "ready", "rejected", "expired"), store.payload(row.localId).takeIf { file -> file.isFile && row.mime.startsWith("image/") }) },
            hasUnknown = rows.any { it.status in setOf("unknown", "held", "deleting") }) }
    }
    fun cancel() { currentJob?.cancel(); _state.update { it.copy(message = "传输已取消；已经发出的写入保留原操作标识，请查询回执。") } }
    private fun protectedPreviews(): Set<File> = listOfNotNull(state.value.preview?.file, saveSelection?.file).toSet()
    fun closePreview() {
        saveSelection = null
        _state.update { it.copy(preview = null) }
        val protected = protectedPreviews()
        coroutineScope.launch(Dispatchers.IO) { previews.clean(protected) }
    }
    fun open() = external(false)
    fun share() = external(true)
    private fun external(share: Boolean) {
        val selected = state.value.preview ?: return
        try {
            require(selected.file.isFile && selected.file.length() == selected.size)
            previews.retain(selected.file)
            val uri = FileProvider.getUriForFile(context, context.packageName + ".artifacts", selected.file)
            val intent = Intent(if (share) Intent.ACTION_SEND else Intent.ACTION_VIEW).apply {
                if (share) { type = selected.mime; putExtra(Intent.EXTRA_STREAM, uri); putExtra(Intent.EXTRA_TITLE, selected.name) }
                else setDataAndType(uri, selected.mime)
                clipData = ClipData.newRawUri(selected.name, uri); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(Intent.createChooser(intent, if (share) "分享成果" else "打开成果").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) { _state.update { it.copy(message = "系统未能打开此成果，请尝试保存后使用兼容的应用打开。") } }
    }
    fun save(uri: Uri) = runAction {
        val selected = saveSelection ?: state.value.preview ?: return@runAction
        saveSelection = null
        require(uri.scheme == "content" && uri.authority != context.packageName + ".artifacts")
        withContext(Dispatchers.IO) {
            context.contentResolver.openOutputStream(uri, "w")?.use { output -> selected.file.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024); var count = 0L
                while (true) { coroutineContext.ensureActive(); val n = input.read(buffer); if (n < 0) break; count += n; require(count <= selected.size); output.write(buffer, 0, n) }
                require(count == selected.size)
            } } ?: error("目标文件授权已失效。")
        }
        _state.update { it.copy(message = "成果已保存到所选位置。") }
    }
    private fun runAction(work: suspend () -> Unit) {
        // A cancelled job may still be fsyncing known-notSent cleanup. Do not replace its dispatch context.
        if (currentJob?.isCompleted == false) return
        val expected = generation
        currentJob = coroutineScope.launch {
            _state.update { it.copy(busy = true, message = null) }
            try { work() }
            catch (_: CancellationException) { /* Preserve durable unknowns. */ }
            catch (error: Exception) { if (expected == generation) _state.update { it.copy(message = when (error) {
                is GatewayException -> error.userMessage
                is PreviewCacheFullException -> error.message!!
                is SecurityException -> "文件授权已撤销，请重新使用系统选择器选择。"
                else -> "文件操作未完成，请检查文件类型、大小、授权和连接；未知写入已保留，请核对回执。"
            }) } }
            finally { if (expected == generation) _state.update { it.copy(busy = false, progress = null) } }
        }
    }
    private fun checkGeneration(expected: Long) { check(expected == generation) { "会话已改变。" } }
    private fun progress(label: String, done: Long, total: Long, expected: Long) {
        if (generation == expected) _state.update { it.copy(progress = TransferProgress(label, done, total)) }
    }
    private fun JsonObject.nullable(key: String): String? = (this[key] as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content
}
