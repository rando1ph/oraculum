package dev.oraculum.poc.gateway

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class NativeReadContractTest {
    private fun obj(value: String) = Json.parseToJsonElement(value).jsonObject
    private val defaults = obj("""{"source":"native-config","readAt":1700000000000,"model":null,"effort":null,"approvalPolicy":null,"sandboxMode":null,"workspaceWriteNetworkAccess":null,"origins":{}}""")
    private val bucket = obj("""{"credits":null,"individualLimit":null,"limitId":null,"limitName":null,"planType":null,"primary":{"usedPercent":35,"windowDurationMins":300,"resetsAt":1700003600},"rateLimitReachedType":null,"secondary":null,"spendControlReached":null}""")
    private fun quota(selected: JsonObject = bucket) = buildJsonObject {
        put("source", "native-rate-limits"); put("readAt", 1700000000000L); put("limited", false)
        put("ordinaryUsageAllowed", JsonNull); put("resetCreditsAvailable", JsonNull)
        put("rateLimits", selected); put("rateLimitsByLimitId", JsonNull)
    }

    @Test fun defaultNullsArePreservedAndFutureEffortsAreNotAnEnum() {
        val empty = GatewayProtocol.nativeDefaults(defaults)
        assertNull(empty.model); assertNull(empty.effort); assertNull(empty.sandboxMode)
        val ultra = GatewayProtocol.nativeDefaults(JsonObject(defaults + ("effort" to JsonPrimitive("ultra"))))
        assertEquals("ultra", ultra.effort)
        assertThrows(GatewayException::class.java) { GatewayProtocol.nativeDefaults(JsonObject(defaults - "model")) }
        assertThrows(GatewayException::class.java) {
            GatewayProtocol.nativeDefaults(JsonObject(defaults + ("effort" to JsonPrimitive("invalid effort"))))
        }
    }

    @Test fun quotaKeepsSecondsAndMissingWindowsWithoutInventingValues() {
        val result = GatewayProtocol.accountRateLimits(quota())
        assertEquals(1700003600L, result.rateLimits.primary?.resetsAt)
        assertEquals(1700000000000L, result.readAt)
        assertNull(result.rateLimits.secondary); assertNull(result.rateLimits.credits)
        val overLimit = JsonObject(bucket + ("primary" to obj("""{"usedPercent":125,"windowDurationMins":300,"resetsAt":null}""")))
        assertEquals(125L, GatewayProtocol.accountRateLimits(quota(overLimit)).rateLimits.primary?.usedPercent)
        val bad = JsonObject(bucket + ("primary" to obj("""{"usedPercent":-1,"windowDurationMins":300,"resetsAt":null}""")))
        assertThrows(GatewayException::class.java) { GatewayProtocol.accountRateLimits(quota(bad)) }
    }

    @Test fun cumulativeUsageRemainsSeparateFromQuotaAndRejectsInvalidFacts() {
        val summary = obj("""{"currentStreakDays":null,"lifetimeTokens":42,"longestRunningTurnSec":null,"longestStreakDays":null,"peakDailyTokens":null}""")
        val usage = buildJsonObject {
            put("source", "native-account-usage"); put("readAt", 1700000000000L); put("limited", false)
            put("summary", summary); put("dailyUsageBuckets", JsonNull)
        }
        assertEquals(42L, GatewayProtocol.accountUsage(usage).summary.lifetimeTokens)
        assertNull(GatewayProtocol.accountUsage(usage).dailyUsageBuckets)
        val invalid = JsonObject(usage + ("dailyUsageBuckets" to JsonArray(listOf(obj("""{"startDate":"not-a-date","tokens":4}""")))))
        assertThrows(GatewayException::class.java) { GatewayProtocol.accountUsage(invalid) }
    }

    @Test fun authenticatedResourcePathsValidateTheNewReadContracts() {
        val installation = "00000000-0000-4000-8000-000000000001"
        fun envelope(data: JsonObject) = buildJsonObject {
            put("installationId", installation); put("epoch", "00000000-0000-4000-8000-000000000002")
            put("requestId", "read"); put("data", data)
        }
        GatewayProtocol.resource("projects/p/native-defaults", envelope(defaults), installation)
        GatewayProtocol.resource("account/rate-limits", envelope(quota()), installation)
        assertThrows(GatewayException::class.java) {
            GatewayProtocol.resource("projects/p/native-defaults", envelope(JsonObject(defaults - "source")), installation)
        }
        assertThrows(GatewayException::class.java) {
            GatewayProtocol.resource("account/rate-limits", envelope(JsonObject(quota() - "limited")), installation)
        }
    }
}
