import type { DatabaseSync } from 'node:sqlite';
import type { NativeSessionSettings, PermissionMode } from '../../packages/shared/protocol';

export type ExplicitPermissionMode = Exclude<PermissionMode, 'inherit'>;

// Only user-selected, natively confirmed presets belong here. Codex persists the
// model/effort itself, but 0.160.0 reloads sandbox from config on process restart.
// This is client preference metadata, never a copy of native configuration.
export class ThreadPermissionStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS thread_permission_choices (
      workspace TEXT NOT NULL, thread_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('read-only', 'auto', 'full-access')),
      PRIMARY KEY (workspace, thread_id)
    )`);
  }
  get(workspace: string, threadId: string): ExplicitPermissionMode | undefined {
    const row = this.db.prepare('SELECT mode FROM thread_permission_choices WHERE workspace=? AND thread_id=?')
      .get(workspace, threadId) as { mode: ExplicitPermissionMode } | undefined;
    return row && ['read-only', 'auto', 'full-access'].includes(row.mode) ? row.mode : undefined;
  }
  confirm(workspace: string, threadId: string, mode: PermissionMode, actual: NativeSessionSettings) {
    if (mode === 'inherit') return;
    const sandbox = actual.sandbox;
    const matches = mode === 'full-access' ? actual.approvalPolicy === 'never' && sandbox.type === 'dangerFullAccess'
      : actual.approvalPolicy === 'on-request' && (mode === 'read-only'
        ? sandbox.type === 'readOnly' && sandbox.networkAccess === false
        : sandbox.type === 'workspaceWrite' && sandbox.networkAccess === false && sandbox.excludeTmpdirEnvVar === false && sandbox.excludeSlashTmp === false);
    if (!matches) {
      // An accepted change that resolves to a custom policy must not leave an
      // older preset capable of replacing that actual policy on a later resume.
      this.remove(workspace, threadId);
      return;
    }
    this.db.prepare(`INSERT INTO thread_permission_choices VALUES (?, ?, ?)
      ON CONFLICT(workspace, thread_id) DO UPDATE SET mode=excluded.mode`).run(workspace, threadId, mode);
  }
  remove(workspace: string, threadId: string) {
    this.db.prepare('DELETE FROM thread_permission_choices WHERE workspace=? AND thread_id=?').run(workspace, threadId);
  }
}
