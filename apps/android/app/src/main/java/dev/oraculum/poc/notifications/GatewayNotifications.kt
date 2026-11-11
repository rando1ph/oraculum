package dev.oraculum.poc.notifications

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import dev.oraculum.poc.MainActivity
import dev.oraculum.poc.R
import dev.oraculum.poc.gateway.GatewayProtocol
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject

enum class NotificationDelivery { SHOWN, CANCELLED, DUPLICATE, SUPPRESSED, IGNORED, FAILED }

/** Uses the existing in-process WSS only. No service, wake lock, push or retry worker is installed. */
class GatewayNotifications(context: Context, private val ledger: NotificationLedger = NotificationLedger(context)) {
    private val app = context.applicationContext
    private val manager = app.getSystemService(NotificationManager::class.java)

    init {
        manager.createNotificationChannels(listOf(
            NotificationChannel(TURNS_CHANNEL, "执行结果", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Codex 原生执行完成或停止"
            },
            NotificationChannel(ATTENTION_CHANNEL, "审批与回复", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "需要在应用内核对的原生审批和交互请求"
            },
            NotificationChannel(ERRORS_CHANNEL, "执行错误", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Codex 原生执行失败"
            },
        ))
    }

    suspend fun onVerifiedEvent(scopeKey: String, event: JsonObject): NotificationDelivery {
        val notice = classifyNotification(scopeKey, event) ?: return NotificationDelivery.IGNORED
        return try {
            if (notice.cancel) {
                manager.cancel(notice.nativeKey, NOTIFICATION_ID)
                // Do not allow an earlier opened event to recreate a submitted/resolved prompt.
                ledger.claim(notice)
                NotificationDelivery.CANCELLED
            } else {
                if (!ledger.claim(notice)) return NotificationDelivery.DUPLICATE
                val channel = channel(notice.kind)
                if (!notificationsEnabled(app) || manager.getNotificationChannel(channel)?.importance == NotificationManager.IMPORTANCE_NONE)
                    return NotificationDelivery.SUPPRESSED
                val content = PendingIntent.getActivity(app, 0, routeIntent(app, notice),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                val notification = NotificationCompat.Builder(app, channel)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(notice.title)
                    .setContentText(notice.text)
                    .setContentIntent(content)
                    .setAutoCancel(true)
                    .setOnlyAlertOnce(true)
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                    .setPublicVersion(NotificationCompat.Builder(app, channel)
                        .setSmallIcon(R.drawable.ic_notification).setContentTitle("神谕")
                        .setContentText("有新的 Codex 状态，请打开应用查看。")
                        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC).build())
                    .setCategory(if (notice.kind == NoticeKind.ATTENTION) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_STATUS)
                    .build()
                manager.notify(notice.nativeKey, NOTIFICATION_ID, notification)
                NotificationDelivery.SHOWN
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Notification permission or storage trouble must not break the Gateway event projection.
            NotificationDelivery.FAILED
        }
    }

    companion object {
        const val TURNS_CHANNEL = "oraculum.turns"
        const val ATTENTION_CHANNEL = "oraculum.attention"
        const val ERRORS_CHANNEL = "oraculum.errors"
        const val ROUTE_ACTION = "dev.oraculum.poc.OPEN_NOTIFICATION"
        private const val NOTIFICATION_ID = 1
        private const val SCOPE = "notification.scope"
        private const val PROJECT = "notification.project"
        private const val THREAD = "notification.thread"
        private const val INSPECTOR = "notification.inspector"

        fun permissionRequired(context: Context): Boolean = Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

        fun notificationsEnabled(context: Context): Boolean = !permissionRequired(context) &&
            NotificationManagerCompat.from(context).areNotificationsEnabled()

        fun settingsIntent(context: Context): Intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)

        /** These are read-only navigation hints; the VM must validate scope and fetch current facts. */
        fun readRoute(intent: Intent?): NotificationRoute? {
            if (intent?.action != ROUTE_ACTION || intent.data?.scheme != "oraculum-notification" || intent.data?.authority != "notice") return null
            val scope = intent.getStringExtra(SCOPE)?.takeIf { it.length in 1..8192 } ?: return null
            val project = intent.getStringExtra(PROJECT)?.takeIf(GatewayProtocol::uuid) ?: return null
            val thread = intent.getStringExtra(THREAD)?.takeIf(::safeNativeId) ?: return null
            val inspector = intent.getStringExtra(INSPECTOR)?.takeIf { it in setOf("approvals", "execution") } ?: return null
            return NotificationRoute(scope, project, thread, inspector)
        }

        internal fun routeIntent(context: Context, notice: GatewayNotice): Intent = Intent(context, MainActivity::class.java)
            .setAction(ROUTE_ACTION)
            .setData(Uri.Builder().scheme("oraculum-notification").authority("notice").appendPath(notice.nativeKey).build())
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(SCOPE, notice.route.scopeKey).putExtra(PROJECT, notice.route.projectId)
            .putExtra(THREAD, notice.route.threadId).putExtra(INSPECTOR, notice.route.inspector)

        private fun channel(kind: NoticeKind): String = when (kind) {
            NoticeKind.TURN -> TURNS_CHANNEL
            NoticeKind.ATTENTION -> ATTENTION_CHANNEL
            NoticeKind.ERROR -> ERRORS_CHANNEL
        }
    }
}
