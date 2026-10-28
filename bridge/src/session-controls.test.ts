import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEvent, NativeOperationMethod, Snapshot, Thread, Turn } from '../../packages/shared/protocol';
import { BridgeService } from './service';
import { NativeRpcError } from './codex';
import { ReceiptStore } from './receipts';
import { NativeOperations } from './native-operations';
import { validateNativeResponse } from './compatibility';
import { TrustStore } from './trust-store';
import { createServer } from './server';

const cwd = '/isolated-b4';
const methods: NativeOperationMethod[] = ['thread/name/set', 'thread/fork', 'thread/revert', 'turn/steer', 'review/start', 'thread/compact/start'];
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture() {
  const turns = [{ id: 'first', status: 'completed', items: [] }, { id: 'second', status: 'completed', items: [] }] as unknown as Turn[];
  const thread = { id: 'owned', cwd, name: '原生名称', preview: 'test', parentThreadId: null, source: 'appServer', ephemeral: false,
    status: { type: 'idle' }, turns } as unknown as Thread;
  const records = new Map([[thread.id, thread]]);
  const db = new DatabaseSync(':memory:'); cleanups.push(() => db.close());
  const receipts = new ReceiptStore(db);
  const settings = { approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' }, approvalsReviewer: 'user', model: 'native-model', reasoningEffort: 'medium', cwd };
  const read = vi.fn(async (): Promise<unknown> => ({ thread }));
  const list = vi.fn(async (params: Record<string, unknown>): Promise<unknown> => ({ data: params.archived ? [] : [...records.values()], nextCursor: null }));
  const pages = vi.fn(async (): Promise<unknown> => ({ data: thread.turns.map(turn => ({ ...turn, items: [] })), nextCursor: null }));
  const native = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'thread/name/set') { thread.name = params.name as string; return {}; }
    if (method === 'thread/fork') {
      const fork = { ...thread, id: 'forked', turns: [...thread.turns] }; records.set(fork.id, fork);
      return { ...settings, thread: fork };
    }
    if (method === 'thread/revert') {
      thread.turns = thread.turns.slice(0, thread.turns.findIndex(turn => turn.id === params.beforeTurnId));
      return { thread: { ...thread, turns: [] }, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
    }
    if (method === 'turn/steer') return { turnId: params.expectedTurnId };
    if (method === 'review/start' || method === 'thread/compact/start') {
      const turn = { id: method === 'review/start' ? 'review-turn' : 'compact-turn', status: 'inProgress', items: [] } as unknown as Turn;
      thread.status = { type: 'active', activeFlags: [] }; thread.turns.push(turn);
      codex.emit('message', { method: 'turn/started', params: { threadId: thread.id, turn } });
      if (method === 'thread/compact/start') codex.emit('message', { method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item: { id: 'compact', type: 'contextCompaction' } } });
      return method === 'review/start' ? { turn, reviewThreadId: thread.id } : {};
    }
    throw new Error(`Unexpected native mutation ${method}`);
  });
  const codex = Object.assign(new EventEmitter(), {
    request: vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'thread/list') return list(params);
      if (method === 'thread/read') return read();
      if (method === 'thread/resume') return { ...settings, thread };
      if (method === 'thread/turns/list') return pages();
      if (method === 'thread/items/list') return { data: [], nextCursor: null };
      if (method === 'turn/start') return { turn: { id: 'ordinary-turn', status: 'inProgress', items: [] } };
      if (method === 'turn/interrupt') return {};
      return native(method, params);
    }), send: vi.fn(),
  });
  const service = new BridgeService({ on: codex.on.bind(codex), send: codex.send,
    request: async <T>(method: string, params: object) => await codex.request(method, params as Record<string, unknown>) as T }, cwd, receipts);
  service.threads.add(thread.id);
  const events: BridgeEvent[] = []; service.on('event', event => events.push(event));
  const call = (method: NativeOperationMethod, params: Record<string, unknown> = {}, context?: { deviceId: string; isAuthorized?: () => boolean }) =>
    service.dispatch(method, { threadId: thread.id, cwd, operationId: randomUUID(), ...params }, context);
  const subscribe = () => service.dispatch('bridge/subscribe', { threadId: thread.id }) as Promise<Snapshot>;
  const activate = (id = 'active') => {
    thread.status = { type: 'active', activeFlags: [] };
    const turn = { id, status: 'inProgress', items: [] } as unknown as Turn; thread.turns.push(turn);
    codex.emit('message', { method: 'turn/started', params: { threadId: thread.id, turn } });
  };
  const complete = (id: string, status = 'completed') => {
    thread.status = { type: 'idle' };
    const turn = thread.turns.find(turn => turn.id === id)!; turn.status = status as Turn['status'];
    codex.emit('message', { method: 'turn/completed', params: { threadId: thread.id, turn } });
  };
  return { db, service, receipts, thread, records, codex, native, read, list, pages, events, call, subscribe, activate, complete, settings };
}

describe('B4 native session control boundary', () => {
  it('renames through native API, broadcasts native name, and rejects invalid names and projects', async () => {
    const f = fixture(); await f.subscribe();
    await f.call('thread/name/set', { name: '  原生新名称  ' });
    expect(f.native).toHaveBeenCalledWith('thread/name/set', { threadId: f.thread.id, name: '原生新名称' });
    expect(f.events).toContainEqual({ type: 'event', event: { method: 'thread/name/updated', params: { threadId: f.thread.id, threadName: '原生新名称' } } });
    for (const name of ['', ' ', 'x'.repeat(129), 'bad\nname', 'bad\u202ename']) await expect(f.call('thread/name/set', { name })).rejects.toThrow('名称');
    await expect(f.call('thread/name/set', { name: 'okay', cwd: '/foreign' })).rejects.toThrow('outside');
    await expect(f.call('thread/name/set', { name: 'okay', threadId: 'foreign' })).rejects.toThrow('outside');
    expect(f.native).toHaveBeenCalledTimes(1);
  });

  it('allows rename while running and waiting for approval without changing execution settings', async () => {
    const f = fixture(); await f.subscribe(); f.activate();
    f.codex.emit('message', { id: 'approval', method: 'item/fileChange/requestApproval', params: { threadId: f.thread.id, turnId: 'active', itemId: 'file' } });
    await f.call('thread/name/set', { name: '运行中重命名', model: 'forged', permissionMode: 'full-access' });
    expect(f.native).toHaveBeenCalledExactlyOnceWith('thread/name/set', { threadId: f.thread.id, name: '运行中重命名' });
    expect(f.service.pending.size).toBe(1);
  });

  it('invalidates an older list response when another device receives a native rename', async () => {
    const f = fixture(); const gate = deferred<unknown>(); f.list.mockImplementationOnce(() => gate.promise);
    const old = f.service.dispatch('thread/list', {});
    await vi.waitFor(() => expect(f.list).toHaveBeenCalled());
    f.codex.emit('message', { method: 'thread/name/updated', params: { threadId: f.thread.id, threadName: 'new' } });
    gate.resolve({ data: [{ ...f.thread, name: 'old' }], nextCursor: null });
    await expect(old).rejects.toThrow('状态已变化');
  });

  it('preserves a newer authoritative native name notification received before the rename ACK', async () => {
    const f = fixture(); await f.subscribe();
    f.native.mockImplementationOnce(async () => {
      for (const threadName of ['requested', 'newer-native-name']) f.codex.emit('message', { method: 'thread/name/updated', params: { threadId: f.thread.id, threadName } });
      return {};
    });
    await f.call('thread/name/set', { name: 'requested' });
    const names = f.events.flatMap(event => event.type === 'event' && event.event.method === 'thread/name/updated' ? [event.event.params.threadName] : []);
    expect(names).toEqual(['requested', 'newer-native-name']);
  });

  it('forks only an authorized persistent thread in the same project and broadcasts navigation refresh', async () => {
    const f = fixture(); await f.subscribe();
    const result = await f.call('thread/fork', { lastTurnId: 'first', path: '/untrusted/rollout', model: 'forged' });
    expect(result).toMatchObject({ thread: { id: 'forked', cwd } });
    expect(f.native).toHaveBeenCalledExactlyOnceWith('thread/fork', { threadId: f.thread.id, cwd, lastTurnId: 'first' });
    expect(f.service.threads.has('forked')).toBe(true); expect(f.events).toContainEqual({ type: 'projectsChanged' });
    expect(await f.service.dispatch('thread/list', { cwd })).toMatchObject({ data: expect.arrayContaining([expect.objectContaining({ id: 'forked', cwd })]) });
  });

  it.each(['project', 'parent', 'same-id'])('does not authorize a fork with an invalid %s response, and never retries it', async invalid => {
    const f = fixture(); await f.subscribe();
    const fork = { ...f.thread, id: invalid === 'same-id' ? f.thread.id : 'foreign-fork',
      cwd: invalid === 'project' ? '/private' : cwd, parentThreadId: invalid === 'parent' ? 'unowned-parent' : null };
    f.native.mockResolvedValueOnce({ ...f.settings, thread: fork });
    await expect(f.call('thread/fork')).rejects.toThrow('结果未知');
    expect(f.service.threads.has('foreign-fork')).toBe(false);
    await expect(f.call('thread/fork')).rejects.toThrow('不要重复');
    expect(f.native).toHaveBeenCalledTimes(1);
  });

  it.each(['thread/fork', 'thread/revert', 'review/start', 'thread/compact/start'] as NativeOperationMethod[])('blocks %s for active descendants and hidden cross-project child dependencies', async method => {
    const f = fixture(); await f.subscribe();
    const params = method === 'thread/revert' ? { beforeTurnId: 'second', confirm: true } : method === 'review/start' ? { target: { type: 'uncommittedChanges' } } : {};
    f.codex.emit('message', { method: 'thread/started', params: { thread: { ...f.thread, id: 'child', parentThreadId: f.thread.id } } });
    f.codex.emit('message', { method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn' } } });
    await expect(f.call(method, params)).rejects.toThrow('运行中');
    const g = fixture(); await g.subscribe();
    g.records.set('hidden', { ...g.thread, id: 'hidden', cwd: '/private', parentThreadId: g.thread.id });
    await expect(g.call(method, params)).rejects.toThrow('子会话依赖');
    expect(f.native).not.toHaveBeenCalled(); expect(g.native).not.toHaveBeenCalled(); expect(g.service.threads.has('hidden')).toBe(false);
  });

  it('reverts only an explicitly confirmed native completed boundary and reloads authoritative paginated history', async () => {
    const f = fixture(); const before = await f.subscribe();
    await expect(f.call('thread/revert', { beforeTurnId: 'second' })).rejects.toThrow('二次确认');
    await expect(f.call('thread/revert', { beforeTurnId: 'missing', confirm: true })).rejects.toThrow('未找到');
    const result = await f.call('thread/revert', { beforeTurnId: 'second', confirm: true });
    expect(result).toMatchObject({ thread: { turns: [] } });
    expect(f.native).toHaveBeenCalledExactlyOnceWith('thread/revert', { threadId: f.thread.id, beforeTurnId: 'second' });
    const after = await f.subscribe();
    expect(after.thread.turns.map(turn => turn.id)).toEqual(['first']); expect(after.historyRevision).toBeGreaterThan(before.historyRevision!);
    expect(f.events).toContainEqual(expect.objectContaining({ type: 'threadHistoryChanged', reason: 'revert', historyRevision: after.historyRevision }));
    expect(f.codex.request.mock.calls.filter(([method]) => method === 'thread/turns/list').length).toBeGreaterThan(2);
  });

  it('rejects an old in-flight history page after an external native revert rather than relabeling it with the new revision', async () => {
    const f = fixture(); await f.subscribe(); const gate = deferred<unknown>(); f.pages.mockImplementationOnce(() => gate.promise);
    const old = f.service.dispatch('bridge/history', { threadId: f.thread.id, cursor: 'old' });
    await vi.waitFor(() => expect(f.pages).toHaveBeenCalledTimes(2));
    f.codex.emit('message', { method: 'thread/reverted', params: { threadId: f.thread.id } });
    gate.resolve({ data: [{ id: 'deleted-turn', status: 'completed', items: [] }], nextCursor: null });
    await expect(old).rejects.toThrow('历史已变化');
  });

  it('steers only the observed active native turn, allowing its accepted ordinary send receipt', async () => {
    const f = fixture(); await f.subscribe(); f.activate();
    const receipt = randomUUID(); f.receipts.reserve(receipt, cwd, f.thread.id, 'device'); f.receipts.accepted(receipt, 'active');
    const operationId = randomUUID();
    await expect(f.call('turn/steer', { expectedTurnId: 'active', text: '补充内容', operationId, model: 'forged', permissionMode: 'full-access' })).resolves.toEqual({ turnId: 'active' });
    expect(f.native).toHaveBeenCalledExactlyOnceWith('turn/steer', { threadId: f.thread.id, expectedTurnId: 'active', clientUserMessageId: operationId,
      input: [{ type: 'text', text: '补充内容', text_elements: [] }] });
    expect(f.codex.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
    await expect(f.call('turn/steer', { expectedTurnId: 'old', text: 'stale' })).rejects.toThrow('活动轮次已变化');
    f.complete('active');
    await expect(f.call('turn/steer', { expectedTurnId: 'active', text: 'late' })).rejects.toThrow('活动轮次已变化');
  });

  it('rejects steering while a send is unconfirmed or belongs to a different accepted turn', async () => {
    const f = fixture(); await f.subscribe(); f.activate();
    const receipt = randomUUID(); f.receipts.reserve(receipt, cwd, f.thread.id, 'device');
    await expect(f.call('turn/steer', { expectedTurnId: 'active', text: 'unknown' })).rejects.toThrow('活动轮次已变化');
    f.receipts.accepted(receipt, 'other-turn');
    await expect(f.call('turn/steer', { expectedTurnId: 'active', text: 'other' })).rejects.toThrow('活动轮次已变化');
    expect(f.native).not.toHaveBeenCalled();
  });

  it('rechecks the active turn after an awaited native read and does not fall back to a new turn', async () => {
    const f = fixture(); await f.subscribe(); f.activate(); const gate = deferred<unknown>(); f.read.mockImplementationOnce(() => gate.promise);
    const pending = f.call('turn/steer', { expectedTurnId: 'active', text: 'race' });
    f.complete('active'); f.activate('next'); gate.resolve({ thread: f.thread });
    await expect(pending).rejects.toThrow('活动轮次已变化'); expect(f.native).not.toHaveBeenCalled();
    expect(f.codex.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
  });

  it('does not settle unknown steer from turn completion, reject retries across restart, or replay any native mutation', async () => {
    const f = fixture(); await f.subscribe(); f.activate(); f.native.mockRejectedValueOnce(new Error('timeout'));
    const operationId = randomUUID(); await expect(f.call('turn/steer', { expectedTurnId: 'active', text: 'one', operationId })).rejects.toThrow('结果未知');
    f.complete('active'); const snapshot = await f.subscribe();
    expect(snapshot.nativeOperations).toContainEqual(expect.objectContaining({ operationId, state: 'unknown' }));
    const reopened = new NativeOperations(f.db);
    expect(() => reopened.reserve(operationId, cwd, f.thread.id, 'turn/steer')).toThrow('已记录');
    expect(reopened.list(cwd, f.thread.id)[0].state).toBe('unknown'); expect(f.native).toHaveBeenCalledTimes(1);
  });

  it.each(['review/start', 'thread/compact/start'] as NativeOperationMethod[])('tracks %s actual native execution and completion with ordinary turn/approval events', async method => {
    const f = fixture(); await f.subscribe();
    await f.call(method, method === 'review/start' ? { target: { type: 'uncommittedChanges' } } : {});
    const turnId = method === 'review/start' ? 'review-turn' : 'compact-turn';
    expect((await f.subscribe()).nativeOperations).toContainEqual(expect.objectContaining({ method, state: 'accepted', turnId }));
    await expect(f.call('thread/fork')).rejects.toThrow('运行中');
    f.codex.emit('message', { id: 'approval', method: 'item/fileChange/requestApproval', params: { threadId: f.thread.id, turnId, itemId: 'file' } });
    expect(f.service.pending.size).toBe(1);
    if (method === 'thread/compact/start') f.codex.emit('message', { method: 'item/completed', params: { threadId: f.thread.id, turnId, item: { id: 'compact', type: 'contextCompaction' } } });
    f.complete(turnId);
    expect(f.service.pending.size).toBe(0); expect((await f.subscribe()).nativeOperations).toContainEqual(expect.objectContaining({ method, state: 'completed', turnId }));
    if (method === 'thread/compact/start') expect(f.events).toContainEqual(expect.objectContaining({ type: 'threadHistoryChanged', reason: 'compact' }));
  });

  it('does not resurrect a completed native review when its ACK arrives late', async () => {
    const f = fixture(); await f.subscribe(); const gate = deferred<unknown>(); f.native.mockImplementationOnce(() => gate.promise);
    const pending = f.call('review/start', { target: { type: 'uncommittedChanges' } });
    await vi.waitFor(() => expect(f.native).toHaveBeenCalled()); f.activate('review-turn'); f.complete('review-turn');
    gate.resolve({ turn: { id: 'review-turn', status: 'inProgress', items: [] }, reviewThreadId: f.thread.id }); await pending;
    expect((await f.subscribe()).nativeOperations).toContainEqual(expect.objectContaining({ method: 'review/start', state: 'completed' }));
    await expect(f.call('thread/fork')).resolves.toMatchObject({ thread: { id: 'forked' } });
  });

  it('preserves a newer active turn and Stop when an older completed review ACK arrives late', async () => {
    const f = fixture(); await f.subscribe(); const gate = deferred<unknown>(); f.native.mockImplementationOnce(() => gate.promise);
    const pending = f.call('review/start', { target: { type: 'uncommittedChanges' } });
    await vi.waitFor(() => expect(f.native).toHaveBeenCalled()); f.activate('review-turn'); f.complete('review-turn'); f.activate('newer-turn');
    gate.resolve({ turn: { id: 'review-turn', status: 'inProgress', items: [] }, reviewThreadId: f.thread.id }); await pending;
    await expect(f.service.dispatch('turn/interrupt', { threadId: f.thread.id, turnId: 'newer-turn' })).resolves.toEqual({});
    await expect(f.service.dispatch('turn/start', { threadId: f.thread.id, text: 'must not send', operationId: randomUUID() }, { deviceId: 'device' })).rejects.toThrow('progress');
  });

  it.each(['failed', 'interrupted'])('refuses a %s turn as a fork or revert boundary', async status => {
    const f = fixture(); await f.subscribe(); f.thread.turns[0].status = status as Turn['status'];
    await expect(f.call('thread/fork', { lastTurnId: 'first' })).rejects.toThrow('已完成');
    await expect(f.call('thread/revert', { beforeTurnId: 'first', confirm: true })).rejects.toThrow('已完成');
    expect(f.native).not.toHaveBeenCalled();
  });

  it.each(['review/start', 'thread/compact/start'] as NativeOperationMethod[])('does not correlate an unknown %s with an unrelated later native turn', async method => {
    const f = fixture(); await f.subscribe(); f.native.mockRejectedValueOnce(new Error('timeout'));
    await expect(f.call(method, method === 'review/start' ? { target: { type: 'uncommittedChanges' } } : {})).rejects.toThrow('结果未知');
    f.activate('unrelated-cli-turn');
    f.codex.emit('message', { method: 'item/started', params: { threadId: f.thread.id, turnId: 'unrelated-cli-turn', item: { id: 'unrelated', type: 'contextCompaction' } } });
    f.complete('unrelated-cli-turn');
    expect((await f.subscribe()).nativeOperations).toContainEqual(expect.objectContaining({ method, state: 'unknown', turnId: undefined }));
    await expect(f.call(method, method === 'review/start' ? { target: { type: 'uncommittedChanges' } } : {})).rejects.toThrow('不要重复');
    expect(f.native).toHaveBeenCalledTimes(1);
  });

  it('rejects late native approval requests for terminal or removed turns after a revert', async () => {
    const f = fixture(); await f.subscribe(); await f.call('thread/revert', { beforeTurnId: 'second', confirm: true });
    f.codex.emit('message', { id: 'late', method: 'item/fileChange/requestApproval', params: { threadId: f.thread.id, turnId: 'second', itemId: 'removed' } });
    expect(f.service.pending.size).toBe(0);
    expect(f.codex.send).toHaveBeenCalledWith({ id: 'late', error: { code: -32600, message: 'Turn already terminal or removed; no permission granted' } });
  });

  it('isolates an unsupported native method while keeping normal sending and other methods available', async () => {
    const f = fixture(); await f.subscribe(); f.native.mockRejectedValueOnce(new NativeRpcError('method not found', -32601));
    await expect(f.call('thread/compact/start')).rejects.toThrow('不支持');
    const snapshot = await f.subscribe(); expect(snapshot.nativeCapabilities?.unsupportedMethods).toEqual(['thread/compact/start']);
    expect(snapshot.sendBlocked).toBe(false);
    await expect(f.call('thread/name/set', { name: 'still works' })).resolves.toEqual({});
    await expect(f.service.dispatch('turn/start', { threadId: f.thread.id, text: 'ordinary', operationId: randomUUID() }, { deviceId: 'device' })).resolves.toMatchObject({ turn: { id: 'ordinary-turn' } });
  });

  it('reserves native mutation before safety reads and rechecks device revocation before sending', async () => {
    const f = fixture(); await f.subscribe(); const gate = deferred<unknown>(); f.read.mockImplementationOnce(() => gate.promise);
    let authorized = true;
    const pending = f.call('thread/fork', {}, { deviceId: 'device', isAuthorized: () => authorized });
    await expect(f.call('thread/name/set', { name: 'race' })).rejects.toThrow('操作正在进行');
    authorized = false; gate.resolve({ thread: f.thread });
    await expect(pending).rejects.toThrow('授权已撤销'); expect(f.native).not.toHaveBeenCalled();
    expect(f.receipts.nativeOperations.list(cwd, f.thread.id)).toEqual([]);
  });

  it('persists unknown outcomes on unavailable and revisions advance across reopening the ledger', async () => {
    const f = fixture(); await f.subscribe(); const gate = deferred<unknown>(); f.native.mockImplementationOnce(() => gate.promise);
    const pending = f.call('thread/fork'); await vi.waitFor(() => expect(f.native).toHaveBeenCalled());
    f.codex.emit('unavailable', 'lost');
    expect(f.receipts.nativeOperations.list(cwd, f.thread.id)[0].state).toBe('unknown');
    gate.reject(new Error('lost')); await expect(pending).rejects.toThrow('结果未知');
    const before = (await f.subscribe()).historyRevision!;
    f.codex.emit('message', { method: 'thread/reverted', params: { threadId: f.thread.id } });
    const changed = (await f.subscribe()).historyRevision!; expect(changed).toBeGreaterThan(before);
    const reopened = new NativeOperations(f.db); expect(reopened.revision(cwd, f.thread.id)).toBe(changed);
  });
});

describe('B4 authenticated WebSocket mutations', () => {
  it('denies untrusted Origin, anonymous/revoked sessions, and a device revoked during awaited native safety reads', async () => {
    const f = fixture(); await f.subscribe();
    const directory = mkdtempSync(join(tmpdir(), 'oraculum-b4-auth-')); cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const trust = new TrustStore(directory); cleanups.push(() => trust.close());
    const app = await createServer(f.service, 17865, '/missing', { trust }); cleanups.push(() => app.close()); await app.ready();
    const origin = 'http://127.0.0.1:17865'; const headers = { host: '127.0.0.1:17865', origin };
    const pairing = trust.pair(trust.createPairing().code, 'B4 isolated test', origin);
    const cookie = `oraculum_local=${pairing.token}`;
    await expect(app.injectWS('/ws', { headers: { ...headers, origin: 'https://foreign.invalid', cookie } })).rejects.toThrow('403');
    await expect(app.injectWS('/ws', { headers: { host: headers.host, cookie } })).rejects.toThrow('403');
    await expect(app.injectWS('/ws', { headers })).rejects.toThrow('401');
    const socket = await app.injectWS('/ws', { headers: { ...headers, cookie } }); cleanups.push(() => { socket.close(); });
    const response = once(socket, 'message');
    socket.send(JSON.stringify({ id: 'rename', method: 'thread/name/set', params: { threadId: f.thread.id, cwd, name: 'authenticated', operationId: randomUUID() } }));
    // Operation broadcasts precede the RPC response. Wait for the known native
    // mutation rather than treating the first event as an acknowledgement.
    await response; await vi.waitFor(() => expect(f.native).toHaveBeenCalledExactlyOnceWith('thread/name/set', { threadId: f.thread.id, name: 'authenticated' }));
    const gate = deferred<unknown>(); f.read.mockImplementationOnce(() => gate.promise);
    const readCount = f.read.mock.calls.length;
    socket.send(JSON.stringify({ id: 'fork', method: 'thread/fork', params: { threadId: f.thread.id, cwd, operationId: randomUUID() } }));
    await vi.waitFor(() => expect(f.read.mock.calls.length).toBeGreaterThan(readCount));
    trust.revoke(pairing.device.id); gate.resolve({ thread: f.thread });
    const closed = once(socket, 'close');
    // Request completion checks the callback before sending, and the socket's
    // independent trust timer also closes a revoked device without a response.
    await closed;
    expect(f.native).toHaveBeenCalledTimes(1);
    expect(f.receipts.nativeOperations.list(cwd, f.thread.id).every(operation => operation.method !== 'thread/fork')).toBe(true);
    await expect(app.injectWS('/ws', { headers: { ...headers, cookie } })).rejects.toThrow('401');
  });
});

describe('B4 compatibility shapes', () => {
  it.each(methods)('rejects an invalid %s response without global capability probing', method => {
    expect(() => validateNativeResponse('fixture', method, null)).toThrow('incompatible');
  });
  it('validates only fields consumed by B4 while tolerating additive fields', () => {
    expect(() => validateNativeResponse('fixture', 'thread/name/set', { additive: true })).not.toThrow();
    expect(() => validateNativeResponse('fixture', 'thread/compact/start', {})).not.toThrow();
    expect(() => validateNativeResponse('fixture', 'turn/steer', { turnId: 'active', additive: true })).not.toThrow();
    expect(() => validateNativeResponse('fixture', 'turn/steer', { turnId: '' })).toThrow('turnId');
    expect(() => validateNativeResponse('fixture', 'review/start', { turn: { id: 'review', status: 'inProgress', items: [] } })).toThrow('reviewThreadId');
  });
});
