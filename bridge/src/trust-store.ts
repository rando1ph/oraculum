import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, lstatSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { selectStateDirectory } from './paths';
import { validateTrustSchema } from './trust-schema';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const credential = () => randomBytes(32).toString('base64url');
export const defaultStateDir = () => selectStateDirectory();
// A null expiry is a persistent device grant; only revoke/logout ends it.
export type Device = { id: string; label: string; expiresAt: number | null; revoked: number };

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
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      try {
        const version = validateTrustSchema(this.db, true);
        this.db.exec(`CREATE TABLE IF NOT EXISTS pairing (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS devices (
            id TEXT PRIMARY KEY, label TEXT NOT NULL, digest TEXT UNIQUE NOT NULL,
            origin TEXT NOT NULL, expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0
          );`);
        if (version === 0) {
          const columns = this.db.prepare('PRAGMA table_info(devices)').all() as { name: string; notnull: number }[];
          if (columns.find(column => column.name === 'expires_at')?.notnull) {
            // Upgrade exactly once, in the same transaction as the schema marker.
            // Already expired/revoked authorizations must never become permanent.
            this.db.exec(`CREATE TABLE devices_long_trust (
              id TEXT PRIMARY KEY, label TEXT NOT NULL, digest TEXT UNIQUE NOT NULL,
              origin TEXT NOT NULL, expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0
            )`);
            this.db.prepare(`INSERT INTO devices_long_trust SELECT id, label, digest, origin,
              CASE WHEN revoked=0 AND expires_at>? THEN NULL ELSE expires_at END, revoked FROM devices`).run(this.now());
            this.db.exec('DROP TABLE devices; ALTER TABLE devices_long_trust RENAME TO devices');
          }
          this.db.exec('PRAGMA user_version=1');
        }
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) { this.db.close(); throw error; }
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
    const device: Device = { id: randomUUID(), label: label.trim(), expiresAt: null, revoked: 0 };
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
    // Finite expiries now only belong to invalid legacy records. Never revive
    // them on a later open or after a backward host-clock correction.
    return this.db.prepare('SELECT id, label, expires_at AS expiresAt, revoked FROM devices WHERE digest=? AND origin=? AND revoked=0 AND expires_at IS NULL')
      .get(digest(token), origin) as Device | undefined;
  }
  list(): Device[] {
    return this.db.prepare('SELECT id, label, expires_at AS expiresAt, revoked FROM devices').all() as Device[];
  }
  revoke(id: string) { return this.db.prepare('UPDATE devices SET revoked=1 WHERE id=?').run(id).changes === 1; }
  close() { this.db.close(); }
}
