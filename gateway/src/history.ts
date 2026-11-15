import { createHash, randomUUID } from 'node:crypto';
import { CodexError, type CodexAdapter, type NativeItem, type NativeTurn } from './codex';
import { BoundedReadCache, ReadCacheBusyError, ReadCacheInvalidatedError } from './read-cache';
export class HistoryError extends Error {
    constructor(readonly code: 'HISTORY_BUSY' | 'HISTORY_TIMEOUT' | 'HISTORY_STALE' | 'HISTORY_CURSOR_INVALID' | 'HISTORY_PROTOCOL', message: string) { super(message); }
}
type HistoryAdapter = Pick<CodexAdapter, 'listTurns' | 'listItems' | 'readThread'>;
export type NativeItemTiming = { startedAtMs?: number; completedAtMs?: number };
/** Producer timestamps only; absent/invalid native values are not replaced with the receipt clock. */
export function nativeItemTiming(value: Record<string, unknown>): NativeItemTiming {
    const result: NativeItemTiming = {};
    for (const key of ['startedAtMs', 'completedAtMs'] as const) {
        const timestamp = value[key];
        if (typeof timestamp === 'number' && Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= 253402300799999)
            result[key] = timestamp;
    }
    return result;
}
type Cursor = {
    scope: string;
    pageSize?: number;
    threadId: string;
    turnId?: string;
    revision: string;
    kind: 'turns' | 'items';
    source: 'native-pages' | 'native-read';
    position: string | number;
    expiresAt: number;
};
export type HistoryPage<T> = {
    epoch: string;
    revision: string;
    source: 'native-pages' | 'native-read';
    data: T[];
    nextCursor: string | null;
    complete: boolean;
    truncated: boolean;
    snapshotSeq: number;
    itemCursors?: Record<string, string>;
    itemTimings?: Record<string, NativeItemTiming>;
};
type PageProjection<T> = Omit<HistoryPage<T>, 'nextCursor' | 'itemCursors'> & {
    nextPosition: string | number | null;
    itemPositions?: Record<string, { source: Cursor['source']; position: string | number }>;
    contentDigest?: string;
    fullDigest?: string;
};
type ObservedPage = {
    threadId: string;
    revision: string;
    digest: string;
    bytes: number;
    load: (deadline: number, revision: string) => Promise<PageProjection<unknown>>;
};
const fallback = (error: unknown) => error instanceof CodexError && ['NATIVE_UNSUPPORTED', 'NATIVE_EXPERIMENTAL', 'NATIVE_PAGINATION_UNSUPPORTED'].includes(error.code);
/** Bounded display projection; never stored as canonical history or used for operation correlation. */
export function projectItem(item: NativeItem, byteBudget = 16384): {
    item: NativeItem;
    truncated: boolean;
    bytes: number;
} {
    let remaining = byteBudget, truncated = false;
    const project = (value: unknown, depth = 0): unknown => {
        if (remaining <= 0 || depth > 12) {
            truncated = true;
            return null;
        }
        if (typeof value === 'string') {
            const bytes = Buffer.byteLength(value);
            if (bytes <= remaining) {
                remaining -= bytes;
                return value;
            }
            truncated = true;
            const result = Buffer.from(value).subarray(0, Math.max(0, remaining - 3)).toString('utf8');
            remaining = 0;
            return result;
        }
        if (Array.isArray(value)) {
            if (value.length > 100)
                truncated = true;
            const result: unknown[] = [];
            for (const part of value.slice(0, 100)) {
                if (remaining <= 0) {
                    truncated = true;
                    break;
                }
                result.push(project(part, depth + 1));
            }
            return result;
        }
        if (value && typeof value === 'object') {
            const entries = Object.entries(value);
            if (entries.length > 80)
                truncated = true;
            const result = Object.create(null) as Record<string, unknown>;
            for (const [key, part] of entries.slice(0, 80)) {
                remaining -= Buffer.byteLength(key) + 4;
                if (remaining <= 0) {
                    truncated = true;
                    break;
                }
                result[key] = project(part, depth + 1);
            }
            return result;
        }
        remaining -= 8;
        return value;
    };
    const projected = project(item) as NativeItem;
    // Identity is mandatory even when a large preceding field consumes the display budget.
    const result = { ...projected, id: item.id, type: item.type };
    return { item: result, truncated, bytes: Buffer.byteLength(JSON.stringify(result)) };
}
/** Native history only. Cursors/revisions are short-lived coordination data, not a second history database. */
export class NativeHistory {
    private active = 0;
    private revisions = new Map<string, string>();
    private readonly pages: BoundedReadCache;
    // A lease schedules fresh content validation; elapsed time is not a history change.
    private readonly rootLeases = new Map<string, number>();
    private readonly rootFingerprints = new Map<string, Map<number, string>>();
    private readonly fullDigests = new Map<string, string>();
    private readonly observedPages = new Map<string, ObservedPage>();
    private observedBytes = 0;
    private cursors = new Map<string, Cursor>();
    private detailCursors = new Map<string, {
        scope: string;
        threadId: string;
        turnId: string;
        itemId: string;
        revision: string;
        digest: string;
        offset: number;
        expiresAt: number;
    }>();
    constructor(private readonly codex: HistoryAdapter, private readonly options: {
        epoch: string;
        maxConcurrent?: number;
        deadlineMs?: number;
        maxCursors?: number;
        cursorTtlMs?: number;
        sequence?: () => number;
        cacheTtlMs?: number;
        validationTtlMs?: number;
        cacheMaxEntries?: number;
        cacheMaxBytes?: number;
        maxObservedPages?: number;
        now?: () => number;
    }) {
        this.pages = new BoundedReadCache({ maxEntries: options.cacheMaxEntries ?? 128,
            maxBytes: options.cacheMaxBytes ?? 8 * 1024 * 1024, maxPending: options.maxConcurrent ?? 2, now: options.now });
    }
    private now() { return this.options.now?.() ?? Date.now(); }
    discardCached(threadId: string) {
        this.pages.invalidateWhere(key => JSON.parse(key)[0] === threadId);
    }
    invalidate(threadId: string) {
        this.discardCached(threadId);
        this.rootLeases.delete(threadId);
        this.rootFingerprints.delete(threadId);
        this.fullDigests.delete(threadId);
        for (const [key, page] of this.observedPages) if (page.threadId === threadId) {
            this.observedPages.delete(key); this.observedBytes -= page.bytes;
        }
        this.revisions.set(threadId, randomUUID());
        for (const [token, entry] of this.cursors)
            if (entry.threadId === threadId)
                this.cursors.delete(token);
        for (const [token, entry] of this.detailCursors)
            if (entry.threadId === threadId)
                this.detailCursors.delete(token);
        this.pruneRevisions();
    }
    clear() { this.pages.clear(); this.rootLeases.clear(); this.rootFingerprints.clear(); this.fullDigests.clear(); this.observedPages.clear(); this.observedBytes = 0; this.revisions.clear(); this.cursors.clear(); this.detailCursors.clear(); }
    private pageRevision(threadId: string, root: boolean) {
        if (root) {
            const now = this.now();
            if (!this.rootLeases.has(threadId)) this.rootLeases.set(threadId, now + (this.options.validationTtlMs ?? 30000));
        }
        return this.revision(threadId);
    }
    private validateRoot(threadId: string, pageSize: number, projection: PageProjection<NativeTurn>) {
        // Native cursors are opaque positions, not stable version identifiers.
        const fingerprint = projection.fullDigest ?? projection.contentDigest ?? this.digest({ source: projection.source,
            data: projection.data, itemTimings: projection.itemTimings, truncated: projection.truncated,
            complete: projection.complete, hasNext: projection.nextPosition !== null,
            itemPages: Object.keys(projection.itemPositions ?? {}).sort() });
        const previous = this.rootFingerprints.get(threadId)?.get(pageSize);
        if (previous !== undefined && previous !== fingerprint) {
            this.invalidate(threadId);
            projection.revision = this.pageRevision(threadId, true);
        }
        let fingerprints = this.rootFingerprints.get(threadId);
        if (!fingerprints) this.rootFingerprints.set(threadId, fingerprints = new Map());
        fingerprints.set(pageSize, fingerprint);
    }
    private digest(value: unknown): string {
        // Object insertion order (notably parallel Item timing completion) is not
        // a native content change. Arrays keep their canonical native order.
        const json = JSON.stringify(value, (_key, part) => part && typeof part === 'object' && !Array.isArray(part)
            ? Object.fromEntries(Object.keys(part).sort().map(key => [key, part[key]])) : part);
        return createHash('sha256').update(json).digest('hex');
    }
    private observe(threadId: string, key: string, projection: PageProjection<unknown>, load: ObservedPage['load'], root: boolean) {
        const full = projection.fullDigest, previousFull = this.fullDigests.get(threadId);
        if (full && previousFull !== undefined && previousFull !== full) {
            this.invalidate(threadId);
            if (!root) throw new HistoryError('HISTORY_STALE', 'Native history changed while reading an older page');
            projection.revision = this.pageRevision(threadId, true);
        }
        if (full) this.fullDigests.set(threadId, full);
        // Full reads already validate every Turn/Item without retaining the raw history.
        if (full) return;
        const digest = projection.contentDigest!;
        const previous = this.observedPages.get(key);
        if (previous && previous.revision === projection.revision && previous.digest !== digest) {
            this.invalidate(threadId);
            if (!root) throw new HistoryError('HISTORY_STALE', 'Native history changed while reading an older page');
            projection.revision = this.pageRevision(threadId, true);
        }
        const bytes = Buffer.byteLength(key) + 128;
        if (!this.observedPages.has(key)) {
            while (this.observedPages.size >= (this.options.maxObservedPages ?? 128) || this.observedBytes + bytes > 2 * 1024 * 1024) {
                const oldest = this.observedPages.values().next().value;
                if (!oldest) throw new HistoryError('HISTORY_BUSY', 'Native history observation budget exhausted');
                this.invalidate(oldest.threadId);
                if (oldest.threadId === threadId) throw new HistoryError('HISTORY_STALE', 'Loaded native history exceeded its observation budget; reload the current page');
            }
            this.observedBytes += bytes;
        }
        this.observedPages.set(key, { threadId, revision: projection.revision, digest, bytes, load });
    }
    private async validateObserved(threadId: string, revision: string, key: string, current: PageProjection<unknown>, deadline: number) {
        if (!current.fullDigest) for (const [otherKey, page] of [...this.observedPages]) {
            if (page.threadId !== threadId || page.revision !== revision) continue;
            let fresh: PageProjection<unknown>;
            try { fresh = otherKey === key ? current : await page.load(deadline, revision); }
            catch (error) {
                if (error instanceof HistoryError && error.code === 'HISTORY_STALE') this.invalidate(threadId);
                if (error instanceof CodexError && error.code === 'NATIVE_REJECTED' && error.nativeCode === -32602) {
                    this.invalidate(threadId);
                    throw new HistoryError('HISTORY_STALE', 'An observed native history position is no longer valid; reload the current page');
                }
                throw error;
            }
            this.check(threadId, revision, deadline);
            if (fresh.contentDigest !== page.digest) {
                this.invalidate(threadId);
                throw new HistoryError('HISTORY_STALE', 'Native history changed in the loaded page window; reload the current page');
            }
        }
        this.check(threadId, revision, deadline);
        this.rootLeases.set(threadId, this.now() + (this.options.validationTtlMs ?? 30000));
    }
    private async projection<T>(key: string, forceFresh: boolean | undefined, load: () => Promise<T>): Promise<T> {
        try {
            return forceFresh ? await load() : await this.pages.get(key, this.options.cacheTtlMs ?? 5000, load);
        } catch (error) {
            if (error instanceof ReadCacheBusyError) throw new HistoryError('HISTORY_BUSY', 'Native history read capacity reached');
            if (error instanceof ReadCacheInvalidatedError) throw new HistoryError('HISTORY_STALE', 'Native history changed while reading; reload the current page');
            throw error;
        }
    }
    private page<T>(projection: PageProjection<T>, scope: string, threadId: string, kind: Cursor['kind'], pageSize?: number, turnId?: string): HistoryPage<T> {
        const { nextPosition, itemPositions, contentDigest: _contentDigest, fullDigest: _fullDigest, ...page } = projection;
        const itemCursors = itemPositions ? Object.fromEntries(Object.entries(itemPositions).map(([id, position]) => [id,
            this.encode({ scope, threadId, turnId: id, revision: page.revision, kind: 'items', ...position })])) : undefined;
        return { ...page, ...(itemCursors ? { itemCursors } : {}), nextCursor: nextPosition === null ? null :
            this.encode({ scope, threadId, turnId, pageSize, revision: page.revision, kind, source: page.source, position: nextPosition }) };
    }
    private revision(threadId: string) {
        let revision = this.revisions.get(threadId);
        if (!revision) {
            revision = randomUUID();
            this.revisions.set(threadId, revision);
            this.pruneRevisions();
        }
        return revision;
    }
    private pruneRevisions() {
        while (this.revisions.size > 1024) {
            const removed = this.revisions.keys().next().value!;
            this.revisions.delete(removed);
            this.rootLeases.delete(removed);
            this.rootFingerprints.delete(removed);
            this.fullDigests.delete(removed);
            for (const [key, page] of this.observedPages) if (page.threadId === removed) {
                this.observedPages.delete(key); this.observedBytes -= page.bytes;
            }
            this.discardCached(removed);
            for (const [token, entry] of this.cursors)
                if (entry.threadId === removed)
                    this.cursors.delete(token);
            for (const [token, entry] of this.detailCursors)
                if (entry.threadId === removed)
                    this.detailCursors.delete(token);
        }
    }
    private decode(token: string | undefined, threadId: string, turnId: string | undefined, revision: string, kind: Cursor['kind'], scope: string, pageSize?: number): Cursor | undefined {
        if (token === undefined)
            return undefined;
        const entry = this.cursors.get(token);
        if (!entry || entry.expiresAt < this.now() || entry.threadId !== threadId || entry.turnId !== turnId || entry.revision !== revision || entry.kind !== kind || entry.scope !== scope || entry.pageSize !== pageSize) {
            throw new HistoryError('HISTORY_CURSOR_INVALID', 'History cursor expired or does not match this query; reload the current page');
        }
        return entry;
    }
    private encode(entry: Omit<Cursor, 'expiresAt'>): string {
        for (const [token, old] of this.cursors)
            if (old.expiresAt < this.now())
                this.cursors.delete(token);
        while (this.cursors.size >= (this.options.maxCursors ?? 256))
            this.cursors.delete(this.cursors.keys().next().value!);
        const token = randomUUID();
        this.cursors.set(token, { ...entry, expiresAt: this.now() + (this.options.cursorTtlMs ?? 600000) });
        return token;
    }
    private remaining(deadline: number) {
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining <= 0)
            throw new HistoryError('HISTORY_TIMEOUT', 'Native history read exceeded its time budget');
        return remaining;
    }
    private async bounded<T>(work: (deadline: number) => Promise<T>): Promise<T> {
        if (this.active >= (this.options.maxConcurrent ?? 2))
            throw new HistoryError('HISTORY_BUSY', 'Native history read capacity reached');
        this.active++;
        try {
            return await work(performance.now() + (this.options.deadlineMs ?? 12000));
        }
        finally {
            this.active--;
        }
    }
    private check(threadId: string, revision: string, deadline: number) {
        this.remaining(deadline);
        if (this.revision(threadId) !== revision)
            throw new HistoryError('HISTORY_STALE', 'Native history changed while reading; reload the current page');
    }
    async turns(threadId: string, options: {
        cursor?: string;
        limit?: number;
        scope: string;
        forceFresh?: boolean;
    }): Promise<HistoryPage<NativeTurn>> {
        const pageSize = options.limit ?? 5;
        if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 20)
            throw new HistoryError('HISTORY_CURSOR_INVALID', 'History page limit must be 1–20');
        const revision = this.pageRevision(threadId, options.cursor === undefined);
        const position = this.decode(options.cursor, threadId, undefined, revision, 'turns', options.scope, pageSize);
        const root = options.cursor === undefined;
        const validate = root && (this.rootLeases.get(threadId) ?? 0) <= this.now();
        if (options.forceFresh || validate) this.discardCached(threadId);
        const descriptor = JSON.stringify([threadId, 'turns', pageSize, position?.source ?? 'native-pages', position?.position ?? null]);
        const key = JSON.stringify([threadId, options.scope, revision, 'turns', pageSize, position?.source, position?.position]);
        const load = async (deadline: number, expectedRevision: string): Promise<PageProjection<NativeTurn>> => {
            const snapshotSeq = this.options.sequence?.() ?? 0;
            const itemPositions: NonNullable<PageProjection<NativeTurn>['itemPositions']> = Object.create(null);
            const itemTimings: Record<string, NativeItemTiming> = Object.create(null);
            let fullDigest: string | undefined;
            let source: Cursor['source'] = position?.source ?? 'native-pages', turns: NativeTurn[], next: string | number | null;
            if (source === 'native-pages') {
                try {
                    const page = await this.codex.listTurns({ threadId, cursor: position?.position as string | undefined, limit: pageSize }, this.remaining(deadline));
                    if (page.data.length > pageSize)
                        throw new HistoryError('HISTORY_PROTOCOL', 'Native turn page exceeded the requested limit');
                    if (page.nextCursor && page.nextCursor === position?.position)
                        throw new HistoryError('HISTORY_PROTOCOL', 'Native history cursor did not advance');
                    turns = [...new Map(page.data.map(turn => [turn.id, { ...turn }])).values()].slice(0, pageSize);
                    next = page.nextCursor;
                    // Two workers per admitted history request: at most four Item
                    // RPCs with the default two-request history capacity.
                    let index = 0, failed = false;
                    const workers = await Promise.allSettled(Array.from({ length: Math.min(2, turns.length) }, async () => {
                        try {
                            while (!failed && index < turns.length) {
                                const turn = turns[index++];
                                const part = await this.itemPage(threadId, turn.id, undefined, deadline);
                                turn.items = part.items;
                                Object.assign(itemTimings, part.itemTimings);
                                turn.itemsView = part.next === null ? 'full' : 'summary';
                                if (part.next !== null) itemPositions[turn.id] = { source: part.source, position: part.next };
                            }
                        } catch (error) { failed = true; throw error; }
                    }));
                    // Drain both workers before releasing the request capacity.
                    // An early rejection must not leave unaccounted native RPCs.
                    const rejected = workers.find(result => result.status === 'rejected');
                    if (rejected?.status === 'rejected') throw rejected.reason;
                }
                catch (error) {
                    if (!fallback(error))
                        throw error;
                    // A native-page cursor cannot be interpreted as a full-read offset.
                    if (position)
                        throw new HistoryError('HISTORY_STALE', 'Native pagination became unavailable; reload the first page');
                    source = 'native-read';
                }
            }
            if (source === 'native-read') {
                const offset = (position?.position as number | undefined) ?? 0;
                const result = await this.codex.readThread(threadId, true, this.remaining(deadline));
                if (result.thread.id !== threadId)
                    throw new HistoryError('HISTORY_PROTOCOL', 'Native history returned another thread');
                fullDigest = this.digest(result.thread.turns);
                const total = result.thread.turns.length;
                turns = result.thread.turns.slice(Math.max(0, total - offset - pageSize), Math.max(0, total - offset)).reverse().map(turn => ({ ...turn }));
                next = offset + pageSize < total ? offset + pageSize : null;
                for (const turn of turns) {
                    if (turn.items.length > 40)
                        itemPositions[turn.id] = { source, position: 40 };
                    turn.items = turn.items.slice(-40);
                    turn.itemsView = itemPositions[turn.id] ? 'summary' : 'full';
                }
            }
            this.check(threadId, expectedRevision, deadline);
            const contentDigest = this.digest({ source, turns: turns!, itemTimings, hasNext: next! !== null });
            let budget = 256 * 1024 - Buffer.byteLength(JSON.stringify(itemTimings)), truncated = false;
            const data = turns!.reverse().map(turn => {
                const items: NativeItem[] = [];
                for (const item of turn.items) {
                    if (budget < Buffer.byteLength(JSON.stringify({ id: item.id, type: item.type })) + 64)
                        throw new HistoryError('HISTORY_PROTOCOL', 'Native history identities exceeded the projection budget; request a smaller page');
                    const projected = projectItem(item, Math.min(16384, Math.max(0, budget)));
                    budget -= projected.bytes;
                    truncated ||= projected.truncated;
                    items.push(projected.item);
                }
                // Do not forward arbitrary large native metadata alongside bounded item projections.
                const metadata = projectItem({ ...turn, items: [], type: 'turn' }, Math.min(4096, Math.max(0, budget)));
                budget -= metadata.bytes;
                truncated ||= metadata.truncated;
                return { ...metadata.item, id: turn.id, status: turn.status, items } as NativeTurn;
            });
            return { epoch: this.options.epoch, revision: expectedRevision, source, data, snapshotSeq, truncated, itemPositions, contentDigest, ...(fullDigest ? { fullDigest } : {}),
                ...(Object.keys(itemTimings).length ? { itemTimings } : {}),
                complete: next! === null && Object.keys(itemPositions).length === 0 && !truncated, nextPosition: next! };
        };
        const projection = await this.projection(key, options.forceFresh || validate, () => this.bounded(async deadline => {
            const fresh = await load(deadline, revision);
            if (validate) await this.validateObserved(threadId, revision, descriptor, fresh, deadline);
            return fresh;
        }));
        if (this.revision(threadId) !== revision) throw new HistoryError('HISTORY_STALE', 'Native history changed while reading; reload the current page');
        this.observe(threadId, descriptor, projection, load, root);
        if (root) this.validateRoot(threadId, pageSize, projection);
        return this.page(projection, options.scope, threadId, 'turns', pageSize);
    }
    private async itemPage(threadId: string, turnId: string, position: Cursor | undefined, deadline: number) {
        if (position?.source !== 'native-read') {
            try {
                const page = await this.codex.listItems({ threadId, turnId, cursor: position?.position as string | undefined, limit: 40 }, this.remaining(deadline));
                if (page.data.length > 40)
                    throw new HistoryError('HISTORY_PROTOCOL', 'Native item page exceeded the requested limit');
                if (page.nextCursor && page.nextCursor === position?.position)
                    throw new HistoryError('HISTORY_PROTOCOL', 'Native item cursor did not advance');
                if (page.data.some(entry => entry.turnId !== turnId))
                    throw new HistoryError('HISTORY_PROTOCOL', 'Native history returned another turn');
                const entries = [...new Map(page.data.map(entry => [entry.item.id, entry])).values()].slice(0, 40).reverse();
                const itemTimings: Record<string, NativeItemTiming> = Object.create(null);
                for (const entry of entries) {
                    const timing = nativeItemTiming(entry);
                    if (Object.keys(timing).length) itemTimings[entry.item.id] = timing;
                }
                return { items: entries.map(entry => entry.item), itemTimings, next: page.nextCursor, source: 'native-pages' as const };
            }
            catch (error) {
                if (!fallback(error))
                    throw error;
                if (position)
                    throw new HistoryError('HISTORY_STALE', 'Native item pagination became unavailable; reload the first page');
            }
        }
        const result = await this.codex.readThread(threadId, true, this.remaining(deadline));
        if (result.thread.id !== threadId)
            throw new HistoryError('HISTORY_PROTOCOL', 'Native history returned another thread');
        const turn = result.thread.turns.find(turn => turn.id === turnId);
        if (!turn)
            throw new HistoryError('HISTORY_STALE', 'Native history turn no longer exists');
        const offset = (position?.position as number | undefined) ?? 0, total = turn.items.length;
        return { items: turn.items.slice(Math.max(0, total - offset - 40), Math.max(0, total - offset)), itemTimings: {}, next: offset + 40 < total ? offset + 40 : null, source: 'native-read' as const, fullDigest: this.digest(result.thread.turns) };
    }
    async items(threadId: string, turnId: string, options: {
        cursor?: string;
        scope: string;
        forceFresh?: boolean;
    }): Promise<HistoryPage<NativeItem>> {
        const revision = this.pageRevision(threadId, false);
        const position = this.decode(options.cursor, threadId, turnId, revision, 'items', options.scope);
        if (options.forceFresh) this.discardCached(threadId);
        const descriptor = JSON.stringify([threadId, 'items', turnId, position?.source ?? 'native-pages', position?.position ?? null]);
        const key = JSON.stringify([threadId, options.scope, revision, 'items', turnId, position?.source, position?.position]);
        const load = async (deadline: number, expectedRevision: string): Promise<PageProjection<NativeItem>> => {
            const snapshotSeq = this.options.sequence?.() ?? 0;
            const page = await this.itemPage(threadId, turnId, position, deadline);
            this.check(threadId, expectedRevision, deadline);
            let budget = 256 * 1024 - Buffer.byteLength(JSON.stringify(page.itemTimings)), truncated = false;
            const data = page.items.map(item => {
                if (budget < Buffer.byteLength(JSON.stringify({ id: item.id, type: item.type })) + 64)
                    throw new HistoryError('HISTORY_PROTOCOL', 'Native item identities exceeded the projection budget');
                const projected = projectItem(item, Math.min(16384, Math.max(0, budget)));
                budget -= projected.bytes;
                truncated ||= projected.truncated;
                return projected.item;
            });
            return { epoch: this.options.epoch, revision: expectedRevision, source: page.source, data, snapshotSeq, truncated, complete: page.next === null && !truncated,
                ...(Object.keys(page.itemTimings).length ? { itemTimings: page.itemTimings } : {}),
                nextPosition: page.next, contentDigest: this.digest({ items: page.items, itemTimings: page.itemTimings, source: page.source, hasNext: page.next !== null }), ...(page.fullDigest ? { fullDigest: page.fullDigest } : {}) };
        };
        const projection = await this.projection(key, options.forceFresh, () => this.bounded(deadline => load(deadline, revision)));
        if (this.revision(threadId) !== revision) throw new HistoryError('HISTORY_STALE', 'Native history changed while reading; reload the current page');
        this.observe(threadId, descriptor, projection, load, options.cursor === undefined);
        return this.page(projection, options.scope, threadId, 'items', undefined, turnId);
    }
    private async detailItem(threadId: string, turnId: string, itemId: string, scope: string, revision: string, deadline: number) {
        let nativePosition: Cursor | undefined, selected: NativeItem | undefined, source: 'native-pages' | 'native-read' = 'native-pages', fullDigest: string | undefined;
        const seen = new Set<string>();
        for (let page = 0; page < 32; page++) {
            const part = await this.itemPage(threadId, turnId, nativePosition, deadline);
            source = part.source; fullDigest = part.fullDigest;
            selected = part.items.find(item => item.id === itemId);
            if (selected)
                break;
            if (part.next === null)
                break;
            const key = String(part.next);
            if (seen.has(key))
                throw new HistoryError('HISTORY_PROTOCOL', 'Native detail cursor did not advance');
            seen.add(key);
            nativePosition = { scope, threadId, turnId, revision, kind: 'items', source, position: part.next, expiresAt: this.now() + 60000 };
        }
        if (!selected)
            throw new HistoryError('HISTORY_STALE', 'Item was not found within the native detail read budget');
        return { selected, source, fullDigest };
    }
    /** Bounded chunks of one native item, for content too large for display projections.
     * No raw history is cached: every page re-reads Codex and verifies its digest. */
    async details(threadId: string, turnId: string, itemId: string, options: {
        scope: string;
        cursor?: string;
    }) {
        return this.bounded(async (deadline) => {
            const revision = this.revision(threadId), position = options.cursor ? this.detailCursors.get(options.cursor) : undefined;
            if (options.cursor && (!position || position.expiresAt < this.now() || position.scope !== options.scope || position.threadId !== threadId || position.turnId !== turnId || position.itemId !== itemId || position.revision !== revision))
                throw new HistoryError('HISTORY_CURSOR_INVALID', 'Item detail cursor is stale or outside this query');
            const { selected, source, fullDigest } = await this.detailItem(threadId, turnId, itemId, options.scope, revision, deadline);
            this.check(threadId, revision, deadline);
            const bytes = Buffer.from(JSON.stringify(selected), 'utf8');
            if (bytes.length > 8 * 1024 * 1024)
                throw new HistoryError('HISTORY_PROTOCOL', 'Native item exceeded the detail byte budget');
            const sha256 = createHash('sha256').update(bytes).digest('hex'), offset = position?.offset ?? 0;
            const observation: PageProjection<NativeItem> = { epoch: this.options.epoch, revision, source, data: [], nextPosition: null,
                complete: true, truncated: false, snapshotSeq: 0, contentDigest: this.digest(selected), ...(fullDigest ? { fullDigest } : {}) };
            this.observe(threadId, JSON.stringify([threadId, 'detail', turnId, itemId]), observation, async (readDeadline, expectedRevision) => {
                const current = await this.detailItem(threadId, turnId, itemId, options.scope, expectedRevision, readDeadline);
                return { ...observation, revision: expectedRevision, contentDigest: this.digest(current.selected), fullDigest: current.fullDigest };
            }, false);
            if (position && (position.digest !== sha256 || offset >= bytes.length))
                throw new HistoryError('HISTORY_STALE', 'Native item changed while its details were being read');
            const end = Math.min(offset + 65536, bytes.length), chunk = bytes.subarray(offset, end).toString('base64');
            let nextCursor: string | null = null;
            for (const [token, entry] of this.detailCursors)
                if (entry.expiresAt < this.now())
                    this.detailCursors.delete(token);
            if (end < bytes.length) {
                while (this.detailCursors.size >= (this.options.maxCursors ?? 256))
                    this.detailCursors.delete(this.detailCursors.keys().next().value!);
                nextCursor = randomUUID();
                this.detailCursors.set(nextCursor, { scope: options.scope, threadId, turnId, itemId, revision, digest: sha256, offset: end, expiresAt: this.now() + (this.options.cursorTtlMs ?? 600000) });
            }
            return { epoch: this.options.epoch, historyRevision: revision, source: source === 'native-read' ? 'native-read-projection' : 'native-pagination', itemId, encoding: 'base64', format: 'native-item-json', chunk, offsetBytes: offset, totalBytes: bytes.length, sha256, nextCursor, complete: nextCursor === null };
        });
    }
}
