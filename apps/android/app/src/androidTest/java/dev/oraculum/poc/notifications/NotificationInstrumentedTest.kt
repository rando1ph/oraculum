package dev.oraculum.poc.notifications

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.ParcelFileDescriptor
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.oraculum.poc.MainActivity
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Android service + Preferences DataStore checks. Actual Codex/Home delivery is in the live journey. */
@RunWith(AndroidJUnit4::class)
class NotificationInstrumentedTest {
    private lateinit var context: Context
    private lateinit var manager: NotificationManager
    private lateinit var file: File
    private lateinit var storeScope: CoroutineScope
    private lateinit var notifications: GatewayNotifications
    private val scopeKey = "notification-test:${UUID.randomUUID()}"
    private val nativeTurn = UUID.randomUUID().toString()
    private val interaction = UUID.randomUUID().toString()
    private val tags = mutableSetOf<String>()

    @Before fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        manager = context.getSystemService(NotificationManager::class.java)
        file = File(context.filesDir, "notification-test-${UUID.randomUUID()}.preferences_pb")
        openStore()
        if (Build.VERSION.SDK_INT >= 33) {
            val result = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(
                "pm grant ${context.packageName} android.permission.POST_NOTIFICATIONS",
            )
            ParcelFileDescriptor.AutoCloseInputStream(result).use { it.readBytes() }
        }
    }

    @After fun tearDown() = runBlocking<Unit> {
        tags.forEach { manager.cancel(it, 1) }
        storeScope.coroutineContext.job.cancelAndJoin()
        file.delete()
    }

    @Test fun nativeNotificationUsesImportancePrivateContentAndExplicitImmutableReadOnlyRoute() = runBlocking {
        assertFalse(GatewayNotifications.permissionRequired(context))
        assertTrue(GatewayNotifications.notificationsEnabled(context))
        val event = turn("failed")
        val notice = remember(event)
        assertEquals(NotificationDelivery.SHOWN, notifications.onVerifiedEvent(scopeKey, event))
        val posted = awaitNotification(notice.nativeKey)
        assertEquals(GatewayNotifications.ERRORS_CHANNEL, posted.notification.channelId)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, manager.getNotificationChannel(GatewayNotifications.ERRORS_CHANNEL).importance)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, manager.getNotificationChannel(GatewayNotifications.ATTENTION_CHANNEL).importance)
        assertEquals(NotificationManager.IMPORTANCE_DEFAULT, manager.getNotificationChannel(GatewayNotifications.TURNS_CHANNEL).importance)
        assertEquals(android.app.Notification.VISIBILITY_PRIVATE, posted.notification.visibility)
        assertNotNull(posted.notification.publicVersion)
        assertNull(posted.notification.actions)
        if (Build.VERSION.SDK_INT >= 31) assertTrue(posted.notification.contentIntent.isImmutable)
        assertEquals(context.packageName, posted.notification.contentIntent.creatorPackage)
        val routeIntent = GatewayNotifications.routeIntent(context, notice)
        assertEquals(MainActivity::class.java.name, routeIntent.component?.className)
        assertEquals(notice.route, GatewayNotifications.readRoute(routeIntent))
        assertNull(GatewayNotifications.readRoute(Intent()))
        assertNull(GatewayNotifications.readRoute(Intent(routeIntent).setAction(Intent.ACTION_VIEW)))
    }

    @Test fun replayAndNativeDuplicateStaySuppressedAfterLedgerReopen() = runBlocking {
        val event = turn("completed")
        val notice = remember(event)
        assertEquals(NotificationDelivery.SHOWN, notifications.onVerifiedEvent(scopeKey, event))
        assertEquals(NotificationDelivery.DUPLICATE, notifications.onVerifiedEvent(scopeKey, event))
        manager.cancel(notice.nativeKey, 1)
        storeScope.coroutineContext.job.cancelAndJoin()
        openStore()
        assertEquals(NotificationDelivery.DUPLICATE, notifications.onVerifiedEvent(scopeKey, event))
        assertEquals(NotificationDelivery.DUPLICATE, notifications.onVerifiedEvent(scopeKey, turn("completed", 2)))
        val otherScope = "$scopeKey:other-device"
        tags += classifyNotification(otherScope, event)!!.nativeKey
        assertEquals(NotificationDelivery.SHOWN, notifications.onVerifiedEvent(otherScope, event))
    }

    @Test fun resolvedApprovalCancelsAndDoesNotRecreateAnActionablePrompt() = runBlocking {
        val opened = interactionEvent("interaction.opened", "pending", 3)
        val notice = remember(opened)
        assertEquals(NotificationDelivery.SHOWN, notifications.onVerifiedEvent(scopeKey, opened))
        assertEquals(GatewayNotifications.ATTENTION_CHANNEL, awaitNotification(notice.nativeKey).notification.channelId)
        assertEquals(NotificationDelivery.CANCELLED, notifications.onVerifiedEvent(scopeKey, interactionEvent("interaction.resolved", "resolved", 4)))
        assertEquals(NotificationDelivery.DUPLICATE, notifications.onVerifiedEvent(scopeKey, opened))
        assertTrue(manager.activeNotifications.none { it.tag == notice.nativeKey })
    }

    private fun openStore() {
        storeScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val store = PreferenceDataStoreFactory.create(scope = storeScope, produceFile = { file })
        notifications = GatewayNotifications(context, NotificationLedger(store))
    }

    private fun remember(event: JsonObject) = classifyNotification(scopeKey, event)!!.also { tags += it.nativeKey }

    private fun awaitNotification(tag: String): android.service.notification.StatusBarNotification {
        repeat(50) {
            manager.activeNotifications.firstOrNull { it.tag == tag }?.let { return it }
            Thread.sleep(20)
        }
        error("Notification was not posted")
    }

    private fun turn(status: String, seq: Long = 1) = event("native.state", buildJsonObject {
        put("method", "turn/completed"); put("truncated", false)
        put("data", buildJsonObject {
            put("threadId", "notification-test-thread")
            put("turn", buildJsonObject { put("id", nativeTurn); put("status", status) })
        })
    }, seq)

    private fun interactionEvent(kind: String, status: String, seq: Long) = event(kind, buildJsonObject {
        put("interactionId", interaction); put("projectId", PROJECT); put("threadId", "notification-test-thread")
        put("turnId", nativeTurn); put("epoch", EPOCH); put("generation", 1)
        put("kind", "command"); put("status", status); put("request", buildJsonObject {})
    }, seq)

    private fun event(kind: String, payload: JsonObject, seq: Long) = buildJsonObject {
        put("installationId", PROJECT); put("epoch", EPOCH); put("seq", seq); put("kind", kind); put("impact", "state")
        put("scope", buildJsonObject { put("projectId", PROJECT); put("threadId", "notification-test-thread") }); put("payload", payload)
    }

    companion object {
        private const val PROJECT = "12345678-1234-4123-8123-123456789abc"
        private const val EPOCH = "22345678-1234-4123-8123-123456789abc"
    }
}
