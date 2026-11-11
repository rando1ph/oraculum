package dev.oraculum.poc.repository

import kotlinx.coroutines.CancellationException

enum class NativeReadStage(val label: String) {
    PROJECTS("读取项目目录"), MODELS("读取模型目录"), ACTIVE_THREADS("读取未归档会话列表"), SNAPSHOT("读取原生会话快照"),
}

/** Contains only a fixed stage, elapsed time and the original exception, never request contents. */
class NativeReadFailed(val stage: NativeReadStage, val elapsedMillis: Long, val context: String, cause: Exception) : Exception(cause)

suspend fun <T> observeNativeRead(stage: NativeReadStage, context: String, read: suspend () -> T): T {
    val start = System.nanoTime()
    try { return read() }
    catch (error: CancellationException) { throw error }
    catch (error: Exception) { throw NativeReadFailed(stage, (System.nanoTime() - start) / 1_000_000, context, error) }
}
