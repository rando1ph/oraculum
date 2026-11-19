import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceState } from '../../contracts/workspace';
import { cacheHistory, ClientStorage, historyEvictions, identityKey, LocalStorageError, mergeCachedHistory, scopeKey, type CachedHistory, type LocalScope } from './local-data';

const scope: LocalScope = { endpoint: 'http://127.0.0.1:7777/', installationId: 'installation', deviceId: 'device', projectId: 'project', threadId: 'thread' };
const turn = (id: string, text = id) => ({ id, status: 'completed', items: [{ id: `${id}-item`, type: 'agentMessage', text }] });
function cached(ids: string[], patch: Partial<CachedHistory> = {}): CachedHistory {
  return { savedAt: 10, streamItems: [], history: { epoch: 'epoch', historyRevision: 'opaque', source: 'native-pagination', complete: true, truncated: false,
    items: ids.map(id => turn(id)), nextCursor: 'older' }, ...patch };
}
function state(): WorkspaceState {
  return { connection: { ...scope, status: 'connected', secureStorage: true, epoch: 'epoch' }, projectId: 'project', threadId: 'thread',
    projects: [], roots: [], streamItems: [], interactions: [], synchronization: 'current', attachments: [], draftId: 'attachment-id', operations: [], busy: false,
    thread: { id: 'thread', projectId: 'project', status: 'idle', title: null, parentThreadId: null,
      permissionReadback: { preset: 'full-access', sandboxType: 'danger-full-access', approvalPolicy: 'never', observedAt: 5, source: 'thread.resume' },
      accessToken: 'never-persist-metadata', cwd: '/private/path' },
    firstTurnReady: true, activeTurnId: 'turn', history: cached(['latest']).history, diff: 'display diff', plan: { turnId: 'latest' }, tokenUsage: { total: 12 } };
}

describe('local data partition and last-known projection', () => {
  it('separates endpoint Base Path, installation, device, project and thread without delimiter collisions', () => {
    const base = scopeKey(scope);
    for (const patch of [{ endpoint: 'http://127.0.0.1:7777/base/' }, { installationId: 'new' }, { deviceId: 'new' }, { projectId: 'new' }, { threadId: 'new' }, { threadId: undefined }]) {
      expect(scopeKey({ ...scope, ...patch })).not.toBe(base);
    }
    expect(scopeKey({ ...scope, projectId: 'a,b', threadId: 'c' })).not.toBe(scopeKey({ ...scope, projectId: 'a', threadId: 'b,c' }));
    expect(scopeKey({ ...scope, threadId: 'null' })).not.toBe(scopeKey({ ...scope, threadId: undefined }));
  });
  it.each(['http://user:password@127.0.0.1/', 'https://example.com/?token=secret', 'https://example.com/#secret', 'file:///tmp/', 'not-a-url', 'http://127.0.0.1:7777'])('refuses unnormalized or credential-bearing endpoint %s', endpoint => {
    expect(() => identityKey({ ...scope, endpoint })).toThrow('LOCAL_STORAGE_INVALID');
  });
  it('accepts normalized HTTPS Base Paths without making a network connection', () => {
    expect(identityKey({ ...scope, endpoint: 'https://example.invalid/client/' })).toContain('/client/');
  });
  it('persists only display facts, dropping every live authority and transport field', () => {
    const source = state(), result = cacheHistory(source, 123);
    expect(Object.keys(result).sort()).toEqual(['diff', 'history', 'plan', 'savedAt', 'streamItems', 'thread', 'tokenUsage']);
    expect(result.thread).toEqual({ id: 'thread', projectId: 'project', status: 'idle', title: null, parentThreadId: null });
    expect(JSON.stringify(result)).not.toMatch(/permissionReadback|accessToken|cwd|firstTurnReady|secureStorage|capabilities|operations/);
    source.history!.items = [];
    expect(result.history?.items).toHaveLength(1);
  });
  it('rejects malformed or duplicate native history instead of offering corrupted offline content', () => {
    const source = state();
    source.history!.items.push(turn('latest'));
    expect(() => cacheHistory(source)).toThrow('LOCAL_STORAGE_INVALID');
    source.history!.items = [{ id: 'turn', status: 'completed', items: [{ type: 'agentMessage', text: 'missing id' }] }];
    expect(() => cacheHistory(source)).toThrow('LOCAL_STORAGE_INVALID');
  });
  it('reports unavailable persistence without falling back to an in-memory success claim', async () => {
    const storage = new ClientStorage();
    await expect(storage.readDraft(scope)).rejects.toEqual(new LocalStorageError('unavailable'));
    await expect(storage.saveDraft(scope, { text: 'retained by caller', model: '', effort: '', permissionPreset: 'auto' }, 0)).rejects.toEqual(new LocalStorageError('unavailable'));
  });
  it('cancels an in-flight open without letting its late callbacks replace a newer connection', async () => {
    const requests: { onsuccess?: () => void; onupgradeneeded?: () => void; result: { close: ReturnType<typeof vi.fn>; createObjectStore: ReturnType<typeof vi.fn> }; transaction: { abort: ReturnType<typeof vi.fn> } }[] = [];
    const factory = { open: vi.fn(() => {
      const request = { result: { close: vi.fn(), createObjectStore: vi.fn() }, transaction: { abort: vi.fn() } };
      requests.push(request); return request;
    }) } as unknown as IDBFactory;
    const storage = new ClientStorage({ factory });
    const obsolete = storage.readDraft(scope);
    const obsoleteCheck = expect(obsolete).rejects.toEqual(new LocalStorageError('unavailable'));
    storage.close();
    const current = storage.readDraft(scope);
    const currentCheck = expect(current).rejects.toEqual(new LocalStorageError('unavailable'));
    await obsoleteCheck;
    // The old rejection cleanup must not invalidate the shared new open promise.
    const joined = storage.readDraft(scope);
    const joinedCheck = expect(joined).rejects.toEqual(new LocalStorageError('unavailable'));
    expect(factory.open).toHaveBeenCalledTimes(2);
    requests[0].onupgradeneeded?.(); requests[0].onsuccess?.();
    expect(requests[0].transaction.abort).toHaveBeenCalledTimes(1);
    expect(requests[0].result.createObjectStore).not.toHaveBeenCalled();
    expect(requests[0].result.close).toHaveBeenCalledTimes(1);
    storage.close(); await Promise.all([currentCheck, joinedCheck]);
  });
});

describe('history cache replacement and pagination', () => {
  it('evicts least recently read history by count, while protecting the current save', () => {
    const entries = Array.from({ length: 34 }, (_, index) => ({ key: String(index), bytes: 1024, accessedAt: index }));
    expect(historyEvictions(entries, '0')).toEqual(['1', '2']);
  });
  it('enforces a byte budget even below the entry count and does not mutate source metadata', () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({ key: String(index), bytes: 8 * 1024 * 1024, accessedAt: 10 - index }));
    expect(historyEvictions(entries, '9')).toEqual(['8', '7']);
    expect(entries[0].key).toBe('0');
    expect(historyEvictions([{ key: 'a', bytes: 1, accessedAt: 0 }], 'a')).toEqual([]);
  });
  it('rejects corrupt eviction metadata rather than guessing which data to delete', () => {
    expect(() => historyEvictions([{ key: 'x', bytes: -1, accessedAt: 0 }], 'other')).toThrow('LOCAL_STORAGE_CORRUPT');
  });
  it('keeps loaded old pages through a fresh same-revision tail snapshot and replaces overlap once', () => {
    const previous = cached(['one', 'two', 'three']);
    previous.history!.nextCursor = 'oldest-page-cursor';
    const incoming = cached(['two', 'three'], { savedAt: 20 });
    incoming.history!.items[1] = turn('three', 'new terminal text');
    const merged = mergeCachedHistory(previous, incoming);
    expect(merged.history?.items).toEqual([turn('one'), turn('two'), turn('three', 'new terminal text')]);
    expect(merged.history?.nextCursor).toBe('oldest-page-cursor');
    expect(previous.history?.items).toEqual(['one', 'two', 'three'].map(id => turn(id)));
  });
  it('uses the newly loaded older page cursor when incoming has the entire retained window', () => {
    const previous = cached(['two', 'three']), incoming = cached(['one', 'two', 'three'], { savedAt: 20 });
    incoming.history!.nextCursor = null;
    expect(mergeCachedHistory(previous, incoming).history?.nextCursor).toBeNull();
  });
  it.each(['epoch', 'historyRevision'] as const)('discards pages, cursors and event-only facts on changed %s', field => {
    const previous = cached(['old'], { plan: { turnId: 'old' }, diff: 'old', tokenUsage: { total: 1 } }), incoming = cached(['new'], { savedAt: 20 });
    incoming.history![field] = 'a-lexically-earlier-opaque-token';
    const merged = mergeCachedHistory(previous, incoming);
    expect(merged.history?.items).toEqual([turn('new')]);
    expect(merged).not.toHaveProperty('diff');
    expect(merged).not.toHaveProperty('plan');
    expect(merged).not.toHaveProperty('tokenUsage');
  });
  it('treats wall-clock time as display metadata, so a clock correction cannot reject a fresh capture', () => {
    const previous = cached(['one'], { savedAt: 20 });
    const incoming = cached(['one'], { savedAt: 10 }); incoming.history!.items[0] = turn('one', 'new terminal text');
    expect(mergeCachedHistory(previous, incoming).history?.items).toEqual(incoming.history?.items);
    incoming.history!.historyRevision = 'new-revision';
    expect(mergeCachedHistory(previous, incoming)).toEqual(incoming);
  });
  it('retains explicit last-known inspector facts only within one unchanged revision', () => {
    const previous = cached(['one'], { plan: { turnId: 'one' }, diff: 'last-known', tokenUsage: { total: 3 } });
    const merged = mergeCachedHistory(previous, cached(['one'], { savedAt: 20 }));
    expect(merged.diff).toBe('last-known');
    expect(merged.plan).toEqual({ turnId: 'one' });
    expect(merged.tokenUsage).toEqual({ total: 3 });
  });
  it('never concatenates previous stream deltas or different-thread history as a baseline', () => {
    const previous = cached(['one'], { streamItems: [{ turnId: 'live', item: { id: 'live-item', type: 'agentMessage', text: 'partial' } }] });
    const incoming = cached(['one'], { savedAt: 20, streamItems: [{ turnId: 'live', item: { id: 'live-item', type: 'agentMessage', text: 'authoritative replacement' } }] });
    expect(mergeCachedHistory(previous, incoming).streamItems).toEqual(incoming.streamItems);
    previous.thread = { id: 'first', projectId: 'project', status: 'idle' };
    incoming.thread = { id: 'second', projectId: 'project', status: 'idle' };
    expect(mergeCachedHistory(previous, incoming)).toEqual(incoming);
  });
  it('bounds retained native items and visibly marks a shortened cache', () => {
    const previous = cached(Array.from({ length: 2000 }, (_, index) => `old-${index}`));
    previous.history!.itemCursors = { 'old-0-item': 'removed', 'old-1-item': 'retained' };
    previous.history!.itemTimings = { 'old-0-item': { startedAtMs: 1 }, 'old-1-item': { startedAtMs: 2 } };
    const merged = mergeCachedHistory(previous, cached(['latest'], { savedAt: 20 }));
    expect(merged.history?.items).toHaveLength(2000);
    expect(merged.history?.truncated).toBe(true);
    expect(merged.history?.nextCursor).toBeNull();
    expect(merged.history?.itemCursors).toEqual({ 'old-1-item': 'retained' });
    expect(merged.history?.itemTimings).toEqual({ 'old-1-item': { startedAtMs: 2 } });
    expect((merged.history!.items.at(-1) as { id: string }).id).toBe('latest');
  });
});
