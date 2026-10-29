import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readExtensions } from './extensions';
import { BridgeService } from './service';
import { NativeRpcError } from './codex';
import { createServer } from './server';
import { TrustStore } from './trust-store';

function fixture() {
  const request = vi.fn(async (method: string, _params: any): Promise<any> => {
    if (method === 'skills/list') return { data: [{ cwd: '/fixture', skills: [
      { name: 'analysis', scope: 'repo', description: 'Project skill', enabled: true, path: '/private/SKILL.md', dependencies: { secret: 'hidden' } },
      { name: 'disabled', scope: 'user', description: 'Disabled skill', enabled: false },
    ], errors: [] }] };
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'docs', authStatus: 'unsupported', runtimeStatus: 'connected', tools: { read: { inputSchema: { secret: 'hidden' } } }, httpOrigin: 'https://private.example', serverCapabilities: { secret: 'hidden' } }], nextCursor: null };
    if (method === 'app/installed') return { apps: [{ id: 'app', runtimeName: 'Documents', enabled: true, callable: false }] };
    if (method === 'plugin/list') return { marketplaces: [{ path: '/private/catalog', plugins: [
      { id: 'installed', name: 'Installed', installed: true, enabled: false, availability: 'DISABLED_BY_ADMIN', source: { type: 'git', url: 'https://secret@example' }, interface: { shortDescription: 'Plugin info', websiteUrl: 'https://secret' } },
      { id: 'catalog-only', name: 'Catalog only', installed: false, enabled: false },
    ] }], marketplaceLoadErrors: [] };
    throw new Error('Unexpected method');
  });
  return { request, read: () => readExtensions(request, '/fixture', 'parent') };
}

it('projects native distinctions and only minimal display data; never calls catalog apps, plugin/read, config or mutations', async () => {
  const f = fixture(), result = await f.read();
  expect(result.lists.skills.entries.map(value => value.enabled)).toEqual([true, false]);
  expect(result.lists.skills.entries.map(value => value.source)).toEqual(['项目', '用户']);
  expect(result.lists.mcp.entries[0]).toMatchObject({ enabled: null, runtimeStatus: 'connected', authStatus: 'unsupported', toolCount: 1 });
  expect(result.lists.mcp.status).toBe('ready');
  expect(result.lists.apps.entries[0]).toMatchObject({ installed: true, enabled: true, callable: false });
  expect(result.lists.plugins.entries).toHaveLength(1);
  expect(result.lists.plugins.entries[0]).toMatchObject({ installed: true, enabled: false, available: false, source: 'Git 插件' });
  expect(JSON.stringify(result)).not.toMatch(/private|secret|hidden|inputSchema|catalog-only/);
  expect(f.request.mock.calls.map(call => call[0]).sort()).toEqual(['app/installed', 'mcpServerStatus/list', 'plugin/list', 'skills/list']);
  expect(f.request).toHaveBeenCalledWith('app/installed', { threadId: 'parent', forceRefresh: false });
});

it('follows native opaque MCP cursors, deduplicates rows and keeps partial data on repeat cursors', async () => {
  const f = fixture(), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (method, params) => method !== 'mcpServerStatus/list' ? original(method, params) : {
    data: [{ name: params.cursor ? 'second' : 'first', tools: {} }], nextCursor: 'opaque',
  });
  const list = (await f.read()).lists.mcp;
  expect(list.entries.map(row => row.name)).toEqual(['first', 'second']); expect(list.status).toBe('partial');
  expect(f.request).toHaveBeenCalledWith('mcpServerStatus/list', expect.objectContaining({ cursor: 'opaque', detail: 'toolsAndAuthOnly', threadId: 'parent' }));
  expect(list.entries[0]).toMatchObject({ authStatus: null, runtimeStatus: null, enabled: null });
});

it('isolates unsupported methods, 403 and malformed responses and never exposes upstream details', async () => {
  const f = fixture();
  f.request.mockImplementation(async method => {
    if (method === 'skills/list') return { data: [{ cwd: '/private', skills: [{ name: 'hidden' }] }] };
    if (method === 'mcpServerStatus/list') return { data: 'bad' };
    if (method === 'app/installed') throw new NativeRpcError('403 Cloudflare private cookies', -32000);
    throw new NativeRpcError('private unknown method', -32601);
  });
  const result = await f.read();
  expect(result.lists.skills).toMatchObject({ status: 'partial', entries: [] });
  expect(result.lists.mcp.status).toBe('unavailable');
  expect(result.lists.apps).toMatchObject({ status: 'unavailable', message: '原生服务拒绝访问，暂时无法读取。' });
  expect(result.lists.plugins.status).toBe('unsupported');
  expect(JSON.stringify(result)).not.toMatch(/private|cookies|hidden|Cloudflare/);
});

it('reports skill/plugin source errors and MCP tool discovery failure without pretending empty success or disconnect', async () => {
  const f = fixture();
  f.request.mockImplementation(async method => method === 'skills/list' ? { data: [{ cwd: '/fixture', skills: [], errors: [{ path: '/private', message: 'secret' }] }] }
    : method === 'plugin/list' ? { marketplaces: [], marketplaceLoadErrors: [{ message: 'secret' }] }
    : method === 'mcpServerStatus/list' ? { data: [{ name: 'docs', authStatus: 'unsupported', tools: {}, toolsError: 'secret' }], nextCursor: null }
    : { apps: [] });
  const result = await f.read();
  expect(result.lists.skills.status).toBe('partial'); expect(result.lists.plugins.status).toBe('partial');
  expect(result.lists.mcp).toMatchObject({ status: 'partial', entries: [{ toolCount: null, runtimeStatus: null, authStatus: 'unsupported' }] });
  expect(result.lists.apps).toMatchObject({ status: 'ready', entries: [] });
  expect(JSON.stringify(result)).not.toMatch(/secret|private/);
});

it('bounds optional inventory waits without blocking the other capabilities', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, params) => method === 'plugin/list' ? new Promise(() => {}) : original(method, params));
    const result = f.read(); await vi.advanceTimersByTimeAsync(12001);
    expect((await result).lists.plugins.status).toBe('unavailable'); expect((await result).lists.skills.entries).toHaveLength(2);
  } finally { vi.useRealTimers(); }
});

it('rejects unauthorized scope before any inventory read and rechecks trust after asynchronous reads', async () => {
  const f = fixture(), bus = new EventEmitter();
  const service = new BridgeService({ request: f.request, send: vi.fn(), on: bus.on.bind(bus) }, '/fixture');
  service.threads.add('parent');
  await expect(service.dispatch('bridge/extensions', { threadId: 'private' })).rejects.toThrow('outside');
  await expect(service.dispatch('bridge/extensions', { threadId: 'parent' })).rejects.toThrow('outside'); // not loaded
  expect(f.request).not.toHaveBeenCalled();
  let authorized = true;
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (method, params) => { const value = await original(method, params); authorized = false; return value; });
  await expect(service.dispatch('bridge/extensions', {}, { deviceId: 'test', isAuthorized: () => authorized })).rejects.toThrow('设备授权已撤销');
});

it.each([false, true])('retains WS authentication/Origin and suppresses late inventory after revocation (remote=%s)', async remote => {
  const dir = mkdtempSync(join(tmpdir(), 'oraculum-b6-auth-')), trust = new TrustStore(dir), bus = new EventEmitter();
  let finish!: (value: unknown) => void;
  const read = new Promise(resolve => { finish = resolve; });
  const request = vi.fn(async <T>(): Promise<T> => await read as T);
  const service = new BridgeService({ request: async <T>() => await request() as T, send: vi.fn(), on: bus.on.bind(bus) }, '/fixture');
  const app = await createServer(service, 17864, '/missing', { trust, remoteOrigin: 'https://b6.example', remoteBasePath: '/console/' });
  await app.ready();
  try {
    const headers = remote ? { host: 'b6.example', origin: 'https://b6.example', 'x-forwarded-proto': 'https' } : { host: '127.0.0.1:17864', origin: 'http://127.0.0.1:17864' }, base = remote ? '/console/' : '/';
    await expect(app.injectWS(base + 'ws', { headers })).rejects.toThrow('401');
    await expect(app.injectWS(base + 'ws', { headers: { ...headers, origin: 'https://wrong.example' } })).rejects.toThrow('403');
    const pair = await app.inject({ method: 'POST', url: base + 'auth/pair', headers, payload: { code: trust.createPairing().code, label: 'B6 fixture' } });
    const cookie = [pair.headers['set-cookie']].flat()[0]!.split(';')[0], socket = await app.injectWS(base + 'ws', { headers: { ...headers, cookie } });
    const received: unknown[] = []; socket.on('message', value => received.push(value));
    socket.send(JSON.stringify({ id: 'extensions', method: 'bridge/extensions', params: {} }));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    trust.revoke(pair.json().device.id);
    const closed = once(socket, 'close'); finish({}); await closed;
    expect(received).toEqual([]);
    await expect(app.injectWS(base + 'ws', { headers: { ...headers, cookie } })).rejects.toThrow('401');
  } finally { finish({}); await app.close(); trust.close(); rmSync(dir, { recursive: true, force: true }); }
});
