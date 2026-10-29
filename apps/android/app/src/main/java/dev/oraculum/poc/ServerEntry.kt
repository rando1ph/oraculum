package dev.oraculum.poc

import java.net.URI
import java.security.MessageDigest
import java.util.Locale

/** The address is configuration only. Pairing secrets stay in the entry's WebView profile. */
@ConsistentCopyVisibility
data class ServerEntry private constructor(val origin: String, val basePath: String) {
    val url: String get() = origin + basePath
    val profileName: String get() = "entry-" + MessageDigest.getInstance("SHA-256")
        .digest(url.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    fun trusts(rawUrl: String): Boolean = runCatching {
        val uri = URI(rawUrl)
        val path = uri.rawPath ?: return false
        uri.rawUserInfo == null && validPath(path) && path.startsWith(basePath) &&
            canonicalOrigin(uri) == origin
    }.getOrDefault(false)

    fun usesDefaultProfile(defaultProfileEntry: String): Boolean = url == defaultProfileEntry

    companion object {
        val DEBUG_ORIGIN = "http://127.0.0.1:${BuildConfig.ORACULUM_DEBUG_PORT}"

        fun parse(originInput: String, pathInput: String, debug: Boolean): ServerEntry {
            val uri = runCatching { URI(originInput.trim()) }
                .getOrElse { throw IllegalArgumentException("请输入有效的 HTTPS Origin") }
            require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
                uri.rawPath in listOf("", "/") && uri.host != null &&
                (uri.port == -1 || uri.port in 1..65535)) {
                "Origin 只包含协议、主机与可选端口；路径请填写在 Base Path"
            }
            val origin = canonicalOrigin(uri)
            require(uri.scheme.equals("https", ignoreCase = true) || (debug && origin == DEBUG_ORIGIN)) {
                "仅支持 HTTPS；Debug 可使用本机 ADB reverse 入口"
            }
            val path = pathInput.trim().ifEmpty { "/" }
            require(validPath(path)) { "Base Path 须以 / 开头，不能含转义、重复 / 或 . 与 .. 路径段" }
            val normalizedPath = if (path.endsWith('/')) path else "$path/"
            require(origin != DEBUG_ORIGIN || normalizedPath == "/") { "ADB reverse 使用默认根路径 /" }
            return ServerEntry(origin, normalizedPath)
        }

        private fun validPath(path: String): Boolean = Regex("^/[A-Za-z0-9._~/-]*$").matches(path) &&
            !path.contains("//") && path.split('/').none { it == "." || it == ".." }

        private fun canonicalOrigin(uri: URI): String {
            val scheme = requireNotNull(uri.scheme).lowercase(Locale.ROOT)
            val host = requireNotNull(uri.host).lowercase(Locale.ROOT)
            val port = if (scheme == "https" && uri.port == 443) -1 else uri.port
            return URI(scheme, null, host, port, null, null, null).toASCIIString()
        }
    }
}
