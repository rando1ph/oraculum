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
 * Only authentication/health and GET capabilities/models/extensions/native defaults/account reads
 * are used. No Turn, resume, configuration, preference or credential writes are allowed. Reports
 * contain only counts, known capability/status flags, missing-value booleans and safe reason codes.
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
        var verifyPairedIdentity: (() -> Boolean)? = null
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
            verifyPairedIdentity = {
                val after = vault.load(endpoint)
                after != null && after.identity == savedCredential.identity && after.secret == savedCredential.secret
            }
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
                read("nativeDefaults") {
                    gateway.get("projects/${GatewayClient.segment(project)}/native-defaults").data()
                }?.let { data ->
                    val defaults = GatewayProtocol.nativeDefaults(data)
                    report.put("nativeDefaults", JSONObject()
                        .put("modelMissing", defaults.model == null)
                        .put("effortMissing", defaults.effort == null)
                        .put("approvalPolicyMissing", defaults.approvalPolicy == null)
                        .put("sandboxModeMissing", defaults.sandboxMode == null)
                        .put("networkAccessMissing", defaults.workspaceWriteNetworkAccess == null))
                }
                read("accountRateLimits") { gateway.get("account/rate-limits").data() }?.let { data ->
                    val account = GatewayProtocol.accountRateLimits(data)
                    val limits = listOf(account.rateLimits) + account.rateLimitsByLimitID?.values.orEmpty()
                    report.put("accountRateLimits", JSONObject()
                        .put("limited", account.limited)
                        .put("limitBucketCount", limits.size)
                        .put("windowCount", limits.sumOf { listOfNotNull(it.primary, it.secondary).size })
                        .put("primaryMissing", account.rateLimits.primary == null)
                        .put("secondaryMissing", account.rateLimits.secondary == null)
                        .put("creditsMissing", account.rateLimits.credits == null)
                        .put("creditBalanceMissing", account.rateLimits.credits?.balance == null)
                        .put("individualLimitMissing", account.rateLimits.individualLimit == null)
                        .put("ordinaryUsageAllowedMissing", account.ordinaryUsageAllowed == null)
                        .put("resetCreditsAvailableMissing", account.resetCreditsAvailable == null)
                        .put("limitsByIdMissing", account.rateLimitsByLimitID == null))
                }
                read("accountUsage") { gateway.get("account/usage").data() }?.let { data ->
                    val account = GatewayProtocol.accountUsage(data)
                    val summary = account.summary
                    report.put("accountUsage", JSONObject()
                        .put("limited", account.limited)
                        .put("dailyBucketsMissing", account.dailyUsageBuckets == null)
                        .put("dailyBucketCount", account.dailyUsageBuckets?.size ?: 0)
                        .put("summaryValueCount", listOfNotNull(summary.lifetimeTokens, summary.peakDailyTokens,
                            summary.currentStreakDays, summary.longestStreakDays, summary.longestRunningTurnSEC).size)
                        .put("lifetimeTokensMissing", summary.lifetimeTokens == null)
                        .put("peakDailyTokensMissing", summary.peakDailyTokens == null)
                        .put("currentStreakDaysMissing", summary.currentStreakDays == null)
                        .put("longestStreakDaysMissing", summary.longestStreakDays == null)
                        .put("longestRunningTurnMissing", summary.longestRunningTurnSEC == null))
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
            val identityUnchanged = runCatching { verifyPairedIdentity?.invoke() == true }.getOrDefault(false)
            report.put("preferencesUnchanged", unchanged).put("pairedIdentityUnchanged", identityUnchanged)
                .put("credentialSaves", credentialSaves)
            if (!unchanged || !identityUnchanged || credentialSaves != 0) failed = true
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
        val CAPABILITIES = setOf("extensions.read", "config.read", "thread.name.set", "thread.archive",
            "thread.unarchive", "thread.delete", "thread.fork", "thread.revert", "thread.compact", "turn.steer",
            "account.rateLimits.read", "account.usage.read")
    }
}
