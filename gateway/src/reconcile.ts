import type { EventEnvelope } from '../../packages/gateway-protocol/generated/types.js';

/** Pure recovery rules for protocol consumers; this is not a history store. */
export interface EventPosition { installationId: string; epoch: string; seq: number }
export type EventDecision = {
  action: 'apply' | 'duplicate' | 'replay' | 'reset' | 'invalidate' | 'skip';
  nextSeq: number;
  reason?: 'IDENTITY_CHANGED' | 'INVALID_SEQUENCE' | 'SEQUENCE_GAP' | 'UNKNOWN_STATE_EVENT';
};

/** Persist nextSeq only AFTER applying the corresponding cache mutation/invalidation. */
export function acceptEvent(position: EventPosition, event: EventEnvelope, knownKinds: ReadonlySet<string>): EventDecision {
  if (event.installationId !== position.installationId || event.epoch !== position.epoch) {
    return { action: 'reset', nextSeq: position.seq, reason: 'IDENTITY_CHANGED' };
  }
  if (!Number.isSafeInteger(event.seq) || event.seq <= 0) {
    return { action: 'reset', nextSeq: position.seq, reason: 'INVALID_SEQUENCE' };
  }
  if (event.seq <= position.seq) return { action: 'duplicate', nextSeq: position.seq };
  if (event.seq !== position.seq + 1) return { action: 'replay', nextSeq: position.seq, reason: 'SEQUENCE_GAP' };
  if (knownKinds.has(event.kind)) return { action: 'apply', nextSeq: event.seq };
  if (event.impact === 'informational') return { action: 'skip', nextSeq: event.seq };
  return { action: 'invalidate', nextSeq: event.seq, reason: 'UNKNOWN_STATE_EVENT' };
}

export interface ItemProjection {
  id: string;
  /** Last bounded native snapshot/full item, never blindly appended to after recovery. */
  baseline: string;
  /** A separate temporary live stream, possibly incomplete while synchronizing. */
  stream: string;
  status: 'syncing' | 'streaming' | 'complete';
  terminal: boolean;
  detailsRequired: boolean;
}

export type ItemUpdate =
  | { kind: 'snapshot'; id: string; text: string; terminal: boolean; complete: boolean }
  | { kind: 'started'; id: string; text: string; complete: boolean }
  | { kind: 'delta'; id: string; text: string }
  | { kind: 'completed'; id: string; text: string; complete: boolean }
  | { kind: 'gap'; id: string };

/**
 * Normalize native item facts before calling this helper. observedStartSeq and
 * observedEndSeq are deliberately absent: Gateway observation order is not a
 * native snapshot watermark. A caller only applies continuous accepted events.
 */
export function mergeItem(current: ItemProjection | undefined, update: ItemUpdate, maxBytes = 256 * 1024): ItemProjection {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('Invalid item projection budget');
  if (current && current.id !== update.id) throw new TypeError('Item projection ID mismatch');
  const previous = current ?? { id: update.id, baseline: '', stream: '', status: 'syncing', terminal: false, detailsRequired: false };
  let next: ItemProjection;
  switch (update.kind) {
    case 'gap':
      next = { ...previous, stream: '', status: 'syncing', detailsRequired: true };
      break;
    case 'snapshot':
      // A complete terminal fact already observed during this recovery wins
      // over a concurrently obtained active snapshot that may be older.
      if (previous.terminal && (!update.terminal || (previous.status === 'complete' && !update.complete))) return previous;
      next = {
        id: update.id, baseline: update.text, stream: '', terminal: update.terminal,
        status: update.terminal && update.complete ? 'complete' : 'syncing', detailsRequired: !update.complete,
      };
      break;
    case 'started':
      if (previous.terminal) return previous;
      // Only an item first observed from its complete start gets an appendable
      // live stream. A recovered baseline never acquires that property later.
      next = current ? { ...previous, status: 'syncing' } : {
        id: update.id, baseline: '', stream: update.text, terminal: false,
        status: update.complete ? 'streaming' : 'syncing', detailsRequired: !update.complete,
      };
      break;
    case 'delta':
      if (previous.terminal) return previous;
      next = { ...previous, stream: previous.stream + update.text };
      break;
    case 'completed':
      if (previous.terminal && previous.status === 'complete' && !update.complete) return previous;
      next = {
        id: update.id, baseline: update.text, stream: '', terminal: true,
        status: update.complete ? 'complete' : 'syncing', detailsRequired: !update.complete,
      };
      break;
  }
  if (Buffer.byteLength(next.baseline) + Buffer.byteLength(next.stream) > maxBytes) {
    // A bound is a visible loss of completeness, never silent text truncation.
    next = { ...next, baseline: '', stream: '', status: 'syncing', detailsRequired: true };
  }
  return next;
}
