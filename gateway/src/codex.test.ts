import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexAdapter, CodexError } from './codex';
import { NativeHistory } from './history';
import gatewayRelease from '../../packaging/gateway/metadata.json';

const adapters: CodexAdapter[] = [], directories: string[] = [];
const fixture = resolve('gateway/test/fixtures/fake-codex.mjs');
async function setup(mode = 'normal', options: { maxFrameBytes?: number; readTimeoutMs?: number; writeTimeoutMs?: number; maxPending?: number } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'oraculum-native-unit-')); directories.push(cwd);
  await chmod(fixture, 0o755);
  const transcript = join(cwd, 'transcript.jsonl');
  const adapter = new CodexAdapter({ cwd, executable: fixture, env: { ...process.env, ORACULUM_TEST_NATIVE_MODE: mode, ORACULUM_TEST_TRANSCRIPT: transcript }, ...options });
  adapters.push(adapter); await adapter.start();
  return { adapter, cwd, messages: async () => (await readFile(transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}
async function setupNativeError(code: number, message: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'oraculum-native-error-')); directories.push(cwd);
  const executable = join(cwd, 'native-error.mjs');
  await writeFile(executable, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const response = request.method === 'initialize'
    ? { result: { userAgent: 'codex-test/0.0.0' } }
    : { error: ${JSON.stringify({ code, message })} };
  process.stdout.write(JSON.stringify({ id: request.id, ...response }) + '\\n');
});
`, { mode: 0o700 });
  const adapter = new CodexAdapter({ cwd, executable });
  adapters.push(adapter); await adapter.start();
  return adapter;
}
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('official Codex stdio boundary', () => {
  it('handshakes once with experimental API off and projects only supported parameters', async () => {
    const { adapter, cwd, messages } = await setup();
    await adapter.readThread('thread-1');
    await adapter.startThread({ cwd, permissionPreset: 'read-only', config: { model_provider: 'injected' } } as never);
    await adapter.resumeThread('thread-1');
    await adapter.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'test' }], permissionPreset: 'auto' });
    const log = await messages();
    expect(log[0].params.clientInfo.version).toBe(gatewayRelease.version);
    expect(log[0].params.capabilities.experimentalApi).toBe(false);
    expect(log[1]).toMatchObject({ method: 'initialized' });
    expect(log.find(v => v.method === 'thread/read').params).toEqual({ threadId: 'thread-1', includeTurns: false });
    expect(log.find(v => v.method === 'thread/start').params).toEqual({ cwd, approvalPolicy: 'on-request', sandbox: 'read-only' });
    expect(log.find(v => v.method === 'thread/resume').params).toEqual({ threadId: 'thread-1', excludeTurns: true });
    expect(log.find(v => v.method === 'turn/start').params.input).toEqual([{ type: 'text', text: 'test', text_elements: [] }]);
    await expect(adapter.start()).rejects.toMatchObject({ code: 'NATIVE_UNAVAILABLE' });
  });
  it.each(['timeout', 'crash', 'malformed', 'huge', 'bad-response'])('never claims rejected or retries a submitted write after %s', async mode => {
    const { adapter, messages } = await setup(mode, { writeTimeoutMs: 30, maxFrameBytes: 1024 });
    await expect(adapter.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'test' }] })).rejects.toMatchObject({ outcome: 'unknown' });
    expect((await messages()).filter(value => value.method === 'turn/start')).toHaveLength(1);
  });
  it('recognizes explicit pre-execution rejection and keeps native error content private', async () => {
    const { adapter } = await setup('rejection');
    await expect(adapter.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'test' }] })).rejects.toMatchObject({ code: 'NATIVE_REJECTED', outcome: 'rejected', nativeCode: -32602 });
    const { adapter: other } = await setup('provider');
    try { await other.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'test' }] }); }
    catch (error) { expect(error).toBeInstanceOf(CodexError); expect((error as Error).message).not.toContain('secret-value'); expect(error).toMatchObject({ outcome: 'unknown' }); }
  });
  it.each([['unsupported', 'NATIVE_UNSUPPORTED'], ['experimental', 'NATIVE_EXPERIMENTAL'], ['pagination', 'NATIVE_PAGINATION_UNSUPPORTED'], ['paginationFeature','NATIVE_PAGINATION_UNSUPPORTED'], ['invalidCursor', 'NATIVE_REJECTED']])('classifies %s without broad unsupported matching', async (mode, code) => {
    const { adapter } = await setup(mode);
    await expect(adapter.listTurns({ threadId: 'thread-1' })).rejects.toMatchObject({ code });
  });
  it('classifies the specific unimplemented native item paging response',async()=>{
    const {adapter}=await setup('itemPaginationFeature');
    await expect(adapter.listItems({threadId:'thread-1',turnId:'turn-1'})).rejects.toMatchObject({code:'NATIVE_PAGINATION_UNSUPPORTED'});
  });
  it('recognizes only the exact native history-not-materialized response for the requested thread', async () => {
    const adapter = await setupNativeError(-32600,
      'thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message');
    await expect(adapter.listTurns({ threadId: 'thread-1' })).rejects.toMatchObject({
      code: 'NATIVE_HISTORY_NOT_MATERIALIZED', outcome: 'rejected', nativeCode: -32600,
      message: 'Native thread history is not materialized before its first user message',
    });
    const fullRead = vi.spyOn(adapter, 'readThread');
    await expect(new NativeHistory(adapter, { epoch: 'test-epoch' }).turns('thread-1', { scope: 'device:project' }))
      .rejects.toMatchObject({ code: 'NATIVE_HISTORY_NOT_MATERIALIZED' });
    expect(fullRead).not.toHaveBeenCalled();
    expect(adapter.alive).toBe(true);
  });
  it.each([
    [-32600, 'thread other-thread is not materialized yet; thread/turns/list is unavailable before first user message', 'NATIVE_REJECTED'],
    [-32600, 'thread thread-1 is not materialized yet', 'NATIVE_REJECTED'],
    [-32600, 'prefix thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message', 'NATIVE_REJECTED'],
    [-32600, 'thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message; secret-value', 'NATIVE_REJECTED'],
    [-32600, 'thread thread-1 is not materialized yet; thread/items/list is unavailable before first user message', 'NATIVE_REJECTED'],
    [-32601, 'thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message', 'NATIVE_UNSUPPORTED'],
    [-32000, 'thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message', 'NATIVE_REJECTED'],
  ])('does not widen history materialization classification for code %i and message %s', async (code, message, expected) => {
    const adapter = await setupNativeError(code as number, message as string);
    await expect(adapter.listTurns({ threadId: 'thread-1' })).rejects.toMatchObject({ code: expected, outcome: 'rejected' });
  });
  it('does not classify other reads or writes as unmaterialized history', async () => {
    const adapter = await setupNativeError(-32600,
      'thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message');
    await expect(adapter.readThread('thread-1', true)).rejects.toMatchObject({ code: 'NATIVE_REJECTED', outcome: 'rejected' });
    await expect(adapter.listItems({ threadId: 'thread-1', turnId: 'turn-1' })).rejects.toMatchObject({ code: 'NATIVE_REJECTED', outcome: 'rejected' });
    await expect(adapter.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'test' }] })).rejects.toMatchObject({ code: 'NATIVE_REJECTED', outcome: 'rejected' });
    const providerFailure = await setupNativeError(-32000,
      'thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message');
    await expect(providerFailure.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'test' }] })).rejects.toMatchObject({ code: 'NATIVE_REJECTED', outcome: 'unknown' });
  });
  it('isolates optional failures from the core adapter lifecycle', async () => {
    const { adapter } = await setup('unsupported');
    await expect(adapter.readExtensions('plugins', '/tmp')).resolves.toEqual({ status: 'unavailable', code: 'NATIVE_UNSUPPORTED' });
    expect(adapter.alive).toBe(true);
  });
  it('fails closed for unknown server requests without a registered interaction handler', async () => {
    const { messages, adapter } = await setup('unknown-request');
    await adapter.listModels();
    expect((await messages()).find(message => message.id === 'native-1')).toMatchObject({ error: { code: -32601 } });
  });
  it('invalidates unsupported native state notifications without forwarding their private payload',async()=>{
    const {adapter}=await setup('unknown-notification');const observed:unknown[]=[];
    adapter.on('notification',event=>observed.push(event));await adapter.listModels();
    expect(observed).toContainEqual({method:'gateway/unsupportedNativeEvent',params:{threadId:'thread-1'}});
    expect(JSON.stringify(observed)).not.toContain('must-not-forward');
  });
  it('bounds pending operations before forwarding more requests', async () => {
    const { adapter, messages } = await setup('timeout', { maxPending: 1, readTimeoutMs: 30 });
    const first = adapter.listModels();
    await expect(adapter.listModels()).rejects.toMatchObject({ code: 'NATIVE_BUSY', outcome: 'rejected' });
    await expect(first).rejects.toMatchObject({ code: 'NATIVE_TIMEOUT' });
    await expect(adapter.listModels()).rejects.toMatchObject({ code: 'NATIVE_BUSY' });
    expect((await messages()).filter(message => message.method === 'model/list')).toHaveLength(1);
  });

  it('gives slow project listing bounded headroom while ordinary reads retain their deadline without retry', async () => {
    const { adapter, cwd, messages } = await setup('delayed-reads');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let rejected = false;
      const listing = adapter.listThreads({ cwd }).catch(error => { rejected = true; throw error; });
      // Only this process's deadline clock advances; the real stdio peer replies after 200ms.
      await vi.advanceTimersByTimeAsync(8_001);
      expect(rejected).toBe(false);
      await expect(listing).resolves.toMatchObject({ data: [{ id: 'thread-1' }] });
      const reading = adapter.readThread('thread-1');
      const rejection = expect(reading).rejects.toMatchObject({ code: 'NATIVE_TIMEOUT', outcome: 'rejected' });
      await vi.advanceTimersByTimeAsync(8_000);
      await rejection;
      const transcript = await messages();
      expect(transcript.filter(message => message.method === 'thread/list')).toHaveLength(1);
      expect(transcript.filter(message => message.method === 'thread/read')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('keeps an explicit read timeout authoritative for project listing and retains its tombstone', async () => {
    const { adapter, cwd, messages } = await setup('delayed-reads', { readTimeoutMs: 30, maxPending: 1 });
    await expect(adapter.listThreads({ cwd })).rejects.toMatchObject({ code: 'NATIVE_TIMEOUT', outcome: 'rejected' });
    await expect(adapter.listThreads({ cwd })).rejects.toMatchObject({ code: 'NATIVE_BUSY' });
    expect((await messages()).filter(message => message.method === 'thread/list')).toHaveLength(1);
  });
});
