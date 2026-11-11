package dev.oraculum.poc.repository

import java.security.MessageDigest
import kotlinx.serialization.json.*

data class FileChangeApprovalScope(val epoch: String, val projectId: String, val threadId: String)
data class VerifiedFileChange(val path: String, val kind: String, val movePath: String?, val diff: String)

/** Complete, bounded native facts, never reconstructed from a rendered summary or disk cache. */
class FileChangeApprovalContext internal constructor(
    val scope: FileChangeApprovalScope,
    val turnId: String,
    val itemId: String,
    val changes: List<VerifiedFileChange>,
    val digest: String,
    val interactionId: String = "",
    val generation: Long = 0,
) {
    internal fun matchesRequest(epoch: String?, project: String?, thread: String?, kind: String?, status: String?, request: JsonObject): Boolean =
        kind == "fileChange" && status == "pending" && epoch == scope.epoch && project == scope.projectId && thread == scope.threadId &&
            request.text("threadId") == scope.threadId && request.text("turnId") == turnId && request.text("itemId") == itemId &&
            // Native grantRoot requests unstable session-wide authority, beyond this one patch.
            (request["grantRoot"] == null || request["grantRoot"] == JsonNull)

    fun matchesPending(interaction: InteractionUi, displayedDigest: String? = digest): Boolean =
        matchesIdentity(interaction.id, interaction.generation) && displayedDigest == digest && matchesRequest(interaction.epoch, interaction.projectId, interaction.threadId,
            interaction.kind, interaction.status, interaction.request)

    internal fun matchesIdentity(id: String?, generation: Long?) = id == interactionId && generation == this.generation && this.generation > 0

    internal fun bind(interaction: InteractionUi): FileChangeApprovalContext {
        val boundDigest = sha256(buildJsonObject {
            put("itemDigest", digest); put("interactionId", interaction.id); put("generation", interaction.generation)
        }.toString().toByteArray(Charsets.UTF_8))
        return FileChangeApprovalContext(scope, turnId, itemId, changes, boundDigest, interaction.id, interaction.generation)
    }
}

/** Revalidated after the display-time tap and again immediately before the durable request is sent. */
fun fileChangeApprovalStillCurrent(displayed: InteractionUi, current: InteractionUi, displayedDigest: String?): Boolean =
    displayed.id == current.id && displayed.generation == current.generation && displayed.generation > 0 &&
        displayed.fileChangeContext?.matchesPending(displayed, displayedDigest) == true &&
        current.fileChangeContext?.matchesPending(current, displayedDigest) == true

/**
 * Only the current connection's version-checked, read-only snapshot may establish proof.
 * The owner clears this store on every relevant state event, disconnect or scope change.
 * History pagination or Item previews must not be fed here as if they were fresh snapshots.
 */
class FileChangeApprovalContexts {
    private val contexts = linkedMapOf<Pair<String, String>, FileChangeApprovalContext>()

    fun clear() = contexts.clear()

    fun snapshot(scope: FileChangeApprovalScope, history: JsonObject) {
        clear()
        if (listOf(scope.epoch, scope.projectId, scope.threadId).any { !identifier(it) } ||
            history.text("epoch") != scope.epoch || history["truncated"] != JsonPrimitive(false)) return
        val turns = history["items"] as? JsonArray ?: return
        val candidates = linkedMapOf<Pair<String, String>, FileChangeApprovalContext>()
        val seen = mutableSetOf<Pair<String, String>>()
        for (element in turns) {
            val turn = element as? JsonObject ?: return
            val turnId = turn.text("id")?.takeIf(::identifier) ?: return
            if (turn.text("status") != "inProgress") continue
            val items = turn["items"] as? JsonArray ?: return
            for (itemElement in items) {
                val item = itemElement as? JsonObject ?: return
                if (item.text("type") != "fileChange") continue
                val itemId = item.text("id")?.takeIf(::identifier) ?: return
                val key = turnId to itemId
                if (!seen.add(key)) return // Ambiguous duplicate native identities fail closed.
                completeItem(scope, turnId, item)?.let { candidates[key] = it }
                if (candidates.size > 32) return
            }
        }
        contexts.putAll(candidates)
    }

    fun forInteraction(interaction: InteractionUi): FileChangeApprovalContext? {
        val turn = interaction.request.text("turnId") ?: return null
        val item = interaction.request.text("itemId") ?: return null
        return contexts[turn to item]?.takeIf { it.matchesRequest(interaction.epoch, interaction.projectId, interaction.threadId,
            interaction.kind, interaction.status, interaction.request) && interaction.generation > 0 }?.bind(interaction)
    }

    private fun completeItem(scope: FileChangeApprovalScope, turn: String, item: JsonObject): FileChangeApprovalContext? {
        if (item.text("status") != "inProgress" || item.keys.any { it !in setOf("id", "type", "status", "changes") } ||
            item.toString().toByteArray(Charsets.UTF_8).size > MAX_BYTES) return null
        val rawChanges = item["changes"] as? JsonArray ?: return null
        if (rawChanges.size !in 1..20) return null
        val changes = mutableListOf<VerifiedFileChange>()
        val paths = mutableSetOf<String>()
        var lines = 0
        for (element in rawChanges) {
            val change = element as? JsonObject ?: return null
            if (change.keys != setOf("path", "kind", "diff")) return null
            val path = change.text("path")?.takeIf(::visiblePath) ?: return null
            if (!paths.add(path)) return null
            val kind = change["kind"] as? JsonObject ?: return null
            val type = kind.text("type") ?: return null
            val move = kind["move_path"]
            if (type !in setOf("add", "delete", "update") || kind.keys.any { it !in setOf("type", "move_path") } ||
                (type != "update" && kind.containsKey("move_path"))) return null
            val movePath = if (move == null || move == JsonNull) null else move.stringValue()?.takeIf(::visiblePath) ?: return null
            val diff = change.text("diff") ?: return null
            if (diff.isBlank()) return null
            lines += diff.count { it == '\n' || it == '\u2028' || it == '\u2029' } + diff.indices.count { diff[it] == '\r' && (it + 1 == diff.length || diff[it + 1] != '\n') } + 1
            if (lines > 256) return null
            // Control/bidi bytes can hide or reorder a path/patch in a native text view.
            if (diff.any { (it.isISOControl() && it !in "\n\r\t") || invisibleDirection(it) }) return null
            changes += VerifiedFileChange(path, type, movePath, diff)
        }
        val itemId = item.text("id") ?: return null
        val canonical = buildJsonObject {
            put("epoch", scope.epoch); put("projectId", scope.projectId); put("threadId", scope.threadId)
            put("turnId", turn); put("itemId", itemId)
            put("changes", buildJsonArray { changes.forEach { change -> add(buildJsonObject {
                put("path", change.path); put("kind", change.kind); put("movePath", change.movePath?.let(::JsonPrimitive) ?: JsonNull); put("diff", change.diff)
            }) } })
        }.toString().toByteArray(Charsets.UTF_8)
        if (canonical.size > MAX_BYTES) return null
        val digest = sha256(canonical)
        return FileChangeApprovalContext(scope, turn, itemId, changes.toList(), digest)
    }

    companion object { private const val MAX_BYTES = 16 * 1024 }
}

private fun identifier(value: String) = value.isNotBlank() && value.length <= 512 && value.none { it.isISOControl() || invisibleDirection(it) }
private fun visiblePath(value: String) = identifier(value) && value.none { it == '\u007f' }
private fun invisibleDirection(value: Char) = value in '\u202a'..'\u202e' || value in '\u2066'..'\u2069' || value == '\u200e' || value == '\u200f'
private fun JsonElement?.stringValue() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
private fun JsonObject.text(key: String) = this[key].stringValue()
private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
