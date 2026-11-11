import { describe, expect, it } from 'vitest';
import { classifyEvent, validateContract } from '../../packages/gateway-protocol/src/index.js';
import { EventFeedLimitError, EventFeeds, type EventInput } from './events.js';

const event = (text = 'hello'): EventInput => ({ kind: 'item.delta', impact: 'state', scope: { projectId: 'p', threadId: 't' }, payload: { text } });
function connect(feeds: EventFeeds, deviceId = 'a', epoch = 'epoch') {
  const reset = feeds.replay(deviceId, { epoch, afterSeq: 0 });
  expect(reset.resetRequired).toBe(true);
  return reset.headSeq;
}

describe('per-device bounded event recovery', () => {
  it('requires a snapshot for a new feed then replays contiguous device sequences', () => {
    const feeds = new EventFeeds('install', 'epoch');
    const a = connect(feeds);
    const b = connect(feeds, 'b');
    feeds.publish('a', event('a1'));
    feeds.publish('b', event('b1'));
    feeds.publish('b', event('b2'));
    feeds.publish('a', event('a2'));
    expect(feeds.replay('a', { epoch: 'epoch', afterSeq: a }).events.map(item => item.seq)).toEqual([a + 1, a + 2]);
    expect(feeds.replay('b', { epoch: 'epoch', afterSeq: b }).events.map(item => item.seq)).toEqual([b + 1, b + 2]);
    expect(JSON.stringify(feeds.replay('a', { epoch: 'epoch', afterSeq: a }))).not.toContain('b1');
  });

  it('keeps device receipts private and shares only the same device feed with multiple connections', () => {
    const feeds = new EventFeeds('install', 'epoch');
    const a = connect(feeds);
    const b = connect(feeds, 'b');
    const first: number[] = [], second: number[] = [], other: number[] = [];
    const stop = feeds.subscribe('a', value => first.push(value.seq));
    feeds.subscribe('a', value => second.push(value.seq));
    feeds.subscribe('b', value => other.push(value.seq));
    feeds.publish('a', { ...event(), kind: 'operation.changed', payload: { operationId: 'private' } });
    stop();
    feeds.publish('a', event());
    expect(first).toEqual([a + 1]);
    expect(second).toEqual([a + 1, a + 2]);
    expect(other).toEqual([]);
    expect(feeds.head('b')).toBe(b);
    expect(feeds.replay('b', { epoch: 'epoch', afterSeq: b }).events).toEqual([]);
  });

  it('rejects invalid, ahead, wrong-epoch and count-evicted cursors without partial replay', () => {
    const feeds = new EventFeeds('install', 'epoch', { maxEvents: 2 });
    const start = connect(feeds);
    for (const text of ['one', 'two', 'three']) feeds.publish('a', event(text));
    for (const afterSeq of [start, -1, 100, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(feeds.replay('a', { epoch: 'epoch', afterSeq })).toEqual({ resetRequired: true, headSeq: start + 3, events: [] });
    }
    expect(feeds.replay('a', { epoch: 'old', afterSeq: start + 2 }).resetRequired).toBe(true);
    expect(feeds.replay('a', { epoch: 'epoch', afterSeq: start + 1 }).events.map(item => item.seq)).toEqual([start + 2, start + 3]);
    expect(feeds.replay('a', { epoch: 'epoch', afterSeq: start + 3 })).toEqual({ resetRequired: false, headSeq: start + 3, events: [] });
  });

  it('bounds retained UTF-8 bytes and explicitly replaces oversized state with invalidation', () => {
    const feeds = new EventFeeds('install', 'epoch', { maxBytes: 1024 });
    const start = connect(feeds);
    feeds.publish('a', event('🙂'.repeat(100)));
    feeds.publish('a', event('界'.repeat(120)));
    expect(feeds.stats().bytes).toBeLessThanOrEqual(1024);
    expect(feeds.replay('a', { epoch: 'epoch', afterSeq: start }).resetRequired).toBe(true);
    const oversized = feeds.publish('a', event('x'.repeat(2000)));
    expect(oversized.kind).toBe('history.invalidated');
    expect(oversized.impact).toBe('state');
    expect(oversized.scope).toEqual({ projectId: 'p', threadId: 't' });
    expect(oversized.payload).toMatchObject({ truncated: true, detailsAvailable: true, reasonCode: 'EVENT_TOO_LARGE' });
    const hugeScope = feeds.publish('a', { ...event(), scope: { threadId: 'x'.repeat(5000) } });
    expect(hugeScope.scope).toEqual({});
    expect(feeds.stats().bytes).toBeLessThanOrEqual(1024);
  });

  it('expires replay at the exact TTL even while a connection pins its feed', () => {
    let now = 0;
    const feeds = new EventFeeds('install', 'epoch', { maxAgeMs: 100, now: () => now });
    const start = connect(feeds);
    feeds.subscribe('a', () => {});
    feeds.publish('a', event());
    now = 99;
    expect(feeds.replay('a', { epoch: 'epoch', afterSeq: start }).events).toHaveLength(1);
    now = 100;
    expect(feeds.replay('a', { epoch: 'epoch', afterSeq: start }).resetRequired).toBe(true);
    expect(feeds.stats()).toMatchObject({ devices: 1, events: 0, bytes: 0 });
  });

  it('bounds global bytes and count, invalidating only the devices whose events were evicted', () => {
    const feeds = new EventFeeds('install', 'epoch', { maxTotalEvents: 3, maxTotalBytes: 1024 });
    const a = connect(feeds), b = connect(feeds, 'b');
    feeds.publish('a', event('a1'));
    feeds.publish('b', event('b1'));
    feeds.publish('b', event('b2'));
    feeds.publish('b', event('b3'));
    expect(feeds.stats().events).toBe(3);
    expect(feeds.replay('a', { epoch: 'epoch', afterSeq: a }).resetRequired).toBe(true);
    expect(feeds.replay('b', { epoch: 'epoch', afterSeq: b }).events).toHaveLength(3);
    feeds.publish('b', event('x'.repeat(700)));
    expect(feeds.stats().bytes).toBeLessThanOrEqual(1024);
    expect(feeds.replay('b', { epoch: 'epoch', afterSeq: b }).resetRequired).toBe(true);
  });

  it('cannot accept an old cursor after device feed eviction or idle removal', () => {
    let now = 0;
    const feeds = new EventFeeds('install', 'epoch', { maxDevices: 1, maxAgeMs: 100, now: () => now });
    connect(feeds);
    feeds.publish('a', event());
    const oldHead = feeds.head('a');
    connect(feeds, 'b');
    connect(feeds);
    feeds.publish('a', event());
    expect(feeds.replay('a', { epoch: 'epoch', afterSeq: oldHead }).resetRequired).toBe(true);
    expect(feeds.head('a')).toBeGreaterThan(oldHead);
    now = 100;
    expect(feeds.stats().devices).toBe(0);
    expect(feeds.replay('a', { epoch: 'epoch', afterSeq: oldHead }).resetRequired).toBe(true);
  });

  it('protects active feeds, bounds subscriptions, and releases revocation state', () => {
    const feeds = new EventFeeds('install', 'epoch', { maxDevices: 1, maxSubscribersPerDevice: 1 });
    const stop = feeds.subscribe('a', () => {});
    expect(() => feeds.subscribe('a', () => {})).toThrow(EventFeedLimitError);
    expect(() => feeds.ensure('b')).toThrow(EventFeedLimitError);
    stop();
    expect(() => feeds.ensure('b')).not.toThrow();
    feeds.publish('b', event());
    feeds.drop('b');
    expect(feeds.stats()).toEqual({ devices: 0, events: 0, bytes: 0, subscribers: 0 });
  });

  it('notifies live subscribers of new epochs and never reuses an epoch for reset', () => {
    const feeds = new EventFeeds('install', 'epoch');
    connect(feeds);
    const observed: string[] = [];
    feeds.subscribe('a', value => observed.push(`${value.epoch}:${value.kind}`));
    feeds.publish('a', event());
    feeds.reset('next');
    expect(observed).toEqual(['epoch:item.delta', 'next:connection.reset']);
    expect(feeds.replay('a', { epoch: 'epoch', afterSeq: 1 }).resetRequired).toBe(true);
    const head = feeds.head('a');
    feeds.publish('a', event());
    expect(feeds.replay('a', { epoch: 'next', afterSeq: head }).events.map(value => value.seq)).toEqual([head + 1]);
    expect(() => feeds.reset('next')).toThrow('new epoch');
  });

  it('detaches and freezes payloads, isolates broken observers, and rejects invalid JSON without a gap', () => {
    const feeds = new EventFeeds('install', 'epoch');
    const start = connect(feeds);
    const input = event();
    feeds.subscribe('a', () => { throw new Error('socket already closed'); });
    const seen: number[] = [];
    feeds.subscribe('a', value => seen.push(value.seq));
    const result = feeds.publish('a', input);
    (input.payload as { text: string }).text = 'mutated';
    expect(result.payload).toEqual({ text: 'hello' });
    expect(() => { (result.payload as { text: string }).text = 'mutated'; }).toThrow();
    expect(() => feeds.publish('a', { ...input, payload: 1n as never })).toThrow();
    feeds.publish('a', event());
    expect(seen).toEqual([start + 1, start + 2]);
    expect(feeds.stats().subscribers).toBe(1);
  });

  it('rejects unsafe limits rather than disabling retention checks', () => {
    for (const maxEvents of [0, -1, Infinity, NaN, 1.5]) expect(() => new EventFeeds('i', 'e', { maxEvents })).toThrow();
    expect(() => new EventFeeds('i', 'e', { maxBytes: 10 })).toThrow();
  });

  it('publishes contract-valid invalidations and handles wide valid JSON within the retention budget', () => {
    const feeds = new EventFeeds('c4238a48-8b61-4b65-ae60-811251a2b100', 'c4238a48-8b61-4b65-ae60-811251a2b101');
    const wide = feeds.publish('device', { kind: 'future', impact: 'informational', scope: {}, payload: Array.from({ length: 150_000 }, () => 1) });
    expect(validateContract('EventEnvelope', wide)).toBe(true);
    expect(wide.payload).toHaveLength(150_000);
    const oversized = feeds.publish('device', { kind: 'future', impact: 'state', scope: {}, payload: 'x'.repeat(3 * 1024 * 1024) });
    expect(validateContract('EventEnvelope', oversized)).toBe(true);
    expect(validateContract('HistoryInvalidated', oversized.payload)).toBe(true);
    expect(classifyEvent(oversized)).toBe('apply');
  });
});
