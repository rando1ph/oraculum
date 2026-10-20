// Read-only native history capability probe. No inference and no resume.
import { Codex } from '../bridge/src/codex';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Thread, Turn } from '../packages/shared/protocol';
import type { ThreadItemsListResponse } from '../.local/codex-protocol/v2/ThreadItemsListResponse';
const threadId = process.env.ORACULUM_PROBE_THREAD;
if (!threadId) throw new Error('Set ORACULUM_PROBE_THREAD to a controlled test thread ID');
const root = join(homedir(), '.cache/oraculum/workspaces');
await mkdir(join(root, 'local'), { recursive: true });
const results: unknown[] = [];
for (const experimental of [false, true]) {
  const codex = new Codex(join(root, 'local'));
  try {
    await codex.initialize(experimental);
    const { thread } = await codex.request<{ thread: Thread }>('thread/read', { threadId });
    if (!thread.cwd.startsWith(root + '/')) throw new Error('Only Oraculum test workspaces may be probed');
    for (const method of ['thread/read', 'thread/turns/list', 'thread/items/list']) {
      try {
        let cursor: string | null = null;
        const pages: unknown[] = [];
        do {
          const result: { thread?: Thread; data?: Turn[] | ThreadItemsListResponse['data']; nextCursor?: string | null } = await codex.request(method,
            method === 'thread/read' ? { threadId, includeTurns: true } : { threadId, limit: 1, cursor, sortDirection: 'asc', ...(method === 'thread/turns/list' ? { itemsView: 'full' } : {}) });
          const describe = (item: any) => ({ id: item.id, type: item.type, status: item.status });
          pages.push(method === 'thread/items/list'
            ? (result.data as ThreadItemsListResponse['data']).map(e => ({ turnId: e.turnId, item: describe(e.item) }))
            : (result.thread?.turns ?? result.data as Turn[]).map(t => ({ id: t.id, status: t.status, items: t.items.map(describe) })));
          cursor = result.nextCursor ?? null;
        } while (cursor && pages.length < 100);
        results.push({ experimental, method, pages, truncated: !!cursor });
      } catch (error) { results.push({ experimental, method, error: String(error) }); }
    }
  } finally { await codex.close(); }
}
await mkdir('.local/evidence/phase1', { recursive: true });
await writeFile('.local/evidence/phase1/history-probe.json', JSON.stringify({ threadId, results }, null, 2) + '\n');
console.log(JSON.stringify({ threadId, results }, null, 2));
