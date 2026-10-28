package dev.oraculum.poc

import java.io.InputStream
import java.io.OutputStream
import java.net.URLDecoder
import java.security.MessageDigest
import java.text.Normalizer
import java.util.Locale

/** Pure policy shared by the native transport and JVM adversarial tests. */
object ArtifactDownloadPolicy {
    const val maxBytes = 64L * 1024 * 1024
    private val id = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
    private val actionPattern = Regex("^oraculum://artifact/(save|share|open)/($id)$")
    private val types = mapOf("pdf" to "application/pdf", "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "webp" to "image/webp",
        "txt" to "text/plain", "md" to "text/markdown", "csv" to "text/csv",
        "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" to "application/vnd.openxmlformats-officedocument.presentationml.presentation")
    data class Action(val mode: String, val id: String)
    data class Metadata(val name: String, val mime: String, val size: Long, val digest: String)
    fun action(url: String): Action? = actionPattern.matchEntire(url)?.let { Action(it.groupValues[1], it.groupValues[2]) }
    fun cookie(raw: String?, entry: ServerEntry): String? {
        val name = if (entry.origin.startsWith("https://")) "__Secure-oraculum_session" else "oraculum_local"
        val matches = raw.orEmpty().split(';').map { it.trim() }.filter { it.startsWith("$name=") }
        return matches.singleOrNull()?.takeIf { Regex("${Regex.escape(name)}=[A-Za-z0-9_-]{43}").matches(it) }
    }
    fun metadata(contentType: String?, length: String?, disposition: String?, digest: String?): Metadata {
        val mime = contentType.orEmpty().substringBefore(';').lowercase(Locale.ROOT)
        val size = length?.toLongOrNull() ?: throw IllegalArgumentException("下载大小无效")
        require(size in 0..maxBytes && Regex("^[a-f0-9]{64}$").matches(digest.orEmpty()))
        val encoded = Regex("^attachment; filename=\"artifact\\.[a-z]+\"; filename\\*=UTF-8''(.+)$").matchEntire(disposition.orEmpty())?.groupValues?.get(1)
            ?: throw IllegalArgumentException("下载文件名无效")
        val name = URLDecoder.decode(encoded.replace("+", "%2B"), "UTF-8")
        require(name.isNotEmpty() && name.length <= 180 && name.trim() == name && !name.startsWith('.') &&
            !Regex("[/\\\\:%\\p{Cc}\\p{Cf}]").containsMatchIn(name) && Normalizer.normalize(name, Normalizer.Form.NFC) == name)
        require(types[name.substringAfterLast('.', "").lowercase(Locale.ROOT)] == mime)
        return Metadata(name, mime, size, digest!!)
    }
    fun copy(input: InputStream, output: OutputStream, metadata: Metadata, cancelled: () -> Boolean, progress: (Long) -> Unit) {
        val hash = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(64 * 1024)
        var count = 0L
        while (true) {
            check(!cancelled()) { "下载已取消" }
            val read = input.read(buffer)
            if (read < 0) break
            count += read
            require(count <= metadata.size && count <= maxBytes) { "下载大小不符" }
            output.write(buffer, 0, read); hash.update(buffer, 0, read); progress(count)
        }
        check(!cancelled()) { "下载已取消" }
        require(count == metadata.size && hash.digest().joinToString("") { "%02x".format(it) } == metadata.digest) { "下载中断或校验失败" }
        output.flush()
    }
}
