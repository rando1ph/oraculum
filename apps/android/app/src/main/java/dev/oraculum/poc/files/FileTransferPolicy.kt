package dev.oraculum.poc.files

import java.io.InputStream
import java.io.OutputStream
import java.net.URLDecoder
import java.security.MessageDigest
import java.text.Normalizer
import java.util.Base64

/** Gateway file contract, kept independent of Android for negative transport/IO tests. */
object FileTransferPolicy {
    const val MAX_UPLOAD = 20L * 1024 * 1024
    const val MAX_DOWNLOAD = 64L * 1024 * 1024
    const val MAX_TEXT_PREVIEW = 512L * 1024
    val types = mapOf("png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "webp" to "image/webp",
        "pdf" to "application/pdf", "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" to "application/vnd.openxmlformats-officedocument.presentationml.presentation", "txt" to "text/plain", "md" to "text/markdown", "csv" to "text/csv")
    private val sourceExtensions = setOf("ts", "tsx", "js", "jsx", "json", "py", "rs", "c", "cpp", "h", "java", "kt", "kts", "css", "sh", "yaml", "yml", "toml", "sql", "log")
    fun safeName(name: String): Boolean = name.isNotEmpty() && name.length <= 180 && name == name.trim() &&
        !name.startsWith('.') && name == Normalizer.normalize(name, Normalizer.Form.NFC) &&
        name.none { it in "/\\:%" || Character.getType(it) in setOf(Character.CONTROL.toInt(), Character.FORMAT.toInt()) }
    fun relativePath(path: String, rootAllowed: Boolean = false): Boolean =
        (rootAllowed && path.isEmpty()) || (path.length <= 4096 && !path.startsWith('/') && path.split('/').all { safeName(it) && it != "." && it != ".." })
    fun canonicalMime(name: String, given: String?, upload: Boolean): String {
        require(safeName(name)) { "文件名无效。" }
        val extension = name.substringAfterLast('.', "").lowercase()
        val expected = types[extension] ?: if (!upload && extension in sourceExtensions) "text/plain" else null
        require(expected != null) { "不支持此文件类型。" }
        require(given.orEmpty().lowercase() in setOf("", "application/octet-stream", expected) ||
            extension in setOf("txt", "md", "csv") && given?.lowercase() == "text/plain") { "文件名与 MIME 不匹配。" }
        return expected
    }
    fun validateGrant(grant: HostFileGrant, now: Long) {
        require(Regex("^[0-9a-f-]{36}$").matches(grant.id) && relativePath(grant.path) && safeName(grant.name) &&
            grant.path.substringAfterLast('/') == grant.name && canonicalMime(grant.name, grant.mime, false) == grant.mime &&
            grant.size in 0..MAX_DOWNLOAD && grant.expiresAt > now) { "文件授权已过期或无效，请重新选择文件。" }
    }
    fun validateHeaders(grant: HostFileGrant, mime: String?, size: String?, digest: String?, disposition: String?, now: Long): ByteArray {
        validateGrant(grant, now)
        require(mime?.substringBefore(';')?.trim() == grant.mime && size?.toLongOrNull() == grant.size) { "下载的类型或大小与授权不符。" }
        val encoded = Regex("^attachment; filename\\*=UTF-8''(.+)$").matchEntire(disposition.orEmpty())?.groupValues?.get(1)
            ?: error("下载名称缺失。")
        require(URLDecoder.decode(encoded.replace("+", "%2B"), "UTF-8") == grant.name) { "下载名称不符。" }
        val raw = Regex("^sha-256=:([A-Za-z0-9+/]{43}=):$").matchEntire(digest.orEmpty())?.groupValues?.get(1)
            ?: error("下载内容摘要缺失。")
        return Base64.getDecoder().decode(raw).also { require(it.size == 32) }
    }
    fun copyVerified(input: InputStream, output: OutputStream, size: Long, digest: ByteArray,
        check: () -> Unit = {}, progress: (Long, Long) -> Unit = { _, _ -> }): String {
        require(size in 0..MAX_DOWNLOAD && digest.size == 32)
        val hasher = MessageDigest.getInstance("SHA-256"); val buffer = ByteArray(64 * 1024); var count = 0L
        while (true) {
            check(); val read = input.read(buffer); if (read == -1) break
            require(count + read <= size) { "下载超过授权大小。" }
            output.write(buffer, 0, read); hasher.update(buffer, 0, read); count += read; progress(count, size)
        }
        check(); val actual = hasher.digest()
        require(count == size && MessageDigest.isEqual(actual, digest)) { "下载中断或内容摘要不符，临时文件已删除。" }
        return actual.joinToString("") { "%02x".format(it) }
    }
    fun copyBounded(input: InputStream, output: OutputStream, limit: Long, progress: (Long, Long) -> Unit = { _, _ -> }): Pair<Long, String> {
        require(limit in 1..MAX_UPLOAD)
        val hasher = MessageDigest.getInstance("SHA-256"); val buffer = ByteArray(64 * 1024); var count = 0L
        while (true) {
            val read = input.read(buffer); if (read == -1) break
            require(count + read <= limit) { "文件超过 Gateway 单文件限额。" }
            output.write(buffer, 0, read); hasher.update(buffer, 0, read); count += read; progress(count, limit)
        }
        require(count > 0) { "附件不能为空。" }
        return count to hasher.digest().joinToString("") { "%02x".format(it) }
    }
}

data class HostFileGrant(val id: String, val projectId: String, val threadId: String?, val path: String,
    val name: String, val mime: String, val size: Long, val expiresAt: Long)
