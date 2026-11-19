import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceAction, WorkspaceState } from '../contracts/workspace';
import type { CachedHistory, CachedNavigation, DraftContent, DraftReceipt, LocalIdentity, LocalScope, PersistedDraft, ReadingPosition } from './persistence/types';
import type { LocalStorageError as StorageErrorType } from './persistence/types';
let LocalStorageError: typeof StorageErrorType;

const identity: LocalIdentity = { endpoint: 'http://127.0.0.1:7777/', installationId: 'fixture-install', deviceId: 'fixture-device' };
const scopeKey = (scope: LocalScope) => JSON.stringify([scope.endpoint, scope.installationId, scope.deviceId, scope.projectId, scope.threadId]);
const identityKey = (scope: LocalIdentity) => JSON.stringify([scope.endpoint, scope.installationId, scope.deviceId]);
const copy = <T,>(value: T): T => structuredClone(value);
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settleMicrotasks() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function state(threadId = 'a', patch: Partial<WorkspaceState> = {}): WorkspaceState {
  return { connection: { status: 'connected', ...identity, epoch: 'epoch', secureStorage: true }, localScope: identity,
    projects: [{ id: 'project', name: 'Fixture', rootId: 'root', available: true }], roots: [], projectId: 'project', threadId,
    thread: { id: threadId, projectId: 'project', status: 'idle', archived: false },
    threads: { threads: ['a', 'b'].map(id => ({ id, projectId: 'project', status: 'idle', archived: false })), source: 'fixture', nextCursor: null, truncated: false },
    history: { epoch: 'epoch', historyRevision: 'revision', source: 'native-pagination', nextCursor: null, complete: true, truncated: false,
      items: [{ id: `turn-${threadId}`, status: 'completed', items: [{ id: `item-${threadId}`, type: 'agentMessage', text: `Fixture ${threadId}` }] }] },
    streamItems: [], interactions: [], synchronization: 'current', attachments: [], draftId: 'upload-batch', operations: [], busy: false, ...patch };
}
function offline(thread = 'a', patch: Partial<WorkspaceState> = {}) { return state(thread, { connection: { status: 'offline', ...identity, secureStorage: true }, synchronization: 'stale', ...patch }); }
function cached(thread = 'a'): CachedHistory { const value = state(thread); return { savedAt: 123, history: value.history, thread: value.thread, streamItems: [] }; }

/** Deterministic storage boundary: actual IndexedDB durability/migration has its own Chromium suite. */
class MemoryStorage {
  navigation = new Map<string, CachedNavigation>(); histories = new Map<string, CachedHistory>(); drafts = new Map<string, PersistedDraft>();
  readNavigation = vi.fn(async (id: LocalIdentity) => copy(this.navigation.get(identityKey(id))));
  saveNavigation = vi.fn(async (id: LocalIdentity, nav: CachedNavigation) => { this.navigation.set(identityKey(id), copy(nav)); });
  readPreferences = vi.fn(async () => undefined); savePreferences = vi.fn(async () => {});
  readHistory = vi.fn(async (scope: LocalScope) => copy(this.histories.get(scopeKey(scope))));
  saveHistory = vi.fn(async (scope: LocalScope, history: CachedHistory) => { this.histories.set(scopeKey(scope), copy(history)); });
  readReading = vi.fn(async (_scope: LocalScope): Promise<ReadingPosition | undefined> => undefined);
  saveReading = vi.fn(async (_scope: LocalScope, _position: ReadingPosition) => {}); clearHistory = vi.fn(async () => { this.histories.clear(); }); close = vi.fn();
  readDraft = vi.fn(async (scope: LocalScope) => copy(this.drafts.get(scopeKey(scope))));
  saveDraft = vi.fn(async (scope: LocalScope, content: DraftContent, expected: number) => {
    const previous = this.drafts.get(scopeKey(scope));
    if ((previous?.revision ?? 0) !== expected) throw new LocalStorageError('conflict');
    const next: PersistedDraft = { ...content, clientDraftId: previous?.clientDraftId ?? '11111111-1111-4111-8111-111111111111', revision: expected + 1,
      updatedAt: 123, ...(previous?.submission ? { submission: previous.submission } : {}) };
    this.drafts.set(scopeKey(scope), copy(next)); return copy(next);
  });
  beginSubmission = vi.fn(async (scope: LocalScope, revision: number) => {
    const previous = this.drafts.get(scopeKey(scope));
    if (!previous || previous.revision !== revision) throw new LocalStorageError('conflict');
    if (previous.submission?.status === 'pending') throw new LocalStorageError('pending');
    const next: PersistedDraft = { ...previous, submission: { revision, status: 'pending' } }; this.drafts.set(scopeKey(scope), copy(next)); return copy(next);
  });
  releaseSubmission = vi.fn(async (scope: LocalScope, proof: { clientDraftId: string; draftRevision: number }) => {
    const previous = this.drafts.get(scopeKey(scope));
    if (!previous || previous.clientDraftId !== proof.clientDraftId || previous.submission?.revision !== proof.draftRevision || previous.submission.operationId) throw new LocalStorageError('conflict');
    const { submission: _submission, ...content } = previous;
    const next = { ...content, revision: previous.revision === proof.draftRevision ? previous.revision + 1 : previous.revision };
    this.drafts.set(scopeKey(scope), copy(next)); return copy(next);
  });
  settleSubmission = vi.fn(async (scope: LocalScope, receipt: DraftReceipt) => {
    const previous = this.drafts.get(scopeKey(scope));
    if (!previous || previous.clientDraftId !== receipt.clientDraftId || previous.submission?.revision !== receipt.draftRevision) throw new LocalStorageError('conflict');
    const terminal = receipt.status === 'accepted' || receipt.status === 'rejected', same = previous.revision === receipt.draftRevision;
    const next: PersistedDraft = { ...previous, text: same && receipt.status === 'accepted' ? '' : previous.text,
      revision: terminal && same ? previous.revision + 1 : previous.revision,
      submission: { revision: receipt.draftRevision, operationId: receipt.operationId, status: terminal ? receipt.status as 'accepted' | 'rejected' : 'pending' } };
    this.drafts.set(scopeKey(scope), copy(next)); return copy(next);
  });
}
let storage: MemoryStorage;
let api: typeof import('./store');
let invoke: ReturnType<typeof vi.fn<(action: WorkspaceAction) => Promise<WorkspaceState>>>;
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  ({ LocalStorageError } = await import('./persistence/types')); storage = new MemoryStorage();
  vi.doMock('./persistence/local-data', async original => ({ ...await original<object>(), ClientStorage: class { constructor() { return storage; } } }));
  invoke = vi.fn(async () => state()); vi.stubGlobal('window', { oraculumDesktop: { workspaceAction: invoke } });
  api = await import('./store');
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.doUnmock('./persistence/local-data'); });
async function initialize(value = state()) { api.useWorkspace.getState().receive(value); await settleMicrotasks(); }
async function edit(text: string) { const key = api.draftKey(api.useWorkspace.getState().workspace!); api.useWorkspace.getState().setDraft(key, { text }); await settleMicrotasks(); return key; }

describe('Desktop persistence orchestration races', () => {
  it('persists both visited conversations when selection changes inside one cache debounce', async () => {
    await initialize(); api.useWorkspace.getState().receive(state('b')); await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(550);
    expect(storage.saveHistory.mock.calls.map(([scope]) => scope.threadId).sort()).toEqual(['a', 'b']);
  });
  it('keeps the user-selected offline conversation when main repeats its last online selection', async () => {
    await initialize(offline()); await api.useWorkspace.getState().act({ type: 'selectThread', threadId: 'b' });
    api.useWorkspace.getState().receive(offline());
    expect(api.useWorkspace.getState().workspace?.threadId).toBe('b'); expect(api.useWorkspace.getState().cached).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });
  it('uses current connection metadata when a delayed offline history read completes', async () => {
    await initialize(offline()); const gate = deferred<CachedHistory | undefined>(); storage.readHistory.mockImplementationOnce(() => gate.promise);
    const open = api.useWorkspace.getState().act({ type: 'selectThread', threadId: 'b' }); await settleMicrotasks();
    const operation = { operationId: '22222222-2222-4222-8222-222222222222', kind: 'turn.start', status: 'unknown' as const, createdAt: 1, projectId: 'project', threadId: 'a' };
    api.useWorkspace.getState().receive(offline('a', { operations: [operation] })); gate.resolve(cached('b')); await open;
    expect(api.useWorkspace.getState().workspace?.operations).toEqual([operation]);
  });
  it('rejects a late history result after the endpoint identity changes', async () => {
    await initialize(offline()); const gate = deferred<CachedHistory | undefined>(); storage.readHistory.mockImplementationOnce(() => gate.promise);
    const open = api.useWorkspace.getState().act({ type: 'selectThread', threadId: 'b' }); await settleMicrotasks();
    const next = { ...identity, deviceId: 'other-device' }; api.useWorkspace.getState().receive(offline('a', { localScope: next, connection: { ...offline().connection, deviceId: next.deviceId } }));
    gate.resolve(cached('b')); await open; await settleMicrotasks();
    expect(api.useWorkspace.getState().workspace?.localScope?.deviceId).toBe('other-device');
    expect(api.useWorkspace.getState().workspace?.threadId).not.toBe('b');
  });
  it('retains last selection through a slow connected startup with no hydrated project yet', async () => {
    const nav: CachedNavigation = { savedAt: 1, projects: state().projects, threadsByProject: { project: state().threads! }, projectId: 'project', threadId: 'b' };
    storage.navigation.set(identityKey(identity), nav);
    await initialize(offline('', { projectId: undefined, threadId: undefined, thread: undefined, history: undefined, projects: [], threads: undefined }));
    api.useWorkspace.getState().receive(state('', { busy: true, projectId: undefined, threadId: undefined, thread: undefined, history: undefined, projects: [], threads: undefined }));
    await vi.advanceTimersByTimeAsync(600);
    expect(storage.navigation.get(identityKey(identity))?.projectId).toBe('project');
    expect(storage.navigation.get(identityKey(identity))?.threadId).toBe('b');
  });
  it('does not carry the previous thread into a newly selected project with no selected thread', async () => {
    await initialize(); await api.useWorkspace.getState().flush();
    api.useWorkspace.getState().receive(state('', { projectId: 'other-project', threadId: undefined, thread: undefined, history: undefined, threads: { threads: [], nextCursor: null, truncated: false, source: 'fixture' } }));
    await api.useWorkspace.getState().flush();
    const nav = storage.navigation.get(identityKey(identity)); expect(nav?.projectId).toBe('other-project'); expect(nav?.threadId).toBeUndefined();
  });
  it('waits for a queued durable draft transaction before acknowledging window close', async () => {
    await initialize(); const gate = deferred<void>(), original = storage.saveDraft.getMockImplementation()!;
    storage.saveDraft.mockImplementationOnce(async (...args) => { await gate.promise; return original(...args); });
    api.useWorkspace.getState().setDraft(api.draftKey(state()), { text: 'must survive close' });
    let closed = false; const flush = api.useWorkspace.getState().flush().then(value => { closed = true; return value; });
    await settleMicrotasks(); expect(closed).toBe(false); gate.resolve(); expect(await flush).toBe(true);
    expect([...storage.drafts.values()][0].text).toBe('must survive close');
  });
  it('does not clear newer editing when the previous submitted version is accepted', async () => {
    await initialize(); const key = await edit('submitted'); const reply = deferred<WorkspaceState>(); invoke.mockReturnValueOnce(reply.promise);
    const sending = api.useWorkspace.getState().sendDraft(); await settleMicrotasks(); expect(invoke).toHaveBeenCalledTimes(1);
    const action = invoke.mock.calls[0][0]; if (action.type !== 'send') throw new Error('Expected send');
    await edit('new unsent text');
    reply.resolve(state('a', { operations: [{ operationId: '22222222-2222-4222-8222-222222222222', kind: 'turn.start', projectId: 'project', threadId: 'a', status: 'accepted', createdAt: 1, clientDraftId: action.clientDraftId, draftRevision: action.draftRevision }] }));
    await sending; await settleMicrotasks();
    expect(api.useWorkspace.getState().drafts[key].text).toBe('new unsent text'); expect([...storage.drafts.values()][0].text).toBe('new unsent text');
  });
  it('dispatches the committed submission snapshot when typing continues during its storage transaction', async () => {
    await initialize(); const key = await edit('committed submission text');
    const gate = deferred<void>(), originalBegin = storage.beginSubmission.getMockImplementation()!;
    storage.beginSubmission.mockImplementationOnce(async (...args) => { await gate.promise; return originalBegin(...args); });
    const reply = deferred<WorkspaceState>(); invoke.mockReturnValueOnce(reply.promise);
    const sending = api.useWorkspace.getState().sendDraft(); await settleMicrotasks();
    api.useWorkspace.getState().setDraft(key, { text: 'typed while preparing' }); gate.resolve(); await settleMicrotasks();
    const action = invoke.mock.calls[0][0]; if (action.type !== 'send') throw new Error('Expected send');
    expect(action.text).toBe('committed submission text'); expect(action.draftRevision).toBe(1);
    reply.resolve(state('a', { operations: [{ operationId: '22222222-2222-4222-8222-222222222222', kind: 'turn.start', projectId: 'project', threadId: 'a', status: 'accepted', createdAt: 1, clientDraftId: action.clientDraftId, draftRevision: action.draftRevision }] }));
    await sending; await settleMicrotasks();
    expect(api.useWorkspace.getState().drafts[key].text).toBe('typed while preparing');
    expect([...storage.drafts.values()][0].text).toBe('typed while preparing');
  });
  it('keeps a lost IPC result pending and never automatically sends it again', async () => {
    await initialize(); const key = await edit('uncertain submission'); invoke.mockRejectedValueOnce(new Error('IPC lost'));
    await api.useWorkspace.getState().sendDraft(); api.useWorkspace.getState().receive(state()); await settleMicrotasks();
    await api.useWorkspace.getState().sendDraft();
    expect(invoke.mock.calls.filter(([action]) => action.type === 'send')).toHaveLength(1);
    expect(api.useWorkspace.getState().drafts[key].text).toBe('uncertain submission'); expect(api.useWorkspace.getState().draftStatus[key]).toBe('pending');
  });
  it('saves a late unmount bookmark under its original scope without moving the current conversation', async () => {
    await initialize(); const keyA = api.draftKey(state());
    api.useWorkspace.getState().receive(state('b')); await settleMicrotasks();
    const position = { itemKey: 'old-item-a', offset: 42, atBottom: false, historyRevision: 'revision', updatedAt: 4 };
    api.useWorkspace.getState().setReading(position, keyA); await api.useWorkspace.getState().flush();
    expect(storage.saveReading).toHaveBeenCalledWith({ ...identity, projectId: 'project', threadId: 'a' }, position);
    expect(api.useWorkspace.getState().workspace?.threadId).toBe('b'); expect(api.useWorkspace.getState().reading).toBeUndefined();
  });
  it('never grants writes or turn control to a cached projection even if it carries connected-looking fields', async () => {
    const cachedState = { ...state(), localOnly: true, firstTurnReady: true, activeTurnId: 'active',
      capabilities: { capabilities: [{ name: 'turn.steer', supported: true, availability: 'available' }] } as WorkspaceState['capabilities'] };
    expect(api.canWrite(cachedState)).toBe(false); expect(api.canWriteScope(cachedState, 'identity')).toBe(false);
    expect(api.canWriteScope(cachedState, 'project')).toBe(false); expect(api.canSendFirstTurn(cachedState)).toBe(false);
    expect(api.canControlTurn(cachedState, 'steer')).toBe(false);
  });
  it('does not overwrite a conflicting durable draft when retrying local storage', async () => {
    await initialize(); const key = await edit('my previous edit');
    const storedKey = scopeKey({ ...identity, projectId: 'project', threadId: 'a' });
    const concurrent = { ...storage.drafts.get(storedKey)!, revision: 10, text: 'other newer editor' }; storage.drafts.set(storedKey, concurrent);
    await edit('my unsaved edit'); expect(api.useWorkspace.getState().draftStatus[key]).toBe('error');
    await api.useWorkspace.getState().retryLocal(); await settleMicrotasks();
    expect(storage.drafts.get(storedKey)?.text).toBe('other newer editor'); expect(api.useWorkspace.getState().drafts[key].text).toBe('my unsaved edit');
    expect(await api.useWorkspace.getState().flush()).toBe(false);
  });
  it('coalesces simultaneous send clicks before preparing the durable submission', async () => {
    await initialize(); const key = await edit('send once'); const reply = deferred<WorkspaceState>(); invoke.mockReturnValueOnce(reply.promise);
    const first = api.useWorkspace.getState().sendDraft(), second = api.useWorkspace.getState().sendDraft(); await settleMicrotasks();
    expect(storage.beginSubmission).toHaveBeenCalledTimes(1); expect(api.useWorkspace.getState().draftStatus[key]).toBe('pending');
    const action = invoke.mock.calls[0][0]; if (action.type !== 'send') throw new Error('Expected send');
    reply.resolve(state('a', { operations: [{ operationId: '22222222-2222-4222-8222-222222222222', kind: 'turn.start', projectId: 'project', threadId: 'a', status: 'accepted', createdAt: 1, clientDraftId: action.clientDraftId, draftRevision: action.draftRevision }] }));
    await Promise.all([first, second]); expect(invoke.mock.calls.filter(([value]) => value.type === 'send')).toHaveLength(1);
  });
  it('permits an explicit refresh to retry a failed read-only missing-dispatch check', async () => {
    const draft: PersistedDraft = { text: 'crashed before dispatch', model: '', effort: '', permissionPreset: '', clientDraftId: '11111111-1111-4111-8111-111111111111', revision: 1, updatedAt: 1, submission: { revision: 1, status: 'pending' } };
    storage.drafts.set(scopeKey({ ...identity, projectId: 'project', threadId: 'a' }), draft);
    let checks = 0;
    invoke.mockImplementation(async action => {
      if (action.type === 'checkDraft') {
        if (++checks === 1) throw new Error('one lost read-only IPC');
        return state('a', { draftDispatch: { clientDraftId: draft.clientDraftId, draftRevision: 1, status: 'not-dispatched' } });
      }
      return state();
    });
    await initialize(); await settleMicrotasks(); expect(checks).toBe(1);
    await api.useWorkspace.getState().act({ type: 'refresh' }); await settleMicrotasks();
    expect(checks).toBe(2); expect(api.useWorkspace.getState().draftStatus[api.draftKey(state())]).toBe('saved');
    expect(api.useWorkspace.getState().drafts[api.draftKey(state())].text).toBe('crashed before dispatch');
    expect(invoke.mock.calls.some(([action]) => action.type === 'send')).toBe(false);
  });
  it('keeps a quota-failed draft in memory, prevents sends, and refuses silent close', async () => {
    await initialize(); storage.saveDraft.mockRejectedValueOnce(new LocalStorageError('quota'));
    const key = await edit('retain this edit'); await api.useWorkspace.getState().sendDraft();
    expect(api.useWorkspace.getState().drafts[key].text).toBe('retain this edit'); expect(invoke).not.toHaveBeenCalled(); expect(await api.useWorkspace.getState().flush()).toBe(false);
  });
});
