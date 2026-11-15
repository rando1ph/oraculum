package dev.oraculum.poc.e2e

import android.database.sqlite.SQLiteDatabase
import android.graphics.Bitmap
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import dev.oraculum.poc.MainActivity
import dev.oraculum.poc.storage.CacheDatabase
import dev.oraculum.poc.storage.StateDatabase
import dev.oraculum.poc.ui.PocUiState
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** Opt-in physical-device journey. Only a separately installed, disposable test application is eligible. */
class CacheSyncJourneyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val model get() = compose.activity.model
    private val state get() = model.state.value
    private val output get() = File(context.filesDir, "cache-sync-evidence").apply { mkdirs() }
    private lateinit var config: JSONObject
    private var stage = "preflight"
    private val report = JSONObject().put("passed", false)
    private val http = OkHttpClient.Builder().retryOnConnectionFailure(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(180, TimeUnit.SECONDS)
        .callTimeout(240, TimeUnit.SECONDS).build()

    @Test fun retainedWindowsReconnectAndExternalNativeChanges() {
        val input = File(context.noBackupFilesDir, "cache-sync-e2e.json")
        assumeTrue("Explicit private device fixture input required", input.isFile)
        assertTrue("Never use the user's formal or existing Debug package", context.packageName.endsWith(".debug.cachesync"))
        config = JSONObject(input.readText())
        report.put("package", context.packageName).put("deviceModel", android.os.Build.MODEL)
            .put("build", JSONObject(context.assets.open("oraculum-build.json").bufferedReader().use { it.readText() }))
        val project = config.getString("projectId")
        val primary = config.getString("primaryThreadId")
        val secondary = config.getString("secondaryThreadId")
        val draft = "CACHE_SYNC_LOCAL_DRAFT_DO_NOT_SEND"
        try {
            progress("pair-and-list")
            await("Isolated app initialization") { !it.busy }
            if (!state.paired) {
                compose.runOnIdle { model.endpointChange(config.getString("endpoint")) }
                action { model.pair(config.getString("pairCode")) }
            } else {
                assertEquals("A rerun must reuse the same isolated endpoint", config.getString("endpoint"), state.endpoint)
                action { model.reconnect() }
            }
            await("Isolated HTTPS/WSS connected") { it.online && it.paired && !it.busy && it.projects.any { p -> p.id == project } }
            assertTrue("Seeded native sessions must require multiple pages", config.getInt("expectedThreadCount") > 40)
            action { model.selectProject(project) }
            await("Native project list loaded") { it.selectedProjectId == project && !it.busy && it.threads.isNotEmpty() }
            while (state.canLoadMoreThreads) {
                val before = state.threads.size
                action { model.loadMoreThreads() }
                assertTrue("Every native list page advances", state.threads.size > before)
                assertTrue("Fixture catalog remains bounded", state.threads.size <= 100)
            }
            val catalog = control("status").getJSONArray("expectedThreadIds").strings()
            assertEquals("Native Gateway order and page order are exact", catalog, state.threads.map { it.id })
            val loadedList = state.threads.map { it.id }
            assertTrue(loadedList.contains(primary) && loadedList.contains(secondary))
            report.put("loadedThreadCount", loadedList.size)

            progress("load-history-and-detail")
            action { model.selectThread(primary) }
            await("Primary native history loaded") { it.selectedThreadId == primary && !it.busy && it.messages.isNotEmpty() }
            var pages = 1
            while (state.canLoadMore && pages < 5) {
                val before = state.messages.size
                action { model.loadMore() }
                assertTrue("Older native history page adds rows", state.messages.size > before)
                pages++
            }
            assertTrue("History has multiple real native pages", pages >= 2)
            assertTrue("All seeded turns are visible", state.messages.map { it.turnId }.toSet().size >= config.optInt("primaryTurnCount", 8))
            // A page-level truncated flag can also mark short neighboring Items.
            // Select the deliberately oversized native message, not its first neighbor.
            val truncated = state.messages.filter { it.detailsRequired }.maxByOrNull { it.text.toByteArray().size }
            assertNotNull("The dedicated fixture contains an actual bounded native Item", truncated)
            action { model.refreshConversation() }
            val detailed = state.messages.single { it.id == truncated!!.id }
            assertFalse("Explicit refresh verifies the native full Item", detailed.detailsRequired)
            assertTrue("Verified text exceeds the display preview budget", detailed.text.toByteArray().size > 16_384)
            action { model.loadItemDetail(detailed.turnId, detailed.id) }
            assertNotNull("Inspector displays verified complete Item JSON", state.inspector.detailText)
            val detailDigest = digest(checkNotNull(state.inspector.detailText))
            val loadedHistory = state.messages.map { it.id }
            val fullTextDigest = digest(state.messages.single { it.id == detailed.id }.text)
            compose.runOnIdle { model.draftChange(draft); model.readPosition(1, 37) }
            Thread.sleep(700)
            compose.waitForIdle()
            val anchor = state.messages[state.readIndex].id
            val offset = state.readOffset
            val snapshotBefore = snapshotRow(primary)
            val operationsBefore = operationCount()
            screenshot("01-loaded-windows")

            progress("automatic-refresh-past-lease")
            val waitUntil = System.currentTimeMillis() + 38_000
            while (System.currentTimeMillis() < waitUntil) {
                Thread.sleep(250)
                compose.waitForIdle()
                assertEquals("Automatic refresh never collapses the loaded catalog", loadedList, state.threads.map { it.id })
                assertEquals("Unchanged history never loses older rows", loadedHistory, state.messages.map { it.id })
            }
            await("An actual automatic Snapshot has completed", timeoutMs = 35_000) {
                !it.busy && snapshotRow(primary).second > snapshotBefore.second
            }
            assertEquals("Content, not the elapsed lease, defines the revision", snapshotBefore.first, snapshotRow(primary).first)
            assertEquals("Reading Item remains anchored", anchor, state.messages[state.readIndex].id)
            assertEquals("Reading offset remains anchored", offset, state.readOffset)
            assertEquals("Verified Item text remains complete", fullTextDigest, digest(state.messages.single { it.id == detailed.id }.text))
            assertFalse(state.messages.single { it.id == detailed.id }.detailsRequired)
            assertEquals("Inspector detail remains present", detailDigest, digest(checkNotNull(state.inspector.detailText)))
            assertEquals(draft, state.draft)
            assertEquals("Read-only refresh adds no operation", operationsBefore, operationCount())
            report.put("automaticRefreshPassed", true).put("loadedHistoryPages", pages)
                .put("loadedHistoryItems", loadedHistory.size).put("readingAnchorPreserved", true)
                .put("verifiedDetailPreserved", true).put("revisionStablePastLease", true)
            screenshot("02-after-automatic-refresh")

            progress("thread-switch")
            action { model.selectThread(secondary) }
            await("Secondary native history") { !it.busy && it.selectedThreadId == secondary && it.messages.isNotEmpty() }
            action { model.selectThread(primary) }
            await("Primary returns with its local draft") { !it.busy && it.selectedThreadId == primary && it.draft == draft && it.messages.isNotEmpty() }
            assertTrue("Known seed remains readable after switching", state.messages.any { it.text.contains(config.getString("seedMarkerPrefix")) })
            assertEquals("Thread switching performs no native write", operationsBefore, operationCount())
            report.put("threadSwitchPassed", true)

            progress("connection-cut-and-replay")
            val readable = state.messages.map { it.id }
            control("cycleConnection")
            await("Actual TLS/WSS transport disconnect", timeoutMs = 20_000) { !it.online }
            assertFalse("Offline cache cannot send", state.canSend)
            assertEquals("Transport loss retains readable history", readable, state.messages.map { it.id })
            assertEquals(draft, state.draft)
            await("Actual automatic reconnect and Snapshot correction", timeoutMs = 150_000) {
                it.online && !it.busy && it.selectedThreadId == primary && it.messages.isNotEmpty()
            }
            assertEquals(draft, state.draft)
            assertEquals("Reconnect never replays a business write", operationsBefore, operationCount())
            assertTrue("Unknown operation barrier remains clear", state.unresolvedOperations.isEmpty())
            report.put("reconnectPassed", true)
            screenshot("03-reconnected")

            progress("external-catalog-mutations")
            // Refill the complete window after the explicit connection baseline correction.
            while (state.canLoadMoreThreads) action { model.loadMoreThreads() }
            val changed = control("externalChanges")
            val expected = changed.getJSONArray("expectedThreadIds").strings()
            await("External native additions/deletions/archive converge in native order", timeoutMs = 150_000) {
                !it.busy && it.threads.map { t -> t.id } == expected
            }
            assertFalse(state.threads.any { it.id == changed.getString("archivedThreadId") })
            assertFalse(state.threads.any { it.id == changed.getString("deletedThreadId") })
            assertTrue(state.threads.any { it.id == changed.getString("newThreadId") })
            assertEquals("External native name is reflected", changed.optString("renamedTitle", "CACHE_SYNC_EXTERNAL_RENAMED"),
                state.threads.single { it.id == changed.getString("renamedThreadId") }.label)
            report.put("externalCatalogPassed", true).put("externalActiveCount", expected.size)

            progress("external-cli-turn")
            val cli = control("cliUpdate")
            await("Real external CLI history becomes visible", timeoutMs = 150_000) {
                !it.busy && it.messages.any { m -> m.role == "assistant" && m.text.contains(cli.getString("cliMarker")) }
            }
            assertEquals(draft, state.draft)
            report.put("externalCliPassed", true)

            progress("external-acp-turn")
            val acp = control("acpUpdate")
            await("Real external ACP history becomes visible", timeoutMs = 150_000) {
                !it.busy && it.messages.any { m -> m.role == "assistant" && m.text.contains(acp.getString("acpMarker")) }
            }
            assertEquals(draft, state.draft)
            assertEquals("External clients create no Android operation identities", operationsBefore, operationCount())
            assertTrue("No automatic recovery invents an unknown write", state.unresolvedOperations.isEmpty())
            report.put("externalAcpPassed", true).put("businessWritesFromAndroid", 0).put("passed", true)
            progress("passed")
            screenshot("04-external-cli-acp")
        } finally {
            report.put("stage", stage).put("observedAt", System.currentTimeMillis())
            File(output, "report.json").writeText(report.toString(2))
            http.dispatcher.executorService.shutdown()
            http.connectionPool.evictAll()
        }
    }

    private fun action(start: () -> Job) {
        await("Previous action settled") { !it.busy }
        var job: Job? = null
        compose.runOnIdle { job = start() }
        runBlocking { withTimeout(240_000) { checkNotNull(job).join() } }
        compose.waitForIdle()
        assertNull("Action failed at $stage", state.error)
    }

    private fun await(description: String, timeoutMs: Long = 120_000, check: (PocUiState) -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            compose.waitForIdle()
            if (check(state)) return
            Thread.sleep(100)
        }
        fail("$description; stage=$stage online=${state.online} busy=${state.busy} error=${state.error} threads=${state.threads.size} messages=${state.messages.size}")
    }

    private fun control(command: String): JSONObject {
        if (command !in setOf("externalChanges", "cliUpdate", "acpUpdate")) return controlRequest(command)
        // A rerun inspects accepted fixture evidence first. A lost control ACK must
        // never issue another CLI/ACP prompt or repeat a partially executed mutation.
        val before = controlRequest("status", timeoutMs = 25_000)
        if (controlConfirmed(command, before)) {
            recordControlEvidence("reusedConfirmedControls", command)
            return before
        }
        val intent = File(File(context.noBackupFilesDir, "cache-sync-control-intents").apply { mkdirs() },
            digest(config.getString("projectId")) + "-$command.json")
        if (intent.exists()) {
            // A prior test process may have stopped after dispatch. Its absence
            // of an ACK is still unknown; never send its fixed control again.
            recordControlEvidence("continuedUnknownControls", command)
        } else {
            check(intent.createNewFile()) { "Fixture control intent could not be reserved" }
            FileOutputStream(intent).use { stream ->
                stream.write(JSONObject().put("command", command).put("createdAt", System.currentTimeMillis()).toString().toByteArray())
                stream.fd.sync()
            }
            try {
                return controlRequest(command).also {
                    assertTrue("Fixture control $command returned without confirmed native evidence", controlConfirmed(command, it))
                }
            } catch (_: IOException) {
                recordControlEvidence("lostControlAcknowledgements", command)
            } catch (_: FixtureControlAckLost) {
                recordControlEvidence("lostControlAcknowledgements", command)
            }
        }
        val deadline = System.currentTimeMillis() + 210_000
        while (System.currentTimeMillis() < deadline) {
            try {
                val observed = controlRequest("status", timeoutMs = 25_000)
                if (controlConfirmed(command, observed)) {
                    recordControlEvidence("recoveredControlsByReadOnlyStatus", command)
                    return observed
                }
            } catch (_: IOException) {
                // Only this read is retryable. The business control is never resent.
            } catch (_: FixtureControlAckLost) {
                // The older fixture may also close a status socket queued behind
                // a long native writer. Keep observing its original execution.
            }
            Thread.sleep(1_000)
        }
        throw AssertionError("Fixture control $command remains unknown; it was dispatched once and must not be replayed")
    }

    private fun controlConfirmed(command: String, value: JSONObject): Boolean = when (command) {
        "externalChanges" -> value.optJSONObject("counts")?.optInt("externalMutations", 0)?.let { it >= 4 } == true &&
            listOf("archivedThreadId", "deletedThreadId", "renamedThreadId", "newThreadId").all { !value.optString(it).isBlank() }
        "cliUpdate" -> value.optBoolean("cliComplete") && (value.optJSONObject("counts")?.optInt("cliWrites", 0) ?: 0) >= 1
        "acpUpdate" -> value.optBoolean("acpComplete") && (value.optJSONObject("counts")?.optInt("acpWrites", 0) ?: 0) >= 1
        else -> false
    }

    private fun recordControlEvidence(key: String, command: String) {
        val values = report.optJSONArray(key) ?: JSONArray().also { report.put(key, it) }
        if (command !in values.strings()) values.put(command)
    }

    private class FixtureControlAckLost : Exception()

    private fun controlRequest(command: String, timeoutMs: Long = 240_000): JSONObject {
        val body = JSONObject().put("command", command).toString().toRequestBody("application/json".toMediaType())
        val request = Request.Builder().url(config.getString("controlUrl"))
            .header("X-Oraculum-Test-Control", config.getString("controlToken")).post(body).build()
        return http.newCall(request).apply { timeout().timeout(timeoutMs, TimeUnit.MILLISECONDS) }.execute().use { response ->
            if (response.code in 500..599) throw FixtureControlAckLost()
            assertTrue("Fixture control $command failed (${response.code})", response.isSuccessful)
            JSONObject(checkNotNull(response.body).string())
        }
    }

    private fun snapshotRow(thread: String): Pair<String?, Long> = SQLiteDatabase.openDatabase(
        context.getDatabasePath(CacheDatabase.FILE_NAME).path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
        db.rawQuery("SELECT revision, loadedAt FROM projections WHERE kind='snapshot' AND resourceId=? ORDER BY loadedAt DESC LIMIT 1", arrayOf(thread)).use {
            check(it.moveToFirst()) { "Selected Snapshot must be persisted" }
            (if (it.isNull(0)) null else it.getString(0)) to it.getLong(1)
        }
    }

    private fun operationCount(): Long = SQLiteDatabase.openDatabase(
        context.getDatabasePath(StateDatabase.FILE_NAME).path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
        db.rawQuery("SELECT count(*) FROM operations", null).use { it.moveToFirst(); it.getLong(0) }
    }

    private fun progress(value: String) {
        stage = value
        File(output, "progress.json").writeText(JSONObject().put("stage", stage).put("observedAt", System.currentTimeMillis()).toString())
    }

    private fun screenshot(name: String) {
        compose.waitForIdle()
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private fun JSONArray.strings(): List<String> = (0 until length()).map(::getString)
    private fun digest(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
        .joinToString("") { "%02x".format(it) }
}
