import { expect, it } from 'vitest';
import { useSession } from './store';
import type { Thread, ServerNotification } from '../../../packages/shared/protocol';

it('replaces streamed content with native completion and deduplicates by item ID', () => {
  useSession.setState({ thread: { id: 't' } as Thread, items: {}, events: [], pending: [] });
  const emit = (method: string, params: object) => useSession.getState().event({ method, params } as ServerNotification);
  const item = { type: 'agentMessage', id: 'i', text: '', phase: null, memoryCitation: null };
  emit('item/started', { threadId: 't', turnId: 'u', item });
  emit('item/agentMessage/delta', { threadId: 't', turnId: 'u', itemId: 'i', delta: 'hello' });
  emit('item/completed', { threadId: 't', turnId: 'u', item: { ...item, text: 'hello world' } });
  emit('item/completed', { threadId: 't', turnId: 'u', item: { ...item, text: 'hello world' } });
  expect(Object.keys(useSession.getState().items)).toEqual(['i']);
  expect(useSession.getState().items.i).toMatchObject({ text: 'hello world' });
  emit('item/agentMessage/delta', { threadId: 'other', itemId: 'i', delta: 'unrelated' });
  expect(useSession.getState().items.i).toMatchObject({ text: 'hello world' });
});
