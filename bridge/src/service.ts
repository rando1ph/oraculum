import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { NativeRpcError, type Codex } from './codex';
import type { Approval, RpcId, Snapshot, WireMessage, BridgeEvent, LocalConfig, Thread, NativeSessionSettings } from '../../packages/shared/protocol';
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
  private resuming = new Map<string, Promise<void>>();
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
    this.revisions.set(threadId, (this.revisions.get(threadId) ?? 0) + 1);
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
      const page = await this.codex.request<ThreadListResponse>('thread/list', {
        cwd, limit: 30, sortKey: 'updated_at', modelProviders: [],
        cursor: typeof params.cursor === 'string' ? params.cursor : undefined,
      });
      page.data = page.data.filter(thread => thread.cwd === cwd);
      for (const thread of page.data) this.track(thread.id, cwd);
      if (!params.cursor) {
        page.data = [...this.fresh.values()].filter(t => this.threadCwd(t.id) === cwd && !page.data.some(p => p.id === t.id)).concat(page.data);
      }
      return method === 'bridge/threads' ? page.data.map(t => t.id) : page;
    }
    if (method === 'thread/start') {
      const cwd = await this.projectCwd(params.cwd);
      const request: ThreadStartParams = {
        cwd,
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
    const pendingResponse = method === 'bridge/approve' ? this.pending.get(params.requestId as RpcId) : undefined;
    const needsDirectory = ['bridge/subscribe', 'bridge/history', 'turn/start'].includes(method) ||
      (pendingResponse?.params.threadId === threadId && responseNeedsDirectory(pendingResponse, params));
    // Even if a directory disappears, Stop and Decline remain available.
    if (needsDirectory && this.projects && await this.projects.resolve(cwd) !== cwd) throw new Error('Project directory changed; refresh the native thread list');
    if (method === 'bridge/subscribe' || method === 'bridge/history') {
      await this.resume(threadId);
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
        ...(typeof params.model === 'string' && params.model ? { model: params.model } : {}),
        ...(typeof params.effort === 'string' && params.effort ? { effort: params.effort } : {}),
      };
      if (this.receipts) {
        if (!context?.deviceId) throw new Error('Authenticated device context required');
        this.receipts.reserve(params.operationId, cwd, threadId, context.deviceId);
      }
      this.busy.add(threadId);
      this.unknownSends.add(threadId);
      const fresh = this.fresh.get(threadId);
      this.fresh.delete(threadId);
      // Deliberately keep unknown sends blocked. A timeout is not a safe retry.
      try {
        const result = await this.codex.request<TurnStartResponse>('turn/start', request);
        this.receipts?.accepted(params.operationId as string, result.turn.id);
        this.receipts?.observe(cwd, threadId, result.turn);
        this.unknownSends.delete(threadId);
        if (this.busy.has(threadId) && result.turn.status === 'inProgress') this.activeTurns.set(threadId, result.turn.id);
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
    this.settings.set(response.thread.id, { approvalPolicy, sandbox, approvalsReviewer });
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
        const resumed = await this.codex.request<ThreadResumeResponse>('thread/resume', {
          threadId, cwd, excludeTurns: true,
        });
        if (resumed.thread.cwd !== cwd) throw new Error('Native thread resumed outside the selected project');
        this.rememberSettings(resumed);
        this.loaded.add(threadId);
      } catch (error) { this.loaded.delete(threadId); throw error; }
    })();
    this.resuming.set(threadId, resume);
    try { await resume; } finally { this.resuming.delete(threadId); }
  }
}
