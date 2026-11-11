package dev.oraculum.poc

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.getValue
import dev.oraculum.poc.ui.OraculumScreen
import dev.oraculum.poc.ui.OraculumTheme
import dev.oraculum.poc.ui.PocActions

/** Native Phase 2 client. The official Harness remains behind Gateway. */
class MainActivity : ComponentActivity() {
    lateinit var model: PocViewModel
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        model = ViewModelProvider(this)[PocViewModel::class.java]
        setContent {
            val state by model.state.collectAsStateWithLifecycle()
            OraculumTheme {
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
                ))
            }
        }
    }
}
