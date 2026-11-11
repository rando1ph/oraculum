package dev.oraculum.poc.gateway

import java.net.URI
import java.util.Locale

/** An explicitly selected HTTPS origin and canonical, deployment-relative base path. */
class GatewayEndpoint private constructor(val origin: String, val basePath: String) {
    val url: String get() = origin + basePath

    override fun equals(other: Any?): Boolean = other is GatewayEndpoint && url == other.url
    override fun hashCode(): Int = url.hashCode()
    override fun toString(): String = url

    companion object {
        fun parse(input: String): GatewayEndpoint {
            try {
                val uri = URI(input.trim())
                require(uri.scheme.equals("https", ignoreCase = true) && uri.host != null &&
                    uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
                    (uri.port == -1 || uri.port in 1..65535))
                val path = uri.rawPath.orEmpty().ifEmpty { "/" }
                require(Regex("^/[A-Za-z0-9._~/-]*$").matches(path) && !path.contains("//") &&
                    path.split('/').none { it == "." || it == ".." })
                val origin = URI("https", null, uri.host.lowercase(Locale.ROOT),
                    if (uri.port == 443) -1 else uri.port, null, null, null).toASCIIString()
                return GatewayEndpoint(origin, if (path.endsWith('/')) path else "$path/")
            } catch (_: Exception) {
                throw GatewayException("INVALID_ENDPOINT", "请输入 HTTPS 地址；可含 Base Path，不能含账号、查询参数或路径转义。")
            }
        }

        /** The Gateway rejects escaped paths; never let an opaque ID turn into path traversal. */
        fun segment(id: String): String {
            if (!Regex("^[A-Za-z0-9._~-]{1,256}$").matches(id) || id == "." || id == "..")
                throw GatewayException("INVALID_RESOURCE_ID", "网关返回的资源标识无法安全用于此路径，请重新同步。")
            return id
        }
    }
}

/** Only fixed local text and a bounded code leave this layer; network exception text may contain secrets. */
class GatewayException(
    val code: String,
    val userMessage: String,
    val httpStatus: Int? = null,
) : Exception(userMessage) {
    val authInvalid: Boolean get() = (httpStatus == 401 && code != "ACCESS_EXPIRED") || code in setOf("UNAUTHENTICATED", "DEVICE_REVOKED", "PAIRING_REQUIRED",
        "INSTALLATION_CHANGED", "CREDENTIAL_STORAGE_UNAVAILABLE")

    companion object {
        internal fun response(code: String, status: Int): GatewayException {
            val safeCode = code.takeIf { Regex("^[A-Z][A-Z0-9_]{1,64}$").matches(it) } ?: "REQUEST_REJECTED"
            val message = when (safeCode) {
                "DEVICE_REVOKED" -> "此设备已被主机撤销，无法继续认证；请在主机检查设备授权。"
                "UNAUTHENTICATED" -> "认证已失效，或配对码无效。请检查主机授权后重新连接；写入不会自动重发。"
                "PROTOCOL_INCOMPATIBLE" -> "Gateway 协议不兼容，请使用支持协议 2 的网关。"
                "OPERATION_UNKNOWN", "OPERATION_ALREADY_EXISTS" -> "该操作结果尚未确认。请查询回执和原生状态，不要重复发送。"
                "RATE_LIMITED" -> "请求过于频繁，请稍后手动重试连接。"
                "CURSOR_RESET_REQUIRED", "HISTORY_STALE" -> "历史游标已失效，请重新读取原生状态。"
                "PROJECT_UNAVAILABLE", "THREAD_UNAVAILABLE", "NOT_FOUND" -> "所选项目、会话或资源不可用，请刷新后重新选择。"
                else -> "网关拒绝请求（$safeCode）。请刷新授权或原生状态；写入不会自动重发。"
            }
            return GatewayException(safeCode, message, status)
        }
    }
}
