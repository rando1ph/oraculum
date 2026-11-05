import { expect, it, vi } from 'vitest';
import { readHistory, readHistoryItems } from './history';
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
it('loads bounded recent pages and previews huge native outputs without modifying the native item', async () => {
  const huge = { id: 'tool', type: 'commandExecution', aggregatedOutput: 'x'.repeat(2_000_000) };
  const request = vi.fn(async (method: string) => method === 'thread/turns/list'
    ? { data: [{ id: 'u', items: [], status: 'completed' }], nextCursor: 'older-turns' }
    : { data: [{ turnId: 'u', item: huge }], nextCursor: 'older-items' });
  const result = await readHistory(client(request), thread, undefined, true);
  expect(request).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result).length).toBeLessThan(10_000);
  expect(result.history).toMatchObject({ nextCursor: 'older-turns', itemCursors: { u: 'older-items' }, details: [{ turnId: 'u', itemId: 'tool', cursor: null }] });
  expect(huge.aggregatedOutput).toHaveLength(2_000_000);
});
it('keeps older turns and items reachable when native pagination is unavailable', async () => {
  const turns = Array.from({ length: 12 }, (_, index) => ({ id: `turn-${index}`, items: Array.from({ length: 45 }, (_, i) => ({ type: 'agentMessage', id: `${index}-${i}`, text: String(i) })), status: 'completed' }));
  const request = vi.fn(async (method: string) => {
    if (method === 'thread/read') return { thread: { ...thread, turns } };
    throw new NativeRpcError('unsupported pagination', -32601);
  });
  const recent = await readHistory(client(request), thread, undefined, true);
  expect(recent.thread.turns.map(t => t.id)).toEqual(['turn-7', 'turn-8', 'turn-9', 'turn-10', 'turn-11']);
  expect(recent.history?.nextCursor).toBe('legacy-turn:5');
  const older = await readHistory(client(request), thread, recent.history!.nextCursor!, true);
  expect(older.thread.turns.map(t => t.id)).toEqual(['turn-2', 'turn-3', 'turn-4', 'turn-5', 'turn-6']);
  const items = await readHistoryItems(client(request), 't', 'turn-11', recent.history!.itemCursors!['turn-11']);
  expect(items.items.map(item => item.id)).toEqual(['11-0', '11-1', '11-2', '11-3', '11-4']);
  expect(items.nextCursor).toBeNull();
});
