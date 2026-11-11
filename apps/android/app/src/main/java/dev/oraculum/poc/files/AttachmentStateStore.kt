package dev.oraculum.poc.files

import android.content.Context
import android.util.AtomicFile
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.security.MessageDigest
import java.util.UUID

@Serializable
internal data class AttachmentDraft(val scope: String, val project: String, val thread: String,
    val draft: String = UUID.randomUUID().toString(), val rows: List<AttachmentLocal> = emptyList())
@Serializable
internal data class AttachmentLocal(
    val localId: String, val draftId: String, val name: String, val mime: String, val size: Long, val digest: String,
    val status: String, val uploadOperation: String, val remoteId: String? = null, val expiresAt: Long? = null,
    val claimOperation: String? = null, val deleteOperation: String? = null,
)

/** FilesDir state is independent of history cache; malformed state fails closed instead of replacing unknowns. */
internal class AttachmentStateStore(context: Context) {
    private val root = File(context.filesDir, "attachment-drafts-v2").apply { check(isDirectory || mkdirs()) }
    private val json = Json { ignoreUnknownKeys = false; encodeDefaults = true }
    private fun record(scope: String, project: String, thread: String): AtomicFile {
        val key = json.encodeToString(listOf(scope, project, thread)).toByteArray()
        val name = MessageDigest.getInstance("SHA-256").digest(key).joinToString("") { "%02x".format(it) }
        return AtomicFile(File(root, "$name.json"))
    }
    fun read(scope: String, project: String, thread: String): AttachmentDraft {
        val file = record(scope, project, thread)
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return AttachmentDraft(scope, project, thread).also(::write)
        require(file.baseFile.length() <= 512 * 1024) { "附件安全状态过大，已停止修改。" }
        return json.decodeFromString<AttachmentDraft>(file.readFully().toString(Charsets.UTF_8)).also {
            require(it.scope == scope && it.project == project && it.thread == thread && it.rows.size <= 512)
            require(uuid(it.draft) && it.rows.all { row -> uuid(row.localId) && uuid(row.draftId) && uuid(row.uploadOperation) &&
                (row.claimOperation == null || uuid(row.claimOperation)) && (row.deleteOperation == null || uuid(row.deleteOperation)) &&
                row.status in setOf("selected", "unknown", "ready", "held", "sent", "expired", "rejected", "deleting") &&
                FileTransferPolicy.safeName(row.name) && row.size in 1..FileTransferPolicy.MAX_UPLOAD && Regex("^[0-9a-f]{64}$").matches(row.digest) })
        }
    }
    fun write(draft: AttachmentDraft) {
        val file = record(draft.scope, draft.project, draft.thread)
        val bytes = json.encodeToString(draft).toByteArray(); require(bytes.size <= 512 * 1024)
        val stream = file.startWrite()
        try { stream.write(bytes); file.finishWrite(stream) } catch (error: Throwable) { file.failWrite(stream); throw error }
    }
    fun payload(id: String): File { require(uuid(id)); return File(root, "$id.input") }
    private fun uuid(value: String) = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$").matches(value)
}
