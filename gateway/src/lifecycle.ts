import { CodexError, record, type CodexAdapter, type NativeThread } from './codex';
import { GatewayError } from './private-paths';

const PAGE_LIMIT = 100;
const READ_BUDGET_MS = 30_000;
const fail = (code: string, message: string): never => { throw new GatewayError(code, 409, message); };
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  value.length <= 4096 && !/[\x00-\x1f]/.test(value);

function nativeParent(thread: NativeThread): string | null {
  if (validId(thread.parentThreadId)) return thread.parentThreadId;
  const source = thread.source;
  if (record(source) && record(source.subAgent) && Object.hasOwn(source.subAgent, 'thread_spawn')) {
    const spawn = source.subAgent.thread_spawn;
    if (record(spawn) && validId(spawn.parent_thread_id)) return spawn.parent_thread_id;
    return fail('LIFECYCLE_LINEAGE_UNVERIFIED', 'Native spawned thread ownership could not be verified');
  }
  // Explicit null also covers review/compaction subagents that have no spawned
  // parent. Missing or malformed lineage is never evidence of independence.
  if (thread.parentThreadId !== null)
    return fail('LIFECYCLE_LINEAGE_UNVERIFIED', 'Native thread relationships could not be verified');
  return null;
}

/**
 * Metadata-only preflight for native archive/delete, which cascade descendants.
 * The adapter includes every source/provider and does not filter by cwd: a child
 * can belong to another project. No inventory metadata leaves this function.
 * This is a bounded preflight, not an atomic native mutation precondition; the
 * caller must reread status and process pending notifications before writing.
 */
export async function assertLifecycleInventory(
  codex: Pick<CodexAdapter, 'listLifecycleThreads'>, threadId: string, cwd: string,
): Promise<'active' | 'archived' | undefined> {
  const deadline = performance.now() + READ_BUDGET_MS;
  let state: 'active' | 'archived' | undefined;
  for (const archived of [false, true]) {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let pageNumber = 0; ; pageNumber++) {
      if (pageNumber >= PAGE_LIMIT)
        fail('LIFECYCLE_INVENTORY_INCOMPLETE', 'Native thread inventory exceeded the verification page budget');
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) fail('LIFECYCLE_INVENTORY_TIMEOUT', 'Native thread inventory verification timed out');
      let page: Awaited<ReturnType<CodexAdapter['listLifecycleThreads']>>;
      try { page = await codex.listLifecycleThreads({ archived, ...(cursor ? { cursor } : {}), timeoutMs: remaining }); }
      catch (error) {
        if (error instanceof CodexError) throw error;
        return fail('LIFECYCLE_INVENTORY_UNAVAILABLE', 'Native thread inventory could not be verified');
      }
      if (performance.now() >= deadline)
        fail('LIFECYCLE_INVENTORY_TIMEOUT', 'Native thread inventory verification timed out');
      if (!Array.isArray(page.data) || page.data.length > 100 || !(page.nextCursor === null || validId(page.nextCursor)))
        fail('LIFECYCLE_INVENTORY_INCOMPLETE', 'Native thread inventory response could not be verified');
      for (const thread of page.data) {
        const parent = nativeParent(thread);
        if (parent === threadId)
          fail('THREAD_HAS_DEPENDENCIES', 'Thread has spawned children and cannot be safely archived or deleted');
        if (thread.id === threadId) {
          if (thread.cwd !== cwd) throw new GatewayError('PROJECT_UNAVAILABLE', 403, 'Thread is outside this registered project');
          if (parent)
            fail('THREAD_HAS_DEPENDENCIES', 'A spawned thread must be managed through its native parent');
          if (state) fail('LIFECYCLE_STATE_CHANGED', 'Native thread lifecycle changed while verifying inventory');
          state = archived ? 'archived' : 'active';
        }
      }
      if (page.nextCursor === null) break;
      if (cursors.has(page.nextCursor))
        fail('LIFECYCLE_INVENTORY_INCOMPLETE', 'Native thread inventory pagination could not be verified');
      cursor = page.nextCursor;
      cursors.add(cursor);
    }
  }
  return state;
}
