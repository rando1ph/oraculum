package dev.oraculum.poc.repository

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class PermissionReadbackTest {
    private fun thread(preset: JsonElement = JsonPrimitive("auto"), source: String = "thread.start") = buildJsonObject {
        put("permissionReadback", buildJsonObject {
            put("sandboxType", "workspaceWrite"); put("approvalPolicy", "on-request")
            put("preset", preset); put("observedAt", 1234); put("source", source)
        })
    }
    @Test fun preservesNativeSourceTimeAndFacts() {
        val value = requireNotNull(permissionReadbackUi(thread()))
        assertEquals("thread.start", value.source)
        assertEquals(1234L, value.observedAt)
        assertEquals("workspaceWrite", value.sandboxType)
        assertEquals("on-request", value.approvalPolicy)
        assertEquals("auto", value.preset)
    }
    @Test fun customNullNeverUsesTopLevelOrLocalPreset() {
        val raw = JsonObject(thread(JsonNull) + ("permissionPreset" to JsonPrimitive("full-access")))
        val value = requireNotNull(permissionReadbackUi(raw))
        assertNull(value.preset)
        assertEquals("workspaceWrite", value.sandboxType)
        assertNull(permissionReadbackUi(buildJsonObject { put("permissionPreset", "read-only") }))
    }
    @Test fun incompleteOrUnsupportedFactsFailClosed() {
        assertNull(permissionReadbackUi(thread(JsonPrimitive("guessed"))))
        assertNull(permissionReadbackUi(thread(source = "turn.start")))
        val missing = thread()["permissionReadback"]!!.jsonObject.filterKeys { it != "preset" }
        assertNull(permissionReadbackUi(buildJsonObject { put("permissionReadback", JsonObject(missing)) }))
        val wrongTime = JsonObject(thread()["permissionReadback"]!!.jsonObject + ("observedAt" to JsonPrimitive("1234")))
        assertNull(permissionReadbackUi(buildJsonObject { put("permissionReadback", wrongTime) }))
    }
}
