import { create } from 'zustand';
import type { Interaction } from '../../../../packages/gateway-protocol/src/index';
import type { WorkspaceAction, WorkspaceState } from '../contracts/workspace';
import { ClientStorage, mergeCachedHistory } from './persistence/local-data';
import { LocalStorageError, type CachedHistory, type CachedNavigation, type DraftContent, type LocalIdentity, type LocalScope, type PersistedDraft, type ReadingPosition, type LocalPreferences } from './persistence/types';

export type Draft = DraftContent;
const emptyDraft: Draft = { text: '', model: '', effort: '', permissionPreset: '' };
const defaultUi: LocalPreferences = { navigationWidth: 256, inspectorWidth: 344, navigationVisible: true };
export type DisplayWorkspace = WorkspaceState & { localOnly?: boolean; lastKnownInspector?: boolean };
type DraftStatus = 'loading' | 'saved' | 'saving' | 'pending' | 'error';
type Store = {
  workspace: DisplayWorkspace | null; pending: boolean; error: string; drafts: Record<string, Draft>;
  draftStatus: Record<string, DraftStatus>; localStatus: 'loading' | 'ready' | 'saving' | 'error'; localError: string;
  cached: boolean; cachedAt?: number; reading?: ReadingPosition; readingReady: boolean; ui: LocalPreferences;
  receive: (state: WorkspaceState) => void; setDraft: (key: string, patch: Partial<Draft>) => void;
  clearError: () => void; act: (action: WorkspaceAction) => Promise<WorkspaceState | undefined>;
  sendDraft: (steer?: boolean) => Promise<void>; setReading: (reading: ReadingPosition, scopeKey: string) => void;
  patchUi: (patch: Partial<LocalPreferences>) => void; clearHistory: () => Promise<void>;
  retryLocal: () => Promise<void>; flush: () => Promise<boolean>;
  recheckDraft: () => Promise<void>;
};
let storage: ClientStorage | undefined;
function db(): ClientStorage { return storage ??= new ClientStorage(); }
let eventRevision = 0, selectionRevision = 0;
let raw: WorkspaceState | null = null, activeIdentity = '', restoredIdentity = '';
let navigation: CachedNavigation | undefined;
const records = new Map<string, PersistedDraft>();
const scopes = new Map<string, LocalScope>();
const writes = new Map<string, Promise<unknown>>();
const editVersions = new Map<string, number>();
const draftFaults = new Map<string, string>();
const historyMemory = new Map<string, CachedHistory>();
let cacheTimer: ReturnType<typeof setTimeout> | undefined;
const pendingCaches = new Map<string, WorkspaceState>();
const cacheWork = new Set<Promise<void>>();
let pausingCache = false;
let hydration: Promise<void> = Promise.resolve();
const checkedDrafts = new Set<string>();
let preparingSend = false;
let restoringSelection = false;
let reconnectSelection: { identity: string; projectId?: string; threadId?: string } | undefined;
let uiRevision = 0;
const pendingReading = new Map<string, { scope: LocalScope; reading: ReadingPosition }>();
let readingTimer: ReturnType<typeof setTimeout> | undefined;
const keyOf = (value: unknown) => JSON.stringify(value);
export function identityOf(state: WorkspaceState): LocalIdentity | undefined {
  if (['revoked', 'pairing', 'idle'].includes(state.connection.status) && !state.localScope) return;
  const scope = state.localScope ?? (state.connection.status === 'connected' && state.connection.installationId && state.connection.deviceId
    ? { endpoint: state.connection.endpoint, installationId: state.connection.installationId, deviceId: state.connection.deviceId } : undefined);
  return scope;
}
function identityKey(identity: LocalIdentity): string { return keyOf([identity.endpoint, identity.installationId, identity.deviceId]); }
function scopeOf(state: WorkspaceState): LocalScope | undefined { const identity = identityOf(state); return identity && state.projectId ? { ...identity, projectId: state.projectId, ...(state.threadId ? { threadId: state.threadId } : {}) } : undefined; }
function scopeKey(scope: LocalScope): string { return keyOf([scope.endpoint, scope.installationId, scope.deviceId, scope.projectId, scope.threadId ?? 'new']); }
export function draftKey(state: WorkspaceState): string { const scope = scopeOf(state); return scope ? scopeKey(scope) : keyOf([state.connection.endpoint, state.connection.installationId, state.connection.deviceId, state.projectId, state.threadId ?? 'new']); }
export function getDraft(state: WorkspaceState, drafts: Store['drafts']): Draft { return drafts[draftKey(state)] ?? emptyDraft; }
function errorMessage(error: unknown): string {
  const code = error instanceof LocalStorageError ? error.code : 'unavailable';
  return ({ quota: '本机存储空间不足。请释放空间后重试；当前草稿仍在窗口中，发送已暂停。', conflict: '草稿已有其他版本。当前编辑仍保留，请复制后重新载入核对。',
    blocked: '本地存储正在被另一个窗口使用。请关闭旧窗口后重试。', version: '本地数据来自较新的版本，请使用兼容版本打开；原数据已保留。',
    corrupt: '部分本地数据无法读取。原数据已保留；可清除历史缓存后重新载入，草稿不会被清除。', pending: '这版草稿的发送结果尚待核实。请核实原操作，不要重复发送。' } as Record<string, string>)[code]
    ?? '本地保存暂时失败。当前草稿仍在窗口中；请重试保存，成功前暂停发送。';
}
function fail(error: unknown, key?: string) {
  if (key) draftFaults.set(key, error instanceof LocalStorageError ? error.code : 'unavailable');
  useWorkspace.setState(s => ({ localStatus: 'error', localError: errorMessage(error), ...(key ? { draftStatus: { ...s.draftStatus, [key]: 'error' } } : {}) }));
}
function enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
  const next = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(job);
  writes.set(key, next); void next.finally(() => { if (writes.get(key) === next) writes.delete(key); }).catch(() => undefined);
  return next;
}
async function persistReading(): Promise<void> {
  const batch = [...pendingReading.entries()]; pendingReading.clear();
  await Promise.all(batch.map(([key, value]) => enqueue(`reading:${key}`, () => db().saveReading(value.scope, value.reading))));
}
async function readBookmark(scope: LocalScope): Promise<ReadingPosition | undefined> {
  const key = scopeKey(scope), pending = pendingReading.get(key);
  if (pending) return pending.reading;
  await writes.get(`reading:${key}`);
  return db().readReading(scope);
}
function setRecord(key: string, value: PersistedDraft | undefined, editVersion: number) {
  if (value) records.set(key, value); else records.delete(key);
  if ((editVersions.get(key) ?? 0) !== editVersion) return;
  draftFaults.delete(key);
  useWorkspace.setState(s => ({ drafts: { ...s.drafts, [key]: value ?? { ...emptyDraft } }, draftStatus: { ...s.draftStatus, [key]: value?.submission?.status === 'pending' ? 'pending' : 'saved' } }));
}
async function loadDraft(scope: LocalScope): Promise<void> {
  const key = scopeKey(scope), editVersion = editVersions.get(key) ?? 0;
  scopes.set(key, scope);
  if (useWorkspace.getState().draftStatus[key]) return;
  useWorkspace.setState(s => ({ draftStatus: { ...s.draftStatus, [key]: 'loading' } }));
  await enqueue(key, async () => { try { setRecord(key, await db().readDraft(scope), editVersion); } catch (error) { fail(error, key); } });
}
async function settle(state: WorkspaceState): Promise<void> {
  const identity = identityOf(state); if (!identity) return;
  for (const operation of state.operations) {
    if (!operation.clientDraftId || operation.draftRevision === undefined || !operation.projectId) continue;
    const scope: LocalScope = { ...identity, projectId: operation.projectId, threadId: operation.threadId }, key = scopeKey(scope);
    const known = records.get(key);
    const settledStatus = ['prepared', 'unknown'].includes(operation.status) ? 'pending' : operation.status;
    if (!known || known.clientDraftId !== operation.clientDraftId || !known.submission || known.submission.revision !== operation.draftRevision
      || known.submission.status === settledStatus && known.submission.operationId === operation.operationId) continue;
    const editVersion = editVersions.get(key) ?? 0;
    await enqueue(key, async () => {
      try {
        const next = await db().settleSubmission(scope, { clientDraftId: operation.clientDraftId!, draftRevision: operation.draftRevision!, operationId: operation.operationId, status: operation.status });
        setRecord(key, next, editVersion);
      } catch (error) { fail(error, key); }
    });
  }
  const proof = state.draftDispatch;
  if (proof?.status === 'not-dispatched') {
    for (const [key, known] of records) {
      const scope = scopes.get(key);
      if (!scope || identityKey(scope) !== identityKey(identity) || known.clientDraftId !== proof.clientDraftId
        || known.submission?.status !== 'pending' || known.submission.revision !== proof.draftRevision || known.submission.operationId) continue;
      const version = editVersions.get(key) ?? 0;
      await enqueue(key, async () => {
        const current = records.get(key);
        if (!current || current.clientDraftId !== proof.clientDraftId || current.submission?.status !== 'pending'
          || current.submission.revision !== proof.draftRevision || current.submission.operationId) return;
        try { setRecord(key, await db().releaseSubmission(scope, proof), version); }
        catch (error) { fail(error, key); }
      });
    }
  }
}
async function checkPendingDraft(): Promise<void> {
  const state = useWorkspace.getState().workspace;
  if (!state || !raw || raw.busy || useWorkspace.getState().pending) return;
  const key = draftKey(state), draft = records.get(key);
  if (!draft?.submission || draft.submission.status !== 'pending') return;
  const check = `${key}:${draft.clientDraftId}:${draft.submission.revision}`;
  if (checkedDrafts.has(check)) return;
  checkedDrafts.add(check);
  await useWorkspace.getState().act({ type: 'checkDraft', clientDraftId: draft.clientDraftId, draftRevision: draft.submission.revision });
}
function cachedView(base: WorkspaceState, nav: CachedNavigation | undefined, scope?: LocalScope, history?: CachedHistory): DisplayWorkspace {
  const { permissionReadback: _permissions, ...thread } = history?.thread ?? {};
  return { connection: base.connection, localScope: identityOf(base), projects: nav?.projects ?? [], roots: [], projectId: scope?.projectId, threadId: scope?.threadId,
    threads: scope ? nav?.threadsByProject[scope.projectId] : undefined, thread: history?.thread ? thread as WorkspaceState['thread'] : undefined,
    history: history?.history, streamItems: history?.streamItems ?? [], plan: history?.plan, diff: history?.diff, tokenUsage: history?.tokenUsage,
    interactions: [], synchronization: 'stale', attachments: [], draftId: '', operations: base.operations, busy: base.busy, localOnly: true };
}
async function openCached(projectId?: string, threadId?: string): Promise<void> {
  const base = raw, identity = base && identityOf(base); if (!base || !identity) return;
  const ticket = ++selectionRevision, id = identityKey(identity);
  const scope = projectId ? { ...identity, projectId, ...(threadId ? { threadId } : {}) } : undefined;
  try {
    const [history, reading] = scope ? await Promise.all([db().readHistory(scope), readBookmark(scope), loadDraft(scope)]).then(([h, r]) => [h, r] as const) : [undefined, undefined];
    if (ticket !== selectionRevision || id !== activeIdentity) return;
    if (history && scope) rememberHistory(scopeKey(scope), history);
    useWorkspace.setState({ workspace: cachedView(raw ?? base, navigation, scope, history), cached: true, cachedAt: history?.savedAt ?? navigation?.savedAt, reading, readingReady: true });
    if (navigation) {
      const selected = { ...navigation, projectId, threadId }; navigation = selected;
      await enqueue(`nav:${id}`, () => db().saveNavigation(identity, selected));
    }
    await settle(base);
    void checkPendingDraft();
  } catch (error) { fail(error); }
}
async function hydrate(identity: LocalIdentity): Promise<void> {
  const id = identityKey(identity), layoutRevision = uiRevision;
  try {
    const [nav, ui] = await Promise.all([db().readNavigation(identity), db().readPreferences()]);
    if (id !== activeIdentity) return;
    navigation = nav;
    useWorkspace.setState({ ...(layoutRevision === uiRevision ? { ui: ui ?? defaultUi } : {}), localStatus: 'ready', localError: '' });
    const current = raw;
    if (!current) return;
    if (current.projectId) { await loadSelection(current); queueCache(current); }
    else if (nav?.projectId) {
      await openCached(nav.projectId, nav.threadId);
      if (raw?.connection.status === 'connected' && !raw.busy) await restoreSelection(identity);
    }
  } catch (error) { fail(error); }
}
async function restoreSelection(identity: LocalIdentity): Promise<void> {
  const id = identityKey(identity), requested = reconnectSelection?.identity === id ? reconnectSelection : undefined, nav = requested ?? navigation;
  if (restoringSelection || !requested && restoredIdentity === id || !nav?.projectId || !raw || raw.busy || useWorkspace.getState().pending || raw.connection.status !== 'connected') return;
  // Only read/select intents are restored; never create or send a turn.
  restoredIdentity = id;
  if (!raw.projects.some(project => project.id === nav.projectId && project.available)) return;
  restoringSelection = true;
  try {
    if (raw.projectId !== nav.projectId) await useWorkspace.getState().act({ type: 'selectProject', projectId: nav.projectId });
    // A saved thread may lie beyond the first list page. Main performs an
    // authorized direct thread read and rejects deleted/inaccessible selections.
    if (nav.threadId && activeIdentity === id && raw?.projectId === nav.projectId && raw.threadId !== nav.threadId)
      await useWorkspace.getState().act({ type: 'selectThread', threadId: nav.threadId });
  } finally { restoringSelection = false; if (reconnectSelection === requested) reconnectSelection = undefined; }
}
async function loadSelection(state: WorkspaceState): Promise<void> {
  const scope = scopeOf(state); if (!scope) return;
  const key = scopeKey(scope), ticket = selectionRevision;
  await loadDraft(scope);
  try {
    const [reading, history] = await Promise.all([readBookmark(scope), db().readHistory(scope)]);
    if (history) rememberHistory(key, history);
    if (ticket === selectionRevision && useWorkspace.getState().workspace && draftKey(useWorkspace.getState().workspace!) === key) {
      useWorkspace.setState({ reading, readingReady: true, ...(raw && raw.connection.status === 'connected' && draftKey(raw) === key ? { workspace: mergeDisplay(raw) } : {}) });
    }
    await settle(state);
    void checkPendingDraft();
    // Durable clean drafts can be reloaded. Keep unsaved edits and unresolved
    // submissions resident, but do not retain every visited conversation forever.
    const current = useWorkspace.getState();
    const clean = Object.keys(current.drafts).filter(candidate => candidate !== key && current.draftStatus[candidate] === 'saved');
    if (clean.length > 24) {
      const drafts = { ...current.drafts }, statuses = { ...current.draftStatus };
      for (const candidate of clean.slice(0, clean.length - 24)) {
        delete drafts[candidate]; delete statuses[candidate]; records.delete(candidate); scopes.delete(candidate); editVersions.delete(candidate);
      }
      useWorkspace.setState({ drafts, draftStatus: statuses });
    }
  } catch (error) { fail(error); }
}
function queueCache(state: WorkspaceState) {
  if (pausingCache || state.connection.status !== 'connected' || !identityOf(state)) return;
  const scope = scopeOf(state), identity = identityOf(state)!;
  pendingCaches.set(scope ? scopeKey(scope) : identityKey(identity), state);
  if (!cacheTimer) cacheTimer = setTimeout(() => { cacheTimer = undefined; void runCacheWork().catch(fail); }, 500);
}
function runCacheWork(): Promise<void> {
  const task = persistCache(); cacheWork.add(task);
  void task.finally(() => cacheWork.delete(task)).catch(() => undefined);
  return task;
}
function rememberHistory(key: string, history: CachedHistory) {
  historyMemory.delete(key); historyMemory.set(key, history);
  while (historyMemory.size > 6) historyMemory.delete(historyMemory.keys().next().value!);
}
function mergeDisplay(state: WorkspaceState): DisplayWorkspace {
  const scope = scopeOf(state), previous = scope && historyMemory.get(scopeKey(scope));
  if (!previous || !state.history || state.synchronization === 'stale') return state;
  const merged = mergeCachedHistory(previous, { savedAt: Date.now(), thread: state.thread, history: state.history, streamItems: state.streamItems, plan: state.plan, diff: state.diff, tokenUsage: state.tokenUsage });
  const settled = state.synchronization === 'current' && !state.activeTurnId;
  return { ...state, history: merged.history, ...(settled ? { plan: merged.plan, diff: merged.diff, tokenUsage: merged.tokenUsage,
    lastKnownInspector: state.plan === undefined && merged.plan !== undefined || state.diff === undefined && merged.diff !== undefined || state.tokenUsage === undefined && merged.tokenUsage !== undefined } : {}) };
}
async function persistCache(): Promise<void> {
  const batch = [...pendingCaches.values()]; pendingCaches.clear();
  for (const state of batch) {
    const identity = identityOf(state); if (!identity) continue;
    const id = identityKey(identity), scope = scopeOf(state);
    await enqueue(`nav:${id}`, async () => {
      const existing = id === activeIdentity ? navigation : await db().readNavigation(identity);
      const latest = raw && identityOf(raw) && identityKey(identityOf(raw)!) === id ? raw : state;
      const display = useWorkspace.getState().cached && id === activeIdentity ? useWorkspace.getState().workspace : latest;
      const selection = display?.projectId ? { projectId: display.projectId, threadId: display.threadId }
        : { projectId: existing?.projectId, threadId: existing?.threadId };
      const nav: CachedNavigation = { savedAt: Date.now(), projects: latest.busy && !latest.projects.length ? existing?.projects ?? [] : latest.projects,
        threadsByProject: { ...existing?.threadsByProject, ...(state.projectId && state.threads ? { [state.projectId]: state.threads } : {}) },
        ...selection };
      await db().saveNavigation(identity, nav);
      if (id === activeIdentity) navigation = nav;
    });
    if (scope?.threadId && state.history && state.synchronization !== 'stale') {
      await enqueue(`history:${scopeKey(scope)}`, async () => {
        const previous = historyMemory.get(scopeKey(scope)) ?? await db().readHistory(scope);
        const history = mergeCachedHistory(previous, { savedAt: Date.now(), thread: state.thread, history: state.history, streamItems: state.streamItems, plan: state.plan, diff: state.diff, tokenUsage: state.tokenUsage });
        await db().saveHistory(scope, history); rememberHistory(scopeKey(scope), history);
      });
    }
  }
}
export const useWorkspace = create<Store>((set, get) => ({
  workspace: null, pending: false, error: '', drafts: {}, draftStatus: {}, localStatus: 'loading', localError: '', cached: false, readingReady: false, ui: defaultUi,
  receive: state => {
    eventRevision++;
    const previous = raw;
    if (previous && (state.projectId !== previous.projectId || state.threadId !== previous.threadId)) queueCache(previous);
    raw = state;
    const identity = identityOf(state), id = identity ? identityKey(identity) : '';
    const changed = activeIdentity !== id;
    if (changed) { activeIdentity = id; restoredIdentity = ''; navigation = undefined; reconnectSelection = undefined; selectionRevision++; set({ reading: undefined, readingReady: false, cached: false, cachedAt: undefined, localStatus: identity ? 'loading' : 'ready' }); }
    // Cached content may remain visible while an authoritative read is pending,
    // but it is stripped of every capability, permission and interaction.
    const current = get().workspace;
    if (!changed && get().cached && current && previous?.connection.status !== 'connected' && state.connection.status === 'connected')
      reconnectSelection = { identity: id, projectId: current.projectId, threadId: current.threadId };
    if (!changed && get().cached && current && identity && (state.connection.status !== 'connected' || !state.threadId || state.threadId === current.threadId && !state.history))
      set({ workspace: { ...current, connection: state.connection, operations: state.operations, busy: state.busy } });
    else set({ workspace: mergeDisplay(state), cached: false, cachedAt: undefined });
    if (!identity) {
      if (!previous) {
        const revision = uiRevision;
        hydration = db().readPreferences().then(ui => { set({ ...(revision === uiRevision ? { ui: ui ?? defaultUi } : {}), localStatus: 'ready' }); }).catch(fail);
      }
      return;
    }
    if (changed) hydration = hydrate(identity);
    else {
      if (state.projectId !== previous?.projectId || state.threadId !== previous?.threadId) { selectionRevision++; set({ reading: undefined, readingReady: false }); void loadSelection(state); }
      void settle(state);
      queueCache(state);
      if (state.connection.status === 'connected' && (!state.projectId || reconnectSelection) && !state.busy) void hydration.then(() => restoreSelection(identity));
    }
  },
  setDraft: (key, patch) => {
    const content = { ...emptyDraft, ...get().drafts[key], ...patch };
    const version = (editVersions.get(key) ?? 0) + 1; editVersions.set(key, version);
    set(s => ({ drafts: { ...s.drafts, [key]: content }, draftStatus: { ...s.draftStatus, [key]: 'saving' }, localStatus: 'saving' }));
    const scope = scopes.get(key) ?? (get().workspace && scopeOf(get().workspace!));
    if (!scope || scopeKey(scope) !== key) { fail(new LocalStorageError('unavailable'), key); return; }
    scopes.set(key, scope);
    void enqueue(key, async () => {
      try {
        const saved = await db().saveDraft(scope, content, records.get(key)?.revision ?? 0);
        setRecord(key, saved, version);
        if ((editVersions.get(key) ?? 0) === version) set({ localStatus: 'ready', localError: '' });
      } catch (error) { fail(error, key); }
    });
  },
  clearError: () => set({ error: '' }),
  act: async action => {
    if (get().pending || !window.oraculumDesktop) return;
    if (['refresh', 'reconcile', 'reconnect'].includes(action.type)) checkedDrafts.clear();
    if (raw?.connection.status !== 'connected' && ['selectProject', 'selectThread', 'threads'].includes(action.type)) {
      await hydration;
      if (action.type === 'selectProject') await openCached(action.projectId);
      else if (action.type === 'selectThread') await openCached(get().workspace?.projectId, action.threadId);
      else if (action.type === 'threads') {
        const current = get().workspace, page = current?.projectId && navigation?.threadsByProject[current.projectId];
        if (current && page) {
          const search = action.search?.trim().toLocaleLowerCase() ?? '';
          const threads = page.threads.filter(thread => (!search || `${thread.title ?? ''} ${thread.preview ?? ''}`.toLocaleLowerCase().includes(search))
            && (action.archived === undefined || thread.archived === action.archived));
          set({ workspace: { ...current, threads: { ...page, threads, nextCursor: null } } });
        }
      }
      return get().workspace ?? undefined;
    }
    if (get().cached && !['selectProject', 'selectThread', 'threads', 'connect', 'reconnect', 'disconnect', 'logout', 'pair', 'reconcile', 'refresh', 'checkDraft'].includes(action.type)) return;
    set({ pending: true, error: '' });
    const revision = eventRevision;
    try {
      const workspace = await window.oraculumDesktop.workspaceAction(action);
      if (revision === eventRevision) get().receive(workspace);
      // Receipt reconciliation also consumes a returned state when newer events
      // already won the display race. It cannot replace the current projection.
      await settle(workspace);
      return workspace;
    } catch { set({ error: '操作未能完成。请查看连接和操作记录；结果不明时先核实原操作。' }); }
    finally { set({ pending: false }); void checkPendingDraft(); }
  },
  sendDraft: async (steer = false) => {
    const state = get().workspace, scope = state && scopeOf(state);
    if (!state || !scope?.threadId || preparingSend || get().pending || get().cached || !(steer ? canControlTurn(state, 'steer') : canSendFirstTurn(state))) return;
    const key = scopeKey(scope);
    preparingSend = true;
    try {
      await writes.get(key);
      const content = get().drafts[key];
      if (!content?.text.trim() || get().draftStatus[key] !== 'saved' || get().pending || get().cached
        || !get().workspace || draftKey(get().workspace!) !== key) return;
      const version = editVersions.get(key) ?? 0;
      const expectedRevision = records.get(key)?.revision ?? 0;
      const draft = await enqueue(key, () => db().beginSubmission(scope, expectedRevision));
      setRecord(key, draft, version);
      // Recheck selection after durable storage, before crossing the main boundary.
      if (!get().workspace || draftKey(get().workspace!) !== key || get().cached) {
        await get().act({ type: 'checkDraft', clientDraftId: draft.clientDraftId, draftRevision: draft.revision }); return;
      }
      const common = { text: draft.text, clientDraftId: draft.clientDraftId, draftRevision: draft.revision };
      const result = await get().act(steer ? { type: 'steer', ...common } : { type: 'send', ...common,
        ...(draft.model ? { model: draft.model } : {}), ...(draft.effort ? { effort: draft.effort } : {}), ...(draft.permissionPreset ? { permissionPreset: draft.permissionPreset } : {}) });
      if (result) await settle(result);
    } catch (error) { fail(error, key); }
    finally { preparingSend = false; }
  },
  setReading: (reading, key) => {
    const scope = scopes.get(key); if (!scope?.threadId) return;
    // The viewport owns its live anchor. Avoid rerendering the whole workspace
    // or strict disk commits every animation frame while the user scrolls.
    pendingReading.set(key, { scope, reading });
    if (!readingTimer) readingTimer = setTimeout(() => { readingTimer = undefined; void persistReading().catch(fail); }, 200);
  },
  patchUi: patch => {
    uiRevision++;
    const ui = { ...get().ui, ...patch }; set({ ui }); void enqueue('preferences', () => db().savePreferences(ui)).catch(fail);
  },
  clearHistory: async () => {
    const identity = raw && identityOf(raw); if (!identity) return;
    pausingCache = true;
    if (cacheTimer) clearTimeout(cacheTimer); cacheTimer = undefined; pendingCaches.clear();
    if (readingTimer) clearTimeout(readingTimer); readingTimer = undefined; pendingReading.clear();
    try { await Promise.allSettled([...cacheWork]); await Promise.allSettled([...writes.values()]); await db().clearHistory(identity); historyMemory.clear();
      set({ localError: '', localStatus: 'ready' });
      if (raw?.connection.status !== 'connected') await openCached(get().workspace?.projectId ?? navigation?.projectId, get().workspace?.threadId ?? navigation?.threadId);
      else if (get().cached && raw) set({ workspace: cachedView(raw, navigation, scopeOf(get().workspace!)), cachedAt: undefined });
    } catch (error) { fail(error); }
    finally { pausingCache = false; }
  },
  retryLocal: async () => {
    // Retry the user's retained edits; never send them as part of recovery.
    storage?.close(); storage = undefined; set({ localError: '', localStatus: 'loading' });
    for (const [key, status] of Object.entries(get().draftStatus)) if (status === 'error') {
      const scope = scopes.get(key); if (!scope) continue;
      if (['conflict', 'corrupt', 'version'].includes(draftFaults.get(key) ?? '')) { fail(new LocalStorageError(draftFaults.get(key) as 'conflict' | 'corrupt' | 'version'), key); continue; }
      try { get().setDraft(key, get().drafts[key]); await writes.get(key); } catch (error) { fail(error, key); }
    }
    const identity = raw && identityOf(raw); if (identity) await hydrate(identity);
  },
  recheckDraft: async () => { checkedDrafts.clear(); await checkPendingDraft(); },
  flush: async () => {
    pausingCache = true;
    if (cacheTimer) clearTimeout(cacheTimer); cacheTimer = undefined;
    if (readingTimer) clearTimeout(readingTimer); readingTimer = undefined;
    try {
      await hydration; await persistReading(); await runCacheWork(); await Promise.all([...cacheWork]);
      // A batch schedules further transactions after each await. Wait for its
      // producer as well as the individual writes before acknowledging close.
      while (writes.size || pendingReading.size) { await persistReading(); await Promise.all([...writes.values()]); }
      return !Object.values(get().draftStatus).some(status => status === 'error' || status === 'saving' || status === 'loading');
    }
    catch (error) { fail(error); return false; }
    finally { pausingCache = false; }
  },
}));
export function hasPendingOperation(state: WorkspaceState, scope: 'thread' | 'project' | 'identity' = 'thread'): boolean {
  return state.operations.some(operation => ['prepared', 'unknown'].includes(operation.status)
    && (scope === 'identity' || !operation.projectId || operation.projectId === state.projectId)
    && (scope !== 'thread' || !operation.threadId || operation.threadId === state.threadId));
}
export function canUseCapability(state: WorkspaceState, name: string): boolean {
  const capability = state.capabilities?.capabilities.find(item => item.name === name);
  return !!capability?.supported && ['available', 'unverified'].includes(capability.availability);
}
export function canWrite(state: WorkspaceState): boolean {
  return !(state as DisplayWorkspace).localOnly && state.connection.status === 'connected' && state.synchronization === 'current' && !state.busy && !hasPendingOperation(state);
}
export function canWriteScope(state: WorkspaceState, scope: 'project' | 'identity'): boolean {
  // No thread snapshot exists before selection. These intents are scoped to a
  // project/identity and are still checked against the durable journal in main.
  return !(state as DisplayWorkspace).localOnly && state.connection.status === 'connected' && !state.busy && !hasPendingOperation(state, scope);
}
export function canSendFirstTurn(state: WorkspaceState): boolean {
  if ((state as DisplayWorkspace).localOnly) return false;
  // An omitted archived field is unknown, not an unarchived thread. Only a
  // verified fresh-thread permit can bridge that absence for the first Turn.
  if (state.thread?.archived === true || state.thread?.archived !== false && state.firstTurnReady !== true) return false;
  return canWrite(state) || state.firstTurnReady === true && state.connection.status === 'connected' && !state.busy && !hasPendingOperation(state);
}
function liveNativeState(state: WorkspaceState, pending: boolean): boolean {
  return !(state as DisplayWorkspace).localOnly && state.connection.status === 'connected' && state.synchronization !== 'stale' && !state.busy && !pending;
}
export function canControlTurn(state: WorkspaceState, action: 'interrupt' | 'steer', pending = false): boolean {
  if (!liveNativeState(state, pending) || !state.projectId || !state.threadId || !state.activeTurnId || !canUseCapability(state, `turn.${action}`)) return false;
  if (action === 'steer') return state.thread?.archived === false && !hasPendingOperation(state);
  // Stopping an observed active Turn is a safety exception. Other unresolved
  // writes must not prevent it, but an unresolved Stop is never sent again.
  return !state.operations.some(operation => operation.kind === 'turn.interrupt' && ['prepared', 'unknown'].includes(operation.status)
    && (!operation.projectId || operation.projectId === state.projectId) && (!operation.threadId || operation.threadId === state.threadId));
}
export function hasPendingInteractionResponse(state: WorkspaceState, interaction: Interaction): boolean {
  return state.operations.some(operation => operation.kind === 'interaction.respond' && ['prepared', 'unknown'].includes(operation.status)
    && (!operation.projectId || operation.projectId === interaction.projectId) && (!operation.threadId || operation.threadId === interaction.threadId));
}
export function canAnswerInteraction(state: WorkspaceState, interaction: Interaction, pending = false): boolean {
  if (!liveNativeState(state, pending) || !canUseCapability(state, 'interactions') || interaction.status !== 'pending'
    || interaction.epoch !== state.connection.epoch || interaction.projectId !== state.projectId || interaction.threadId !== state.threadId
    || hasPendingInteractionResponse(state, interaction)) return false;
  // A current pending interaction is actionable during an active Turn even
  // though its evolving history cannot yet be a settled/current snapshot.
  return state.interactions.some(current => current.interactionId === interaction.interactionId && current.status === 'pending'
    && current.generation === interaction.generation && current.epoch === interaction.epoch
    && current.projectId === interaction.projectId && current.threadId === interaction.threadId);
}

export const connectionLabels: Record<WorkspaceState['connection']['status'], string> = {
  idle: '尚未连接', connecting: '正在连接', pairing: '等待设备配对', connected: '已连接',
  offline: '连接已断开', revoked: '设备信任已失效', error: '连接未完成',
};
