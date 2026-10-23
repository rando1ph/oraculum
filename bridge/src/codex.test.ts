import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ spawn: vi.fn(), execFileSync: vi.fn() }));
vi.mock('node:child_process', () => native);
import { Codex, NativeRpcError } from './codex';
import { BridgeService } from './service';
import { ReceiptStore } from './receipts';
import { readHistory } from './history';
import { CodexCompatibilityError } from './compatibility';
import type { Thread } from '../../packages/shared/protocol';

beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('ORACULUM_CODEX_BIN', undefined); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

const thread = { id: 'thread-a', cwd: '/native-project', preview: '', turns: [], status: { type: 'idle' } };
const started = { thread, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly' } };

const replies: Record<string, unknown> = {
  initialize: { userAgent: 'test-app-server' },
  'config/read': { config: { model: null, model_provider: null, model_reasoning_effort: null } },
  'model/list': { data: [], nextCursor: null },
  'thread/list': { data: [], nextCursor: null },
};
function mockCodex(version: string, overrides: Record<string, unknown> = {}) {
  const sent: any[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  child.stdin.on('finish', () => child.emit('exit', 0));
  child.stdin.on('data', data => {
    const message = JSON.parse(String(data));
    sent.push(message);
    if (message.id !== undefined) queueMicrotask(() => {
      const result = Object.hasOwn(overrides, message.method) ? overrides[message.method] : replies[message.method];
      child.stdout.write(JSON.stringify({ id: message.id, ...(result && typeof result === 'object' && 'error' in result ? result : { result }) }) + '\n');
    });
  });
  native.execFileSync.mockReturnValue(version + '\n');
  native.spawn.mockReturnValue(child);
  return { codex: new Codex('/native-project'), sent, child };
}

it.each(['codex-cli 0.160.0', 'codex-cli 0.161.0', 'codex-cli 1.0.0-preview.2'])('initializes compatible %s using only read-only compatibility probes', async version => {
  const { codex, sent } = mockCodex(version);
  try {
    await codex.initialize();
    expect(sent.map(message => message.method)).toEqual(['initialize', 'initialized', 'config/read', 'model/list', 'thread/list']);
    expect(codex.version).toBe(version);
    expect(sent[0].params.capabilities).toEqual({ experimentalApi: false });
    expect(sent[2].params.cwd).toBe('/native-project');
    expect(sent[4].params.cwd).toBe('/native-project');
  } finally { await codex.close(); }
});

it.each(['initialize', 'config/read', 'model/list', 'thread/list'])('reports missing required %s with actual runtime and method, without retries', async method => {
  const { codex, sent } = mockCodex('codex-cli 0.161.0', { [method]: { error: { code: -32601, message: 'Method not found' } } });
  try {
    await expect(codex.initialize()).rejects.toThrow(`codex-cli 0.161.0: ${method}: Method not found`);
    expect(sent.filter(message => message.method === method)).toHaveLength(1);
  } finally { await codex.close(); }
});

it('rejects incompatible required response fields rather than trusting TypeScript casts', async () => {
  const { codex } = mockCodex('codex-cli 0.160.0', { 'model/list': { data: null, nextCursor: null } });
  try { await expect(codex.initialize()).rejects.toThrow(/model\/list.*data/); }
  finally { await codex.close(); }
});

it('accepts additive fields and a dynamically named model without schema equality', async () => {
  const { codex } = mockCodex('codex-cli 9.0.0', {
    initialize: { userAgent: 'new-server', newCapability: true },
    'model/list': { data: [{ id: 'future', model: 'new-model', displayName: 'New model', supportedReasoningEfforts: [{ reasoningEffort: 'adaptive' }], newMetadata: {} }], nextCursor: null, additional: 1 },
    'thread/list': { data: [{ ...thread, additional: 1 }], nextCursor: null },
  });
  try { await expect(codex.initialize()).resolves.toMatchObject({ userAgent: 'new-server' }); }
  finally { await codex.close(); }
});

it.each([
  ['initialize', {}, 'userAgent'],
  ['config/read', { config: { model: {}, model_provider: null, model_reasoning_effort: null } }, 'config.model'],
  ['model/list', { data: [{ id: 'm', model: 'm', displayName: 'M', supportedReasoningEfforts: null }], nextCursor: null }, 'supportedReasoningEfforts'],
  ['thread/list', { data: [{ ...thread, cwd: null }], nextCursor: null }, 'cwd'],
  ['thread/start', { ...started, sandbox: null }, 'sandbox'],
  ['thread/resume', { ...started, thread: { ...thread, turns: null } }, 'turns'],
  ['thread/read', { thread: { ...thread, status: { type: 'active' } } }, 'activeFlags'],
  ['turn/start', { turn: { id: 'turn-a', status: 'futureState', items: [] } }, 'status'],
  ['thread/turns/list', { data: [{ id: 'turn-a', status: 'completed', items: null }], nextCursor: null }, 'items'],
  ['thread/items/list', { data: [{ turnId: 'turn-a', item: { id: 'item-a' } }], nextCursor: null }, 'type'],
] as const)('rejects an incompatible %s response at its consumed field', async (method, response, field) => {
  const { codex } = mockCodex('codex-cli 0.161.0', { [method]: response });
  try { await expect(codex.request(method, {})).rejects.toThrow(field); }
  finally { await codex.close(); }
});

it.each([
  { turn: { status: 'inProgress', items: [] } },
  { error: { code: 'invalid', message: 'malformed error' } },
  { error: { code: -32602, message: 'ambiguous' }, result: {} },
])('keeps ambiguous turn responses unknown and blocks resend', async response => {
  const { codex, sent } = mockCodex('codex-cli 0.161.0', { 'thread/start': started, 'turn/start': response });
  const db = new DatabaseSync(':memory:');
  const receipts = new ReceiptStore(db);
  const service = new BridgeService(codex, '/native-project', receipts);
  const operationId = randomUUID();
  try {
    await codex.initialize();
    await service.dispatch('thread/start', {});
    await expect(service.dispatch('turn/start', { threadId: thread.id, text: 'hello', operationId }, { deviceId: 'device-a' })).rejects.toBeInstanceOf(CodexCompatibilityError);
    expect(receipts.list(thread.cwd, thread.id)[0]).toMatchObject({ status: 'unknown', turnId: null });
    await expect(service.dispatch('turn/start', { threadId: thread.id, text: 'hello', operationId }, { deviceId: 'device-a' })).rejects.toThrow(/unknown/);
    expect(sent.filter(message => message.method === 'turn/start')).toHaveLength(1);
  } finally { await codex.close(); db.close(); }
});

it('preserves native method-not-found codes and the existing read-only history fallback', async () => {
  const { codex, sent } = mockCodex('codex-cli 0.161.0', {
    'thread/turns/list': { error: { code: -32601, message: 'Method not found' } }, 'thread/read': { thread },
  });
  try {
    await expect(codex.request('thread/turns/list', {})).rejects.toBeInstanceOf(NativeRpcError);
    expect((await readHistory(codex, thread as unknown as Thread)).history?.source).toBe('native-read');
    expect(sent.filter(message => message.method === 'thread/read')).toHaveLength(1);
  } finally { await codex.close(); }
});

it('uses an explicit executable unchanged for both version discovery and runtime launch', async () => {
  vi.stubEnv('ORACULUM_CODEX_BIN', '/installation/bin/codex');
  const { codex } = mockCodex('codex-cli 0.161.0');
  try {
    await codex.initialize();
    expect(native.execFileSync.mock.calls[0][0]).toBe('/installation/bin/codex');
    expect(native.spawn.mock.calls[0][0]).toBe('/installation/bin/codex');
    expect(native.spawn.mock.calls[0][2]).not.toHaveProperty('env');
  } finally { await codex.close(); }
});

it('rejects ambiguous relative executable configuration before launching', () => {
  vi.stubEnv('ORACULUM_CODEX_BIN', './codex');
  expect(() => new Codex('/native-project')).toThrow(/absolute/);
  expect(native.spawn).not.toHaveBeenCalled();
  expect(native.execFileSync).not.toHaveBeenCalled();
});

it('reports missing executables and invalid version responses without spawning the app server', () => {
  native.execFileSync.mockImplementationOnce(() => { throw new Error('ENOENT'); });
  expect(() => new Codex('/native-project')).toThrow(/ORACULUM_CODEX_BIN or PATH/);
  native.execFileSync.mockReturnValueOnce('\n');
  expect(() => new Codex('/native-project')).toThrow(/invalid version response/);
  expect(native.spawn).not.toHaveBeenCalled();
});

it('does not resend a native operation after a response timeout', async () => {
  vi.useFakeTimers();
  const { codex, child } = mockCodex('codex-cli 0.161.0');
  child.stdin.removeAllListeners('data');
  const writes: string[] = [];
  child.stdin.on('data', data => writes.push(String(data)));
  try {
    const rejected = expect(codex.request('turn/start', {})).rejects.toThrow(/result unknown, do not retry automatically/);
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(writes).toHaveLength(1);
  } finally { await codex.close(); }
});

it('inherits native configuration and environment without rewriting feature or MCP settings', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  child.stdin.on('finish', () => child.emit('exit', 0));
  native.execFileSync.mockReturnValueOnce('codex-cli 0.160.0\n').mockReturnValue('[]');
  native.spawn.mockReturnValue(child);
  const codex = new Codex('/native-project');
  try {
    expect(native.execFileSync).toHaveBeenCalledExactlyOnceWith('codex', ['--version'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
    expect(native.spawn).toHaveBeenCalledExactlyOnceWith('codex', ['app-server', '--listen', 'stdio://'], {
      cwd: '/native-project', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } finally { await codex.close(); }
});
