import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayStore, randomCredential } from './store';
import { GatewayService, type Authorized } from './service';
import { CodexError, type CodexAdapter, type NativeThread } from './codex';
import type { GatewayConfig } from './config';

class NativeFixture extends EventEmitter {
  alive = true;
  thread!: NativeThread;
  nextCursor: string | null = null;
  readThread = vi.fn(async (_id: string) => ({ thread: structuredClone(this.thread) }));
  listThreads = vi.fn(async (_input: unknown) => ({ data: [structuredClone(this.thread)], nextCursor: this.nextCursor }));
  listTurns = vi.fn(async (_input: unknown) => ({ data: [], nextCursor: null }));
  listItems = vi.fn(async (_input: unknown) => ({ data: [], nextCursor: null }));
  setThreadName = vi.fn(async (_id: string, name: string) => { this.thread.name = name; return {}; });
  async close() { this.alive = false; }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oraculum-read-cache-'));
  const projects = join(root, 'projects'), path = join(projects, 'dedicated');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const store = new GatewayStore(join(root, 'state'), { create: true });
  const codex = new NativeFixture(); let now = 1000;
  const config: GatewayConfig = { configVersion: 2, stateDir: store.stateDir, host: '127.0.0.1', port: 18791, basePath: '/', externalOrigin: null, allowedRoots: [{ id: 'fixture', path: projects }], codexCommand: 'unused' };
  const service = new GatewayService(store, config, codex as unknown as CodexAdapter, { now: () => now });
  const project = await service.projects.register('fixture', 'dedicated');
  codex.thread = { id: 'thread-fixture', cwd: path, preview: '', status: { type: 'idle' }, turns: [], updatedAt: 1 };
  const pair = (): Authorized => {
    const deviceId = randomUUID();
    const result = service.auth.pair({ installationId: store.installationId, deviceId, deviceCredential: randomCredential(), code: store.createPairing().code, label: 'Read fixture' });
    return { deviceId, check: () => { service.auth.authenticate(result.accessToken); } };
  };
  const auth = pair();
  cleanups.push(async () => { await service.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, codex, service, auth, pair, projectId: project.id, path, advance: (ms: number) => { now += ms; } };
}

describe('Gateway read projection reuse and native authorization', () => {
  it('uses one native list for ten repeated reads and revalidates external changes at five seconds', async () => {
    const f = await fixture();
    for (let index = 0; index < 10; index++) await f.service.listThreads(f.auth, f.projectId, {});
    expect(f.codex.listThreads).toHaveBeenCalledTimes(1);
    f.codex.thread.name = 'External CLI title';
    f.advance(5000);
    expect((await f.service.listThreads(f.auth, f.projectId, {})).threads[0].title).toBe('External CLI title');
    expect(f.codex.listThreads).toHaveBeenCalledTimes(2);
  });

  it('shares native list pages across devices while signing separate device-bound cursors', async () => {
    const f = await fixture(), other = f.pair(); f.codex.nextCursor = 'native-next';
    const one = await f.service.listThreads(f.auth, f.projectId, {});
    const two = await f.service.listThreads(other, f.projectId, {});
    expect(f.codex.listThreads).toHaveBeenCalledTimes(1);
    expect(one.nextCursor).not.toBe(two.nextCursor);
    await expect(f.service.listThreads(other, f.projectId, { cursor: one.nextCursor! })).rejects.toMatchObject({ code: 'CURSOR_RESET_REQUIRED' });
    f.store.revokeDevice(other.deviceId);
    await expect(f.service.listThreads(other, f.projectId, {})).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
    expect(f.codex.listThreads).toHaveBeenCalledTimes(1);
  });

  it('checks registered directory identity even when a list page is warm', async () => {
    const f = await fixture(); await f.service.listThreads(f.auth, f.projectId, {});
    renameSync(f.path, `${f.path}-original`); mkdirSync(f.path);
    await expect(f.service.listThreads(f.auth, f.projectId, {})).rejects.toMatchObject({ code: 'PROJECT_UNAVAILABLE' });
    expect(f.codex.listThreads).toHaveBeenCalledTimes(1);
  });

  it('keeps metadata authorization fresh and removes the duplicate snapshot metadata RPC', async () => {
    const f = await fixture();
    for (let index = 0; index < 10; index++) await f.service.snapshot(f.auth, f.codex.thread.id, f.projectId);
    expect(f.codex.readThread).toHaveBeenCalledTimes(10);
    await f.service.requireThread(f.auth, f.projectId, f.codex.thread.id);
    await f.service.requireThread(f.auth, f.projectId, f.codex.thread.id);
    expect(f.codex.readThread).toHaveBeenCalledTimes(12);
    f.codex.thread.cwd = join(f.path, 'moved');
    await expect(f.service.snapshot(f.auth, f.codex.thread.id, f.projectId)).rejects.toMatchObject({ code: 'PROJECT_UNAVAILABLE' });
  });

  it('rereads an active snapshot history and its pending facts', async () => {
    const f = await fixture(); f.codex.thread.status = { type: 'active', activeFlags: [] };
    await f.service.snapshot(f.auth, f.codex.thread.id, f.projectId);
    await f.service.snapshot(f.auth, f.codex.thread.id, f.projectId);
    expect(f.codex.listTurns).toHaveBeenCalledTimes(2);
  });

  it('bypasses warm history while an idle thread has a pending native approval', async () => {
    const f = await fixture(); await f.service.snapshot(f.auth, f.codex.thread.id, f.projectId);
    await f.service.interactions.receive({ id: 7, method: 'item/commandExecution/requestApproval', params: {
      threadId: f.codex.thread.id, turnId: 'turn-fixture', itemId: 'command-fixture', command: 'printf fixture', cwd: f.path,
    } }, f.projectId);
    const one = await f.service.snapshot(f.auth, f.codex.thread.id, f.projectId);
    const two = await f.service.snapshot(f.auth, f.codex.thread.id, f.projectId);
    expect(one.interactions).toHaveLength(1); expect(two.interactions[0].status).toBe('pending');
    expect(f.codex.listTurns).toHaveBeenCalledTimes(3);
  });

  it('shares simultaneous display metadata reads and keeps each snapshot current', async () => {
    const f = await fixture(); let release!: (result: { thread: NativeThread }) => void;
    const validate = f.service.projects.validate.bind(f.service.projects); let validated = 0;
    vi.spyOn(f.service.projects, 'validate').mockImplementation(async projectId => { const project = await validate(projectId); validated++; return project; });
    f.codex.readThread.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = f.service.snapshot(f.auth, f.codex.thread.id, f.projectId);
    const second = f.service.snapshot(f.auth, f.codex.thread.id, f.projectId);
    await vi.waitFor(() => { expect(f.codex.readThread).toHaveBeenCalledTimes(1); expect(validated).toBe(2); });
    release({ thread: structuredClone(f.codex.thread) });
    const results = await Promise.all([first, second]);
    expect(results.map(result => result.synchronization)).toEqual(['current', 'current']);
    expect(f.codex.readThread).toHaveBeenCalledTimes(1);
  });

  it('invalidates list projections on native catalog events but preserves them through item deltas', async () => {
    const f = await fixture(); await f.service.listThreads(f.auth, f.projectId, {});
    f.codex.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: f.codex.thread.id, delta: 'text' } });
    await f.service.settled(); await f.service.listThreads(f.auth, f.projectId, {});
    expect(f.codex.listThreads).toHaveBeenCalledTimes(1);
    f.codex.thread.name = 'Native event title';
    f.codex.emit('notification', { method: 'thread/name/updated', params: { threadId: f.codex.thread.id, threadName: f.codex.thread.name } });
    await f.service.settled();
    expect((await f.service.listThreads(f.auth, f.projectId, {})).threads[0].title).toBe('Native event title');
    expect(f.codex.listThreads).toHaveBeenCalledTimes(2);
    f.codex.emit('notification', { method: 'turn/completed', params: { threadId: 'unknown-external-thread', turn: { id: 'external-turn' } } });
    await f.service.settled(); await f.service.listThreads(f.auth, f.projectId, {});
    expect(f.codex.listThreads).toHaveBeenCalledTimes(3);
  });

  it('invalidates local mutation projections while preserving durable receipts', async () => {
    const f = await fixture(); await f.service.listThreads(f.auth, f.projectId, {});
    const operationId = randomUUID();
    const result = await f.service.mutateThread(f.auth, f.codex.thread.id, 'name', { operationId, projectId: f.projectId, expectedEpoch: f.service.epoch, name: 'Renamed' });
    expect(result.status).toBe('accepted');
    expect((await f.service.listThreads(f.auth, f.projectId, {})).threads[0].title).toBe('Renamed');
    expect(f.codex.listThreads).toHaveBeenCalledTimes(2);
    expect(f.store.getOperation(operationId, f.auth.deviceId)?.status).toBe('accepted');
  });

  it('clears failed shared reads and rejects stale in-flight catalog generations', async () => {
    const f = await fixture();
    f.codex.listThreads.mockRejectedValueOnce(new CodexError('NATIVE_TIMEOUT', 'timeout', 'rejected'));
    await expect(f.service.listThreads(f.auth, f.projectId, {})).rejects.toMatchObject({ code: 'NATIVE_TIMEOUT' });
    await f.service.listThreads(f.auth, f.projectId, {});
    f.advance(5000);
    let release!: (page: { data: NativeThread[]; nextCursor: null }) => void;
    f.codex.listThreads.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const stale = f.service.listThreads(f.auth, f.projectId, {});
    const rejected = expect(stale).rejects.toMatchObject({ code: 'HISTORY_STALE' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.codex.emit('notification', { method: 'thread/name/updated', params: { threadId: f.codex.thread.id, threadName: 'Changed' } });
    release({ data: [structuredClone(f.codex.thread)], nextCursor: null }); await rejected;
    await f.service.listThreads(f.auth, f.projectId, {});
    expect(f.codex.listThreads).toHaveBeenCalledTimes(4);
    f.codex.emit('unavailable'); await f.service.listThreads(f.auth, f.projectId, {});
    expect(f.codex.listThreads).toHaveBeenCalledTimes(5);
  });

  it('rechecks each caller authorization after a shared native read finishes', async () => {
    const f = await fixture(), other = f.pair();
    let release!: (page: { data: NativeThread[]; nextCursor: null }) => void;
    f.codex.listThreads.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = f.service.listThreads(f.auth, f.projectId, {});
    const second = f.service.listThreads(other, f.projectId, {});
    const rejected = expect(second).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.store.revokeDevice(other.deviceId); release({ data: [structuredClone(f.codex.thread)], nextCursor: null });
    expect((await first).threads).toHaveLength(1); await rejected;
    expect(f.codex.listThreads).toHaveBeenCalledTimes(1);
  });

  it('rejects a project unregistered while its native catalog read was in flight', async () => {
    const f = await fixture(); let release!: (page: { data: NativeThread[]; nextCursor: null }) => void;
    f.codex.listThreads.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const reading = f.service.listThreads(f.auth, f.projectId, {});
    const rejected = expect(reading).rejects.toMatchObject({ code: 'PROJECT_UNAVAILABLE' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.service.projects.unregister(f.projectId);
    release({ data: [structuredClone(f.codex.thread)], nextCursor: null }); await rejected;
  });
});
