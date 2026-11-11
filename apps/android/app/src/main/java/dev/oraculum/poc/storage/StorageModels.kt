package dev.oraculum.poc.storage

import androidx.room.Entity
import androidx.room.Index
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive

/** No data is shared between endpoints, Gateway installations, or paired devices. */
data class CacheScope(val endpoint: String, val installationId: String, val deviceId: String) {
    val key: String
        get() = JsonArray(listOf(endpoint, installationId, deviceId).map(::JsonPrimitive)).toString()
}

/** A replaceable Gateway projection. Native item/turn IDs and cursors stay in its JSON payload. */
@Entity(
    tableName = "projections",
    primaryKeys = ["scopeKey", "projectId", "kind", "resourceId", "pageKey"],
    indices = [Index(value = ["scopeKey", "projectId", "threadId"]), Index(value = ["loadedAt"])],
)
data class CachedProjection(
    val scopeKey: String,
    val kind: String,
    val resourceId: String = "",
    val pageKey: String = "",
    val payloadJson: String,
    val epoch: String,
    val revision: String? = null,
    val projectId: String = "",
    val threadId: String? = null,
    val source: String = "gateway",
    val complete: Boolean = false,
    val loadedAt: Long = System.currentTimeMillis(),
)

@Entity(tableName = "event_cursors", primaryKeys = ["scopeKey"])
data class StoredEventCursor(val scopeKey: String, val epoch: String, val sequence: Long)

@Entity(tableName = "drafts", primaryKeys = ["scopeKey", "projectId", "threadId"])
data class DraftRecord(
    val scopeKey: String,
    val projectId: String,
    val threadId: String,
    val text: String,
    val updatedAt: Long = System.currentTimeMillis(),
)

@Entity(tableName = "read_anchors", primaryKeys = ["scopeKey", "projectId", "threadId"])
data class ReadAnchorRecord(
    val scopeKey: String,
    val projectId: String,
    val threadId: String,
    val itemId: String?,
    val offset: Int = 0,
    val followBottom: Boolean = true,
    val updatedAt: Long = System.currentTimeMillis(),
)

/**
 * The initial unknown row must commit before HTTP dispatch. A crash at any point leaves a
 * reconciliation record, never a replay queue. No request body or authentication secret belongs here.
 */
@Entity(
    tableName = "operations",
    primaryKeys = ["scopeKey", "operationId"],
    indices = [Index(value = ["scopeKey", "status"]), Index(value = ["scopeKey", "projectId", "threadId"])],
)
data class OperationRecord(
    val scopeKey: String,
    val operationId: String,
    val projectId: String,
    val threadId: String?,
    val kind: String,
    val status: String = "unknown",
    val delivery: String = "unknown",
    val nativeThreadId: String? = null,
    val nativeTurnId: String? = null,
    val receiptJson: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
    val updatedAt: Long = createdAt,
)
