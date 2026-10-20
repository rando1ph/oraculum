import type { DatabaseSync } from 'node:sqlite';
import type { SendReceipt, Turn } from '../../packages/shared/protocol';

// Delivery metadata only. Native Codex remains the source of conversation and
// execution facts; never store prompts, tool output, approvals or credentials.
export class ReceiptStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS send_receipts (
      operation_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, thread_id TEXT NOT NULL,
      device_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      status TEXT NOT NULL, turn_id TEXT
    ); CREATE INDEX IF NOT EXISTS receipt_thread ON send_receipts(workspace, thread_id);`);
  }
  reserve(operationId: unknown, workspace: string, threadId: string, deviceId: string) {
    if (typeof operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
      throw new Error('A unique operation ID is required');
    }
    // Commit synchronously before any native call; a crash leaves "unknown".
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT 1 FROM send_receipts WHERE operation_id=?').get(operationId)) {
        throw new Error('Operation already recorded; query native state, do not resend');
      }
      if (this.blocked(workspace, threadId)) throw new Error('Previous send result unknown or still active; query state');
      this.db.prepare(`INSERT INTO send_receipts VALUES (?, ?, ?, ?, ?, 'unknown', NULL)`)
        .run(operationId, workspace, threadId, deviceId, Date.now());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  accepted(operationId: string, turnId: string) {
    this.db.prepare("UPDATE send_receipts SET status='accepted', turn_id=? WHERE operation_id=? AND status='unknown'").run(turnId, operationId);
  }
  rejected(operationId: string) {
    this.db.prepare("UPDATE send_receipts SET status='rejected' WHERE operation_id=? AND status='unknown'").run(operationId);
  }
  observe(workspace: string, threadId: string, turn: Pick<Turn, 'id' | 'status'>) {
    if (!['completed', 'failed', 'interrupted'].includes(turn.status)) return;
    // An unrelated native completion cannot resolve a send with no known turn ID.
    this.db.prepare(`UPDATE send_receipts SET status=?
      WHERE workspace=? AND thread_id=? AND turn_id=? AND status='accepted'`).run(turn.status, workspace, threadId, turn.id);
  }
  blocked(workspace: string, threadId: string) {
    return !!this.db.prepare(`SELECT 1 FROM send_receipts WHERE workspace=? AND thread_id=?
      AND status IN ('unknown', 'accepted') LIMIT 1`).get(workspace, threadId);
  }
  list(workspace: string, threadId: string): SendReceipt[] {
    return this.db.prepare(`SELECT operation_id AS operationId, status, turn_id AS turnId, created_at AS createdAt
      FROM send_receipts WHERE workspace=? AND thread_id=? ORDER BY created_at DESC, rowid DESC LIMIT 20`)
      .all(workspace, threadId) as SendReceipt[];
  }
}
