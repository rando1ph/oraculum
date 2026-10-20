import { expect, it, vi } from 'vitest';
import { readHistory } from './history';
import { NativeRpcError } from './codex';
import type { Thread } from '../../packages/shared/protocol';
const thread = { id: 't', status: { type: 'idle' } } as Thread;
function client(mock: ReturnType<typeof vi.fn>) {
  return { request: async <T>(method: string, params: object) => await mock(method, params) as T };
}
it('reads native turn and item pages, deduplicates native IDs and exposes older cursor', async () => {
  const request = vi.fn(async (method, params) => {
    if (method === 'thread/turns/list') return { data: [{ id: 'u', items: [], status: 'completed' }], nextCursor: 'older' };
    return { data: [{ turnId: 'u', item: { id: 'i', type: 'agentMessage', text: params.cursor ? 'complete' : 'first' } }], nextCursor: params.cursor ? null : 'page2' };
  });
  const result = await readHistory(client(request), thread);
  expect(result.thread.turns[0].items).toEqual([{ id: 'i', type: 'agentMessage', text: 'complete' }]);
  expect(result.history).toMatchObject({ source: 'native-pages', nextCursor: 'older' });
  expect(result.history!.warning).toContain('部分历史未能恢复');
  expect(request).toHaveBeenCalledWith('thread/items/list', expect.objectContaining({ cursor: 'page2', turnId: 'u' }));
});
it('falls back explicitly on unsupported pagination but does not conceal transport errors', async () => {
  const request = vi.fn(async method => {
    if (method === 'thread/turns/list') throw new NativeRpcError('unsupported', -32601);
    return { thread: { ...thread, turns: [] } };
  });
  expect((await readHistory(client(request), thread)).history?.source).toBe('native-read');
  request.mockRejectedValue(new Error('transport lost'));
  await expect(readHistory(client(request), thread)).rejects.toThrow('transport lost');
});
it('rejects cross-turn items and repeated cursors rather than inventing complete history', async () => {
  const request = vi.fn(async (method): Promise<unknown> => method === 'thread/turns/list'
    ? { data: [{ id: 'u', items: [] }], nextCursor: null }
    : { data: [{ turnId: 'other', item: { id: 'i' } }], nextCursor: null });
  await expect(readHistory(client(request), thread)).rejects.toThrow('another turn');
  request.mockImplementation(async method => method === 'thread/turns/list'
    ? { data: [{ id: 'u', items: [] }], nextCursor: null }
    : { data: [], nextCursor: 'same' });
  await expect(readHistory(client(request), thread)).rejects.toThrow('cursor repeated');
});
