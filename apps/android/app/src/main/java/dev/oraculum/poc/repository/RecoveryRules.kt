package dev.oraculum.poc.repository

/** These are client projection rules, never a native execution state machine. */
data class EventPosition(val installationId: String, val epoch: String, val sequence: Long)
enum class EventDecision { APPLY, DUPLICATE, RESET, INVALIDATE, SKIP }

fun acceptEvent(
    position: EventPosition,
    installationId: String,
    epoch: String,
    sequence: Long,
    kind: String,
    impact: String?,
): EventDecision {
    if (installationId != position.installationId || epoch != position.epoch || sequence <= 0 ||
        sequence > 9_007_199_254_740_991L) return EventDecision.RESET
    if (sequence <= position.sequence) return EventDecision.DUPLICATE
    if (sequence != position.sequence + 1) return EventDecision.RESET
    if (kind in setOf("item.started", "item.delta", "item.completed", "operation.changed")) return EventDecision.APPLY
    if (kind == "connection.reset" || kind == "history.invalidated" || kind == "native.state" ||
        kind == "project.changed" || kind.startsWith("interaction.")) return EventDecision.INVALIDATE
    return if (impact == "informational") EventDecision.SKIP else EventDecision.INVALIDATE
}

data class ItemProjection(
    val id: String,
    val turnId: String,
    val type: String,
    val baseline: String = "",
    val stream: String = "",
    val terminal: Boolean = false,
    val appendable: Boolean = false,
    val detailsRequired: Boolean = false,
) {
    // A stream observed after recovery is not an extension of the snapshot baseline.
    val visibleText: String get() = if (appendable) stream else baseline.ifBlank { stream }
}

enum class ItemUpdate { SNAPSHOT, STARTED, DELTA, COMPLETED, GAP }

fun mergeItem(
    previous: ItemProjection?,
    id: String,
    turnId: String,
    type: String,
    update: ItemUpdate,
    text: String = "",
    terminal: Boolean = false,
    complete: Boolean = true,
    maxBytes: Int = 64 * 1024,
): ItemProjection {
    require(maxBytes > 0)
    require(previous == null || previous.id == id)
    val old = previous ?: ItemProjection(id, turnId, type)
    val next = when (update) {
        ItemUpdate.GAP -> old.copy(stream = "", appendable = false, detailsRequired = true)
        ItemUpdate.SNAPSHOT -> {
            if (old.terminal && (!terminal || (!old.detailsRequired && !complete))) return old
            old.copy(baseline = text, stream = "", terminal = terminal, appendable = false, detailsRequired = !complete)
        }
        ItemUpdate.STARTED -> {
            if (old.terminal) return old
            if (previous != null) old.copy(appendable = false)
            else old.copy(stream = text, appendable = complete, detailsRequired = !complete)
        }
        ItemUpdate.DELTA -> {
            if (old.terminal) return old
            old.copy(stream = old.stream + text)
        }
        ItemUpdate.COMPLETED -> {
            if (old.terminal && !old.detailsRequired && !complete) return old
            old.copy(baseline = text, stream = "", terminal = true, appendable = false, detailsRequired = !complete)
        }
    }
    return if ((next.baseline + next.stream).toByteArray(Charsets.UTF_8).size > maxBytes)
        next.copy(baseline = "", stream = "", appendable = false, detailsRequired = true) else next
}

data class PendingIntent(val projectId: String, val threadId: String?, val kind: String, val status: String)

/** No missing receipt, fresh UUID, or new device can prove an unknown intent was not delivered. */
fun blocksWrite(pending: List<PendingIntent>, projectId: String, threadId: String?): Boolean =
    pending.any { it.status == "unknown" && (it.projectId.isEmpty() || it.projectId == projectId) &&
        (threadId == null || it.threadId == null || it.threadId == threadId) }

/** An HTTP response cannot overwrite facts observed while that snapshot was in flight. */
fun snapshotStillCurrent(startGeneration: Int, currentGeneration: Int, startVersion: Long, currentVersion: Long): Boolean =
    startGeneration == currentGeneration && startVersion == currentVersion

/** Obvious invalid inputs are rejected locally; the Gateway performs authoritative path checks. */
fun validProjectRelativePath(path: String): Boolean = path.length in 1..1024 &&
    path.split('/').let { parts -> parts.size <= 12 && parts.all { part ->
        part.isNotEmpty() && part.length <= 180 && part == part.trim() && !part.startsWith('.') &&
            part.none { it == '\\' || it == ':' || it == '%' || it.isISOControl() }
    } }
