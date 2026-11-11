package dev.oraculum.poc.gateway

import dev.oraculum.gateway.protocol.*
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

enum class EventDisposition { APPLY, SKIP, RESYNCHRONIZE }

/** Generated contracts remain the field source; checks below enforce identity/range semantics. */
object GatewayProtocol {
    internal val json = Json { ignoreUnknownKeys = true; explicitNulls = true }
    internal const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
    private val uuidPattern = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    internal fun uuid(value: String): Boolean = uuidPattern.matches(value)
    internal fun sequence(value: Long): Boolean = value in 0..MAX_SAFE_INTEGER

    internal inline fun <reified T> decode(value: JsonElement): T = try {
        json.decodeFromString<T>(value.toString())
    } catch (_: Exception) { throw malformed() }

    internal fun malformed(): GatewayException = GatewayException("INVALID_RESPONSE", "网关响应无法安全识别，请重新连接并校正原生状态。")

    internal fun health(value: JsonObject): HealthResponse {
        val result = decode<HealthResponse>(value)
        if (result.protocolMajor != 2L) throw incompatible()
        if (!uuid(result.installationID)) throw malformed()
        return result
    }

    internal fun capabilities(value: JsonObject, installationId: String): Capabilities {
        val result = decode<Capabilities>(value)
        if (result.protocol.major != 2L || result.protocol.minClientMinor > 0 ||
            result.protocol.minClientMinor < 0 || result.protocol.minor < 0) throw incompatible()
        if (result.installationID != installationId || !uuid(result.epoch) ||
            result.capabilities.any { it.epoch != result.epoch }) throw malformed()
        return result
    }

    internal fun envelope(value: JsonObject, installationId: String, operationId: String? = null) {
        val epoch: String
        val actualInstallation: String
        if (operationId != null) {
            val result = decode<OperationResponse>(value)
            if (result.operation.operationID != operationId || !uuid(operationId)) throw malformed()
            epoch = result.epoch
            actualInstallation = result.installationID
        } else {
            val result = decode<ResourceResponse>(value)
            epoch = result.epoch
            actualInstallation = result.installationID
        }
        if (actualInstallation != installationId)
            throw GatewayException("INSTALLATION_CHANGED", "Gateway 安装身份已改变；已停止请求并保留原设备身份和未确认操作。")
        if (!uuid(epoch)) throw malformed()
    }

    internal fun resource(path: String, value: JsonObject, installationId: String) {
        envelope(value, installationId)
        val data = value.getValue("data")
        when {
            path == "capabilities" -> capabilities(data.jsonObject, installationId)
            path == "projects" -> decode<Projects>(data)
            path == "auth/session" -> decode<SessionResponse>(data)
            path == "models" -> decode<ModelPage>(data)
            Regex("^projects/[^/]+/extensions$").matches(path) -> decode<ExtensionsSnapshot>(data)
            path == "project-directories/query" -> decode<DirectoryPage>(data)
            Regex("^projects/[^/]+/files/query$").matches(path) -> decode<FilePage>(data)
            Regex("^projects/[^/]+/files/select$").matches(path) -> decode<FileGrant>(data)
            Regex("^projects/[^/]+/threads$").matches(path) -> decode<ThreadPage>(data)
            Regex("^projects/[^/]+/threads/[^/]+$").matches(path) -> decode<dev.oraculum.gateway.protocol.Thread>(data)
            Regex("^operations/[^/]+$").matches(path) -> {
                val receipt = decode<OperationQueryResult>(data)
                if (receipt.operationID != path.substringAfter("operations/") || !uuid(receipt.operationID)) throw malformed()
            }
            path.endsWith("/snapshot") -> decode<Snapshot>(data)
            path.endsWith("/history/query") -> decode<HistoryPage>(data)
            path.endsWith("/history/details") -> decode<ItemDetails>(data)
        }
    }

    /** Same fail-closed classification as packages/gateway-protocol/src/index.ts. */
    fun disposition(event: JsonObject): EventDisposition {
        val valid = runCatching {
            val envelope = decode<EventEnvelope>(event)
            val payload = envelope.payload ?: throw malformed()
            when (envelope.kind) {
                "item.delta" -> {
                    val delta = decode<ItemDelta>(payload)
                    if (delta.offset != null && !sequence(delta.offset)) throw malformed()
                }
                "item.started", "item.completed" -> decode<ItemCompleted>(payload)
                "interaction.opened", "interaction.resolved" -> decode<Interaction>(payload)
                "operation.changed" -> {
                    val receipt = decode<OperationReceipt>(payload)
                    if (!uuid(receipt.operationID)) throw malformed()
                }
                "project.changed" -> decode<ProjectChanged>(payload)
                "history.invalidated" -> decode<HistoryInvalidated>(payload)
                "connection.changed" -> decode<ConnectionChanged>(payload)
                else -> throw malformed()
            }
        }.isSuccess
        return if (valid) EventDisposition.APPLY
        else if ((event["impact"] as? JsonPrimitive)?.content == "informational") EventDisposition.SKIP
        else EventDisposition.RESYNCHRONIZE
    }

    private fun incompatible() = GatewayException("PROTOCOL_INCOMPATIBLE", "Gateway 协议不兼容，请使用支持协议 2.0 的网关。")
}
