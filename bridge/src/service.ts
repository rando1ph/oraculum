import { EventEmitter } from 'node:events';
import { NativeRpcError, type Codex } from './codex';
import type { Approval, RpcId, Snapshot, WireMessage, BridgeEvent, LocalConfig, Thread } from '../../packages/shared/protocol';
import type { ThreadStartParams } from '../../.local/codex-protocol/v2/ThreadStartParams';
import type { ThreadStartResponse } from '../../.local/codex-protocol/v2/ThreadStartResponse';
import type { TurnStartParams } from '../../.local/codex-protocol/v2/TurnStartParams';
import type { TurnStartResponse } from '../../.local/codex-protocol/v2/TurnStartResponse';
import type { ThreadReadResponse } from '../../.local/codex-protocol/v2/ThreadReadResponse';
import type { ModelListResponse } from '../../.local/codex-protocol/v2/ModelListResponse';
import type { ThreadListResponse } from '../../.local/codex-protocol/v2/ThreadListResponse';
import type { ThreadResumeResponse } from '../../.local/codex-protocol/v2/ThreadResumeResponse';
import type { ConfigReadResponse } from '../../.local/codex-protocol/v2/ConfigReadResponse';

export class BridgeService extends EventEmitter {
  readonly threads = new Set<string>();
  readonly pending = new Map<RpcId, Approval>();
  private busy = new Set<string>();
  private unknownSends = new Set<string>();
  private loaded = new Set<string>();
  private fresh = new Map<string, Thread>();
  private resuming = new Map<string, Promise<void>>();
  constructor(readonly codex: Pick<Codex, 'request' | 'send'> & { on(event: string, listener: (...args: any[]) => void): unknown }, readonly cwd: string) {
    super();
    codex.on('message', (message: WireMessage) => this.receive(message));
    codex.on('unavailable', (message: string) => {
      this.pending.clear();
      this.emit('event', { type: 'unavailable', message } satisfies BridgeEvent);
    });
  }
  private receive(message: WireMessage) {
    const params = message.params ?? {};
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    if (message.method && message.id !== undefined) {
      if (threadId && this.threads.has(threadId) &&
        ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
        const request = message as Approval;
        this.pending.set(request.id, request);
        this.emit('event', { type: 'approval', request } satisfies BridgeEvent);
      } else {
        // Fail closed on auth requests / unsupported interactions; no credentials
        // or privileged requests are forwarded to the renderer.
        this.codex.send({ id: message.id, error: { code: -32601, message: 'Interaction unsupported by Phase 0B client' } });
        this.emit('event', { type: 'unavailable', message: `Unsupported interaction: ${message.method}` } satisfies BridgeEvent);
      }
      return;
    }
    if (!threadId || !this.threads.has(threadId)) return;
    if (message.method === 'serverRequest/resolved') this.pending.delete(params.requestId as RpcId);
    if (message.method === 'turn/completed') {
      this.busy.delete(threadId);
      this.unknownSends.delete(threadId);
      for (const [id, request] of this.pending) if (request.params.threadId === threadId) this.pending.delete(id);
    }
    // Native notifications are the facts; no agent loop or tool execution here.
    this.emit('event', { type: 'event', event: message } as BridgeEvent);
  }
  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'bridge/config') {
      const { config } = await this.codex.request<ConfigReadResponse>('config/read', { cwd: this.cwd, includeLayers: false });
      // Only safe effective settings cross into the renderer, never raw config.
      return { cwd: this.cwd, model: config.model, effort: config.model_reasoning_effort,
        provider: config.model_provider, approvalPolicy: 'on-request', sandbox: 'workspace-write',
        restrictedTools: true } satisfies LocalConfig;
    }
    if (method === 'model/list') {
      return this.codex.request<ModelListResponse>('model/list', { limit: 100, includeHidden: false, cursor: typeof params.cursor === 'string' ? params.cursor : undefined });
    }
    if (method === 'thread/list' || method === 'bridge/threads') {
      const page = await this.codex.request<ThreadListResponse>('thread/list', {
        cwd: this.cwd, limit: 30, sortKey: 'updated_at', modelProviders: [],
        cursor: typeof params.cursor === 'string' ? params.cursor : undefined,
      });
      page.data = page.data.filter(thread => thread.cwd === this.cwd);
      for (const thread of page.data) this.threads.add(thread.id);
      if (!params.cursor) {
        page.data = [...this.fresh.values()].filter(t => !page.data.some(p => p.id === t.id)).concat(page.data);
      }
      return method === 'bridge/threads' ? page.data.map(t => t.id) : page;
    }
    if (method === 'thread/start') {
      const request: ThreadStartParams = {
        cwd: this.cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user',
        ...(typeof params.model === 'string' && params.model ? { model: params.model } : {}),
      };
      const response = await this.codex.request<ThreadStartResponse>('thread/start', request);
      this.threads.add(response.thread.id);
      this.loaded.add(response.thread.id);
      this.fresh.set(response.thread.id, response.thread);
      return response;
    }
    const threadId = params.threadId;
    if (typeof threadId !== 'string' || !this.threads.has(threadId)) throw new Error('Thread is outside this workspace; refresh the native thread list');
    if (method === 'bridge/subscribe') {
      await this.resume(threadId);
      const thread = this.fresh.get(threadId) ??
        (await this.codex.request<ThreadReadResponse>('thread/read', { threadId, includeTurns: true })).thread;
      if (thread.turns.some(t => t.status === 'inProgress')) this.busy.add(threadId);
      return { thread, pending: [...this.pending.values()].filter(r => r.params.threadId === threadId),
        sendBlocked: this.unknownSends.has(threadId),
        history: { source: 'native-read', warning: '部分历史未能恢复：原生历史可能缺少审批、拒绝和工具事件。待审批仅在当前 Bridge 生命周期有效。' },
      } satisfies Snapshot;
    }
    if (method === 'turn/start') {
      if (this.busy.has(threadId)) throw new Error('Turn in progress or send result unknown; query state before continuing');
      if (typeof params.text !== 'string' || !params.text.trim() || params.text.length > 16000) throw new Error('Expected 1–16000 characters');
      const request: TurnStartParams = {
        threadId, input: [{ type: 'text', text: params.text, text_elements: [] }],
        ...(typeof params.model === 'string' && params.model ? { model: params.model } : {}),
        ...(typeof params.effort === 'string' && params.effort ? { effort: params.effort } : {}),
      };
      this.busy.add(threadId);
      this.unknownSends.add(threadId);
      this.fresh.delete(threadId);
      // Deliberately keep unknown sends blocked. A timeout is not a safe retry.
      try {
        const result = await this.codex.request<TurnStartResponse>('turn/start', request);
        this.unknownSends.delete(threadId);
        return result;
      } catch (error) {
        if (error instanceof NativeRpcError) {
          this.busy.delete(threadId);
          this.unknownSends.delete(threadId);
        }
        throw error;
      }
    }
    if (method === 'turn/interrupt') {
      if (typeof params.turnId !== 'string') throw new Error('Missing turnId');
      return this.codex.request('turn/interrupt', { threadId, turnId: params.turnId });
    }
    if (method === 'bridge/approve') {
      const request = this.pending.get(params.requestId as RpcId);
      if (!request || request.params.threadId !== threadId) throw new Error('Approval no longer pending');
      if (!['accept', 'decline', 'cancel'].includes(String(params.decision))) throw new Error('Unsupported decision');
      // Remove synchronously before writing; never apply a reply twice.
      this.pending.delete(request.id);
      this.codex.send({ id: request.id, result: { decision: params.decision } });
      return { submitted: true };
    }
    throw new Error('Method not exposed by Phase 0B');
  }
  private async resume(threadId: string) {
    if (this.loaded.has(threadId)) return;
    const existing = this.resuming.get(threadId);
    if (existing) return existing;
    const resume = (async () => {
      const { thread } = await this.codex.request<ThreadReadResponse>('thread/read', { threadId });
      if (thread.cwd !== this.cwd) throw new Error('Thread is outside this workspace');
      this.loaded.add(threadId);
      try {
        await this.codex.request<ThreadResumeResponse>('thread/resume', {
          threadId, cwd: this.cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request',
          approvalsReviewer: 'user', excludeTurns: true,
        });
      } catch (error) { this.loaded.delete(threadId); throw error; }
    })();
    this.resuming.set(threadId, resume);
    try { await resume; } finally { this.resuming.delete(threadId); }
  }
}
