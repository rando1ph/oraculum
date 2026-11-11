package dev.oraculum.poc.repository

import dev.oraculum.poc.ui.PermissionReadbackUi
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/** Latest native start/resume response, never a claim about current execution or a local preset. */
fun permissionReadbackUi(thread: JsonObject): PermissionReadbackUi? {
    val readback = thread["permissionReadback"] as? JsonObject ?: return null
    fun text(key: String) = (readback[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    val sandbox = text("sandboxType")?.takeIf { it.length in 1..100 } ?: return null
    val approval = text("approvalPolicy")?.takeIf { it.length in 1..100 } ?: return null
    val source = text("source")?.takeIf { it in setOf("thread.start", "thread.resume") } ?: return null
    val observed = (readback["observedAt"] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull
        ?.takeIf { it in 0..9_007_199_254_740_991L } ?: return null
    if (!readback.containsKey("preset")) return null
    val preset = when {
        readback["preset"] == JsonNull -> null
        text("preset") in setOf("read-only", "auto", "full-access") -> text("preset")
        else -> return null
    }
    return PermissionReadbackUi(sandbox, approval, preset, observed, source)
}
