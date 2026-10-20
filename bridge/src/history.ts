import type { Codex } from './codex';
import { NativeRpcError } from './codex';
import type { Snapshot, Thread } from '../../packages/shared/protocol';
import type { ThreadTurnsListResponse } from '../../.local/codex-protocol/v2/ThreadTurnsListResponse';
import type { ThreadItemsListResponse } from '../../.local/codex-protocol/v2/ThreadItemsListResponse';
import type { ThreadReadResponse } from '../../.local/codex-protocol/v2/ThreadReadResponse';

const warning = '部分历史未能恢复：原生持久历史可能缺少审批、拒绝和工具事件；当前窗口的实时事件不是持久记录。待审批仅在当前 Bridge 生命周期有效。';
export async function readHistory(codex: Pick<Codex, 'request'>, thread: Thread, cursor?: string): Promise<Pick<Snapshot, 'thread' | 'history'>> {
  try {
    const page = await codex.request<ThreadTurnsListResponse>('thread/turns/list', {
      threadId: thread.id, cursor, limit: 20, sortDirection: 'desc', itemsView: 'notLoaded',
    });
    let truncated = false;
    // Each item page is a native read. No rollout parsing or alternate history store.
    for (const turn of page.data) {
      const items = new Map();
      const seen = new Set<string>();
      let itemCursor: string | null = null;
      let pages = 0;
      do {
        const part: ThreadItemsListResponse = await codex.request('thread/items/list', {
          threadId: thread.id, turnId: turn.id, cursor: itemCursor, limit: 100, sortDirection: 'asc',
        });
        for (const entry of part.data) {
          if (entry.turnId !== turn.id) throw new Error('Native history returned an item from another turn');
          items.set(entry.item.id, entry.item);
        }
        itemCursor = part.nextCursor;
        if (itemCursor && seen.has(itemCursor)) throw new Error('Native history cursor repeated');
        if (itemCursor) seen.add(itemCursor);
        pages++;
      } while (itemCursor && pages < 50);
      if (itemCursor) truncated = true;
      turn.items = [...items.values()];
      turn.itemsView = itemCursor ? 'summary' : 'full';
    }
    return {
      thread: { ...thread, turns: [...new Map(page.data.map(t => [t.id, t])).values()].reverse() },
      history: { source: 'native-pages', nextCursor: page.nextCursor,
        warning: warning + (truncated ? ' 超长轮次达到读取上限，内容已截断。' : '') },
    };
  } catch (error) {
    // Only known capability/legacy-store errors may fall back. Other failures stay visible.
    if (!(error instanceof NativeRpcError) ||
      !(error.code === -32601 || /unsupported|experimentalApi|paginated|pagination/i.test(error.message))) throw error;
    const result = await codex.request<ThreadReadResponse>('thread/read', { threadId: thread.id, includeTurns: true });
    return { thread: result.thread, history: { source: 'native-read', warning: `分页接口不可用，降级为 thread/read。${warning}` } };
  }
}
