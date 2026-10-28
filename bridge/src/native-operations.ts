import type { DatabaseSync } from 'node:sqlite';
import type { NativeOperation, NativeOperationMethod } from '../../packages/shared/protocol';

// Delivery metadata only. Names, instructions, review targets and conversation
// content remain exclusively in Codex. An interrupted Bridge never replays RPCs.
export class NativeOperations {
  private memory = new Map<string, NativeOperation>();
  private revisions = new Map<string, number>();
  constructor(private db?: DatabaseSync) {
    db?.exec(`CREATE TABLE IF NOT EXISTS native_operations (
      operation_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, thread_id TEXT NOT NULL,
      method TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
      result_thread_id TEXT, turn_id TEXT
    ); CREATE INDEX IF NOT EXISTS native_operation_thread ON native_operations(workspace, thread_id);
    CREATE TABLE IF NOT EXISTS native_history_revisions (
      workspace TEXT NOT NULL, thread_id TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY (workspace, thread_id)
    );
    UPDATE native_operations SET state='unknown' WHERE state IN ('running', 'accepted')`);
  }
  private rows(cwd: string, threadId: string): NativeOperation[] {
    return this.db ? this.db.prepare(`SELECT operation_id AS operationId, workspace AS cwd, thread_id AS threadId,
      method, state, created_at AS createdAt, result_thread_id AS resultThreadId, turn_id AS turnId
      FROM native_operations WHERE workspace=? AND thread_id=? ORDER BY created_at DESC, rowid DESC`).all(cwd, threadId)
      .map(row => ({ ...row, ...(row.resultThreadId === null ? { resultThreadId: undefined } : {}),
        ...(row.turnId === null ? { turnId: undefined } : {}) })) as NativeOperation[]
      : [...this.memory.values()].filter(operation => operation.cwd === cwd && operation.threadId === threadId).reverse();
  }
  list(cwd: string, threadId: string) { return this.rows(cwd, threadId).slice(0, 20); }
  unresolved(cwd: string, threadId: string) {
    return this.rows(cwd, threadId).filter(operation => ['running', 'accepted', 'unknown'].includes(operation.state));
  }
  reserve(operationId: unknown, cwd: string, threadId: string, method: NativeOperationMethod) {
    if (typeof operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
      throw new Error('每次原生操作都需要唯一操作编号。');
    }
    if (this.db ? this.db.prepare('SELECT 1 FROM native_operations WHERE operation_id=?').get(operationId) : this.memory.has(operationId)) {
      throw new Error('该操作已记录，请查询原生状态，不要重复执行。');
    }
    const operation: NativeOperation = { operationId, cwd, threadId, method, state: 'running', createdAt: Date.now() };
    this.db?.prepare(`INSERT INTO native_operations VALUES (?, ?, ?, ?, 'running', ?, NULL, NULL)`)
      .run(operationId, cwd, threadId, method, operation.createdAt);
    this.memory.set(operationId, operation);
    return operation;
  }
  update(operation: NativeOperation, change: Partial<NativeOperation>) {
    const next = { ...operation, ...change };
    this.db?.prepare('UPDATE native_operations SET state=?, result_thread_id=?, turn_id=? WHERE operation_id=?')
      .run(next.state, next.resultThreadId ?? null, next.turnId ?? null, next.operationId);
    this.memory.set(next.operationId, next);
    return next;
  }
  get(operationId: string, cwd: string, threadId: string) {
    return this.memory.get(operationId) ?? this.rows(cwd, threadId).find(operation => operation.operationId === operationId);
  }
  revision(cwd: string, threadId: string) {
    return this.db ? (this.db.prepare('SELECT revision FROM native_history_revisions WHERE workspace=? AND thread_id=?')
      .get(cwd, threadId) as { revision: number } | undefined)?.revision ?? 0 : this.revisions.get(cwd + '\0' + threadId) ?? 0;
  }
  setRevision(cwd: string, threadId: string, revision: number) {
    this.db?.prepare(`INSERT INTO native_history_revisions VALUES (?, ?, ?)
      ON CONFLICT(workspace, thread_id) DO UPDATE SET revision=excluded.revision`).run(cwd, threadId, revision);
    this.revisions.set(cwd + '\0' + threadId, revision);
  }
}
