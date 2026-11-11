package dev.oraculum.poc.ui

/** Display-only models. Native IDs remain opaque and are passed back unchanged. */
data class RootOption(val id: String, val label: String)
data class ProjectOption(val id: String, val label: String, val detail: String = "")
data class ThreadOption(val id: String, val label: String, val detail: String = "")
data class ChatMessage(
    val id: String,
    val role: String,
    val text: String,
    val status: String = "",
)

data class PocUiState(
    val endpoint: String = "",
    val paired: Boolean = false,
    val connectionLabel: String = "尚未配对",
    val online: Boolean = false,
    val busy: Boolean = false,
    val error: String? = null,
    val roots: List<RootOption> = emptyList(),
    val projects: List<ProjectOption> = emptyList(),
    val threads: List<ThreadOption> = emptyList(),
    val selectedProjectId: String? = null,
    val selectedThreadId: String? = null,
    val messages: List<ChatMessage> = emptyList(),
    val draft: String = "",
    val executionLabel: String = "",
    val canSend: Boolean = false,
    val canStop: Boolean = false,
    val canResume: Boolean = false,
    val canLoadMore: Boolean = false,
    val unknownWarning: String? = null,
    val historyWarning: String? = null,
    val readIndex: Int = 0,
    val readOffset: Int = 0,
)

data class PocActions(
    val onEndpointChange: (String) -> Unit = {},
    val onPair: (String) -> Unit = {},
    val onReconnect: () -> Unit = {},
    val onRefresh: () -> Unit = {},
    val onSelectProject: (String) -> Unit = {},
    val onRegisterProject: (String, String) -> Unit = { _, _ -> },
    val onSelectThread: (String) -> Unit = {},
    val onCreateThread: () -> Unit = {},
    val onDraftChange: (String) -> Unit = {},
    val onSend: () -> Unit = {},
    val onStop: () -> Unit = {},
    val onResume: () -> Unit = {},
    val onLoadMore: () -> Unit = {},
    val onReadPosition: (Int, Int) -> Unit = { _, _ -> },
    val onClearCache: () -> Unit = {},
    val onDisconnect: () -> Unit = {},
)
