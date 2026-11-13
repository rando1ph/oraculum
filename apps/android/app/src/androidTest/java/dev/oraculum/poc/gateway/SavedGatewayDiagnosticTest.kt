package dev.oraculum.poc.gateway

import android.database.sqlite.SQLiteDatabase
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.oraculum.poc.repository.EventDecision
import dev.oraculum.poc.repository.EventPosition
import dev.oraculum.poc.repository.acceptEvent
import dev.oraculum.poc.storage.CacheScope
import dev.oraculum.poc.storage.ClientPreferences
import dev.oraculum.poc.storage.StateDatabase
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest

/**
 * Explicitly opted-in diagnosis of the existing installation. No Activity/ViewModel is launched:
 * there is no pairing, endpoint change, operation settlement, resume or business write.
 * Run only this class with -e oraculumReadOnlyDiagnostic true. Reports stay in app-private files.
 */
@RunWith(AndroidJUnit4::class)
class SavedGatewayDiagnosticTest {
    @Test fun inspectSavedGatewayWithoutBusinessWrites() = runBlocking {
        assumeTrue("Read-only Gateway diagnostic requires explicit opt-in",
            InstrumentationRegistry.getArguments().getString("oraculumReadOnlyDiagnostic") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.filesDir, "gateway-diagnostic").apply { check(isDirectory || mkdirs()) }
        val report = JSONObject().put("businessWrites", 0).put("credentialSaves", 0)
        val stages = JSONArray()
        report.put("stages", stages)
        val raw = JSONObject()
        var client: GatewayClient? = null
        var socket: EventConnectionHandle? = null
        val socketLock = Any()
        var position: EventPosition? = null
        var eventCount = 0
        var eventFailure: String? = null
        var eventContinuity = true
        var closingSocket = false
        var lastFailure: String? = null

        suspend fun <T> stage(name: String, work: suspend () -> T): T {
            val started = SystemClock.elapsedRealtime()
            val entry = JSONObject().put("name", name)
            stages.put(entry)
            try {
                return withTimeout(45_000) { work() }.also { entry.put("success", true) }
            } catch (error: Exception) {
                val code = safeFailure(error)
                entry.put("success", false).put("errorCode", code)
                if (error is GatewayException) error.httpStatus?.let { entry.put("httpStatus", it) }
                throw DiagnosticFailure(code)
            } finally { entry.put("elapsedMs", SystemClock.elapsedRealtime() - started) }
        }

        try {
            val saved = stage("savedSelection") { ClientPreferences(context).snapshot() }
            check(saved.endpoint.isNotBlank()) { "SAVED_ENDPOINT_REQUIRED" }
            val endpoint = GatewayEndpoint.parse(saved.endpoint)
            val vault = CredentialVault(context)
            val credential = stage("savedPairedIdentity") { vault.load(endpoint) }
            check(credential?.identity?.paired == true) { "SAVED_PAIRED_IDENTITY_REQUIRED" }
            val identity = checkNotNull(credential).identity
            val scope = CacheScope(identity.endpoint, identity.installationId, identity.deviceId).key
            check(saved.scopeKey == scope) { "SAVED_SCOPE_MISMATCH" }
            report.put("savedPairedIdentity", true).put("savedScopeMatches", saved.scopeKey == scope)
                .put("hasSavedProject", saved.projectId != null).put("hasSavedThread", saved.threadId != null)
            val before = stage("localStateBefore") { readLocalState(context.getDatabasePath(StateDatabase.FILE_NAME), scope) }
            report.put("localStateBefore", before.summary)
            // Fail closed if any future connect path attempts to alter the persistent identity.
            val readonlyVault = object : CredentialStore {
                override fun load(requested: GatewayEndpoint): DeviceCredential? {
                    check(requested == endpoint) { "ENDPOINT_CHANGED" }
                    return vault.load(requested)
                }
                override fun save(credential: DeviceCredential) { throw DiagnosticFailure("CREDENTIAL_SAVE_PROHIBITED") }
            }
            val gateway = GatewayClient(readonlyVault, OkHttpClient())
            client = gateway
            val health = stage("health") { gateway.health(endpoint) }
            report.put("health", JSONObject().put("protocolMajor", health.number("protocolMajor")))
            val capabilities = stage("authenticateAndCapabilities") { gateway.connect(endpoint) }
            val epoch = capabilities.text("epoch").orEmpty()
            report.put("connection", JSONObject().put("epochFingerprint", fingerprint(epoch))
                .put("nativeConnectionState", allowed(capabilities.objectValue("codex")?.text("connectionState"), setOf("connected", "disconnected"))))
            val connection = CompletableDeferred<Unit>()
            socket = stage("wssConnection") {
                gateway.openEvents(null, object : GatewayEventListener {
                    override fun onConnection(message: JsonObject) {
                        synchronized(socketLock) {
                            if (message.text("epoch") != epoch || message.text("installationId") != identity.installationId) {
                                eventContinuity = false
                                connection.completeExceptionally(DiagnosticFailure("EVENT_IDENTITY_MISMATCH"))
                            } else {
                                position = EventPosition(identity.installationId, epoch, message.number("headSeq") ?: 0)
                                report.put("wssInitialSeq", position!!.sequence)
                                connection.complete(Unit)
                            }
                        }
                    }
                    override fun onEvent(event: JsonObject) {
                        synchronized(socketLock) {
                            val current = position ?: return
                            val decision = acceptEvent(current, event.text("installationId").orEmpty(), event.text("epoch").orEmpty(),
                                event.number("seq") ?: -1, event.text("kind").orEmpty(), event.text("impact"))
                            if (decision == EventDecision.RESET) eventContinuity = false
                            if (decision != EventDecision.DUPLICATE && decision != EventDecision.RESET) {
                                position = current.copy(sequence = event.number("seq") ?: current.sequence)
                                eventCount++
                            }
                        }
                    }
                    override fun onFailure(error: GatewayException) {
                        synchronized(socketLock) { eventFailure = safeFailure(error) }
                        connection.completeExceptionally(DiagnosticFailure(safeFailure(error)))
                    }
                    override fun onClosed() {
                        synchronized(socketLock) {
                            if (!closingSocket) eventFailure = "EVENT_CONNECTION_CLOSED"
                        }
                    }
                }).also { connection.await() }
            }
            val projects = stage("projects") { gateway.get("projects").objectValue("data") ?: throw DiagnosticFailure("MISSING_DATA") }
            report.put("projectCount", projects["projects"]?.jsonArray?.size ?: 0)
            val project = saved.projectId
            val thread = saved.threadId
            if (project != null) {
                val threads = stage("threads") { gateway.get("projects/${GatewayClient.segment(project)}/threads", mapOf("limit" to "20", "archived" to "false")) }
                val data = threads.objectValue("data") ?: throw DiagnosticFailure("MISSING_DATA")
                report.put("threadCountOnFirstPage", data["threads"]?.jsonArray?.size ?: 0)
            }
            if (project != null && thread != null) {
                val snapshots = JSONArray()
                report.put("snapshots", snapshots)
                repeat(2) { index ->
                    val envelope = stage("snapshot${index + 1}") {
                        gateway.post("threads/${GatewayClient.segment(thread)}/snapshot", buildJsonObject { put("projectId", project) })
                    }
                    raw.put("snapshot${index + 1}", JSONObject(envelope.toString()))
                    val data = envelope.objectValue("data") ?: throw DiagnosticFailure("MISSING_DATA")
                    val turns = JSONArray()
                    data.objectValue("history")?.get("items")?.jsonArray?.forEach { item ->
                        val turn = item as? JsonObject ?: return@forEach
                        val message = turn.objectValue("error")?.text("message")
                        turns.put(JSONObject().put("status", allowed(turn.text("status"), TURN_STATUSES))
                            .put("itemCount", turn["items"]?.jsonArray?.size ?: 0)
                            .put("hasNativeError", !message.isNullOrBlank()).put("nativeErrorClass", classifyNativeError(message)))
                    }
                    val seq = synchronized(socketLock) { position?.sequence }
                    snapshots.put(JSONObject().put("synchronization", allowed(data.text("synchronization"), setOf("current", "synchronizing", "stale")))
                        .put("threadStatus", allowed(data.objectValue("thread")?.text("status"), THREAD_STATUSES))
                        .put("observedStartSeq", data.number("observedStartSeq")).put("observedEndSeq", data.number("observedEndSeq"))
                        .put("clientObservedSeq", seq).put("epochMatches", data.text("epoch") == epoch)
                        .put("turns", turns).put("operationStatuses", counts(data["operations"]?.jsonArray?.mapNotNull { (it as? JsonObject)?.text("status") }.orEmpty(), OPERATION_STATUSES)))
                    if (index == 0) delay(1_000)
                }
            }
            val receiptResults = JSONArray()
            report.put("originalOperationReceipts", receiptResults).put("receiptReadLimit", RECEIPT_LIMIT)
                .put("receiptReadsLimited", before.operationCount > before.operationIds.size)
            for (operationId in before.operationIds) {
                try {
                    val envelope = stage("originalOperationReceipt") { gateway.get("operations/${GatewayClient.segment(operationId)}") }
                    val receipt = envelope.objectValue("data") ?: throw DiagnosticFailure("MISSING_DATA")
                    receiptResults.put(JSONObject().put("status", allowed(receipt.text("status"), OPERATION_STATUSES))
                        .put("delivery", allowed(receipt.text("delivery"), setOf("sent", "notSent", "unknown"))))
                } catch (error: DiagnosticFailure) {
                    receiptResults.put(JSONObject().put("errorCode", error.code))
                    // A missing original receipt is diagnostic information, never permission to resend.
                    if (error.code != "NOT_FOUND" && error.code != "OPERATION_NOT_FOUND") throw error
                }
            }
            report.put("wssPingQueued", socket?.ping() == true)
            delay(2_000)
            val after = stage("localStateAfter") { readLocalState(context.getDatabasePath(StateDatabase.FILE_NAME), scope) }
            report.put("localStateAfter", after.summary).put("localStateUnchanged", before.fingerprint == after.fingerprint)
            check(before.fingerprint == after.fingerprint) { "LOCAL_STATE_CHANGED" }
        } catch (error: Exception) {
            lastFailure = safeFailure(error)
            report.put("errorCode", lastFailure)
        } finally {
            synchronized(socketLock) {
                report.put("wssEventCount", eventCount).put("wssLastSeq", position?.sequence)
                    .put("wssSequenceContinuous", eventContinuity).put("wssFailureCode", eventFailure)
                if (eventFailure != null && lastFailure == null) lastFailure = eventFailure
                closingSocket = true
            }
            socket?.close()
            client?.disconnect()
            report.put("success", lastFailure == null)
            privateWrite(File(directory, "report.json"), report.toString(2))
            privateWrite(File(directory, "report-raw.json"), raw.toString(2))
        }
        if (lastFailure != null) throw AssertionError("Saved Gateway read-only diagnostic failed: $lastFailure; inspect app-private gateway-diagnostic/report.json")
    }

    private data class LocalObservation(val summary: JSONObject, val operationIds: List<String>, val operationCount: Int, val fingerprint: String)

    private fun readLocalState(file: File, scope: String): LocalObservation {
        check(file.isFile) { "LOCAL_STATE_REQUIRED" }
        return SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY).use { database ->
            val operationIds = mutableListOf<String>()
            val statuses = mutableListOf<String>()
            val evidence = StringBuilder()
            var total = 0
            // Original unknown identities first; no generated operation ID and no receipt updates.
            database.rawQuery("SELECT operationId,status,delivery,updatedAt FROM operations WHERE scopeKey=? ORDER BY CASE WHEN status='unknown' THEN 0 ELSE 1 END,createdAt DESC,operationId", arrayOf(scope)).use { rows ->
                while (rows.moveToNext()) {
                    total++
                    statuses += rows.getString(1)
                    if (operationIds.size < RECEIPT_LIMIT) operationIds += rows.getString(0)
                    repeat(rows.columnCount) { column -> evidence.append(rows.getString(column)).append('\u0000') }
                }
            }
            var drafts = 0
            database.rawQuery("SELECT projectId,threadId,text,updatedAt FROM drafts WHERE scopeKey=? ORDER BY projectId,threadId", arrayOf(scope)).use { rows ->
                while (rows.moveToNext()) {
                    drafts++
                    repeat(rows.columnCount) { column -> evidence.append(rows.getString(column)).append('\u0000') }
                }
            }
            LocalObservation(JSONObject().put("operationCount", total).put("operationStatuses", counts(statuses, OPERATION_STATUSES))
                .put("draftCount", drafts), operationIds, total, fingerprint(evidence.toString()))
        }
    }

    private fun safeFailure(error: Exception): String = when (error) {
        is DiagnosticFailure -> error.code
        is GatewayException -> error.code.takeIf { it.matches(Regex("^[A-Z][A-Z0-9_]{1,64}$")) } ?: "GATEWAY_FAILURE"
        is kotlinx.coroutines.TimeoutCancellationException -> "DIAGNOSTIC_TIMEOUT"
        else -> error.message?.takeIf { it.matches(Regex("^[A-Z][A-Z0-9_]{1,64}$")) } ?: "LOCAL_DIAGNOSTIC_FAILURE"
    }

    private class DiagnosticFailure(val code: String) : Exception()

    private fun privateWrite(file: File, content: String) {
        file.writeText(content)
        check(file.setReadable(false, false) && file.setReadable(true, true))
        check(file.setWritable(false, false) && file.setWritable(true, true))
    }

    private companion object {
        const val RECEIPT_LIMIT = 16
        val TURN_STATUSES = setOf("inProgress", "completed", "interrupted", "failed")
        val THREAD_STATUSES = setOf("notLoaded", "idle", "systemError", "active", "unknown")
        val OPERATION_STATUSES = setOf("accepted", "rejected", "unknown")
        fun JsonObject.text(key: String): String? = (get(key) as? JsonPrimitive)?.content
        fun JsonObject.number(key: String): Long? = text(key)?.toLongOrNull()
        fun JsonObject.objectValue(key: String): JsonObject? = get(key) as? JsonObject
        fun allowed(value: String?, values: Set<String>): String = value?.takeIf { it in values } ?: "unknown"
        fun counts(values: List<String>, allowedValues: Set<String>): JSONObject = JSONObject().apply {
            values.groupingBy { allowed(it, allowedValues) }.eachCount().forEach { (status, count) -> put(status, count) }
        }
        fun fingerprint(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
        fun classifyNativeError(message: String?): String = when {
            message.isNullOrBlank() -> "none"
            message.contains("workspace routing discovery", ignoreCase = true) && message.contains("timed out", ignoreCase = true) -> "WORKSPACE_ROUTING_DISCOVERY_TIMEOUT"
            message.contains("workspace routing discovery", ignoreCase = true) -> "WORKSPACE_ROUTING_DISCOVERY_FAILED"
            else -> "OTHER_NATIVE_ERROR"
        }
    }
}
