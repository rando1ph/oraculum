import { beforeEach, expect, it } from 'vitest';
import { itemKey, useSession } from './store';
import type { Thread, ServerNotification } from '../../../packages/shared/protocol';
const emit = (method: string, params: object) => useSession.getState().event({ method, params } as ServerNotification);
const item = { type: 'agentMessage', id: 'i', text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
beforeEach(() => { useSession.getState().reset(); useSession.setState({ thread: { id: 't', turns: [] } as unknown as Thread }); });
it('deduplicates by turn/item and ignores other threads and late deltas after completion', () => {
  emit('item/started', { threadId: 't', turnId: 'u', item });
  emit('item/agentMessage/delta', { threadId: 't', turnId: 'u', itemId: 'i', delta: 'hello' });
  emit('item/completed', { threadId: 't', turnId: 'u', item: { ...item, text: 'hello world' } });
  emit('item/completed', { threadId: 't', turnId: 'u', item: { ...item, text: 'hello world' } });
  emit('item/agentMessage/delta', { threadId: 'other', turnId: 'u', itemId: 'i', delta: 'unrelated' });
  emit('item/agentMessage/delta', { threadId: 't', turnId: 'u', itemId: 'i', delta: 'late' });
  expect(Object.keys(useSession.getState().items)).toEqual([itemKey('u', 'i')]);
  expect(useSession.getState().items[itemKey('u', 'i')].item).toMatchObject({ text: 'hello world' });
  emit('item/started', { threadId: 't', turnId: 'v', item });
  expect(Object.keys(useSession.getState().items)).toHaveLength(2);
});
it('does not clear another active turn on late completion and exposes native failed state', () => {
  emit('turn/started', { threadId: 't', turn: { id: 'new', status: 'inProgress' } });
  emit('turn/completed', { threadId: 't', turn: { id: 'old', status: 'interrupted' } });
  expect(useSession.getState().activeTurn).toBe('new');
  emit('turn/completed', { threadId: 't', turn: { id: 'new', status: 'failed', error: { message: 'provider error' } } });
  expect(useSession.getState().activeTurn).toBeUndefined();
  expect(useSession.getState().turns.new).toMatchObject({ status: 'failed', error: { message: 'provider error' } });
});
it('keeps observed-only items labelled live until selection changes', () => {
  emit('item/completed', { threadId: 't', turnId: 'u', item });
  useSession.getState().snapshot({ thread: { id: 't', turns: [] } as unknown as Thread, pending: [] });
  expect(useSession.getState().items[itemKey('u', 'i')].source).toBe('live');
  useSession.getState().snapshot({ thread: { id: 'other', turns: [] } as unknown as Thread, pending: [] });
  expect(useSession.getState().items).toEqual({});
});
it('does not replay overlapping deltas during a snapshot', () => {
  emit('item/started', { threadId: 't', turnId: 'u', item: { ...item, text: 'hello' } });
  useSession.getState().event({ method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'u', itemId: 'i', delta: 'hello' } }, true);
  expect(useSession.getState().items[itemKey('u', 'i')].item).toMatchObject({ text: 'hello' });
});
