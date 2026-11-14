package dev.oraculum.poc

import android.app.Application
import android.database.sqlite.SQLiteDatabaseCorruptException
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.oraculum.poc.gateway.*
import dev.oraculum.poc.repository.*
import dev.oraculum.poc.storage.*
import dev.oraculum.poc.ui.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.util.UUID

/** Native client coordinator. All execution remains in the Gateway and official Codex. */
class PocViewModel(application: Application) : AndroidViewModel(application) {
    private val client = GatewayClient(application)
    private val local = LocalStore(application)
    private val mutableState = MutableStateFlow(PocUiState())
    val state: StateFlow<PocUiState> = mutableState.asStateFlow()
    private val actionMutex = Mutex()
    private val eventMutex = Mutex()
    private val draftMutex = Mutex()
    private val cacheMutex = Mutex()
    private val projection = HistoryProjection()
    private val inspectorProjection = InspectorProjection()
    private val fileChangeContexts = FileChangeApprovalContexts()
    private val notifications = dev.oraculum.poc.notifications.GatewayNotifications(application)
    private var foreground = true
    private var capabilityData: JsonObject? = null
    private var nextThreadCursor: String? = null
    private var nextArchivedThreadCursor: String? = null
    private var navigationSyncJob: Job? = null
    private var operationNoticeJob: Job? = null
    private var compactionCompletionVersion = 0L
    private var nextDirectoryCursor: String? = null
    private var correctionAttempts = 0
    private var scopeKey: String? = null
    private var epoch = ""
    private var position: EventPosition? = null
    private var events: EventConnectionHandle? = null
    private var pendingConnectionReady: CompletableDeferred<Unit>? = null
    private var connectionGeneration = 0
    private var invalidationVersion = 0L
    private var receivedEventVersion = 0L
    private var fileChangeEvidenceVersion = 0L
    private var snapshotCurrent = false
    private var activeTurnId: String? = null
    private var threadStatus = "unknown"
    private var capabilities: Set<String> = emptySet()
    private var pending: List<OperationRecord> = emptyList()
    private var pendingObserver: Job? = null
    private var syncJob: Job? = null
    private var reconnectJob: Job? = null
    private var heartbeatJob: Job? = null
    private var cacheJob: Job? = null
    private var anchorJob: Job? = null
    private var automaticReconnect = true
    private var durableStateAvailable = true
    private var nextHistoryCursor: String? = null
    private val itemCursors = linkedMapOf<String, String>()
    private var historyRevision: String? = null
    private var historyPages = 0
    private var replaceTerminalOnSnapshot = true
    // Native empty threads may not be listed until their first Turn. This is only the current
    // connection's accepted explicit start receipt, never permission inferred from cached history.
    private val freshThreads = mutableSetOf<String>()
    private val firstTurnPermit = FirstTurnPermit()
    private data class FileDispatch(val scope: String, val id: String, val project: String, val thread: String, val epoch: String, val generation: Int)
    private var fileDispatch: FileDispatch? = null
    private val fileDispatchScopes = mutableMapOf<String, FileDispatch>()
    val files = dev.oraculum.poc.files.FilesController(application, client, viewModelScope,
        beginWrite = { id, kind, project, thread ->
            actionMutex.withLock {
                requireOnline("attachments")
                if (project != state.value.selectedProjectId || thread != state.value.selectedThreadId) throw ClientStateException("附件会话已改变")
                checkUnknown(project, thread)
                val scope = requireScope()
                fileDispatch = FileDispatch(scope, id, project, thread, epoch, connectionGeneration)
                fileDispatchScopes[id] = requireNotNull(fileDispatch)
                local.state.insertOperation(OperationRecord(scope, id, project, thread, kind))
                pending = local.state.unresolved(scope)
                updateControls()
            }
        },
        acceptReceipt = { envelope ->
            if (envelope.string("epoch") != epoch) { connectionFailed(null); throw ClientStateException("附件响应代次已变化，保留原操作等待查询") }
            val receipt = envelope.obj("operation") ?: throw ClientStateException("附件回执缺失，结果保持未知")
            val id = receipt.string("operationId") ?: throw ClientStateException("附件回执缺少操作标识")
            val original = local.state.operation(requireScope(), id) ?: throw ClientStateException("附件回执不属于当前设备操作")
            applyReceipt(receipt, original.projectId, original.threadId)
        },
        beforeDispatch = {
            val observation = fileDispatch ?: throw DispatchPreventedException()
            if (!state.value.online || position == null || !durableStateAvailable || scopeKey != observation.scope || epoch != observation.epoch ||
                connectionGeneration != observation.generation || state.value.selectedProjectId != observation.project || state.value.selectedThreadId != observation.thread ||
                blocksWrite(pending.filter { it.operationId != observation.id }.map { PendingIntent(it.projectId, it.threadId, it.kind, it.status) }, observation.project, observation.thread))
                throw DispatchPreventedException()
        },
        notDispatched = { id ->
            val observation = fileDispatchScopes[id]
            if (observation != null) {
                local.state.updateOperationReceipt(observation.scope, id, "rejected", "notSent")
                fileDispatchScopes.remove(id)
                if (scopeKey == observation.scope) { pending = local.state.unresolved(observation.scope); updateControls() }
            }
        })

    private suspend fun syncFiles() {
        files.bind(scopeKey.orEmpty(), state.value.selectedProjectId, state.value.selectedThreadId, state.value.online && position != null, capabilityData)
    }

    init {
        action {
            val saved = local.preferences.snapshot()
            mutableState.value = state.value.copy(endpoint = saved.endpoint, themeMode = saved.themeMode, userLabel = saved.userLabel, assistantLabel = saved.assistantLabel, readingScale = saved.readingScale,
                accentColor = saved.accentColor, avatarFileName = saved.avatarFileName)
            if (saved.endpoint.isNotBlank()) {
                val endpoint = GatewayEndpoint.parse(saved.endpoint)
                val identity = client.savedIdentity(endpoint)
                if (identity != null && identity.paired) {
                    setScope(CacheScope(identity.endpoint, identity.installationId, identity.deviceId).key)
                    mutableState.value = state.value.copy(paired = true, connectionLabel = "离线缓存")
                    loadCached(saved)
                    connectInternal()
                }
            }
        }
    }

    fun themeChange(mode: String) = action {
        if (mode !in setOf("light", "dark", "oled")) return@action
        local.preferences.saveTheme(mode)
        mutableState.value = state.value.copy(themeMode = mode)
    }

    fun accentChange(mode: String) = action {
        local.preferences.saveAccent(mode)
        mutableState.value = state.value.copy(accentColor = mode)
    }

    fun refreshLocalAvatar() = viewModelScope.launch {
        try {
            val saved = local.preferences.snapshot()
            mutableState.value = state.value.copy(avatarFileName = saved.avatarFileName)
        } catch (error: Exception) { handleFailure(error) }
    }

    fun identityLabelsChange(user: String, assistant: String) = action {
        val userName = user.trim(); val assistantName = assistant.trim()
        if (userName.length !in 1..40 || assistantName.length !in 1..40 || (userName + assistantName).any { it.isISOControl() }) throw ClientStateException("显示名称应为 1–40 个可见字符")
        local.preferences.saveIdentityLabels(userName, assistantName)
        mutableState.value = state.value.copy(userLabel = userName, assistantLabel = assistantName)
    }
    fun readingScaleChange(scale: Float) = action {
        if (!scale.isFinite() || scale !in 0.85f..1.4f) return@action
        local.preferences.saveReadingScale(scale)
        mutableState.value = state.value.copy(readingScale = scale)
    }

    fun selectModel(id: String) {
        if (state.value.busy) return
        if (id.isEmpty()) {
            mutableState.value = state.value.copy(selectedModel = null, selectedEffort = null)
            return
        }
        val model = state.value.models.firstOrNull { it.id == id } ?: return
        mutableState.value = state.value.copy(selectedModel = id, selectedEffort = model.defaultEffort?.takeIf { isWritableEffort(it, state.value.gatewayProtocolMinor) })
    }

    fun selectEffort(effort: String) {
        if (state.value.busy) return
        if (effort.isEmpty()) {
            mutableState.value = state.value.copy(selectedEffort = null)
            return
        }
        val modelId = state.value.selectedModel ?: state.value.actualModel ?: state.value.nativeDefaults?.model
        if (!isWritableEffort(effort, state.value.gatewayProtocolMinor) || state.value.models.firstOrNull { it.id == modelId }?.efforts?.contains(effort) != true) return
        mutableState.value = state.value.copy(selectedEffort = effort)
    }

    /** full-access is accepted only after the native UI's explicit confirmation. Never persisted. */
    fun selectPermission(preset: String, confirmed: Boolean) {
        if (state.value.busy || preset !in setOf("native", "read-only", "auto", "full-access") || (preset == "full-access" && !confirmed)) return
        mutableState.value = state.value.copy(permissionPreset = preset)
    }

    private suspend fun refreshModels() {
        val page = resource(client.get("models"))
        val models = modelOptions(page)
        mutableState.value = state.value.copy(models = models, modelsLimited = page.string("nextCursor") != null,
            selectedModel = state.value.selectedModel?.takeIf { selected -> models.any { it.id == selected } },
            selectedEffort = state.value.selectedEffort?.takeIf { effort -> isWritableEffort(effort, state.value.gatewayProtocolMinor) && models.firstOrNull { it.id == (state.value.selectedModel ?: state.value.actualModel ?: state.value.nativeDefaults?.model) }?.efforts?.contains(effort) == true })
    }

    fun refreshAccount() = action { refreshAccountInternal() }

    fun refreshNativeDefaults() = action { refreshNativeDefaultsInternal() }

    /** Optional read failures never erase a proven session or fabricate account/config facts. */
    private fun optionalReadMessage(error: Exception): String {
        if (error is TimeoutCancellationException) return "读取超时，请稍后刷新。"
        if (error is CancellationException) throw error
        if (error is GatewayException) {
            if (error.authInvalid || error.code == "ACCESS_EXPIRED") handleFailure(error)
            return error.userMessage
        }
        if (!state.value.online) return "连接已变化，请重新连接后刷新。"
        return "响应暂无法识别，请稍后刷新。"
    }

    private suspend fun refreshNativeDefaultsInternal() {
        val project = state.value.selectedProjectId ?: return
        if (!state.value.online || position == null) return
        val generation = connectionGeneration
        if ("config.read" !in capabilities) {
            mutableState.value = state.value.copy(nativeDefaults = null, nativeDefaultsError = "当前连接暂未提供默认设置")
            return
        }
        try {
            val data = resource(client.get("projects/${segment(project)}/native-defaults"))
            val defaults = GatewayProtocol.decode<dev.oraculum.gateway.protocol.NativeDefaults>(data)
            if (generation == connectionGeneration && state.value.online && state.value.selectedProjectId == project)
                mutableState.value = state.value.copy(nativeDefaults = defaults, nativeDefaultsError = null)
        } catch (error: Exception) {
            val message = optionalReadMessage(error)
            if (generation == connectionGeneration && state.value.selectedProjectId == project) mutableState.value = state.value.copy(nativeDefaultsError = message)
        }
    }

    private suspend fun refreshAccountInternal() {
        if (!state.value.online || position == null) return
        val generation = connectionGeneration
        val scope = scopeKey
        mutableState.value = state.value.copy(accountRefreshing = true)
        val errors = mutableListOf<String>()
        try {
            if ("account.rateLimits.read" in capabilities) {
                try {
                    val data = resource(client.get("account/rate-limits"))
                    val limits = GatewayProtocol.decode<dev.oraculum.gateway.protocol.AccountRateLimits>(data)
                    if (generation == connectionGeneration && scope == scopeKey) mutableState.value = state.value.copy(accountRateLimits = limits)
                } catch (error: Exception) { errors += "额度：${optionalReadMessage(error)}" }
            } else {
                mutableState.value = state.value.copy(accountRateLimits = null)
                errors += "当前连接暂未提供账户额度"
            }
            if (state.value.online && "account.usage.read" in capabilities) {
                try {
                    val data = resource(client.get("account/usage"))
                    val usage = GatewayProtocol.decode<dev.oraculum.gateway.protocol.AccountUsage>(data)
                    if (generation == connectionGeneration && scope == scopeKey) mutableState.value = state.value.copy(accountUsage = usage)
                } catch (error: Exception) { errors += "累计用量：${optionalReadMessage(error)}" }
            } else if ("account.usage.read" !in capabilities) mutableState.value = state.value.copy(accountUsage = null)
            if (generation == connectionGeneration && scope == scopeKey)
                mutableState.value = state.value.copy(accountError = errors.takeIf { it.isNotEmpty() }?.joinToString("\n"))
        } finally { mutableState.value = state.value.copy(accountRefreshing = false) }
    }

    fun showArchivedThreads(archived: Boolean): Job {
        if (!archived) {
            mutableState.value = state.value.copy(showArchivedThreads = false)
            return viewModelScope.launch {}
        }
        return action {
            requireOnline("thread.list")
            val project = state.value.selectedProjectId ?: return@action
            mutableState.value = state.value.copy(showArchivedThreads = true)
            refreshArchivedThreads(project)
        }
    }

    fun loadMoreArchivedThreads() = action {
        requireOnline("thread.list")
        val project = state.value.selectedProjectId ?: return@action
        val cursor = nextArchivedThreadCursor ?: return@action
        val data = resource(client.get("projects/${segment(project)}/threads", mapOf("limit" to "20", "archived" to "true", "cursor" to cursor)))
        if (state.value.selectedProjectId != project) return@action
        nextArchivedThreadCursor = data.string("nextCursor")
        val added = data.array("threads").mapNotNull { (it as? JsonObject)?.let { threadOption(it, archived = true) } }
        mutableState.value = state.value.copy(archivedThreads = (state.value.archivedThreads + added).distinctBy { it.id }, archivedThreadsLoaded = true)
    }

    private fun knownThread(id: String) = (state.value.threads + state.value.archivedThreads).firstOrNull { it.id == id }

    private fun clearArchivedThreads() {
        nextArchivedThreadCursor = null
        mutableState.value = state.value.copy(archivedThreads = emptyList(), archivedThreadsLoaded = false,
            canLoadMoreArchivedThreads = false, showArchivedThreads = false)
    }

    private suspend fun refreshArchivedThreads(project: String) {
        val data = resource(client.get("projects/${segment(project)}/threads", mapOf("limit" to "20", "archived" to "true")))
        if (state.value.selectedProjectId != project) return
        nextArchivedThreadCursor = data.string("nextCursor")
        mutableState.value = state.value.copy(archivedThreads = data.array("threads").mapNotNull {
            (it as? JsonObject)?.let { thread -> threadOption(thread, archived = true) }
        }, archivedThreadsLoaded = true, canLoadMoreArchivedThreads = state.value.online && !state.value.busy && nextArchivedThreadCursor != null)
    }

    private suspend fun refreshThreadLists(project: String) {
        refreshThreads(project)
        if (state.value.showArchivedThreads) refreshArchivedThreads(project)
    }

    fun renameThread(threadId: String, name: String) = mutateThread(threadId, "thread.name.set", "name", buildJsonObject {
        val trimmed = name.trim()
        put("name", trimmed)
    })

    fun archiveThread(threadId: String) = mutateThread(threadId, "thread.archive", "archive")
    fun unarchiveThread(threadId: String) = mutateThread(threadId, "thread.unarchive", "unarchive")
    /** UI must display an explicit irreversible-delete confirmation before invoking this action. */
    fun deleteThread(threadId: String) = mutateThread(threadId, "thread.delete", "", buildJsonObject { put("confirm", true) }, delete = true)

    private fun mutateThread(threadId: String, capability: String, suffix: String, fields: JsonObject = buildJsonObject {},
        delete: Boolean = false) = action {
        requireOnline(capability)
        val project = state.value.selectedProjectId ?: return@action
        val name = fields.string("name")
        if (capability == "thread.name.set" && (name.isNullOrBlank() || name.codePointCount(0, name.length) > 200 || name.any { it.code in 0..31 || it.code == 127 }))
            throw ClientStateException("名称应为 1–200 个可见字符")
        val target = knownThread(threadId)
            ?: throw ClientStateException("会话不在当前列表中，请刷新后重试")
        if (capability == "thread.archive" && target.archived || capability == "thread.unarchive" && !target.archived)
            throw ClientStateException("会话归档状态已变化，请刷新")
        if (state.value.selectedThreadId == threadId && activeTurnId != null && capability != "thread.name.set")
            throw ClientStateException("请先停止当前执行，再管理会话")
        reconcileUnknown()
        checkUnknown(project, threadId)
        val result = executeWrite(capability, project, threadId,
            "threads/${segment(threadId)}" + if (suffix.isEmpty()) "" else "/$suffix",
            method = if (delete) "DELETE" else "POST",
            extraGuard = { state.value.selectedProjectId == project && knownThread(threadId)?.archived == target.archived }) { id ->
            buildJsonObject {
                put("operationId", id); put("projectId", project); put("expectedEpoch", epoch)
                fields.forEach { (key, value) -> put(key, value) }
            }
        }
        if (result.string("status") != "accepted") return@action
        mutableState.value = state.value.copy(error = null)
        if (capability in setOf("thread.archive", "thread.delete") && state.value.selectedThreadId == threadId) {
            resetThread()
            local.preferences.saveSelection(requireScope(), project, null)
        }
        refreshThreads(project)
        if (target.archived || capability == "thread.archive" || state.value.archivedThreadsLoaded || state.value.showArchivedThreads) refreshArchivedThreads(project)
        if (capability == "thread.unarchive") {
            if (state.value.threads.any { it.id == threadId && !it.archived }) selectThreadInternal(threadId)
            else showOperationNotice("已请求恢复归档；请在活动会话列表中重新选择")
        } else if (state.value.selectedThreadId == threadId) scheduleSync()
    }

    fun forkThread(lastTurnId: String?) = selectedThreadOperation("thread.fork", "fork", buildJsonObject {
        lastTurnId?.let { put("lastTurnId", it) }
    })

    fun revertThread(beforeTurnId: String) = selectedThreadOperation("thread.revert", "revert", buildJsonObject {
        put("beforeTurnId", beforeTurnId)
    })

    fun compactThread() = selectedThreadOperation("thread.compact", "compact")

    private fun selectedThreadOperation(capability: String, suffix: String, fields: JsonObject = buildJsonObject {}) = action {
        requireOnline(capability)
        val project = state.value.selectedProjectId ?: return@action
        val thread = state.value.selectedThreadId ?: return@action
        reconcileUnknown()
        syncThread(thread)
        checkUnknown(project, thread)
        if (state.value.selectedThreadId != thread || !snapshotCurrent || activeTurnId != null || threadStatus !in setOf("idle", "notLoaded", "active"))
            throw ClientStateException("请等待会话空闲并完成同步")
        val referencedTurn = fields.string("beforeTurnId") ?: fields.string("lastTurnId")
        if (referencedTurn != null && state.value.messages.none { it.turnId == referencedTurn })
            throw ClientStateException("该轮次不在已加载历史中，请重新选择")
        val version = invalidationVersion
        val compactionVersion = compactionCompletionVersion
        val sourceScope = requireScope()
        val sourceEpoch = epoch
        val sourceGeneration = connectionGeneration
        val branchTitle = branchThreadTitle(state.value.threads.firstOrNull { it.id == thread }?.label.orEmpty())
        val result = executeWrite(capability, project, thread, "threads/${segment(thread)}/$suffix",
            extraGuard = { state.value.selectedProjectId == project && state.value.selectedThreadId == thread && activeTurnId == null && snapshotCurrent && invalidationVersion == version }) { id ->
            buildJsonObject {
                put("operationId", id); put("projectId", project); put("expectedEpoch", epoch)
                fields.forEach { (key, value) -> put(key, value) }
            }
        }
        if (result.string("status") != "accepted") return@action
        if (capability == "thread.fork") {
            val forked = result.string("nativeThreadId") ?: throw ClientStateException("分支已创建，暂时无法定位。请刷新列表，请勿重复创建。")
            if (forked == thread) throw ClientStateException("分支返回了原会话，已停止命名。请刷新查看，请勿重复创建。")
            finishFork(project, forked, branchTitle, sourceScope, sourceEpoch, sourceGeneration)
        } else {
            replaceTerminalOnSnapshot = true
            snapshotCurrent = false
            firstTurnPermit.invalidate(thread)
            showOperationNotice(if (capability == "thread.compact") {
                if (compactionCompletionVersion != compactionVersion) "上下文压缩已完成" else "已请求压缩，完成后会显示结果"
            } else "已请求撤回选定轮次及后续对话；工作区文件不会回滚")
            scheduleSync()
        }
    }

    /** The accepted fork is retained even if its separate, durable name write is unconfirmed. */
    private suspend fun finishFork(project: String, forked: String, title: String, sourceScope: String, sourceEpoch: String, sourceGeneration: Int) {
        fun sameContext() = scopeKey == sourceScope && epoch == sourceEpoch && connectionGeneration == sourceGeneration &&
            state.value.selectedProjectId == project
        if (!sameContext()) throw ClientStateException("分支已创建，连接已变化。请返回原账户刷新列表，请勿重复创建。")
        freshThreads.add(forked)
        mutableState.value = state.value.copy(showArchivedThreads = false,
            threads = (state.value.threads + ThreadOption(forked, "新分支")).distinctBy { it.id })
        var renamed = false
        try {
            requireOnline("thread.name.set")
            checkUnknown(project, forked)
            val receipt = executeWrite("thread.name.set", project, forked, "threads/${segment(forked)}/name",
                extraGuard = { sameContext() && state.value.threads.any { it.id == forked } }) { id ->
                buildJsonObject {
                    put("operationId", id); put("projectId", project); put("expectedEpoch", sourceEpoch); put("name", title)
                }
            }
            renamed = receipt.string("status") == "accepted"
            if (renamed && sameContext()) mutableState.value = state.value.copy(threads = state.value.threads.map {
                if (it.id == forked) it.copy(label = title) else it
            })
        } catch (error: Exception) {
            if (error is CancellationException && error !is TimeoutCancellationException) throw error
            handleFailure(error)
        }
        var opened = false
        if (sameContext() && state.value.online) {
            try {
                refreshThreadLists(project)
                if (forked in freshThreads && state.value.threads.none { it.id == forked }) mutableState.value = state.value.copy(
                    threads = state.value.threads + ThreadOption(forked, if (renamed) title else "新分支"))
                if (sameContext() && state.value.threads.any { it.id == forked }) {
                    selectThreadInternal(forked)
                    opened = true
                }
            } catch (error: Exception) {
                if (error is CancellationException && error !is TimeoutCancellationException) throw error
                handleFailure(error)
            }
        }
        if (!renamed || !opened) {
            mutableState.value = state.value.copy(error = if (!renamed) "分支已创建，名称尚未确认。请刷新后查看，请勿重复创建。" else "分支已创建，暂时无法打开。请刷新列表后查看。")
        } else showOperationNotice("分支已创建")
    }

    /** Steer targets exactly the observed active Turn and never claims pending attachments. */
    fun steer() = action {
        requireOnline("turn.steer")
        val project = state.value.selectedProjectId ?: return@action
        val thread = state.value.selectedThreadId ?: return@action
        val turn = activeTurnId ?: throw ClientStateException("没有可确认的活动执行")
        val text = state.value.draft
        if (text.isBlank()) return@action
        if (text.toByteArray(Charsets.UTF_8).size > 60 * 1024) throw ClientStateException("补充消息限 60 KiB")
        reconcileUnknown()
        checkUnknown(project, thread)
        syncFiles()
        if (files.state.value.attachments.isNotEmpty()) throw ClientStateException("执行中补充仅支持文字；请保留附件用于下一条消息")
        val scope = requireScope()
        draftMutex.withLock { local.state.putDraft(DraftRecord(scope, project, thread, text)) }
        val result = executeWrite("turn.steer", project, thread, "threads/${segment(thread)}/turns/${segment(turn)}/steer",
            extraGuard = { state.value.selectedProjectId == project && state.value.selectedThreadId == thread && activeTurnId == turn }) { id ->
            buildJsonObject {
                put("operationId", id); put("projectId", project); put("expectedEpoch", epoch)
                put("input", buildJsonArray { add(buildJsonObject { put("type", "text"); put("text", text) }) })
            }
        }
        if (result.string("status") == "accepted") {
            draftMutex.withLock {
                if (local.state.draft(scope, project, thread)?.text == text) local.state.putDraft(DraftRecord(scope, project, thread, ""))
            }
            if (state.value.selectedThreadId == thread && state.value.draft == text) mutableState.value = state.value.copy(draft = "")
        }
        scheduleSync()
    }

    fun browseDirectory(rootId: String, path: String) = action {
        requireOnline("projects")
        if (state.value.roots.none { it.id == rootId } || (path.isNotEmpty() && !validProjectRelativePath(path))) throw ClientStateException("请选择授权根目录下的有效目录")
        loadDirectory(rootId, path, null)
    }
    fun loadMoreDirectories() = action {
        requireOnline("projects")
        val cursor = nextDirectoryCursor ?: return@action
        loadDirectory(state.value.directory.rootId, state.value.directory.path, cursor)
    }
    private suspend fun loadDirectory(root: String, path: String, cursor: String?) {
        val data = resource(client.post("project-directories/query", buildJsonObject {
            put("rootId", root); put("path", path); put("limit", 50); cursor?.let { put("cursor", it) }
        }))
        if (data.string("rootId") != root || data.string("path") != path) throw ClientStateException("目录响应范围不匹配")
        nextDirectoryCursor = data.string("nextCursor")
        val entries = data.array("entries").mapNotNull { (it as? JsonObject)?.let { item ->
            val itemPath = item.string("path") ?: return@let null
            DirectoryOption(item.string("name") ?: itemPath, itemPath)
        } }
        mutableState.value = state.value.copy(directory = DirectoryUiState(root, path,
            ((if (cursor != null) state.value.directory.entries else emptyList()) + entries).distinctBy { it.path },
            data.flag("canRegister"), nextDirectoryCursor != null, data.flag("limited")))
    }

    fun loadMoreThreads() = action {
        requireOnline("thread.list")
        val project = state.value.selectedProjectId ?: return@action
        val cursor = nextThreadCursor ?: return@action
        val data = resource(client.get("projects/${segment(project)}/threads", mapOf("limit" to "20", "archived" to "false", "cursor" to cursor)))
        if (state.value.selectedProjectId != project) return@action
        nextThreadCursor = data.string("nextCursor")
        val added = data.array("threads").mapNotNull { (it as? JsonObject)?.let { thread -> threadOption(thread) } }
        mutableState.value = state.value.copy(threads = (state.value.threads + added).distinctBy { it.id })
    }

    fun respondInteraction(id: String, response: JsonObject) = respondInteractionInternal(id, response, null)

    /** The digest comes from the exact patch rendered by the tapped native approval card. */
    fun respondFileChange(id: String, response: JsonObject, displayedDigest: String) = respondInteractionInternal(id, response, displayedDigest)

    private fun respondInteractionInternal(id: String, response: JsonObject, displayedDigest: String?) = action {
        requireOnline("interactions")
        val project = state.value.selectedProjectId ?: return@action
        val thread = state.value.selectedThreadId ?: return@action
        val original = state.value.interactions.firstOrNull { it.id == id } ?: throw ClientStateException("此交互已经失效，请刷新原生状态")
        val approvesFileChange = original.kind == "fileChange" && response.string("decision") == "accept"
        if (approvesFileChange && original.fileChangeContext?.matchesPending(original, displayedDigest) != true)
            throw ClientStateException("文件修改尚无与你看到的 Diff 精确绑定的校验上下文；未派发批准")
        reconcileUnknown()
        syncThread(thread)
        checkUnknown(project, thread)
        val current = state.value.interactions.firstOrNull { it.id == id }
        if (current == null || current.projectId != project || current.threadId != thread || current.epoch != epoch || current.generation != original.generation || current.status != "pending")
            throw ClientStateException("此请求已过期、取消或由其他设备处理；未派发响应")
        if (!NativeInteractionForms.validate(current, response)) throw ClientStateException("请检查当前请求允许的选项和填写内容")
        if (approvesFileChange && !fileChangeApprovalStillCurrent(original, current, displayedDigest))
            throw ClientStateException("文件修改或请求已变化，请重新查看完整 Diff；未派发批准")
        val verifiedVersion = invalidationVersion
        try {
            executeWrite("interaction.respond", project, thread, "interactions/${segment(id)}/response", extraGuard = {
                state.value.interactions.any { live -> live.id == id && live.projectId == project && live.threadId == thread &&
                    live.epoch == current.epoch && live.generation == current.generation && live.status == "pending" &&
                    (!approvesFileChange || (invalidationVersion == verifiedVersion && fileChangeApprovalStillCurrent(original, live, displayedDigest))) }
            }) { operationId -> buildJsonObject {
                put("operationId", operationId); put("projectId", project); put("epoch", current.epoch)
                put("generation", current.generation); put("response", response)
            } }
        } finally { if (approvesFileChange) revokeFileChangeContexts(); scheduleSync() }
    }

    private fun revokeFileChangeContexts() {
        fileChangeEvidenceVersion++
        fileChangeContexts.clear()
        if (state.value.interactions.any { it.fileChangeContext != null }) mutableState.value = state.value.copy(
            interactions = state.value.interactions.map { if (it.kind == "fileChange") NativeInteractionForms.bindFileChangeContext(it, null) else it })
    }

    fun refreshInspector() = action {
        requireOnline("history")
        state.value.selectedThreadId?.let { syncThread(it) }
        val project = state.value.selectedProjectId ?: return@action
        if ("extensions.read" !in capabilities) {
            mutableState.value = state.value.copy(inspector = state.value.inspector.copy(extensions = listOf("skills", "mcp", "apps", "plugins").map {
                ExtensionSectionUi(it, "unavailable", reason = "当前 Gateway 未开放只读扩展目录")
            }))
            return@action
        }
        val data = resource(client.get("projects/${segment(project)}/extensions"))
        if (data.string("projectId") != project) throw ClientStateException("扩展响应项目不匹配")
        val sections = data.array("sections").mapNotNull { (it as? JsonObject)?.let { section ->
            ExtensionSectionUi(section.string("kind").orEmpty(), section.string("status") ?: "unavailable",
                section.array("entries").mapNotNull { (it as? JsonObject)?.let { entry -> InspectorEntry(entry.string("id").orEmpty(), entry.string("name").orEmpty(),
                    entry.filterKeys { it !in setOf("id", "name") }.entries.joinToString("\n") { "${it.key}: ${it.value}" }, entry.string("status").orEmpty()) } }, section.flag("limited"), section.string("reasonCode"))
        } }
        mutableState.value = state.value.copy(inspector = state.value.inspector.copy(extensions = sections))
    }

    fun loadItemDetail(turnId: String, itemId: String) = action {
        requireOnline("history")
        val project = state.value.selectedProjectId ?: return@action
        val thread = state.value.selectedThreadId ?: return@action
        val generation = connectionGeneration
        val accumulator = ItemDetailAccumulator(itemId, epoch)
        var cursor: String? = null
        var pages = 0
        mutableState.value = state.value.copy(inspector = state.value.inspector.copy(detailTitle = itemId, detailText = null, detailProgress = "正在读取并校验完整详情…"))
        try {
            do {
                val data = resource(client.post("threads/${segment(thread)}/history/details", buildJsonObject {
                    put("projectId", project); put("turnId", turnId); put("itemId", itemId); cursor?.let { put("cursor", it) }
                }))
                if (connectionGeneration != generation || state.value.selectedThreadId != thread) throw ClientStateException("连接或会话已改变，详情读取已停止")
                val item = withContext(Dispatchers.Default) { accumulator.append(data) }
                pages++
                mutableState.value = state.value.copy(inspector = state.value.inspector.copy(detailProgress = "已读取 ${accumulator.loadedBytes} / ${data.number("totalBytes")} 字节"))
                if (item != null) {
                    inspectorProjection.item(item, turnId)
                    val rendered = withContext(Dispatchers.Default) {
                        val pretty = Json { prettyPrint = true }.encodeToString(JsonObject.serializer(), item)
                        pretty.take(64 * 1024) to (pretty.length > 64 * 1024)
                    }
                    mutableState.value = state.value.copy(inspector = inspectorProjection.state(state.value.inspector).copy(detailText = rendered.first,
                        detailProgress = if (rendered.second) "内容校验通过 · 当前仅显示前 64 Ki 字符" else "完整内容校验通过"))
                }
                cursor = data.string("nextCursor")
            } while (cursor != null && pages < 128)
            if (!accumulator.finished) throw ClientStateException("详情超过读取上限，尚未完整校验")
        } catch (error: Exception) {
            mutableState.value = state.value.copy(inspector = state.value.inspector.copy(detailText = null, detailProgress = "详情未通过完整校验；请重新读取"))
            if (error is IllegalArgumentException || error is IllegalStateException) throw ClientStateException(error.message ?: "详情校验失败")
            throw error
        }
    }

    fun queryOperation(id: String) = action {
        val scope = requireScope()
        if (!state.value.online) throw ClientStateException("离线无法查询原回执，未知操作继续保留")
        val operation = local.state.operation(scope, id) ?: return@action
        try {
            val receipt = resource(client.get("operations/${segment(id)}"))
            applyReceipt(receipt, operation.projectId, operation.threadId)
            showOperationNotice(when (receipt.string("status")) {
                "accepted" -> "请求已确认接收"
                "rejected" -> "请求未执行"
                else -> "结果尚未确认，请勿重复提交"
            })
        } catch (error: GatewayException) {
            if (error.httpStatus != 404) throw error
            mutableState.value = state.value.copy(operationStatusMessage = "暂未查到请求记录。查不到记录不代表未执行，请勿重复提交，可在主机核实。")
        }
    }

    fun refreshOperationThread(id: String) = action {
        val operation = local.state.operation(requireScope(), id) ?: return@action
        val thread = operation.nativeThreadId ?: operation.threadId ?: throw ClientStateException("暂时无法定位这次请求的会话，请查询记录或在主机核实")
        requireOnline("thread.read")
        if (operation.projectId.isBlank()) throw ClientStateException("此操作尚无可确认的项目，未知状态继续保留")
        // Read-only inspection of the original scope does not resolve or remove the operation barrier.
        readSnapshot(operation.projectId, thread)
        showOperationNotice("会话状态已读取。请求结果仍以查询记录为准，请勿重复提交。")
        if (thread == state.value.selectedThreadId && operation.projectId == state.value.selectedProjectId) syncThread(thread)
    }

    fun onForegroundChanged(value: Boolean) {
        val was = foreground
        foreground = value
        if (value && !was && state.value.paired && automaticReconnect) refresh()
    }

    fun openNotification(route: dev.oraculum.poc.notifications.NotificationRoute) = action(queue = true) {
        if (route.scopeKey != scopeKey) throw ClientStateException("此通知属于另一配对身份；当前会话未改变")
        if (!state.value.online) connectInternal()
        val generation = connectionGeneration
        val version = invalidationVersion
        val readEpoch = epoch
        val eventVersion = receivedEventVersion
        // Do not clear the current conversation/draft while a target native read may time out.
        val target = try {
            readNotificationTarget(route.projectId, route.threadId,
                readProjects = { resource(client.get("projects")) },
                readThreads = { cursor -> resource(client.get("projects/${segment(route.projectId)}/threads", buildMap {
                    put("limit", "20"); put("archived", "false"); cursor?.let { put("cursor", it) }
                })) },
                readSnapshot = { readSnapshot(route.projectId, route.threadId) })
        } catch (error: NotificationTargetUnavailable) { throw ClientStateException(error.message.orEmpty()) }
        if (route.scopeKey != scopeKey || readEpoch != epoch || target.snapshot.string("epoch") != epoch || eventVersion != receivedEventVersion ||
            !snapshotStillCurrent(generation, connectionGeneration, version, invalidationVersion) || position?.epoch != epoch ||
            (position?.sequence ?: Long.MAX_VALUE) > (target.snapshot.number("observedEndSeq") ?: -1))
            throw ClientStateException("连接或会话状态已变化，当前会话已保留，请重新打开通知")
        // The non-suspending selection change commits only after every target read succeeded.
        resetThread()
        clearArchivedThreads()
        applyProjects(target.projects)
        mutableState.value = state.value.copy(selectedProjectId = route.projectId, selectedThreadId = route.threadId,
            showArchivedThreads = false, nativeDefaults = null, nativeDefaultsError = null)
        applyThreads(target.firstThreads)
        nextThreadCursor = target.firstThreads.string("nextCursor")
        if (state.value.threads.none { it.id == route.threadId }) mutableState.value = state.value.copy(threads = state.value.threads + threadOption(target.thread))
        val committedVersion = invalidationVersion
        // Apply the already-read snapshot before any local IO can let a new event race with it.
        applyVerifiedSnapshot(route.projectId, route.threadId, target.snapshot, committedVersion, generation, fileChangeEvidenceVersion)
        local.preferences.saveSelection(requireScope(), route.projectId, route.threadId)
        mutableState.value = state.value.copy(draft = local.state.draft(requireScope(), route.projectId, route.threadId)?.text.orEmpty(),
            navigationRequest = if (route.inspector != "conversation") "inspector:${UUID.randomUUID()}" else "conversation:${UUID.randomUUID()}")
        syncFiles()
        refreshNativeDefaultsInternal()
    }

    fun endpointChange(value: String) {
        if (state.value.online || state.value.busy) return
        if (pending.isNotEmpty()) { mutableState.value = state.value.copy(error = "请保留当前设备身份并查询未知操作；不能通过换服务器或重新配对绕过屏障"); return }
        if (value != state.value.endpoint) {
            automaticReconnect = false
            reconnectJob?.cancel()
            disconnectTransport()
            scopeKey = null
            pendingObserver?.cancel()
            pending = emptyList()
            projection.clear()
            mutableState.value = PocUiState(endpoint = value, themeMode = state.value.themeMode, userLabel = state.value.userLabel, assistantLabel = state.value.assistantLabel, readingScale = state.value.readingScale,
                accentColor = state.value.accentColor, avatarFileName = state.value.avatarFileName)
        }
    }

    fun pair(code: String) = action {
        if (pending.isNotEmpty()) throw ClientStateException(UNKNOWN_MESSAGE)
        val generation = connectionGeneration
        val endpoint = GatewayEndpoint.parse(state.value.endpoint)
        automaticReconnect = true
        local.preferences.saveEndpoint(endpoint.url)
        val capabilityData = client.pair(endpoint, code)
        if (generation != connectionGeneration) { client.disconnect(); throw CancellationException("Connection attempt cancelled") }
        establish(capabilityData)
    }

    fun reconnect() = action { automaticReconnect = true; connectInternal() }

    fun refresh() = action {
        correctionAttempts = 0
        if (!state.value.online) connectInternal()
        else {
            reconcileUnknown()
            refreshProjects()
            state.value.selectedProjectId?.let { refreshThreadLists(it) }
            state.value.selectedThreadId?.let { syncThread(it) }
            refreshNativeDefaultsInternal()
            refreshAccountInternal()
        }
    }

    fun selectProject(projectId: String) = action {
        if (state.value.projects.none { it.id == projectId }) return@action
        resetThread()
        clearArchivedThreads()
        nextThreadCursor = null
        mutableState.value = state.value.copy(selectedProjectId = projectId, threads = emptyList(), error = null, showArchivedThreads = false, nativeDefaults = null, nativeDefaultsError = null)
        scopeKey?.let { local.preferences.saveSelection(it, projectId, null) }
        if (state.value.online) { refreshThreads(projectId); refreshNativeDefaultsInternal() } else loadCachedThreads(projectId)
    }

    fun selectThread(threadId: String) = action {
        val target = state.value.threads.firstOrNull { it.id == threadId } ?: throw ClientStateException("请从当前列表选择会话")
        if (target.archived) throw ClientStateException("请先恢复归档会话")
        selectThreadInternal(threadId)
    }

    fun registerProject(rootId: String, path: String) = action {
        requireOnline("projects")
        if (state.value.roots.none { it.id == rootId }) throw ClientStateException("请选择 Gateway 允许的项目根目录")
        if (!validProjectRelativePath(path)) throw ClientStateException("请输入允许根目录下的相对子目录；不能使用绝对路径、空段或 . / ..")
        if (pending.isNotEmpty()) throw ClientStateException(UNKNOWN_MESSAGE)
        // User input is validated through a read-only endpoint before creating any durable write intent.
        val directory = resource(client.post("project-directories/query", buildJsonObject {
            put("rootId", rootId); put("path", path); put("limit", 1)
        }))
        if (directory.string("rootId") != rootId || directory.string("path") != path || !directory.flag("canRegister"))
            throw ClientStateException("此目录当前不可注册；请检查路径或刷新允许目录")
        val before = state.value.projects.map { it.id }.toSet()
        executeWrite("project.register", "", null, "projects") { operationId ->
            buildJsonObject { put("operationId", operationId); put("rootId", rootId); put("path", path) }
        }
        refreshProjects()
        state.value.projects.firstOrNull { it.id !in before }?.let { project ->
            resetThread()
            clearArchivedThreads()
            mutableState.value = state.value.copy(selectedProjectId = project.id, showArchivedThreads = false, nativeDefaults = null, nativeDefaultsError = null)
            local.preferences.saveSelection(requireScope(), project.id, null)
            refreshThreads(project.id)
            refreshNativeDefaultsInternal()
        }
    }

    fun createThread() = action {
        requireOnline("thread.start")
        val projectId = state.value.selectedProjectId ?: throw ClientStateException("请先选择项目")
        reconcileUnknown()
        checkUnknown(projectId, null)
        mutableState.value = state.value.copy(showArchivedThreads = false)
        val startedEpoch = epoch
        val startedGeneration = connectionGeneration
        val result = executeWrite("thread.start", projectId, null, "projects/${segment(projectId)}/threads") { id ->
            buildJsonObject {
                put("operationId", id); put("expectedEpoch", epoch)
                state.value.permissionPreset.takeUnless { it == "native" }?.let { put("permissionPreset", it) }
                state.value.selectedModel?.let { put("model", it) }
                state.value.selectedEffort?.let { put("effort", it) }
            }
        }
        val createdThread = result.string("nativeThreadId").takeIf { result.string("status") == "accepted" }
        // Preserve the accepted acknowledgement before optional list refresh can fail. This is
        // still only a candidate: selection must confirm native idle in this connection generation.
        createdThread?.let {
            if (state.value.online && position != null && epoch == startedEpoch && connectionGeneration == startedGeneration)
                firstTurnPermit.acceptedStart(projectId, it, startedEpoch, startedGeneration)
            freshThreads.add(it)
            if (state.value.threads.none { thread -> thread.id == it }) mutableState.value = state.value.copy(threads = state.value.threads + ThreadOption(it, "新会话", "idle"))
        }
        refreshThreads(projectId)
        createdThread?.let {
            if (state.value.threads.none { thread -> thread.id == it }) mutableState.value = state.value.copy(threads = state.value.threads + ThreadOption(it, "新会话", "idle"))
            selectThreadInternal(it)
        }
    }

    fun draftChange(text: String) {
        // TextInput's protocol budget is enforced before dispatch; draft editing remains available offline.
        mutableState.value = state.value.copy(draft = text)
        updateControls()
        val scope = scopeKey ?: return
        val project = state.value.selectedProjectId ?: return
        val thread = state.value.selectedThreadId ?: return
        viewModelScope.launch {
            try { draftMutex.withLock { local.state.putDraft(DraftRecord(scope, project, thread, text)) } }
            catch (error: Exception) { handleFailure(error); mutableState.value = state.value.copy(error = "草稿未能保存到本机；暂时禁止发送"); snapshotCurrent = false; updateControls() }
        }
    }

    fun send() = action {
        requireOnline("turn.start")
        val project = state.value.selectedProjectId ?: throw ClientStateException("请先选择项目")
        val thread = state.value.selectedThreadId ?: throw ClientStateException("请先选择会话")
        val text = state.value.draft
        if (text.isBlank()) return@action
        if (text.toByteArray(Charsets.UTF_8).size > 60 * 1024) throw ClientStateException("单次消息限 60 KiB，请缩短草稿")
        reconcileUnknown()
        syncThread(thread)
        checkUnknown(project, thread)
        if ((!snapshotCurrent && !firstTurnAllowed()) || activeTurnId != null || threadStatus !in setOf("idle", "active"))
            throw ClientStateException(if (threadStatus == "notLoaded") "请先点击继续，加载此会话" else "会话尚未就绪，请刷新或等待当前执行结束")
        val scope = requireScope()
        draftMutex.withLock { local.state.putDraft(DraftRecord(scope, project, thread, text)) }
        syncFiles()
        if (files.state.value.busy || files.state.value.hasUnknown) throw ClientStateException("请等待文件操作完成并核对未知附件回执")
        var attachmentClaim = buildJsonObject { }
        val result = executeWrite("turn.start", project, thread, "threads/${segment(thread)}/turns", prepare = { id ->
            attachmentClaim = files.claimForSend(id)
        }) { id ->
            buildJsonObject {
                put("operationId", id); put("projectId", project); put("expectedEpoch", epoch)
                put("input", buildJsonArray { add(buildJsonObject { put("type", "text"); put("text", text) }) })
                state.value.permissionPreset.takeUnless { it == "native" }?.let { put("permissionPreset", it) }
                state.value.selectedModel?.let { put("model", it) }
                state.value.selectedEffort?.let { put("effort", it) }
                attachmentClaim.forEach { (key, value) -> put(key, value) }
            }
        }
        if (result.string("status") == "accepted") {
            activeTurnId = result.string("nativeTurnId")
            snapshotCurrent = false
            draftMutex.withLock {
                if (local.state.draft(scope, project, thread)?.text == text) local.state.putDraft(DraftRecord(scope, project, thread, ""))
            }
            if (state.value.selectedThreadId == thread && state.value.draft == text) mutableState.value = state.value.copy(draft = "")
        }
        scheduleSync()
    }

    fun stop() = action {
        requireOnline("turn.interrupt")
        val project = state.value.selectedProjectId ?: return@action
        val thread = state.value.selectedThreadId ?: return@action
        val turn = activeTurnId ?: throw ClientStateException("没有正在执行的任务，请刷新会话")
        executeWrite("turn.interrupt", project, thread, "threads/${segment(thread)}/turns/${segment(turn)}/interrupt") { id ->
            buildJsonObject { put("operationId", id); put("projectId", project); put("expectedEpoch", epoch) }
        }
        scheduleSync()
    }

    /** Deliberately a button action. Process/Gateway restart never dispatches thread/resume. */
    fun resume() = action {
        requireOnline("thread.resume")
        val project = state.value.selectedProjectId ?: return@action
        val thread = state.value.selectedThreadId ?: return@action
        reconcileUnknown()
        syncThread(thread)
        checkUnknown(project, thread)
        if (!snapshotCurrent || activeTurnId != null) throw ClientStateException("请等待会话同步完成后再继续")
        executeWrite("thread.resume", project, thread, "threads/${segment(thread)}/resume") { id ->
            buildJsonObject { put("operationId", id); put("projectId", project); put("expectedEpoch", epoch) }
        }
        syncThread(thread)
    }

    fun loadMore() = action {
        requireOnline("history")
        val project = state.value.selectedProjectId ?: return@action
        val thread = state.value.selectedThreadId ?: return@action
        if (historyPages >= 20) throw ClientStateException("已加载 20 页；请重新打开会话以回到最新历史")
        val itemPage = itemCursors.entries.firstOrNull()?.let { it.key to it.value }
        val cursor = itemPage?.second ?: nextHistoryCursor ?: return@action
        val version = invalidationVersion
        val data = resource(client.post("threads/${segment(thread)}/history/query", buildJsonObject {
            put("projectId", project); put("cursor", cursor); put("limit", 5)
            itemPage?.let { put("turnId", it.first) }
        }))
        if (version != invalidationVersion || data.string("epoch") != epoch || data.string("historyRevision") != historyRevision)
            throw ClientStateException("历史版本已变化，请刷新后重新加载")
        projection.applyHistory(data, itemPage?.first, older = true)
        inspectorProjection.history(data, itemPage?.first)
        if (itemPage != null) {
            itemCursors.remove(itemPage.first)
            data.string("nextCursor")?.let { itemCursors[itemPage.first] = it }
        } else nextHistoryCursor = data.string("nextCursor")
        readItemCursors(data)
        historyPages++
        cache("history-page", thread, data, project, thread, "${itemPage?.first.orEmpty()}:$cursor")
        saveProjection()
        showProjection()
    }

    fun readPosition(index: Int, offset: Int) {
        val messages = state.value.messages
        if (messages.isEmpty()) return
        val boundedIndex = index.coerceIn(0, messages.lastIndex)
        mutableState.value = state.value.copy(readIndex = boundedIndex, readOffset = offset.coerceAtLeast(0))
        val scope = scopeKey ?: return
        val project = state.value.selectedProjectId ?: return
        val thread = state.value.selectedThreadId ?: return
        val anchor = ReadAnchorRecord(scope, project, thread, messages[boundedIndex].id, offset.coerceAtLeast(0), boundedIndex == messages.lastIndex)
        anchorJob?.cancel()
        anchorJob = viewModelScope.launch {
            delay(150)
            try { local.state.putReadAnchor(anchor) } catch (error: Exception) { handleFailure(error) }
        }
    }

    fun clearCache() = action {
        withCache { local.cache.clearAll() }
        projection.clear()
        snapshotCurrent = false
        replaceTerminalOnSnapshot = true
        mutableState.value = state.value.copy(messages = emptyList(), historyWarning = "历史缓存已清除；草稿与未知操作保留")
        if (state.value.online) {
            refreshProjects()
            state.value.selectedProjectId?.let { refreshThreadLists(it) }
            state.value.selectedThreadId?.let { syncThread(it) }
        }
    }

    fun disconnect() {
        automaticReconnect = false
        reconnectJob?.cancel()
        syncJob?.cancel()
        disconnectTransport()
        client.disconnect()
        mutableState.value = state.value.copy(online = false, connectionLabel = "已断开 · 缓存只读", error = null)
        updateControls()
    }

    private suspend fun connectInternal() {
        val generation = connectionGeneration
        val endpoint = GatewayEndpoint.parse(state.value.endpoint)
        local.preferences.saveEndpoint(endpoint.url)
        mutableState.value = state.value.copy(connectionLabel = "正在连接并校正…")
        val data = client.connect(endpoint)
        if (generation != connectionGeneration) { client.disconnect(); throw CancellationException("Connection attempt cancelled") }
        establish(data)
    }

    private suspend fun establish(data: JsonObject) {
        val attemptGeneration = connectionGeneration
        val identity = client.identity ?: throw ClientStateException("缺少本机配对身份")
        val oldScope = scopeKey
        val newScope = CacheScope(identity.endpoint, identity.installationId, identity.deviceId).key
        if (oldScope != newScope) {
            resetThread()
            mutableState.value = state.value.copy(projects = emptyList(), threads = emptyList(), selectedProjectId = null,
                accountRateLimits = null, accountUsage = null, accountError = null, nativeDefaults = null, nativeDefaultsError = null, showArchivedThreads = false)
        }
        setScope(newScope)
        if (attemptGeneration != connectionGeneration) { client.disconnect(); throw CancellationException("Connection attempt cancelled") }
        epoch = data.string("epoch") ?: throw ClientStateException("Gateway 缺少运行代次")
        capabilityData = data
        capabilities = data.array("capabilities").mapNotNull { value ->
            val capability = value as? JsonObject ?: return@mapNotNull null
            // "unverified" allows the first explicit user operation on the documented stable surface.
            capability.string("name")?.takeIf { capability.flag("supported") && capability.string("availability") in setOf("available", "unverified") }
        }.toSet()
        mutableState.value = state.value.copy(capabilityNames = capabilities, gatewayProtocolMinor = data.obj("protocol")?.number("minor") ?: 0,
            nativeDefaults = null, nativeDefaultsError = null)
        disconnectTransport()
        val generation = connectionGeneration
        freshThreads.clear()
        val ready = CompletableDeferred<Unit>()
        pendingConnectionReady = ready
        events = client.openEvents(null, object : GatewayEventListener {
            override fun onConnection(message: JsonObject) {
                viewModelScope.launch {
                    if (generation != connectionGeneration) return@launch
                    eventMutex.withLock {
                        if (generation != connectionGeneration) return@withLock
                        val actualEpoch = message.string("epoch")
                        if (actualEpoch != epoch || message.string("installationId") != identity.installationId) {
                            ready.completeExceptionally(ClientStateException("Gateway 身份或代次已变化，请重新连接")); return@withLock
                        }
                        position = EventPosition(identity.installationId, epoch, message.number("headSeq") ?: 0)
                        ready.complete(Unit)
                    }
                }
            }
            override fun onEvent(event: JsonObject) {
                viewModelScope.launch {
                    if (generation != connectionGeneration) return@launch
                    receivedEventVersion++
                    // Revocation cannot wait behind notification/receipt IO for an older event.
                    // This establishes no new facts; complete proof still requires a fresh snapshot.
                    val eventThread = event.obj("scope")?.string("threadId")
                    if (eventThread == null || eventThread == state.value.selectedThreadId) revokeFileChangeContexts()
                    if (generation == connectionGeneration) eventMutex.withLock {
                        if (generation != connectionGeneration) return@withLock
                        try { handleEvent(event) } catch (error: Exception) { handleFailure(error) }
                    }
                }
            }
            override fun onFailure(error: GatewayException) {
                viewModelScope.launch {
                    if (generation != connectionGeneration) return@launch
                    ready.completeExceptionally(error)
                    connectionFailed(error)
                }
            }
            override fun onClosed() {
                viewModelScope.launch {
                    if (generation != connectionGeneration) return@launch
                    ready.completeExceptionally(ClientStateException("实时连接已关闭"))
                    connectionFailed(null)
                }
            }
        })
        try { withTimeout(20_000) { ready.await() } }
        finally { if (pendingConnectionReady === ready) pendingConnectionReady = null }
        if (generation != connectionGeneration) throw CancellationException("Connection attempt cancelled")
        mutableState.value = state.value.copy(paired = true, online = true, connectionLabel = "已连接 · HTTPS / WSS", error = null)
        replaceTerminalOnSnapshot = true
        val saved = local.preferences.snapshot()
        if (saved.scopeKey == scopeKey && state.value.selectedProjectId == null) {
            mutableState.value = state.value.copy(selectedProjectId = saved.projectId, selectedThreadId = saved.threadId)
            saved.threadId?.let { loadLocalThread(it) }
        }
        reconcileUnknown()
        observeNativeRead(NativeReadStage.PROJECTS, "连接校正") { refreshProjects() }
        observeNativeRead(NativeReadStage.MODELS, "连接校正") { refreshModels() }
        state.value.selectedProjectId?.let { project -> observeNativeRead(NativeReadStage.ACTIVE_THREADS, "连接校正") { refreshThreads(project) } }
        state.value.selectedThreadId?.let { thread -> observeNativeRead(NativeReadStage.SNAPSHOT, "连接校正") { syncThread(thread) } }
        heartbeatJob = viewModelScope.launch { while (isActive) { delay(15_000); events?.ping() } }
        refreshNativeDefaultsInternal()
        refreshAccountInternal()
        updateControls()
    }

    private suspend fun setScope(value: String) {
        if (scopeKey != value) clearArchivedThreads()
        scopeKey = value
        pendingObserver?.cancel()
        pending = local.state.unresolved(value)
        syncFiles()
        pendingObserver = viewModelScope.launch {
            try {
                local.state.observeUnresolved(value).collect { operations ->
                    if (scopeKey == value) { pending = operations; updateControls() }
                }
            } catch (error: Exception) { handleFailure(error) }
        }
    }

    private suspend fun refreshProjects() {
        val data = resource(client.get("projects"))
        applyProjects(data)
        cache("projects", "", data)
        val project = state.value.selectedProjectId
        if (project != null && state.value.projects.none { it.id == project }) {
            resetThread()
            clearArchivedThreads()
            mutableState.value = state.value.copy(selectedProjectId = null, threads = emptyList(), nativeDefaults = null, nativeDefaultsError = null, showArchivedThreads = false, error = "上次项目已不可用；请选择可用项目")
            local.preferences.saveSelection(requireScope(), null, null)
        }
    }

    private fun applyProjects(data: JsonObject) {
        mutableState.value = state.value.copy(
            roots = data.array("roots").mapNotNull { value -> (value as? JsonObject)?.let { root -> root.string("id")?.let { RootOption(it, root.string("label") ?: it) } } },
            projects = data.array("projects").mapNotNull { value -> (value as? JsonObject)?.let { project ->
                project.string("id")?.takeIf { project.flag("available") }?.let { ProjectOption(it, project.string("name") ?: "项目", project.string("canonicalPath").orEmpty()) }
            } },
        )
    }

    private suspend fun refreshThreads(project: String) {
        val data = resource(client.get("projects/${segment(project)}/threads", mapOf("limit" to "20", "archived" to "false")))
        if (state.value.selectedProjectId != project) return
        applyThreads(data)
        nextThreadCursor = data.string("nextCursor")
        freshThreads.removeAll(state.value.threads.map { it.id }.toSet())
        cache("threads", project, data, project)
        val selected = state.value.selectedThreadId
        if (selected != null && state.value.threads.none { it.id == selected }) {
            // Codex Thread does not expose archived. Confirm membership through the active list,
            // never infer eligibility from a successful thread/read or a guessed path.
            var cursor = data.string("nextCursor")
            var found: JsonObject? = null
            var pages = 1
            while (cursor != null && found == null && pages < 10) {
                val page = resource(client.get("projects/${segment(project)}/threads", mapOf("limit" to "20", "archived" to "false", "cursor" to cursor)))
                found = page.array("threads").mapNotNull { it as? JsonObject }.firstOrNull { it.string("id") == selected }
                cursor = page.string("nextCursor")
                pages++
            }
            if (found != null) {
                freshThreads.remove(selected)
                mutableState.value = state.value.copy(threads = state.value.threads + threadOption(found))
            }
            else if (selected in freshThreads) {
                try {
                    val detail = resource(client.get("projects/${segment(project)}/threads/${segment(selected)}"))
                    mutableState.value = state.value.copy(threads = state.value.threads + threadOption(detail))
                } catch (error: GatewayException) {
                    if (error.httpStatus in listOf(403, 404) && !error.authInvalid) unavailableThread() else throw error
                }
            }
            else {
                unavailableThread()
                if (cursor != null) mutableState.value = state.value.copy(error = "在有界会话列表内无法确认上次会话仍可用；请重新选择会话")
            }
        }
    }

    private fun applyThreads(data: JsonObject) {
        mutableState.value = state.value.copy(
            threads = data.array("threads").mapNotNull { (it as? JsonObject)?.let { thread -> threadOption(thread) } },
            canLoadMoreThreads = data.string("nextCursor") != null,
        )
    }

    private fun threadOption(thread: JsonObject, archived: Boolean = false) = ThreadOption(thread.string("id").orEmpty(),
        thread.string("title")?.takeIf { it.isNotBlank() } ?: thread.string("preview")?.take(64)?.takeIf { it.isNotBlank() } ?: "新会话",
        thread.string("status").orEmpty(), archived = archived)

    private suspend fun selectThreadInternal(thread: String) {
        val project = state.value.selectedProjectId ?: return
        resetThread()
        mutableState.value = state.value.copy(selectedThreadId = thread, error = null)
        local.preferences.saveSelection(requireScope(), project, thread)
        loadLocalThread(thread)
        syncFiles()
        if (state.value.online) {
            reconcileUnknown()
            syncThread(thread)
        }
    }

    private suspend fun syncThread(thread: String) {
        val project = state.value.selectedProjectId ?: return
        if (!state.value.online || state.value.selectedThreadId != thread || position == null) return
        val version = invalidationVersion
        val generation = connectionGeneration
        revokeFileChangeContexts()
        val evidenceVersion = fileChangeEvidenceVersion
        snapshotCurrent = false
        updateControls()
        val data = try {
            readSnapshot(project, thread)
        } catch (error: GatewayException) {
            if (error.code == "NATIVE_HISTORY_NOT_MATERIALIZED" && prepareFirstTurn(project, thread)) return
            if (error.httpStatus in listOf(403, 404) && !error.authInvalid) { unavailableThread(); return } else throw error
        }
        applyVerifiedSnapshot(project, thread, data, version, generation, evidenceVersion)
    }

    private suspend fun applyVerifiedSnapshot(project: String, thread: String, data: JsonObject, version: Long, generation: Int, evidenceVersion: Long) {
        if (state.value.selectedProjectId != project || state.value.selectedThreadId != thread || data.string("epoch") != epoch) return
        if (!snapshotStillCurrent(generation, connectionGeneration, version, invalidationVersion)) {
            scheduleSync()
            return
        }
        val history = data.obj("history") ?: throw ClientStateException("Gateway 历史数据不完整")
        val nativeThread = data.obj("thread") ?: throw ClientStateException("Gateway 会话数据不完整")
        if (nativeThread.flag("archived")) { unavailableThread(); return }
        threadStatus = nativeThread.string("status") ?: "unknown"
        val readback = permissionReadbackUi(nativeThread)
        // A pending approval makes synchronization "synchronizing". It may still carry complete
        // Item facts, but only if no Gateway event occurred during the read and the scope is exact.
        if (evidenceVersion == fileChangeEvidenceVersion && nativeThread.string("id") == thread && nativeThread.string("projectId") == project &&
            data.number("observedStartSeq") != null && data.number("observedStartSeq") == data.number("observedEndSeq") &&
            position?.epoch == epoch && (position?.sequence ?: Long.MAX_VALUE) <= (data.number("observedEndSeq") ?: -1))
            fileChangeContexts.snapshot(FileChangeApprovalScope(epoch, project, thread), history)
        val interactions = data.array("interactions").mapNotNull { (it as? JsonObject)?.let { raw ->
            val parsed = NativeInteractionForms.parse(raw)
            NativeInteractionForms.bindFileChangeContext(parsed, fileChangeContexts.forInteraction(parsed))
        } }
        mutableState.value = state.value.copy(actualModel = nativeThread.string("model"), actualEffort = nativeThread.string("reasoningEffort"), interactions = interactions)
        inspectorProjection.history(history, replace = true)
        firstTurnPermit.invalidate(thread)
        projection.snapshot(history, preserveTerminal = !replaceTerminalOnSnapshot && (historyRevision == null || historyRevision == history.string("historyRevision")))
        replaceTerminalOnSnapshot = false
        activeTurnId = projection.activeTurnId ?: activeTurnId.takeUnless { data.string("synchronization") == "current" }
        historyRevision = history.string("historyRevision")
        nextHistoryCursor = history.string("nextCursor")
        itemCursors.clear(); readItemCursors(history); historyPages = 1
        data.array("operations").forEach { (it as? JsonObject)?.let { receipt -> applyReceipt(receipt, project, thread) } }
        snapshotCurrent = data.string("synchronization") == "current" && version == invalidationVersion &&
            position?.epoch == epoch && (position?.sequence ?: -1) <= (data.number("observedEndSeq") ?: -2)
        mutableState.value = state.value.copy(actualPermissionPreset = readback?.preset, permissionReadback = readback)
        // A new first page replaces this thread's prior page/cursor window. Repeated refreshes
        // must not accumulate opaque cursor tokens or old-revision pages indefinitely.
        val currentScope = requireScope()
        withCache { local.cache.deleteThread(currentScope, project, thread) }
        cache("snapshot", thread, data, project, thread)
        saveProjection()
        val hasInteractions = data.array("interactions").isNotEmpty()
        mutableState.value = state.value.copy(historyWarning = when {
            history.flag("truncated") || projection.limited -> "部分内容未完整加载，可在详情中继续读取并校验"
            hasInteractions -> "正在等待你的确认，请查看当前请求"
            nextHistoryCursor != null || itemCursors.isNotEmpty() -> "已加载最近历史，可继续加载更早内容"
            else -> null
        })
        showProjectionWithAnchor()
        if (!snapshotCurrent && state.value.online) {
            correctionAttempts++
            if (correctionAttempts < if (foreground) 4 else 1) scheduleSync(1_500, resetBudget = false)
            else mutableState.value = state.value.copy(historyWarning = "会话暂未同步完成，已暂停自动刷新。可手动刷新，确认状态前不会发送。")
        } else correctionAttempts = 0
    }

    private suspend fun handleEvent(event: JsonObject) {
        val generation = connectionGeneration
        val current = position ?: return
        val continuity = acceptEvent(current, event.string("installationId").orEmpty(), event.string("epoch").orEmpty(),
            event.number("seq") ?: -1, event.string("kind").orEmpty(), event.string("impact"))
        val disposition = GatewayProtocol.disposition(event)
        val decision = if (continuity in setOf(EventDecision.APPLY, EventDecision.INVALIDATE, EventDecision.SKIP)) {
            when (disposition) {
                EventDisposition.RESYNCHRONIZE -> EventDecision.INVALIDATE
                EventDisposition.SKIP -> EventDecision.SKIP
                EventDisposition.APPLY -> continuity
            }
        } else continuity
        if (decision == EventDecision.DUPLICATE) return
        if (decision == EventDecision.RESET) { connectionFailed(null); return }
        // Notifications consume only whitelisted native shapes and never alter execution state.
        if (continuity in setOf(EventDecision.APPLY, EventDecision.INVALIDATE)) scopeKey?.let { notifications.onVerifiedEvent(it, event) }
        val scope = event.obj("scope")
        val relevant = eventAffectsSelection(scope?.string("projectId"), scope?.string("threadId"), state.value.selectedProjectId, state.value.selectedThreadId)
        val eventThread = scope?.string("threadId")
        val eventKind = event.string("kind")
        val nativeMethod = event.obj("payload")?.string("method")
        if (decision != EventDecision.SKIP && (scope?.string("projectId") == null || scope.string("projectId") == state.value.selectedProjectId) &&
            (eventKind == "history.invalidated" || nativeMethod in setOf("thread/started", "thread/name/updated", "thread/archived", "thread/unarchived", "thread/deleted", "thread/closed")))
            scheduleNavigationRefresh()
        if (relevant && decision != EventDecision.SKIP) {
            revokeFileChangeContexts()
            invalidatePermissionReadback()
        }
        if (relevant && eventThread != null && eventThread == state.value.selectedThreadId) {
            if (decision != EventDecision.SKIP && eventKind == "item.completed" && event.obj("payload")?.obj("item")?.string("type") == "contextCompaction") {
                compactionCompletionVersion++
                showOperationNotice("上下文压缩已完成")
            }
            inspectorProjection.event(event)
            if (eventKind == "native.state") {
                projection.event(event)
                mutableState.value = state.value.copy(messages = projection.messages())
            }
            mutableState.value = state.value.copy(inspector = inspectorProjection.state(state.value.inspector))
            if (eventKind in setOf("interaction.opened", "interaction.resolved")) event.obj("payload")?.let { raw ->
                val interaction = NativeInteractionForms.parse(raw)
                mutableState.value = state.value.copy(interactions = state.value.interactions.filter { it.id != interaction.id } + interaction)
            }
        }
        if (relevant && decision == EventDecision.INVALIDATE && eventKind != "native.state") firstTurnPermit.invalidate(eventThread)
        if (relevant && eventKind == "operation.changed" && (event.obj("payload")?.string("nativeTurnId") != null || event.obj("payload")?.string("status") == "unknown"))
            firstTurnPermit.invalidate(eventThread)
        if (relevant && eventKind in setOf("item.started", "item.delta", "item.completed", "history.invalidated", "connection.reset", "connection.changed"))
            firstTurnPermit.invalidate(eventThread)
        if (relevant && eventKind == "native.state") {
            val payload = event.obj("payload")
            val method = payload?.string("method")
            val nativeStatus = payload?.obj("data")?.obj("thread")?.obj("status")?.string("type")
            if (method != "thread/started" || nativeStatus != "idle") firstTurnPermit.invalidate(eventThread)
        }
        if (event.string("kind") == "native.state" && event.obj("payload")?.string("method") in setOf("thread/archived", "thread/closed", "thread/deleted"))
            scope?.string("threadId")?.let { freshThreads.remove(it) }
        if (decision == EventDecision.INVALIDATE && relevant) {
            invalidationVersion++
            snapshotCurrent = false
            nextHistoryCursor = null; itemCursors.clear()
            if (event.string("kind") in setOf("history.invalidated", "connection.reset")) {
                replaceTerminalOnSnapshot = true
                projection.invalidate()
            }
            if (event.string("kind") == "native.state") {
                val payload = event.obj("payload")
                val nativeTurn = payload?.obj("data")?.obj("turn")
                if (payload?.string("method") == "turn/completed" && nativeTurn?.string("id") == activeTurnId)
                    activeTurnId = null
                if (payload?.string("method") in setOf("thread/archived", "thread/closed", "thread/deleted")) {
                    scope?.string("threadId")?.let { freshThreads.remove(it) }
                    if (scope?.string("threadId") == state.value.selectedThreadId) unavailableThread()
                }
            }
            // native.state never unlocks sending. Only a subsequent current snapshot can do that.
            scheduleSync()
        }
        if (decision == EventDecision.APPLY) {
            if (event.string("kind") == "operation.changed") event.obj("payload")?.let { receipt ->
                applyReceipt(receipt, scope?.string("projectId") ?: state.value.selectedProjectId.orEmpty(), scope?.string("threadId"))
            } else if (relevant && scope != null && state.value.selectedThreadId != null && scope.string("threadId") == state.value.selectedThreadId) {
                val terminalLateEvent = event.string("kind") in setOf("item.delta", "item.started") && projection.isTerminal(scope.string("itemId"))
                if (!terminalLateEvent) {
                    snapshotCurrent = false
                    invalidationVersion++
                    projection.event(event)
                    showProjection()
                    scheduleSync()
                }
            }
        }
        if (generation != connectionGeneration) return
        position = current.copy(sequence = event.number("seq") ?: current.sequence)
        updateControls()
        cacheJob?.cancel()
        cacheJob = viewModelScope.launch {
            delay(200)
            try { saveProjection() } catch (error: Exception) { handleFailure(error) }
        }
    }

    private suspend fun executeWrite(kind: String, project: String, thread: String?, path: String, method: String = "POST", extraGuard: () -> Boolean = { true }, prepare: suspend (String) -> Unit = {}, body: (String) -> JsonObject): JsonObject {
        val scope = requireScope()
        val writeEpoch = epoch
        val generation = connectionGeneration
        val version = invalidationVersion
        val observedTurn = activeTurnId
        val firstTurnCandidate = kind == "turn.start" && !snapshotCurrent && firstTurnAllowed()
        if (!state.value.online || position == null) throw ClientStateException("当前已离线；未派发操作")
        val id = UUID.randomUUID().toString()
        fun dispatchAllowed(): Boolean {
            if (!extraGuard() || !durableStateAvailable || !state.value.online || position == null || scopeKey != scope || epoch != writeEpoch || connectionGeneration != generation) return false
            if (kind == "turn.interrupt") return observedTurn != null && observedTurn == activeTurnId
            if (kind == "turn.steer" && (observedTurn == null || observedTurn != activeTurnId || state.value.selectedThreadId != thread)) return false
            if (blocksWrite(pending.filter { it.operationId != id }.map { PendingIntent(it.projectId, it.threadId, it.kind, it.status) }, project, thread)) return false
            return kind !in setOf("turn.start", "thread.resume") ||
                ((snapshotCurrent || (firstTurnCandidate && thread != null && threadStatus == "idle" &&
                    firstTurnPermit.allows(project, thread, writeEpoch, generation, online = true, unknown = false))) && invalidationVersion == version &&
                    activeTurnId == null && state.value.selectedThreadId == thread)
        }
        if (kind in setOf("turn.start", "thread.resume", "interaction.respond") && thread == state.value.selectedThreadId)
            invalidatePermissionReadback()
        // Durable commit happens before the request is constructed/dispatched, and this ID is never retried.
        local.state.insertOperation(OperationRecord(scope, id, project, thread, kind))
        val remaining = local.state.unresolved(scope)
        if (scopeKey == scope) { pending = remaining; updateControls() }
        if (!dispatchAllowed()) {
            // There has been no HTTP dispatch at this local cut point, so notSent is known.
            local.state.updateOperationReceipt(scope, id, "rejected", "notSent")
            files.settleClaim(id, "rejected", "notSent")
            pending = local.state.unresolved(scope)
            throw ClientStateException("连接已改变，操作尚未派发；请重新校正后显式操作")
        }
        // This cut point contains only local work. Failure proves the HTTP operation was not sent.
        val requestBody = prepareWriteRequest({
            prepare(id)
            body(id)
        }, {
            local.state.updateOperationReceipt(scope, id, "rejected", "notSent")
            files.settleClaim(id, "rejected", "notSent")
            pending = local.state.unresolved(scope)
        })
        val response = dispatchWriteRequest({ markDispatched ->
            val beforeDispatch: () -> Unit = {
                if (!dispatchAllowed()) throw DispatchPreventedException()
                if (kind == "turn.start" && thread != null) {
                    if (firstTurnCandidate && !snapshotCurrent && !firstTurnPermit.consume(project, thread, writeEpoch, generation))
                        throw DispatchPreventedException()
                    // Local preparation/auth failures keep the candidate. Once enqueue is reached,
                    // even a lost ACK consumes it; no suspension separates consumption and dispatch.
                    firstTurnPermit.invalidate(thread)
                }
                markDispatched()
            }
            if (method == "DELETE") client.delete(path, requestBody, beforeDispatch)
            else client.post(path, requestBody, beforeDispatch)
        }, {
            local.state.updateOperationReceipt(scope, id, "rejected", "notSent")
            files.settleClaim(id, "rejected", "notSent")
            pending = local.state.unresolved(scope)
        })
        val receipt = response.obj("operation") ?: throw ClientStateException("操作结果未知；只查询回执，不会自动重发")
        applyReceipt(receipt, project, thread)
        if (receipt.string("status") == "rejected") {
            val errorCode = receipt.string("errorCode") ?: "REJECTED"
            throw ClientStateException(if (errorCode == "THREAD_LIFECYCLE_CHANGED")
                "历史尚未就绪或会话状态已变化，请刷新后重新确认。" else "请求未执行（$errorCode）")
        }
        return receipt
    }

    private suspend fun readSnapshot(project: String, thread: String): JsonObject {
        var last: GatewayException? = null
        repeat(3) { attempt ->
            try {
                return resource(client.post("threads/${segment(thread)}/snapshot", buildJsonObject { put("projectId", project) }))
            } catch (error: GatewayException) {
                if (error.code !in setOf("HISTORY_BUSY", "HISTORY_STALE", "NATIVE_BUSY", "NATIVE_UNSUPPORTED") || attempt == 2) throw error
                last = error
                delay(250L * (attempt + 1))
                if (!state.value.online || position == null) throw ClientStateException("已离线，停止只读快照重试")
            }
        }
        throw last ?: ClientStateException("无法读取会话状态")
    }

    private suspend fun prepareFirstTurn(project: String, thread: String): Boolean {
        val generation = connectionGeneration
        val version = invalidationVersion
        if (!state.value.online || position == null || !firstTurnPermit.isCandidate(project, thread, epoch, generation)) return false
        val detail = resource(client.get("projects/${segment(project)}/threads/${segment(thread)}"))
        if (!snapshotStillCurrent(generation, connectionGeneration, version, invalidationVersion) ||
            state.value.selectedThreadId != thread || detail.string("id") != thread || detail.string("projectId") != project) {
            scheduleSync()
            return false
        }
        if (!firstTurnPermit.confirmNativeIdle(project, thread, epoch, generation, detail.string("status").orEmpty())) return false
        threadStatus = "idle"
        val readback = permissionReadbackUi(detail)
        mutableState.value = state.value.copy(actualPermissionPreset = readback?.preset, permissionReadback = readback, actualModel = detail.string("model"), actualEffort = detail.string("reasoningEffort"))
        activeTurnId = null
        snapshotCurrent = false
        mutableState.value = state.value.copy(error = null, historyWarning = FIRST_TURN_MESSAGE)
        updateControls()
        return true
    }

    private fun firstTurnAllowed(): Boolean {
        val project = state.value.selectedProjectId ?: return false
        val thread = state.value.selectedThreadId ?: return false
        val unknown = blocksWrite(pending.map { PendingIntent(it.projectId, it.threadId, it.kind, it.status) }, project, thread)
        return firstTurnPermit.allows(project, thread, epoch, connectionGeneration, state.value.online && position != null, unknown)
    }

    private suspend fun applyReceipt(receipt: JsonObject, project: String, thread: String?) {
        val scope = scopeKey ?: return
        val id = receipt.string("operationId") ?: return
        val status = receipt.string("status") ?: return
        if (status !in setOf("accepted", "rejected", "unknown")) { snapshotCurrent = false; return }
        if (local.state.operation(scope, id) == null && status == "unknown") local.state.insertOperation(OperationRecord(scope, id, project, thread, "recovered.unknown"))
        local.state.updateOperationReceipt(scope, id, status, receipt.string("delivery") ?: "unknown", receipt.string("nativeThreadId"),
            receipt.string("nativeTurnId"), receipt.toString())
        val effective = local.state.operation(scope, id)
        if (effective != null) {
            files.settleClaim(id, effective.status, effective.delivery)
            if (effective.status != "unknown") fileDispatchScopes.remove(id)
        }
        val remaining = local.state.unresolved(scope)
        if (scopeKey == scope) { pending = remaining; updateControls() }
    }

    private suspend fun reconcileUnknown() {
        val scope = requireScope()
        for (operation in local.state.unresolved(scope)) {
            try {
                val receipt = resource(client.get("operations/${segment(operation.operationId)}"))
                applyReceipt(receipt, operation.projectId, operation.threadId)
            } catch (error: GatewayException) {
                // A missing receipt proves nothing about delivery. Keep this durable unknown.
                if (error.httpStatus != 404) throw error
            }
        }
        pending = local.state.unresolved(scope)
        updateControls()
    }

    private fun showOperationNotice(message: String) {
        operationNoticeJob?.cancel()
        mutableState.value = state.value.copy(operationStatusMessage = message)
        operationNoticeJob = viewModelScope.launch {
            delay(8_000)
            if (state.value.operationStatusMessage == message) mutableState.value = state.value.copy(operationStatusMessage = null)
        }
    }

    private fun scheduleNavigationRefresh() {
        val project = state.value.selectedProjectId ?: return
        val generation = connectionGeneration
        navigationSyncJob?.cancel()
        navigationSyncJob = viewModelScope.launch {
            delay(250)
            actionMutex.withLock {
                if (generation != connectionGeneration || state.value.selectedProjectId != project || !state.value.online) return@withLock
                try { refreshThreadLists(project) } catch (error: Exception) { handleFailure(error) }
            }
        }
    }

    private fun scheduleSync(delayMs: Long = 300, resetBudget: Boolean = true) {
        if (!state.value.online) return
        if (resetBudget) correctionAttempts = 0
        syncJob?.cancel()
        syncJob = viewModelScope.launch {
            delay(delayMs)
            actionMutex.withLock {
                try {
                    reconcileUnknown()
                    state.value.selectedThreadId?.let { syncThread(it) }
                } catch (error: Exception) { handleFailure(error) }
            }
        }
    }

    private suspend fun loadCached(saved: ClientPreferenceSnapshot) {
        val scope = scopeKey ?: return
        cached("projects")?.let(::applyProjects)
        if (saved.scopeKey == scope) {
            mutableState.value = state.value.copy(selectedProjectId = saved.projectId, selectedThreadId = saved.threadId)
            saved.projectId?.let { loadCachedThreads(it) }
            saved.threadId?.let { loadLocalThread(it) }
        }
    }

    private suspend fun loadCachedThreads(project: String) { nextThreadCursor = null; cached("threads", project)?.let(::applyThreads) }

    private suspend fun loadLocalThread(thread: String) {
        val scope = scopeKey ?: return
        val project = state.value.selectedProjectId ?: return
        cached("projection", thread)?.let { projection.restoreCached(it) }
        cached("snapshot", thread)?.obj("history")?.let { inspectorProjection.history(it, replace = true) }
        inspectorProjection.restoreUsage(projection.cachedTokenUsage())
        mutableState.value = state.value.copy(draft = local.state.draft(scope, project, thread)?.text.orEmpty())
        showProjectionWithAnchor()
    }

    private suspend fun showProjectionWithAnchor() {
        val scope = scopeKey ?: return
        val project = state.value.selectedProjectId ?: return
        val thread = state.value.selectedThreadId ?: return
        val anchor = local.state.readAnchor(scope, project, thread)
        val messages = projection.messages()
        val index = messages.indexOfFirst { it.id == anchor?.itemId }
        // First nonempty publication includes the durable reading position in the same UI frame.
        mutableState.value = state.value.copy(inspector = inspectorProjection.state(state.value.inspector), messages = messages,
            readIndex = if (index >= 0) index else state.value.readIndex.coerceIn(0, messages.lastIndex.coerceAtLeast(0)),
            readOffset = if (index >= 0) anchor?.offset ?: 0 else 0,
            historyWarning = if (projection.limited) "当前最多展示 250 条内容，部分历史尚未完整加载" else state.value.historyWarning)
        updateControls()
    }

    private suspend fun cached(kind: String, resourceId: String = ""): JsonObject? {
        val scope = scopeKey ?: return null
        val project = if (kind == "projects") "" else if (kind == "threads") resourceId else state.value.selectedProjectId.orEmpty()
        val row = withCache { local.cache.get(scope, kind, resourceId, projectId = project) } ?: return null
        return try { Json.parseToJsonElement(row.payloadJson) as? JsonObject }
        catch (_: Exception) { withCache { local.cache.clearScope(scope) }; mutableState.value = state.value.copy(historyWarning = "损坏的历史缓存已丢弃；可重新连接重建"); null }
    }

    private suspend fun cache(kind: String, resourceId: String, data: JsonObject, project: String? = null, thread: String? = null, pageKey: String = "") {
        val row = CachedProjection(requireScope(), kind, resourceId, pageKey, data.toString(), epoch,
            historyRevision, project.orEmpty(), thread, complete = !data.flag("truncated"))
        withCache { local.cache.put(row) }
    }

    private suspend fun saveProjection() {
        val scope = scopeKey ?: return
        val thread = state.value.selectedThreadId ?: return
        val project = state.value.selectedProjectId ?: return
        val data = projection.cached()
        val cursor = position
        val row = CachedProjection(scope, "projection", thread, payloadJson = data.toString(), epoch = epoch,
            revision = historyRevision, projectId = project, threadId = thread, complete = snapshotCurrent)
        withCache {
            if (cursor != null && cursor.epoch == row.epoch) local.cache.putWithCursor(row, StoredEventCursor(scope, row.epoch, cursor.sequence))
            else local.cache.put(row)
        }
    }

    private suspend fun <T> withCache(block: suspend () -> T): T = cacheMutex.withLock {
        try { block() }
        catch (_: SQLiteDatabaseCorruptException) {
            local.rebuildCache()
            mutableState.value = state.value.copy(historyWarning = "损坏的历史缓存已重建；草稿与未知操作保持独立")
            block()
        }
    }

    private fun readItemCursors(data: JsonObject) {
        data.obj("itemCursors")?.forEach { (turn, value) -> (value as? JsonPrimitive)?.contentOrNull?.let { itemCursors[turn] = it } }
    }

    private fun showProjection() {
        mutableState.value = state.value.copy(inspector = inspectorProjection.state(state.value.inspector), messages = projection.messages(),
            historyWarning = if (projection.limited) "当前最多展示 250 条内容，部分历史尚未完整加载" else state.value.historyWarning)
        updateControls()
    }

    private fun resetThread() {
        revokeFileChangeContexts()
        syncJob?.cancel(); cacheJob?.cancel(); anchorJob?.cancel(); operationNoticeJob?.cancel()
        snapshotCurrent = false; activeTurnId = null; threadStatus = "unknown"; correctionAttempts = 0
        nextHistoryCursor = null; itemCursors.clear(); historyRevision = null; historyPages = 0
        replaceTerminalOnSnapshot = true; projection.clear(); inspectorProjection.clear(); invalidationVersion++
        mutableState.value = state.value.copy(selectedThreadId = null, messages = emptyList(), draft = "", readIndex = 0, readOffset = 0,
            executionLabel = "", historyWarning = null, operationStatusMessage = null, inspector = InspectorUiState(), interactions = emptyList(), actualPermissionPreset = null, permissionReadback = null, permissionPreset = "native", selectedModel = null, selectedEffort = null, actualModel = null, actualEffort = null)
        updateControls()
    }

    private suspend fun unavailableThread() {
        state.value.selectedThreadId?.let { firstTurnPermit.invalidate(it) }
        resetThread()
        mutableState.value = state.value.copy(error = "上次会话不存在、已归档或不可访问；请选择其他会话")
        local.preferences.saveSelection(requireScope(), state.value.selectedProjectId, null)
    }

    private fun requireOnline(capability: String) {
        if (!durableStateAvailable) throw ClientStateException("本机持久状态不可用，已禁止写入；请保留草稿和未确认操作数据以供恢复")
        if (!state.value.online || position == null) throw ClientStateException("离线仅可查看缓存和编辑草稿，请先重新连接")
        if (capability !in capabilities) throw ClientStateException("当前 Gateway 未提供此能力：$capability")
    }

    private fun checkUnknown(project: String, thread: String?) {
        if (blocksWrite(pending.map { PendingIntent(it.projectId, it.threadId, it.kind, it.status) }, project, thread))
            throw ClientStateException(UNKNOWN_MESSAGE)
    }

    private fun updateControls() {
        viewModelScope.launch { try { syncFiles() } catch (error: Exception) { if (error !is CancellationException) mutableState.value = state.value.copy(error = "附件本机状态无法加载；请保留数据并检查存储") } }
        val current = state.value
        val blocked = current.selectedProjectId?.let { project -> blocksWrite(pending.map { PendingIntent(it.projectId, it.threadId, it.kind, it.status) }, project, current.selectedThreadId) } ?: pending.isNotEmpty()
        val ready = current.online && position != null && !current.busy && current.selectedThreadId != null && durableStateAvailable
        mutableState.value = current.copy(
            actualPermissionPreset = current.actualPermissionPreset.takeIf { current.online && position != null && !blocked && activeTurnId == null && (snapshotCurrent || firstTurnAllowed()) },
            permissionReadback = current.permissionReadback.takeIf { current.online && position != null && !blocked && activeTurnId == null && (snapshotCurrent || firstTurnAllowed()) },
            canSend = ready && (snapshotCurrent || firstTurnAllowed()) && !blocked && activeTurnId == null && threadStatus in setOf("idle", "active") && current.draft.isNotBlank() && "turn.start" in capabilities,
            canCreateThread = current.online && position != null && !current.busy && durableStateAvailable && "thread.start" in capabilities &&
                current.selectedProjectId?.let { project -> !blocksWrite(pending.map { PendingIntent(it.projectId, it.threadId, it.kind, it.status) }, project, null) } == true,
            activeTurnId = activeTurnId.takeIf { current.online && position != null },
            canSteer = ready && activeTurnId != null && !blocked && current.draft.isNotBlank() && "turn.steer" in capabilities,
            canManageThread = ready && !blocked && snapshotCurrent && activeTurnId == null && threadStatus in setOf("idle", "active", "notLoaded"),
            canStop = ready && activeTurnId != null && "turn.interrupt" in capabilities,
            canResume = ready && snapshotCurrent && !blocked && activeTurnId == null && threadStatus == "notLoaded" && "thread.resume" in capabilities,
            canLoadMore = current.online && !current.busy && historyPages < 20 && (nextHistoryCursor != null || itemCursors.isNotEmpty()),
            unknownWarning = if (blocked) UNKNOWN_MESSAGE else null,
            unresolvedOperations = pending.map { UnknownOperationUi(it.operationId, it.kind, it.projectId, it.threadId, it.createdAt, it.status, it.delivery, it.nativeThreadId, it.nativeTurnId) },
            canLoadMoreThreads = current.online && !current.busy && nextThreadCursor != null,
            canLoadMoreArchivedThreads = current.online && !current.busy && nextArchivedThreadCursor != null,
            executionLabel = when {
                !current.online -> "离线 · 仅查看缓存与编辑草稿"
                activeTurnId != null -> "正在执行"
                current.selectedThreadId == null -> "请选择或新建会话"
                threadStatus == "notLoaded" -> "会话尚未加载，点击继续"
                firstTurnAllowed() -> FIRST_TURN_MESSAGE
                !snapshotCurrent -> "正在同步会话"
                else -> "已同步"
            },
        )
    }

    private fun resource(envelope: JsonObject): JsonObject {
        if (envelope.string("epoch") != epoch) {
            invalidationVersion++
            replaceTerminalOnSnapshot = true
            nextHistoryCursor = null; itemCursors.clear()
            connectionFailed(null)
            throw ClientStateException("Gateway 运行代次已变化，正在只读重连并校正")
        }
        return envelope.obj("data") ?: throw ClientStateException("Gateway 返回的数据不完整")
    }

    private fun action(queue: Boolean = false, block: suspend () -> Unit): Job = viewModelScope.launch {
        if (!queue && state.value.busy) return@launch
        actionMutex.withLock {
            operationNoticeJob?.cancel()
            mutableState.value = state.value.copy(busy = true, error = null, operationStatusMessage = null)
            updateControls()
            try { block() } catch (error: Exception) { handleFailure(error) }
            finally { mutableState.value = state.value.copy(busy = false); updateControls() }
        }
    }

    private fun handleFailure(error: Exception) {
        if (error is CancellationException && error !is TimeoutCancellationException) throw error
        when (error) {
            is NativeReadFailed -> {
                // Classify the original cause first, including auth revocation and local database
                // corruption. Adding a stage must never weaken the existing recovery barriers.
                handleFailure(error.cause as Exception)
                mutableState.value = state.value.copy(error = "${error.context}：${error.stage.label}失败（${error.elapsedMillis} ms）。${state.value.error.orEmpty()}")
            }
            is SQLiteDatabaseCorruptException -> {
                durableStateAvailable = false
                snapshotCurrent = false
                mutableState.value = state.value.copy(error = "本机数据库损坏，已禁止写入；草稿和未确认操作不会自动删除")
            }
            is TimeoutCancellationException -> {
                mutableState.value = state.value.copy(error = "连接超时；已保留缓存和未确认操作")
                connectionFailed(null)
            }
            is GatewayException -> {
                mutableState.value = state.value.copy(error = error.userMessage)
                // The local body-size guard runs before enqueue and says nothing about transport
                // health. Keep the same-generation first-turn proof after this known notSent.
                if (error.authInvalid || error.code == "ACCESS_EXPIRED" || (error.httpStatus == null && error.code != "REQUEST_TOO_LARGE")) connectionFailed(error)
                else if (error.code.contains("CURSOR") || error.code.contains("STALE")) {
                    snapshotCurrent = false; invalidationVersion++; nextHistoryCursor = null; itemCursors.clear(); scheduleSync()
                }
            }
            is ClientStateException -> mutableState.value = state.value.copy(error = error.message)
            is DispatchPreventedException -> mutableState.value = state.value.copy(error = "连接状态已改变；操作未派发，请刷新后显式操作")
            else -> { snapshotCurrent = false; mutableState.value = state.value.copy(error = "本机状态或通信校正失败；请重新连接，未确认操作不会重发") }
        }
        updateControls()
    }

    private fun connectionFailed(error: GatewayException?) {
        disconnectTransport()
        mutableState.value = state.value.copy(online = false,
            connectionLabel = if (error?.authInvalid == true) "设备身份失效 · 请重新配对" else "离线缓存 · 等待重连",
            paired = if (error?.authInvalid == true) false else state.value.paired,
            error = error?.userMessage ?: state.value.error)
        updateControls()
        if (error?.authInvalid == true) automaticReconnect = false
        if (automaticReconnect && reconnectJob?.isActive != true) {
            reconnectJob = viewModelScope.launch {
                var pause = 2_000L
                var attempts = 0
                while (isActive && automaticReconnect && !state.value.online && attempts < (if (foreground) 8 else 2)) {
                    attempts++
                    delay(pause)
                    actionMutex.withLock {
                        try { connectInternal() } catch (failure: Exception) { handleFailure(failure) }
                    }
                    pause = (pause * 2).coerceAtMost(30_000)
                }
                if (!state.value.online) mutableState.value = state.value.copy(connectionLabel = "离线缓存 · 自动重连已暂停，可点重新连接")
            }
        }
    }

    private fun invalidatePermissionReadback() {
        if (state.value.actualPermissionPreset != null || state.value.permissionReadback != null)
            mutableState.value = state.value.copy(actualPermissionPreset = null, permissionReadback = null)
    }

    private fun disconnectTransport() {
        navigationSyncJob?.cancel()
        mutableState.value = state.value.copy(nativeDefaults = null, nativeDefaultsError = null)
        revokeFileChangeContexts()
        invalidatePermissionReadback()
        connectionGeneration++
        pendingConnectionReady?.cancel()
        pendingConnectionReady = null
        firstTurnPermit.invalidate()
        freshThreads.clear()
        events?.close(); events = null
        heartbeatJob?.cancel()
        position = null; snapshotCurrent = false; activeTurnId = null
        // Do not clear the freshly exchanged HTTP access while replacing only the WSS subscription.
    }

    private fun requireScope() = scopeKey ?: throw ClientStateException("尚未建立本机配对身份")
    private fun segment(value: String) = GatewayClient.segment(value)

    override fun onCleared() {
        automaticReconnect = false
        disconnectTransport()
        client.disconnect()
        local.close()
        super.onCleared()
    }

    private class ClientStateException(message: String) : Exception(message)
    private class DispatchPreventedException : Exception()
    private companion object {
        const val UNKNOWN_MESSAGE = "有请求的结果尚未确认。已保留记录，只会查询结果，不会自动重发，请勿重复提交。可刷新会话，或停止正在执行的任务。查不到记录也不代表未执行。"
        const val FIRST_TURN_MESSAGE = "新会话历史尚未生成，可发送首条消息"
    }
}
