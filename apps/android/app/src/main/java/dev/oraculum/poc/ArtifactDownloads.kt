package dev.oraculum.poc

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.StatFs
import android.provider.DocumentsContract
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** One user-initiated transfer at a time; cookies never leave the HTTP request. */
class ArtifactDownloads(private val activity: Activity) {
    companion object { const val saveRequest = 4106 }
    private val executor = Executors.newSingleThreadExecutor()
    private val root = File(activity.cacheDir, "artifact-shares")
    private class Job(val action: ArtifactDownloadPolicy.Action, val current: () -> Boolean) {
        val cancelled = AtomicBoolean(false)
        @Volatile var connection: HttpURLConnection? = null
        @Volatile var destination: ParcelFileDescriptor? = null
        val saveCancellation = CancellationSignal()
        var directory: File? = null
        var file: File? = null
        var metadata: ArtifactDownloadPolicy.Metadata? = null
        var dialog: AlertDialog? = null
    }
    private var job: Job? = null
    private var pendingSave: Job? = null
    private var pickerPending = false
    val busy: Boolean get() = job != null || pickerPending
    private val handler = Handler(Looper.getMainLooper())

    init {
        // Only this narrow private cache tree. Shared URIs expire on next cleanup;
        // retain four previous outputs before creating the next; the byte budget
        // includes the current/most recently completed output as well.
        prune()
    }
    private fun prune() {
        root.mkdirs()
        root.listFiles()?.sortedByDescending { it.lastModified() }?.forEachIndexed { i, folder ->
            if (i >= 4 || System.currentTimeMillis() - folder.lastModified() > 24 * 60 * 60 * 1000L) folder.deleteRecursively()
        }
    }
    fun begin(action: ArtifactDownloadPolicy.Action, target: ServerEntry, cookie: String?, current: () -> Boolean) {
        if (job != null || pickerPending || !current()) { toast("已有文件操作正在进行，请完成或取消后再试。"); return }
        val credential = ArtifactDownloadPolicy.cookie(cookie, target) ?: run { toast("设备授权不可用，请重新配对。"); return }
        prune()
        // Keep total private cache use bounded even before the next app launch.
        if ((root.listFiles()?.sumOf { folder -> folder.walkTopDown().filter { it.isFile }.sumOf { it.length() } } ?: 0) + ArtifactDownloadPolicy.maxBytes > 320L * 1024 * 1024 ||
            StatFs(activity.cacheDir.path).availableBytes < ArtifactDownloadPolicy.maxBytes + 32L * 1024 * 1024) { toast("设备可用空间不足，请稍后重试。"); return }
        val next = Job(action, current); job = next
        next.directory = File(root, UUID.randomUUID().toString()).apply { mkdir() }
        val label = TextView(activity).apply { text = "正在连接…"; setPadding(24, 20, 24, 12) }
        val progress = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply { max = 1000 }
        val content = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; addView(label); addView(progress) }
        next.dialog = AlertDialog.Builder(activity).setTitle("取得成果文件").setView(content)
            .setNegativeButton("取消") { _, _ -> cancel(next) }.setOnCancelListener { cancel(next) }.create().also { it.show() }
        executor.execute {
            var connection: HttpURLConnection? = null
            val deadline = Runnable { cancel(next) }
            handler.postDelayed(deadline, 180000)
            try {
                val started = System.nanoTime()
                connection = URL(target.url + "artifacts/content/" + action.id).openConnection() as HttpURLConnection
                next.connection = connection
                connection.instanceFollowRedirects = false; connection.connectTimeout = 15000; connection.readTimeout = 15000
                connection.requestMethod = "POST"; connection.doOutput = true; connection.setFixedLengthStreamingMode(0)
                connection.useCaches = false
                connection.setRequestProperty("Origin", target.origin)
                connection.setRequestProperty("X-Oraculum-Artifact", "1")
                connection.setRequestProperty("Cookie", credential)
                connection.setRequestProperty("Accept-Encoding", "identity")
                connection.outputStream.use { }
                require(connection.responseCode == 200) { "下载未完成，文件或授权已变化" }
                val metadata = ArtifactDownloadPolicy.metadata(connection.contentType, connection.getHeaderField("Content-Length"),
                    connection.getHeaderField("Content-Disposition"), connection.getHeaderField("X-Oraculum-SHA256"))
                next.metadata = metadata
                val file = File(next.directory!!, metadata.name); next.file = file
                var update = 0L
                connection.inputStream.use { input -> file.outputStream().use { output ->
                    ArtifactDownloadPolicy.copy(input, output, metadata,
                        { next.cancelled.get() || System.nanoTime() - started > 180_000_000_000L }) { count ->
                        val now = System.nanoTime()
                        if (now - update > 100_000_000L || count == metadata.size) {
                            update = now
                            activity.runOnUiThread { if (job === next && !next.cancelled.get()) {
                                label.text = activity.getString(R.string.artifact_transfer_progress, metadata.name, count / 1024, metadata.size / 1024)
                                progress.progress = if (metadata.size == 0L) 1000 else (count * 1000 / metadata.size).toInt()
                            } }
                        }
                    }
                } }
                check(!next.cancelled.get())
                activity.runOnUiThread { complete(next) }
            } catch (_: Exception) {
                activity.runOnUiThread { if (job === next) { finish(next, false); toast(if (next.cancelled.get()) "已取消下载。" else "下载未完成，请刷新文件并重试；检查网络或设备授权。") } }
            } finally { handler.removeCallbacks(deadline); connection?.disconnect(); next.connection = null }
        }
    }
    private fun complete(next: Job) {
        if (job !== next || next.cancelled.get() || !next.current()) { finish(next, false); return }
        next.dialog?.dismiss(); next.dialog = null
        val metadata = next.metadata!!
        if (next.action.mode == "save") {
            pickerPending = true; pendingSave = next
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE); type = metadata.mime; putExtra(Intent.EXTRA_TITLE, metadata.name)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
            try {
                @Suppress("DEPRECATION")
                activity.startActivityForResult(intent, saveRequest)
            } catch (_: Exception) { pickerPending = false; pendingSave = null; finish(next, false); toast("系统保存选择器不可用。") }
        } else {
            try {
                val uri = FileProvider.getUriForFile(activity, activity.packageName + ".artifacts", next.file!!)
                val intent = if (next.action.mode == "share") Intent(Intent.ACTION_SEND).apply {
                    type = metadata.mime; putExtra(Intent.EXTRA_STREAM, uri)
                } else Intent(Intent.ACTION_VIEW).apply { setDataAndType(uri, metadata.mime) }
                intent.clipData = ClipData.newRawUri(metadata.name, uri)
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                activity.startActivity(Intent.createChooser(intent, if (next.action.mode == "share") "分享成果" else "打开成果"))
                finish(next, true)
            } catch (_: Exception) { finish(next, false); toast("没有可用的应用，请选择保存到设备后打开。") }
        }
    }
    fun activityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != saveRequest) return false
        pickerPending = false
        val next = pendingSave ?: return true
        pendingSave = null
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null || uri.scheme != "content" || uri.authority == null || uri.authority!!.startsWith(activity.packageName) ||
            data.flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION == 0) { finish(next, false); toast("已取消保存。"); return true }
        // Reject any provider owned by this app, not just our public authority.
        @Suppress("DEPRECATION")
        val ownProvider = runCatching { activity.packageManager.resolveContentProvider(uri.authority!!, 0)?.applicationInfo?.uid == activity.applicationInfo.uid }.getOrDefault(true)
        if (ownProvider) { finish(next, false); toast("保存位置无效。"); return true }
        if (job !== next || next.cancelled.get() || !next.current()) {
            // ACTION_CREATE_DOCUMENT has already created a new document even if
            // navigation canceled our operation while the system picker was open.
            executor.execute {
                runCatching { DocumentsContract.deleteDocument(activity.contentResolver, uri) }
                activity.runOnUiThread { finish(next, false); toast("已取消保存。"); }
            }
            return true
        }
        val label = TextView(activity).apply { text = activity.getString(R.string.artifact_saving, next.metadata!!.name); setPadding(24, 20, 24, 12) }
        val progress = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply { max = 1000 }
        val content = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; addView(label); addView(progress) }
        next.dialog = AlertDialog.Builder(activity).setTitle("保存成果文件").setView(content)
            .setNegativeButton("取消") { _, _ -> cancel(next) }.setOnCancelListener { cancel(next) }.create().also { it.show() }
        executor.execute {
            var success = false
            val deadline = Runnable { cancel(next) }
            handler.postDelayed(deadline, 180000)
            try {
                val descriptor = activity.contentResolver.openFileDescriptor(uri, "w", next.saveCancellation) ?: throw IllegalStateException()
                next.destination = descriptor
                next.file!!.inputStream().use { input -> ParcelFileDescriptor.AutoCloseOutputStream(descriptor).use { output ->
                    ArtifactDownloadPolicy.copy(input, output, next.metadata!!, { next.cancelled.get() }) { count ->
                        activity.runOnUiThread { if (job === next && !next.cancelled.get()) progress.progress =
                            if (next.metadata!!.size == 0L) 1000 else (count * 1000 / next.metadata!!.size).toInt() }
                    }
                } }
                success = true
            } catch (_: Exception) {
                // The selected document was just created for this operation. Never
                // overwrite/retry another target or leave an incomplete result silently.
                runCatching { DocumentsContract.deleteDocument(activity.contentResolver, uri) }
            } finally { handler.removeCallbacks(deadline); next.destination = null }
            activity.runOnUiThread { finish(next, false); toast(if (success) "文件已保存。" else "保存未完成，请重新选择位置。") }
        }
        return true
    }
    private fun cancel(next: Job) {
        next.cancelled.set(true); next.connection?.disconnect()
        next.saveCancellation.cancel(); runCatching { next.destination?.close() }
        // A pending SAF activity keeps its result pairing; no second picker can
        // consume its response. Navigation invalidates its eventual result.
        if (pendingSave !== next) next.dialog?.dismiss()
    }
    fun invalidate() { job?.let { cancel(it); if (pendingSave === it) finish(it, false) }; pendingSave?.cancelled?.set(true) }
    fun close() { invalidate(); executor.shutdownNow() }
    private fun finish(next: Job, retained: Boolean) {
        next.dialog?.dismiss(); next.dialog = null
        if (!retained) next.directory?.deleteRecursively()
        if (job === next) job = null
    }
    private fun toast(message: String) { if (!activity.isDestroyed) Toast.makeText(activity, message, Toast.LENGTH_LONG).show() }
}
