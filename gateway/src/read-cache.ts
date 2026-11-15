/** A discarded read must never fill or satisfy a newer cache generation. */
export class ReadCacheInvalidatedError extends Error {
  readonly code = 'READ_STALE';
  constructor() { super('Native state changed while reading; refresh the projection'); }
}

export class ReadCacheBusyError extends Error {
  readonly code = 'NATIVE_BUSY';
  constructor() { super('Native read capacity exhausted'); }
}

type Entry = { json: string; bytes: number; expires: number };
type Pending = { promise: Promise<string> };

/** Disposable JSON projections only; never authorization, receipts, or write preconditions. */
export class BoundedReadCache {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Pending>();
  private bytes = 0;
  private active = 0;
  private readonly now: () => number;
  constructor(private readonly options: { maxEntries?: number; maxBytes?: number; maxPending?: number; now?: () => number } = {}) {
    for (const value of [options.maxEntries, options.maxBytes, options.maxPending]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new RangeError('Invalid read cache limit');
    }
    this.now = options.now ?? Date.now;
  }

  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new RangeError('Invalid read cache lifetime');
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key); this.entries.set(key, existing);
      return JSON.parse(existing.json) as T;
    }
    const reading = this.pending.get(key);
    if (reading) return JSON.parse(await reading.promise) as T;
    if (this.active >= (this.options.maxPending ?? 16)) throw new ReadCacheBusyError();
    this.active++;
    const pending: Pending = { promise: Promise.resolve('') };
    this.pending.set(key, pending);
    pending.promise = Promise.resolve().then(load).then(value => {
      if (this.pending.get(key) !== pending) throw new ReadCacheInvalidatedError();
      const json = JSON.stringify(value), bytes = Buffer.byteLength(json);
      if (ttlMs > 0 && bytes <= (this.options.maxBytes ?? 4 * 1024 * 1024)) {
        while (this.entries.size >= (this.options.maxEntries ?? 128) || this.bytes + bytes > (this.options.maxBytes ?? 4 * 1024 * 1024)) {
          this.remove(this.entries.keys().next().value!);
        }
        this.entries.set(key, { json, bytes, expires: this.now() + ttlMs }); this.bytes += bytes;
      }
      return json;
    }).finally(() => {
      this.active--;
      if (this.pending.get(key) === pending) this.pending.delete(key);
    });
    return JSON.parse(await pending.promise) as T;
  }

  invalidate(key: string): void { this.remove(key); this.pending.delete(key); }
  invalidateWhere(matches: (key: string) => boolean): void {
    for (const key of this.entries.keys()) if (matches(key)) this.remove(key);
    for (const key of this.pending.keys()) if (matches(key)) this.pending.delete(key);
  }
  clear(): void { this.entries.clear(); this.pending.clear(); this.bytes = 0; }
  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(key); }
  }
  private prune(): void {
    const now = this.now();
    for (const [key, value] of this.entries) if (value.expires <= now) this.remove(key);
  }
}
