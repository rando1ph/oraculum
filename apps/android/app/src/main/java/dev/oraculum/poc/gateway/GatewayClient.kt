package dev.oraculum.poc.gateway

import android.content.Context
import dev.oraculum.gateway.protocol.AuthResponse
import dev.oraculum.gateway.protocol.ErrorResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.BufferedSink
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.File
import java.io.FileOutputStream
import java.util.Base64
import dev.oraculum.poc.files.FileTransferPolicy
import dev.oraculum.poc.files.HostFileGrant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** HTTPS/WSS only. Access tokens are memory-only; no interceptor retries a write. */
class GatewayClient internal constructor(
    private val vault: CredentialStore,
    client: OkHttpClient,
    private val now: () -> Long = System::currentTimeMillis,
) {
    constructor(context: Context) : this(CredentialVault(context.applicationContext), OkHttpClient())

    private val http = client.newBuilder()
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS).callTimeout(135, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS).build()
    private val authentication = Mutex()
    @Volatile private var endpoint: GatewayEndpoint? = null
    @Volatile private var credential: DeviceCredential? = null
    @Volatile private var access: Access? = null
    private val sockets = ConcurrentHashMap.newKeySet<EventConnectionHandle>()

    val identity: DeviceIdentity? get() = credential?.identity

    suspend fun savedIdentity(endpoint: GatewayEndpoint): DeviceIdentity? = withContext(Dispatchers.IO) {
        vault.load(endpoint)?.identity
    }

    suspend fun health(endpoint: GatewayEndpoint): JsonObject {
        val response = request(endpoint, "GET", "health", api = false)
        GatewayProtocol.health(response)
        return response
    }

    /** The durable UUID/secret is committed before POST, so a lost pair ACK is recoverable via token. */
    suspend fun pair(endpoint: GatewayEndpoint, code: String, label: String = "Oraculum Android"): JsonObject {
        if (code.length !in 20..128 || label.isBlank() || label.length > 80)
            throw GatewayException("INVALID_PAIRING", "请输入主机 CLI 生成的完整配对码（有效期内一次使用）。")
        val installation = GatewayProtocol.health(health(endpoint)).installationID
        authentication.withLock {
            val prior = withContext(Dispatchers.IO) { vault.load(endpoint) }
            val selected = prior ?: newCredential(endpoint, installation).also { created ->
                withContext(Dispatchers.IO) { vault.save(created) }
            }
            bind(endpoint, selected, installation)
            if (prior != null) {
                try {
                    exchange(selected)
                    return@withLock
                } catch (error: GatewayException) {
                    // Only a never-confirmed pairing can use its unchanged identity with a fresh CLI code.
                    if (error.code != "UNAUTHENTICATED" || selected.identity.paired) throw error
                }
            }
            val body = authBody(selected) {
                put("code", code)
                put("label", label)
            }
            accept(request(endpoint, "POST", "auth/pair", body), selected)
        }
        return capabilities()
    }

    suspend fun connect(endpoint: GatewayEndpoint): JsonObject {
        val installation = GatewayProtocol.health(health(endpoint)).installationID
        authentication.withLock {
            val selected = withContext(Dispatchers.IO) { vault.load(endpoint) }
                ?: throw GatewayException("PAIRING_REQUIRED", "此地址尚未配对，请在主机 CLI 生成一次性配对码。")
            bind(endpoint, selected, installation)
            if (!accessValid()) exchange(selected)
        }
        return capabilities()
    }

    suspend fun get(path: String, query: Map<String, String> = emptyMap()): JsonObject =
        authorized("GET", path, null, query, readOnly = true)

    suspend fun post(path: String, body: JsonObject, beforeDispatch: () -> Unit = {}): JsonObject = authorized("POST", path, body,
        readOnly = path == "project-directories/query" || Regex("^threads/[^/]+/(snapshot|history/query|history/details)$").matches(path) ||
            Regex("^projects/[^/]+/files/(query|select)$").matches(path),
        beforeDispatch = beforeDispatch)

    suspend fun delete(path: String, body: JsonObject, beforeDispatch: () -> Unit = {}): JsonObject =
        authorized("DELETE", path, body, readOnly = false, beforeDispatch = beforeDispatch)

    /** A one-shot binary request: a cancelled or lost ACK is reconciled by operation ID, never replayed. */
    suspend fun uploadAttachment(metadata: JsonObject, file: File, beforeDispatch: () -> Unit,
        progress: (Long, Long) -> Unit = { _, _ -> }): JsonObject {
        val operationId = metadata["operationId"]?.jsonPrimitive?.content?.takeIf(GatewayProtocol::uuid)
            ?: throw GatewayProtocol.malformed()
        val threadId = segment(metadata.getValue("threadId").jsonPrimitive.content)
        val expectedSize = metadata.getValue("size").jsonPrimitive.content.toLongOrNull() ?: throw GatewayProtocol.malformed()
        if (expectedSize !in 1..FileTransferPolicy.MAX_UPLOAD || !file.isFile || file.length() != expectedSize) throw GatewayProtocol.malformed()
        val session = ensureSession()
        beforeDispatch()
        val body = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun contentLength() = expectedSize
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) {
                file.inputStream().use { input ->
                    val buffer = ByteArray(64 * 1024); var count = 0L
                    while (true) {
                        val read = input.read(buffer)
                        if (read == -1) break
                        if (count + read > expectedSize) throw IOException("Upload changed")
                        sink.write(buffer, 0, read); count += read; progress(count, expectedSize)
                    }
                    if (count != expectedSize) throw IOException("Upload changed")
                }
            }
        }
        val request = Request.Builder().url(session.endpoint.url + "api/v2/threads/$threadId/attachments")
            .header("X-Oraculum-Protocol", "2").header("Authorization", "Bearer ${session.access.token}")
            .header("X-Oraculum-Upload", Base64.getUrlEncoder().withoutPadding().encodeToString(metadata.toString().toByteArray()))
            .post(body).build()
        val result = binaryAuthorized(session) { execute(request) { decodeResponse(it) } }
        GatewayProtocol.envelope(result, session.identity.installationId, operationId)
        return result
    }

    /** Bytes are bounded and authenticated against the grant and server digest before publication. */
    suspend fun downloadFile(grant: HostFileGrant, target: File, progress: (Long, Long) -> Unit = { _, _ -> }) {
        FileTransferPolicy.validateGrant(grant, now())
        val session = ensureSession()
        val request = Request.Builder().url(session.endpoint.url + "api/v2/files/${segment(grant.id)}/content")
            .header("X-Oraculum-Protocol", "2").header("Authorization", "Bearer ${session.access.token}")
            .header("Accept", grant.mime).get().build()
        try {
            binaryAuthorized(session) { execute(request) { response ->
                if (!response.isSuccessful) { decodeResponse(response); throw GatewayProtocol.malformed() }
                val body = response.body ?: throw GatewayProtocol.malformed()
                val digest = FileTransferPolicy.validateHeaders(grant, response.header("Content-Type"),
                    response.header("Content-Length"), response.header("Content-Digest"), response.header("Content-Disposition"), now())
                FileOutputStream(target).use { output ->
                    body.byteStream().use { input -> FileTransferPolicy.copyVerified(input, output, grant.size, digest,
                        { FileTransferPolicy.validateGrant(grant, now()) }, progress) }
                    output.fd.sync()
                }
            } }
        } catch (error: Throwable) { target.delete(); throw error }
    }

    private suspend fun <T> binaryAuthorized(session: Session, work: suspend () -> T): T = try { work() }
    catch (error: GatewayException) {
        if ((error.httpStatus == 401 || error.httpStatus == 403) && access === session.access) access = null
        if (error.httpStatus == 401) throw GatewayException("ACCESS_EXPIRED", "临时访问凭据已失效，请校正连接；文件写入不会自动重发。", 401)
        throw error
    }

    private suspend fun <T> execute(request: Request, decode: (Response) -> T): T = suspendCancellableCoroutine { continuation ->
        val call = http.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) {
                if (continuation.isActive) continuation.resumeWithException(networkError(error))
            }
            override fun onResponse(call: Call, response: Response) {
                val result = runCatching { response.use(decode) }
                if (continuation.isActive) result.fold(continuation::resume, continuation::resumeWithException)
            }
        })
    }

    suspend fun openEvents(cursor: EventCursor?, listener: GatewayEventListener): EventConnectionHandle {
        val session = ensureSession()
        val handle = EventConnectionHandle(session.identity.installationId, cursor, listener) { connection ->
            sockets.remove(connection)
        }
        sockets.add(handle)
        val request = Request.Builder().url(session.endpoint.url + "api/v2/events")
            .header("X-Oraculum-Protocol", "2").header("Authorization", "Bearer ${session.access.token}").build()
        handle.attach(http.newWebSocket(request, handle.listener {
            // A 1008 close can mean access expiry or revocation. The next explicit reconnect reauthenticates.
            if (access === session.access) access = null
        }))
        return handle
    }

    fun disconnect() {
        access = null
        sockets.toList().forEach { it.close() }
    }

    private suspend fun capabilities(): JsonObject = get("capabilities").getValue("data").jsonObject

    private fun bind(endpoint: GatewayEndpoint, selected: DeviceCredential, installation: String) {
        if (selected.identity.installationId != installation)
            throw GatewayException("INSTALLATION_CHANGED", "Gateway 安装身份已改变；请检查地址和主机状态。原设备身份与未确认操作已保留。")
        if (this.endpoint != endpoint || credential?.identity?.deviceId != selected.identity.deviceId) disconnect()
        this.endpoint = endpoint
        credential = selected
    }

    private suspend fun ensureSession(): Session = authentication.withLock {
        if (!accessValid()) exchange(credential ?: throw pairingRequired())
        Session(endpoint ?: throw pairingRequired(), identity ?: throw pairingRequired(), access ?: throw pairingRequired())
    }

    private fun accessValid(): Boolean = access?.let { now() < it.refreshAt } == true

    private suspend fun exchange(selected: DeviceCredential) {
        val selectedEndpoint = endpoint ?: throw pairingRequired()
        accept(request(selectedEndpoint, "POST", "auth/token", authBody(selected)), selected)
    }

    private suspend fun accept(response: JsonObject, selected: DeviceCredential) {
        val result = GatewayProtocol.decode<AuthResponse>(response)
        if (result.installationID != selected.identity.installationId || result.deviceID != selected.identity.deviceId ||
            !Regex("^[A-Za-z0-9_-]{43}$").matches(result.accessToken) || !GatewayProtocol.sequence(result.expiresAt))
            throw GatewayProtocol.malformed()
        val remaining = result.expiresAt - now()
        if (remaining <= 0) throw GatewayException("AUTH_EXPIRED", "网关返回的认证已过期，请检查设备时间并重新连接。")
        val active = if (selected.identity.paired) selected
            else DeviceCredential(selected.identity.copy(paired = true), selected.secret).also {
                withContext(Dispatchers.IO) { vault.save(it) }
            }
        credential = active
        access = Access(result.accessToken, result.expiresAt - minOf(30_000, remaining / 10))
    }

    private suspend fun authorized(
        method: String, path: String, body: JsonObject?, query: Map<String, String> = emptyMap(), readOnly: Boolean,
        beforeDispatch: () -> Unit = {},
    ): JsonObject {
        validatePath(path)
        if (path.startsWith("auth/") && path != "auth/session") throw GatewayProtocol.malformed()
        val operationId = if (readOnly) null else body?.get("operationId")?.jsonPrimitive?.content
            ?.takeIf { GatewayProtocol.uuid(it) } ?: throw GatewayException("OPERATION_ID_REQUIRED", "写入前必须先保存操作标识。")
        val session = ensureSession()
        // Token exchange may suspend while the caller loses its WSS baseline. Recheck the durable
        // operation's lifecycle immediately before enqueueing its one-shot business request.
        if (!readOnly) beforeDispatch()
        val response = try {
            request(session.endpoint, method, path, body, query, token = session.access.token)
        } catch (error: GatewayException) {
            if ((error.httpStatus == 401 || error.httpStatus == 403) && access === session.access) access = null
            if (error.httpStatus == 401)
                throw GatewayException("ACCESS_EXPIRED", "临时访问凭据已失效，正在重新校正连接。设备配对仍保留；写入不会自动重发。", 401)
            throw error // Even a 401/503 is not permission to repeat a business request.
        }
        try {
            if (readOnly) GatewayProtocol.resource(path, response, session.identity.installationId)
            else GatewayProtocol.envelope(response, session.identity.installationId, operationId)
        } catch (error: GatewayException) { throw error }
        catch (_: Exception) { throw GatewayProtocol.malformed() }
        return response
    }

    private suspend fun request(
        endpoint: GatewayEndpoint, method: String, path: String, body: JsonObject? = null,
        query: Map<String, String> = emptyMap(), api: Boolean = true, token: String? = null,
    ): JsonObject {
        validatePath(path)
        val url = (endpoint.url + (if (api) "api/v2/" else "") + path).toHttpUrl().newBuilder()
        query.forEach { (key, value) ->
            if (key.lowercase() in setOf("token", "access_token", "authorization", "credential")) throw GatewayProtocol.malformed()
            url.addQueryParameter(key, value)
        }
        val request = Request.Builder().url(url.build()).header("Accept", "application/json")
            .header("X-Oraculum-Protocol", "2")
        token?.let { request.header("Authorization", "Bearer $it") }
        val encoded = body?.toString()?.toByteArray(Charsets.UTF_8)
        if (encoded != null && encoded.size > 128 * 1024)
            throw GatewayException("REQUEST_TOO_LARGE", "请求超过网关限制，请缩短内容。")
        request.method(method, encoded?.let { OneShotJson(it) })
        return suspendCancellableCoroutine { continuation ->
            val call = http.newCall(request.build())
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, error: IOException) {
                    if (continuation.isActive) continuation.resumeWithException(networkError(error))
                }
                override fun onResponse(call: Call, response: Response) {
                    val result = runCatching { response.use { decodeResponse(it) } }
                    if (continuation.isActive) result.fold(continuation::resume, continuation::resumeWithException)
                }
            })
        }
    }

    private fun decodeResponse(response: Response): JsonObject {
        try {
            if (response.code in 300..399)
                throw GatewayException("REDIRECT_REJECTED", "网关返回了重定向；为保护凭据，请直接填写最终 HTTPS 地址。", response.code)
            val body = response.body ?: throw GatewayProtocol.malformed()
            if (body.contentLength() > 2 * 1024 * 1024) throw GatewayProtocol.malformed()
            val data = ByteArrayOutputStream()
            body.byteStream().use { input ->
                val buffer = ByteArray(8192)
                while (true) {
                    val count = input.read(buffer)
                    if (count == -1) break
                    if (data.size() + count > 2 * 1024 * 1024) throw GatewayProtocol.malformed()
                    data.write(buffer, 0, count)
                }
            }
            val value = GatewayProtocol.json.parseToJsonElement(data.toString("UTF-8")).jsonObject
            if (!response.isSuccessful) {
                val error = GatewayProtocol.decode<ErrorResponse>(value)
                throw GatewayException.response(error.error.code, response.code)
            }
            return value
        } catch (error: GatewayException) { throw error }
        catch (error: IOException) { throw networkError(error) }
        catch (_: Exception) { throw GatewayProtocol.malformed() }
    }

    private fun authBody(selected: DeviceCredential, extra: (kotlinx.serialization.json.JsonObjectBuilder.() -> Unit)? = null) = buildJsonObject {
        put("installationId", selected.identity.installationId)
        put("deviceId", selected.identity.deviceId)
        put("deviceCredential", selected.secret)
        extra?.invoke(this)
    }

    private class Access(val token: String, val refreshAt: Long)
    private class Session(val endpoint: GatewayEndpoint, val identity: DeviceIdentity, val access: Access)
    private class OneShotJson(private val bytes: ByteArray) : RequestBody() {
        override fun contentType() = "application/json; charset=utf-8".toMediaType()
        override fun contentLength(): Long = bytes.size.toLong()
        override fun isOneShot() = true
        override fun writeTo(sink: BufferedSink) { sink.write(bytes) }
    }

    companion object {
        fun segment(id: String): String = GatewayEndpoint.segment(id)
        private fun pairingRequired() = GatewayException("PAIRING_REQUIRED", "请先连接已配对的 Gateway。")
        private fun validatePath(path: String) {
            if (!Regex("^[A-Za-z0-9._~/-]+$").matches(path) || path.startsWith('/') || path.endsWith('/') ||
                path.contains("//") || path.split('/').any { it == "." || it == ".." }) throw GatewayProtocol.malformed()
        }
        internal fun networkError(error: Throwable): GatewayException =
            if (error is SSLException || error.cause is SSLException)
                GatewayException("TLS_REJECTED", "HTTPS 证书未获信任或主机名不匹配，连接已拒绝。请检查证书和地址。")
            else GatewayException("CONNECTION_LOST", "无法连接网关。可浏览缓存和编辑草稿；未确认写入不会自动重发。")
    }
}
