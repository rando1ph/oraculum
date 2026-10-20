package dev.oraculum.poc

import android.app.Activity
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import java.io.ByteArrayInputStream

class MainActivity : Activity() {
    private lateinit var web: WebView
    private val entry = "http://127.0.0.1:17860/"

    private fun trusted(uri: Uri): Boolean =
        BuildConfig.DEBUG && uri.scheme == "http" && uri.host == "127.0.0.1" &&
            uri.port == 17860 && uri.userInfo == null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.BLACK)
            setOnApplyWindowInsetsListener { view, insets ->
                view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
                insets
            }
        }
        val retry = Button(this).apply {
            text = "无法加载本机界面 · 检查 ADB reverse 后重试"
            visibility = View.GONE
            setOnClickListener { web.loadUrl(entry) }
        }
        web = WebView(this).apply {
            setBackgroundColor(Color.BLACK)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.setSupportMultipleWindows(false)
            // No addJavascriptInterface, file picker, OS bridge, or credential API.
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) =
                    !trusted(request.url)

                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    if (trusted(request.url)) null else WebResourceResponse(
                        "text/plain", "UTF-8", 403, "Blocked", emptyMap(),
                        ByteArrayInputStream(ByteArray(0)))

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) retry.visibility = View.VISIBLE
                }

                override fun onPageFinished(view: WebView, url: String) {
                    if (trusted(Uri.parse(url)) && view.title == "Oraculum · 神谕") retry.visibility = View.GONE
                }
            }
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        layout.addView(retry)
        layout.addView(web, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(layout)
        if (BuildConfig.DEBUG) web.loadUrl(entry) else retry.apply {
            text = "Phase 0B 仅提供本地 debug 原型"
            visibility = View.VISIBLE
            isEnabled = false
        }
    }

    override fun onDestroy() {
        (web.parent as? ViewGroup)?.removeView(web)
        web.destroy()
        super.onDestroy()
    }
}
