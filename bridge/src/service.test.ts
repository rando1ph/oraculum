import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { BridgeService } from './service';
import { createServer } from './server';

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
    codex.request.mockResolvedValue({ thread: { id: 'thread-2' } });
    await service.dispatch('thread/start', { cwd: '/etc', approvalPolicy: 'never' });
    expect(codex.request).toHaveBeenCalledWith('thread/start', {
      cwd: '/controlled-workspace', sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user',
    });
  });
  it('answers exact server request ID once; item ID cannot substitute', async () => {
    const { service, codex } = fixture();
    codex.emit('message', { id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', itemId: 'same-item', turnId: 'turn-1' } });
    await expect(service.dispatch('bridge/approve', { threadId: 'thread-1', requestId: 'same-item', decision: 'accept' })).rejects.toThrow();
    await service.dispatch('bridge/approve', { threadId: 'thread-1', requestId: 99, decision: 'decline' });
    expect(codex.send).toHaveBeenCalledExactlyOnceWith({ id: 99, result: { decision: 'decline' } });
    await expect(service.dispatch('bridge/approve', { threadId: 'thread-1', requestId: 99, decision: 'accept' })).rejects.toThrow();
  });
  it('keeps an unknown send blocked instead of silently resending', async () => {
    const { service, codex } = fixture();
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
    expect(codex.send).toHaveBeenCalledWith({ id: 3, error: { code: -32601, message: 'Interaction unsupported by Phase 0B client' } });
  });
  it('requires exact local host and same Origin before upgrade', async () => {
    const { service } = fixture();
    const app = await createServer(service, 17860, '/missing-static-root');
    try {
      expect((await app.inject({ url: '/health', headers: { host: '127.0.0.1:17860' } })).statusCode).toBe(200);
      expect((await app.inject({ url: '/health', headers: { host: 'evil.test:17860' } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/ws', headers: { host: '127.0.0.1:17860', origin: 'https://evil.test' } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/ws', headers: { host: '127.0.0.1:17860' } })).statusCode).toBe(403);
    } finally { await app.close(); }
  });
});
