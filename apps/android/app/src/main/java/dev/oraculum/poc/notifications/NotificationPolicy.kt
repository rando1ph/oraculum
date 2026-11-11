package dev.oraculum.poc.notifications

import dev.oraculum.gateway.protocol.EventEnvelope
import dev.oraculum.gateway.protocol.Interaction
import dev.oraculum.gateway.protocol.NativeStateEvent
import dev.oraculum.poc.gateway.GatewayProtocol
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.security.MessageDigest

data class NotificationRoute(
    val scopeKey: String,
    val projectId: String,
    val threadId: String,
    val inspector: String,
)

enum class NoticeKind { TURN, ATTENTION, ERROR }

/** A display projection of verified Gateway facts, never an execution or approval decision. */
data class GatewayNotice(
    val eventKey: String,
    val nativeKey: String,
    val kind: NoticeKind,
    val route: NotificationRoute,
    val title: String,
    val text: String,
    val cancel: Boolean = false,
)

/** Call only after the Gateway event continuity/identity gate has accepted this envelope. */
fun classifyNotification(scopeKey: String, event: JsonObject): GatewayNotice? {
    return runCatching {
        val envelope = GatewayProtocol.decode<EventEnvelope>(event)
        if (scopeKey.isBlank() || !GatewayProtocol.uuid(envelope.installationID) ||
            !GatewayProtocol.uuid(envelope.epoch) || envelope.seq < 1 || !GatewayProtocol.sequence(envelope.seq)) return null
        val project = envelope.scope.projectID?.takeIf(GatewayProtocol::uuid) ?: return null
        val thread = envelope.scope.threadID?.takeIf(::safeNativeId) ?: return null
        val payload = envelope.payload ?: return null
        val eventKey = noticeHash(scopeKey, envelope.epoch, envelope.seq.toString())
        fun notice(nativeId: String, family: String, kind: NoticeKind, title: String, text: String, cancel: Boolean = false) = GatewayNotice(
            eventKey, noticeHash(scopeKey, project, thread, family, nativeId), kind,
            NotificationRoute(scopeKey, project, thread, if (kind == NoticeKind.ATTENTION) "approvals" else "execution"),
            title, text, cancel,
        )
        when (envelope.kind) {
            "interaction.opened", "interaction.resolved" -> {
                val interaction = GatewayProtocol.decode<Interaction>(payload)
                val status = (payload as? JsonObject)?.text("status")
                if (interaction.projectID != project || interaction.threadID != thread || interaction.epoch != envelope.epoch ||
                    !GatewayProtocol.uuid(interaction.interactionID) || interaction.generation < 1 || !GatewayProtocol.sequence(interaction.generation) ||
                    interaction.kind !in setOf("command", "fileChange", "permissions", "input", "elicitation")) return null
                when {
                    envelope.kind == "interaction.opened" && status == "pending" -> notice(
                        interaction.interactionID, "interaction", NoticeKind.ATTENTION,
                        if (interaction.kind in setOf("input", "elicitation")) "Codex 等待你的回复" else "Codex 需要审批",
                        "打开对应会话，核对最新请求后处理。",
                    )
                    envelope.kind == "interaction.resolved" && status in setOf("submitted", "unknown", "resolved") -> notice(
                        interaction.interactionID, "interaction", NoticeKind.ATTENTION, "", "", cancel = true,
                    )
                    else -> null
                }
            }
            "native.state" -> {
                val state = GatewayProtocol.decode<NativeStateEvent>(payload)
                if (state.truncated || state.method != "turn/completed" || state.data.text("threadId") != thread) return null
                val turn = state.data["turn"] as? JsonObject ?: return null
                val id = turn.text("id")?.takeIf(::safeNativeId) ?: return null
                if (envelope.scope.turnID != null && envelope.scope.turnID != id) return null
                when (turn.text("status")) {
                    "completed" -> notice(id, "turn", NoticeKind.TURN, "Codex 执行完成", "打开对应会话查看结果与执行详情。")
                    "interrupted" -> notice(id, "turn", NoticeKind.TURN, "Codex 执行已停止", "打开对应会话核对最新状态。")
                    "failed" -> notice(id, "turn", NoticeKind.ERROR, "Codex 执行失败", "打开对应会话查看错误与执行详情。")
                    else -> null
                }
            }
            else -> null
        }
    }.getOrNull()
}

internal fun safeNativeId(value: String): Boolean = value.length in 1..256 && value.none(Char::isISOControl)
internal fun noticeHash(vararg values: String): String = MessageDigest.getInstance("SHA-256")
    .digest(JsonArray(values.map(::JsonPrimitive)).toString().toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it) }
private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
