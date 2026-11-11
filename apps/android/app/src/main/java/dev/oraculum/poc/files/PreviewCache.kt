package dev.oraculum.poc.files

import java.io.File
import java.nio.file.Files
import java.util.UUID

/** Only this client's UUID.download files are managed; shared bytes retain a conservative local lease. */
internal class PreviewCache(
    private val root: File,
    private val now: () -> Long = System::currentTimeMillis,
    private val budgetBytes: Long = 128L * 1024 * 1024,
    private val leaseMillis: Long = 60L * 60 * 1000,
    private val maxFiles: Int = 64,
) {
    init { require(budgetBytes > 0 && leaseMillis > 0 && maxFiles > 0); check(root.isDirectory || root.mkdirs()) }

    @Synchronized
    fun reserve(size: Long, protected: Set<File>): File {
        require(size in 0..FileTransferPolicy.MAX_DOWNLOAD)
        clean(protected)
        val files = ownedFiles()
        val total = files.fold(0L) { used, file -> (used + file.length()).coerceAtMost(budgetBytes + FileTransferPolicy.MAX_DOWNLOAD) }
        if (files.size >= maxFiles || size > budgetBytes || total > budgetBytes - size) throw PreviewCacheFullException()
        return File(root, UUID.randomUUID().toString() + ".download").also { check(it.createNewFile()) }
    }

    /** Renew before exposing a content URI, so a later cleanup cannot invalidate a recent share. */
    @Synchronized
    fun retain(file: File) {
        require(owned(file))
        check(file.setLastModified(now())) { "Preview lease could not be preserved" }
    }

    @Synchronized
    fun clean(protected: Set<File>) {
        val protectedPaths = protected.map { it.absoluteFile }.toSet()
        val deadline = now() - leaseMillis
        ownedFiles().forEach { file ->
            if (file.absoluteFile !in protectedPaths && file.lastModified() <= deadline) file.delete()
        }
    }

    private fun ownedFiles(): List<File> = root.listFiles()?.filter(::owned).orEmpty()
    private fun owned(file: File): Boolean = file.parentFile?.absoluteFile == root.absoluteFile &&
        NAME.matches(file.name) && !Files.isSymbolicLink(file.toPath()) && file.isFile

    private companion object {
        val NAME = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.download$")
    }
}

internal class PreviewCacheFullException : Exception("预览缓存已达到 128 MB 或 64 个文件上限。当前预览和最近一小时的打开/分享文件会保留；请稍后重试下载。")
