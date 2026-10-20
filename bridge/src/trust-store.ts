import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, lstatSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const credential = () => randomBytes(32).toString('base64url');
export const defaultStateDir = () => resolve(process.env.ORACULUM_STATE_DIR ?? '.local/runtime');
export type Device = { id: string; label: string; expiresAt: number; revoked: number };

// Only hashed device credentials / short-lived pairing codes. No OAuth, prompts,
// conversation bodies or tool history belongs in this database.
export class TrustStore {
  readonly db: DatabaseSync;
  constructor(dir: string, private now = () => Date.now()) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const folder = lstatSync(dir);
    if (!folder.isDirectory() || (folder.mode & 0o077)) throw new Error('State directory must be private (0700), not a symlink');
    const path = join(dir, 'trust.sqlite');
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const file = lstatSync(path);
    if (!file.isFile() || (file.mode & 0o077)) throw new Error('Trust database must be private (0600), not a symlink');
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS pairing (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, digest TEXT UNIQUE NOT NULL,
        origin TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
      );`);
  }
  createPairing() {
    const code = credential();
    const expiresAt = this.now() + 5 * 60_000;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM pairing');
      this.db.prepare('INSERT INTO pairing VALUES (?, ?)').run(digest(code), expiresAt);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { code, expiresAt };
  }
  pair(code: unknown, label: unknown, origin: string) {
    if (typeof code !== 'string' || !/^[\w-]{43}$/.test(code) ||
        typeof label !== 'string' || !label.trim() || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) {
      throw new Error('Invalid or expired pairing code');
    }
    const token = credential();
    const device: Device = { id: randomUUID(), label: label.trim(), expiresAt: this.now() + 24 * 60 * 60_000, revoked: 0 };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('DELETE FROM pairing WHERE digest=? AND expires_at>?').run(digest(code), this.now());
      if (result.changes !== 1) throw new Error('Invalid or expired pairing code');
      this.db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?, ?, 0)').run(device.id, device.label, digest(token), origin, device.expiresAt);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { token, device };
  }
  authenticate(token: string | undefined, origin: string): Device | undefined {
    if (!token || !/^[\w-]{43}$/.test(token)) return undefined;
    return this.db.prepare('SELECT id, label, expires_at AS expiresAt, revoked FROM devices WHERE digest=? AND origin=? AND revoked=0 AND expires_at>?')
      .get(digest(token), origin, this.now()) as Device | undefined;
  }
  list(): Device[] {
    return this.db.prepare('SELECT id, label, expires_at AS expiresAt, revoked FROM devices').all() as Device[];
  }
  revoke(id: string) { return this.db.prepare('UPDATE devices SET revoked=1 WHERE id=?').run(id).changes === 1; }
  close() { this.db.close(); }
}
