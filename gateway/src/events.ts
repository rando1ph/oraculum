import type { EventEnvelope } from '../../packages/gateway-protocol/generated/types.js';

export type EventInput = Pick<EventEnvelope, 'kind' | 'impact' | 'scope' | 'payload'>;
export interface EventCursor { epoch: string; afterSeq: number }
export interface EventReplay { resetRequired: boolean; headSeq: number; events: EventEnvelope[] }

export interface EventFeedOptions {
  maxEvents?: number;
  maxBytes?: number;
  maxAgeMs?: number;
  maxTotalEvents?: number;
  maxTotalBytes?: number;
  maxDevices?: number;
  maxSubscribersPerDevice?: number;
  now?: () => number;
}

type StoredEvent = { event: EventEnvelope; bytes: number; at: number; order: number };
type Subscriber = (event: EventEnvelope) => void;
type Feed = {
  head: number;
  floor: number;
  fresh: boolean;
  touched: number;
  bytes: number;
  events: StoredEvent[];
  subscribers: Set<Subscriber>;
};

/** An explicit resource rejection; callers must close/reject excess connections. */
export class EventFeedLimitError extends Error {
  readonly code = 'RATE_LIMITED';
  constructor() { super('The event connection budget is exhausted'); }
}

/**
 * Ephemeral, per-device streams. Callers authorize BEFORE publishing: this class
 * deliberately has no broadcast API and never allocates another device's seq.
 * Retention loss is exposed as resetRequired, never a successful partial replay.
 */
export class EventFeeds {
  private readonly feeds = new Map<string, Feed>();
  private readonly limits: Required<Omit<EventFeedOptions, 'now'>>;
  private readonly now: () => number;
  private epoch: string;
  private sequenceFloor = 0;
  private order = 0;
  private totalBytes = 0;
  private totalEvents = 0;

  constructor(readonly installationId: string, epoch: string, options: EventFeedOptions = {}) {
    this.checkIdentity(installationId);
    this.checkIdentity(epoch);
    this.epoch = epoch;
    this.now = options.now ?? Date.now;
    this.limits = {
      maxEvents: options.maxEvents ?? 1024,
      maxBytes: options.maxBytes ?? 2 * 1024 * 1024,
      maxAgeMs: options.maxAgeMs ?? 5 * 60_000,
      maxTotalEvents: options.maxTotalEvents ?? 16_384,
      maxTotalBytes: options.maxTotalBytes ?? 32 * 1024 * 1024,
      maxDevices: options.maxDevices ?? 128,
      maxSubscribersPerDevice: options.maxSubscribersPerDevice ?? 4,
    };
    for (const limit of Object.values(this.limits)) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('Invalid event feed limit');
    }
    if (this.limits.maxBytes < 1024 || this.limits.maxTotalBytes < 1024) {
      throw new RangeError('Event byte budgets must allow a bounded invalidation event');
    }
  }

  ensure(deviceId: string): void { this.get(deviceId); }

  head(deviceId: string): number { return this.get(deviceId).head; }

  /**
   * Check a local read window without consuming the socket's replay/reset state.
   * Missing retained events cannot prove that the selected scope stayed unchanged.
   * These are Gateway observations, not a native snapshot watermark.
   */
  hasChangesSince(deviceId: string, cursor: EventCursor, scope: { projectId: string; threadId: string }): boolean {
    const feed = this.get(deviceId);
    if (cursor.epoch !== this.epoch || !Number.isSafeInteger(cursor.afterSeq) ||
      cursor.afterSeq < feed.floor || cursor.afterSeq > feed.head) return true;
    return feed.events.some(({ event }) => event.seq > cursor.afterSeq &&
      (event.scope.projectId === undefined || event.scope.projectId === scope.projectId) &&
      (event.scope.threadId === undefined || event.scope.threadId === scope.threadId));
  }

  publish(deviceId: string, input: EventInput): EventEnvelope {
    const feed = this.get(deviceId);
    if (feed.head >= Number.MAX_SAFE_INTEGER - 1) throw new RangeError('Event epoch sequence exhausted');
    const seq = feed.head + 1;
    const makeEvent = (value: EventInput): EventEnvelope => ({
      installationId: this.installationId, epoch: this.epoch, seq,
      kind: value.kind, impact: value.impact, scope: value.scope, payload: value.payload,
    });
    // JSON detachment prevents callers or another subscriber mutating retained
    // events. Unsupported JSON is rejected before committing a sequence number.
    let serialized = JSON.stringify(makeEvent(input));
    const maxBytes = Math.min(this.limits.maxBytes, this.limits.maxTotalBytes);
    if (Buffer.byteLength(serialized) > maxBytes) {
      let invalidation: EventInput = {
        kind: 'history.invalidated', impact: 'state', scope: input.scope,
        payload: { reasonCode: 'EVENT_TOO_LARGE', truncated: true, detailsAvailable: true },
      };
      serialized = JSON.stringify(makeEvent(invalidation));
      if (Buffer.byteLength(serialized) > maxBytes) {
        // An oversized scope cannot be represented safely; invalidate all of
        // this device's projections instead of emitting a misleading subset.
        invalidation = { ...invalidation, scope: {} };
        serialized = JSON.stringify(makeEvent(invalidation));
      }
    }
    const event = freezeJson(JSON.parse(serialized) as EventEnvelope);
    const bytes = Buffer.byteLength(serialized);
    feed.head = seq;
    this.sequenceFloor = Math.max(this.sequenceFloor, seq + 1);
    feed.events.push({ event, bytes, at: this.now(), order: this.order++ });
    feed.bytes += bytes;
    this.totalBytes += bytes;
    this.totalEvents++;
    while (feed.events.length > this.limits.maxEvents || feed.bytes > this.limits.maxBytes) this.removeFirst(feed);
    this.enforceGlobalBudget();
    for (const subscriber of [...feed.subscribers]) {
      try { subscriber(event); } catch { feed.subscribers.delete(subscriber); }
    }
    return event;
  }

  replay(deviceId: string, cursor: EventCursor): EventReplay {
    const feed = this.get(deviceId);
    const resetRequired = feed.fresh || cursor.epoch !== this.epoch
      || !Number.isSafeInteger(cursor.afterSeq) || cursor.afterSeq < feed.floor || cursor.afterSeq > feed.head;
    feed.fresh = false;
    return {
      resetRequired,
      headSeq: feed.head,
      events: resetRequired ? [] : feed.events.filter(({ event }) => event.seq > cursor.afterSeq).map(({ event }) => event),
    };
  }

  /** Subscribe synchronously before calling replay, then send replay before live events. */
  subscribe(deviceId: string, subscriber: Subscriber): () => void {
    const feed = this.get(deviceId);
    if (feed.subscribers.size >= this.limits.maxSubscribersPerDevice && !feed.subscribers.has(subscriber)) {
      throw new EventFeedLimitError();
    }
    feed.subscribers.add(subscriber);
    return () => { feed.subscribers.delete(subscriber); feed.touched = this.now(); };
  }

  /** Remove revoked device state. The caller also terminates its authenticated sockets. */
  drop(deviceId: string): void {
    const feed = this.feeds.get(deviceId);
    if (feed) this.removeFeed(deviceId, feed);
  }

  reset(epoch: string): void {
    this.checkIdentity(epoch);
    if (epoch === this.epoch) throw new RangeError('A reset requires a new epoch');
    this.epoch = epoch;
    this.sequenceFloor = 0;
    this.totalBytes = 0;
    this.totalEvents = 0;
    for (const feed of this.feeds.values()) {
      feed.head = this.sequenceFloor++;
      feed.floor = feed.head;
      feed.fresh = true;
      feed.events = [];
      feed.bytes = 0;
    }
    for (const deviceId of [...this.feeds.keys()]) {
      this.publish(deviceId, { kind: 'connection.reset', impact: 'state', scope: {}, payload: { reasonCode: 'EPOCH_CHANGED' } });
    }
  }

  stats(): { devices: number; events: number; bytes: number; subscribers: number } {
    this.prune();
    return {
      devices: this.feeds.size, events: this.totalEvents, bytes: this.totalBytes,
      subscribers: [...this.feeds.values()].reduce((sum, feed) => sum + feed.subscribers.size, 0),
    };
  }

  private get(deviceId: string): Feed {
    this.checkIdentity(deviceId);
    this.prune();
    let feed = this.feeds.get(deviceId);
    if (!feed) {
      if (this.feeds.size >= this.limits.maxDevices) {
        const candidate = [...this.feeds.entries()].filter(([, value]) => value.subscribers.size === 0)
          .sort((a, b) => a[1].touched - b[1].touched)[0];
        if (!candidate) throw new EventFeedLimitError();
        this.removeFeed(candidate[0], candidate[1]);
      }
      if (this.sequenceFloor >= Number.MAX_SAFE_INTEGER - 1) throw new RangeError('Event epoch sequence exhausted');
      // Only initial bases share a high-water mark. Thereafter each device
      // increments contiguously. Re-created feeds start above every old cursor,
      // so eviction cannot accidentally accept an earlier feed's same number.
      const floor = this.sequenceFloor++;
      feed = { head: floor, floor, fresh: true, touched: this.now(), bytes: 0, events: [], subscribers: new Set() };
      this.feeds.set(deviceId, feed);
    }
    feed.touched = this.now();
    return feed;
  }

  private prune(): void {
    const cutoff = this.now() - this.limits.maxAgeMs;
    for (const [deviceId, feed] of this.feeds) {
      while (feed.events[0] && feed.events[0].at <= cutoff) this.removeFirst(feed);
      if (feed.subscribers.size === 0 && feed.touched <= cutoff) this.removeFeed(deviceId, feed);
    }
  }

  private enforceGlobalBudget(): void {
    while (this.totalEvents > this.limits.maxTotalEvents || this.totalBytes > this.limits.maxTotalBytes) {
      let oldest: Feed | undefined;
      for (const feed of this.feeds.values()) {
        if (feed.events[0] && (!oldest || feed.events[0].order < oldest.events[0]!.order)) oldest = feed;
      }
      if (!oldest) break;
      this.removeFirst(oldest);
    }
  }

  private removeFirst(feed: Feed): void {
    const entry = feed.events.shift();
    if (!entry) return;
    feed.floor = entry.event.seq;
    feed.bytes -= entry.bytes;
    this.totalBytes -= entry.bytes;
    this.totalEvents--;
  }

  private removeFeed(deviceId: string, feed: Feed): void {
    this.totalBytes -= feed.bytes;
    this.totalEvents -= feed.events.length;
    feed.subscribers.clear();
    this.feeds.delete(deviceId);
  }

  private checkIdentity(value: string): void {
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) throw new TypeError('Invalid event identity');
  }
}

function freezeJson<T>(value: T): T {
  // Iterative traversal keeps deeply nested but valid JSON from exhausting the
  // JS stack during freezing. Parsing/serialization retain their native bounds.
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (current && typeof current === 'object') {
      for (const child of Object.values(current)) pending.push(child);
      Object.freeze(current);
    }
  }
  return value;
}
