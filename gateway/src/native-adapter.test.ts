import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexAdapter } from './codex';

const fixture = resolve('gateway/test/fixtures/fake-codex.mjs');
const adapters: CodexAdapter[] = [], directories: string[] = [];
async function setup(mode = 'normal', options: { readTimeoutMs?: number; writeTimeoutMs?: number; maxPending?: number } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'oraculum-native-capabilities-')); directories.push(cwd);
  await chmod(fixture, 0o755);
  const transcript = join(cwd, 'transcript.jsonl');
  const adapter = new CodexAdapter({ cwd, executable: fixture,
    env: { ...process.env, ORACULUM_TEST_NATIVE_MODE: mode, ORACULUM_TEST_TRANSCRIPT: transcript }, ...options });
  adapters.push(adapter); await adapter.start();
  return { adapter, cwd, messages: async (): Promise<{ method: string; params: Record<string, unknown> }[]> =>
    (await readFile(transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('stable native capability transport', () => {
  it('keeps inherited thread and turn defaults omitted and experimental API disabled', async () => {
    const { adapter, cwd, messages } = await setup();
    await adapter.startThread({ cwd, config: { injected: 'never-forward' } } as never);
    await adapter.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'Continue' }], arbitrary: 'never-forward' } as never);
    const log = await messages();
    expect(log[0]!.params.capabilities).toEqual({ experimentalApi: false });
    expect(log.find(message => message.method === 'thread/start')!.params).toEqual({ cwd });
    expect(log.find(message => message.method === 'turn/start')!.params).toEqual({ threadId: 'thread-1', input: [{ type: 'text', text: 'Continue', text_elements: [] }] });
    expect(JSON.stringify(log)).not.toContain('never-forward');
  });

  it('merges thread effort with the explicit permission config and passes dynamic model/effort strings', async () => {
    const { adapter, cwd, messages } = await setup('future-effort');
    const models = await adapter.listModels();
    expect(models.data[0]!.supportedReasoningEfforts).toEqual([{ reasoningEffort: 'future-effort' }]);
    await adapter.startThread({ cwd, model: 'future-model', effort: 'ultra', permissionPreset: 'auto' });
    await adapter.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'Continue' }], model: 'future-model', effort: 'future-effort' });
    const log = await messages();
    expect(log.find(message => message.method === 'thread/start')!.params).toEqual({ cwd, model: 'future-model', approvalPolicy: 'on-request', sandbox: 'workspace-write', config: {
      sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false }, model_reasoning_effort: 'ultra',
    } });
    expect(log.find(message => message.method === 'turn/start')!.params).toEqual({ threadId: 'thread-1', input: [{ type: 'text', text: 'Continue', text_elements: [] }], model: 'future-model', effort: 'future-effort' });
  });

  it('sends exact bounded lifecycle parameters and steer correlation without arbitrary overrides', async () => {
    const { adapter, messages } = await setup();
    await adapter.setThreadName('thread-1', 'Renamed');
    await adapter.unarchiveThread('thread-1');
    await adapter.archiveThread('thread-1');
    await adapter.deleteThread('thread-1');
    await adapter.forkThread('thread-1');
    await adapter.forkThread('thread-1', 'turn-0');
    await adapter.revertThread('thread-1', 'turn-0');
    await adapter.compactThread('thread-1');
    await expect(adapter.steerTurn({ threadId: 'thread-1', expectedTurnId: 'turn-1', clientUserMessageId: 'operation-1',
      input: [{ type: 'text', text: 'Keep this focused' }], approvalPolicy: 'never', model: 'injected' } as never)).resolves.toMatchObject({ turnId: 'turn-1' });
    expect((await messages()).filter(message => !['initialize', 'initialized'].includes(message.method))).toEqual([
      { id: 2, method: 'thread/name/set', params: { threadId: 'thread-1', name: 'Renamed' } },
      { id: 3, method: 'thread/unarchive', params: { threadId: 'thread-1' } },
      { id: 4, method: 'thread/archive', params: { threadId: 'thread-1' } },
      { id: 5, method: 'thread/delete', params: { threadId: 'thread-1' } },
      { id: 6, method: 'thread/fork', params: { threadId: 'thread-1', excludeTurns: true } },
      { id: 7, method: 'thread/fork', params: { threadId: 'thread-1', excludeTurns: true, lastTurnId: 'turn-0' } },
      { id: 8, method: 'thread/revert', params: { threadId: 'thread-1', beforeTurnId: 'turn-0' } },
      { id: 9, method: 'thread/compact/start', params: { threadId: 'thread-1' } },
      { id: 10, method: 'turn/steer', params: { threadId: 'thread-1', expectedTurnId: 'turn-1', clientUserMessageId: 'operation-1', input: [{ type: 'text', text: 'Keep this focused', text_elements: [] }] } },
    ]);
  });

  it('scans lifecycle dependencies across every native source without narrowing to a project cwd', async () => {
    const { adapter, messages } = await setup();
    await adapter.listLifecycleThreads({ archived: false });
    await adapter.listLifecycleThreads({ archived: true, cursor: 'next-page', cwd: '/injected' } as never);
    const sources = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
    expect((await messages()).filter(message => message.method === 'thread/list').map(message => message.params)).toEqual([
      { archived: false, limit: 100, modelProviders: [], sourceKinds: sources },
      { archived: true, cursor: 'next-page', limit: 100, modelProviders: [], sourceKinds: sources },
    ]);
  });

  it('honors the lifecycle scan deadline and does not retry a timed-out scan', async () => {
    const { adapter, messages } = await setup('timeout', { readTimeoutMs: 1_000, maxPending: 1 });
    await expect(adapter.listLifecycleThreads({ archived: false, timeoutMs: 20 })).rejects.toMatchObject({ code: 'NATIVE_TIMEOUT', outcome: 'rejected' });
    await expect(adapter.listLifecycleThreads({ archived: true, timeoutMs: 20 })).rejects.toMatchObject({ code: 'NATIVE_BUSY', outcome: 'rejected' });
    expect((await messages()).filter(message => message.method === 'thread/list')).toHaveLength(1);
  });

  it('does not substitute another listing after an unsupported lifecycle dependency scan', async () => {
    const { adapter, messages } = await setup('unsupported');
    await expect(adapter.listLifecycleThreads({ archived: false })).rejects.toMatchObject({ code: 'NATIVE_UNSUPPORTED', outcome: 'rejected' });
    expect((await messages()).filter(message => message.method === 'thread/list')).toHaveLength(1);
  });

  it('dispatches config, account and lightweight MCP reads with no write or full discovery', async () => {
    const { adapter, cwd, messages } = await setup();
    await expect(adapter.readConfig(cwd)).resolves.toMatchObject({ config: { model: 'model-1' }, origins: {} });
    await expect(adapter.readAccountRateLimits()).resolves.toMatchObject({ rateLimits: { primary: { usedPercent: 25 } } });
    await expect(adapter.readAccountUsage()).resolves.toMatchObject({ summary: { lifetimeTokens: 1234 } });
    await expect(adapter.readExtensions('mcp', cwd)).resolves.toMatchObject({ status: 'available', data: { data: [{ name: 'server' }] } });
    expect((await messages()).slice(2).map(message => ({ method: message.method, params: message.params }))).toEqual([
      { method: 'config/read', params: { cwd, includeLayers: false } },
      { method: 'account/rateLimits/read', params: {} },
      { method: 'account/usage/read', params: {} },
      { method: 'mcpServerStatus/list', params: { limit: 100, detail: 'toolsAndAuthOnly' } },
    ]);
  });

  it('rejects invalid names, effort values and non-text steer input before dispatch', async () => {
    const { adapter, cwd, messages } = await setup();
    for (const name of ['', '  ', 'bad\nname', 'x'.repeat(201)]) expect(() => adapter.setThreadName('thread-1', name)).toThrowError();
    expect(() => adapter.startThread({ cwd, effort: 'bad effort' })).toThrowError();
    expect(() => adapter.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'Text' }], effort: 'bad effort' })).toThrowError();
    expect(() => adapter.steerTurn({ threadId: 'thread-1', expectedTurnId: 'turn-1', clientUserMessageId: 'op', input: [{ type: 'localImage', path: '/private/image' }] })).toThrowError();
    expect(() => adapter.steerTurn({ threadId: 'thread-1', expectedTurnId: 'turn-1', clientUserMessageId: 'op', input: [{ type: 'text', text: '' }] })).toThrowError();
    expect((await messages()).filter(message => !['initialize', 'initialized'].includes(message.method))).toEqual([]);
  });

  const writes: [string, (adapter: CodexAdapter) => Promise<unknown>][] = [
    ['thread/name/set', adapter => adapter.setThreadName('thread-1', 'Renamed')],
    ['thread/unarchive', adapter => adapter.unarchiveThread('thread-1')],
    ['thread/archive', adapter => adapter.archiveThread('thread-1')],
    ['thread/delete', adapter => adapter.deleteThread('thread-1')],
    ['thread/fork', adapter => adapter.forkThread('thread-1')],
    ['thread/revert', adapter => adapter.revertThread('thread-1', 'turn-0')],
    ['thread/compact/start', adapter => adapter.compactThread('thread-1')],
    ['turn/steer', adapter => adapter.steerTurn({ threadId: 'thread-1', expectedTurnId: 'turn-1', clientUserMessageId: 'op', input: [{ type: 'text', text: 'Continue' }] })],
  ];
  it.each(writes)('retains unknown outcome without retry for timed-out %s', async (method, write) => {
    const { adapter, messages } = await setup('timeout', { writeTimeoutMs: 20 });
    await expect(write(adapter)).rejects.toMatchObject({ code: 'NATIVE_TIMEOUT', outcome: 'unknown' });
    expect((await messages()).filter(message => message.method === method)).toHaveLength(1);
    expect(adapter.alive).toBe(true);
  });
  it.each(writes)('preserves explicit unsupported rejection without retry for %s', async (method, write) => {
    const { adapter, messages } = await setup('unsupported');
    await expect(write(adapter)).rejects.toMatchObject({ code: 'NATIVE_UNSUPPORTED', outcome: 'rejected' });
    expect((await messages()).filter(message => message.method === method)).toHaveLength(1);
    expect(adapter.alive).toBe(true);
  });

  it('gives lightweight MCP discovery bounded headroom and retains its timeout tombstone', async () => {
    const { adapter, cwd, messages } = await setup('timeout', { maxPending: 1 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let complete = false;
      const reading = adapter.readExtensions('mcp', cwd).then(result => { complete = true; return result; });
      await vi.advanceTimersByTimeAsync(19_999);
      expect(complete).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(reading).resolves.toEqual({ status: 'unavailable', code: 'NATIVE_TIMEOUT' });
      await expect(adapter.readExtensions('mcp', cwd)).resolves.toEqual({ status: 'unavailable', code: 'NATIVE_BUSY' });
      expect((await messages()).filter(message => message.method === 'mcpServerStatus/list')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('honors an explicit MCP read deadline without retrying full discovery', async () => {
    const { adapter, cwd, messages } = await setup('timeout', { readTimeoutMs: 20, maxPending: 1 });
    await expect(adapter.readExtensions('mcp', cwd)).resolves.toEqual({ status: 'unavailable', code: 'NATIVE_TIMEOUT' });
    await expect(adapter.readExtensions('mcp', cwd)).resolves.toEqual({ status: 'unavailable', code: 'NATIVE_BUSY' });
    const reads = (await messages()).filter(message => message.method === 'mcpServerStatus/list');
    expect(reads).toHaveLength(1);
    expect(reads[0]!.params.detail).toBe('toolsAndAuthOnly');
  });
});
