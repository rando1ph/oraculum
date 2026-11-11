import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '../../packages/gateway-protocol/generated/types.js';
import { acceptEvent, mergeItem } from './reconcile.js';

const position = { installationId: 'i', epoch: 'e', seq: 10 };
const known = new Set(['item.delta', 'item.completed']);
const envelope = (seq: number, kind = 'item.delta', impact: string | undefined = 'state'): EventEnvelope => ({
  installationId: 'i', epoch: 'e', seq, kind, ...(impact === undefined ? {} : { impact }), scope: { threadId: 't' }, payload: {},
});

describe('event sequence and unknown-kind recovery rules', () => {
  it('ignores duplicates and out-of-order delivery, but never advances over gaps', () => {
    expect(acceptEvent(position, envelope(10), known)).toEqual({ action: 'duplicate', nextSeq: 10 });
    expect(acceptEvent(position, envelope(9), known)).toEqual({ action: 'duplicate', nextSeq: 10 });
    expect(acceptEvent(position, envelope(12), known)).toMatchObject({ action: 'replay', nextSeq: 10 });
    expect(acceptEvent(position, envelope(11), known)).toEqual({ action: 'apply', nextSeq: 11 });
  });

  it('requires reset across installation/epoch changes and invalid numbers', () => {
    for (const change of [{ installationId: 'other' }, { epoch: 'new' }, { seq: NaN }, { seq: 1.1 }, { seq: -1 }, { seq: 0 }]) {
      expect(acceptEvent(position, { ...envelope(11), ...change }, known)).toMatchObject({ action: 'reset', nextSeq: 10 });
    }
  });

  it('skips only explicitly informational unknown kinds; critical and future impact values invalidate', () => {
    expect(acceptEvent(position, envelope(11, 'future', 'informational'), known)).toEqual({ action: 'skip', nextSeq: 11 });
    for (const impact of ['state', 'future', undefined]) {
      const value = envelope(11, 'future', impact);
      if (impact === undefined) delete value.impact;
      expect(acceptEvent(position, value, known)).toMatchObject({ action: 'invalidate', nextSeq: 11 });
    }
  });
});

describe('snapshot and streaming item reconciliation', () => {
  it('does not append delayed or overlapping deltas to active snapshot text', () => {
    const snapshot = mergeItem(undefined, { kind: 'snapshot', id: 'a', text: 'Hello world', terminal: false, complete: true });
    const duplicateDelta = mergeItem(snapshot, { kind: 'delta', id: 'a', text: ' world' });
    expect(duplicateDelta).toMatchObject({ baseline: 'Hello world', stream: ' world', status: 'syncing' });
    const final = mergeItem(duplicateDelta, { kind: 'completed', id: 'a', text: 'Hello world!', complete: true });
    expect(final).toMatchObject({ baseline: 'Hello world!', stream: '', status: 'complete', terminal: true });
    expect(mergeItem(final, { kind: 'delta', id: 'a', text: ' world' })).toBe(final);
  });

  it('allows a complete newly observed start to stream, but a gap discards that append guarantee', () => {
    const started = mergeItem(undefined, { kind: 'started', id: 'a', text: 'Hi', complete: true });
    const live = mergeItem(started, { kind: 'delta', id: 'a', text: ' there' });
    expect(live).toMatchObject({ baseline: '', stream: 'Hi there', status: 'streaming' });
    const gap = mergeItem(live, { kind: 'gap', id: 'a' });
    const afterGap = mergeItem(gap, { kind: 'delta', id: 'a', text: ' again' });
    expect(afterGap).toMatchObject({ stream: ' again', status: 'syncing', detailsRequired: true });
  });

  it('keeps truncated completions incomplete and converges only on a complete terminal native fact', () => {
    const partial = mergeItem(undefined, { kind: 'completed', id: 'a', text: 'part', complete: false });
    expect(partial).toMatchObject({ terminal: true, status: 'syncing', detailsRequired: true });
    expect(mergeItem(partial, { kind: 'delta', id: 'a', text: 'unsafe' })).toBe(partial);
    const full = mergeItem(partial, { kind: 'snapshot', id: 'a', text: 'complete', terminal: true, complete: true });
    expect(full).toMatchObject({ baseline: 'complete', status: 'complete', detailsRequired: false });
    expect(mergeItem(full, { kind: 'snapshot', id: 'a', text: 'old active', terminal: false, complete: true })).toBe(full);
    expect(mergeItem(full, { kind: 'snapshot', id: 'a', text: 'late truncated', terminal: true, complete: false })).toBe(full);
    expect(mergeItem(full, { kind: 'completed', id: 'a', text: 'late truncated', complete: false })).toBe(full);
    expect(mergeItem(partial, { kind: 'snapshot', id: 'a', text: 'old active', terminal: false, complete: true })).toBe(partial);
  });

  it('does not turn a recovered snapshot into a complete stream on a late started event', () => {
    const snapshot = mergeItem(undefined, { kind: 'snapshot', id: 'a', text: 'already there', terminal: false, complete: true });
    const lateStart = mergeItem(snapshot, { kind: 'started', id: 'a', text: '', complete: true });
    expect(lateStart).toMatchObject({ baseline: 'already there', status: 'syncing' });
  });

  it('bounds temporary projection bytes without claiming that silently truncated content is complete', () => {
    const overflow = mergeItem(undefined, { kind: 'completed', id: 'a', text: '🙂'.repeat(100), complete: true }, 100);
    expect(overflow).toMatchObject({ baseline: '', stream: '', status: 'syncing', detailsRequired: true });
    expect(() => mergeItem(overflow, { kind: 'delta', id: 'b', text: '' })).toThrow('ID mismatch');
  });
});
