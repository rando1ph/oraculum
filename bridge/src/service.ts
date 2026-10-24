import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { NativeRpcError, type Codex } from './codex';
import type { Approval, RpcId, Snapshot, WireMessage, BridgeEvent, LocalConfig, Thread, NativeSessionSettings, ThreadLifecycleState, ThreadLifecycleResult } from '../../packages/shared/protocol';
import type { ThreadStartParams } from '../../.local/codex-protocol/v2/ThreadStartParams';
import type { ThreadStartResponse } from '../../.local/codex-protocol/v2/ThreadStartResponse';
import type { TurnStartParams } from '../../.local/codex-protocol/v2/TurnStartParams';
import type { TurnStartResponse } from '../../.local/codex-protocol/v2/TurnStartResponse';
import type { ThreadReadResponse } from '../../.local/codex-protocol/v2/ThreadReadResponse';
import type { ModelListResponse } from '../../.local/codex-protocol/v2/ModelListResponse';
import type { ThreadListResponse } from '../../.local/codex-protocol/v2/ThreadListResponse';
import type { ThreadResumeResponse } from '../../.local/codex-protocol/v2/ThreadResumeResponse';
import type { ConfigReadResponse } from '../../.local/codex-protocol/v2/ConfigReadResponse';
import { readHistory } from './history';
import type { ReceiptStore } from './receipts';
import type { ProjectDirectories } from './projects';
import { basename, dirname } from 'node:path';
import { nativeResponse, responseNeedsDirectory, supportedRequest } from './native-requests';
import { permissionMode, threadPermissions, turnPermissions } from './permissions';

export class BridgeService extends EventEmitter {
  readonly threads = new Set<string>();
  readonly pending = new Map<RpcId, Approval>();
  private threadProjects = new Map<string, string>();
  private threadParents = new Map<string, string>();
  private busy = new Set<string>();
  private activeTurns = new Map<string, string>();
  private revisions = new Map<string, number>();
  private unknownSends = new Set<string>();
  private loaded = new Set<string>();
  private fresh = new Map<string, Thread>();
  private settings = new Map<string, NativeSessionSettings>();
  private settingsQueries = new Map<string, number>();
  private resuming = new Map<string, Promise<void>>();
  private archived = new Set<string>();
  private lifecycleRevision = 0;
  private nativeStatuses = new Map<string, Thread['status']['type']>();
  private deleted = new Set<string>();
  private lifecycle = new Set<string>();
  private inFlight = new Map<string, number>();
  private uncertainLifecycle = new Map<string, 'active' | 'archived' | 'deleted'>();
  constructor(readonly codex: Pick<Codex, 'request' | 'send'> & { on(event: string, listener: (...args: any[]) => void): unknown }, readonly cwd: string,
    private receipts?: ReceiptStore, private projects?: ProjectDirectories) {
    super();
    codex.on('message', (message: WireMessage) => this.receive(message));
    codex.on('unavailable', (message: string) => {
      this.pending.clear();
      this.emit('event', { type: 'unavailable', message } satisfies BridgeEvent);
    });
  }
  private receive(message: WireMessage) {
    const params = message.params ?? {};
    if (message.method === 'thread/started' && message.id === undefined) {
      const thread = params.thread as Thread | undefined;
      // A native child is only reachable through its already owned parent and
      // identical canonical project. A bare request can never add ownership.
      if (thread && typeof thread.id === 'string' && typeof thread.parentThreadId === 'string' &&
        this.threads.has(thread.parentThreadId) && thread.id !== thread.parentThreadId &&
        !this.descendsFrom(thread.parentThreadId, thread.id)) {
        const cwd = this.threadCwd(thread.parentThreadId);
        const knownParent = this.threadParents.get(thread.id);
        if (thread.cwd === cwd && (!this.threadProjects.has(thread.id) || this.threadCwd(thread.id) === cwd) &&
          (!knownParent || knownParent === thread.parentThreadId)) {
          this.track(thread.id, cwd);
          this.threadParents.set(thread.id, thread.parentThreadId);
        } else {
          this.emit('event', { type: 'notice', threadId: this.displayThread(thread.parentThreadId),
            message: '原生子会话与已授权父会话的项目归属不一致，其交互未获授权。' } satisfies BridgeEvent);
        }
      }
      return;
    }
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    if (message.method && message.id !== undefined) {
      if (threadId && this.threads.has(threadId) && supportedRequest(message)) {
        // Retransmission must not invalidate a token that another device holds.
        if (this.pending.has(message.id)) return;
        // Raw RPC ID is preserved, with a UI-only token to reject stale replies
        // after an App Server restart that reuses its numeric request IDs.
        const displayThreadIds = this.ancestorThreads(threadId);
        const request = { ...message, bridgeToken: randomUUID(),
          ...(displayThreadIds.length ? { displayThreadIds } : {}) } as Approval;
        this.pending.set(request.id, request);
        this.emit('event', { type: 'approval', request } satisfies BridgeEvent);
      } else {
        // Harness/client-owned execution, credential refresh, and unsupported
        // verification stay outside the renderer's native interaction adapter.
        this.codex.send({ id: message.id, error: { code: -32601, message: 'Interaction unsupported by Oraculum; no permission granted' } });
        const displayThreadIds = threadId && this.threads.has(threadId) ? this.ancestorThreads(threadId) : [];
        this.emit('event', { type: 'notice', threadId, ...(displayThreadIds.length ? { displayThreadIds } : {}),
          message: `暂不支持 ${message.method}；已安全拒绝，未授予权限。` } satisfies BridgeEvent);
      }
      return;
    }
    if (!threadId || !this.threads.has(threadId)) return;
    if (message.method === 'thread/status/changed') {
      const status = params.status as Thread['status'] | undefined;
      if (status?.type) this.nativeStatuses.set(threadId, status.type);
    }
    if (message.method === 'thread/archived' || message.method === 'thread/unarchived' || message.method === 'thread/deleted') {
      const state = message.method === 'thread/archived' ? 'archived' : message.method === 'thread/unarchived' ? 'active' : 'deleted';
      this.publishLifecycle(threadId, state);
    }
    this.revisions.set(threadId, (this.revisions.get(threadId) ?? 0) + 1);
    if (message.method === 'thread/settings/updated') {
      const settings = params.threadSettings as { cwd?: string; approvalPolicy: NativeSessionSettings['approvalPolicy'];
        sandboxPolicy: NativeSessionSettings['sandbox']; approvalsReviewer: NativeSessionSettings['approvalsReviewer'] } | undefined;
      if (settings?.cwd === this.threadCwd(threadId) && settings.approvalPolicy && settings.sandboxPolicy?.type && settings.approvalsReviewer) {
        this.publishSettings(threadId, { approvalPolicy: settings.approvalPolicy, sandbox: settings.sandboxPolicy,
          approvalsReviewer: settings.approvalsReviewer });
      } else {
        this.publishSettings(threadId);
        this.emit('event', { type: 'notice', threadId, message: '原生权限更新无法核实；请重新查询会话状态。' } satisfies BridgeEvent);
        return;
      }
    }
    if (message.method === 'serverRequest/resolved' && this.pending.get(params.requestId as RpcId)?.params.threadId === threadId) {
      this.resolveRequest(params.requestId as RpcId);
    }
    if (message.method === 'turn/started') {
      this.activeTurns.set(threadId, (params.turn as { id: string }).id);
      this.busy.add(threadId);
    }
    if (message.method === 'turn/completed') {
      const turnId = (params.turn as { id: string }).id;
      const cwd = this.threadCwd(threadId);
      this.receipts?.observe(cwd, threadId, params.turn as Parameters<ReceiptStore['observe']>[2]);
      if (this.activeTurns.get(threadId) === turnId) {
        this.busy.delete(threadId);
        if (!this.receipts?.blocked(cwd, threadId)) this.unknownSends.delete(threadId);
        this.activeTurns.delete(threadId);
      }
      for (const [id, request] of this.pending) {
        if (request.params.threadId === threadId && request.params.turnId === turnId) this.resolveRequest(id);
      }
    }
    // Native notifications are the facts; no agent loop or tool execution here.
    this.emit('event', { type: 'event', event: message } as BridgeEvent);
  }
  async dispatch(method: string, params: Record<string, unknown>, context?: { deviceId: string }): Promise<unknown> {
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    const mutation = ['thread/archive', 'thread/unarchive', 'thread/delete'].includes(method);
    const guarded = mutation || ['bridge/subscribe', 'bridge/history', 'turn/start'].includes(method);
    if (!threadId || !guarded) return this.dispatchRequest(method, params, context);
    // Reserve before the first asynchronous directory/read check. Other devices
    // cannot sneak in a send or native resume while a lifecycle check is running.
    if ([...this.lifecycle].some(id => this.related(id, threadId)) ||
      (mutation && [...this.inFlight].some(([id, count]) => count > 0 && this.related(id, threadId)))) {
      throw new Error('会话操作正在进行，请等待完成后查询状态。');
    }
    if (this.deleted.has(threadId)) throw new Error('会话已删除，请刷新会话列表。');
    if (this.uncertainLifecycle.has(threadId)) throw new Error('会话操作结果未知，请刷新普通及已归档列表核实；不要重复操作。');
    if (!mutation && this.archived.has(threadId)) throw new Error('会话已归档，请先恢复归档。');
    if (mutation) this.lifecycle.add(threadId); else this.beginFlight(threadId);
    try { return await this.dispatchRequest(method, params, context); }
    finally { if (mutation) this.lifecycle.delete(threadId); else this.endFlight(threadId); }
  }
  private async dispatchRequest(method: string, params: Record<string, unknown>, context?: { deviceId: string }): Promise<unknown> {
    if (method === 'bridge/projects') {
      return this.projects?.list() ?? { root: dirname(this.cwd), projects: [{ cwd: this.cwd, name: basename(this.cwd) }] };
    }
    if (['bridge/browse', 'bridge/registerProject', 'bridge/unregisterProject'].includes(method)) {
      if (!this.projects) throw new Error('Host directory browsing is unavailable');
      if (method === 'bridge/browse') return this.projects.browse(params.path, params.cursor);
      const result = method === 'bridge/registerProject'
        ? await this.projects.register(params.path) : await this.projects.unregister(params.cwd);
      this.emit('event', { type: 'projectsChanged' } satisfies BridgeEvent);
      return result;
    }
    if (method === 'bridge/config') {
      const cwd = await this.projectCwd(params.cwd);
      const { config } = await this.codex.request<ConfigReadResponse>('config/read', { cwd, includeLayers: false });
      // Only safe effective settings cross into the renderer, never raw config.
      return { cwd, model: config.model, effort: config.model_reasoning_effort,
        provider: config.model_provider, approvalPolicy: config.approval_policy ?? null,
        sandbox: config.sandbox_mode ?? null, approvalsReviewer: config.approvals_reviewer ?? null,
        webSearch: config.web_search ?? null } satisfies LocalConfig;
    }
    if (method === 'model/list') {
      return this.codex.request<ModelListResponse>('model/list', { limit: 100, includeHidden: false, cursor: typeof params.cursor === 'string' ? params.cursor : undefined });
    }
    if (method === 'thread/list' || method === 'bridge/threads') {
      const cwd = await this.projectCwd(params.cwd);
      if (params.archived !== undefined && typeof params.archived !== 'boolean') throw new Error('Expected archived boolean');
      const archived = params.archived === true;
      const revision = this.lifecycleRevision;
      const page = await this.codex.request<ThreadListResponse>('thread/list', {
        cwd, archived, limit: 30, sortKey: 'updated_at', modelProviders: [],
        cursor: typeof params.cursor === 'string' ? params.cursor : undefined,
      });
      if (revision !== this.lifecycleRevision) throw new Error('会话状态已变化，请刷新列表。');
      page.data = page.data.filter(thread => thread.cwd === cwd && !this.deleted.has(thread.id));
      for (const thread of page.data) {
        this.track(thread.id, cwd);
        if (archived) this.archived.add(thread.id); else this.archived.delete(thread.id);
        const expected = this.uncertainLifecycle.get(thread.id);
        if (expected === (archived ? 'archived' : 'active')) this.publishLifecycle(thread.id, expected);
      }
      if (!params.cursor && !archived) {
        page.data = [...this.fresh.values()].filter(t => this.threadCwd(t.id) === cwd && !this.archived.has(t.id) && !this.deleted.has(t.id) && !this.uncertainLifecycle.has(t.id) && !page.data.some(p => p.id === t.id)).concat(page.data);
      }
      return method === 'bridge/threads' ? page.data.map(t => t.id) : page;
    }
    if (method === 'thread/start') {
      const cwd = await this.projectCwd(params.cwd);
      const request: ThreadStartParams = {
        cwd,
        ...threadPermissions(permissionMode(params.permissionMode)),
        ...(typeof params.model === 'string' && params.model ? { model: params.model } : {}),
      };
      const response = await this.codex.request<ThreadStartResponse>('thread/start', request);
      if (response.thread.cwd !== cwd) throw new Error('Native thread started outside the selected project');
      this.track(response.thread.id, cwd);
      this.loaded.add(response.thread.id);
      this.fresh.set(response.thread.id, response.thread);
      this.rememberSettings(response);
      return response;
    }
    const threadId = params.threadId;
    if (typeof threadId !== 'string' || !this.threads.has(threadId)) throw new Error('Thread is outside this workspace; refresh the native thread list');
    // A turn/approval/history request cannot reassign an existing thread by
    // supplying a different cwd. Its project came from the validated native list.
    const cwd = this.threadCwd(threadId);
    if (['thread/archive', 'thread/unarchive', 'thread/delete'].includes(method)) {
      return this.changeLifecycle(method, threadId, cwd, params);
    }
    const pendingResponse = method === 'bridge/approve' ? this.pending.get(params.requestId as RpcId) : undefined;
    const needsDirectory = ['bridge/subscribe', 'bridge/history', 'turn/start'].includes(method) ||
      (pendingResponse?.params.threadId === threadId && responseNeedsDirectory(pendingResponse, params));
    // Even if a directory disappears, Stop and Decline remain available.
    if (needsDirectory && this.projects && await this.projects.resolve(cwd) !== cwd) throw new Error('Project directory changed; refresh the native thread list');
    if (method === 'bridge/subscribe' || method === 'bridge/history') {
      const wasLoaded = this.loaded.has(threadId);
      await this.resume(threadId);
      // Stable native notifications need not include permission changes. Rejoin
      // a loaded thread without overrides to read its actual current settings.
      // A newly created, empty thread has no rollout yet, so use start's reply.
      if (wasLoaded && !this.fresh.has(threadId) && !params.cursor) await this.readSettings(threadId);
      const revision = this.revisions.get(threadId) ?? 0;
      const fresh = this.fresh.get(threadId);
      const thread = fresh ?? (await this.codex.request<ThreadReadResponse>('thread/read', { threadId })).thread;
      if (thread.cwd !== cwd) throw new Error('Thread is outside this workspace');
      const result = fresh ? { thread } : await readHistory(this.codex, thread, typeof params.cursor === 'string' ? params.cursor : undefined);
      for (const turn of result.thread.turns) this.receipts?.observe(cwd, threadId, turn);
      const active = result.thread.turns.find(t => t.status === 'inProgress');
      // Older history pages must not change current execution controls.
      if (!params.cursor && revision === (this.revisions.get(threadId) ?? 0)) {
        if (active) { this.busy.add(threadId); this.activeTurns.set(threadId, active.id); }
        else if (thread.status.type !== 'active' && !this.unknownSends.has(threadId)) {
          this.busy.delete(threadId); this.activeTurns.delete(threadId);
        }
      }
      return { ...result, pending: [...this.pending.values()].filter(r => r.params.threadId === threadId || this.descendsFrom(r.params.threadId, threadId)),
        settings: this.settings.get(threadId),
        sendBlocked: this.unknownSends.has(threadId) || !!this.receipts?.blocked(cwd, threadId),
        receipts: this.receipts?.list(cwd, threadId),
      } satisfies Snapshot;
    }
    if (method === 'turn/start') {
      if (this.busy.has(threadId) || this.receipts?.blocked(cwd, threadId)) throw new Error('Turn in progress or send result unknown; query state before continuing');
      if (!this.loaded.has(threadId)) throw new Error('Select and resume the thread before starting a turn');
      if (typeof params.text !== 'string' || !params.text.trim() || params.text.length > 16000) throw new Error('Expected 1–16000 characters');
      const request: TurnStartParams = {
        threadId, input: [{ type: 'text', text: params.text, text_elements: [] }],
        ...turnPermissions(permissionMode(params.permissionMode)),
        ...(typeof params.model === 'string' && params.model ? { model: params.model } : {}),
        ...(typeof params.effort === 'string' && params.effort ? { effort: params.effort } : {}),
      };
      if (this.receipts) {
        if (!context?.deviceId) throw new Error('Authenticated device context required');
        this.receipts.reserve(params.operationId, cwd, threadId, context.deviceId);
      }
      this.busy.add(threadId);
      this.unknownSends.add(threadId);
      if (params.permissionMode !== undefined && params.permissionMode !== 'inherit') this.publishSettings(threadId);
      const fresh = this.fresh.get(threadId);
      this.fresh.delete(threadId);
      // Deliberately keep unknown sends blocked. A timeout is not a safe retry.
      try {
        const result = await this.codex.request<TurnStartResponse>('turn/start', request);
        this.receipts?.accepted(params.operationId as string, result.turn.id);
        this.receipts?.observe(cwd, threadId, result.turn);
        this.unknownSends.delete(threadId);
        if (this.busy.has(threadId) && result.turn.status === 'inProgress') this.activeTurns.set(threadId, result.turn.id);
        // A confirmed turn ACK remains accepted even if the settings read fails.
        // Never derive effective permissions from the requested preset alone.
        void this.readSettings(threadId);
        return result;
      } catch (error) {
        if (error instanceof NativeRpcError) {
          this.receipts?.rejected(params.operationId as string);
          this.busy.delete(threadId);
          this.unknownSends.delete(threadId);
          if (fresh) this.fresh.set(threadId, fresh);
        }
        throw error;
      }
    }
    if (method === 'turn/interrupt') {
      if (typeof params.turnId !== 'string' || this.activeTurns.get(threadId) !== params.turnId) throw new Error('Turn is not the observed active turn; query state');
      return this.codex.request('turn/interrupt', { threadId, turnId: params.turnId });
    }
    if (method === 'bridge/approve') {
      const request = this.pending.get(params.requestId as RpcId);
      if (!request || request.params.threadId !== threadId) throw new Error('Approval no longer pending');
      if (params.bridgeToken !== request.bridgeToken) throw new Error('Approval expired or belongs to another Bridge session');
      const result = nativeResponse(request, params);
      // Remove synchronously before writing; never apply a reply twice.
      this.pending.delete(request.id);
      this.codex.send({ id: request.id, result });
      this.emit('event', { type: 'requestAnswered', requestId: request.id, bridgeToken: request.bridgeToken } satisfies BridgeEvent);
      return { submitted: true };
    }
    throw new Error('Method not exposed by Oraculum');
  }
  private related(first: string, second: string) {
    return first === second || this.descendsFrom(first, second) || this.descendsFrom(second, first);
  }
  private beginFlight(threadId: string) { this.inFlight.set(threadId, (this.inFlight.get(threadId) ?? 0) + 1); }
  private endFlight(threadId: string) {
    const count = (this.inFlight.get(threadId) ?? 1) - 1;
    if (count) this.inFlight.set(threadId, count); else this.inFlight.delete(threadId);
  }
  private assertLifecycleIdle(threadId: string, cwd: string) {
    if (['active', 'systemError'].includes(this.nativeStatuses.get(threadId) ?? '') || this.busy.has(threadId) || this.activeTurns.has(threadId) || this.unknownSends.has(threadId) || this.receipts?.blocked(cwd, threadId)) {
      throw new Error('会话运行中或发送结果未知，请先停止并查询状态。');
    }
    if ([...this.pending.values()].some(request => this.related(request.params.threadId, threadId))) {
      throw new Error('会话仍有待处理审批或输入，请先处理并查询状态。');
    }
    if (this.threadParents.has(threadId) || [...this.threadParents.values()].includes(threadId)) {
      throw new Error('会话存在子会话依赖，暂不支持安全归档或删除。');
    }
  }
  private nativeParent(thread: Thread): string | null {
    if (typeof thread.parentThreadId === 'string' && thread.parentThreadId) return thread.parentThreadId;
    const source = thread.source;
    if (source && typeof source === 'object' && 'subAgent' in source) {
      const subAgent = source.subAgent;
      if (subAgent && typeof subAgent === 'object' && 'thread_spawn' in subAgent) {
        if (typeof subAgent.thread_spawn.parent_thread_id === 'string' && subAgent.thread_spawn.parent_thread_id) return subAgent.thread_spawn.parent_thread_id;
        throw new Error('原生子会话归属不明确，无法安全执行会话操作。');
      }
    }
    // Explicit null also covers native review/compact subagents without a
    // spawned parent. Their source classification alone is not a dependency.
    if (thread.parentThreadId !== null) throw new Error('原生会话父子关系无法核实，暂不支持会话操作。');
    return null;
  }
  private async readLifecycleThread(threadId: string, cwd: string) {
    const { thread } = await this.codex.request<ThreadReadResponse>('thread/read', { threadId });
    if (thread.id !== threadId || thread.cwd !== cwd) throw new Error('Thread is outside this workspace');
    if (this.nativeParent(thread)) throw new Error('子会话须由原生父会话管理，暂不支持单独操作。');
    if (thread.ephemeral) throw new Error('临时会话尚未持久化，不能归档或删除。');
    if (!['idle', 'notLoaded'].includes(thread.status.type) || thread.turns.some(turn => turn.status === 'inProgress')) {
      throw new Error('原生会话运行中或状态异常，请先停止并查询状态。');
    }
    return thread;
  }
  private async lifecycleInventory(threadId: string, cwd: string) {
    let state: 'active' | 'archived' | undefined;
    // Native archive/delete cascade spawned children. Include noninteractive and
    // archived sources, and other projects, because a hidden child can have a
    // different cwd. This metadata stays inside the Bridge; it grants no access.
    const sourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
      'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
    for (const archived of [false, true]) {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (let pageNumber = 0; ; pageNumber++) {
        if (pageNumber >= 100) throw new Error('会话关系过多，无法完整核实；未执行会话操作。');
        const page = await this.codex.request<ThreadListResponse>('thread/list', {
          archived, sourceKinds, modelProviders: [], limit: 100, ...(cursor ? { cursor } : {}),
        });
        for (const thread of page.data) {
          const parent = this.nativeParent(thread);
          if (parent === threadId) throw new Error('会话存在子会话依赖，暂不支持安全归档或删除。');
          if (thread.id === threadId) {
            if (thread.cwd !== cwd) throw new Error('Thread is outside this workspace');
            if (parent) throw new Error('子会话须由原生父会话管理，暂不支持单独操作。');
            if (state) throw new Error('原生会话归档状态发生变化，请刷新后重试。');
            state = archived ? 'archived' : 'active';
          }
        }
        if (!page.nextCursor) break;
        if (cursors.has(page.nextCursor)) throw new Error('原生会话分页无法完整核实，未执行会话操作。');
        cursor = page.nextCursor; cursors.add(cursor);
      }
    }
    return state;
  }
  private async changeLifecycle(method: string, threadId: string, cwd: string, params: Record<string, unknown>): Promise<ThreadLifecycleResult> {
    if (params.cwd !== undefined && params.cwd !== cwd) throw new Error('Thread is outside the selected project');
    if (method === 'thread/delete' && params.confirm !== true) throw new Error('永久删除必须经过明确的二次确认。');
    if (this.projects && await this.projects.resolve(cwd) !== cwd) throw new Error('Project directory changed; refresh the native thread list');
    this.assertLifecycleIdle(threadId, cwd);
    await this.readLifecycleThread(threadId, cwd);
    const current = await this.lifecycleInventory(threadId, cwd);
    if (method === 'thread/unarchive' && current !== 'archived') throw new Error('会话不在已归档列表，请刷新状态。');
    if (method === 'thread/archive' && current === 'archived') throw new Error('会话已经归档，请刷新状态。');
    // The native active list omits empty threads even after unarchive. Avoid an
    // archive/restore flow that would make a new empty thread disappear.
    if (!current && !(method === 'thread/delete' && this.fresh.has(threadId))) throw new Error(this.fresh.has(threadId)
      ? '空会话尚未进入原生历史，请先发送消息后再操作。'
      : '原生列表中未找到会话，请刷新后重试。');
    // The inventory may span multiple pages; reread native status immediately
    // before mutating, then include notifications received during that read.
    await this.readLifecycleThread(threadId, cwd);
    if (this.projects && await this.projects.resolve(cwd) !== cwd) throw new Error('Project directory changed; refresh the native thread list');
    this.assertLifecycleIdle(threadId, cwd);
    const state = method === 'thread/archive' ? 'archived' : method === 'thread/unarchive' ? 'active' : 'deleted';
    try {
      const result = await this.codex.request<{ thread?: Thread }>(method, { threadId });
      if (method === 'thread/unarchive' && (result.thread?.id !== threadId || result.thread.cwd !== cwd)) {
        throw new Error('Native restored thread belongs to another thread or project');
      }
      this.publishLifecycle(threadId, state);
      return { threadId, state };
    } catch (error) {
      if (error instanceof NativeRpcError) {
        if (error.code === -32601) throw new Error('当前 Codex App Server 不支持此会话操作；未使用文件清理替代。');
        // A native rejection is not a successful lifecycle operation.
        if (error.code !== -32603) throw error;
      }
      this.uncertainLifecycle.set(threadId, state);
      this.publishLifecycle(threadId, 'unknown');
      throw new Error('原生会话操作结果未知，请刷新普通及已归档列表核实；不要重复操作。');
    }
  }
  private publishLifecycle(threadId: string, state: ThreadLifecycleState) {
    this.lifecycleRevision++;
    this.loaded.delete(threadId); this.fresh.delete(threadId); this.settings.delete(threadId);
    this.settingsQueries.set(threadId, (this.settingsQueries.get(threadId) ?? 0) + 1);
    if (state === 'archived') this.archived.add(threadId);
    if (state === 'active') this.archived.delete(threadId);
    if (state === 'deleted') { this.deleted.add(threadId); this.archived.delete(threadId); }
    if (state !== 'unknown') this.uncertainLifecycle.delete(threadId);
    this.emit('event', { type: 'threadLifecycleChanged', threadId, cwd: this.threadCwd(threadId), state } satisfies BridgeEvent);
  }
  private projectCwd(value: unknown) {
    return this.projects ? this.projects.resolve(value) : Promise.resolve(this.cwd);
  }
  private threadCwd(threadId: string) {
    return this.threadProjects.get(threadId) ?? this.cwd;
  }
  private displayThread(threadId: string): string {
    return this.ancestorThreads(threadId).at(-1) ?? threadId;
  }
  private ancestorThreads(threadId: string): string[] {
    const ancestors: string[] = [];
    for (let parent = this.threadParents.get(threadId); parent; parent = this.threadParents.get(parent)) ancestors.push(parent);
    return ancestors;
  }
  private descendsFrom(threadId: string, ancestor: string): boolean {
    return this.ancestorThreads(threadId).includes(ancestor);
  }
  private resolveRequest(id: RpcId) {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    this.emit('event', { type: 'requestAnswered', requestId: id, bridgeToken: request.bridgeToken } satisfies BridgeEvent);
  }
  private track(threadId: string, cwd: string) {
    const known = this.threadProjects.get(threadId);
    if (known && known !== cwd) throw new Error('Native thread changed project unexpectedly');
    this.threads.add(threadId);
    this.threadProjects.set(threadId, cwd);
  }
  private rememberSettings(response: ThreadStartResponse | ThreadResumeResponse) {
    const { approvalPolicy, sandbox, approvalsReviewer } = response;
    this.publishSettings(response.thread.id, { approvalPolicy, sandbox, approvalsReviewer });
  }
  private publishSettings(threadId: string, settings?: NativeSessionSettings) {
    this.settingsQueries.set(threadId, (this.settingsQueries.get(threadId) ?? 0) + 1);
    if (settings) this.settings.set(threadId, settings); else this.settings.delete(threadId);
    this.emit('event', { type: 'settingsChanged', threadId, settings } satisfies BridgeEvent);
  }
  private async readSettings(threadId: string) {
    const ticket = (this.settingsQueries.get(threadId) ?? 0) + 1;
    this.settingsQueries.set(threadId, ticket);
    try {
      const response = await this.nativeResume(threadId);
      if (response.thread.id !== threadId || response.thread.cwd !== this.threadCwd(threadId)) throw new Error('Native thread settings belong to another thread or project');
      if (ticket === this.settingsQueries.get(threadId)) this.rememberSettings(response);
    } catch {
      if (ticket !== this.settingsQueries.get(threadId)) return;
      this.publishSettings(threadId);
      // Permission readback is ancillary: don't lose history, pending approvals,
      // or accepted receipts when it fails, and never retry a turn automatically.
      this.emit('event', { type: 'notice', threadId,
        message: '实际权限尚未确认，请查询状态；发送回执以原生结果为准，不要重复发送。' } satisfies BridgeEvent);
    }
  }
  private async nativeResume(threadId: string, cwd?: string) {
    if (this.lifecycle.has(threadId) || this.archived.has(threadId) || this.deleted.has(threadId) || this.uncertainLifecycle.has(threadId)) throw new Error('Thread lifecycle changed; refresh state');
    this.beginFlight(threadId);
    try { return await this.requestNativeResume(threadId, cwd); } finally { this.endFlight(threadId); }
  }
  private async requestNativeResume(threadId: string, cwd?: string) {
    const params = { threadId, ...(cwd ? { cwd } : {}) };
    try { return await this.codex.request<ThreadResumeResponse>('thread/resume', { ...params, excludeTurns: true }); }
    catch (error) {
      // Legacy JSONL threads can reject the metadata-only resume because their
      // store has no list_turns API. Retry only this known read capability error.
      if (!(error instanceof NativeRpcError) || error.code !== -32601 || !/list_turns.*not supported/i.test(error.message)) throw error;
      return this.codex.request<ThreadResumeResponse>('thread/resume', params);
    }
  }
  private async resume(threadId: string) {
    if (this.loaded.has(threadId)) return;
    const existing = this.resuming.get(threadId);
    if (existing) return existing;
    const resume = (async () => {
      const cwd = this.threadCwd(threadId);
      const { thread } = await this.codex.request<ThreadReadResponse>('thread/read', { threadId });
      if (thread.cwd !== cwd) throw new Error('Thread is outside this workspace');
      try {
        if (this.projects) await this.projects.resolve(cwd);
        const resumed = await this.nativeResume(threadId, cwd);
        if (resumed.thread.id !== threadId || resumed.thread.cwd !== cwd) throw new Error('Native thread resumed outside the selected thread or project');
        this.rememberSettings(resumed);
        this.loaded.add(threadId);
      } catch (error) { this.loaded.delete(threadId); throw error; }
    })();
    this.resuming.set(threadId, resume);
    try { await resume; } finally { this.resuming.delete(threadId); }
  }
}
