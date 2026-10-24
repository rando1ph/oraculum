import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEvent, Thread } from '../../packages/shared/protocol';
import { BridgeService } from './service';
import { NativeRpcError } from './codex';
import { ReceiptStore } from './receipts';
import { validateNativeResponse } from './compatibility';

const cwd = '/lifecycle-test';
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const thread = { id: 'owned', cwd, preview: 'test', parentThreadId: null, source: 'appServer', ephemeral: false,
    status: { type: 'idle' }, turns: [] } as unknown as Thread;
  const records = new Map<string, { thread: Thread; archived: boolean }>([[thread.id, { thread, archived: false }]]);
  const db = new DatabaseSync(':memory:'); cleanups.push(() => db.close());
  const receipts = new ReceiptStore(db);
  const mutate = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const entry = records.get(params.threadId as string)!;
    if (method === 'thread/archive') entry.archived = true;
    if (method === 'thread/unarchive') entry.archived = false;
    if (method === 'thread/delete') records.delete(params.threadId as string);
    return method === 'thread/unarchive' ? { thread: entry.thread } : {};
  });
  const read = vi.fn(async (): Promise<unknown> => ({ thread }));
  const list = vi.fn(async (params: Record<string, unknown>): Promise<unknown> => ({
    data: [...records.values()].filter(r => r.archived === !!params.archived && (!params.cwd || r.thread.cwd === params.cwd)).map(r => r.thread), nextCursor: null,
  }));
  const resume = vi.fn(async (): Promise<unknown> => ({ thread }));
  const turn = vi.fn(async (): Promise<unknown> => ({ turn: { id: 'turn', status: 'inProgress', items: [] } }));
  const codex = Object.assign(new EventEmitter(), {
    request: vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'thread/list') return list(params);
      if (method === 'thread/read') return read();
      if (method === 'thread/start') return { thread };
      if (method === 'thread/resume') return resume();
      if (method === 'thread/turns/list') return { data: [], nextCursor: null };
      if (method === 'turn/start') return turn();
      if (['thread/archive', 'thread/unarchive', 'thread/delete'].includes(method)) return mutate(method, params);
      throw new Error(`Unexpected method ${method}`);
    }), send: vi.fn(),
  });
  const service = new BridgeService({
    on: codex.on.bind(codex), send: codex.send,
    request: async <T>(method: string, params: object) => await codex.request(method, params as Record<string, unknown>) as T,
  }, cwd, receipts);
  service.threads.add(thread.id);
  const events: BridgeEvent[] = [];
  service.on('event', event => events.push(event));
  const change = (method = 'thread/archive', params: Record<string, unknown> = {}) => service.dispatch(method, { threadId: thread.id, cwd, ...params });
  const send = () => service.dispatch('turn/start', { threadId: thread.id, text: 'test', operationId: randomUUID() }, { deviceId: 'test-device' });
  return { service, codex, read, list, resume, turn, thread, records, events, mutate, receipts, change, send };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('native thread lifecycle boundary', () => {
  it('archives, lists archives without fresh cache ghosts, restores and permanently deletes through native methods', async () => {
    const f = fixture();
    await f.service.dispatch('thread/start', {});
    await expect(f.change()).resolves.toEqual({ threadId: f.thread.id, state: 'archived' });
    expect(await f.service.dispatch('thread/list', {})).toMatchObject({ data: [] });
    expect(await f.service.dispatch('thread/list', { archived: true })).toMatchObject({ data: [f.thread] });
    await expect(f.service.dispatch('bridge/subscribe', { threadId: f.thread.id })).rejects.toThrow('先恢复');
    await expect(f.change('thread/unarchive')).resolves.toEqual({ threadId: f.thread.id, state: 'active' });
    await expect(f.send()).rejects.toThrow('resume');
    await expect(f.change('thread/delete', { confirm: true })).resolves.toEqual({ threadId: f.thread.id, state: 'deleted' });
    await expect(f.send()).rejects.toThrow('已删除');
    expect(f.mutate.mock.calls).toEqual(['thread/archive', 'thread/unarchive', 'thread/delete'].map(method => [method, { threadId: f.thread.id }]));
    expect(f.events.filter(e => e.type === 'threadLifecycleChanged')).toEqual(['archived', 'active', 'deleted'].map(state => ({ type: 'threadLifecycleChanged', threadId: f.thread.id, cwd, state })));
  });

  it('refuses a fresh empty thread omitted from native history instead of losing it on restore', async () => {
    const f = fixture(); await f.service.dispatch('thread/start', {}); f.records.clear();
    await expect(f.change()).rejects.toThrow('空会话尚未进入原生历史');
    expect(f.mutate).not.toHaveBeenCalled();
    expect(await f.service.dispatch('thread/list', {})).toMatchObject({ data: [f.thread] });
    await expect(f.change('thread/delete', { confirm: true })).resolves.toMatchObject({ state: 'deleted' });
    expect(await f.service.dispatch('thread/list', {})).toMatchObject({ data: [] });
    expect(f.mutate).toHaveBeenCalledExactlyOnceWith('thread/delete', { threadId: f.thread.id });
  });

  it('requires explicit confirmation and refuses both forged and changed project ownership before mutation', async () => {
    const f = fixture();
    await expect(f.change('thread/delete')).rejects.toThrow('二次确认');
    await expect(f.change('thread/delete', { confirm: 'true' })).rejects.toThrow('二次确认');
    await expect(f.change('thread/delete', { confirm: true, cwd: '/other' })).rejects.toThrow('selected project');
    await expect(f.change('thread/archive', { threadId: 'private' })).rejects.toThrow('outside');
    f.read.mockResolvedValue({ thread: { ...f.thread, cwd: '/other' } });
    await expect(f.change()).rejects.toThrow('outside');
    expect(f.mutate).not.toHaveBeenCalled();
  });

  it.each(['active', 'systemError'])('refuses native %s status', async status => {
    const f = fixture(); f.thread.status = { type: status } as Thread['status'];
    await expect(f.change()).rejects.toThrow('状态异常');
    expect(f.mutate).not.toHaveBeenCalled();
  });

  it('refuses unknown/accepted persisted receipts, pending interactions, and observed native turns even when read says idle', async () => {
    const f = fixture();
    f.codex.emit('message', { id: 'approval', method: 'item/fileChange/requestApproval', params: { threadId: f.thread.id, turnId: 'turn', itemId: 'file' } });
    await expect(f.change()).rejects.toThrow('审批');
    f.codex.emit('message', { method: 'serverRequest/resolved', params: { threadId: f.thread.id, requestId: 'approval' } });
    const operationId = randomUUID(); f.receipts.reserve(operationId, cwd, f.thread.id, 'device');
    await expect(f.change()).rejects.toThrow('发送结果未知');
    f.receipts.accepted(operationId, 'turn');
    await expect(f.change()).rejects.toThrow('发送结果未知');
    f.receipts.observe(cwd, f.thread.id, { id: 'turn', status: 'completed' });
    f.codex.emit('message', { method: 'turn/started', params: { threadId: f.thread.id, turn: { id: 'current' } } });
    await expect(f.change()).rejects.toThrow('运行中');
    expect(f.mutate).not.toHaveBeenCalled();
  });

  it('rechecks native status after inventory and catches active status notifications during the final read', async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce({ thread: f.thread }).mockImplementationOnce(async () => {
      f.codex.emit('message', { method: 'thread/status/changed', params: { threadId: f.thread.id, status: { type: 'active', activeFlags: ['waitingOnUserInput'] } } });
      return { thread: f.thread };
    });
    await expect(f.change()).rejects.toThrow('运行中');
    expect(f.read).toHaveBeenCalledTimes(2); expect(f.mutate).not.toHaveBeenCalled();
  });

  it.each([false, true])('refuses a hidden cross-project child (archived=%s) before cascade', async archived => {
    const f = fixture();
    f.records.set('child', { thread: { ...f.thread, id: 'child', cwd: '/private-project', parentThreadId: f.thread.id }, archived });
    await expect(f.change()).rejects.toThrow('子会话依赖');
    expect(f.service.threads.has('child')).toBe(false); expect(f.mutate).not.toHaveBeenCalled();
    expect(f.list).toHaveBeenCalledWith(expect.objectContaining({ sourceKinds: expect.arrayContaining(['subAgentThreadSpawn']), modelProviders: [] }));
  });

  it('does not block unrelated native review/compact records with an explicit null parent', async () => {
    const f = fixture();
    f.records.set('review', { thread: { ...f.thread, id: 'review', source: { subAgent: 'review' } }, archived: false });
    await expect(f.change()).resolves.toMatchObject({ state: 'archived' });
  });

  it('refuses unresolved lineage, child targets, ephemeral threads and incomplete cyclic pagination', async () => {
    const f = fixture();
    f.thread.parentThreadId = 'parent'; await expect(f.change()).rejects.toThrow('子会话');
    f.thread.parentThreadId = null; f.thread.ephemeral = true; await expect(f.change()).rejects.toThrow('临时');
    f.thread.ephemeral = false;
    f.records.set('ambiguous', { thread: { ...f.thread, id: 'ambiguous', parentThreadId: undefined } as unknown as Thread, archived: false });
    await expect(f.change()).rejects.toThrow('父子关系');
    f.records.delete('ambiguous'); f.list.mockResolvedValue({ data: [], nextCursor: 'same' });
    await expect(f.change()).rejects.toThrow('分页');
    expect(f.mutate).not.toHaveBeenCalled();
  });

  it('holds a reservation throughout safety reads, refusing another device send, resume, or duplicate delete', async () => {
    const f = fixture(); const gate = deferred<unknown>();
    f.read.mockImplementationOnce(() => gate.promise);
    const archive = f.change();
    await expect(f.send()).rejects.toThrow('操作正在进行');
    await expect(f.service.dispatch('bridge/subscribe', { threadId: f.thread.id })).rejects.toThrow('操作正在进行');
    await expect(f.change('thread/delete', { confirm: true })).rejects.toThrow('操作正在进行');
    gate.resolve({ thread: f.thread }); await archive;
    expect(f.mutate).toHaveBeenCalledTimes(1); expect(f.turn).not.toHaveBeenCalled(); expect(f.resume).not.toHaveBeenCalled();
  });

  it('refuses archive while a native send ACK is pending, including the native idle-status race', async () => {
    const f = fixture(); await f.service.dispatch('thread/start', {});
    const gate = deferred<unknown>(); f.turn.mockImplementationOnce(() => gate.promise);
    const pending = f.send();
    await expect(f.change()).rejects.toThrow('操作正在进行');
    gate.resolve({ turn: { id: 'turn', status: 'inProgress' } }); await pending;
    await vi.waitFor(() => expect(f.resume).toHaveBeenCalled());
    await expect(f.change()).rejects.toThrow(/运行中|操作正在进行/);
    expect(f.mutate).not.toHaveBeenCalled();
  });

  it('refuses archive while a resume or background permission read is outstanding', async () => {
    const f = fixture(); const gate = deferred<unknown>(); f.resume.mockImplementationOnce(() => gate.promise);
    const pending = f.service.dispatch('bridge/subscribe', { threadId: f.thread.id });
    await vi.waitFor(() => expect(f.resume).toHaveBeenCalled());
    await expect(f.change()).rejects.toThrow('操作正在进行');
    gate.resolve({ thread: f.thread }); await pending;
    expect(f.mutate).not.toHaveBeenCalled();
  });

  it('does not let an older list response overwrite a completed archive or unlock resume', async () => {
    const f = fixture(); const gate = deferred<unknown>();
    f.list.mockImplementationOnce(() => gate.promise);
    const oldList = f.service.dispatch('thread/list', {});
    await f.change(); gate.resolve({ data: [f.thread], nextCursor: null });
    await expect(oldList).rejects.toThrow('状态已变化');
    await expect(f.service.dispatch('bridge/subscribe', { threadId: f.thread.id })).rejects.toThrow('先恢复');
  });

  it('reports unsupported APIs truthfully and preserves explicit native rejection without pretending deletion', async () => {
    const f = fixture(); f.mutate.mockRejectedValueOnce(new NativeRpcError('method not found', -32601));
    await expect(f.change('thread/delete', { confirm: true })).rejects.toThrow('不支持');
    f.mutate.mockRejectedValueOnce(new NativeRpcError('no rollout found', -32600));
    await expect(f.change()).rejects.toThrow('no rollout');
    expect(f.events.filter(e => e.type === 'threadLifecycleChanged')).toEqual([]);
    expect(f.records.has(f.thread.id)).toBe(true);
  });

  it('blocks an unknown archive until a native archived query confirms success, without automatically retrying', async () => {
    const f = fixture(); f.mutate.mockRejectedValueOnce(new Error('response timeout'));
    await expect(f.change()).rejects.toThrow('结果未知');
    expect(f.events.at(-1)).toMatchObject({ type: 'threadLifecycleChanged', state: 'unknown' });
    await f.service.dispatch('thread/list', {});
    await expect(f.change()).rejects.toThrow('结果未知');
    f.records.get(f.thread.id)!.archived = true;
    await f.service.dispatch('thread/list', { archived: true });
    expect(f.events.at(-1)).toMatchObject({ type: 'threadLifecycleChanged', state: 'archived' });
    await expect(f.change('thread/unarchive')).resolves.toMatchObject({ state: 'active' });
    expect(f.mutate).toHaveBeenCalledTimes(2);
  });

  it('treats internal errors and mismatched unarchive responses as unknown lifecycle outcomes', async () => {
    const f = fixture(); f.records.get(f.thread.id)!.archived = true;
    f.mutate.mockResolvedValueOnce({ thread: { ...f.thread, cwd: '/other' } });
    await expect(f.change('thread/unarchive')).rejects.toThrow('结果未知');
    await expect(f.send()).rejects.toThrow('结果未知');
    expect(f.events.at(-1)).toMatchObject({ type: 'threadLifecycleChanged', state: 'unknown' });
    const g = fixture(); g.mutate.mockRejectedValueOnce(new NativeRpcError('storage failed after update', -32603));
    await expect(g.change('thread/delete', { confirm: true })).rejects.toThrow('结果未知');
    expect(g.events.at(-1)).toMatchObject({ type: 'threadLifecycleChanged', state: 'unknown' });
  });

  it('never infers unknown delete success from list absence, but accepts the native deletion notification', async () => {
    const f = fixture(); f.mutate.mockRejectedValueOnce(new Error('connection lost'));
    await expect(f.change('thread/delete', { confirm: true })).rejects.toThrow('结果未知');
    f.records.clear(); await f.service.dispatch('thread/list', {}); await f.service.dispatch('thread/list', { archived: true });
    await expect(f.change('thread/delete', { confirm: true })).rejects.toThrow('结果未知');
    f.codex.emit('message', { method: 'thread/deleted', params: { threadId: f.thread.id } });
    expect(f.events.filter(e => e.type === 'threadLifecycleChanged').at(-1)).toMatchObject({ state: 'deleted' });
    await expect(f.send()).rejects.toThrow('已删除'); expect(f.mutate).toHaveBeenCalledTimes(1);
  });
});

it('validates lifecycle replies without pinning runtime Codex versions', () => {
  for (const method of ['thread/archive', 'thread/delete']) {
    expect(() => validateNativeResponse('future', method, {})).not.toThrow();
    expect(() => validateNativeResponse('future', method, null)).toThrow('incompatible');
  }
  expect(() => validateNativeResponse('future', 'thread/unarchive', {})).toThrow('thread');
});
