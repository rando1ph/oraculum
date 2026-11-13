package dev.oraculum.poc.e2e

import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.graphics.Bitmap
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import dev.oraculum.poc.MainActivity
import dev.oraculum.poc.PocViewModel
import dev.oraculum.poc.gateway.*
import dev.oraculum.poc.storage.ClientPreferences
import dev.oraculum.poc.ui.PocUiState
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Explicit real-device regression with an already paired Gateway and existing TEST project.
 * No endpoint, pairing, resume, approval, cleanup or retry writes are permitted here. Durable
 * create/send guards intentionally make a second invocation read-only and fail closed: inspect
 * the original native receipt instead of deleting these guards or sending another test message.
 */
class SavedGatewayRecoveryJourneyTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val privateDirectory get() = File(context.noBackupFilesDir, "saved-gateway-recovery").apply { mkdirs() }
    private val outputDirectory get() = File(context.filesDir, "gateway-recovery-evidence").apply { mkdirs() }
    private val marker = "ORACULUM_GATEWAY_DEVICE_OK"
    private val prompt = "Reply exactly ORACULUM_GATEWAY_DEVICE_OK. Do not use tools, read files, or modify anything."

    @Test fun existingIdentitySingleTurnRefreshSwitchAndReconnect() {
        assumeTrue("Explicit real Gateway write acceptance opt-in required",
            InstrumentationRegistry.getArguments().getString("oraculumGatewayE2e") == "true")
        assertTrue("Explicit TEST project label is required",
            InstrumentationRegistry.getArguments().getString("oraculumTestProject") == "TEST")
        val createIntent = File(privateDirectory, "create-intent.json")
        val sendIntent = File(privateDirectory, "send-intent.json")
        assertFalse("Prior create intent may have executed; inspect its original receipt, never create again", createIntent.exists())
        assertFalse("Prior send intent may have executed; inspect its original receipt, never resend", sendIntent.exists())
        val preferences = runBlocking { ClientPreferences(context).snapshot() }
        val project = checkNotNull(preferences.projectId) { "Existing selected TEST project required" }
        val originalThread = checkNotNull(preferences.threadId) { "Existing thread required for safe readback" }
        val scope = checkNotNull(preferences.scopeKey) { "Existing saved identity scope required" }
        val endpoint = GatewayEndpoint.parse(preferences.endpoint)
        val vault = CredentialVault(context)
        val identity = checkNotNull(vault.load(endpoint)) { "Existing paired identity required" }
        assertTrue("Never pair during a regression", identity.identity.paired)
        val originalDrafts = rows("drafts", "scopeKey || '|' || projectId || '|' || threadId")
        val originalOperations = rows("operations", "scopeKey || '|' || operationId")
        assertFalse("Unknown operations require original receipt reconciliation before any new write",
            operationValues().any { it.optString("status") == "unknown" })
        val report = JSONObject().put("passed", false).put("existingIdentityReused", true)
            .put("endpointUnchanged", true).put("businessSends", 0).put("nativeCreates", 0)
        val events = Collections.synchronizedList(mutableListOf<JsonObject>())
        val connection = AtomicReference<JsonObject?>()
        val selectedTestThread = AtomicReference<String?>()
        val continuous = AtomicBoolean(true)
        val lastSeq = AtomicLong(-1)
        val transportFailure = AtomicReference<String?>()
        val client = GatewayClient(object : CredentialStore {
            override fun load(endpoint: GatewayEndpoint): DeviceCredential? = vault.load(endpoint)
            override fun save(credential: DeviceCredential) = error("Identity writes are prohibited in this test")
        }, OkHttpClient())
        var handle: EventConnectionHandle? = null
        var activity: MainActivity? = null
        var phase = "read-only-preflight"
        fun progress() {
            File(outputDirectory, "progress.json").writeText(report.put("phase", phase)
                .put("observedAt", System.currentTimeMillis()).toString(2))
        }
        try {
            runBlocking {
                client.health(endpoint)
                client.connect(endpoint)
                val original = snapshot(client, project, originalThread)
                assertQuiescent(original)
                original["operations"]?.jsonArray?.forEach { value ->
                    assertTrue("Gateway reports an unresolved original operation", value.jsonObject.text("status") != "unknown")
                }
                // Query every original operation by its existing identity, without changing local rows.
                operationValues().filter { it.optString("scopeKey") == scope }.forEach { operation ->
                    val receipt = resource(client.get("operations/${GatewayEndpoint.segment(operation.getString("operationId"))}"))
                    assertTrue("Original operation must have a confirmed Gateway receipt", receipt.text("status") in setOf("accepted", "rejected"))
                }
                handle = client.openEvents(null, object : GatewayEventListener {
                    override fun onConnection(message: JsonObject) {
                        connection.set(message)
                        lastSeq.set(message["headSeq"]?.jsonPrimitive?.longOrNull ?: -1)
                    }
                    override fun onEvent(event: JsonObject) {
                        val seq = event["seq"]?.jsonPrimitive?.longOrNull ?: -1
                        val previous = lastSeq.getAndSet(seq)
                        if (previous < 0 || seq != previous + 1) continuous.set(false)
                        if (event["scope"]?.jsonObject?.text("threadId") == selectedTestThread.get()) events.add(event)
                    }
                    override fun onFailure(error: GatewayException) { transportFailure.set(error.code) }
                })
            }
            await("Read-only WSS observer connected") { connection.get() != null }
            assertNull("Read-only WSS observer must remain healthy", transportFailure.get())
            instrumentation.runOnMainSync {
                context.startActivity(Intent(context, MainActivity::class.java).setAction(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_LAUNCHER).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
            }
            activity = resumedActivity()
            val activeModel = activity.model
            awaitState(activeModel, "Original paired app connected") {
                it.online && it.paired && !it.busy && it.selectedProjectId == project && it.selectedThreadId == originalThread
            }
            assertTrue("Never change the saved endpoint", activeModel.state.value.endpoint == preferences.endpoint)
            assertTrue("Only the selected dedicated TEST project may be used", activeModel.state.value.projects.any { it.id == project && it.label == "TEST" })
            assertFalse("Do not create around an active native Turn", activeModel.state.value.canStop)
            assertTrue("Unknown write barrier must remain clear", activeModel.state.value.unresolvedOperations.isEmpty())
            assertTrue("Pending native requests must be handled by the user first", activeModel.state.value.interactions.none { it.status == "pending" })
            val selectedModel = activeModel.state.value.models.firstOrNull { it.id == "gpt-6.1-sol" }
                ?: error("Required advertised controlled-test model is unavailable")
            instrumentation.runOnMainSync {
                activeModel.selectModel(selectedModel.id)
                if ("low" in selectedModel.efforts) activeModel.selectEffort("low")
                activeModel.selectPermission("read-only", false)
            }
            assertTrue("Native create must be enabled by the existing safety state", activeModel.state.value.canCreateThread)
            durableIntent(createIntent, JSONObject().put("projectId", project).put("requestedAt", System.currentTimeMillis()))
            phase = "create-intent-durable"
            progress()
            action { activeModel.createThread() }
            awaitState(activeModel, "One explicit dedicated native thread created") {
                !it.busy && it.selectedThreadId != null && it.selectedThreadId != originalThread
            }
            val thread = checkNotNull(activeModel.state.value.selectedThreadId)
            selectedTestThread.set(thread)
            durableIntent(File(privateDirectory, "checkpoint.json"), JSONObject().put("projectId", project)
                .put("threadId", thread).put("originalThreadId", originalThread))
            report.put("nativeCreates", 1)
            await("Dedicated file scope is available") {
                activeModel.files.state.value.let { it.threadId == thread && !it.busy }
            }
            assertTrue("Never claim unrelated attachments", activeModel.files.state.value.attachments.isEmpty())
            instrumentation.runOnMainSync {
                activeModel.selectModel(selectedModel.id)
                if ("low" in selectedModel.efforts) activeModel.selectEffort("low")
                activeModel.draftChange(prompt)
            }
            awaitState(activeModel, "Dedicated explicit draft is writable") {
                it.draft == prompt && it.canSend && !it.busy && !it.canStop && it.unresolvedOperations.isEmpty()
            }
            durableIntent(sendIntent, JSONObject().put("threadId", thread).put("requestedAt", System.currentTimeMillis()).put("marker", marker))
            phase = "send-intent-durable"
            progress()
            action { activeModel.send() }
            report.put("businessSends", 1)
            awaitState(activeModel, "Real native response reaches completed state", 240_000) {
                !it.busy && !it.canStop && it.messages.any { message ->
                    message.role == "assistant" && message.text.contains(marker) && message.turn?.status == "completed"
                }
            }
            val answer = activeModel.state.value.messages.last { it.role == "assistant" && it.text.contains(marker) }
            val turn = answer.turnId
            await("Observer receives exact native completion", 15_000) { synchronized(events) { events.any { event ->
                event.text("kind") == "native.state" && event["payload"]?.jsonObject?.text("method") == "turn/completed" &&
                    event["payload"]?.jsonObject?.get("data")?.jsonObject?.get("turn")?.jsonObject?.text("id") == turn
            } } }
            val observed = synchronized(events) { events.toList() }
            val deltas = observed.count { event -> event.text("kind") == "item.delta" && event["scope"]?.jsonObject?.text("turnId") == turn }
            assertTrue("Require actual WSS stream deltas for this exact new Turn", deltas > 0)
            assertTrue("Require actual WSS native completion for this exact new Turn", observed.any { event ->
                event.text("kind") == "native.state" && event["payload"]?.jsonObject?.text("method") == "turn/completed" &&
                    event["payload"]?.jsonObject?.get("data")?.jsonObject?.get("turn")?.jsonObject?.text("id") == turn
            })
            assertTrue("WSS event sequence must stay continuous", continuous.get())
            assertNull("WSS observer must not fail", transportFailure.get())
            phase = "completed-native-turn"
            verifyCompleted(client, project, thread, turn)
            screenshot("02-completed.png")
            action { activeModel.refresh() }
            assertRestored(activeModel, thread, turn)
            verifyAndroidSnapshot(scope, project, thread, turn)
            report.put("refreshPassed", true)
            action { activeModel.selectThread(originalThread) }
            awaitState(activeModel, "Original thread selected without resume") { !it.busy && it.selectedThreadId == originalThread }
            assertRowsPreserved("drafts", "scopeKey || '|' || projectId || '|' || threadId", originalDrafts)
            action { activeModel.selectThread(thread) }
            assertRestored(activeModel, thread, turn)
            report.put("threadSwitchPassed", true)
            instrumentation.runOnMainSync { activeModel.disconnect() }
            awaitState(activeModel, "Explicit disconnect preserves readable history") { !it.online && !it.canSend && it.messages.any { m -> m.turnId == turn && m.text.contains(marker) } }
            screenshot("03-offline-readonly.png")
            action { activeModel.reconnect() }
            assertRestored(activeModel, thread, turn)
            verifyAndroidSnapshot(scope, project, thread, turn)
            verifyCompleted(client, project, thread, turn)
            assertTrue("Saved Endpoint must still be exact", runBlocking { ClientPreferences(context).snapshot().endpoint } == preferences.endpoint)
            assertTrue("Original paired identity must remain exact", vault.load(endpoint)?.identity == identity.identity)
            assertRowsPreserved("drafts", "scopeKey || '|' || projectId || '|' || threadId", originalDrafts)
            assertRowsPreserved("operations", "scopeKey || '|' || operationId", originalOperations)
            val finalOperations = operationValues()
            assertEquals("Exactly one create and one send; refresh/switch/reconnect must add no writes", originalOperations.size + 2, finalOperations.size)
            assertFalse("No new unknown operations", finalOperations.any { it.optString("status") == "unknown" })
            val dedicated = finalOperations.filter { it.optString("threadId") == thread || it.optString("nativeThreadId") == thread }
            assertEquals("Exactly one dedicated thread.start", 1, dedicated.count { it.optString("kind") == "thread.start" && it.optString("status") == "accepted" })
            assertEquals("Exactly one dedicated turn.start", 1, dedicated.count { it.optString("kind") == "turn.start" && it.optString("status") == "accepted" })
            report.put("reconnectPassed", true).put("originalDraftsPreserved", true).put("originalOperationsPreserved", true)
                .put("identityUnchanged", true).put("deltaCount", deltas).put("eventSequenceContinuous", true)
                .put("nativeStatus", "idle").put("nativeTurnStatus", "completed").put("snapshotSynchronization", "current")
                .put("build", JSONObject(context.assets.open("oraculum-build.json").bufferedReader().use { it.readText() }))
                .put("passed", true)
            phase = "passed"
            screenshot("04-reconnected.png")
        } finally {
            progress()
            File(outputDirectory, "report.json").writeText(report.toString(2))
            handle?.close()
            client.disconnect()
            // Finish only the Activity started/selected by this test; all app data remains intact.
            val owned = activity
            if (owned != null) instrumentation.runOnMainSync { owned.finish() }
        }
    }

    private fun action(start: () -> Job) {
        var job: Job? = null
        instrumentation.runOnMainSync { job = start() }
        runBlocking { withTimeout(180_000) { checkNotNull(job).join() } }
    }
    private fun await(description: String, timeout: Long = 120_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(50)
        }
        fail(description)
    }
    private fun awaitState(model: PocViewModel, description: String, timeout: Long = 120_000, condition: (PocUiState) -> Boolean) =
        await(description, timeout) { condition(model.state.value) }
    private fun assertRestored(model: PocViewModel, thread: String, turn: String) {
        awaitState(model, "Exact completed native Turn restored") { state -> state.online && !state.busy && !state.canStop &&
            state.selectedThreadId == thread && state.unresolvedOperations.isEmpty() && state.error == null &&
            state.messages.any { it.turnId == turn && it.role == "assistant" && it.text.contains(marker) && it.turn?.status == "completed" } }
    }
    private fun resumedActivity(): MainActivity {
        var activity: MainActivity? = null
        await("MainActivity resumed") {
            instrumentation.runOnMainSync {
                activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filterIsInstance<MainActivity>().firstOrNull()
            }
            activity != null
        }
        return checkNotNull(activity)
    }
    private fun durableIntent(file: File, value: JSONObject) {
        assertTrue("Durable guard already exists; never replay this test write", file.createNewFile())
        FileOutputStream(file).use { it.write(value.toString().toByteArray()); it.fd.sync() }
    }
    private fun screenshot(name: String) {
        instrumentation.waitForIdleSync()
        val image = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        try { File(outputDirectory, name).outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) } }
        finally { image.recycle() }
    }
    private fun JsonObject.text(key: String) = (get(key) as? JsonPrimitive)?.contentOrNull
    private fun resource(value: JsonObject) = checkNotNull(value["data"] as? JsonObject)
    private suspend fun snapshot(client: GatewayClient, project: String, thread: String): JsonObject = resource(client.post(
        "threads/${GatewayEndpoint.segment(thread)}/snapshot", buildJsonObject { put("projectId", project) }))
    private fun assertQuiescent(value: JsonObject) {
        assertTrue("Original Snapshot must be current before test writes", value.text("synchronization") == "current")
        assertTrue("Original thread must have no native active Turn", value["thread"]?.jsonObject?.text("status") in setOf("idle", "notLoaded", "systemError"))
        assertTrue("Original history must have no inProgress Turn", value["history"]?.jsonObject?.get("items")?.jsonArray?.none { it.jsonObject.text("status") == "inProgress" } == true)
        assertTrue("No native pending approval may be bypassed", value["interactions"]?.jsonArray?.none { it.jsonObject.text("status") == "pending" } != false)
    }
    private fun verifyCompleted(client: GatewayClient, project: String, thread: String, turn: String) = runBlocking {
        val value = snapshot(client, project, thread)
        assertQuiescent(value)
        assertTrue("Completed dedicated thread must be natively idle", value["thread"]?.jsonObject?.text("status") == "idle")
        val native = value["history"]?.jsonObject?.get("items")?.jsonArray?.map { it.jsonObject }?.single { it.text("id") == turn }
        assertTrue("Exact native Turn must be completed", native?.text("status") == "completed")
        assertTrue("Native reply must contain the fixed marker", native.toString().contains(marker))
        assertTrue("No tool execution is allowed in the controlled message", native?.get("items")?.jsonArray?.all {
            it.jsonObject.text("type") in setOf("userMessage", "agentMessage", "reasoning") } == true)
    }
    private fun verifyAndroidSnapshot(scope: String, project: String, thread: String, turn: String) {
        SQLiteDatabase.openDatabase(context.getDatabasePath("oraculum-v2-cache.db").path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
            db.rawQuery("SELECT payloadJson, complete FROM projections WHERE scopeKey=? AND projectId=? AND kind='snapshot' AND resourceId=?", arrayOf(scope, project, thread)).use { cursor ->
                assertTrue("Android must persist a verified Snapshot", cursor.moveToFirst())
                assertEquals("Android Snapshot must be current", 1, cursor.getInt(1))
                val value = Json.parseToJsonElement(cursor.getString(0)).jsonObject
                assertQuiescent(value)
                assertTrue("Android Snapshot must retain exact completed native Turn", value["history"]?.jsonObject?.get("items")?.jsonArray?.any {
                    it.jsonObject.text("id") == turn && it.jsonObject.text("status") == "completed" } == true)
            }
        }
    }
    private fun rows(table: String, key: String): Map<String, String> {
        check(table in setOf("drafts", "operations"))
        val result = linkedMapOf<String, String>()
        SQLiteDatabase.openDatabase(context.getDatabasePath("oraculum-v2-state.db").path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
            db.rawQuery("SELECT $key AS rowKey, * FROM $table", null).use { cursor ->
                while (cursor.moveToNext()) {
                    // A confirmed receipt read legitimately refreshes local receiptJson/updatedAt.
                    // Preserve every original operation identity, scope, outcome and native binding.
                    val protectedColumns = (1 until cursor.columnCount).filter { index ->
                        table != "operations" || cursor.getColumnName(index) !in setOf("receiptJson", "updatedAt")
                    }
                    val value = protectedColumns.joinToString("\u0000") { index ->
                        if (cursor.isNull(index)) "<null>" else cursor.getString(index)
                    }
                    result[cursor.getString(0)] = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
                }
            }
        }
        return result
    }
    private fun assertRowsPreserved(table: String, key: String, original: Map<String, String>) {
        val current = rows(table, key)
        assertTrue("Original $table rows must remain unchanged", original.all { (id, hash) -> current[id] == hash })
    }
    private fun operationValues(): List<JSONObject> {
        val values = mutableListOf<JSONObject>()
        SQLiteDatabase.openDatabase(context.getDatabasePath("oraculum-v2-state.db").path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
            db.rawQuery("SELECT scopeKey, operationId, kind, status, threadId, nativeThreadId FROM operations", null).use { cursor ->
                while (cursor.moveToNext()) values.add(JSONObject().apply {
                    cursor.columnNames.forEachIndexed { index, key -> put(key, if (cursor.isNull(index)) JSONObject.NULL else cursor.getString(index)) }
                })
            }
        }
        return values
    }
}
