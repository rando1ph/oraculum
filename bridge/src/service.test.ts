import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { BridgeService } from './service';
import { createServer } from './server';
import { NativeRpcError } from './codex';

function fixture() {
  const codex = Object.assign(new EventEmitter(), {
    request: vi.fn(async (_method: string, _params: object): Promise<unknown> => ({})),
    send: vi.fn(),
  });
  const service = new BridgeService({
    on: codex.on.bind(codex),
    send: codex.send,
    request: async <T>(method: string, params: object): Promise<T> => await codex.request(method, params) as T,
  }, '/controlled-workspace');
  service.threads.add('thread-1');
  return { codex, service };
}
describe('PoC boundary and native routing', () => {
  it('rejects unrelated threads and privileged methods', async () => {
    const { service, codex } = fixture();
    await expect(service.dispatch('bridge/subscribe', { threadId: 'private-thread' })).rejects.toThrow('outside');
    await expect(service.dispatch('config/value/write', { threadId: 'thread-1' })).rejects.toThrow('not exposed');
    expect(codex.request).not.toHaveBeenCalled();
  });
  it('scopes cwd, sandbox and reviewer independently of UI params', async () => {
    const { service, codex } = fixture();
    codex.request.mockResolvedValue({ thread: { id: 'thread-2', cwd: '/controlled-workspace' } });
    await service.dispatch('thread/start', { cwd: '/etc', approvalPolicy: 'never' });
    expect(codex.request).toHaveBeenCalledWith('thread/start', {
      cwd: '/controlled-workspace', sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user',
    });
  });
  it('answers exact server request ID once; item ID cannot substitute', async () => {
    const { service, codex } = fixture();
    codex.emit('message', { id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', itemId: 'same-item', turnId: 'turn-1' } });
    await expect(service.dispatch('bridge/approve', { threadId: 'thread-1', requestId: 'same-item', decision: 'accept' })).rejects.toThrow();
    const bridgeToken = service.pending.get(99)!.bridgeToken;
    await expect(service.dispatch('bridge/approve', { threadId: 'thread-1', requestId: 99, bridgeToken: 'stale', decision: 'accept' })).rejects.toThrow('expired');
    await service.dispatch('bridge/approve', { threadId: 'thread-1', requestId: 99, bridgeToken, decision: 'decline' });
    expect(codex.send).toHaveBeenCalledExactlyOnceWith({ id: 99, result: { decision: 'decline' } });
    await expect(service.dispatch('bridge/approve', { threadId: 'thread-1', requestId: 99, decision: 'accept' })).rejects.toThrow();
  });
  it('keeps an unknown send blocked instead of silently resending', async () => {
    const { service, codex } = fixture();
    codex.request.mockResolvedValue({ thread: { id: 'thread-1', cwd: '/controlled-workspace' } });
    await service.dispatch('thread/start', {});
    codex.request.mockClear();
    codex.request.mockRejectedValue(new Error('response timeout'));
    await expect(service.dispatch('turn/start', { threadId: 'thread-1', text: 'hello' })).rejects.toThrow('timeout');
    await expect(service.dispatch('turn/start', { threadId: 'thread-1', text: 'hello' })).rejects.toThrow('unknown');
    expect(codex.request).toHaveBeenCalledTimes(1);
  });
  it('drops pending prompts on native resolution and fails closed for unsupported requests', () => {
    const { service, codex } = fixture();
    codex.emit('message', { id: 2, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1' } });
    codex.emit('message', { method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 2 } });
    expect(service.pending.size).toBe(0);
    codex.emit('message', { id: 3, method: 'account/chatgptAuthTokens/refresh', params: {} });
    expect(codex.send).toHaveBeenCalledWith({ id: 3, error: { code: -32601, message: 'Interaction unsupported by Oraculum; no permission granted' } });
  });
  it('allows a file approval only with its current token and never reuses a resolved ID', async () => {
    const { service, codex } = fixture();
    codex.emit('message', { id: 'file-request', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'u', itemId: 'patch' } });
    const bridgeToken = service.pending.get('file-request')!.bridgeToken;
    await service.dispatch('bridge/approve', { threadId: 'thread-1', requestId: 'file-request', bridgeToken, decision: 'accept' });
    expect(codex.send).toHaveBeenCalledExactlyOnceWith({ id: 'file-request', result: { decision: 'accept' } });
    await expect(service.dispatch('bridge/approve', { threadId: 'thread-1', requestId: 'file-request', bridgeToken, decision: 'accept' })).rejects.toThrow('no longer');
  });
  it.each(['item/tool/requestUserInput', 'mcpServer/elicitation/request', 'item/permissions/requestApproval'])('safely rejects unsupported %s and tells the UI', method => {
    const { service, codex } = fixture();
    const events: unknown[] = [];
    service.on('event', e => events.push(e));
    codex.emit('message', { id: 4, method, params: { threadId: 'thread-1', turnId: 'u' } });
    expect(codex.send).toHaveBeenCalledWith({ id: 4, error: expect.objectContaining({ code: -32601 }) });
    expect(events).toContainEqual({ type: 'notice', threadId: 'thread-1', message: expect.stringContaining('已安全拒绝') });
    expect(service.pending.size).toBe(0);
  });
  it('requires exact local host and same Origin before upgrade', async () => {
    const { service } = fixture();
    const app = await createServer(service, 17860, '/missing-static-root', { testOnlyUnauthenticated: true });
    try {
      expect((await app.inject({ url: '/health', headers: { host: '127.0.0.1:17860' } })).statusCode).toBe(200);
      expect((await app.inject({ url: '/health', headers: { host: 'evil.test:17860' } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/ws', headers: { host: '127.0.0.1:17860', origin: 'https://evil.test' } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/ws', headers: { host: '127.0.0.1:17860' } })).statusCode).toBe(403);
    } finally { await app.close(); }
  });
});

describe('native session and settings', () => {
  it('lists only the fixed workspace and uses the native opaque cursor', async () => {
    const { service, codex } = fixture();
    codex.request.mockResolvedValue({ data: [{ id: 'ours', cwd: '/controlled-workspace' }, { id: 'other', cwd: '/private' }], nextCursor: 'opaque' });
    expect(await service.dispatch('thread/list', { cwd: '/private', cursor: 'cursor' })).toMatchObject({ data: [{ id: 'ours' }], nextCursor: 'opaque' });
    expect(codex.request).toHaveBeenCalledWith('thread/list', expect.objectContaining({ cwd: '/controlled-workspace', cursor: 'cursor' }));
    expect(service.threads.has('other')).toBe(false);
  });
  it('rechecks cwd before native resume and never accepts history or config from renderer', async () => {
    const { service, codex } = fixture();
    codex.request.mockImplementation(async method => method === 'thread/read'
      ? { thread: { id: 'thread-1', cwd: '/controlled-workspace', status: { type: 'idle' }, turns: [] } }
      : method === 'thread/turns/list' ? { data: [], nextCursor: null } : {});
    await service.dispatch('bridge/subscribe', { threadId: 'thread-1', history: [], cwd: '/private', config: { sandbox_mode: 'danger-full-access' } });
    expect(codex.request).toHaveBeenCalledWith('thread/resume', {
      threadId: 'thread-1', cwd: '/controlled-workspace', sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user', excludeTurns: true,
    });
  });
  it('does not resume a listed thread whose cwd no longer matches', async () => {
    const { service, codex } = fixture();
    codex.request.mockResolvedValue({ thread: { cwd: '/private' } });
    await expect(service.dispatch('bridge/subscribe', { threadId: 'thread-1' })).rejects.toThrow('outside');
    expect(codex.request).toHaveBeenCalledTimes(1);
  });
  it('projects only safe effective configuration', async () => {
    const { service, codex } = fixture();
    codex.request.mockResolvedValue({ config: { model: 'catalog-model', model_reasoning_effort: 'high', model_provider: 'openai', secret: 'must-not-leak', instructions: 'private' } });
    expect(await service.dispatch('bridge/config', {})).toEqual({ cwd: '/controlled-workspace', model: 'catalog-model', effort: 'high', provider: 'openai', sandbox: 'workspace-write', approvalPolicy: 'on-request', restrictedTools: true });
  });
});

describe('turn ownership and recovery safety', () => {
  it('never lets an old snapshot resurrect a completed turn', async () => {
    const { service, codex } = fixture();
    const thread = { id: 'thread-1', cwd: '/controlled-workspace', status: { type: 'active' }, turns: [] };
    const turn = { id: 'current', status: 'inProgress', items: [] };
    codex.request.mockImplementation(async method => {
      if (method === 'thread/start' || method === 'thread/read') return { thread };
      if (method === 'turn/start') return { turn };
      if (method === 'thread/turns/list') return { data: [turn], nextCursor: null };
      if (method === 'thread/items/list') {
        codex.emit('message', { method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, status: 'completed' } } });
        return { data: [], nextCursor: null };
      }
      return {};
    });
    await service.dispatch('thread/start', {});
    await service.dispatch('turn/start', { threadId: thread.id, text: 'one' });
    await service.dispatch('bridge/subscribe', { threadId: thread.id });
    await expect(service.dispatch('turn/interrupt', { threadId: thread.id, turnId: turn.id })).rejects.toThrow('active');
    await expect(service.dispatch('turn/start', { threadId: thread.id, text: 'two' })).resolves.toEqual({ turn });
  });
  it('permits a manual next send after an explicit native rejection, but requires resume for listed threads', async () => {
    const { service, codex } = fixture();
    await expect(service.dispatch('turn/start', { threadId: 'thread-1', text: 'first' })).rejects.toThrow('resume');
    codex.request.mockResolvedValue({ thread: { id: 'thread-1', cwd: '/controlled-workspace' } });
    await service.dispatch('thread/start', {});
    codex.request.mockRejectedValueOnce(new NativeRpcError('model unavailable', -32602));
    await expect(service.dispatch('turn/start', { threadId: 'thread-1', text: 'first' })).rejects.toThrow('model unavailable');
    codex.request.mockResolvedValue({ turn: { id: 'u', status: 'inProgress' } });
    await expect(service.dispatch('turn/start', { threadId: 'thread-1', text: 'manual retry' })).resolves.toMatchObject({ turn: { id: 'u' } });
  });
  it('does not let a late completion unlock another running turn', async () => {
    const { service, codex } = fixture();
    codex.emit('message', { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'current', status: 'inProgress' } } });
    codex.emit('message', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'old', status: 'completed' } } });
    await expect(service.dispatch('turn/start', { threadId: 'thread-1', text: 'duplicate' })).rejects.toThrow('progress');
  });
  it('rejects interrupt for a turn that is not the observed active turn', async () => {
    const { service, codex } = fixture();
    codex.emit('message', { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'current', status: 'inProgress' } } });
    await expect(service.dispatch('turn/interrupt', { threadId: 'thread-1', turnId: 'old' })).rejects.toThrow('active');
    expect(codex.request).not.toHaveBeenCalled();
  });
});
