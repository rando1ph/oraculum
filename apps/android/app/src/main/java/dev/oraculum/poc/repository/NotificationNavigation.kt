package dev.oraculum.poc.repository

import kotlinx.serialization.json.*
import kotlinx.coroutines.CancellationException

data class NotificationTargetRead(val projects: JsonObject, val firstThreads: JsonObject, val thread: JsonObject, val snapshot: JsonObject)
class NotificationTargetUnavailable(message: String) : Exception(message)
enum class NotificationReadStage(val label: String) {
    PROJECTS("读取项目目录"), ACTIVE_THREADS("读取未归档会话列表"), SNAPSHOT("读取原生会话快照"),
}
class NotificationTargetReadFailed(val stage: NotificationReadStage, val elapsedMillis: Long, cause: Exception) : Exception(cause)

private suspend fun notificationRead(stage: NotificationReadStage, read: suspend () -> JsonObject): JsonObject {
    val start = System.nanoTime()
    try { return read() }
    catch (error: CancellationException) { throw error }
    catch (error: Exception) { throw NotificationTargetReadFailed(stage, (System.nanoTime() - start) / 1_000_000, error) }
}

/** Read every target prerequisite before the caller commits a visible navigation change. */
suspend fun readNotificationTarget(
    projectId: String,
    threadId: String,
    readProjects: suspend () -> JsonObject,
    readThreads: suspend (String?) -> JsonObject,
    readSnapshot: suspend () -> JsonObject,
): NotificationTargetRead {
    val projects = notificationRead(NotificationReadStage.PROJECTS, readProjects)
    if ((projects["projects"] as? JsonArray)?.any { value ->
            val project = value as? JsonObject
            project?.text("id") == projectId && project["available"] == JsonPrimitive(true)
        } != true) throw NotificationTargetUnavailable("通知项目已不可访问；保留当前会话")
    val firstThreads = notificationRead(NotificationReadStage.ACTIVE_THREADS) { readThreads(null) }
    var page = firstThreads
    var found: JsonObject? = null
    var pages = 0
    val cursors = mutableSetOf<String>()
    while (pages < 10) {
        pages++
        found = (page["threads"] as? JsonArray)?.mapNotNull { it as? JsonObject }?.firstOrNull { it.text("id") == threadId }
        if (found != null) break
        val cursor = page.text("nextCursor") ?: break
        if (!cursors.add(cursor) || pages == 10) break
        page = notificationRead(NotificationReadStage.ACTIVE_THREADS) { readThreads(cursor) }
    }
    val thread = found ?: throw NotificationTargetUnavailable("在有界未归档列表内无法确认通知会话仍可用；保留当前会话")
    // A successful thread/read alone cannot establish unarchived membership.
    val snapshot = notificationRead(NotificationReadStage.SNAPSHOT, readSnapshot)
    val nativeThread = snapshot["thread"] as? JsonObject
    val history = snapshot["history"] as? JsonObject
    if (nativeThread == null || nativeThread.text("id") != threadId || nativeThread.text("projectId") != projectId ||
        nativeThread["archived"] == JsonPrimitive(true) || history == null || snapshot.text("epoch") == null ||
        history.text("epoch") != snapshot.text("epoch"))
        throw NotificationTargetUnavailable("通知会话快照范围不匹配；保留当前会话")
    return NotificationTargetRead(projects, firstThreads, thread, snapshot)
}

private fun JsonObject.text(key: String) = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
