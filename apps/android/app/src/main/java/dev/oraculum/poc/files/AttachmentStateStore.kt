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
    val draft: String = UUID.randomUUID().toString(), val rows: List<AttachmentLocal> = emptyList(),
    val cleanupPending: List<String> = emptyList())
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
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return write(AttachmentDraft(scope, project, thread))
        require(file.baseFile.length() <= 512 * 1024) { "附件安全状态过大，已停止修改。" }
        val draft = json.decodeFromString<AttachmentDraft>(file.readFully().toString(Charsets.UTF_8)).also {
            require(it.scope == scope && it.project == project && it.thread == thread)
            require(uuid(it.draft) && it.rows.all { row -> uuid(row.localId) && uuid(row.draftId) && uuid(row.uploadOperation) &&
                (row.claimOperation == null || uuid(row.claimOperation)) && (row.deleteOperation == null || uuid(row.deleteOperation)) &&
                row.status in setOf("selected", "unknown", "ready", "held", "sent", "expired", "rejected", "deleting") &&
                FileTransferPolicy.safeName(row.name) && row.size in 1..FileTransferPolicy.MAX_UPLOAD && Regex("^[0-9a-f]{64}$").matches(row.digest) })
            require(it.cleanupPending.all(::uuid) && it.rows.map(AttachmentLocal::localId).distinct().size == it.rows.size)
            require(it.rows.none { row -> row.status !in TERMINAL && row.localId in it.cleanupPending })
        }
        // Finish only already-proven terminal cleanup after a crash; unresolved rows are untouched.
        return write(draft)
    }
    fun write(draft: AttachmentDraft): AttachmentDraft {
        val terminal = draft.rows.filter { it.status in TERMINAL }
        val keptTerminal = terminal.takeLast(TERMINAL_RECORDS).map(AttachmentLocal::localId).toSet()
        val pending = (draft.cleanupPending + terminal.map(AttachmentLocal::localId)).distinct()
        require(pending.all(::uuid) && draft.rows.none { it.status !in TERMINAL && it.localId in pending })
        val compacted = draft.copy(rows = draft.rows.filter { it.status !in TERMINAL || it.localId in keptTerminal }, cleanupPending = pending)
        // The terminal decision and cleanup IDs commit before any payload deletion. Room's operation
        // receipts remain independent and are never removed by this bounded attachment inventory.
        persist(compacted)
        val remaining = pending.filter { id -> runCatching { payload(id).let { it.exists() && !it.delete() } }.getOrDefault(true) }
        if (remaining == pending) return compacted
        val cleared = compacted.copy(cleanupPending = remaining)
        // The first write already committed the caller's active rows. A cleanup bookkeeping failure
        // must not report that commit as failed (callers may discard a never-committed input copy).
        return if (runCatching { persist(cleared) }.isSuccess) cleared else compacted
    }
    private fun persist(draft: AttachmentDraft) {
        val file = record(draft.scope, draft.project, draft.thread)
        val bytes = json.encodeToString(draft).toByteArray(); require(bytes.size <= 512 * 1024)
        val stream = file.startWrite()
        try { stream.write(bytes); file.finishWrite(stream) } catch (error: Throwable) { file.failWrite(stream); throw error }
    }
    fun payload(id: String): File { require(uuid(id)); return File(root, "$id.input") }
    private fun uuid(value: String) = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$").matches(value)
    companion object {
        const val TERMINAL_RECORDS = 32
        private val TERMINAL = setOf("sent", "expired")
    }
}
