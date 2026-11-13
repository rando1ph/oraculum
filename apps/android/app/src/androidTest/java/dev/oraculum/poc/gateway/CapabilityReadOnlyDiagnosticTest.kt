package dev.oraculum.poc.gateway

import android.os.Bundle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.oraculum.poc.storage.CacheScope
import dev.oraculum.poc.storage.ClientPreferences
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Opt-in reads against the already paired Gateway, without starting an Activity or ViewModel.
 * Only authentication/health and GET capabilities/models/extensions are used. No Turn, resume,
 * configuration, preference or credential writes are allowed. The report contains only counts,
 * known capability flags, section status/reason codes and whether any model advertises ultra.
 */
@RunWith(AndroidJUnit4::class)
class CapabilityReadOnlyDiagnosticTest {
    @Test fun inspectAdvertisedCapabilitiesWithoutBusinessWrites() = runBlocking {
        assumeTrue("Saved Gateway capability diagnosis requires explicit opt-in",
            InstrumentationRegistry.getArguments().getString("oraculumReadOnlyCapabilityDiagnostic") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val report = JSONObject().put("businessWrites", 0).put("preferenceWrites", 0)
        val stages = JSONArray()
        report.put("stages", stages)
        val preferences = ClientPreferences(context)
        val before = preferences.snapshot()
        var client: GatewayClient? = null
        var credentialSaves = 0
        var failed = false

        suspend fun read(name: String, work: suspend () -> JsonObject): JsonObject? {
            val stage = JSONObject().put("name", name)
            stages.put(stage)
            return try {
                withTimeout(45_000) { work() }.also { stage.put("success", true) }
            } catch (error: Exception) {
                failed = true
                stage.put("success", false).put("errorCode", safeFailure(error))
                if (error is GatewayException) error.httpStatus?.let { stage.put("httpStatus", it) }
                null
            }
        }

        try {
            check(before.endpoint.isNotBlank()) { "SAVED_ENDPOINT_REQUIRED" }
            val project = checkNotNull(before.projectId) { "SAVED_PROJECT_REQUIRED" }
            val endpoint = GatewayEndpoint.parse(before.endpoint)
            val vault = CredentialVault(context)
            val savedCredential = checkNotNull(vault.load(endpoint)) { "SAVED_PAIRED_IDENTITY_REQUIRED" }
            check(savedCredential.identity.paired) { "SAVED_PAIRED_IDENTITY_REQUIRED" }
            val identity = savedCredential.identity
            val scope = CacheScope(identity.endpoint, identity.installationId, identity.deviceId).key
            check(before.scopeKey == scope) { "SAVED_SCOPE_MISMATCH" }
            val readOnlyVault = object : CredentialStore {
                override fun load(requested: GatewayEndpoint): DeviceCredential? {
                    check(requested == endpoint) { "ENDPOINT_CHANGED" }
                    return vault.load(endpoint)
                }
                override fun save(credential: DeviceCredential) {
                    credentialSaves++
                    error("CREDENTIAL_SAVE_PROHIBITED")
                }
            }
            val gateway = GatewayClient(readOnlyVault, OkHttpClient())
            client = gateway
            val capabilities = read("authenticateAndCapabilities") { gateway.connect(endpoint) }
            capabilities?.let { data ->
                val advertised = data.array("capabilities").mapNotNull { it as? JsonObject }
                val flags = JSONObject()
                for (name in CAPABILITIES) flags.put(name, advertised.any {
                    it.text("name") == name && it.text("supported") == "true"
                })
                report.put("capabilities", flags)
            }
            if (capabilities != null) {
                read("models") { gateway.get("models").data() }?.let { page ->
                    val models = page.array("data").mapNotNull { it as? JsonObject }
                    val ultraCount = models.count { model -> model.array("supportedReasoningEfforts").any {
                        (it as? JsonObject)?.text("reasoningEffort") == "ultra"
                    } }
                    report.put("models", JSONObject().put("count", models.size)
                        .put("ultraAdvertised", ultraCount > 0).put("modelsAdvertisingUltra", ultraCount)
                        .put("modelsDefaultingToUltra", models.count { it.text("defaultReasoningEffort") == "ultra" })
                        .put("hasNextCursor", page["nextCursor"] != null && page["nextCursor"] != JsonNull))
                }
                read("extensions") {
                    gateway.get("projects/${GatewayClient.segment(project)}/extensions").data()
                }?.let { snapshot ->
                    val sections = JSONArray()
                    snapshot.array("sections").mapNotNull { it as? JsonObject }.forEach { section ->
                        sections.put(JSONObject()
                            .put("kind", section.text("kind")?.takeIf { it in KINDS } ?: "unknown")
                            .put("status", section.text("status")?.takeIf { it in STATUSES } ?: "unknown")
                            .put("reasonCode", section.text("reasonCode")?.takeIf(SAFE_CODE::matches) ?: JSONObject.NULL)
                            .put("entryCount", section.array("entries").size)
                            .put("limited", section.text("limited") == "true"))
                    }
                    report.put("extensions", sections)
                }
            }
        } catch (error: Exception) {
            failed = true
            report.put("errorCode", safeFailure(error))
        } finally {
            client?.disconnect()
            val unchanged = preferences.snapshot() == before
            report.put("preferencesUnchanged", unchanged).put("credentialSaves", credentialSaves)
            if (!unchanged || credentialSaves != 0) failed = true
            report.put("success", !failed)
            InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply {
                putString("capabilityDiagnostic", report.toString())
            })
        }
        check(!failed) { "CAPABILITY_DIAGNOSTIC_FAILED" }
    }

    private fun JsonObject.text(key: String): String? = (get(key) as? JsonPrimitive)?.content
    private fun JsonObject.array(key: String): JsonArray = get(key) as? JsonArray ?: JsonArray(emptyList())
    private fun JsonObject.data(): JsonObject = get("data") as? JsonObject ?: error("MISSING_DATA")

    private fun safeFailure(error: Exception): String = when (error) {
        is GatewayException -> error.code.takeIf(SAFE_CODE::matches) ?: "GATEWAY_FAILURE"
        is kotlinx.coroutines.TimeoutCancellationException -> "DIAGNOSTIC_TIMEOUT"
        else -> error.message?.takeIf(SAFE_CODE::matches) ?: "LOCAL_DIAGNOSTIC_FAILURE"
    }

    private companion object {
        val SAFE_CODE = Regex("^[A-Z][A-Z0-9_]{1,64}$")
        val KINDS = setOf("skills", "mcp", "apps", "plugins")
        val STATUSES = setOf("available", "unavailable")
        val CAPABILITIES = setOf("extensions.read", "thread.rename", "thread.archive", "thread.unarchive",
            "thread.delete", "account.rateLimits.read", "account.usage.read")
    }
}
