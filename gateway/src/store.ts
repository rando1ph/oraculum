import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPrivateFile, GatewayError, privateDirectory, privateFile } from './private-paths';

export { GatewayError } from './private-paths';
export const SCHEMA_VERSION = 1;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomCredential = () => randomBytes(32).toString('base64url');
export const validCredential = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').length === 32 && Buffer.from(value, 'base64url').toString('base64url') === value;
const uuid = (name: string) => `length(${name})=36 AND substr(${name},9,1)='-' AND substr(${name},14,1)='-' AND substr(${name},19,1)='-' AND substr(${name},24,1)='-' AND substr(${name},15,1)='4' AND substr(${name},20,1) IN ('8','9','a','b') AND length(replace(${name},'-',''))=32 AND replace(${name},'-','') NOT GLOB '*[^0-9a-f]*'`;
const nonnegative = (name: string) => `typeof(${name})='integer' AND ${name}>=0`;
const decimal = (name: string) => `length(${name})>0 AND ${name} NOT GLOB '*[^0-9]*'`;

// This schema contains communication/security metadata only. In particular no
// native history, prompts, access tokens, or legacy Oraculum tables are stored.
const schema = [
  `CREATE TABLE gateway_meta (id INTEGER PRIMARY KEY CHECK(id=1), installation_id TEXT NOT NULL UNIQUE CHECK(${uuid('installation_id')}), created_at INTEGER NOT NULL CHECK(${nonnegative('created_at')}))`,
  `CREATE TABLE devices (id TEXT PRIMARY KEY NOT NULL CHECK(${uuid('id')}), label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 80), credential_digest TEXT NOT NULL UNIQUE CHECK(length(credential_digest)=64 AND credential_digest NOT GLOB '*[^0-9a-f]*'), created_at INTEGER NOT NULL CHECK(${nonnegative('created_at')}), revoked_at INTEGER CHECK(revoked_at IS NULL OR (${nonnegative('revoked_at')})), last_seen_at INTEGER CHECK(last_seen_at IS NULL OR (${nonnegative('last_seen_at')})))`,
  `CREATE TABLE pairing_codes (id INTEGER PRIMARY KEY CHECK(id=1), code_digest TEXT NOT NULL UNIQUE CHECK(length(code_digest)=64 AND code_digest NOT GLOB '*[^0-9a-f]*'), created_at INTEGER NOT NULL CHECK(${nonnegative('created_at')}), expires_at INTEGER NOT NULL CHECK(expires_at>created_at))`,
  `CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL CHECK(${uuid('id')}), canonical_path TEXT NOT NULL CHECK(substr(canonical_path,1,1)='/'), root_id TEXT NOT NULL CHECK(length(root_id) BETWEEN 1 AND 80), dev TEXT NOT NULL CHECK(${decimal('dev')}), ino TEXT NOT NULL CHECK(${decimal('ino')}), created_at INTEGER NOT NULL CHECK(${nonnegative('created_at')}), unregistered_at INTEGER CHECK(unregistered_at IS NULL OR (${nonnegative('unregistered_at')})), inbox_name TEXT, inbox_dev TEXT, inbox_ino TEXT, CHECK((inbox_name IS NULL AND inbox_dev IS NULL AND inbox_ino IS NULL) OR (inbox_name IS NOT NULL AND inbox_dev IS NOT NULL AND inbox_ino IS NOT NULL AND length(inbox_name)>0 AND inbox_name NOT IN ('.','..') AND instr(inbox_name,'/')=0 AND ${decimal('inbox_dev')} AND ${decimal('inbox_ino')})))`,
  `CREATE UNIQUE INDEX projects_active_path ON projects(canonical_path) WHERE unregistered_at IS NULL`,
  `CREATE TABLE operations (operation_id TEXT PRIMARY KEY NOT NULL CHECK(${uuid('operation_id')}), device_id TEXT NOT NULL REFERENCES devices(id), project_id TEXT REFERENCES projects(id), thread_id TEXT, kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 80), status TEXT NOT NULL CHECK(status IN ('unknown','accepted','rejected')), created_at INTEGER NOT NULL CHECK(${nonnegative('created_at')}), updated_at INTEGER NOT NULL CHECK(${nonnegative('updated_at')}), native_thread_id TEXT, native_turn_id TEXT, error_code TEXT)`,
  `CREATE INDEX operations_device_created ON operations(device_id,created_at)`,
  `CREATE INDEX operations_scope_status ON operations(project_id,thread_id,status)`,
  `CREATE TABLE attachments (id TEXT PRIMARY KEY NOT NULL CHECK(${uuid('id')}), device_id TEXT NOT NULL REFERENCES devices(id), project_id TEXT NOT NULL REFERENCES projects(id), thread_id TEXT NOT NULL, draft_id TEXT NOT NULL, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 255), mime TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('image','document')), extension TEXT NOT NULL, size INTEGER NOT NULL CHECK(${nonnegative('size')}), digest TEXT NOT NULL CHECK(length(digest)=64 AND digest NOT GLOB '*[^0-9a-f]*'), state TEXT NOT NULL CHECK(state IN ('uploading','ready','held','sent','unknown','expired')), created_at INTEGER NOT NULL CHECK(${nonnegative('created_at')}), expires_at INTEGER CHECK(expires_at IS NULL OR (${nonnegative('expires_at')})), operation_id TEXT REFERENCES operations(operation_id), upload_operation_id TEXT UNIQUE REFERENCES operations(operation_id), turn_id TEXT, dev TEXT NOT NULL CHECK(${decimal('dev')}), ino TEXT NOT NULL CHECK(${decimal('ino')}), folder_dev TEXT NOT NULL CHECK(${decimal('folder_dev')}), folder_ino TEXT NOT NULL CHECK(${decimal('folder_ino')}))`,
  `CREATE INDEX attachments_scope ON attachments(device_id,project_id,thread_id,draft_id)`,
  `CREATE INDEX attachments_state_expiry ON attachments(state,expires_at)`,
  `CREATE INDEX attachments_operation ON attachments(operation_id)`,
];
const normalizeSql = (sql: string) => sql.replace(/\s+/g, '').toLowerCase();
const expectedSchema = new Set(schema.map(normalizeSql));
const invalidSchema = () => new GatewayError('UNKNOWN_SCHEMA', 500, 'Unknown Gateway database schema; no legacy import or automatic migration is supported');

export interface Device { id: string; label: string; createdAt: number; revokedAt: number | null; lastSeenAt: number | null }
export interface Project { id: string; canonicalPath: string; rootId: string; dev: string; ino: string; createdAt: number; unregisteredAt: number | null; inboxName: string | null; inboxDev: string | null; inboxIno: string | null }
export interface Operation { operationId: string; deviceId: string; projectId: string | null; threadId: string | null; kind: string; status: 'unknown' | 'accepted' | 'rejected'; createdAt: number; updatedAt: number; nativeThreadId: string | null; nativeTurnId: string | null; errorCode: string | null }
export interface PairInput { installationId: string; deviceId: string; deviceCredential: string; code: string; label: string }
export interface CredentialInput { installationId: string; deviceId: string; deviceCredential: string }
export interface OperationInput { operationId: string; deviceId: string; projectId?: string | null; threadId?: string | null; kind: string }
const deviceColumns = 'id,label,created_at AS createdAt,revoked_at AS revokedAt,last_seen_at AS lastSeenAt';
const projectColumns = 'id,canonical_path AS canonicalPath,root_id AS rootId,dev,ino,created_at AS createdAt,unregistered_at AS unregisteredAt,inbox_name AS inboxName,inbox_dev AS inboxDev,inbox_ino AS inboxIno';
const operationColumns = 'operation_id AS operationId,device_id AS deviceId,project_id AS projectId,thread_id AS threadId,kind,status,created_at AS createdAt,updated_at AS updatedAt,native_thread_id AS nativeThreadId,native_turn_id AS nativeTurnId,error_code AS errorCode';

export class GatewayStore {
  readonly db: DatabaseSync;
  readonly installationId: string;
  readonly databasePath: string;
  private readonly directoryFd: number;
  private readonly now: () => number;
  private closed = false;

  constructor(readonly stateDir: string, options: { create?: boolean; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    privateDirectory(stateDir, options.create);
    if (existsSync(join(stateDir, 'trust.sqlite'))) throw new GatewayError('LEGACY_STATE_PATH', 500, 'Use an independent Gateway state directory; legacy state is never imported');
    this.databasePath = join(stateDir, 'gateway.sqlite');
    if (!existsSync(this.databasePath) && options.create) closeSync(createPrivateFile(this.databasePath));
    privateFile(this.databasePath);
    for (const suffix of ['-journal', '-wal', '-shm']) {
      const sidecar = this.databasePath + suffix;
      // lstat detects a dangling symlink too; existsSync alone cannot do that.
      try { lstatSync(sidecar); privateFile(sidecar); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    this.directoryFd = openSync(stateDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let opened: DatabaseSync | undefined;
    try {
      const before = lstatSync(stateDir);
      const pinned = fstatSync(this.directoryFd);
      if (before.dev !== pinned.dev || before.ino !== pinned.ino) throw new GatewayError('UNSAFE_STATE_PATH', 500, 'Gateway state directory changed');
      opened = new DatabaseSync(`/proc/self/fd/${this.directoryFd}/gateway.sqlite`);
      this.db = opened;
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF');
      this.transaction(() => {
        const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
        const definitions = this.db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all() as { sql: string | null }[];
        if (version === 0 && definitions.length === 0 && options.create) {
          for (const sql of schema) this.db.exec(sql);
          this.db.prepare('INSERT INTO gateway_meta VALUES(1,?,?)').run(randomUUID(), this.now());
          this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
        } else if (version !== SCHEMA_VERSION || definitions.length !== schema.length || definitions.some(definition => !definition.sql || !expectedSchema.has(normalizeSql(definition.sql)))) {
          throw invalidSchema();
        }
      });
      const metadata = this.db.prepare('SELECT installation_id AS installationId FROM gateway_meta WHERE id=1').get() as { installationId: string } | undefined;
      if (!metadata || !UUID_PATTERN.test(metadata.installationId)) throw invalidSchema();
      this.installationId = metadata.installationId;
      privateFile(this.databasePath);
    } catch (error) { opened?.close(); closeSync(this.directoryFd); throw error; }
  }

  transaction<T>(fn: () => T): T {
    // Callers may compose metadata writes, but a transaction must never cross an
    // await or a file/native stream. Nested synchronous operations share it.
    const execute = () => {
      const result = fn();
      if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result && typeof result.then === 'function') throw new Error('Gateway SQLite transactions must be synchronous');
      return result;
    };
    if (this.db.isTransaction) return execute();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = execute();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  createPairing(): { code: string; expiresAt: number } {
    // 160 random bits, grouped RFC 4648 Base32, easier to enter on a phone.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0; let value = 0; let encoded = '';
    for (const byte of randomBytes(20)) {
      value = (value << 8) | byte; bits += 8;
      while (bits >= 5) { encoded += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    const code = encoded.match(/.{1,4}/g)!.join('-');
    const createdAt = this.now(); const expiresAt = createdAt + 5 * 60_000;
    this.transaction(() => {
      this.db.exec('DELETE FROM pairing_codes');
      this.db.prepare('INSERT INTO pairing_codes VALUES(1,?,?,?)').run(digest(encoded), createdAt, expiresAt);
    });
    return { code, expiresAt };
  }

  pair(input: PairInput): Device {
    const code = typeof input.code === 'string' ? input.code.replace(/[- ]/g, '').toUpperCase() : '';
    if (input.installationId !== this.installationId || !UUID_PATTERN.test(input.deviceId) || !validCredential(input.deviceCredential) || !/^[A-Z2-7]{32}$/.test(code) || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80 || /[\x00-\x1f\x7f]/.test(input.label)) {
      throw new GatewayError('UNAUTHENTICATED', 401, 'Invalid pairing request or installation');
    }
    return this.transaction(() => {
      const used = this.db.prepare('DELETE FROM pairing_codes WHERE id=1 AND code_digest=? AND expires_at>?').run(digest(code), this.now());
      if (used.changes !== 1) throw new GatewayError('UNAUTHENTICATED', 401, 'Invalid or expired pairing code');
      const credentialDigest = digest(input.deviceCredential);
      if (this.db.prepare('SELECT 1 FROM devices WHERE id=? OR credential_digest=?').get(input.deviceId, credentialDigest)) throw new GatewayError('UNAUTHENTICATED', 401, 'Device identity is already in use');
      this.db.prepare('INSERT INTO devices(id,label,credential_digest,created_at) VALUES(?,?,?,?)').run(input.deviceId, input.label.trim(), credentialDigest, this.now());
      return this.getDevice(input.deviceId)!;
    });
  }

  authenticateCredential(input: CredentialInput): Device {
    if (input.installationId !== this.installationId || !UUID_PATTERN.test(input.deviceId) || !validCredential(input.deviceCredential)) throw new GatewayError('UNAUTHENTICATED', 401, 'Invalid device credential');
    const device = this.db.prepare(`SELECT ${deviceColumns} FROM devices WHERE id=? AND credential_digest=?`).get(input.deviceId, digest(input.deviceCredential)) as Device | undefined;
    if (!device) throw new GatewayError('UNAUTHENTICATED', 401, 'Invalid device credential');
    if (device.revokedAt !== null) throw new GatewayError('DEVICE_REVOKED', 403, 'Device was revoked');
    return device;
  }

  getDevice(id: string): Device | undefined { return this.db.prepare(`SELECT ${deviceColumns} FROM devices WHERE id=?`).get(id) as Device | undefined; }
  listDevices(): Device[] { return this.db.prepare(`SELECT ${deviceColumns} FROM devices ORDER BY created_at,id`).all() as unknown as Device[]; }
  revokeDevice(id: string): boolean { return this.db.prepare('UPDATE devices SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(this.now(), id).changes === 1; }
  touchDevice(id: string): void { this.db.prepare('UPDATE devices SET last_seen_at=? WHERE id=? AND (last_seen_at IS NULL OR last_seen_at<?)').run(this.now(), id, this.now() - 60_000); }

  listProjects(includeUnregistered = false): Project[] { return this.db.prepare(`SELECT ${projectColumns} FROM projects ${includeUnregistered ? '' : 'WHERE unregistered_at IS NULL'} ORDER BY created_at,id`).all() as unknown as Project[]; }
  getProject(id: string): Project | undefined { return this.db.prepare(`SELECT ${projectColumns} FROM projects WHERE id=?`).get(id) as Project | undefined; }
  insertProject(input: { id?: string; canonicalPath: string; rootId: string; dev: string; ino: string }): Project {
    const id = input.id ?? randomUUID();
    if (!UUID_PATTERN.test(id)) throw new GatewayError('INVALID_REQUEST', 400, 'Invalid project ID');
    this.db.prepare('INSERT INTO projects(id,canonical_path,root_id,dev,ino,created_at) VALUES(?,?,?,?,?,?)').run(id, input.canonicalPath, input.rootId, input.dev, input.ino, this.now());
    return this.getProject(id)!;
  }
  updateProjectInbox(id: string, inbox: { name: string; dev: string; ino: string }): void {
    const changed = this.db.prepare('UPDATE projects SET inbox_name=?,inbox_dev=?,inbox_ino=? WHERE id=? AND inbox_name IS NULL AND unregistered_at IS NULL').run(inbox.name, inbox.dev, inbox.ino, id);
    if (changed.changes !== 1) throw new GatewayError('PROJECT_UNAVAILABLE', 409, 'Project inbox is already initialized or project is unavailable');
  }
  unregisterProject(id: string): boolean { return this.db.prepare('UPDATE projects SET unregistered_at=COALESCE(unregistered_at,?) WHERE id=?').run(this.now(), id).changes === 1; }

  reserveOperation(input: OperationInput): { operation: Operation; created: true } {
    if (!UUID_PATTERN.test(input.operationId)) throw new GatewayError('INVALID_REQUEST', 400, 'operationId must be a UUIDv4');
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM operations WHERE operation_id=?').get(input.operationId)) throw new GatewayError('OPERATION_ALREADY_RECORDED', 409, 'Operation ID has already been recorded; query its receipt instead');
      const device = this.getDevice(input.deviceId);
      if (!device || device.revokedAt !== null) throw new GatewayError('DEVICE_REVOKED', 403, 'Device is unavailable');
      if(input.projectId && (!this.getProject(input.projectId) || this.getProject(input.projectId)!.unregisteredAt !== null)) throw new GatewayError('PROJECT_UNAVAILABLE',409,'Project is no longer registered');
      const now = this.now();
      this.db.prepare("INSERT INTO operations(operation_id,device_id,project_id,thread_id,kind,status,created_at,updated_at) VALUES(?,?,?,?,?,'unknown',?,?)").run(input.operationId, input.deviceId, input.projectId ?? null, input.threadId ?? null, input.kind, now, now);
      return { operation: this.getOperation(input.operationId, input.deviceId)!, created: true };
    });
  }
  getOperation(id: string, deviceId: string): Operation | undefined { return this.db.prepare(`SELECT ${operationColumns} FROM operations WHERE operation_id=? AND device_id=?`).get(id, deviceId) as Operation | undefined; }
  finishOperation(id: string, status: 'accepted' | 'rejected' | 'unknown', result: { nativeThreadId?: string; nativeTurnId?: string; errorCode?: string } = {}): void {
    const changed = this.db.prepare("UPDATE operations SET status=?,updated_at=?,native_thread_id=COALESCE(?,native_thread_id),native_turn_id=COALESCE(?,native_turn_id),error_code=? WHERE operation_id=? AND status='unknown'").run(status, this.now(), result.nativeThreadId ?? null, result.nativeTurnId ?? null, result.errorCode ?? null, id);
    if (changed.changes !== 1) throw new GatewayError('OPERATION_ALREADY_RECORDED', 409, 'Operation is missing or already has a definitive result');
  }
  hasUnknownOperation(projectId: string, threadId?: string | null): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM operations WHERE project_id=? AND status='unknown' ${threadId ? 'AND (thread_id IS NULL OR thread_id=?)' : ''} LIMIT 1`).get(...(threadId ? [projectId, threadId] : [projectId])));
  }

  close(): void { if (!this.closed) { this.closed = true; try { this.db.close(); } finally { closeSync(this.directoryFd); } } }
}
