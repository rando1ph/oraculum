import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { NativeRpcError, type Codex } from './codex';
import type { Approval, RpcId, Snapshot, WireMessage, BridgeEvent, LocalConfig, Thread, NativeSessionSettings, ThreadLifecycleState, ThreadLifecycleResult, PermissionMode, NativeOperation, NativeOperationMethod, NativeCapabilities } from '../../packages/shared/protocol';
import type { ThreadStartParams } from '../../.local/codex-protocol/v2/ThreadStartParams';
import type { ThreadStartResponse } from '../../.local/codex-protocol/v2/ThreadStartResponse';
import type { TurnStartParams } from '../../.local/codex-protocol/v2/TurnStartParams';
import type { TurnStartResponse } from '../../.local/codex-protocol/v2/TurnStartResponse';
import type { ThreadReadResponse } from '../../.local/codex-protocol/v2/ThreadReadResponse';
import type { ModelListResponse } from '../../.local/codex-protocol/v2/ModelListResponse';
import type { ThreadListResponse } from '../../.local/codex-protocol/v2/ThreadListResponse';
import type { ThreadResumeResponse } from '../../.local/codex-protocol/v2/ThreadResumeResponse';
import type { ConfigReadResponse } from '../../.local/codex-protocol/v2/ConfigReadResponse';
import type { ThreadForkResponse } from '../../.local/codex-protocol/v2/ThreadForkResponse';
import type { ThreadRevertResponse } from '../../.local/codex-protocol/v2/ThreadRevertResponse';
import type { TurnSteerResponse } from '../../.local/codex-protocol/v2/TurnSteerResponse';
import type { ReviewStartResponse } from '../../.local/codex-protocol/v2/ReviewStartResponse';
import type { ReviewTarget } from '../../.local/codex-protocol/v2/ReviewTarget';
import type { ThreadTurnsListResponse } from '../../.local/codex-protocol/v2/ThreadTurnsListResponse';
import { readHistory } from './history';
import type { ReceiptStore } from './receipts';
import type { ProjectDirectories } from './projects';
import { basename, dirname } from 'node:path';
import { nativeResponse, responseNeedsDirectory, supportedRequest } from './native-requests';
import { permissionMode, threadPermissions, turnPermissions } from './permissions';
import type { ThreadPermissionStore } from './thread-permissions';
import { NativeUsage } from './usage';
import { NativeOperations } from './native-operations';
import { readExtensions } from './extensions';
import { AttachmentStore, type AttachmentOwner } from './attachments';
import { attachmentId } from '../../packages/shared/attachments';
import { ArtifactStore, type ArtifactOwner } from './artifacts';
import type { Readable } from 'node:stream';

type RequestContext = { deviceId: string; isAuthorized?: () => boolean };
const nativeMethods = new Set<NativeOperationMethod>(['thread/name/set', 'thread/fork', 'thread/revert', 'turn/steer', 'review/start', 'thread/compact/start']);

const forwardedNotifications = new Set(['thread/status/changed', 'thread/settings/updated', 'thread/archived', 'thread/unarchived', 'thread/deleted',
  'thread/name/updated', 'thread/reverted', 'thread/compacted',
  'turn/started', 'turn/completed', 'turn/diff/updated', 'turn/plan/updated', 'item/started', 'item/completed', 'item/agentMessage/delta',
  'item/commandExecution/outputDelta', 'item/fileChange/patchUpdated', 'item/mcpToolCall/progress', 'item/plan/delta',
  'item/reasoning/summaryPartAdded', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'serverRequest/resolved', 'error']);

export class BridgeService extends EventEmitter {
  private usage: NativeUsage;
  readonly threads = new Set<string>();
  readonly pending = new Map<RpcId, Approval>();
  private threadProjects = new Map<string, string>();
  private threadParents = new Map<string, string>();
  private busy = new Set<string>();
  private startingTurns = new Set<string>();
  private activeTurns = new Map<string, string>();
  private revisions = new Map<string, number>();
  private unknownSends = new Set<string>();
  private loaded = new Set<string>();
  private fresh = new Map<string, Thread>();
  private settings = new Map<string, NativeSessionSettings>();
  private settingsQueries = new Map<string, number>();
  private acceptedPermissionChoices = new Map<string, PermissionMode>();
  private resuming = new Map<string, Promise<void>>();
  private archived = new Set<string>();
  private lifecycleRevision = 0;
  private nativeStatuses = new Map<string, Thread['status']['type']>();
  private deleted = new Set<string>();
  private lifecycle = new Set<string>();
  private inFlight = new Map<string, number>();
  private uncertainLifecycle = new Map<string, 'active' | 'archived' | 'deleted'>();
  private nativeOperations: NativeOperations;
  private unsupportedNative = new Set<NativeOperationMethod>();
  private historyRevisions = new Map<string, number>();
  private terminalTurns = new Map<string, Set<string>>();
  private terminalTurnStatuses = new Map<string, Map<string, string>>();
  private liveNativeOperations = new Map<string, NativeOperation>();
  private nameRevisions = new Map<string, number>();
  constructor(readonly codex: Pick<Codex, 'request' | 'send'> & { on(event: string, listener: (...args: any[]) => void): unknown }, readonly cwd: string,
    private receipts?: ReceiptStore, private projects?: ProjectDirectories, private permissionChoices?: ThreadPermissionStore, readonly attachments?: AttachmentStore, readonly artifacts?: ArtifactStore) {
    super();
    this.nativeOperations = receipts?.nativeOperations ?? new NativeOperations();
    this.usage = new NativeUsage((method, params) => codex.request(method, params), snapshot => this.emit('event', { type: 'accountLimits', snapshot } satisfies BridgeEvent));
    codex.on('message', (message: WireMessage) => this.receive(message));
    codex.on('unavailable', (message: string) => {
      this.usage.invalidate(true);
      this.pending.clear();
      // Only operations dispatched by this live Bridge need transitioning.
      // Persisted operations were made unknown when the ledger was opened.
      for (const operation of this.liveNativeOperations.values()) if (['running', 'accepted'].includes(operation.state)) {
        this.publishOperation(operation, { state: 'unknown', message: '连接中断，原生操作结果未知；请查询状态，不要重复执行。' });
      }
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
        if (typeof params.turnId === 'string' && this.terminalTurns.get(threadId)?.has(params.turnId)) {
          this.codex.send({ id: message.id, error: { code: -32600, message: 'Turn already terminal or removed; no permission granted' } });
          return;
        }
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
    if (message.method === 'account/updated') { this.usage.invalidate(); return; }
    if (message.method === 'account/rateLimits/updated') { this.usage.update(params); return; }
    if (!threadId || !this.threads.has(threadId) || this.deleted.has(threadId)) return;
    if (message.method === 'thread/tokenUsage/updated') {
      const active = this.activeTurns.get(threadId);
      if (active && params.turnId !== active) return;
      const snapshot = this.usage.thread(threadId, this.threadCwd(threadId), params.turnId, params.tokenUsage);
      if (snapshot) this.emit('event', { type: 'threadUsage', snapshot } satisfies BridgeEvent);
      return;
    }
    if (!message.method || !forwardedNotifications.has(message.method)) return;
    if (message.method === 'thread/name/updated') {
      if (params.threadName === undefined || typeof params.threadName === 'string') {
        this.lifecycleRevision++;
        this.nameRevisions.set(threadId, (this.nameRevisions.get(threadId) ?? 0) + 1);
        const fresh = this.fresh.get(threadId);
        if (fresh) this.fresh.set(threadId, { ...fresh, name: typeof params.threadName === 'string' ? params.threadName : null });
        this.completeOperations(threadId, 'thread/name/set');
      }
    }
    if (message.method === 'thread/reverted') {
      this.completeOperations(threadId, 'thread/revert');
      this.invalidateHistory(threadId, 'revert');
    }
    if (message.method === 'thread/compacted' ||
      (message.method === 'item/completed' && (params.item as { type?: string } | undefined)?.type === 'contextCompaction')) {
      this.invalidateHistory(threadId, 'compact');
    }
    if (['item/started', 'item/completed'].includes(message.method) && (params.item as { type?: string } | undefined)?.type === 'contextCompaction' && typeof params.turnId === 'string') {
      for (const operation of this.liveNativeOperations.values()) {
        // The generic next turn may belong to another Codex client. A native
        // compaction item is the identifying fact, and cannot settle a prior
        // uncorrelated timeout or an operation from a previous Bridge process.
        if (operation.threadId === threadId && operation.method === 'thread/compact/start' &&
          ['running', 'accepted'].includes(operation.state) && !operation.turnId) this.publishOperation(operation, { turnId: params.turnId });
      }
    }
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
        sandboxPolicy: NativeSessionSettings['sandbox']; approvalsReviewer: NativeSessionSettings['approvalsReviewer'];
        model?: string; effort?: string | null } | undefined;
      if (settings?.cwd === this.threadCwd(threadId) && settings.approvalPolicy && settings.sandboxPolicy?.type && settings.approvalsReviewer) {
        this.publishSettings(threadId, { ...this.settings.get(threadId),
          approvalPolicy: settings.approvalPolicy, sandbox: settings.sandboxPolicy,
          approvalsReviewer: settings.approvalsReviewer,
          ...(typeof settings.model === 'string' && settings.model ? { model: settings.model } : {}),
          ...(settings.effort === null || typeof settings.effort === 'string' ? { effort: settings.effort } : {}) });
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
      if (this.terminalTurns.get(threadId)?.has((params.turn as { id: string }).id)) return;
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
      this.observeNativeTurn(threadId, params.turn as { id: string; status: string });
    }
    // Native notifications are the facts; no agent loop or tool execution here.
    this.emit('event', { type: 'event', event: message } as BridgeEvent);
  }
  async dispatch(method: string, params: Record<string, unknown>, context?: RequestContext): Promise<unknown> {
    this.assertAuthorized(context);
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    const mutation = ['thread/archive', 'thread/unarchive', 'thread/delete'].includes(method) || nativeMethods.has(method as NativeOperationMethod);
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
    if (method === 'turn/start' && this.startingTurns.has(threadId)) throw new Error('发送正在进行，请查询状态。');
    if (method === 'turn/start') this.startingTurns.add(threadId);
    if (mutation) this.lifecycle.add(threadId); else this.beginFlight(threadId);
    try { return await this.dispatchRequest(method, params, context); }
    finally { if (method === 'turn/start') this.startingTurns.delete(threadId); if (mutation) this.lifecycle.delete(threadId); else this.endFlight(threadId); }
  }
  private attachmentOwner(params: Record<string, unknown>, context?: RequestContext): AttachmentOwner {
    if (!this.attachments || !this.projects || !this.receipts || !context?.deviceId || !attachmentId(params.draftId) || typeof params.threadId !== 'string' || typeof params.cwd !== 'string') throw new Error('附件上传不可用，或草稿归属无效。');
    const { cwd, threadId, draftId } = params;
    const validate = async () => {
      this.assertAuthorized(context);
      if (!this.threads.has(threadId) || this.threadCwd(threadId) !== cwd || !this.loaded.has(threadId) ||
        this.deleted.has(threadId) || this.archived.has(threadId) || this.uncertainLifecycle.has(threadId) || this.lifecycle.has(threadId)) throw new Error('附件不属于已选择的有效项目和会话。');
      await this.projects!.resolve(cwd);
      this.assertAuthorized(context);
    };
    return { cwd, threadId, draftId, deviceId: context.deviceId, authorized: context.isAuthorized ?? (() => true), validate };
  }
  async uploadAttachment(params: Record<string, unknown>, input: Readable, context?: RequestContext) {
    const owner = this.attachmentOwner(params, context);
    return this.attachments!.upload(params, input, owner);
  }
  async removeAttachment(params: Record<string, unknown>, context?: RequestContext) {
    const owner = this.attachmentOwner(params, context);
    return this.attachments!.remove(params.id, owner);
  }
  private artifactOwner(params: Record<string, unknown>, context?: RequestContext): ArtifactOwner {
    if (!this.artifacts || !this.projects || !context?.deviceId || typeof params.cwd !== 'string' || typeof params.threadId !== 'string') throw new Error('请先选择已授权项目和会话。');
    const { cwd, threadId } = params;
    const validate = async () => {
      this.assertAuthorized(context);
      if (!this.threads.has(threadId) || this.threadCwd(threadId) !== cwd || !this.loaded.has(threadId) ||
        this.deleted.has(threadId) || this.archived.has(threadId) || this.uncertainLifecycle.has(threadId) || this.lifecycle.has(threadId)) throw new Error('文件不属于有效的当前项目和会话。');
      await this.projects!.resolve(cwd); this.assertAuthorized(context);
    };
    return { cwd, threadId, deviceId: context.deviceId, authorized: context.isAuthorized ?? (() => true), validate };
  }
  async listArtifacts(params: Record<string, unknown>, context?: RequestContext) {
    return this.artifacts!.list(this.artifactOwner(params, context), params.path, params.cursor);
  }
  async selectArtifact(params: Record<string, unknown>, context?: RequestContext) {
    return this.artifacts!.select(this.artifactOwner(params, context), params.path);
  }
  async downloadArtifact(id: string, signal: AbortSignal, context?: RequestContext) {
    if (!this.artifacts || !context?.deviceId) throw new Error('成果下载不可用。');
    const scope = this.artifacts.scope(id, context.deviceId);
    return this.artifacts.download(this.artifactOwner(scope, context), id, signal);
  }
  sendStatus(operationId: string, deviceId: string) { return this.receipts?.sendStatus(operationId, deviceId) ?? 'unknown'; }
  private async dispatchRequest(method: string, params: Record<string, unknown>, context?: RequestContext): Promise<unknown> {
    if (method === 'bridge/extensions') {
      const cwd = await this.projectCwd(params.cwd);
      const id = params.threadId;
      if (id !== undefined && (typeof id !== 'string' || !this.threads.has(id) || !this.loaded.has(id) || this.threadCwd(id) !== cwd || this.deleted.has(id))) throw new Error('Thread is outside the selected workspace');
      this.assertAuthorized(context);
      const result = await readExtensions((method, params) => this.codex.request(method, params), cwd, typeof id === 'string' ? id : undefined);
      this.assertAuthorized(context);
      return result;
    }
    if (method === 'bridge/accountUsage') return this.usage.readActivity();
    if (method === 'bridge/usage') {
      const id = params.threadId;
      if (id !== undefined && (typeof id !== 'string' || !this.threads.has(id) || this.deleted.has(id))) throw new Error('Thread is outside this workspace');
      if (typeof id === 'string' && params.cwd !== undefined && params.cwd !== this.threadCwd(id)) throw new Error('Thread is outside this workspace');
      const account = await this.usage.read();
      return { account, thread: typeof id === 'string' && !this.deleted.has(id) ? this.usage.threads.get(id) ?? null : null };
    }
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
      this.assertAuthorized(context);
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
      this.permissionChoices?.confirm(cwd, response.thread.id, permissionMode(params.permissionMode), this.settings.get(response.thread.id)!);
      return response;
    }
    const threadId = params.threadId;
    if (typeof threadId !== 'string' || !this.threads.has(threadId)) throw new Error('Thread is outside this workspace; refresh the native thread list');
    // A turn/approval/history request cannot reassign an existing thread by
    // supplying a different cwd. Its project came from the validated native list.
    const cwd = this.threadCwd(threadId);
    if (['thread/archive', 'thread/unarchive', 'thread/delete'].includes(method)) {
      return this.changeLifecycle(method, threadId, cwd, params, context);
    }
    if (nativeMethods.has(method as NativeOperationMethod)) return this.changeNative(method as NativeOperationMethod, threadId, cwd, params, context);
    const pendingResponse = method === 'bridge/approve' ? this.pending.get(params.requestId as RpcId) : undefined;
    const needsDirectory = ['bridge/subscribe', 'bridge/history', 'turn/start'].includes(method) ||
      (pendingResponse?.params.threadId === threadId && responseNeedsDirectory(pendingResponse, params));
    // Even if a directory disappears, Stop and Decline remain available.
    if (needsDirectory && this.projects && await this.projects.resolve(cwd) !== cwd) throw new Error('Project directory changed; refresh the native thread list');
    if (method === 'bridge/subscribe' || method === 'bridge/history') {
      const historyRevision = this.historyRevision(threadId);
      if (method === 'bridge/history' && params.historyRevision !== undefined && params.historyRevision !== historyRevision) {
        throw new Error('原生历史版本已变化，请重新查询会话。');
      }
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
      if (historyRevision !== this.historyRevision(threadId)) throw new Error('原生历史已变化，请重新查询会话。');
      for (const turn of result.thread.turns) {
        this.receipts?.observe(cwd, threadId, turn);
        this.observeNativeTurn(threadId, turn);
      }
      const active = result.thread.turns.find(t => t.status === 'inProgress');
      // Older history pages must not change current execution controls.
      if (!params.cursor && revision === (this.revisions.get(threadId) ?? 0)) {
        if (active) { this.busy.add(threadId); this.activeTurns.set(threadId, active.id); }
        else if (thread.status.type !== 'active' && !this.unknownSends.has(threadId)) {
          this.busy.delete(threadId); this.activeTurns.delete(threadId);
        }
      }
      return { ...result, pending: [...this.pending.values()].filter(r => r.params.threadId === threadId || this.descendsFrom(r.params.threadId, threadId)),
        attachments: await this.attachments?.deliveries(cwd, threadId, result.thread.turns.map(turn => turn.id)),
        settings: this.settings.get(threadId),
        sendBlocked: this.unknownSends.has(threadId) || !!this.receipts?.blocked(cwd, threadId) || this.nativeSendBlocked(threadId),
        receipts: this.receipts?.list(cwd, threadId),
        nativeOperations: this.nativeOperations.list(cwd, threadId), nativeCapabilities: this.nativeCapabilities(), historyRevision,
      } satisfies Snapshot;
    }
    if (method === 'turn/start') {
      if (this.busy.has(threadId) || this.activeTurns.has(threadId) || this.receipts?.blocked(cwd, threadId) || this.nativeSendBlocked(threadId)) throw new Error('Turn in progress or native operation result unknown; query state before continuing');
      if (!this.loaded.has(threadId)) throw new Error('Select and resume the thread before starting a turn');
      const hasAttachments = Array.isArray(params.attachmentIds) && params.attachmentIds.length > 0;
      if (typeof params.text !== 'string' || (!params.text.trim() && !hasAttachments) || params.text.length > 16000) throw new Error('Expected 1–16000 characters or attachments');
      if (params.attachmentIds !== undefined && params.cwd !== undefined && params.cwd !== cwd) throw new Error('Thread is outside the selected project');
      // Client paths and binary are never native input. Only owned ready IDs map to files.
      if (params.input !== undefined || params.path !== undefined || params.attachments !== undefined) throw new Error('只接受服务端附件标识。');
      const attachmentOwner = params.attachmentIds !== undefined ? this.attachmentOwner({ ...params, cwd }, context) : undefined;
      const prepared = attachmentOwner ? await this.attachments!.prepare(params.attachmentIds, attachmentOwner) : undefined;
      const request: TurnStartParams = {
        threadId, input: [{ type: 'text', text: (params.text.trim() ? params.text : '请查看所附文件。') + (prepared?.referenceText ?? ''), text_elements: [] }, ...(prepared?.input ?? [])],
        ...turnPermissions(permissionMode(params.permissionMode)),
        ...(typeof params.model === 'string' && params.model ? { model: params.model } : {}),
        ...(typeof params.effort === 'string' && params.effort ? { effort: params.effort } : {}),
      };
      this.assertAuthorized(context);
      if (this.receipts) {
        if (!context?.deviceId) throw new Error('Authenticated device context required');
        this.receipts.reserve(params.operationId, cwd, threadId, context.deviceId, () => { if (prepared) this.attachments!.claim(prepared.rows, params.operationId as string); });
      }
      this.busy.add(threadId);
      this.unknownSends.add(threadId);
      if (params.permissionMode !== undefined && params.permissionMode !== 'inherit') this.acceptedPermissionChoices.delete(threadId);
      if (request.model !== undefined || request.effort !== undefined || (params.permissionMode !== undefined && params.permissionMode !== 'inherit')) this.publishSettings(threadId);
      const fresh = this.fresh.get(threadId);
      this.fresh.delete(threadId);
      // Deliberately keep unknown sends blocked. A timeout is not a safe retry.
      try {
        const result = await this.codex.request<TurnStartResponse>('turn/start', request);
        this.receipts?.accepted(params.operationId as string, result.turn.id,
          prepared ? () => this.attachments!.accepted(params.operationId as string, result.turn.id) : undefined);
        this.receipts?.observe(cwd, threadId, result.turn);
        this.unknownSends.delete(threadId);
        if (prepared?.rows.length) {
          // Metadata refresh cannot turn a confirmed native ACK into a failed send.
          const deliveries = await this.attachments!.deliveries(cwd, threadId, [result.turn.id]).catch(() => []);
          this.emit('event', { type: 'attachmentsChanged', threadId, cwd, deliveries } satisfies BridgeEvent);
        }
        if (this.busy.has(threadId) && result.turn.status === 'inProgress' && (!this.activeTurns.has(threadId) || this.activeTurns.get(threadId) === result.turn.id)) this.activeTurns.set(threadId, result.turn.id);
        // A confirmed turn ACK remains accepted even if the settings read fails.
        // Never derive effective permissions from the requested preset alone.
        const choice = permissionMode(params.permissionMode);
        if (choice !== 'inherit') this.acceptedPermissionChoices.set(threadId, choice);
        void this.readSettings(threadId);
        return result;
      } catch (error) {
        if (error instanceof NativeRpcError) {
          this.receipts?.rejected(params.operationId as string,
            prepared ? () => this.attachments!.rejected(params.operationId as string) : undefined);
          this.busy.delete(threadId);
          this.unknownSends.delete(threadId);
          if (fresh) this.fresh.set(threadId, fresh);
        }
        throw error;
      }
    }
    if (method === 'turn/interrupt') {
      if (typeof params.turnId !== 'string' || this.activeTurns.get(threadId) !== params.turnId) throw new Error('Turn is not the observed active turn; query state');
      this.assertAuthorized(context);
      return this.codex.request('turn/interrupt', { threadId, turnId: params.turnId });
    }
    if (method === 'bridge/approve') {
      const request = this.pending.get(params.requestId as RpcId);
      if (!request || request.params.threadId !== threadId) throw new Error('Approval no longer pending');
      if (params.bridgeToken !== request.bridgeToken) throw new Error('Approval expired or belongs to another Bridge session');
      const result = nativeResponse(request, params);
      this.assertAuthorized(context);
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
  private assertAuthorized(context?: RequestContext) {
    if (context?.isAuthorized && !context.isAuthorized()) throw new Error('设备授权已撤销；未发送新的原生操作。');
  }
  private nativeCapabilities(): NativeCapabilities {
    return { unsupportedMethods: [...this.unsupportedNative], plan: { available: false,
      reason: '当前版本暂不支持原生 Plan 模式。此功能仍属实验能力，为保证会话稳定暂未启用。' } };
  }
  private publishOperation(operation: NativeOperation, change: Partial<NativeOperation>) {
    const next = this.nativeOperations.update(operation, change);
    this.liveNativeOperations.set(next.operationId, next);
    this.emit('event', { type: 'nativeOperationChanged', operation: next } satisfies BridgeEvent);
    return next;
  }
  private completeOperations(threadId: string, method: NativeOperationMethod) {
    for (const operation of this.nativeOperations.unresolved(this.threadCwd(threadId), threadId)) {
      if (operation.method === method) this.publishOperation(operation, { state: 'completed' });
    }
  }
  private observeNativeTurn(threadId: string, turn: { id: string; status: string }) {
    if (!['completed', 'failed', 'interrupted'].includes(turn.status)) return;
    const terminal = this.terminalTurns.get(threadId) ?? new Set<string>();
    terminal.add(turn.id); this.terminalTurns.set(threadId, terminal);
    const statuses = this.terminalTurnStatuses.get(threadId) ?? new Map<string, string>();
    statuses.set(turn.id, turn.status); this.terminalTurnStatuses.set(threadId, statuses);
    for (const operation of this.nativeOperations.unresolved(this.threadCwd(threadId), threadId)) {
      // A terminal turn only settles a review/compact with a native-observed ID.
      // It cannot establish whether a timed-out steer was actually delivered.
      if (operation.turnId === turn.id && ['review/start', 'thread/compact/start'].includes(operation.method)) {
        this.publishOperation(operation, { state: turn.status === 'completed' ? 'completed' : 'rejected',
          ...(turn.status === 'completed' ? {} : { message: turn.status === 'interrupted' ? '原生操作已停止。' : '原生操作执行失败，请查看会话结果。' }) });
      }
    }
  }
  private nativeSendBlocked(threadId: string) {
    return this.nativeOperations.unresolved(this.threadCwd(threadId), threadId)
      .some(operation => ['thread/revert', 'review/start', 'thread/compact/start'].includes(operation.method));
  }
  private historyRevision(threadId: string) {
    let revision = this.historyRevisions.get(threadId);
    if (revision === undefined) {
      revision = Math.max(Date.now(), this.nativeOperations.revision(this.threadCwd(threadId), threadId) + 1);
      this.historyRevisions.set(threadId, revision);
      this.nativeOperations.setRevision(this.threadCwd(threadId), threadId, revision);
    }
    return revision;
  }
  private invalidateHistory(threadId: string, reason: 'revert' | 'compact') {
    const historyRevision = Math.max(Date.now(), this.historyRevision(threadId) + 1);
    this.historyRevisions.set(threadId, historyRevision);
    this.nativeOperations.setRevision(this.threadCwd(threadId), threadId, historyRevision);
    this.fresh.delete(threadId);
    if (reason === 'revert') {
      this.unknownSends.delete(threadId);
      for (const [id, request] of this.pending) if (request.params.threadId === threadId) this.resolveRequest(id);
    }
    this.emit('event', { type: 'threadHistoryChanged', threadId, cwd: this.threadCwd(threadId), reason, historyRevision } satisfies BridgeEvent);
  }
  private assertNativeIdle(threadId: string, cwd: string) {
    if ([...this.threads].some(id => this.related(id, threadId) && (
      ['active', 'systemError'].includes(this.nativeStatuses.get(id) ?? '') || this.busy.has(id) ||
      this.activeTurns.has(id) || this.unknownSends.has(id) || this.receipts?.blocked(this.threadCwd(id), id) || this.nativeSendBlocked(id)))) {
      throw new Error('会话运行中或原生操作结果未知，请先停止并查询状态。');
    }
    if ([...this.pending.values()].some(request => this.related(request.params.threadId, threadId))) {
      throw new Error('会话仍有待处理审批或输入，请先处理并查询状态。');
    }
  }
  private async checkedNativeThread(threadId: string, cwd: string, idle: boolean) {
    const { thread } = await this.codex.request<ThreadReadResponse>('thread/read', { threadId });
    if (thread.id !== threadId || thread.cwd !== cwd) throw new Error('Thread is outside the selected project');
    if (this.nativeParent(thread)) throw new Error('子会话须由原生父会话管理，不能单独执行此操作。');
    if (idle && (!['idle', 'notLoaded'].includes(thread.status.type) || thread.turns.some(turn => turn.status === 'inProgress'))) {
      throw new Error('原生会话运行中或状态异常，请先停止并查询状态。');
    }
    return thread;
  }
  private async completedNativeTurn(threadId: string, turnId: unknown) {
    if (typeof turnId !== 'string' || !turnId) throw new Error('请选择一个已完成的原生轮次。');
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await this.codex.request<ThreadTurnsListResponse>('thread/turns/list', {
        threadId, cursor, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded',
      });
      const turn = page.data.find(turn => turn.id === turnId);
      for (const observed of page.data) this.observeNativeTurn(threadId, observed);
      if (turn) {
        if (turn.status !== 'completed') throw new Error('只能选择已完成的原生轮次。');
        return turnId;
      }
      if (!page.nextCursor) break;
      if (seen.has(page.nextCursor)) throw new Error('原生历史分页重复，未执行操作。');
      seen.add(page.nextCursor); cursor = page.nextCursor;
    }
    throw new Error('原生历史中未找到所选轮次，请重新查询状态。');
  }
  private reviewTarget(value: unknown): ReviewTarget {
    const target = value as Record<string, unknown> | undefined;
    if (target?.type === 'uncommittedChanges') return { type: 'uncommittedChanges' };
    if (target?.type === 'baseBranch' && typeof target.branch === 'string' && target.branch.trim() && target.branch.length <= 256 && !/[\x00-\x1f\x7f]/.test(target.branch)) {
      return { type: 'baseBranch', branch: target.branch.trim() };
    }
    if (target?.type === 'commit' && typeof target.sha === 'string' && /^[0-9a-f]{7,64}$/i.test(target.sha) &&
      (target.title == null || (typeof target.title === 'string' && target.title.length <= 500 && !/[\x00-\x1f\x7f]/.test(target.title)))) {
      return { type: 'commit', sha: target.sha, title: typeof target.title === 'string' ? target.title : null };
    }
    if (target?.type === 'custom' && typeof target.instructions === 'string' && target.instructions.trim() && target.instructions.length <= 16000 && !target.instructions.includes('\0')) {
      return { type: 'custom', instructions: target.instructions };
    }
    throw new Error('原生审阅目标无效。');
  }
  private async changeNative(method: NativeOperationMethod, threadId: string, cwd: string, params: Record<string, unknown>, context?: RequestContext) {
    if (params.cwd !== undefined && params.cwd !== cwd) throw new Error('Thread is outside the selected project');
    if (this.unsupportedNative.has(method)) throw new Error('当前 Codex App Server 不支持此操作；其他功能仍可使用。');
    if (this.nativeOperations.unresolved(cwd, threadId).some(operation => operation.method === method)) {
      throw new Error('此原生操作仍在运行或结果未知；请查询状态，不要重复执行。');
    }
    const name = typeof params.name === 'string' ? params.name.trim() : '';
    if (method === 'thread/name/set' && (!name || [...name].length > 128 || /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(name))) {
      throw new Error('名称须为 1–128 个字符，不能包含控制字符。');
    }
    if (method === 'thread/revert' && params.confirm !== true) throw new Error('回退必须经过二次确认；它不会撤销主机文件修改。');
    if (method === 'turn/steer' && (typeof params.text !== 'string' || !params.text.trim() || params.text.length > 16000)) throw new Error('Expected 1–16000 characters');
    const target = method === 'review/start' ? this.reviewTarget(params.target) : undefined;
    if (params.delivery !== undefined && params.delivery !== 'inline') throw new Error('本次仅支持在当前会话内进行原生审阅。');
    const idle = method !== 'thread/name/set' && method !== 'turn/steer';
    if (idle) this.assertNativeIdle(threadId, cwd);
    if (this.projects && await this.projects.resolve(cwd) !== cwd) throw new Error('Project directory changed; refresh the native thread list');
    let thread = await this.checkedNativeThread(threadId, cwd, idle);
    if (['thread/fork', 'thread/revert'].includes(method) && thread.ephemeral) throw new Error('临时会话尚未持久化，不能分叉或回退。');
    if (['thread/revert', 'review/start', 'thread/compact/start', 'turn/steer'].includes(method) && !this.loaded.has(threadId)) throw new Error('请先选择并恢复此原生会话。');
    const boundary = method === 'thread/revert' ? await this.completedNativeTurn(threadId, params.beforeTurnId)
      : method === 'thread/fork' && params.lastTurnId !== undefined ? await this.completedNativeTurn(threadId, params.lastTurnId) : undefined;
    // Native operations may include children omitted from the interactive list,
    // including archived children in another cwd. Reuse the complete native
    // dependency inventory; it grants no new ownership to the renderer.
    if (idle) {
      await this.lifecycleInventory(threadId, cwd);
      thread = await this.checkedNativeThread(threadId, cwd, true);
    }
    if (this.projects && await this.projects.resolve(cwd) !== cwd) throw new Error('Project directory changed; refresh the native thread list');
    if (idle) this.assertNativeIdle(threadId, cwd);
    if (method === 'turn/steer' && (typeof params.expectedTurnId !== 'string' || this.activeTurns.get(threadId) !== params.expectedTurnId ||
      this.unknownSends.has(threadId) || this.receipts?.uncertainForSteer(cwd, threadId, params.expectedTurnId) ||
      thread.status.type !== 'active' || thread.turns.some(turn => turn.status === 'inProgress' && turn.id !== params.expectedTurnId))) {
      throw new Error('补充指令对应的活动轮次已变化，请查询状态；未创建新轮次。');
    }
    this.assertAuthorized(context);
    let operation = this.nativeOperations.reserve(params.operationId, cwd, threadId, method);
    operation = this.publishOperation(operation, method === 'turn/steer' ? { turnId: params.expectedTurnId as string } : {});
    if (method === 'review/start' || method === 'thread/compact/start') this.busy.add(threadId);
    try {
      if (method === 'thread/name/set') {
        const revision = this.nameRevisions.get(threadId) ?? 0;
        const result = await this.codex.request(method, { threadId, name });
        // Do not overwrite a newer name notification with the requested value
        // when another native client renamed the same thread before our ACK.
        if (revision === (this.nameRevisions.get(threadId) ?? 0)) {
          this.lifecycleRevision++;
          this.nameRevisions.set(threadId, revision + 1);
          const fresh = this.fresh.get(threadId); if (fresh) this.fresh.set(threadId, { ...fresh, name });
          this.emit('event', { type: 'event', event: { method: 'thread/name/updated', params: { threadId, threadName: name } } } satisfies BridgeEvent);
        }
        this.publishOperation(operation, { state: 'completed' });
        return result;
      }
      if (method === 'thread/fork') {
        const result = await this.codex.request<ThreadForkResponse>(method, { threadId, cwd, ...(boundary ? { lastTurnId: boundary } : {}) });
        if (!result.thread.id || result.thread.id === threadId || result.thread.cwd !== cwd || result.cwd !== cwd || result.thread.ephemeral) {
          throw new Error('原生分叉返回的会话或项目归属无法核实。');
        }
        const parent = this.nativeParent(result.thread);
        if (parent && (!this.threads.has(parent) || this.threadCwd(parent) !== cwd || parent === result.thread.id || this.descendsFrom(parent, result.thread.id))) {
          throw new Error('原生分叉的父会话归属无法核实。');
        }
        this.track(result.thread.id, cwd);
        if (parent) this.threadParents.set(result.thread.id, parent);
        this.loaded.add(result.thread.id);
        this.rememberSettings(result);
        this.publishOperation(operation, { state: 'completed', resultThreadId: result.thread.id });
        this.lifecycleRevision++;
        this.emit('event', { type: 'projectsChanged' } satisfies BridgeEvent);
        return result;
      }
      if (method === 'thread/revert') {
        const result = await this.codex.request<ThreadRevertResponse>(method, { threadId, beforeTurnId: boundary! });
        if (result.thread.id !== threadId || result.thread.cwd !== cwd || this.nativeParent(result.thread)) throw new Error('原生回退返回的会话归属无法核实。');
        if (this.nativeOperations.get(operation.operationId, cwd, threadId)?.state !== 'completed') this.invalidateHistory(threadId, 'revert');
        this.publishOperation(operation, { state: 'completed' });
        return result;
      }
      if (method === 'turn/steer') {
        const result = await this.codex.request<TurnSteerResponse>(method, { threadId, expectedTurnId: params.expectedTurnId,
          clientUserMessageId: operation.operationId, input: [{ type: 'text', text: params.text, text_elements: [] }] });
        if (result.turnId !== params.expectedTurnId) throw new Error('原生补充响应的轮次不匹配，结果未知。');
        this.publishOperation(operation, { state: 'completed', turnId: result.turnId });
        return result;
      }
      if (method === 'review/start') {
        const result = await this.codex.request<ReviewStartResponse>(method, { threadId, target, delivery: 'inline' });
        if (result.reviewThreadId !== threadId || !result.turn.id) throw new Error('原生审阅返回了不同会话，结果未知。');
        const current = this.nativeOperations.get(operation.operationId, cwd, threadId)!;
        if (!['completed', 'rejected'].includes(current.state)) {
          const status = this.terminalTurnStatuses.get(threadId)?.get(result.turn.id) ?? result.turn.status;
          this.publishOperation(current, { state: status === 'inProgress' ? 'accepted' : status === 'completed' ? 'completed' : 'rejected', turnId: result.turn.id });
          if (status === 'inProgress') {
            if (!this.activeTurns.has(threadId) || this.activeTurns.get(threadId) === result.turn.id) this.activeTurns.set(threadId, result.turn.id);
            this.busy.add(threadId);
          }
          else if (!this.activeTurns.has(threadId) || this.activeTurns.get(threadId) === result.turn.id) {
            this.busy.delete(threadId); this.activeTurns.delete(threadId);
          }
        }
        return result;
      }
      const result = await this.codex.request(method, { threadId });
      const current = this.nativeOperations.get(operation.operationId, cwd, threadId)!;
      if (!['completed', 'rejected'].includes(current.state)) this.publishOperation(current, { state: 'accepted' });
      return result;
    } catch (error) {
      const current = this.nativeOperations.get(operation.operationId, cwd, threadId)!;
      if (error instanceof NativeRpcError && error.code !== -32603) {
        this.publishOperation(current, { state: 'rejected', message: error.code === -32601 ? '当前 Codex App Server 不支持此操作。' : '原生操作已拒绝，请检查错误后查询状态。' });
        if ((method === 'review/start' || method === 'thread/compact/start') && !this.activeTurns.has(threadId)) this.busy.delete(threadId);
        if (error.code === -32601) {
          this.unsupportedNative.add(method);
          this.emit('event', { type: 'nativeCapabilitiesChanged', capabilities: this.nativeCapabilities() } satisfies BridgeEvent);
          throw new Error('当前 Codex App Server 不支持此操作；其他功能仍可使用。');
        }
        throw error;
      }
      // A matching native notification may already establish a completed revert
      // or rename even if its acknowledgement is lost. Never downgrade that fact.
      if (current.state !== 'completed' && current.state !== 'rejected') this.publishOperation(current, { state: 'unknown', message: '原生操作结果未知；请查询状态，不要重复执行。' });
      throw new Error('原生操作结果未知；请查询状态，不要重复执行。');
    }
  }
  private beginFlight(threadId: string) { this.inFlight.set(threadId, (this.inFlight.get(threadId) ?? 0) + 1); }
  private endFlight(threadId: string) {
    const count = (this.inFlight.get(threadId) ?? 1) - 1;
    if (count) this.inFlight.set(threadId, count); else this.inFlight.delete(threadId);
  }
  private assertLifecycleIdle(threadId: string, cwd: string) {
    if (['active', 'systemError'].includes(this.nativeStatuses.get(threadId) ?? '') || this.busy.has(threadId) || this.activeTurns.has(threadId) || this.unknownSends.has(threadId) || this.receipts?.blocked(cwd, threadId) || this.nativeSendBlocked(threadId)) {
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
  private async changeLifecycle(method: string, threadId: string, cwd: string, params: Record<string, unknown>, context?: RequestContext): Promise<ThreadLifecycleResult> {
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
    this.assertAuthorized(context);
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
    if (state === 'deleted') {
      this.deleted.add(threadId); this.archived.delete(threadId);
      this.permissionChoices?.remove(this.threadCwd(threadId), threadId);
      this.acceptedPermissionChoices.delete(threadId);
    }
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
    const { approvalPolicy, sandbox, approvalsReviewer, model, reasoningEffort } = response;
    this.publishSettings(response.thread.id, { approvalPolicy, sandbox, approvalsReviewer,
      ...(typeof model === 'string' && model ? { model } : {}),
      ...(reasoningEffort === null || typeof reasoningEffort === 'string' ? { effort: reasoningEffort } : {}) });
  }
  private publishSettings(threadId: string, settings?: NativeSessionSettings) {
    this.settingsQueries.set(threadId, (this.settingsQueries.get(threadId) ?? 0) + 1);
    if (settings) {
      this.settings.set(threadId, settings);
      const acceptedChoice = this.acceptedPermissionChoices.get(threadId);
      if (acceptedChoice) {
        this.permissionChoices?.confirm(this.threadCwd(threadId), threadId, acceptedChoice, settings);
        this.acceptedPermissionChoices.delete(threadId);
      }
    } else this.settings.delete(threadId);
    this.emit('event', { type: 'settingsChanged', threadId, settings } satisfies BridgeEvent);
  }
  private async readSettings(threadId: string) {
    const ticket = (this.settingsQueries.get(threadId) ?? 0) + 1;
    this.settingsQueries.set(threadId, ticket);
    try {
      const response = await this.nativeResume(threadId);
      if (response.thread.id !== threadId || response.thread.cwd !== this.threadCwd(threadId)) throw new Error('Native thread settings belong to another thread or project');
      if (ticket === this.settingsQueries.get(threadId)) {
        this.rememberSettings(response);
      }
    } catch {
      if (ticket !== this.settingsQueries.get(threadId)) return;
      this.publishSettings(threadId);
      // Settings readback is ancillary: don't lose history, pending approvals,
      // or accepted receipts when it fails, and never retry a turn automatically.
      this.emit('event', { type: 'notice', threadId,
        message: '实际会话设置尚未确认，请查询状态；发送回执以原生结果为准，不要重复发送。' } satisfies BridgeEvent);
    }
  }
  private async nativeResume(threadId: string, cwd?: string) {
    if (this.lifecycle.has(threadId) || this.archived.has(threadId) || this.deleted.has(threadId) || this.uncertainLifecycle.has(threadId)) throw new Error('Thread lifecycle changed; refresh state');
    this.beginFlight(threadId);
    try { return await this.requestNativeResume(threadId, cwd); } finally { this.endFlight(threadId); }
  }
  private async requestNativeResume(threadId: string, cwd?: string) {
    // Only a first load restores an explicitly selected preset. Rejoining an
    // already loaded thread is a read and never reapplies client preferences.
    const choice = cwd ? this.permissionChoices?.get(cwd, threadId) : undefined;
    const params = { threadId, ...(cwd ? { cwd } : {}), ...(choice ? threadPermissions(choice) : {}) };
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
