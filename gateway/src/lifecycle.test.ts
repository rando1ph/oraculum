import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexError, type NativePage, type NativeThread } from './codex';
import { assertLifecycleInventory } from './lifecycle';

const rootId = 'root';
const cwd = '/project';
const thread = (id = rootId, extras: Partial<NativeThread> = {}): NativeThread => ({
  id, cwd, parentThreadId: null, preview: '', turns: [], status: { type: 'idle' }, ...extras,
});
const page = (data: NativeThread[] = [], nextCursor: string | null = null): NativePage<NativeThread> => ({ data, nextCursor });
const peer = (...pages: NativePage<NativeThread>[]) => ({ listLifecycleThreads: vi.fn()
  .mockImplementation(async () => pages.shift() ?? page()) });

afterEach(() => vi.restoreAllMocks());

describe('bounded native lifecycle inventory preflight', () => {
  it('allows an independent root and checks active plus archived inventories without cwd filtering', async () => {
    const codex = peer(page([thread()]), page([thread('other', { cwd: '/other' })]));
    await expect(assertLifecycleInventory(codex, rootId, cwd)).resolves.toBe('active');
    expect(codex.listLifecycleThreads.mock.calls).toHaveLength(2);
    expect(codex.listLifecycleThreads.mock.calls.map(([options]) => options)).toEqual([
      { archived: false, timeoutMs: expect.any(Number) },
      { archived: true, timeoutMs: expect.any(Number) },
    ]);
    for (const [options] of codex.listLifecycleThreads.mock.calls) expect(options.timeoutMs).toBeLessThanOrEqual(30_000);
  });

  it('returns archived state or absence without treating absence as deletion evidence', async () => {
    await expect(assertLifecycleInventory(peer(page(), page([thread()])), rootId, cwd)).resolves.toBe('archived');
    await expect(assertLifecycleInventory(peer(page(), page()), rootId, cwd)).resolves.toBeUndefined();
  });

  it.each([false, true])('rejects hidden children in archived=%s even outside the root project', async archived => {
    const child = thread('child', { cwd: '/private-other-project', parentThreadId: rootId });
    const codex = peer(page(archived ? [thread()] : [thread(), child]), page(archived ? [child] : []));
    await expect(assertLifecycleInventory(codex, rootId, cwd)).rejects.toMatchObject({ code: 'THREAD_HAS_DEPENDENCIES' });
  });

  it('detects legacy spawn lineage when parentThreadId is missing', async () => {
    const child = thread('child', { parentThreadId: undefined, source: { subAgent: { thread_spawn: { parent_thread_id: rootId } } } });
    await expect(assertLifecycleInventory(peer(page([thread(), child])), rootId, cwd))
      .rejects.toMatchObject({ code: 'THREAD_HAS_DEPENDENCIES' });
  });

  it('rejects direct operations on spawned threads and roots whose cwd has changed', async () => {
    await expect(assertLifecycleInventory(peer(page([thread(rootId, { parentThreadId: 'parent' })])), rootId, cwd))
      .rejects.toMatchObject({ code: 'THREAD_HAS_DEPENDENCIES' });
    await expect(assertLifecycleInventory(peer(page([thread(rootId, { cwd: '/private-outside' })])), rootId, cwd))
      .rejects.toMatchObject({ code: 'PROJECT_UNAVAILABLE', statusCode: 403 });
  });

  it.each([
    { parentThreadId: undefined },
    { parentThreadId: '' },
    { parentThreadId: 123 },
    { parentThreadId: null, source: { subAgent: { thread_spawn: {} } } },
  ])('fails closed on ambiguous native lineage: %j', async extras => {
    await expect(assertLifecycleInventory(peer(page([thread('other', extras)])), rootId, cwd))
      .rejects.toMatchObject({ code: 'LIFECYCLE_LINEAGE_UNVERIFIED' });
  });

  it('accepts explicit parentless native review/compaction sources', async () => {
    const codex = peer(page([thread(), thread('review', { source: { subAgent: 'review' } })]), page());
    await expect(assertLifecycleInventory(codex, rootId, cwd)).resolves.toBe('active');
  });

  it('follows native cursors and refuses looping pagination without exposing native cursor data', async () => {
    const codex = peer(page([], 'native-private-cursor'), page([thread()]), page());
    await expect(assertLifecycleInventory(codex, rootId, cwd)).resolves.toBe('active');
    expect(codex.listLifecycleThreads.mock.calls[1][0]).toMatchObject({ archived: false, cursor: 'native-private-cursor' });
    const looping = peer(page([], 'private-loop'), page([], 'private-loop'));
    const error = await assertLifecycleInventory(looping, rootId, cwd).catch(value => value);
    expect(error).toMatchObject({ code: 'LIFECYCLE_INVENTORY_INCOMPLETE' });
    expect(String(error)).not.toContain('private-loop');
  });

  it('refuses inconsistent root presence across pages or archived states', async () => {
    await expect(assertLifecycleInventory(peer(page([thread()], 'next'), page([thread()])), rootId, cwd))
      .rejects.toMatchObject({ code: 'LIFECYCLE_STATE_CHANGED' });
    await expect(assertLifecycleInventory(peer(page([thread()]), page([thread()])), rootId, cwd))
      .rejects.toMatchObject({ code: 'LIFECYCLE_STATE_CHANGED' });
  });

  it('enforces at most 100 pages for one archived state', async () => {
    let sequence = 0;
    const codex = { listLifecycleThreads: vi.fn(async () => page([], `cursor-${++sequence}`)) };
    await expect(assertLifecycleInventory(codex, rootId, cwd))
      .rejects.toMatchObject({ code: 'LIFECYCLE_INVENTORY_INCOMPLETE' });
    expect(codex.listLifecycleThreads).toHaveBeenCalledTimes(100);
  });

  it('shares one 30-second budget across pages and both archived states', async () => {
    const clock = vi.spyOn(performance, 'now');
    clock.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(12_000)
      .mockReturnValueOnce(12_000).mockReturnValueOnce(30_001);
    const codex = peer(page([thread()]), page());
    await expect(assertLifecycleInventory(codex, rootId, cwd))
      .rejects.toMatchObject({ code: 'LIFECYCLE_INVENTORY_TIMEOUT' });
    expect(codex.listLifecycleThreads.mock.calls.map(([options]) => options.timeoutMs)).toEqual([30_000, 18_000]);
  });

  it('propagates safe adapter failures and sanitizes unexpected inventory failures', async () => {
    const nativeError = new CodexError('NATIVE_TIMEOUT', 'Native inventory timed out', 'rejected');
    const codex = { listLifecycleThreads: vi.fn().mockRejectedValue(nativeError) };
    await expect(assertLifecycleInventory(codex, rootId, cwd)).rejects.toBe(nativeError);
    codex.listLifecycleThreads.mockRejectedValue(new Error('/private/path secret native response'));
    const error = await assertLifecycleInventory(codex, rootId, cwd).catch(value => value);
    expect(error).toMatchObject({ code: 'LIFECYCLE_INVENTORY_UNAVAILABLE' });
    expect(String(error)).not.toContain('private');
  });
});
