package dev.oraculum.poc.e2e

import android.app.NotificationManager
import android.content.Intent
import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import android.os.Process
import android.service.notification.StatusBarNotification
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleCallback
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import dev.oraculum.poc.MainActivity
import dev.oraculum.poc.notifications.GatewayNotifications
import dev.oraculum.poc.notifications.noticeHash
import dev.oraculum.poc.storage.ClientPreferences
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/**
 * A real Gateway/Codex journey with the actual Home key and Notification PendingIntent.
 * No ActivityScenarioRule owns an Activity that Android is allowed to replace while routing.
 * The cold route below recreates Activity + ViewModel in the same live instrumentation process;
 * it does not claim notification delivery after process death or force-stop.
 */
class Phase3BackgroundNotificationTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val directory get() = File(context.filesDir, "phase3-evidence").apply { mkdirs() }
    private val monitor get() = ActivityLifecycleMonitorRegistry.getInstance()

    @Test fun realCompletionNotifiesForeground() {
        assertTrue("Opt-in private fixture input required", File(context.noBackupFilesDir, "phase3-e2e.json").isFile)
        val checkpoint = JSONObject(File(directory, "checkpoint.json").readText())
        val thread = checkpoint.getString("threadId")
        val project = checkpoint.getString("projectId")
        val report = File(directory, "foreground-notification.json")
        report.delete()
        var lifecycleCallback: ActivityLifecycleCallback? = null
        var evidence: JSONObject? = null
        try {
            instrumentation.runOnMainSync {
                context.startActivity(Intent(context, MainActivity::class.java)
                    .setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
            }
            val activity = resumedActivity()
            val model = activity.model
            await("Initial foreground native workspace restored") {
                model.state.value.let { it.online && it.paired && !it.busy && it.selectedThreadId == thread && it.selectedProjectId == project }
            }
            val manager = context.getSystemService(NotificationManager::class.java)
            assertTrue("Grant notifications through the native permission journey first", manager.areNotificationsEnabled())
            val marker = "P3_FOREGROUND_${UUID.randomUUID().toString().replace("-", "")}"
            instrumentation.runOnMainSync { model.draftChange("Reply exactly $marker. Do not use tools.") }
            await("Explicit foreground send enabled") { model.state.value.canSend }
            val existing = manager.activeNotifications.map { it.key }.toSet()
            val previousMessages = model.state.value.messages.map { it.id }.toSet()
            val scope = checkNotNull(runBlocking { ClientPreferences(context).snapshot().scopeKey })
            val leftForeground = AtomicReference<Stage?>(null)
            lifecycleCallback = ActivityLifecycleCallback { changed, currentStage ->
                if (changed === activity && currentStage in setOf(Stage.PAUSED, Stage.STOPPED, Stage.DESTROYED))
                    leftForeground.compareAndSet(null, currentStage)
            }
            instrumentation.runOnMainSync { monitor.addLifecycleCallback(lifecycleCallback!!) }
            assertEquals(Stage.RESUMED, stage(activity))
            val sentAt = System.currentTimeMillis()
            instrumentation.runOnMainSync { model.send() }
            await("New native foreground Turn completed", 180_000) {
                assertNull("Activity left the foreground during the native Turn", leftForeground.get())
                assertEquals(Stage.RESUMED, stage(activity))
                model.state.value.let { !it.busy && !it.canStop && it.messages.any { message ->
                    message.id !in previousMessages && message.role == "assistant" && message.text.contains(marker) && message.turnId.isNotBlank()
                } }
            }
            val completedMessage = model.state.value.messages.first {
                it.id !in previousMessages && it.role == "assistant" && it.text.contains(marker) && it.turnId.isNotBlank()
            }
            val expectedTag = noticeHash(scope, project, thread, "turn", completedMessage.turnId)
            var notification: StatusBarNotification? = null
            await("New notification belongs to the exact completed foreground native Turn", 15_000) {
                assertNull("Activity left the foreground before notification delivery", leftForeground.get())
                assertEquals(Stage.RESUMED, stage(activity))
                notification = manager.activeNotifications.firstOrNull {
                    it.notification.channelId == GatewayNotifications.TURNS_CHANNEL && it.key !in existing &&
                        it.tag == expectedTag && it.postTime >= sentAt
                }
                notification != null
            }
            screenshot("08c-notification-foreground")
            assertNull("Activity remained resumed throughout foreground delivery", leftForeground.get())
            assertEquals(Stage.RESUMED, stage(activity))
            evidence = JSONObject().put("projectId", project).put("threadId", thread)
                .put("nativeTurnId", completedMessage.turnId).put("nativeAssistantItemId", completedMessage.id)
                .put("channel", notification!!.notification.channelId).put("notificationId", notification!!.id)
                .put("newNotificationIdentity", true).put("nativeTurnTagMatched", true)
                .put("activityContinuouslyResumed", true).put("notificationPostedAfterExplicitSend", true)
        } finally {
            lifecycleCallback?.let { callback -> instrumentation.runOnMainSync { monitor.removeLifecycleCallback(callback) } }
            finishMainActivities()
        }
        report.writeText(checkNotNull(evidence).put("passed", true).toString(2))
    }

    @Test fun realCompletionNotifiesAfterHomeAndRoutesBack() {
        assertTrue("Opt-in private fixture input required", File(context.noBackupFilesDir, "phase3-e2e.json").isFile)
        val checkpoint = JSONObject(File(directory, "checkpoint.json").readText())
        val thread = checkpoint.getString("threadId")
        val project = checkpoint.getString("projectId")
        val report = File(directory, "background-notification.json")
        report.delete() // An earlier successful body must not survive a failed rerun as current evidence.
        val progress = File(directory, "background-notification-progress.json")
        progress.delete()
        var phase = "initializing"
        var warmRouteProven = false
        var coldRouteProven = false
        fun recordProgress() {
            val observed = currentResumed()?.model?.state?.value
            progress.writeText(JSONObject().put("passed", false).put("diagnosticOnly", true).put("phase", phase)
                .put("warmRouteProven", warmRouteProven).put("coldRouteProven", coldRouteProven)
                .put("observedAt", System.currentTimeMillis()).put("expectedProjectId", project).put("expectedThreadId", thread)
                .put("observedProjectId", observed?.selectedProjectId).put("observedThreadId", observed?.selectedThreadId)
                .put("online", observed?.online).put("busy", observed?.busy).put("error", observed?.error)
                .put("inspectorRequested", observed?.navigationRequest?.startsWith("inspector:") == true).toString(2))
        }
        val processId = Process.myPid()
        var evidence: JSONObject? = null
        try {
            // A normal explicit launcher Intent; product notification flags remain untouched.
            instrumentation.runOnMainSync {
                context.startActivity(Intent(context, MainActivity::class.java)
                    .setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
            }
            val initial = resumedActivity()
            val initialModel = initial.model
            await("Initial native workspace restored") {
                initialModel.state.value.let { it.online && it.paired && !it.busy && it.selectedThreadId == thread && it.selectedProjectId == project }
            }
            val manager = context.getSystemService(NotificationManager::class.java)
            assertTrue("Grant notifications through the native permission journey first", manager.areNotificationsEnabled())
            val marker = "P3_BACKGROUND_${UUID.randomUUID().toString().replace("-", "")}"
            instrumentation.runOnMainSync {
                initialModel.draftChange("Write 100 short numbered sentences, then finish with $marker. Do not use tools.")
            }
            await("Explicit send enabled") { initialModel.state.value.canSend }
            val existing = manager.activeNotifications.map { it.key }.toSet()
            val previousMessages = initialModel.state.value.messages.map { it.id }.toSet()
            val scope = checkNotNull(runBlocking { ClientPreferences(context).snapshot().scopeKey })
            instrumentation.runOnMainSync { initialModel.send() }
            await("Actual native Turn active before Home") { initialModel.state.value.canStop }
            val launcherPackage = shell("cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME")
                .lineSequence().map(String::trim).lastOrNull { it.matches(Regex("^[A-Za-z0-9_.]+/[A-Za-z0-9_.$]+$")) }
                ?.substringBefore('/') ?: error("Cannot identify the device's current Home launcher")
            // The UiAutomation injection boolean is not reliable for the privileged Home key.
            // Wait for the real shell input command, then verify both lifecycle and visible launcher.
            shell("input keyevent KEYCODE_HOME")
            await("Home stopped the actual Activity and displayed its launcher", 20_000) {
                stage(initial) == Stage.STOPPED &&
                    instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() == launcherPackage
            }
            val backgroundAt = System.currentTimeMillis()
            assertEquals("Home keeps this test's app process alive", processId, Process.myPid())
            await("Native completion received while the Activity stays stopped", 240_000) {
                initialModel.state.value.let { !it.canStop && it.messages.any { message ->
                    message.id !in previousMessages && message.role == "assistant" && message.text.contains(marker) && message.turnId.isNotBlank()
                } }
            }
            assertEquals("Completion must be observed before returning from Home", Stage.STOPPED, stage(initial))
            val completedMessage = initialModel.state.value.messages.first {
                it.id !in previousMessages && it.role == "assistant" && it.text.contains(marker) && it.turnId.isNotBlank()
            }
            val expectedTag = noticeHash(scope, project, thread, "turn", completedMessage.turnId)
            val notification = completionNotification(manager, existing, backgroundAt, expectedTag)
            val pendingIntent = checkNotNull(notification.notification.contentIntent)

            // Hot return follows Android's actual PendingIntent routing, including Activity replacement.
            phase = "warm-route"
            recordProgress()
            pendingIntent.send()
            val warm = routedActivity(project, thread, "warm")
            assertInspectorVisible()
            screenshot("08-notification-routed")
            assertEquals(processId, Process.myPid())
            warmRouteProven = true
            phase = "warm-route-proven"
            recordProgress()

            // Destroy the Activity and its ViewModel, then let that same real notification create them.
            // This exercises init/queued-route ordering, without relabelling it as a process-death test.
            finishMainActivities()
            await("Warm Activity destroyed before cold Activity route", 20_000) { destroyed(warm) }
            phase = "cold-activity-route"
            pendingIntent.send()
            recordProgress()
            val cold = routedActivity(project, thread, "cold Activity")
            assertNotSame("Cold Activity route creates a new Activity", warm, cold)
            assertNotSame("Cold Activity route creates a new ViewModel", warm.model, cold.model)
            assertInspectorVisible()
            screenshot("08b-notification-cold-activity")
            assertEquals(processId, Process.myPid())
            coldRouteProven = true
            phase = "cold-activity-route-proven"
            recordProgress()
            evidence = JSONObject().put("channel", notification.notification.channelId)
                .put("notificationId", notification.id).put("projectId", project).put("threadId", thread)
                .put("nativeTurnId", completedMessage.turnId).put("nativeAssistantItemId", completedMessage.id)
                .put("newNotificationIdentity", true).put("nativeTurnTagMatched", true)
                .put("homeActivityStopped", true).put("postedWhileBackground", true)
                .put("warmPendingIntentRoute", true).put("coldActivityPendingIntentRoute", true)
                .put("sameProcess", true).put("processDeathDeliveryTested", false)
                .put("messages", cold.model.state.value.messages.size).put("theme", cold.model.state.value.themeMode)
        } finally {
            // Explicit teardown is part of the test. Exceptions remain JUnit failures, never suppressed.
            try { recordProgress() } finally { finishMainActivities() }
        }
        // Only write successful body evidence after our Activity lifecycle cleanup also completed.
        report.writeText(checkNotNull(evidence).put("passed", true).toString(2))
    }

    private fun routedActivity(project: String, thread: String, phase: String): MainActivity {
        var result: MainActivity? = null
        await("$phase notification opens the original project/thread and requests Inspector") {
            result = currentResumed()
            result?.model?.state?.value?.let {
                it.selectedProjectId == project && it.selectedThreadId == thread && it.online && !it.busy &&
                    it.navigationRequest?.startsWith("inspector:") == true
            } == true
        }
        return checkNotNull(result)
    }

    private fun completionNotification(manager: NotificationManager, existing: Set<String>, backgroundAt: Long, expectedTag: String): StatusBarNotification {
        var result: StatusBarNotification? = null
        await("Real completion notification posted after Home", 15_000) {
            result = manager.activeNotifications.firstOrNull {
                it.notification.channelId == GatewayNotifications.TURNS_CHANNEL && it.key !in existing &&
                    it.tag == expectedTag && it.postTime >= backgroundAt
            }
            result != null
        }
        return checkNotNull(result)
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
            Stage.values().filter { it != Stage.DESTROYED }.forEach { stage ->
                activities += monitor.getActivitiesInStage(stage).filterIsInstance<MainActivity>()
            }
            activities.forEach { if (!it.isFinishing) it.finish() }
        }
        await("All test MainActivities destroyed", 20_000) { activities.all(::destroyed) }
    }

    private fun assertInspectorVisible() {
        fun containsInspector(node: AccessibilityNodeInfo?): Boolean {
            if (node == null) return false
            if (node.isVisibleToUser && node.text?.toString() == "Inspector") return true
            return (0 until node.childCount).any { containsInspector(node.getChild(it)) }
        }
        await("Actual Inspector panel rendered", 20_000) {
            val root = instrumentation.uiAutomation.rootInActiveWindow
            root?.packageName?.toString() == context.packageName && containsInspector(root)
        }
    }

    private fun screenshot(name: String) {
        instrumentation.waitForIdleSync()
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        try { File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) } }
        finally { bitmap.recycle() }
    }

    private fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command))
            .bufferedReader().use { it.readText() }

    private fun await(description: String, timeout: Long = 120_000, check: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < deadline) {
            if (check()) return
            Thread.sleep(80)
        }
        val state = currentResumed()?.model?.state?.value
        fail("$description; connection=${state?.connectionLabel}; error=${state?.error}; thread=${state?.selectedThreadId}")
    }
}
