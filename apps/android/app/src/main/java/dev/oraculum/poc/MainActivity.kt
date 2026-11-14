package dev.oraculum.poc

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.net.Uri
import android.widget.Toast
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
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.oraculum.poc.notifications.GatewayNotifications
import dev.oraculum.poc.ui.OraculumScreen
import dev.oraculum.poc.ui.OraculumTheme
import dev.oraculum.poc.ui.PocActions
import dev.oraculum.poc.storage.AvatarStore
import dev.oraculum.poc.storage.ClientPreferences
import dev.oraculum.poc.storage.commitAvatarSelection
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** Native workspace; all execution remains behind the Gateway and official Harness. */
class MainActivity : ComponentActivity() {
    lateinit var model: PocViewModel
        private set
    private var notificationsEnabled by mutableStateOf(false)
    private var avatarJob: Job? = null
    private val avatarPicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) updateAvatar(uri)
    }
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
            OraculumTheme(mode = state.themeMode, readingScale = state.readingScale, accentColor = state.accentColor) {
                OraculumScreen(state, PocActions(
                    onEndpointChange = model::endpointChange,
                    onPair = model::pair,
                    onReconnect = model::reconnect,
                    onRefresh = model::refresh,
                    onRefreshConversation = model::refreshConversation,
                    onSelectProject = model::selectProject,
                    onProjectSortChange = model::projectSortChange,
                    onThreadSortChange = model::threadSortChange,
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
                    onAccentChange = model::accentChange,
                    onPickAvatar = { if (avatarJob?.isActive != true) avatarPicker.launch(arrayOf("image/jpeg", "image/png", "image/webp")) },
                    onRemoveAvatar = { updateAvatar(null) },
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
                    onRenameThread = model::renameThread,
                    onArchiveThread = model::archiveThread,
                    onUnarchiveThread = model::unarchiveThread,
                    onDeleteThread = model::deleteThread,
                    onShowArchivedThreads = model::showArchivedThreads,
                    onLoadMoreArchivedThreads = model::loadMoreArchivedThreads,
                    onForkThread = model::forkThread,
                    onRevertThread = model::revertThread,
                    onCompactThread = model::compactThread,
                    onSteer = model::steer,
                    onRefreshAccount = model::refreshAccount,
                    onRefreshNativeDefaults = model::refreshNativeDefaults,
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

    private fun updateAvatar(uri: Uri?) {
        if (avatarJob?.isActive == true) return
        avatarJob = lifecycleScope.launch {
            val avatars = AvatarStore(applicationContext)
            val preferences = ClientPreferences(applicationContext)
            try {
                commitAvatarSelection(preferences,
                    importAvatar = { if (uri == null) null else avatars.importAvatar(uri) },
                    deleteAvatar = avatars::delete,
                    onCommitted = { model.refreshLocalAvatar() })
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                Toast.makeText(this@MainActivity, "头像未更改。请选择完整的 JPG、PNG 或 WebP 图片（最多 8 MB）。", Toast.LENGTH_LONG).show()
            }
        }
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
