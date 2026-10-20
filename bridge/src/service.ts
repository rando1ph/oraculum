import { EventEmitter } from 'node:events';
import type { Codex } from './codex';
import type { Approval, RpcId, Snapshot, WireMessage, BridgeEvent } from '../../packages/shared/protocol';
import type { ThreadStartParams } from '../../.local/codex-protocol/v2/ThreadStartParams';
import type { ThreadStartResponse } from '../../.local/codex-protocol/v2/ThreadStartResponse';
import type { TurnStartParams } from '../../.local/codex-protocol/v2/TurnStartParams';
import type { TurnStartResponse } from '../../.local/codex-protocol/v2/TurnStartResponse';
import type { ThreadReadResponse } from '../../.local/codex-protocol/v2/ThreadReadResponse';
import type { ModelListResponse } from '../../.local/codex-protocol/v2/ModelListResponse';

export class BridgeService extends EventEmitter {
  readonly threads = new Set<string>();
  readonly pending = new Map<RpcId, Approval>();
  private busy = new Set<string>();
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
      for (const [id, request] of this.pending) if (request.params.threadId === threadId) this.pending.delete(id);
    }
    // Native notifications are the facts; no agent loop or tool execution here.
    this.emit('event', { type: 'event', event: message } as BridgeEvent);
  }
  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'model/list') {
      return this.codex.request<ModelListResponse>('model/list', { limit: 100, includeHidden: false, cursor: typeof params.cursor === 'string' ? params.cursor : undefined });
    }
    if (method === 'bridge/threads') return [...this.threads];
    if (method === 'thread/start') {
      if (this.threads.size >= 12) throw new Error('PoC thread limit reached; restart after inspection');
      const request: ThreadStartParams = {
        cwd: this.cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user',
        ...(typeof params.model === 'string' && params.model ? { model: params.model } : {}),
      };
      const response = await this.codex.request<ThreadStartResponse>('thread/start', request);
      this.threads.add(response.thread.id);
      return response;
    }
    const threadId = params.threadId;
    if (typeof threadId !== 'string' || !this.threads.has(threadId)) throw new Error('Thread is outside this PoC process');
    if (method === 'bridge/subscribe') {
      const { thread } = await this.codex.request<ThreadReadResponse>('thread/read', { threadId, includeTurns: true });
      return { thread, pending: [...this.pending.values()].filter(r => r.params.threadId === threadId) } satisfies Snapshot;
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
      // Deliberately keep unknown sends blocked. A timeout is not a safe retry.
      return this.codex.request<TurnStartResponse>('turn/start', request);
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
}
