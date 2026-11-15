package dev.oraculum.poc.repository

import dev.oraculum.poc.gateway.EventCursor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/** Read-only freshness is never evidence for a write, approval, or native permission. */
class SyncReadPolicy(private val now: () -> Long = { System.nanoTime() / 1_000_000 }, private val ttlMs: Long = 30_000) {
    private data class Entry(val version: Long, val checkedAt: Long?)
    private val entries = linkedMapOf<String, Entry>()
    private var serial = 0L
    fun version(key: String): Long {
        val result = entries.getOrPut(key) { Entry(++serial, null) }.version
        bound()
        return result
    }
    fun fresh(key: String, maxAgeMs: Long = ttlMs): Boolean = entries[key]?.checkedAt?.let { now() - it in 0 until maxAgeMs } == true
    fun checked(key: String, version: Long) {
        if (version(key) == version) entries[key] = Entry(version, now())
        bound()
    }
    fun invalidate(key: String) { entries[key] = Entry(++serial, null); bound() }
    fun invalidatePrefix(prefix: String) { entries.keys.filter { it.startsWith(prefix) }.forEach(::invalidate) }
    fun clear() = entries.clear()
    internal fun size(): Int = entries.size
    private fun bound() { while (entries.size > 256) entries.remove(entries.keys.first()) }
}

/** Coalesce bursts without postponing the first request or cancelling an in-flight read. */
class SnapshotRefreshScheduler(
    private val scope: CoroutineScope,
    private val now: () -> Long = { System.nanoTime() / 1_000_000 },
    private val read: suspend () -> Unit,
) {
    private var job: Job? = null
    private var running = false
    private var dueAt = Long.MAX_VALUE
    private var queuedDelay: Long? = null
    private var generation = 0L
    val pending: Boolean get() = job?.isActive == true || running
    fun request(delayMs: Long) {
        require(delayMs >= 0)
        if (running) { queuedDelay = minOf(queuedDelay ?: delayMs, delayMs); return }
        val due = now() + delayMs
        if (job?.isActive == true && dueAt <= due) return
        job?.cancel()
        val token = ++generation
        dueAt = due
        job = scope.launch {
            delay(delayMs)
            if (token != generation) return@launch
            running = true
            try { read() }
            finally {
                if (token == generation) {
                    running = false; job = null; dueAt = Long.MAX_VALUE
                    queuedDelay?.let { queuedDelay = null; request(it) }
                }
            }
        }
    }
    fun cancel() { generation++; queuedDelay = null; running = false; job?.cancel(); job = null; dueAt = Long.MAX_VALUE }
}

/** An in-memory checkpoint only; a new process must establish a complete new baseline. */
class EventResumeCheckpoint {
    private var checkpoint: Pair<String, EventPosition>? = null
    fun remember(scope: String?, position: EventPosition?) { if (scope != null && position != null) checkpoint = scope to position }
    fun cursor(scope: String, installation: String, epoch: String): EventCursor? = checkpoint?.takeIf {
        it.first == scope && it.second.installationId == installation && it.second.epoch == epoch
    }?.second?.let { EventCursor(it.epoch, it.sequence) }
    fun clear() { checkpoint = null }
}

fun eventConnectionPosition(installation: String, epoch: String, headSeq: Long, resetRequired: Boolean, resume: EventCursor?): EventPosition =
    EventPosition(installation, epoch, if (resetRequired || resume == null) headSeq else resume.afterSeq)

/** Reuse loaded pages only while the native root page itself is unchanged. */
fun preserveHistoryWindow(previousEpoch: String?, epoch: String, previousRevision: String?, revision: String?,
    previousRoot: JsonObject?, root: JsonObject, destructive: Boolean): Boolean =
    !destructive && previousEpoch == epoch && previousRevision != null && previousRevision == revision &&
        previousRoot != null && previousRoot["items"] == root["items"] && previousRoot["truncated"] == root["truncated"] &&
        previousRoot["source"] == root["source"]
