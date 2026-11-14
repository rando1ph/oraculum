package dev.oraculum.poc.ui

import dev.oraculum.poc.repository.InteractionUi
import dev.oraculum.gateway.protocol.NativeDefaults
import dev.oraculum.gateway.protocol.AccountRateLimits
import dev.oraculum.gateway.protocol.AccountUsage
import kotlinx.serialization.json.JsonObject

/** Display-only models. Native IDs remain opaque and are passed back unchanged. */
data class RootOption(val id: String, val label: String)
data class ProjectOption(val id: String, val label: String, val detail: String = "")
data class ThreadOption(val id: String, val label: String, val detail: String = "", val archived: Boolean = false)
data class ChatMessage(
    val id: String,
    val role: String,
    val text: String,
    val status: String = "",
    val turnId: String = "",
    val detailsRequired: Boolean = false,
    val phase: String? = null,
    val needsAttention: Boolean = false,
    val timestampMillis: Long? = null,
    val turn: TurnMetadataUi? = null,
)

/** Optional native facts only. Missing counters and producer timestamps remain unknown. */
data class TokenCountsUi(
    val totalTokens: Long? = null,
    val inputTokens: Long? = null,
    val cachedInputTokens: Long? = null,
    val cacheWriteInputTokens: Long? = null,
    val outputTokens: Long? = null,
    val reasoningOutputTokens: Long? = null,
)
data class TokenUsageUi(
    val total: TokenCountsUi = TokenCountsUi(),
    val last: TokenCountsUi = TokenCountsUi(),
    val modelContextWindow: Long? = null,
    val turnId: String? = null,
)
data class TurnMetadataUi(
    val status: String = "",
    val startedAtMillis: Long? = null,
    val completedAtMillis: Long? = null,
    val durationMs: Long? = null,
    val usage: TokenCountsUi? = null,
)

data class PermissionReadbackUi(val sandboxType: String, val approvalPolicy: String, val preset: String?, val observedAt: Long, val source: String)

data class ModelOption(val id: String, val label: String, val efforts: List<String>, val defaultEffort: String? = null, val description: String = "")
data class DirectoryOption(val name: String, val path: String)
data class DirectoryUiState(val rootId: String = "", val path: String = "", val entries: List<DirectoryOption> = emptyList(), val canRegister: Boolean = false, val canLoadMore: Boolean = false, val limited: Boolean = false)
data class UnknownOperationUi(val operationId: String, val kind: String, val projectId: String, val threadId: String?, val createdAt: Long, val status: String, val delivery: String, val nativeThreadId: String? = null, val nativeTurnId: String? = null)
data class InspectorEntry(val id: String, val title: String, val body: String, val status: String = "", val turnId: String = "", val itemId: String = "", val detailsRequired: Boolean = false)
data class ExtensionSectionUi(val kind: String, val status: String, val entries: List<InspectorEntry> = emptyList(), val limited: Boolean = false, val reason: String? = null)
data class InspectorUiState(
    val execution: List<InspectorEntry> = emptyList(),
    val plan: List<InspectorEntry> = emptyList(),
    val diff: String? = null,
    val agents: List<InspectorEntry> = emptyList(),
    val usage: String? = null,
    val tokenUsage: TokenUsageUi? = null,
    val extensions: List<ExtensionSectionUi> = emptyList(),
    val detailTitle: String? = null,
    val detailText: String? = null,
    val detailProgress: String? = null,
    val limitations: List<String> = listOf("Plan 模式和插件安装未开放"),
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
    val canCreateThread: Boolean = false,
    val canStop: Boolean = false,
    val canResume: Boolean = false,
    val canLoadMore: Boolean = false,
    val unknownWarning: String? = null,
    val historyWarning: String? = null,
    val readIndex: Int = 0,
    val readOffset: Int = 0,
    val themeMode: String = "dark",
    val accentColor: String = "matcha",
    val avatarFileName: String? = null,
    val userLabel: String = "你",
    val assistantLabel: String = "Oraculum",
    val readingScale: Float = 1f,
    val actualModel: String? = null,
    val actualEffort: String? = null,
    val models: List<ModelOption> = emptyList(),
    val modelsLimited: Boolean = false,
    val selectedModel: String? = null,
    val selectedEffort: String? = null,
    val permissionPreset: String = "native",
    val actualPermissionPreset: String? = null,
    val permissionReadback: PermissionReadbackUi? = null,
    val directory: DirectoryUiState = DirectoryUiState(),
    val canLoadMoreThreads: Boolean = false,
    val interactions: List<InteractionUi> = emptyList(),
    val inspector: InspectorUiState = InspectorUiState(),
    val unresolvedOperations: List<UnknownOperationUi> = emptyList(),
    val operationStatusMessage: String? = null,
    val capabilityNames: Set<String> = emptySet(),
    val gatewayProtocolMinor: Long = 0,
    val navigationRequest: String? = null,
    val nativeDefaults: NativeDefaults? = null,
    val nativeDefaultsError: String? = null,
    val accountRateLimits: AccountRateLimits? = null,
    val accountUsage: AccountUsage? = null,
    val accountError: String? = null,
    val accountRefreshing: Boolean = false,
    val showArchivedThreads: Boolean = false,
    val activeTurnId: String? = null,
    val canSteer: Boolean = false,
    val canManageThread: Boolean = false,
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
    val onThemeChange: (String) -> Unit = {},
    val onAccentChange: (String) -> Unit = {},
    val onPickAvatar: () -> Unit = {},
    val onRemoveAvatar: () -> Unit = {},
    val onIdentityLabelsChange: (String, String) -> Unit = { _, _ -> },
    val onReadingScaleChange: (Float) -> Unit = {},
    val onSelectModel: (String) -> Unit = {},
    val onSelectEffort: (String) -> Unit = {},
    val onSelectPermission: (String, Boolean) -> Unit = { _, _ -> },
    val onBrowseDirectory: (String, String) -> Unit = { _, _ -> },
    val onLoadMoreDirectories: () -> Unit = {},
    val onLoadMoreThreads: () -> Unit = {},
    val onRespondInteraction: (String, JsonObject) -> Unit = { _, _ -> },
    val onRespondFileChange: (String, JsonObject, String) -> Unit = { _, _, _ -> },
    val onRefreshInspector: () -> Unit = {},
    val onLoadItemDetail: (String, String) -> Unit = { _, _ -> },
    val onQueryOperation: (String) -> Unit = {},
    val onRefreshOperationThread: (String) -> Unit = {},
    val onRenameThread: (String, String) -> Unit = { _, _ -> },
    val onArchiveThread: (String) -> Unit = {},
    val onUnarchiveThread: (String) -> Unit = {},
    val onDeleteThread: (String) -> Unit = {},
    val onShowArchivedThreads: (Boolean) -> Unit = {},
    val onForkThread: (String?) -> Unit = {},
    val onRevertThread: (String) -> Unit = {},
    val onCompactThread: () -> Unit = {},
    val onSteer: () -> Unit = {},
    val onRefreshAccount: () -> Unit = {},
    val onRefreshNativeDefaults: () -> Unit = {},
)
