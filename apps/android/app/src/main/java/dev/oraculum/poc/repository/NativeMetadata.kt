package dev.oraculum.poc.repository

import dev.oraculum.poc.ui.TokenCountsUi
import dev.oraculum.poc.ui.TokenUsageUi
import dev.oraculum.poc.ui.TurnMetadataUi
import kotlinx.serialization.json.*

// JSON numbers are supplied by the native producer, not the client clock. Reject strings,
// negatives, overflow and nonintegral values instead of displaying plausible invented data.
internal fun JsonObject.nativeCount(key: String): Long? = (get(key) as? JsonPrimitive)
    ?.takeUnless { it.isString }?.longOrNull?.takeIf { it in 0..9_007_199_254_740_991L }
internal fun JsonObject.nativeMillis(key: String): Long? = nativeCount(key)?.takeIf { it in 1..253_402_300_799_999L }
private fun JsonObject.nativeSeconds(key: String): Long? = nativeCount(key)?.takeIf { it in 1..253_402_300_799L }?.times(1000)

internal fun tokenCounts(value: JsonObject): TokenCountsUi = TokenCountsUi(
    totalTokens = value.nativeCount("totalTokens"), inputTokens = value.nativeCount("inputTokens"),
    cachedInputTokens = value.nativeCount("cachedInputTokens"), cacheWriteInputTokens = value.nativeCount("cacheWriteInputTokens"),
    outputTokens = value.nativeCount("outputTokens"), reasoningOutputTokens = value.nativeCount("reasoningOutputTokens"),
)
internal fun tokenUsage(value: JsonObject, turnId: String? = null): TokenUsageUi? {
    val total = value.obj("total")?.let(::tokenCounts) ?: TokenCountsUi()
    val last = value.obj("last")?.let(::tokenCounts) ?: TokenCountsUi()
    val window = value.nativeCount("modelContextWindow")?.takeIf { it > 0 }
    if (total == TokenCountsUi() && last == TokenCountsUi() && window == null) return null
    return TokenUsageUi(total, last, window, turnId)
}
internal fun nativeTurnMetadata(value: JsonObject): TurnMetadataUi {
    val start = value.nativeSeconds("startedAt")
    val end = value.nativeSeconds("completedAt")
    val status = value.string("status").orEmpty()
    val duration = if (status == "inProgress") null else value.nativeCount("durationMs")
        ?: if (start != null && end != null && end >= start) end - start else null
    return TurnMetadataUi(status, start, end, duration)
}

internal fun TokenCountsUi.toJson(): JsonObject = buildJsonObject {
    totalTokens?.let { put("totalTokens", it) }; inputTokens?.let { put("inputTokens", it) }
    cachedInputTokens?.let { put("cachedInputTokens", it) }; cacheWriteInputTokens?.let { put("cacheWriteInputTokens", it) }
    outputTokens?.let { put("outputTokens", it) }; reasoningOutputTokens?.let { put("reasoningOutputTokens", it) }
}
internal fun TokenUsageUi.toJson(): JsonObject = buildJsonObject {
    put("total", total.toJson()); put("last", last.toJson())
    modelContextWindow?.let { put("modelContextWindow", it) }; turnId?.let { put("turnId", it) }
}
internal fun TurnMetadataUi.toJson(): JsonObject = buildJsonObject {
    put("status", status)
    startedAtMillis?.let { put("startedAtMillis", it) }; completedAtMillis?.let { put("completedAtMillis", it) }
    durationMs?.let { put("durationMs", it) }; usage?.let { put("usage", it.toJson()) }
}
internal fun cachedTurnMetadata(value: JsonObject): TurnMetadataUi = TurnMetadataUi(
    value.string("status").orEmpty(), value.nativeMillis("startedAtMillis"), value.nativeMillis("completedAtMillis"),
    value.nativeCount("durationMs"), value.obj("usage")?.let(::tokenCounts),
)
