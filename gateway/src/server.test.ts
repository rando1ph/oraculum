import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { GatewayStore, randomCredential } from './store';
import { GatewayService, type ServiceOptions } from './service';
import { createGatewayServer } from './server';
import { CodexError, type CodexAdapter, type NativeThread, type NativeTurn, type RpcId } from './codex';
import type { GatewayConfig } from './config';
import { validateContract } from '../../packages/gateway-protocol/src/index';

// This adapter deliberately models only official App Server methods used by the
// HTTP service. It records dispatch counts to catch retries hidden behind HTTP.
class MockCodex extends EventEmitter {
  alive = true;
  paginated = false;
  startFailure: CodexError | undefined;
  turnFailure: CodexError | undefined;
  nativeThreads = new Map<string, NativeThread>();
  calls = { startThread: 0, resumeThread: 0, startTurn: 0, interruptTurn: 0, respond: 0, reject: 0 };
  responses: { id: RpcId; response: unknown }[] = [];
  async listModels() { return { data: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null }; }
  async startThread(input: { cwd: string }) {
    this.calls.startThread++;
    if (this.startFailure) throw this.startFailure;
    const thread: NativeThread = { id: `native-thread-${this.calls.startThread}`, cwd: input.cwd, preview: '', status: { type: 'idle' }, turns: [], model: 'fixture' };
    this.nativeThreads.set(thread.id, thread);
    return { thread: structuredClone(thread) };
  }
  async readThread(id: string) {
    const thread = this.nativeThreads.get(id);
    if (!thread) throw new CodexError('NATIVE_REJECTED', 'Missing fixture thread', 'rejected');
    return { thread: structuredClone(thread) };
  }
  async listThreads(input: { cwd: string }) { return { data: [...this.nativeThreads.values()].filter(thread => thread.cwd === input.cwd).map(thread => structuredClone(thread)), nextCursor: null }; }
  async resumeThread(id: string) { this.calls.resumeThread++; return this.readThread(id); }
  async startTurn(input: { threadId: string }) {
    this.calls.startTurn++;
    if (this.turnFailure) throw this.turnFailure;
    const turn: NativeTurn = { id: `native-turn-${this.calls.startTurn}`, status: 'inProgress', items: [] };
    this.nativeThreads.get(input.threadId)!.turns.push(turn);
    this.nativeThreads.get(input.threadId)!.status = { type: 'active' };
    return { turn: structuredClone(turn) };
  }
  async interruptTurn(threadId: string, turnId: string) {
    this.calls.interruptTurn++;
    const turn = this.nativeThreads.get(threadId)!.turns.find(turn => turn.id === turnId)!;
    turn.status = 'interrupted';
    this.nativeThreads.get(threadId)!.status = { type: 'idle' };
    this.emit('notification', { method: 'turn/completed', params: { threadId, turn } });
    return {};
  }
  async listTurns(input: { threadId: string }) {
    if (!this.paginated) throw new CodexError('NATIVE_PAGINATION_UNSUPPORTED', 'Fixture storage uses native read', 'rejected');
    return { data: structuredClone(this.nativeThreads.get(input.threadId)!.turns).reverse(), nextCursor: null };
  }
  async listItems(input: { threadId: string; turnId: string }) {
    return { data: structuredClone(this.nativeThreads.get(input.threadId)!.turns.find(turn => turn.id === input.turnId)!.items).reverse().map(item => ({ turnId: input.turnId, item })), nextCursor: null };
  }
  async respondRequest(id: RpcId, response: unknown) { this.calls.respond++; this.responses.push({ id, response }); }
  async rejectRequest() { this.calls.reject++; }
  async close() { this.alive = false; }
}

type Json = Record<string, any>; // Test assertions inspect heterogeneous protocol envelopes.
type Device = { deviceId: string; deviceCredential: string; installationId: string; accessToken: string };
type Running = Awaited<ReturnType<typeof setup>>;
const cleanups: (() => Promise<void>)[] = [];

async function availablePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); return port;
}

async function setup(options: { basePath?: string; externalOrigin?: string; serviceOptions?: ServiceOptions } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'oraculum-gateway-http-'));
  const workspaces = join(root, 'workspaces'); const projectPath = join(workspaces, 'dedicated-project');
  mkdirSync(projectPath, { recursive: true, mode: 0o700 });
  writeFileSync(join(projectPath, 'hello.txt'), 'isolated host result\n');
  writeFileSync(join(projectPath, 'secret.env'), 'must stay hidden');
  const store = new GatewayStore(join(root, 'state'), { create: true });
  const config: GatewayConfig = { configVersion: 2, stateDir: store.stateDir, host: '127.0.0.1', port: await availablePort(), basePath: options.basePath ?? '/', externalOrigin: options.externalOrigin ?? null, allowedRoots: [{ id: 'test-root', path: workspaces }], codexCommand: 'unused-fixture' };
  const codex = new MockCodex(); const service = new GatewayService(store, config, codex as unknown as CodexAdapter, options.serviceOptions);
  const app = await createGatewayServer(service, config); await app.listen({ host: config.host, port: config.port });
  const origin = `http://127.0.0.1:${config.port}`; const api = `${origin}${config.basePath}api/v2`;
  const sockets: WebSocket[] = [];
  const request = async (path: string, options: { method?: string; body?: unknown; device?: Device; headers?: Record<string, string>; raw?: Buffer } = {}) => {
    const body=options.raw??(options.body===undefined?undefined:Buffer.from(JSON.stringify(options.body)));
    const response = await new Promise<{status:number;headers:Headers;text:string}>((resolve,reject)=>{
      const req=httpRequest(new URL(api+path),{method:options.method??(body?'POST':'GET'),headers:{
        'x-oraculum-protocol':'2',...(options.device?{Authorization:`Bearer ${options.device.accessToken}`} : {}),
        ...(options.body===undefined?{}:{'Content-Type':'application/json'}),...(body?{'content-length':String(body.length)}:{}),...options.headers,
      }},res=>{const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(Buffer.from(chunk)));res.once('error',reject);res.once('end',()=>{
        const headers=new Headers();for(const [name,value] of Object.entries(res.headers)) if(value!==undefined) headers.set(name,Array.isArray(value)?value.join(','):value);
        resolve({status:res.statusCode!,headers,text:Buffer.concat(chunks).toString('utf8')});
      });});req.once('error',reject);req.end(body);
    });
    let json:Json={};try{json=JSON.parse(response.text);}catch{}
    return {...response,json};
  };
  const pair = async (): Promise<Device> => {
    const pending = { deviceId: randomUUID(), deviceCredential: randomCredential(), installationId: store.installationId };
    const result = await request('/auth/pair', { body: { ...pending, code: store.createPairing().code, label: 'HTTP测试设备' } });
    expect(result.status, result.text).toBe(200); expect(validateContract('AuthResponse', result.json)).toBe(true);
    return { ...pending, accessToken: result.json.accessToken };
  };
  const connect = async (device: Device) => {
    const socket = new WebSocket(api.replace(/^http/, 'ws') + '/events', { headers: { Authorization: `Bearer ${device.accessToken}`, 'x-oraculum-protocol': '2' } });
    sockets.push(socket); const messages: Json[] = []; const arrivals = new EventEmitter();
    socket.on('message', bytes => { messages.push(JSON.parse(bytes.toString())); arrivals.emit('message'); });
    await once(socket, 'open');
    const waitFor = async (predicate: (message: Json) => boolean, timeout = 3000): Promise<Json> => {
      const found = messages.find(predicate); if (found) return found;
      return new Promise((done, reject) => {
        const timer = setTimeout(() => { arrivals.off('message', check); reject(new Error(`WS message timeout; saw ${messages.map(message => message.kind ?? message.type).join(', ')}`)); }, timeout);
        const check = () => { const found = messages.find(predicate); if (found) { clearTimeout(timer); arrivals.off('message', check); done(found); } };
        arrivals.on('message', check);
      });
    };
    return { socket, messages, waitFor };
  };
  const result = { root, projectPath, store, config, codex, service, app, origin, api, sockets, request, pair, connect };
  cleanups.push(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close(); await service.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }); return result;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function register(f: Running, device: Device) {
  const operationId = randomUUID(); const result = await f.request('/projects', { device, body: { operationId, rootId: 'test-root', path: 'dedicated-project' } });
  expect(result.status, result.text).toBe(200); expect(result.json.operation.status).toBe('accepted');
  const projects = await f.request('/projects', { device }); expect(projects.status, projects.text).toBe(200);
  return projects.json.data.projects[0].id as string;
}
async function start(f: Running, device: Device, projectId: string) {
  const operationId = randomUUID(); const result = await f.request(`/projects/${projectId}/threads`, { device, body: { operationId, expectedEpoch: f.service.epoch, permissionPreset: 'read-only' } });
  expect(result.status, result.text).toBe(200); expect(result.json.operation.status).toBe('accepted');
  return result.json.operation.nativeThreadId as string;
}
const writeBody = (f: Running, projectId: string) => ({ operationId: randomUUID(), projectId, expectedEpoch: f.service.epoch });

describe('Gateway HTTP authentication and endpoint boundaries', () => {
  it('pairs, renews after a discarded ACK, and exposes only minimal unauthenticated health', async () => {
    const f = await setup(); const health = await fetch(f.origin + '/health'); const publicHealth = await health.json();
    expect(publicHealth).toEqual({ status: 'ok', protocolMajor: 2, installationId: f.store.installationId });
    const device = await f.pair(); const renewed = await f.request('/auth/token', { body: { deviceId: device.deviceId, deviceCredential: device.deviceCredential, installationId: device.installationId } });
    expect(renewed.status).toBe(200); expect(renewed.json.accessToken).not.toBe(device.accessToken);
    expect((await f.request('/auth/session', { device })).json.data.deviceId).toBe(device.deviceId);
    expect((await f.request('/auth/session', { device: { ...device, accessToken: renewed.json.accessToken } })).status).toBe(200);
    const anonymous = await f.request('/projects'); expect(anonymous.status).toBe(401); expect(anonymous.text).not.toContain(f.root);
    expect(renewed.headers.get('cache-control')).toBe('no-store');
  });

  it('enforces Host, explicit Origin, Base Path and protocol without trusting forwarding headers', async () => {
    const f = await setup({ basePath: '/test-gateway/', externalOrigin: 'https://gateway.example.invalid' }); const device = await f.pair();
    expect((await f.request('/capabilities', { device })).status).toBe(200);
    expect((await f.request('/capabilities', { device, headers: { Host: 'attacker.invalid', 'x-forwarded-proto': 'https' } })).status).toBe(403);
    expect((await f.request('/capabilities', { device, headers: { Origin: 'https://attacker.invalid' } })).status).toBe(403);
    expect((await f.request('/capabilities', { device, headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await f.request('/capabilities', { device, headers: { 'x-oraculum-protocol': '1' } })).status).toBe(409);
    expect((await f.request('/capabilities', { device, headers: { Host: 'gateway.example.invalid' } })).status).toBe(403);
    expect((await f.request('/capabilities', { device, headers: { Host: 'gateway.example.invalid', 'x-forwarded-proto': 'https', Origin: 'https://gateway.example.invalid' } })).status).toBe(200);
    expect((await fetch(f.origin + '/health')).status).toBe(404);
    expect((await f.request('/capabilities?access_token=synthetic', { device })).status).toBe(400);
  });

  it('has no arbitrary RPC, Web UI, themes or credential-bearing websocket subprotocol channel', async () => {
    const f = await setup(); const device = await f.pair();
    for (const path of ['/', '/index.html', '/themes/default.css']) expect((await fetch(f.origin + path)).status).toBe(404);
    for (const path of ['/rpc', '/commands', '/plugins/install']) expect((await f.request(path, { device, body: { method: 'command/exec', params: { command: 'touch forbidden' } } })).status).toBe(404);
    expect((await f.request('/capabilities', { device, headers: { 'sec-websocket-protocol': 'synthetic-secret' } })).status).toBe(400);
    const ws = await f.connect(device); const closed = once(ws.socket, 'close');
    ws.socket.send(JSON.stringify({ method: 'turn/start', params: {} })); await closed;
    expect(f.codex.calls.startTurn).toBe(0);
  });
});

describe('Gateway native core HTTP/WSS loop', () => {
  it('registers, starts/resumes a native thread, streams events, snapshots and interrupts without duplicate dispatch', async () => {
    const f = await setup(); const device = await f.pair(); const projectId = await register(f, device); const ws = await f.connect(device);
    ws.socket.send(JSON.stringify({ type: 'resume', epoch: f.service.epoch, afterSeq: 0 })); await ws.waitFor(message => message.type === 'connection');
    const threadId = await start(f, device, projectId);
    const resume = await f.request(`/threads/${threadId}/resume`, { device, body: writeBody(f, projectId) }); expect(resume.status, resume.text).toBe(200);
    const body = { ...writeBody(f, projectId), input: [{ type: 'text', text: 'isolated fixture prompt' }] };
    const turn = await f.request(`/threads/${threadId}/turns`, { device, body }); expect(turn.status, turn.text).toBe(200); const turnId = turn.json.operation.nativeTurnId;
    const duplicate = await f.request(`/threads/${threadId}/turns`, { device, body }); expect(duplicate.status).toBe(409); expect(duplicate.json.error.code).toBe('OPERATION_ALREADY_RECORDED'); expect(f.codex.calls.startTurn).toBe(1);
    f.codex.emit('notification', { method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'item-1', delta: 'hello' } });
    await f.service.settled(); const delta = await ws.waitFor(message => message.kind === 'item.delta'); expect(delta.payload.delta).toBe('hello'); expect(validateContract('EventEnvelope', delta)).toBe(true);
    const activeSnapshot = await f.request(`/threads/${threadId}/snapshot`, { device, body: { projectId } }); expect(activeSnapshot.status, activeSnapshot.text).toBe(200); expect(activeSnapshot.json.data.synchronization).toBe('synchronizing');
    const item = { id: 'item-1', type: 'agentMessage', text: 'hello final' }; f.codex.nativeThreads.get(threadId)!.turns[0]!.items = [item];
    f.codex.emit('notification', { method: 'item/completed', params: { threadId, turnId, item } }); await f.service.settled(); expect((await ws.waitFor(message => message.kind === 'item.completed')).payload.item.data.text).toBe('hello final');
    const stopped = await f.request(`/threads/${threadId}/turns/${turnId}/interrupt`, { device, body: writeBody(f, projectId) }); expect(stopped.status, stopped.text).toBe(200); expect(f.codex.calls.interruptTurn).toBe(1);
    await f.service.settled(); const snapshot = await f.request(`/threads/${threadId}/snapshot`, { device, body: { projectId } }); expect(snapshot.status, snapshot.text).toBe(200); expect(snapshot.json.data.history.items[0].items[0].text).toBe('hello final'); expect(snapshot.json.data.synchronization).toBe('current');
    const details=await f.request(`/threads/${threadId}/history/details`,{device,body:{projectId,turnId,itemId:'item-1'}});
    expect(details.status,details.text).toBe(200);expect(validateContract('ItemDetails',details.json.data)).toBe(true);
    expect(JSON.parse(Buffer.from(details.json.data.chunk,'base64').toString('utf8')).text).toBe('hello final');
    expect((await f.request(`/operations/${body.operationId}`, { device })).json.data.status).toBe('accepted');
    const listed = await f.request(`/projects/${projectId}/threads?limit=5`, { device }); expect(listed.status, listed.text).toBe(200); expect(listed.json.data.threads[0].id).toBe(threadId);
    expect(f.codex.calls.resumeThread).toBe(1);
  });

  it('publishes a valid contract when native history pagination is supported', async () => {
    const f = await setup(); f.codex.paginated = true; const device = await f.pair(); const projectId = await register(f, device); const threadId = await start(f, device, projectId);
    const page = await f.request(`/threads/${threadId}/history/query`, { device, body: { projectId, limit: 5 } });
    expect(page.status, page.text).toBe(200); expect(page.json.data.source).toBe('native-pagination'); expect(validateContract('HistoryPage', page.json.data)).toBe(true);
  });

  it('replays events exactly from a device cursor and resets a stale epoch', async () => {
    const f = await setup(); const device = await f.pair(); const projectId = await register(f, device); const threadId = await start(f, device, projectId); const first = await f.connect(device);
    first.socket.send(JSON.stringify({ type: 'resume', epoch: f.service.epoch, afterSeq: 0 })); await first.waitFor(message => message.type === 'connection');
    f.codex.emit('notification', { method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn', itemId: 'one', delta: 'one' } }); await f.service.settled(); const initial = await first.waitFor(message => message.kind === 'item.delta');
    first.socket.close(); await once(first.socket, 'close');
    f.codex.emit('notification', { method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn', itemId: 'two', delta: 'two' } }); await f.service.settled();
    const next = await f.connect(device); next.socket.send(JSON.stringify({ type: 'resume', epoch: f.service.epoch, afterSeq: initial.seq })); const replay = await next.waitFor(message => message.kind === 'item.delta'); expect(replay.payload.delta).toBe('two'); expect(replay.seq).toBe(initial.seq + 1);
    const oldEpoch = f.service.epoch; f.codex.emit('unavailable'); const reset = await f.connect(device); reset.socket.send(JSON.stringify({ type: 'resume', epoch: oldEpoch, afterSeq: replay.seq })); expect((await reset.waitFor(message => message.type === 'connection')).resetRequired).toBe(true);
  });

  it('keeps private receipts off the other device feed and prevents cross-project native reads', async () => {
    const f = await setup(); const a = await f.pair(); const b = await f.pair(); const projectId = await register(f, a); const first = await f.connect(a); const second = await f.connect(b);
    for (const ws of [first, second]) { ws.socket.send(JSON.stringify({ type: 'resume', epoch: f.service.epoch, afterSeq: 0 })); await ws.waitFor(message => message.type === 'connection'); }
    const operationId = randomUUID(); const result = await f.request(`/projects/${projectId}/threads`, { device: a, body: { operationId, expectedEpoch: f.service.epoch } }); expect(result.status).toBe(200);
    await first.waitFor(message => message.kind === 'operation.changed'); expect(second.messages.some(message => message.kind === 'operation.changed')).toBe(false);
    expect((await f.request(`/operations/${operationId}`, { device: b })).status).toBe(404);
    f.codex.nativeThreads.set('foreign', { id: 'foreign', cwd: '/unregistered/project', status: { type: 'idle' }, preview: '', turns: [] });
    expect((await f.request(`/projects/${projectId}/threads/foreign`, { device: a })).status).toBe(403);
  });
});

describe('HTTP delivery fault injection and workspace barriers', () => {
  it('does not dispatch when the receipt transaction fails before reservation', async () => {
    const f = await setup(); const device = await f.pair(); const projectId = await register(f, device);
    const operationId = randomUUID(), reserve = f.store.reserveOperation.bind(f.store);
    f.store.reserveOperation = input => { if (input.operationId === operationId) throw new Error('injected SQLite failure'); return reserve(input); };
    const result = await f.request(`/projects/${projectId}/threads`, { device, body: {operationId, expectedEpoch:f.service.epoch} });
    expect(result.status).toBeGreaterThanOrEqual(500); expect(f.codex.calls.startThread).toBe(0);
    expect((await f.request(`/operations/${operationId}`, {device})).status).toBe(404);
  });

  it('blocks a new device and project re-registration after an unknown thread/start, while reads remain available', async () => {
    const f = await setup(); const first = await f.pair(); const second = await f.pair(); const projectId = await register(f, first); f.codex.startFailure = new CodexError('NATIVE_TIMEOUT', 'ACK lost', 'unknown');
    const operationId = randomUUID(); const unknown = await f.request(`/projects/${projectId}/threads`, { device: first, body: { operationId, expectedEpoch: f.service.epoch } });
    expect(unknown.status, unknown.text).toBe(202); expect(unknown.json.operation.status).toBe('unknown');
    const blocked = await f.request(`/projects/${projectId}/threads`, { device: second, body: { operationId: randomUUID(), expectedEpoch: f.service.epoch } }); expect(blocked.status).toBe(409); expect(blocked.json.error.code).toBe('OPERATION_UNKNOWN'); expect(blocked.text).not.toContain(operationId);
    expect((await f.request(`/projects/${projectId}`, { device: second, method: 'DELETE', body: { operationId: randomUUID() } })).status).toBe(409);
    expect((await f.request(`/projects/${projectId}/threads`, { device: second })).status).toBe(200); expect(f.codex.calls.startThread).toBe(1);
  });

  it('preserves an explicit native rejection and allows a different user intent afterward', async () => {
    const f = await setup(); const device = await f.pair(); const projectId = await register(f, device); f.codex.startFailure = new CodexError('INVALID_NATIVE_ARGUMENT', 'Invalid native arguments', 'rejected');
    const rejected = await f.request(`/projects/${projectId}/threads`, { device, body: { operationId: randomUUID(), expectedEpoch: f.service.epoch } }); expect(rejected.json.operation.status).toBe('rejected');
    f.codex.startFailure = undefined; await start(f, device, projectId); expect(f.codex.calls.startThread).toBe(2);
  });
});

describe('HTTP file and attachment authorization', () => {
  it('browses authorized files, binds file grants to the device and rejects changed or sensitive paths', async () => {
    const f = await setup(); const first = await f.pair(); const second = await f.pair(); const projectId = await register(f, first);
    const files = await f.request(`/projects/${projectId}/files/query`, { device: first, body: {} }); expect(files.status, files.text).toBe(200); expect(files.json.data.entries.map((item: Json) => item.name)).toEqual(['hello.txt']);
    const selected = await f.request(`/projects/${projectId}/files/select`, { device: first, body: { path: 'hello.txt' } }); expect(selected.status, selected.text).toBe(200); const fileId = selected.json.data.fileId;
    const downloaded = await f.request(`/files/${fileId}/content`, { device: first }); expect(downloaded.status).toBe(200); expect(downloaded.text).toBe('isolated host result\n'); expect(downloaded.headers.get('content-disposition')).toContain('attachment');
    expect((await f.request(`/files/${fileId}/content`, { device: second })).status).toBe(409);
    for (const path of ['../outside.txt', '/etc/passwd', 'secret.env', '.codex/auth.json', 'hello%2ftxt']) expect((await f.request(`/projects/${projectId}/files/select`, { device: first, body: { path } })).status).toBeGreaterThanOrEqual(400);
    writeFileSync(join(f.projectPath, 'hello.txt'), 'different version'); expect((await f.request(`/files/${fileId}/content`, { device: first })).status).toBe(409);
  });

  it('uploads with bounded metadata, retrieves the lost-ACK attachment receipt and prevents cross-device use', async () => {
    const f = await setup(); const first = await f.pair(); const second = await f.pair(); const projectId = await register(f, first); const threadId = await start(f, first, projectId);
    const bytes = Buffer.from('a fixture document\n'); const meta = { operationId: randomUUID(), projectId, threadId, draftId: '12345678-1234-4123-8123-123456789abc', name: 'notes.txt', mime: 'text/plain', size: bytes.length };
    const headers = { 'content-type': 'application/octet-stream', 'x-oraculum-upload': Buffer.from(JSON.stringify(meta)).toString('base64url') };
    const upload = await f.request(`/threads/${threadId}/attachments`, { device: first, raw: bytes, headers }); expect(upload.status, upload.text).toBe(200); expect(upload.json.operation.status,upload.text).toBe('accepted');
    const receipt = await f.request(`/operations/${meta.operationId}`, { device: first }); expect(receipt.status).toBe(200); expect(receipt.json.data.attachment.name).toBe('notes.txt'); const attachmentId = receipt.json.data.attachment.id;
    const duplicate = await f.request(`/threads/${threadId}/attachments`, { device: first, raw: bytes, headers }); expect(duplicate.status).toBe(409);
    expect((await f.request(`/operations/${meta.operationId}`, { device: second })).status).toBe(404);
    const stealing = await f.request(`/threads/${threadId}/turns`, { device: second, body: { ...writeBody(f, projectId), input: [{ type: 'text', text: 'fixture' }], draftId: '12345678-1234-4123-8123-123456789abc', attachmentIds: [attachmentId] } }); expect(stealing.status).toBeGreaterThanOrEqual(400); expect(f.codex.calls.startTurn).toBe(0);
    const good = await f.request(`/threads/${threadId}/turns`, { device: first, body: { ...writeBody(f, projectId), input: [{ type: 'text', text: 'fixture' }], draftId: '12345678-1234-4123-8123-123456789abc', attachmentIds: [attachmentId] } }); expect(good.status, good.text).toBe(200); expect(f.codex.calls.startTurn).toBe(1);
    const badMetadata = Buffer.from(JSON.stringify({ ...meta, operationId: randomUUID(), absolutePath: '/tmp/forbidden' })).toString('base64url');
    expect((await f.request(`/threads/${threadId}/attachments`, { device: first, raw: bytes, headers: { ...headers, 'x-oraculum-upload': badMetadata } })).status).toBe(400);
  });

  it('revokes HTTP, existing websocket and previously granted file access from a separate CLI store', async () => {
    const f = await setup(); const device = await f.pair(); const projectId = await register(f, device);
    const selected = await f.request(`/projects/${projectId}/files/select`, { device, body: { path: 'hello.txt' } }); const ws = await f.connect(device); ws.socket.send(JSON.stringify({ type: 'resume', epoch: f.service.epoch, afterSeq: 0 })); await ws.waitFor(message => message.type === 'connection');
    const closed = once(ws.socket, 'close'); const cliStore = new GatewayStore(f.store.stateDir); cliStore.revokeDevice(device.deviceId); cliStore.close();
    expect((await f.request('/capabilities', { device })).status).toBeGreaterThanOrEqual(401); expect((await f.request(`/files/${selected.json.data.fileId}/content`, { device })).status).toBeGreaterThanOrEqual(401);
    const [code] = await closed; expect(code).toBe(1008);
  });
});

describe('native interaction responses through HTTP', () => {
  it('rejects stale generations and sends only one native response when paired devices race', async () => {
    const f = await setup(); const first = await f.pair(); const second = await f.pair(); const projectId = await register(f, first); const threadId = await start(f, first, projectId);
    f.codex.emit('request', { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'turn-fixture', itemId: 'command-fixture', command: 'printf isolated', cwd: f.projectPath, availableDecisions: ['accept', 'decline', 'cancel'] } }); await f.service.settled();
    const interaction = f.service.interactions.list(projectId, threadId)[0]!; expect(interaction).toBeDefined();
    const body = { operationId: randomUUID(), projectId, epoch: f.service.epoch, generation: interaction.generation + 1, response: { type: 'approval', decision: 'decline' } };
    const stale = await f.request(`/interactions/${interaction.interactionId}/response`, { device: first, body }); expect(stale.json.operation?.status ?? stale.status).toBe('rejected'); expect(f.codex.calls.respond).toBe(0);
    const responses = await Promise.all([first, second].map(device => f.request(`/interactions/${interaction.interactionId}/response`, { device, body: { ...body, operationId: randomUUID(), generation: interaction.generation } })));
    expect(f.codex.calls.respond).toBe(1); expect(responses.filter(response => response.json.operation?.status === 'unknown')).toHaveLength(1); expect(responses.filter(response => response.json.operation?.status === 'rejected' || response.status === 409)).toHaveLength(1);
    expect(f.codex.responses[0]).toEqual({ id: 7, response: { decision: 'decline' } });
    f.codex.emit('notification',{method:'serverRequest/resolved',params:{threadId,requestId:7}}); await f.service.settled();
    const winner=responses.find(response=>response.json.operation?.status==='unknown')!;
    const actor=responses[0]===winner?first:second;
    expect((await f.request(`/operations/${winner.json.operation.operationId}`,{device:actor})).json.data.status).toBe('accepted');
    expect(f.store.hasUnknownOperation(projectId,threadId)).toBe(false);
  });
});

describe('HTTP resource budgets and download integrity', () => {
  it('limits unresumed websocket connections before subscription', async () => {
    const f = await setup(); const device = await f.pair();
    for(let i=0;i<4;i++) await f.connect(device);
    const extra = new WebSocket(f.api.replace(/^http/, 'ws') + '/events', {headers:{Authorization:`Bearer ${device.accessToken}`,'x-oraculum-protocol':'2'}});
    f.sockets.push(extra);
    const closed = once(extra,'close');
    await closed;
    expect(extra.readyState).toBe(WebSocket.CLOSED);
  });
  it('sends the digest of the exact authorized file version', async () => {
    const f=await setup(), device=await f.pair(), projectId=await register(f,device);
    const selection=await f.request(`/projects/${projectId}/files/select`,{device,body:{path:'hello.txt'}});
    const download=await f.request(`/files/${selection.json.data.fileId}/content`,{device});
    const {createHash}=await import('node:crypto');
    expect(download.headers.get('content-digest')).toBe(`sha-256=:${createHash('sha256').update(download.text).digest('base64')}:`);
  });
});
