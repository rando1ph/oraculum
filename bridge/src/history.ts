import type { Codex } from './codex';
import { NativeRpcError } from './codex';
import type { HistoryDetail, Snapshot, Thread, ThreadItem } from '../../packages/shared/protocol';
import type { ThreadTurnsListResponse } from '../../.local/codex-protocol/v2/ThreadTurnsListResponse';
import type { ThreadItemsListResponse } from '../../.local/codex-protocol/v2/ThreadItemsListResponse';
import type { ThreadReadResponse } from '../../.local/codex-protocol/v2/ThreadReadResponse';

const warning = '部分历史未能恢复：原生持久历史可能缺少审批、拒绝和工具事件；当前窗口的实时事件不是持久记录。待审批仅在当前 Bridge 生命周期有效。';
const unsupported = (error: unknown) => error instanceof NativeRpcError && (error.code === -32601 || /unsupported|experimentalApi|paginated|pagination/i.test(error.message));
function offset(cursor: string | undefined, prefix: string) {
  const value = cursor ? Number(cursor.slice(prefix.length)) : 0;
  if (cursor && (!cursor.startsWith(prefix) || !/^\d+$/.test(cursor.slice(prefix.length))) || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid legacy history cursor');
  return value;
}
export function previewItem(item: ThreadItem): { item: ThreadItem; truncated: boolean } {
  let budget = 24_000, truncated = false;
  const clip = (value: any, key = '', depth = 0): any => {
    if (depth > 32) { truncated = true; return '[复杂内容请按需读取原生详情]'; }
    if (typeof value === 'string' && !['id', 'type', 'status', 'cwd'].includes(key)) {
      const length = Math.min(8000, Math.max(0, budget)); budget -= Math.min(length, value.length);
      if (value.length > length) { truncated = true; return value.slice(0, length) + '\n[内容较长，请按需读取原生详情]'; }
    }
    if (Array.isArray(value)) { if (value.length > 100) truncated = true; return value.slice(0, 100).map(v => clip(v, '', depth + 1)); }
    if (value && typeof value === 'object') { const entries = Object.entries(value); if (entries.length > 100) truncated = true; return Object.fromEntries(entries.slice(0, 100).map(([k, v]) => [k, clip(v, k, depth + 1)])); }
    return value;
  };
  // Preserve native user input for receipt correlation. Composer input is bounded.
  return item.type === 'userMessage' ? { item, truncated: false } : { item: clip(item), truncated };
}
export async function nativeItemPage(codex: Pick<Codex, 'request'>, threadId: string, turnId: string, cursor?: string): Promise<ThreadItemsListResponse> {
  if (!cursor?.startsWith('legacy-item:')) {
    try { return await codex.request<ThreadItemsListResponse>('thread/items/list', { threadId, turnId, cursor, limit: 40, sortDirection: 'desc' }); }
    catch (error) { if (!unsupported(error)) throw error; }
  }
  const start = offset(cursor, 'legacy-item:');
  const { thread } = await codex.request<ThreadReadResponse>('thread/read', { threadId, includeTurns: true });
  const turn = thread.turns.find(turn => turn.id === turnId);
  if (!turn) throw new Error('Native history turn no longer exists');
  return { data: turn.items.slice(Math.max(0, turn.items.length - start - 40), Math.max(0, turn.items.length - start)).reverse().map(item => ({ turnId, item, startedAtMs: null, completedAtMs: null })), nextCursor: start + 40 < turn.items.length ? `legacy-item:${start + 40}` : null, backwardsCursor: null };
}
export async function readHistoryItems(codex: Pick<Codex, 'request'>, threadId: string, turnId: string, cursor?: string) {
  const page = await nativeItemPage(codex, threadId, turnId, cursor);
  if (page.nextCursor && page.nextCursor === cursor) throw new Error('Native history cursor repeated');
  const details: HistoryDetail[] = [];
  const items = [...new Map(page.data.map(entry => {
    if (entry.turnId !== turnId) throw new Error('Native history returned an item from another turn');
    const preview = previewItem(entry.item);
    if (preview.truncated) details.push({ turnId, itemId: entry.item.id, cursor: cursor ?? null });
    return [entry.item.id, preview.item] as const;
  })).values()].reverse();
  return { items, nextCursor: page.nextCursor, details };
}
export async function readHistory(codex: Pick<Codex, 'request'>, thread: Thread, cursor?: string, bounded = false): Promise<Pick<Snapshot, 'thread' | 'history'>> {
  const deadline = performance.now() + 12_000;
  const itemCursors: Record<string, string> = {}, details: HistoryDetail[] = [];
  if (bounded && cursor?.startsWith('legacy-turn:')) return legacyHistory(codex, thread.id, cursor);
  try {
    const page = await codex.request<ThreadTurnsListResponse>('thread/turns/list', {
      threadId: thread.id, cursor, limit: bounded ? 5 : 20, sortDirection: 'desc', itemsView: 'notLoaded',
    });
    if (page.nextCursor && page.nextCursor === cursor) throw new Error('Native history cursor repeated');
    let truncated = false;
    // Each item page is a native read. No rollout parsing or alternate history store.
    for (const turn of page.data) {
      if (bounded) {
        if (performance.now() >= deadline) throw new Error('历史读取超时，请重新加载历史');
        const part = await readHistoryItems(codex, thread.id, turn.id);
        turn.items = part.items; turn.itemsView = part.nextCursor ? 'summary' : 'full';
        if (part.nextCursor) itemCursors[turn.id] = part.nextCursor;
        details.push(...part.details);
        continue;
      }
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
        ...(bounded ? { itemCursors, details } : {}),
        warning: warning + (truncated ? ' 超长轮次达到读取上限，内容已截断。' : '') },
    };
  } catch (error) {
    // Only known capability/legacy-store errors may fall back. Other failures stay visible.
    if (!unsupported(error)) throw error;
    if (bounded) return legacyHistory(codex, thread.id, cursor);
    const result = await codex.request<ThreadReadResponse>('thread/read', { threadId: thread.id, includeTurns: true });
    return { thread: result.thread, history: { source: 'native-read', warning: `分页接口不可用，降级为 thread/read。${warning}` } };
  }
}
async function legacyHistory(codex: Pick<Codex, 'request'>, threadId: string, cursor?: string): Promise<Pick<Snapshot, 'thread' | 'history'>> {
  const start = offset(cursor, 'legacy-turn:');
  const { thread } = await codex.request<ThreadReadResponse>('thread/read', { threadId, includeTurns: true });
  const total = thread.turns.length, itemCursors: Record<string, string> = {}, details: HistoryDetail[] = [];
  const turns = thread.turns.slice(Math.max(0, total - start - 5), Math.max(0, total - start)).map(turn => {
    if (turn.items.length > 40) itemCursors[turn.id] = 'legacy-item:40';
    return { ...turn, items: turn.items.slice(-40).map(item => {
      const preview = previewItem(item); if (preview.truncated) details.push({ turnId: turn.id, itemId: item.id, cursor: 'legacy-item:0' }); return preview.item;
    }) };
  });
  return { thread: { ...thread, turns }, history: { source: 'native-read', nextCursor: start + 5 < total ? `legacy-turn:${start + 5}` : null, itemCursors, details,
    warning: `原生分页不可用，每页需重新读取原生完整历史，界面分批展示。${warning}` } };
}
