package dev.oraculum.poc

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** Cross-device conversation reminders; no Codex execution, replies or WebView timers. */
class TaskNotificationService : Service() {
    private data class Connection(val entry: ServerEntry, val cookie: String)
    private val handler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val manager by lazy { getSystemService(NotificationManager::class.java) }
    private val preferences by lazy { getSharedPreferences("task-notifications", MODE_PRIVATE) }
    private var connection: Connection? = null
    private var busy = false
    private var destroyed = false
    private val active = mutableSetOf<String>()
    private val postedAt = mutableMapOf<String, Long>()
    private val seen = linkedSetOf<String>()
    private var lastStatus = ""
    private val expire = Runnable { clearTasks() }
    private val poll = object : Runnable {
        override fun run() {
            val current = connection
            if (!destroyed && !busy && current != null) {
                busy = true
                worker.execute {
                    val result = runCatching { read(current) }
                    handler.post {
                        busy = false
                        if (!destroyed && connection === current) {
                            result.onSuccess { value ->
                                if (value == null) { clearTasks(); stopSelf() }
                                else applyFeed(value, current)
                            }.onFailure { clearTasks(); status("连接中断，正在重连") }
                        }
                    }
                }
            }
            if (!destroyed) handler.postDelayed(this, 2000)
        }
    }

    override fun onCreate() {
        super.onCreate()
        manager.createNotificationChannel(NotificationChannel("connection", "任务提醒连接", NotificationManager.IMPORTANCE_LOW))
        manager.createNotificationChannel(NotificationChannel("tasks", "任务与待处理提醒", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "完成、失败、等待审批及等待回答；隐藏会话与文件内容"
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        })
        val foreground = connectionNotification("任务提醒已开启")
        if (Build.VERSION.SDK_INT >= 34) startForeground(CONNECTION_ID, foreground, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        else startForeground(CONNECTION_ID, foreground)
        handler.post(poll)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val entry = runCatching { ServerEntry.parse(intent?.getStringExtra("origin").orEmpty(), intent?.getStringExtra("basePath").orEmpty(), BuildConfig.DEBUG) }.getOrNull()
        val cookie = intent?.getStringExtra("cookie").orEmpty()
        if (entry == null || cookie.isEmpty() || cookie.length > 8192 || cookie.contains('\n') || cookie.contains('\r')) {
            stopSelf(); return START_NOT_STICKY
        }
        if (connection?.entry != entry || connection?.cookie != cookie) {
            clearTasks(); connection = Connection(entry, cookie)
            seen.clear()
            runCatching {
                val saved = JSONArray(preferences.getString(entry.profileName, "[]"))
                for (i in 0 until minOf(saved.length(), 512)) saved.optString(i).takeIf(::noticeId)?.let { seen.add(it) }
            }
        }
        // Credentials live only in this non-exported service's memory. No boot
        // receiver, restart token, external push account or persisted cookie.
        return START_NOT_STICKY
    }

    private fun read(current: Connection): JSONObject? {
        val request = URL(current.entry.url + "notifications").openConnection() as HttpURLConnection
        try {
            request.connectTimeout = 5000; request.readTimeout = 5000
            request.instanceFollowRedirects = false
            request.setRequestProperty("Origin", current.entry.origin)
            request.setRequestProperty("X-Oraculum-Notifications", "1")
            request.setRequestProperty("Cookie", current.cookie)
            if (request.responseCode == 401) return null
            check(request.responseCode == 200)
            val bytes = ByteArray(65537)
            val length = request.inputStream.use { stream ->
                var used = 0
                while (used < bytes.size) { val count = stream.read(bytes, used, bytes.size - used); if (count < 0) break; used += count }
                used
            }
            check(length <= 65536)
            return JSONObject(String(bytes, 0, length, Charsets.UTF_8))
        } finally { request.disconnect() }
    }

    private fun applyFeed(feed: JSONObject, current: Connection) {
        runCatching {
            val generated = feed.getLong("generatedAt")
            val lease = feed.getLong("validUntil") - generated
            check(lease in 1..15000)
            val notices = feed.getJSONArray("notices"); check(notices.length() <= 64)
            val live = (0 until notices.length()).map { notices.getJSONObject(it) }.filter {
                noticeId(it.optString("id")) && copy.containsKey(it.optString("kind")) && it.optLong("expiresAt") > generated
            }
            val ids = live.map { it.getString("id") }.toSet()
            for (id in active.toList()) if (id !in ids) { manager.cancel(id, TASK_ID); active.remove(id); postedAt.remove(id) }
            for (notice in live) {
                val id = notice.getString("id")
                // Renew the short lease silently, while respecting an explicit
                // user dismissal. Never repost a dismissed/resolved reminder.
                if (id in seen && (id !in active || manager.activeNotifications.none { it.tag == id })) { active.remove(id); postedAt.remove(id); continue }
                val elapsed = android.os.SystemClock.elapsedRealtime()
                if (id in active && elapsed - (postedAt[id] ?: 0) < 10000) continue
                val intent = Intent(this, MainActivity::class.java).apply {
                    action = OPEN_NOTICE; data = Uri.parse("oraculum-notice:$id")
                    addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    putExtra("noticeEntry", current.entry.url)
                }
                val pending = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                val notification = Notification.Builder(this, "tasks")
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setContentTitle("神谕 · " + copy[notice.getString("kind")])
                    .setContentText("点击返回会话查看。")
                    .setContentIntent(pending).setAutoCancel(true).setOnlyAlertOnce(true)
                    .setVisibility(Notification.VISIBILITY_PRIVATE)
                    .setTimeoutAfter(minOf(lease, notice.getLong("expiresAt") - generated))
                    .build()
                manager.notify(id, TASK_ID, notification); active.add(id); seen.add(id); postedAt[id] = elapsed
            }
            while (seen.size > 512) seen.remove(seen.first())
            preferences.edit().putString(current.entry.profileName, JSONArray(seen.toList()).toString()).apply()
            handler.removeCallbacks(expire); handler.postDelayed(expire, lease)
            status("任务提醒已开启")
        }.onFailure { clearTasks() }
    }

    private fun connectionNotification(text: String): Notification = Notification.Builder(this, "connection")
        .setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle("神谕 · 后台任务提醒")
        .setContentText(text).setOngoing(true).setOnlyAlertOnce(true)
        .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE))
        .build()

    private fun status(text: String) { if (text != lastStatus) { lastStatus = text; manager.notify(CONNECTION_ID, connectionNotification(text)) } }
    private fun clearTasks() { for (id in active) manager.cancel(id, TASK_ID); active.clear(); postedAt.clear() }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() {
        destroyed = true; connection = null; handler.removeCallbacksAndMessages(null)
        worker.shutdownNow(); clearTasks(); stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy()
    }
    companion object {
        const val OPEN_NOTICE = "dev.oraculum.OPEN_NOTICE"
        private const val CONNECTION_ID = 7000
        private const val TASK_ID = 7001
        private val copy = mapOf("completed" to "任务已完成", "failed" to "任务执行失败", "approval" to "任务等待审批", "input" to "任务等待你的回答")
        fun noticeId(value: String): Boolean = Regex("^[a-f0-9-]{36}$").matches(value)
    }
}
