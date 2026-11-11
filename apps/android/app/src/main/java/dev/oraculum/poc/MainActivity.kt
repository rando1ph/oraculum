package dev.oraculum.poc

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.view.WindowCompat
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.oraculum.poc.notifications.GatewayNotifications
import dev.oraculum.poc.ui.OraculumScreen
import dev.oraculum.poc.ui.OraculumTheme
import dev.oraculum.poc.ui.PocActions

/** Native workspace; all execution remains behind the Gateway and official Harness. */
class MainActivity : ComponentActivity() {
    lateinit var model: PocViewModel
        private set
    private var notificationsEnabled by mutableStateOf(false)
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        notificationsEnabled = GatewayNotifications.notificationsEnabled(this)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        model = ViewModelProvider(this)[PocViewModel::class.java]
        setContent {
            val state by model.state.collectAsStateWithLifecycle()
            val filesState by model.files.state.collectAsStateWithLifecycle()
            SideEffect {
                val light = state.themeMode == "light"
                WindowCompat.getInsetsController(window, window.decorView).apply {
                    isAppearanceLightStatusBars = light
                    isAppearanceLightNavigationBars = light
                }
            }
            OraculumTheme(mode = state.themeMode, readingScale = state.readingScale) {
                OraculumScreen(state, PocActions(
                    onEndpointChange = model::endpointChange,
                    onPair = model::pair,
                    onReconnect = model::reconnect,
                    onRefresh = model::refresh,
                    onSelectProject = model::selectProject,
                    onRegisterProject = model::registerProject,
                    onSelectThread = model::selectThread,
                    onCreateThread = model::createThread,
                    onDraftChange = model::draftChange,
                    onSend = model::send,
                    onStop = model::stop,
                    onResume = model::resume,
                    onLoadMore = model::loadMore,
                    onReadPosition = model::readPosition,
                    onClearCache = model::clearCache,
                    onDisconnect = model::disconnect,
                    onThemeChange = model::themeChange,
                    onIdentityLabelsChange = model::identityLabelsChange,
                    onReadingScaleChange = model::readingScaleChange,
                    onSelectModel = model::selectModel,
                    onSelectEffort = model::selectEffort,
                    onSelectPermission = model::selectPermission,
                    onBrowseDirectory = model::browseDirectory,
                    onLoadMoreDirectories = model::loadMoreDirectories,
                    onLoadMoreThreads = model::loadMoreThreads,
                    onRespondInteraction = model::respondInteraction,
                    onRespondFileChange = model::respondFileChange,
                    onRefreshInspector = model::refreshInspector,
                    onLoadItemDetail = model::loadItemDetail,
                    onQueryOperation = model::queryOperation,
                    onRefreshOperationThread = model::refreshOperationThread,
                ), filesState = filesState, filesActions = model.files.actions(),
                    notificationEnabled = notificationsEnabled,
                    onNotificationSettings = ::configureNotifications)
            }
        }
        if (savedInstanceState == null) openNotification(intent)
    }

    override fun onStart() {
        super.onStart()
        model.onForegroundChanged(true)
    }

    override fun onResume() {
        super.onResume()
        notificationsEnabled = GatewayNotifications.notificationsEnabled(this)
    }

    override fun onStop() {
        model.onForegroundChanged(false)
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openNotification(intent)
    }

    private fun openNotification(intent: Intent?) {
        intent ?: return
        GatewayNotifications.readRoute(intent)?.let(model::openNotification)
    }

    private fun configureNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && GatewayNotifications.permissionRequired(this)) {
            val preferences = getSharedPreferences("oraculum-v2-notification-permission", MODE_PRIVATE)
            val alreadyRequested = preferences.getBoolean("requested", false)
            if (!alreadyRequested || shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) {
                preferences.edit().putBoolean("requested", true).apply()
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                return
            }
        }
        startActivity(GatewayNotifications.settingsIntent(this))
    }
}
