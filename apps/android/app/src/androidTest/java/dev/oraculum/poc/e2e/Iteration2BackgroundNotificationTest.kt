package dev.oraculum.poc.e2e

import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import android.os.Process
import android.service.notification.StatusBarNotification
import android.view.Choreographer
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import dev.oraculum.poc.MainActivity
import dev.oraculum.poc.PocViewModel
import dev.oraculum.poc.notifications.GatewayNotifications
import dev.oraculum.poc.notifications.noticeHash
import dev.oraculum.poc.storage.ClientPreferences
import dev.oraculum.poc.storage.CacheDatabase
import dev.oraculum.poc.storage.CachedProjection
import dev.oraculum.poc.storage.StateDatabase
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/**
 * One explicit recheck after the earlier body's native success and ActivityScenario teardown failure.
 * Android owns notification Activity replacement: no Compose/ActivityScenario rule owns that Activity.
 * An existing durable intent always stops this test; it never retries an uncertain native write.
 */
class Iteration2BackgroundNotificationTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val monitor get() = ActivityLifecycleMonitorRegistry.getInstance()
    private val directory get() = File(context.filesDir, "iteration2-evidence").apply { mkdirs() }

    @Test fun homeCompletionAndActualPendingIntentWithExplicitLifecycleCleanup() {
        val inputFile = File(context.noBackupFilesDir, "iteration2-e2e.json")
        assertTrue("Opt-in private Iteration 2 input required", inputFile.isFile)
        val input = JSONObject(inputFile.readText())
        val checkpoint = JSONObject(File(directory, "checkpoint.json").readText())
        val project = checkpoint.getString("projectId")
        val thread = checkpoint.getString("threadId")
        assertEquals(input.getString("projectId"), project)
        val priorReport = File(directory, "i2-background-notification.json")
        assertTrue("Preserve and inspect the prior native body evidence first", priorReport.isFile)
        val prior = JSONObject(priorReport.readText())
        assertTrue(prior.getBoolean("passed"))
        assertEquals(project, prior.getString("projectId"))
        assertEquals(thread, prior.getString("threadId"))
        val priorTurn = prior.getString("nativeTurnId")
        val intentFile = File(directory, "background-recheck-intent.json")
        assertFalse("This recheck may already have executed; inspect the original receipt, never resend", intentFile.exists())
        val report = File(directory, "i2-background-notification-recheck.json")
        assertFalse("Keep previous recheck evidence intact", report.exists())
        val progress = File(directory, "i2-background-notification-recheck-progress.json")
        val processId = Process.myPid()
        val marker = "I2_BACKGROUND_RECHECK_DONE"
        var initial: MainActivity? = null
        var routed: MainActivity? = null
        var previousDraft: String? = null
        var scope: String? = null
        var draftRestored = false
        var activitiesDestroyed = false
        var phase = "initializing"
        var evidence: JSONObject? = null
        fun recordProgress() {
            progress.writeText(JSONObject().put("passed", false).put("diagnosticOnly", true)
                .put("phase", phase).put("observedAt", System.currentTimeMillis())
                .put("draftRestored", draftRestored).put("activitiesDestroyed", activitiesDestroyed)
                .put("intentExists", intentFile.exists()).toString(2))
        }
        try {
            instrumentation.runOnMainSync {
                context.startActivity(Intent(context, MainActivity::class.java).setAction(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_LAUNCHER)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
            }
            val activity = resumedActivity().also { initial = it }
            val model = activity.model
            await("Existing paired dedicated thread restored") {
                model.state.value.let { it.online && it.paired && !it.busy && it.selectedProjectId == project && it.selectedThreadId == thread }
            }
            assertEquals("Never replace the retained endpoint", input.getString("endpoint"), model.state.value.endpoint)
            val currentScope = checkNotNull(runBlocking { ClientPreferences(context).snapshot().scopeKey })
            scope = currentScope
            val previousSnapshotTime = snapshot(currentScope, project, thread)?.loadedAt ?: -1L
            val refreshStartedAt = System.currentTimeMillis()
            var refresh: Job? = null
            instrumentation.runOnMainSync { refresh = model.refresh() }
            runBlocking { withTimeout(180_000) { checkNotNull(refresh).join() } }
            val settled = model.state.value
            assertTrue("Native reread must finish online", settled.online && !settled.busy)
            assertNull("A handled refresh failure is not successful native readback", settled.error)
            val freshSnapshot = checkNotNull(snapshot(currentScope, project, thread)) { "No verified snapshot was persisted" }
            assertTrue("Require a newly applied native snapshot, not retained cached messages",
                freshSnapshot.loadedAt > previousSnapshotTime && freshSnapshot.loadedAt >= refreshStartedAt)
            val snapshotData = JSONObject(freshSnapshot.payloadJson)
            assertEquals("current", snapshotData.getString("synchronization"))
            assertEquals(freshSnapshot.epoch, snapshotData.getString("epoch"))
            assertEquals(project, snapshotData.getJSONObject("thread").getString("projectId"))
            assertEquals(thread, snapshotData.getJSONObject("thread").getString("id"))
            val nativeTurns = snapshotData.getJSONObject("history").getJSONArray("items")
            assertTrue("Fresh snapshot must contain the exact prior completed native Turn",
                (0 until nativeTurns.length()).any { index -> nativeTurns.getJSONObject(index).let {
                    it.optString("id") == priorTurn && it.optString("status") == "completed"
                } })
            assertFalse("No new verification around an active Turn", settled.canStop)
            assertTrue("Unknown receipts must be resolved by original evidence first", settled.unresolvedOperations.isEmpty())
            assertTrue("Do not bypass an actual native approval", settled.interactions.none { it.status == "pending" })
            assertTrue("Prior body's exact native Turn must be completed after readback", settled.messages.any {
                it.turnId == priorTurn && it.role == "assistant" && it.text.contains("I2_BACKGROUND_DONE") && it.turn?.status == "completed"
            })
            assertOriginalDraftPreserved()
            await("Dedicated attachment scope loaded") {
                model.files.state.value.let { it.threadId == thread && !it.busy }
            }
            assertTrue("Do not claim any unrelated attachment", model.files.state.value.attachments.isEmpty())
            previousDraft = settled.draft
            File(context.noBackupFilesDir, "iteration2-background-recheck-draft.json").writeText(
                JSONObject().put("projectId", project).put("threadId", thread).put("draft", previousDraft).toString())
            val manager = context.getSystemService(NotificationManager::class.java)
            assertTrue("Existing notification permission must be enabled", manager.areNotificationsEnabled())
            val existingNotifications = manager.activeNotifications.map { it.key }.toSet()
            val previousMessages = settled.messages.map { it.id }.toSet()
            val prompt = "Use the shell exactly once to execute sleep 8; printf 'I2_BACKGROUND_RECHECK_DONE\\n'. This only waits and prints a fixed marker. Do not read or modify files. After the command finishes, reply I2_BACKGROUND_RECHECK_DONE in one short Chinese sentence."
            instrumentation.runOnMainSync { model.draftChange(prompt) }
            await("Explicit dedicated verification is writable") {
                model.state.value.let { it.draft == prompt && it.canSend && !it.busy && !it.canStop && it.unresolvedOperations.isEmpty() }
            }
            assertEquals(project, model.state.value.selectedProjectId)
            assertEquals(thread, model.state.value.selectedThreadId)
            assertTrue("Reserve a single durable explicit intent", intentFile.createNewFile())
            FileOutputStream(intentFile).use { stream ->
                stream.write(JSONObject().put("projectId", project).put("threadId", thread).put("marker", marker)
                    .put("priorCompletedNativeTurnId", priorTurn).put("requestedAt", System.currentTimeMillis())
                    .put("beforeMessageIds", JSONArray(previousMessages)).toString().toByteArray(Charsets.UTF_8))
                stream.fd.sync()
            }
            phase = "intent-durable-before-send"
            recordProgress()
            instrumentation.runOnMainSync { model.send() }
            await("Actual native recheck Turn active before Home") { model.state.value.canStop }
            val launcher = shell("cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME")
                .lineSequence().map(String::trim).lastOrNull { it.matches(Regex("^[A-Za-z0-9_.]+/[A-Za-z0-9_.$]+$")) }
                ?.substringBefore('/') ?: error("Cannot identify actual Home launcher")
            shell("input keyevent KEYCODE_HOME")
            await("Actual Home stops the Activity and displays its launcher", 20_000) {
                stage(activity) == Stage.STOPPED && instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() == launcher
            }
            val backgroundAt = System.currentTimeMillis()
            phase = "stopped-at-home"
            recordProgress()
            await("New native command and final answer complete while stopped", 240_000) {
                assertEquals(processId, Process.myPid())
                assertEquals("Never resume before observing completion", Stage.STOPPED, stage(activity))
                model.state.value.let { current -> !current.busy && !current.canStop && current.unresolvedOperations.isEmpty() &&
                    current.messages.any { it.id !in previousMessages && it.role == "assistant" && it.text.contains(marker) && it.turnId.isNotBlank() && it.turn?.status == "completed" } &&
                    current.messages.any { it.id !in previousMessages && it.role == "commandExecution" && it.text.contains(marker) }
                }
            }
            val answer = model.state.value.messages.last {
                it.id !in previousMessages && it.role == "assistant" && it.text.contains(marker) && it.turnId.isNotBlank()
            }
            assertNotEquals("This is a separate explicit recheck", priorTurn, answer.turnId)
            val expectedTag = noticeHash(checkNotNull(scope), project, thread, "turn", answer.turnId)
            var notification: StatusBarNotification? = null
            await("Exact new Turn notification is posted after Home", 15_000) {
                assertEquals(Stage.STOPPED, stage(activity))
                notification = manager.activeNotifications.firstOrNull {
                    it.packageName == context.packageName && it.key !in existingNotifications && it.tag == expectedTag &&
                        it.notification.channelId == GatewayNotifications.TURNS_CHANNEL && it.postTime >= backgroundAt
                }
                notification != null
            }
            val delivered = checkNotNull(notification)
            val title = delivered.notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
            assertEquals("Codex 执行完成", title)
            phase = "exact-native-notification-received"
            recordProgress()
            // Route the actual PendingIntent without opening/capturing unrelated notification-shade content.
            checkNotNull(delivered.notification.contentIntent).send()
            await("Actual PendingIntent restores the dedicated thread and Inspector", 60_000) {
                routed = currentResumed()
                routed?.model?.state?.value?.let { it.online && !it.busy && !it.canStop && it.unresolvedOperations.isEmpty() &&
                    it.selectedProjectId == project && it.selectedThreadId == thread && it.navigationRequest?.startsWith("inspector:") == true
                } == true
            }
            assertEquals(processId, Process.myPid())
            assertInspectorVisible()
            captureStableScreenshot("i2-31-background-notification-routed")
            assertOriginalDraftPreserved()
            evidence = JSONObject().put("build", buildIdentity()).put("projectId", project).put("threadId", thread)
                .put("priorBodyNativeTurnId", priorTurn).put("nativeTurnId", answer.turnId).put("nativeAssistantItemId", answer.id)
                .put("priorBodyCompletionReadBack", true).put("singleExplicitRecheckIntent", true)
                .put("priorSnapshotLoadedAt", freshSnapshot.loadedAt).put("priorReadbackStartedAt", refreshStartedAt)
                .put("activityStoppedBeforeCompletion", true).put("sameProcessAlive", true)
                .put("exactNativeTurnNotificationMatched", true).put("notificationTitle", title)
                .put("notificationChannel", delivered.notification.channelId).put("notificationId", delivered.id)
                .put("actualPendingIntentRouted", true).put("notificationShadeCaptured", false)
                .put("processDeathOrForceStopTested", false)
            phase = "body-complete-cleanup-pending"
        } finally {
            try {
                val cleanupActivity = currentResumed() ?: routed?.takeUnless(::destroyed) ?: initial?.takeUnless(::destroyed)
                val cleanupModel = cleanupActivity?.model
                if (previousDraft != null && cleanupModel != null && scope != null) {
                    val state = cleanupModel.state.value
                    if (state.selectedProjectId == project && state.selectedThreadId == thread && !state.busy && !state.canStop && state.unresolvedOperations.isEmpty()) {
                        restoreDedicatedDraft(cleanupModel, checkNotNull(scope), project, thread, checkNotNull(previousDraft))
                        draftRestored = true
                    }
                }
                if (evidence != null) assertTrue("Successful recheck must restore its prior dedicated draft", draftRestored)
                assertOriginalDraftPreserved()
            } finally {
                try {
                    finishMainActivities()
                    activitiesDestroyed = true
                    phase = "explicit-cleanup-complete"
                } finally { recordProgress() }
            }
        }
        // Successful evidence is written only after lifecycle cleanup and durable draft restoration.
        report.writeText(checkNotNull(evidence).put("passed", true).put("dedicatedDraftRestored", draftRestored)
            .put("originalDraftPreserved", true).put("allTestActivitiesDestroyed", activitiesDestroyed).toString(2))
    }

    private fun restoreDedicatedDraft(model: PocViewModel, scope: String, project: String, thread: String, draft: String) {
        instrumentation.runOnMainSync { model.draftChange(draft) }
        val database = StateDatabase.open(context)
        try {
            await("Previous dedicated draft restored durably before Activity cleanup", 15_000) {
                model.state.value.draft == draft && runBlocking { database.state().draft(scope, project, thread)?.text == draft }
            }
        } finally { database.close() }
    }

    private fun assertOriginalDraftPreserved() = runBlocking {
        val file = File(context.noBackupFilesDir, "iteration2-original-state.json")
        assertTrue("Original private user state must remain present", file.isFile)
        val original = JSONObject(file.readText())
        if (listOf("scopeKey", "projectId", "threadId").any { original.isNull(it) }) return@runBlocking
        val database = StateDatabase.open(context)
        try {
            val current = database.state().draft(original.getString("scopeKey"), original.getString("projectId"), original.getString("threadId"))
            assertEquals("Original user draft existence retained", original.getBoolean("draftExists"), current != null)
            if (current != null) assertEquals("Original user draft text retained", original.getString("draft"), current.text)
        } finally { database.close() }
    }

    private fun buildIdentity() = context.assets.open("oraculum-build.json").bufferedReader().use { JSONObject(it.readText()) }

    private fun snapshot(scope: String, project: String, thread: String): CachedProjection? = runBlocking {
        val database = CacheDatabase.open(context)
        try { database.cache().get(scope, "snapshot", thread, projectId = project) }
        finally { database.close() }
    }

    private fun resumedActivity(): MainActivity {
        var result: MainActivity? = null
        await("MainActivity resumed", 20_000) { result = currentResumed(); result != null }
        return checkNotNull(result)
    }

    private fun currentResumed(): MainActivity? {
        var result: MainActivity? = null
        instrumentation.runOnMainSync { result = monitor.getActivitiesInStage(Stage.RESUMED).filterIsInstance<MainActivity>().singleOrNull() }
        return result
    }

    private fun stage(activity: MainActivity): Stage? {
        var result: Stage? = null
        instrumentation.runOnMainSync { result = monitor.getLifecycleStageOf(activity) }
        return result
    }

    private fun destroyed(activity: MainActivity): Boolean {
        var result = false
        instrumentation.runOnMainSync { result = activity.isDestroyed }
        return result
    }

    private fun finishMainActivities() {
        val activities = mutableSetOf<MainActivity>()
        instrumentation.runOnMainSync {
            Stage.values().filter { it != Stage.DESTROYED }.forEach { activities += monitor.getActivitiesInStage(it).filterIsInstance<MainActivity>() }
            activities.forEach { if (!it.isFinishing) it.finish() }
        }
        await("All manually owned test Activities destroyed", 20_000) { activities.all(::destroyed) }
    }

    private fun assertInspectorVisible() {
        fun containsInspector(node: AccessibilityNodeInfo?): Boolean {
            if (node == null) return false
            if (node.isVisibleToUser && node.text?.toString() == "Inspector") return true
            return (0 until node.childCount).any { containsInspector(node.getChild(it)) }
        }
        await("Actual Inspector window rendered", 20_000) {
            val root = instrumentation.uiAutomation.rootInActiveWindow
            root?.packageName?.toString() == context.packageName && containsInspector(root)
        }
    }

    private fun captureStableScreenshot(name: String) {
        instrumentation.waitForIdleSync()
        var previous: Bitmap? = null
        var stable = 0
        try {
            repeat(30) {
                val frame = CountDownLatch(1)
                instrumentation.runOnMainSync { Choreographer.getInstance().postFrameCallback { frame.countDown() } }
                assertTrue("Display frame must arrive", frame.await(2, TimeUnit.SECONDS))
                val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
                stable = if (previous?.sameAs(bitmap) == true) stable + 1 else 0
                previous?.recycle()
                previous = bitmap
                if (stable >= 2) {
                    File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                    return
                }
            }
            fail("Native window pixels did not settle; no transition frame saved")
        } finally { previous?.recycle() }
    }

    private fun shell(command: String): String = ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command))
        .bufferedReader().use { it.readText() }

    private fun await(description: String, timeout: Long = 120_000, check: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < deadline) {
            if (check()) return
            Thread.sleep(80)
        }
        val state = currentResumed()?.model?.state?.value
        fail("$description; online=${state?.online}, busy=${state?.busy}, active=${state?.canStop}, unresolved=${state?.unresolvedOperations?.size}")
    }
}
