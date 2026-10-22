package dev.oraculum.poc

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.media.AudioManager
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.view.KeyEvent
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream

class MainActivity : Activity() {
    private var web: WebView? = null
    private lateinit var layout: LinearLayout
    private lateinit var recovery: LinearLayout
    private lateinit var recoveryMessage: TextView
    private var settingsDialog: AlertDialog? = null
    private var backPending = false
    private var pageFailed = false
    private val preferences by lazy { getSharedPreferences("server-entry", MODE_PRIVATE) }
    private val defaultEntry by lazy {
        if (BuildConfig.ORACULUM_ORIGIN.isNotEmpty()) ServerEntry.parse(
            BuildConfig.ORACULUM_ORIGIN, BuildConfig.ORACULUM_BASE_PATH, BuildConfig.DEBUG)
        else if (BuildConfig.DEBUG) ServerEntry.parse(ServerEntry.DEBUG_ORIGIN, "/", true)
        else null
    }
    private var entry: ServerEntry? = null
    private val cyan = Color.rgb(136, 220, 239)
    private val ink = Color.rgb(232, 240, 242)
    private var backCallback: OnBackInvokedCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 30) window.setDecorFitsSystemWindows(false)
        entry = loadEntry()
        // An upgrade keeps its existing default cookie/storage profile bound to its original entry.
        // Later build-default changes must never assign that profile to a different server.
        if (!preferences.contains("defaultProfileEntry")) {
            preferences.edit().putString("defaultProfileEntry", defaultEntry?.url ?: entry?.url.orEmpty()).apply()
        }
        layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.BLACK)
            setOnApplyWindowInsetsListener { view, insets ->
                if (Build.VERSION.SDK_INT >= 30) {
                    val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                    val ime = insets.getInsets(WindowInsets.Type.ime())
                    view.setPadding(safe.left, safe.top, safe.right, maxOf(safe.bottom, ime.bottom))
                } else {
                    @Suppress("DEPRECATION")
                    view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                        insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
                }
                insets
            }
        }
        recovery = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(8))
            setBackgroundColor(Color.rgb(12, 18, 22))
        }
        recoveryMessage = TextView(this).apply { setTextColor(ink); textSize = 15f }
        recovery.addView(recoveryMessage)
        recovery.addView(LinearLayout(this).apply {
            addView(actionButton("重试") { loadWebView() }, LinearLayout.LayoutParams(0, -2, 1f))
            addView(actionButton("服务器设置") { showServerSettings() }, LinearLayout.LayoutParams(0, -2, 1f))
        })
        recovery.addView(actionButton("恢复默认主题") { restoreDefaultTheme() })
        layout.addView(recovery)
        setContentView(layout)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        if (Build.VERSION.SDK_INT >= 33) {
            backCallback = OnBackInvokedCallback { handleBack() }
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback!!)
        }
        loadWebView()
    }

    private fun loadEntry(): ServerEntry? {
        val origin = preferences.getString("origin", null) ?: return defaultEntry
        return runCatching { ServerEntry.parse(origin, preferences.getString("basePath", "/") ?: "/", BuildConfig.DEBUG) }
            .getOrElse { defaultEntry }
    }

    private fun profileSupported(target: ServerEntry): Boolean =
        target.usesDefaultProfile(preferences.getString("defaultProfileEntry", "").orEmpty()) ||
            WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)

    private fun showRecovery(message: String) {
        pageFailed = true
        // Keep recovery actionable without showing Chromium's unrelated error document below it.
        web?.visibility = View.INVISIBLE
        recoveryMessage.text = message
        recovery.visibility = View.VISIBLE
    }

    private fun loadWebView() {
        destroyWebView()
        val target = entry ?: run { showRecovery("请设置可信的 HTTPS 服务器地址"); return }
        if (!profileSupported(target)) {
            showRecovery("当前 Android System WebView 不支持隔离服务器登录。请更新 WebView，或恢复原服务器地址。")
            return
        }
        pageFailed = false
        recovery.visibility = View.GONE
        val view = WebView(this)
        if (!target.usesDefaultProfile(preferences.getString("defaultProfileEntry", "").orEmpty())) {
            // Must precede every other WebView call. Each entry retains its own HttpOnly cookies,
            // local storage and pairing; no secret is read, copied, migrated or deleted by the shell.
            if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
                WebViewCompat.setProfile(view, target.profileName)
            } else {
                view.destroy()
                showRecovery("当前 WebView 不支持隔离服务器登录，请先更新 WebView。")
                return
            }
        }
        web = view
        view.apply {
            setBackgroundColor(Color.BLACK)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.setSupportMultipleWindows(false)
            settings.setGeolocationEnabled(false)
            settings.userAgentString += " OraculumAndroid/1"
            cookieManager(this).setAcceptThirdPartyCookies(this, false)
            // No addJavascriptInterface, file picker, OS bridge, or credential API.
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (view !== web) return true
                    if (request.url.toString() == "oraculum://settings/server") {
                        if (request.isForMainFrame && request.hasGesture() && !request.isRedirect &&
                            target.trusts(view.url.orEmpty())) showServerSettings()
                        return true
                    }
                    return !target.trusts(request.url.toString())
                }

                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    if (target.trusts(request.url.toString())) null else WebResourceResponse(
                        "text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (view !== web) return
                    if (request.isForMainFrame) {
                        showRecovery("无法连接服务器 · 检查网络或服务器地址后重试")
                    }
                }

                override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                    if (view !== web) return
                    if (request.isForMainFrame) {
                        showRecovery("服务器未提供界面（HTTP ${response.statusCode}）· 检查地址后重试")
                    }
                }

                override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                    handler.cancel()
                    if (view !== web) return
                    showRecovery("TLS 证书验证失败 · 请检查服务器证书与地址")
                }

                override fun onPageFinished(view: WebView, url: String) {
                    if (view !== web) return
                    if (!pageFailed && target.trusts(url) && view.title == "Oraculum · 神谕") {
                        recovery.visibility = View.GONE
                        if (preferences.getString("themeRecoveryEntry", null) == target.url) {
                            preferences.edit().remove("themeRecoveryEntry").apply()
                        }
                    }
                    else if (!pageFailed) showRecovery("服务器未返回神谕界面 · 请检查 Origin 与 Base Path")
                }

                override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                    if (view !== web) return
                    if (!target.trusts(url)) {
                        view.stopLoading()
                        showRecovery("已阻止离开可信服务器入口")
                    } else {
                        // A fresh trusted navigation may recover from an earlier failure without
                        // recreating this WebView. Later HTTP/TLS callbacks still fail this load.
                        pageFailed = false
                        recovery.visibility = View.GONE
                        view.visibility = View.VISIBLE
                    }
                }
            }
        }
        layout.addView(view, LinearLayout.LayoutParams(-1, 0, 1f))
        view.loadUrl(target.url + if (preferences.getString("themeRecoveryEntry", null) == target.url) "?theme=default" else "")
    }

    private fun restoreDefaultTheme() {
        val target = entry ?: return
        // Only a trusted-entry navigation. No JS interface, cookie export or OS
        // capability is exposed to the page. Keep a failed/offline reset pending.
        preferences.edit().putString("themeRecoveryEntry", target.url).apply()
        settingsDialog?.dismiss()
        loadWebView()
    }

    private fun showThemeRecovery() {
        if (settingsDialog != null) return
        val dialog = AlertDialog.Builder(this).setTitle("神谕 · 界面恢复")
            .setMessage("恢复 Oracle Eye 默认主题。保留服务器、登录和会话；主机任务继续运行。")
            .setPositiveButton("恢复默认主题") { _, _ -> restoreDefaultTheme() }
            .setNegativeButton("取消", null).create()
        settingsDialog = dialog
        dialog.setOnDismissListener { settingsDialog = null }
        dialog.show()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP) {
            if (event.repeatCount == 0) event.startTracking()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyLongPress(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP) { showThemeRecovery(); return true }
        return super.onKeyLongPress(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP) {
            if (!event.isCanceled) (getSystemService(AUDIO_SERVICE) as AudioManager)
                .adjustVolume(AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI)
            return true
        }
        return super.onKeyUp(keyCode, event)
    }

    private fun cookieManager(view: WebView): CookieManager =
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) WebViewCompat.getProfile(view).cookieManager
        else CookieManager.getInstance()

    private fun showServerSettings() {
        if (settingsDialog != null) return
        val fields = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(12), dp(24), dp(8))
        }
        fun label(text: String) = TextView(this).apply {
            this.text = text; setTextColor(ink); textSize = 14f
            setPadding(0, dp(12), 0, dp(4)); fields.addView(this)
        }
        fun input(value: String, hint: String) = EditText(this).apply {
            setText(value); this.hint = hint; setTextColor(ink); setHintTextColor(Color.GRAY)
            textSize = 16f; minHeight = dp(48); isSingleLine = true
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            fields.addView(this, LinearLayout.LayoutParams(-1, -2))
        }
        label("HTTPS Origin")
        val origin = input(entry?.origin.orEmpty(), "https://example.com")
        label("Base Path")
        val path = input(entry?.basePath ?: "/", "/")
        label("新入口需独立配对。切回原入口会保留登录与草稿。更改地址不会停止主机正在执行的任务。")
        val error = TextView(this).apply { setTextColor(Color.rgb(255, 157, 157)); textSize = 14f; fields.addView(this) }
        if (defaultEntry != null) fields.addView(actionButton("使用构建默认地址") {
            origin.setText(defaultEntry!!.origin); path.setText(defaultEntry!!.basePath); error.text = ""
        })
        if (BuildConfig.DEBUG) fields.addView(actionButton("使用 USB / ADB reverse") {
            origin.setText(ServerEntry.DEBUG_ORIGIN); path.setText("/"); error.text = ""
        })
        val dialog = AlertDialog.Builder(this).setTitle("服务器地址")
            .setView(ScrollView(this).apply { addView(fields) })
            .setNegativeButton("取消", null).setPositiveButton("保存并连接", null).create()
        settingsDialog = dialog
        dialog.setOnDismissListener { settingsDialog = null }
        dialog.setOnShowListener {
            dialog.window?.setBackgroundDrawableResource(android.R.color.background_dark)
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).apply { setTextColor(cyan); minHeight = dp(48) }
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).apply {
                setTextColor(cyan); minHeight = dp(48)
                setOnClickListener {
                    val next = try { ServerEntry.parse(origin.text.toString(), path.text.toString(), BuildConfig.DEBUG) }
                    catch (invalid: IllegalArgumentException) { error.text = invalid.message; return@setOnClickListener }
                    if (!profileSupported(next)) {
                        error.text = "请先更新 Android System WebView，以隔离不同服务器的登录。原入口与数据保持不变。"
                        return@setOnClickListener
                    }
                    preferences.edit().putString("origin", next.origin).putString("basePath", next.basePath).apply()
                    if (next != entry) {
                        entry = next
                        loadWebView()
                    } else if (pageFailed || web == null) loadWebView()
                    dialog.dismiss()
                }
            }
        }
        dialog.show()
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() { handleBack() }

    private fun handleBack() {
        val active = web
        if (Build.VERSION.SDK_INT >= 30 && window.decorView.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true) {
            window.insetsController?.hide(WindowInsets.Type.ime())
            return
        }
        if (settingsDialog != null) { settingsDialog?.dismiss(); return }
        if (active == null || entry?.trusts(active.url.orEmpty()) != true || pageFailed) { moveTaskToBack(true); return }
        if (backPending) return
        backPending = true
        // The host asks one boolean question only; web content receives no native API or credentials.
        active.evaluateJavascript("Boolean(window.oraculumAndroidBack && window.oraculumAndroidBack())") { handled ->
            backPending = false
            if (web === active && handled != "true") moveTaskToBack(true)
        }
    }

    override fun onPause() {
        web?.let { cookieManager(it).flush() }
        super.onPause()
    }

    private fun destroyWebView() {
        web?.let {
            cookieManager(it).flush()
            it.stopLoading()
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
        }
        web = null
        backPending = false
    }

    override fun onDestroy() {
        if (Build.VERSION.SDK_INT >= 33) backCallback?.let { onBackInvokedDispatcher.unregisterOnBackInvokedCallback(it) }
        settingsDialog?.dismiss()
        destroyWebView()
        super.onDestroy()
    }

    private fun actionButton(label: String, action: () -> Unit) = Button(this).apply {
        text = label; isAllCaps = false; minHeight = dp(48); setTextColor(cyan)
        setOnClickListener { action() }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
