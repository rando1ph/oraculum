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

/** Native PoC coordinator. All execution remains in the Gateway and official Codex. */
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
    private var scopeKey: String? = null
    private var epoch = ""
    private var position: EventPosition? = null
    private var events: EventConnectionHandle? = null
    private var pendingConnectionReady: CompletableDeferred<Unit>? = null
    private var connectionGeneration = 0
    private var invalidationVersion = 0L
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

    init {
        action {
            val saved = local.preferences.snapshot()
            mutableState.value = state.value.copy(endpoint = saved.endpoint)
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

    fun endpointChange(value: String) {
        if (state.value.online || state.value.busy) return
        if (value != state.value.endpoint) {
            automaticReconnect = false
            reconnectJob?.cancel()
            disconnectTransport()
            scopeKey = null
            pendingObserver?.cancel()
            pending = emptyList()
            projection.clear()
            mutableState.value = PocUiState(endpoint = value)
        }
    }

    fun pair(code: String) = action {
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
        if (!state.value.online) connectInternal()
        else {
            reconcileUnknown()
            refreshProjects()
            state.value.selectedProjectId?.let { refreshThreads(it) }
            state.value.selectedThreadId?.let { syncThread(it) }
        }
    }

    fun selectProject(projectId: String) = action {
        if (state.value.projects.none { it.id == projectId }) return@action
        resetThread()
        mutableState.value = state.value.copy(selectedProjectId = projectId, threads = emptyList(), error = null)
        scopeKey?.let { local.preferences.saveSelection(it, projectId, null) }
        if (state.value.online) refreshThreads(projectId) else loadCachedThreads(projectId)
    }

    fun selectThread(threadId: String) = action { selectThreadInternal(threadId) }

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
            mutableState.value = state.value.copy(selectedProjectId = project.id)
            local.preferences.saveSelection(requireScope(), project.id, null)
            refreshThreads(project.id)
        }
    }

    fun createThread() = action {
        requireOnline("thread.start")
        val projectId = state.value.selectedProjectId ?: throw ClientStateException("请先选择项目")
        reconcileUnknown()
        checkUnknown(projectId, null)
        val startedEpoch = epoch
        val startedGeneration = connectionGeneration
        val result = executeWrite("thread.start", projectId, null, "projects/${segment(projectId)}/threads") { id ->
            buildJsonObject { put("operationId", id); put("expectedEpoch", epoch); put("permissionPreset", "read-only") }
        }
        refreshThreads(projectId)
        if (result.string("status") == "accepted") result.string("nativeThreadId")?.let {
            if (state.value.online && position != null && epoch == startedEpoch && connectionGeneration == startedGeneration)
                firstTurnPermit.acceptedStart(projectId, it, startedEpoch, startedGeneration)
            freshThreads.add(it)
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
        if (text.toByteArray(Charsets.UTF_8).size > 60 * 1024) throw ClientStateException("PoC 单次消息限 60 KiB，请缩短草稿")
        reconcileUnknown()
        syncThread(thread)
        checkUnknown(project, thread)
        if ((!snapshotCurrent && !firstTurnAllowed()) || activeTurnId != null || threadStatus !in setOf("idle", "active"))
            throw ClientStateException(if (threadStatus == "notLoaded") "请先显式恢复此原生会话" else "原生状态尚未就绪，请刷新或等待当前执行结束")
        val scope = requireScope()
        draftMutex.withLock { local.state.putDraft(DraftRecord(scope, project, thread, text)) }
        val result = executeWrite("turn.start", project, thread, "threads/${segment(thread)}/turns") { id ->
            buildJsonObject {
                put("operationId", id); put("projectId", project); put("expectedEpoch", epoch)
                put("input", buildJsonArray { add(buildJsonObject { put("type", "text"); put("text", text) }) })
                put("permissionPreset", "read-only")
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
        val turn = activeTurnId ?: throw ClientStateException("没有可确认的活动 Turn；请刷新原生状态")
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
        if (!snapshotCurrent || activeTurnId != null) throw ClientStateException("请等待原生状态校正后再恢复会话")
        executeWrite("thread.resume", project, thread, "threads/${segment(thread)}/resume") { id ->
            buildJsonObject { put("operationId", id); put("projectId", project); put("expectedEpoch", epoch) }
        }
        syncThread(thread)
    }

    fun loadMore() = action {
        requireOnline("history")
        val project = state.value.selectedProjectId ?: return@action
        val thread = state.value.selectedThreadId ?: return@action
        if (historyPages >= 20) throw ClientStateException("PoC 已加载 20 页；请重新打开会话以回到最新历史")
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
            state.value.selectedProjectId?.let { refreshThreads(it) }
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
            mutableState.value = state.value.copy(projects = emptyList(), threads = emptyList(), selectedProjectId = null)
        }
        setScope(newScope)
        if (attemptGeneration != connectionGeneration) { client.disconnect(); throw CancellationException("Connection attempt cancelled") }
        epoch = data.string("epoch") ?: throw ClientStateException("Gateway 缺少运行代次")
        capabilities = data.array("capabilities").mapNotNull { value ->
            val capability = value as? JsonObject ?: return@mapNotNull null
            // "unverified" allows the first explicit user operation on the documented stable surface.
            capability.string("name")?.takeIf { capability.flag("supported") && capability.string("availability") in setOf("available", "unverified") }
        }.toSet()
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
        refreshProjects()
        state.value.selectedProjectId?.let { refreshThreads(it) }
        state.value.selectedThreadId?.let { syncThread(it) }
        heartbeatJob = viewModelScope.launch { while (isActive) { delay(15_000); events?.ping() } }
        updateControls()
    }

    private suspend fun setScope(value: String) {
        scopeKey = value
        pendingObserver?.cancel()
        pending = local.state.unresolved(value)
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
            mutableState.value = state.value.copy(selectedProjectId = null, threads = emptyList(), error = "上次项目已不可用；请选择可用项目")
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
            threads = data.array("threads").mapNotNull { (it as? JsonObject)?.let(::threadOption) },
            historyWarning = if (data.string("nextCursor") != null || data.flag("truncated")) "PoC 会话入口显示最近 20 条；上次会话仍可恢复" else state.value.historyWarning,
        )
    }

    private fun threadOption(thread: JsonObject) = ThreadOption(thread.string("id").orEmpty(),
        thread.string("title")?.takeIf { it.isNotBlank() } ?: thread.string("preview")?.take(64)?.takeIf { it.isNotBlank() } ?: "新会话",
        thread.string("status").orEmpty())

    private suspend fun selectThreadInternal(thread: String) {
        val project = state.value.selectedProjectId ?: return
        resetThread()
        mutableState.value = state.value.copy(selectedThreadId = thread, error = null)
        local.preferences.saveSelection(requireScope(), project, thread)
        loadLocalThread(thread)
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
        snapshotCurrent = false
        updateControls()
        val data = try {
            readSnapshot(project, thread)
        } catch (error: GatewayException) {
            if (error.code == "NATIVE_HISTORY_NOT_MATERIALIZED" && prepareFirstTurn(project, thread)) return
            if (error.httpStatus in listOf(403, 404) && !error.authInvalid) { unavailableThread(); return } else throw error
        }
        if (state.value.selectedThreadId != thread || data.string("epoch") != epoch) return
        if (!snapshotStillCurrent(generation, connectionGeneration, version, invalidationVersion)) {
            scheduleSync()
            return
        }
        val history = data.obj("history") ?: throw ClientStateException("Gateway 历史数据不完整")
        val nativeThread = data.obj("thread") ?: throw ClientStateException("Gateway 会话数据不完整")
        if (nativeThread.flag("archived")) { unavailableThread(); return }
        threadStatus = nativeThread.string("status") ?: "unknown"
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
        // A new first page replaces this thread's prior page/cursor window. Repeated refreshes
        // must not accumulate opaque cursor tokens or old-revision pages indefinitely.
        val currentScope = requireScope()
        withCache { local.cache.deleteThread(currentScope, project, thread) }
        cache("snapshot", thread, data, project, thread)
        saveProjection()
        val interactions = data.array("interactions").isNotEmpty()
        mutableState.value = state.value.copy(historyWarning = when {
            history.flag("truncated") || projection.limited -> "历史含受限投影；完整详情留待后续阶段"
            interactions -> "原生执行正在等待交互；PoC 暂不提供完整审批表单，可停止当前执行"
            nextHistoryCursor != null || itemCursors.isNotEmpty() -> "已加载最近历史，可继续加载更早内容"
            else -> null
        })
        showProjectionWithAnchor()
        if (!snapshotCurrent && state.value.online) scheduleSync(1_500)
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
        val scope = event.obj("scope")
        val relevant = scope?.string("threadId") == null || scope.string("threadId") == state.value.selectedThreadId
        val eventThread = scope?.string("threadId")
        val eventKind = event.string("kind")
        if (decision == EventDecision.INVALIDATE && eventKind != "native.state") firstTurnPermit.invalidate(eventThread)
        if (eventKind == "operation.changed" && (event.obj("payload")?.string("nativeTurnId") != null || event.obj("payload")?.string("status") == "unknown"))
            firstTurnPermit.invalidate(eventThread)
        if (eventKind in setOf("item.started", "item.delta", "item.completed", "history.invalidated", "connection.reset", "connection.changed"))
            firstTurnPermit.invalidate(eventThread)
        if (eventKind == "native.state") {
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

    private suspend fun executeWrite(kind: String, project: String, thread: String?, path: String, body: (String) -> JsonObject): JsonObject {
        val scope = requireScope()
        val writeEpoch = epoch
        val generation = connectionGeneration
        val version = invalidationVersion
        val observedTurn = activeTurnId
        val firstTurnCandidate = kind == "turn.start" && !snapshotCurrent && firstTurnAllowed()
        var firstTurnClaimed = false
        if (!state.value.online || position == null) throw ClientStateException("当前已离线；未派发操作")
        val id = UUID.randomUUID().toString()
        fun dispatchAllowed(): Boolean {
            if (!durableStateAvailable || !state.value.online || position == null || scopeKey != scope || epoch != writeEpoch || connectionGeneration != generation) return false
            if (kind == "turn.interrupt") return observedTurn != null && observedTurn == activeTurnId
            if (blocksWrite(pending.filter { it.operationId != id }.map { PendingIntent(it.projectId, it.threadId, it.kind, it.status) }, project, thread)) return false
            return kind !in setOf("turn.start", "thread.resume") ||
                ((snapshotCurrent || (firstTurnClaimed && threadStatus == "idle")) && invalidationVersion == version &&
                    activeTurnId == null && state.value.selectedThreadId == thread)
        }
        // Durable commit happens before the request is constructed/dispatched, and this ID is never retried.
        local.state.insertOperation(OperationRecord(scope, id, project, thread, kind))
        if (kind == "turn.start" && thread != null) {
            firstTurnClaimed = firstTurnCandidate && firstTurnPermit.consume(project, thread, writeEpoch, generation)
            firstTurnPermit.invalidate(thread) // Every durable Turn intent, including unknown, consumes this proof.
        }
        val remaining = local.state.unresolved(scope)
        if (scopeKey == scope) { pending = remaining; updateControls() }
        if (!dispatchAllowed()) {
            // There has been no HTTP dispatch at this local cut point, so notSent is known.
            local.state.updateOperationReceipt(scope, id, "rejected", "notSent")
            pending = local.state.unresolved(scope)
            throw ClientStateException("连接已改变，操作尚未派发；请重新校正后显式操作")
        }
        val response = try {
            client.post(path, body(id)) {
                if (!dispatchAllowed()) throw DispatchPreventedException()
            }
        } catch (_: DispatchPreventedException) {
            local.state.updateOperationReceipt(scope, id, "rejected", "notSent")
            pending = local.state.unresolved(scope)
            throw ClientStateException("认证刷新期间连接已改变；业务请求未派发，请校正后显式操作")
        }
        val receipt = response.obj("operation") ?: throw ClientStateException("操作结果未知；只查询回执，不会自动重发")
        applyReceipt(receipt, project, thread)
        if (receipt.string("status") == "rejected") throw ClientStateException("原生操作被拒绝（${receipt.string("errorCode") ?: "REJECTED"}）")
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
        throw last ?: ClientStateException("无法读取原生快照")
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

    private fun scheduleSync(delayMs: Long = 300) {
        if (!state.value.online) return
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

    private suspend fun loadCachedThreads(project: String) { cached("threads", project)?.let(::applyThreads) }

    private suspend fun loadLocalThread(thread: String) {
        val scope = scopeKey ?: return
        val project = state.value.selectedProjectId ?: return
        cached("projection", thread)?.let { projection.restoreCached(it) }
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
        mutableState.value = state.value.copy(messages = messages,
            readIndex = if (index >= 0) index else state.value.readIndex.coerceIn(0, messages.lastIndex.coerceAtLeast(0)),
            readOffset = if (index >= 0) anchor?.offset ?: 0 else 0,
            historyWarning = if (projection.limited) "PoC 最多展示 250 个 Item；部分历史或内容受限" else state.value.historyWarning)
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
        mutableState.value = state.value.copy(messages = projection.messages(),
            historyWarning = if (projection.limited) "PoC 最多展示 250 个 Item；部分历史或内容受限" else state.value.historyWarning)
        updateControls()
    }

    private fun resetThread() {
        syncJob?.cancel(); cacheJob?.cancel(); anchorJob?.cancel()
        snapshotCurrent = false; activeTurnId = null; threadStatus = "unknown"
        nextHistoryCursor = null; itemCursors.clear(); historyRevision = null; historyPages = 0
        replaceTerminalOnSnapshot = true; projection.clear(); invalidationVersion++
        mutableState.value = state.value.copy(selectedThreadId = null, messages = emptyList(), draft = "", readIndex = 0, readOffset = 0,
            executionLabel = "", historyWarning = null)
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
        val current = state.value
        val blocked = current.selectedProjectId?.let { project -> blocksWrite(pending.map { PendingIntent(it.projectId, it.threadId, it.kind, it.status) }, project, current.selectedThreadId) } ?: pending.isNotEmpty()
        val ready = current.online && position != null && !current.busy && current.selectedThreadId != null && durableStateAvailable
        mutableState.value = current.copy(
            canSend = ready && (snapshotCurrent || firstTurnAllowed()) && !blocked && activeTurnId == null && threadStatus in setOf("idle", "active") && current.draft.isNotBlank() && "turn.start" in capabilities,
            canStop = ready && activeTurnId != null && "turn.interrupt" in capabilities,
            canResume = ready && snapshotCurrent && !blocked && activeTurnId == null && threadStatus == "notLoaded" && "thread.resume" in capabilities,
            canLoadMore = current.online && !current.busy && historyPages < 20 && (nextHistoryCursor != null || itemCursors.isNotEmpty()),
            unknownWarning = if (blocked) UNKNOWN_MESSAGE else null,
            executionLabel = when {
                !current.online -> "离线 · 仅查看缓存与编辑草稿"
                activeTurnId != null -> "原生 Turn 正在执行"
                current.selectedThreadId == null -> "请选择或显式新建会话"
                threadStatus == "notLoaded" -> "原生会话未加载 · 点击恢复后才能发送"
                firstTurnAllowed() -> FIRST_TURN_MESSAGE
                !snapshotCurrent -> "正在校正原生状态"
                else -> "原生状态已校正"
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

    private fun action(block: suspend () -> Unit): Job = viewModelScope.launch {
        if (state.value.busy) return@launch
        actionMutex.withLock {
            mutableState.value = state.value.copy(busy = true, error = null)
            updateControls()
            try { block() } catch (error: Exception) { handleFailure(error) }
            finally { mutableState.value = state.value.copy(busy = false); updateControls() }
        }
    }

    private fun handleFailure(error: Exception) {
        if (error is CancellationException && error !is TimeoutCancellationException) throw error
        when (error) {
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
                if (error.authInvalid || error.code == "ACCESS_EXPIRED" || error.httpStatus == null) connectionFailed(error)
                else if (error.code.contains("CURSOR") || error.code.contains("STALE")) {
                    snapshotCurrent = false; invalidationVersion++; nextHistoryCursor = null; itemCursors.clear(); scheduleSync()
                }
            }
            is ClientStateException -> mutableState.value = state.value.copy(error = error.message)
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
                while (isActive && automaticReconnect && !state.value.online) {
                    delay(pause)
                    actionMutex.withLock {
                        try { connectInternal() } catch (failure: Exception) { handleFailure(failure) }
                    }
                    pause = (pause * 2).coerceAtMost(30_000)
                }
            }
        }
    }

    private fun disconnectTransport() {
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
        const val UNKNOWN_MESSAGE = "有操作交付结果未知。已保留原 operationId，仅查询回执；不会自动重发或改用新 ID。可刷新核对原生历史，或停止已确认的活动 Turn；没有回执也不代表未执行。"
        const val FIRST_TURN_MESSAGE = "新会话历史尚未生成，可发送首条消息"
    }
}
