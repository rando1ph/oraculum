package dev.oraculum.poc.gateway

import dev.oraculum.gateway.protocol.EventConnection
import dev.oraculum.gateway.protocol.EventEnvelope
import dev.oraculum.gateway.protocol.EventPong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

data class EventCursor(val epoch: String, val afterSeq: Long)

interface GatewayEventListener {
    /** Ordered on the socket callback thread. Persist/reset the cursor before applying subsequent events. */
    fun onConnection(message: JsonObject) {}
    fun onEvent(event: JsonObject) {}
    fun onFailure(error: GatewayException) {}
    fun onClosed() {}
}

class EventConnectionHandle internal constructor(
    private val installationId: String,
    cursor: EventCursor?,
    private val callbacks: GatewayEventListener,
    private val removed: (EventConnectionHandle) -> Unit,
) {
    // A null cursor explicitly requests a new baseline, never an accidental partial replay from zero.
    private val resume = cursor ?: EventCursor(UUID.randomUUID().toString(), 0)
    private val finished = AtomicBoolean(false)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var socket: WebSocket? = null
    private var connectionEpoch: String? = null
    private var lastSeq = resume.afterSeq

    init {
        if (!GatewayProtocol.uuid(resume.epoch) || !GatewayProtocol.sequence(resume.afterSeq))
            throw GatewayProtocol.malformed()
    }

    internal fun attach(value: WebSocket) {
        socket = value
        if (finished.get()) value.cancel()
    }

    fun ping(): Boolean = !finished.get() && socket?.send("{\"type\":\"ping\"}") == true

    fun close() {
        if (!finished.compareAndSet(false, true)) return
        scope.cancel()
        socket?.close(1000, "Client disconnected")
        removed(this)
        runCatching { callbacks.onClosed() }
    }

    internal fun listener(invalidateAccess: () -> Unit): WebSocketListener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            attach(webSocket)
            if (finished.get()) return
            val sent = webSocket.send(buildJsonObject {
                put("type", "resume"); put("epoch", resume.epoch); put("afterSeq", resume.afterSeq)
            }.toString())
            if (!sent) { fail(GatewayClient.networkError(IllegalStateException())); return }
            scope.launch {
                while (!finished.get()) {
                    delay(20_000)
                    if (!ping()) { fail(GatewayClient.networkError(IllegalStateException())); break }
                }
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (finished.get()) return
            try {
                if (text.length > 2 * 1024 * 1024 || text.toByteArray(Charsets.UTF_8).size > 2 * 1024 * 1024)
                    throw GatewayProtocol.malformed()
                val value = GatewayProtocol.json.parseToJsonElement(text).jsonObject
                when (value["type"]?.jsonPrimitive?.content) {
                    "connection" -> {
                        if (connectionEpoch != null) throw GatewayProtocol.malformed()
                        val connection = GatewayProtocol.decode<EventConnection>(value)
                        if (connection.installationID != installationId || !GatewayProtocol.uuid(connection.epoch) ||
                            !GatewayProtocol.sequence(connection.headSeq)) throw GatewayProtocol.malformed()
                        if (!connection.resetRequired && (connection.epoch != resume.epoch || connection.headSeq < resume.afterSeq))
                            throw GatewayProtocol.malformed()
                        connectionEpoch = connection.epoch
                        if (connection.resetRequired) lastSeq = connection.headSeq
                        callbacks.onConnection(value)
                    }
                    "pong" -> {
                        val pong = GatewayProtocol.decode<EventPong>(value)
                        if (connectionEpoch == null || pong.epoch != connectionEpoch) throw resetRequired()
                    }
                    else -> {
                        val event = GatewayProtocol.decode<EventEnvelope>(value)
                        if (connectionEpoch == null || event.installationID != installationId || event.epoch != connectionEpoch ||
                            !GatewayProtocol.sequence(event.seq) || event.seq < 1) throw resetRequired()
                        if (event.seq <= lastSeq) return // A replay duplicate never reaches the projection twice.
                        if (event.seq != lastSeq + 1) throw resetRequired()
                        lastSeq = event.seq
                        callbacks.onEvent(value)
                    }
                }
            } catch (error: GatewayException) { fail(error) }
            catch (_: Exception) { fail(GatewayProtocol.malformed()) }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) { fail(GatewayProtocol.malformed()) }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, null)
            if (!finished.get()) {
                if (code == 1008) invalidateAccess()
                fail(GatewayException("EVENT_CONNECTION_CLOSED", "实时连接已关闭，请重新连接以校正认证和原生状态。"))
            }
        }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (!finished.get()) fail(GatewayClient.networkError(IllegalStateException()))
        }
        override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
            response?.close()
            if (response?.code in listOf(401, 403)) invalidateAccess()
            fail(GatewayClient.networkError(error))
        }
    }

    private fun fail(error: GatewayException) {
        if (!finished.compareAndSet(false, true)) return
        scope.cancel()
        socket?.cancel()
        removed(this)
        runCatching { callbacks.onFailure(error) }
    }

    private fun resetRequired() = GatewayException("EVENT_RESET_REQUIRED", "事件序号或网关代次已改变，请重新同步原生状态；写入不会自动重发。")
}
