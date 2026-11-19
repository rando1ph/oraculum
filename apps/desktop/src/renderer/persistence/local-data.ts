import type { WorkspaceState } from '../../contracts/workspace';
import { LocalStorageError, type CachedHistory, type CachedNavigation, type DraftContent, type DraftReceipt, type LocalIdentity, type LocalPreferences, type LocalScope, type PersistedDraft, type ReadingPosition } from './types';
export * from './types';

export const LOCAL_DATABASE = 'oraculum-desktop-v2-local';
export const LOCAL_DATABASE_VERSION = 1;
export const LOCAL_STORES = ['drafts', 'history', 'history-index', 'navigation', 'reading', 'preferences'] as const;
type StoreName = typeof LOCAL_STORES[number];
type Envelope = { schema: 1; key: string; value: unknown; checksum: number };
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const MAX_NAVIGATION_BYTES = 2 * 1024 * 1024;
export const HISTORY_CACHE_LIMIT = { entries: 32, bytes: 64 * 1024 * 1024 } as const;
type CacheIndex = { key: string; bytes: number; accessedAt: number };
const MAX_TEXT = 100_000;
const EMPTY: DraftContent = { text: '', model: '', effort: '', permissionPreset: '' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const short = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const clone = <T>(value: T): T => structuredClone(value);
function fail(code: ConstructorParameters<typeof LocalStorageError>[0]): never { throw new LocalStorageError(code); }
function normalizeError(error: unknown): LocalStorageError {
  if (error instanceof LocalStorageError) return error;
  const name = error instanceof Error || record(error) ? error.name : undefined;
  return new LocalStorageError(name === 'QuotaExceededError' ? 'quota' : name === 'VersionError' ? 'version' : 'unavailable');
}
function json(value: unknown, maxBytes: number): string {
  try {
    const text = JSON.stringify(value);
    if (!text || new TextEncoder().encode(text).byteLength > maxBytes) fail('invalid');
    return text;
  } catch (error) { if (error instanceof LocalStorageError) throw error; return fail('invalid'); }
}
// Detect accidental record corruption. This checksum is not an authentication proof.
function checksum(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return hash >>> 0;
}
function envelope(key: string, value: unknown, maxBytes: number): Envelope {
  const serialized = json(value, maxBytes);
  return { schema: 1, key, value: JSON.parse(serialized) as unknown, checksum: checksum(serialized) };
}
function decode<T>(raw: unknown, key: string, validate: (value: unknown) => value is T, maxBytes: number): T | undefined {
  if (raw === undefined) return undefined;
  try {
    if (!record(raw) || raw.schema !== 1 || raw.key !== key || !natural(raw.checksum)
      || raw.checksum !== checksum(json(raw.value, maxBytes)) || !validate(raw.value)) fail('corrupt');
    return clone(raw.value);
  } catch { return fail('corrupt'); }
}
export function identityKey(identity: LocalIdentity): string {
  if (!record(identity) || !short(identity.installationId) || !short(identity.deviceId) || !short(identity.endpoint, 4096)) fail('invalid');
  let endpoint: URL;
  try { endpoint = new URL(identity.endpoint); } catch { return fail('invalid'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.href !== identity.endpoint) fail('invalid');
  return JSON.stringify([identity.endpoint, identity.installationId, identity.deviceId]);
}
export function scopeKey(scope: LocalScope): string {
  identityKey(scope);
  if (!short(scope.projectId) || scope.threadId !== undefined && !short(scope.threadId)) fail('invalid');
  return JSON.stringify([scope.endpoint, scope.installationId, scope.deviceId, scope.projectId, scope.threadId ?? null]);
}
function draftContent(value: unknown): value is DraftContent {
  return record(value) && typeof value.text === 'string' && value.text.length <= MAX_TEXT
    && typeof value.model === 'string' && value.model.length <= 512 && typeof value.effort === 'string' && value.effort.length <= 128
    && ['', 'read-only', 'auto', 'full-access'].includes(String(value.permissionPreset));
}
function draft(value: unknown): value is PersistedDraft {
  if (!draftContent(value) || !record(value) || typeof value.clientDraftId !== 'string' || !UUID.test(value.clientDraftId)
    || !natural(value.revision) || value.revision < 1 || !natural(value.updatedAt)) return false;
  if (value.submission !== undefined) {
    const submission = value.submission;
    if (!record(submission) || !natural(submission.revision) || submission.revision < 1 || submission.revision > value.revision
      || !['pending', 'accepted', 'rejected'].includes(String(submission.status))
      || submission.operationId !== undefined && (typeof submission.operationId !== 'string' || !UUID.test(submission.operationId))) return false;
  }
  return true;
}
function thread(value: unknown, projectId?: string, threadId?: string): boolean {
  return record(value) && short(value.id) && short(value.projectId) && (projectId === undefined || value.projectId === projectId)
    && (threadId === undefined || value.id === threadId) && short(value.status)
    && (value.title === undefined || value.title === null || typeof value.title === 'string');
}
function history(value: unknown): value is CachedHistory {
  if (!record(value) || !natural(value.savedAt) || !Array.isArray(value.streamItems) || value.streamItems.length > 1000
    || value.diff !== undefined && typeof value.diff !== 'string' || value.thread !== undefined && !thread(value.thread)) return false;
  if (!value.streamItems.every(entry => record(entry) && short(entry.turnId) && record(entry.item) && short(entry.item.id) && short(entry.item.type))) return false;
  if (value.history !== undefined) {
    const page = value.history;
    if (!record(page) || !short(page.epoch) || !short(page.historyRevision) || !Array.isArray(page.items)
      || page.items.length > 10_000 || !(page.nextCursor === null || short(page.nextCursor, 4096))
      || typeof page.complete !== 'boolean' || typeof page.truncated !== 'boolean' || typeof page.source !== 'string') return false;
    const turnIds = new Set<string>();
    for (const turn of page.items) {
      if (!record(turn) || !short(turn.id) || turnIds.has(turn.id) || !short(turn.status) || !Array.isArray(turn.items) || turn.items.length > 1000) return false;
      turnIds.add(turn.id);
      const items = new Set<string>();
      for (const item of turn.items) {
        if (!record(item) || !short(item.id) || items.has(item.id) || !short(item.type)) return false;
        items.add(item.id);
      }
    }
  }
  return true;
}
function navigation(value: unknown): value is CachedNavigation {
  return record(value) && natural(value.savedAt) && Array.isArray(value.projects) && value.projects.length <= 1000
    && value.projects.every(project => record(project) && short(project.id) && typeof project.name === 'string' && short(project.rootId) && typeof project.available === 'boolean')
    && record(value.threadsByProject) && Object.keys(value.threadsByProject).length <= 1000
    && Object.entries(value.threadsByProject).every(([projectId, page]) => short(projectId) && record(page) && Array.isArray(page.threads)
      && page.threads.length <= 10_000 && page.threads.every(item => thread(item, projectId))
      && (page.nextCursor === null || short(page.nextCursor, 4096)) && typeof page.truncated === 'boolean' && typeof page.source === 'string')
    && (value.projectId === undefined || short(value.projectId)) && (value.threadId === undefined || short(value.threadId) && short(value.projectId));
}
function reading(value: unknown): value is ReadingPosition {
  return record(value) && typeof value.offset === 'number' && Number.isFinite(value.offset) && Math.abs(value.offset) <= 100_000_000
    && typeof value.atBottom === 'boolean' && natural(value.updatedAt)
    && (value.itemKey === undefined || short(value.itemKey, 2048)) && (value.historyRevision === undefined || short(value.historyRevision));
}
function preferences(value: unknown): value is LocalPreferences {
  return record(value) && typeof value.navigationWidth === 'number' && Number.isFinite(value.navigationWidth) && value.navigationWidth >= 180 && value.navigationWidth <= 480
    && typeof value.inspectorWidth === 'number' && Number.isFinite(value.inspectorWidth) && value.inspectorWidth >= 240 && value.inspectorWidth <= 720
    && typeof value.navigationVisible === 'boolean';
}
function stripThread(value: NonNullable<WorkspaceState['thread']>): NonNullable<WorkspaceState['thread']> {
  return { id: value.id, projectId: value.projectId, status: value.status,
    ...Object.fromEntries(['title', 'archived', 'parentThreadId', 'model', 'reasoningEffort', 'preview', 'createdAt', 'updatedAt']
      .filter(key => value[key] !== undefined).map(key => [key, clone(value[key])])) };
}
/** Explicit allow-list prevents cache data from masquerading as live authorization. */
export function cacheHistory(state: WorkspaceState, savedAt = Date.now()): CachedHistory {
  const result: CachedHistory = { savedAt, streamItems: clone(state.streamItems),
    ...(state.thread ? { thread: stripThread(state.thread) } : {}),
    ...(state.history ? { history: clone(state.history) } : {}),
    ...(state.plan === undefined ? {} : { plan: clone(state.plan) }),
    ...(state.diff === undefined ? {} : { diff: state.diff }),
    ...(state.tokenUsage === undefined ? {} : { tokenUsage: clone(state.tokenUsage) }) };
  if (!history(result)) fail('invalid');
  return result;
}

/** Revisions are opaque equality tokens, not counters. Only one epoch/revision can merge. */
export function mergeCachedHistory(previous: CachedHistory | undefined, incoming: CachedHistory): CachedHistory {
  if (!previous || !previous.history || !incoming.history || previous.history.epoch !== incoming.history.epoch
    || previous.history.historyRevision !== incoming.history.historyRevision
    || previous.thread && incoming.thread && (previous.thread.id !== incoming.thread.id || previous.thread.projectId !== incoming.thread.projectId)) return limitHistory(clone(incoming));
  const oldTurns = previous.history.items as { id: string; items: unknown[] }[], newTurns = incoming.history.items as { id: string; items: unknown[] }[];
  const incomingIds = new Set(newTurns.map(turn => turn.id));
  const retained = oldTurns.filter(turn => !incomingIds.has(turn.id));
  const result = clone(incoming);
  result.history = { ...result.history!, items: [...clone(retained), ...result.history!.items],
    itemCursors: { ...previous.history.itemCursors, ...incoming.history.itemCursors },
    itemTimings: { ...previous.history.itemTimings, ...incoming.history.itemTimings },
    ...(retained.length && oldTurns[0] && !incomingIds.has(oldTurns[0].id) ? { nextCursor: previous.history.nextCursor } : {}) };
  // Event-only inspector facts have no replay read endpoint. Keep them explicitly last-known.
  if (result.plan === undefined) result.plan = clone(previous.plan);
  if (result.diff === undefined) result.diff = previous.diff;
  if (result.tokenUsage === undefined) result.tokenUsage = clone(previous.tokenUsage);
  return limitHistory(result);
}
function limitHistory(result: CachedHistory): CachedHistory {
  if (!result.history) return result;
  // An individual cache entry has a fixed display budget. Live main paging is unaffected.
  let itemCount = (result.history.items as { items: unknown[] }[]).reduce((count, turn) => count + turn.items.length, 0);
  let shortened = false;
  while (itemCount > 2000 && result.history.items.length > 1) {
    const removed = result.history.items.shift() as { items: unknown[] };
    itemCount -= removed.items.length; result.history.truncated = true; shortened = true;
  }
  if (shortened) {
    // No native turn-boundary cursor exists for an arbitrary cache trim. Never
    // reuse a cursor that would skip the newly omitted portion of the history.
    result.history.nextCursor = null;
    const retainedItems = new Set((result.history.items as { items: { id: string }[] }[]).flatMap(turn => turn.items.map(item => item.id)));
    if (result.history.itemCursors) result.history.itemCursors = Object.fromEntries(Object.entries(result.history.itemCursors).filter(([id]) => retainedItems.has(id)));
    if (result.history.itemTimings) result.history.itemTimings = Object.fromEntries(Object.entries(result.history.itemTimings).filter(([id]) => retainedItems.has(id)));
  }
  return result;
}

/** Disposable display entries only. Drafts and read positions are never LRU victims. */
export function historyEvictions(entries: CacheIndex[], protectedKey: string): string[] {
  if (entries.some(entry => !record(entry) || typeof entry.key !== 'string' || !natural(entry.bytes) || !natural(entry.accessedAt))) fail('corrupt');
  let count = entries.length, bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const victims: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.accessedAt - b.accessedAt || a.key.localeCompare(b.key))) {
    if (count <= HISTORY_CACHE_LIMIT.entries && bytes <= HISTORY_CACHE_LIMIT.bytes) break;
    if (entry.key === protectedKey) continue;
    victims.push(entry.key); count--; bytes -= entry.bytes;
  }
  return victims;
}

/** One local DB, separate stores. No credentials, journal, write dispatcher or authority. */
export class ClientStorage {
  private database?: Promise<IDBDatabase>;
  private handle?: IDBDatabase;
  private generation = 0;
  private cancelOpen?: () => void;
  private readonly factory?: IDBFactory;
  private readonly name: string;
  private readonly openTimeoutMs: number;
  constructor(options: { factory?: IDBFactory; name?: string; openTimeoutMs?: number } = {}) {
    this.factory = options.factory ?? globalThis.indexedDB;
    this.name = options.name ?? LOCAL_DATABASE;
    this.openTimeoutMs = options.openTimeoutMs ?? 2000;
  }
  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    const generation = this.generation;
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      if (!this.factory) { reject(new LocalStorageError('unavailable')); return; }
      let request: IDBOpenDBRequest;
      try { request = this.factory.open(this.name, LOCAL_DATABASE_VERSION); } catch (error) { reject(normalizeError(error)); return; }
      let settled = false;
      let cancel: (() => void) | undefined;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (this.cancelOpen === cancel) this.cancelOpen = undefined;
        if (error) reject(normalizeError(error));
        else resolve(request.result);
      };
      const timer = setTimeout(() => finish(new LocalStorageError('blocked')), this.openTimeoutMs);
      cancel = () => finish(new LocalStorageError('unavailable'));
      this.cancelOpen = cancel;
      request.onblocked = () => finish(new LocalStorageError('blocked'));
      request.onerror = () => finish(request.error);
      request.onupgradeneeded = () => {
        if (settled || generation !== this.generation) { request.transaction?.abort(); finish(new LocalStorageError('unavailable')); return; }
        // Additive schema only. Unknown newer versions fail open; never delete a DB.
        const db = request.result;
        for (const name of LOCAL_STORES) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      };
      request.onsuccess = () => {
        if (settled || generation !== this.generation) { request.result.close(); finish(new LocalStorageError('unavailable')); return; }
        const db = request.result;
        if (LOCAL_STORES.some(name => !db.objectStoreNames.contains(name))) { db.close(); finish(new LocalStorageError('corrupt')); return; }
        this.handle = db;
        db.onversionchange = () => { db.close(); if (this.handle === db) { this.handle = undefined; this.database = undefined; this.generation++; } };
        db.onclose = () => { if (this.handle === db) { this.handle = undefined; this.database = undefined; } };
        finish();
      };
    });
    this.database = pending;
    void pending.catch(() => { if (this.database === pending) this.database = undefined; });
    return pending;
  }
  close(): void { this.generation++; this.cancelOpen?.(); this.cancelOpen = undefined; this.handle?.close(); this.handle = undefined; this.database = undefined; }
  private async transaction<T>(names: StoreName[], mode: IDBTransactionMode, work: (tx: IDBTransaction, done: (value: T) => void, abort: (error: unknown) => void) => void): Promise<T> {
    const generation = this.generation;
    const db = await this.open();
    if (generation !== this.generation) fail('unavailable');
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction(names, mode, mode === 'readwrite' ? { durability: names.some(name => ['drafts', 'reading', 'preferences'].includes(name)) ? 'strict' : 'relaxed' } : undefined); }
      catch (error) { reject(normalizeError(error)); return; }
      let result: T, failure: LocalStorageError | undefined;
      const abort = (error: unknown) => { failure = normalizeError(error); try { tx.abort(); } catch { reject(failure); } };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? normalizeError(tx.error));
      tx.onerror = event => { failure ??= normalizeError(tx.error ?? (event.target as IDBRequest | null)?.error); };
      try { work(tx, value => { result = value; }, abort); } catch (error) { abort(error); }
    });
  }
  private read<T>(store: StoreName, key: string, validate: (value: unknown) => value is T, maxBytes: number): Promise<T | undefined> {
    return this.transaction([store], 'readonly', (tx, done, abort) => {
      const request = tx.objectStore(store).get(key);
      request.onsuccess = () => { try { done(decode(request.result, key, validate, maxBytes)); } catch (error) { abort(error); } };
    });
  }
  private save<T>(store: StoreName, key: string, value: T, validate: (value: unknown) => value is T, maxBytes: number): Promise<void> {
    if (!validate(value)) return Promise.reject(new LocalStorageError('invalid'));
    const row = envelope(key, value, maxBytes);
    return this.transaction([store], 'readwrite', (tx, done) => { tx.objectStore(store).put(row, key); done(undefined); });
  }
  readDraft(scope: LocalScope): Promise<PersistedDraft | undefined> { return this.read('drafts', scopeKey(scope), draft, MAX_TEXT * 4 + 8192); }
  private updateDraft(scope: LocalScope, update: (current: PersistedDraft | undefined) => PersistedDraft): Promise<PersistedDraft> {
    const key = scopeKey(scope);
    return this.transaction(['drafts'], 'readwrite', (tx, done, abort) => {
      const store = tx.objectStore('drafts'), request = store.get(key);
      request.onsuccess = () => {
        try {
          const current = decode(request.result, key, draft, MAX_TEXT * 4 + 8192), next = update(current);
          if (!draft(next)) fail('invalid');
          store.put(envelope(key, next, MAX_TEXT * 4 + 8192), key); done(clone(next));
        } catch (error) { abort(error); }
      };
    });
  }
  /** CAS rejects competing editors; callers retain unsaved memory and show the error. */
  saveDraft(scope: LocalScope, content: DraftContent, expectedRevision: number): Promise<PersistedDraft> {
    if (!draftContent(content) || !natural(expectedRevision)) return Promise.reject(new LocalStorageError('invalid'));
    const data: DraftContent = { text: content.text, model: content.model, effort: content.effort, permissionPreset: content.permissionPreset };
    return this.updateDraft(scope, current => {
      if ((current?.revision ?? 0) !== expectedRevision) fail('conflict');
      return { ...data, clientDraftId: current?.clientDraftId ?? crypto.randomUUID(), revision: expectedRevision + 1,
        updatedAt: Date.now(), ...(current?.submission ? { submission: current.submission } : {}) };
    });
  }
  /** Must commit successfully before sending any IPC intent. */
  beginSubmission(scope: LocalScope, expectedRevision: number): Promise<PersistedDraft> {
    return this.updateDraft(scope, current => {
      if (!current || current.revision !== expectedRevision) fail('conflict');
      if (current.submission?.status === 'pending') fail('pending');
      return { ...current, updatedAt: Date.now(), submission: { revision: current.revision, status: 'pending' } };
    });
  }
  /** Only a matching main journal receipt settles a persisted submission. */
  settleSubmission(scope: LocalScope, receipt: DraftReceipt): Promise<PersistedDraft> {
    if (!record(receipt) || !UUID.test(receipt.clientDraftId) || !natural(receipt.draftRevision)
      || !UUID.test(receipt.operationId) || !['prepared', 'unknown', 'accepted', 'rejected'].includes(receipt.status)) return Promise.reject(new LocalStorageError('invalid'));
    return this.updateDraft(scope, current => {
      if (!current || current.clientDraftId !== receipt.clientDraftId || current.submission?.revision !== receipt.draftRevision) fail('conflict');
      const status = receipt.status === 'prepared' || receipt.status === 'unknown' ? 'pending' : receipt.status;
      if (current.submission.status !== 'pending') {
        if (status !== current.submission.status || receipt.operationId !== current.submission.operationId) fail('conflict');
        return current;
      }
      if (current.submission.operationId && current.submission.operationId !== receipt.operationId) fail('conflict');
      const sameRevision = current.revision === receipt.draftRevision;
      return { ...current, ...(status === 'accepted' && sameRevision ? { text: '' } : {}),
        // A definitive rejection permits a later explicit user retry as a new revision.
        revision: status !== 'pending' && sameRevision ? current.revision + 1 : current.revision,
        updatedAt: Date.now(), submission: { revision: receipt.draftRevision, status, operationId: receipt.operationId } };
    });
  }
  /** Call only after main explicitly proves no matching journal dispatch exists. */
  releaseSubmission(scope: LocalScope, proof: { clientDraftId: string; draftRevision: number }): Promise<PersistedDraft> {
    return this.updateDraft(scope, current => {
      if (!current || current.clientDraftId !== proof.clientDraftId || current.submission?.revision !== proof.draftRevision
        || current.submission.status !== 'pending' || current.submission.operationId) fail('conflict');
      const { submission: _submission, ...content } = current;
      return { ...content, revision: current.revision === proof.draftRevision ? current.revision + 1 : current.revision, updatedAt: Date.now() };
    });
  }
  async readHistory(scope: LocalScope): Promise<CachedHistory | undefined> {
    const key = scopeKey(scope), result = await this.read('history', key, history, MAX_HISTORY_BYTES);
    if (result) {
      // Failure to update disposable LRU metadata must not hide readable cached text.
      void this.transaction(['history-index'], 'readwrite', (tx, done) => {
        const store = tx.objectStore('history-index'), request = store.get(key);
        request.onsuccess = () => { if (request.result) store.put({ ...request.result, accessedAt: Date.now() }, key); done(undefined); };
      }).catch(() => undefined);
    }
    return result;
  }
  saveHistory(scope: LocalScope, value: CachedHistory): Promise<void> {
    if (value.thread && !thread(value.thread, scope.projectId, scope.threadId)) return Promise.reject(new LocalStorageError('invalid'));
    const safe: CachedHistory = { savedAt: value.savedAt, streamItems: clone(value.streamItems),
      ...(value.thread ? { thread: stripThread(value.thread) } : {}), ...(value.history ? { history: clone(value.history) } : {}),
      ...(value.plan === undefined ? {} : { plan: clone(value.plan) }), ...(value.diff === undefined ? {} : { diff: value.diff }),
      ...(value.tokenUsage === undefined ? {} : { tokenUsage: clone(value.tokenUsage) }) };
    if (!history(safe)) return Promise.reject(new LocalStorageError('invalid'));
    const key = scopeKey(scope);
    // Read/merge/replace in one transaction so concurrent pages cannot lose retained history.
    return this.transaction(['history', 'history-index'], 'readwrite', (tx, done, abort) => {
      const store = tx.objectStore('history'), request = store.get(key);
      request.onsuccess = () => {
        try {
          const previous = decode(request.result, key, history, MAX_HISTORY_BYTES);
          const merged = mergeCachedHistory(previous, safe), row = envelope(key, merged, MAX_HISTORY_BYTES);
          const index = tx.objectStore('history-index');
          store.put(row, key);
          index.put({ key, bytes: new TextEncoder().encode(JSON.stringify(row)).byteLength, accessedAt: Date.now() } satisfies CacheIndex, key);
          const entries = index.getAll();
          entries.onsuccess = () => {
            try {
              for (const victim of historyEvictions(entries.result as CacheIndex[], key)) { store.delete(victim); index.delete(victim); }
              done(undefined);
            } catch (error) { abort(error); }
          };
        } catch (error) { abort(error); }
      };
    });
  }
  readNavigation(identity: LocalIdentity): Promise<CachedNavigation | undefined> { return this.read('navigation', identityKey(identity), navigation, MAX_NAVIGATION_BYTES); }
  saveNavigation(identity: LocalIdentity, value: CachedNavigation): Promise<void> {
    if (!navigation(value)) return Promise.reject(new LocalStorageError('invalid'));
    const safe: CachedNavigation = { savedAt: value.savedAt,
      projects: value.projects.map(project => ({ id: project.id, name: project.name, rootId: project.rootId, available: project.available })),
      threadsByProject: Object.fromEntries(Object.entries(value.threadsByProject).map(([projectId, page]) => [projectId,
        { source: page.source, nextCursor: page.nextCursor, truncated: page.truncated, threads: page.threads.map(stripThread) }])),
      ...(value.projectId ? { projectId: value.projectId } : {}), ...(value.threadId ? { threadId: value.threadId } : {}) };
    return this.save('navigation', identityKey(identity), safe, navigation, MAX_NAVIGATION_BYTES);
  }
  readReading(scope: LocalScope): Promise<ReadingPosition | undefined> { return this.read('reading', scopeKey(scope), reading, 8192); }
  saveReading(scope: LocalScope, value: ReadingPosition): Promise<void> { return this.save('reading', scopeKey(scope), clone(value), reading, 8192); }
  readPreferences(): Promise<LocalPreferences | undefined> { return this.read('preferences', 'layout', preferences, 1024); }
  savePreferences(value: LocalPreferences): Promise<void> { return this.save('preferences', 'layout', clone(value), preferences, 1024); }
  /** Explicit rebuild of display cache; never touches drafts, credentials or main journal. */
  clearHistory(identity: LocalIdentity): Promise<void> {
    const prefix = identityKey(identity).slice(0, -1) + ',';
    return this.transaction(['history', 'history-index', 'reading'], 'readwrite', (tx, done) => {
      for (const name of ['history', 'history-index', 'reading'] as const) {
        const request = tx.objectStore(name).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) cursor.delete();
          cursor.continue();
        };
      }
      done(undefined);
    });
  }
}

export const emptyDraftContent = (): DraftContent => ({ ...EMPTY });
