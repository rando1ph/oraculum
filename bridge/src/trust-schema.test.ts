import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { validateTrustSchema } from './trust-schema';
import { TrustStore } from './trust-store';

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(change = '') {
  const dir = mkdtempSync(join(tmpdir(), 'oraculum-schema-')); temporary.push(dir);
  const path = join(dir, 'trust.sqlite');
  writeFileSync(path, '', { mode: 0o600 });
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE pairing (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE devices (id TEXT PRIMARY KEY, label TEXT NOT NULL, digest TEXT UNIQUE NOT NULL,
      origin TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE send_receipts (operation_id TEXT PRIMARY KEY);
    INSERT INTO send_receipts VALUES ('keep');`);
  if (change) db.exec(change);
  db.close();
  return { dir, path };
}

it('recognizes known legacy and current schemas with unrelated receipt/project tables', () => {
  const { dir, path } = fixture('CREATE TABLE projects (cwd TEXT PRIMARY KEY, dev TEXT NOT NULL, ino TEXT NOT NULL)');
  const old = new DatabaseSync(path, { readOnly: true });
  expect(validateTrustSchema(old)).toBe(0); old.close();
  const store = new TrustStore(dir); store.close();
  const current = new DatabaseSync(path, { readOnly: true });
  expect(validateTrustSchema(current)).toBe(1);
  expect(current.prepare('SELECT operation_id FROM send_receipts').get()).toEqual({ operation_id: 'keep' });
  current.close();
});

it.each([
  ['extra device data', 'ALTER TABLE devices ADD COLUMN private_extension TEXT'],
  ['custom device index', 'CREATE INDEX private_device_index ON devices(label)'],
  ['custom trigger', "CREATE TRIGGER device_audit AFTER UPDATE ON devices BEGIN INSERT INTO send_receipts VALUES ('extra'); END"],
  ['dependent foreign key', 'CREATE TABLE dependent (device_id TEXT REFERENCES devices(id))'],
  ['case-insensitive foreign key', 'CREATE TABLE dependent (device_id TEXT REFERENCES DEVICES(id))'],
  ['missing pairing table', 'DROP TABLE pairing'],
  ['unknown version', 'PRAGMA user_version=2'],
  ['wrong version marker', 'PRAGMA user_version=1'],
  ['foreign database', 'DROP TABLE devices; DROP TABLE pairing'],
])('rejects %s at constructor with unchanged database bytes', (_label, change) => {
  const { dir, path } = fixture(change);
  const before = readFileSync(path);
  expect(() => new TrustStore(dir)).toThrow();
  expect(readFileSync(path).equals(before)).toBe(true);
});

it('only allows a truly empty unversioned database for deliberate initialization', () => {
  const db = new DatabaseSync(':memory:');
  try {
    expect(() => validateTrustSchema(db)).toThrow('unknown');
    expect(validateTrustSchema(db, true)).toBe(0);
    db.exec('CREATE TABLE sqliteUnrelated (value TEXT)');
    expect(() => validateTrustSchema(db, true)).toThrow('unknown');
  } finally { db.close(); }
});
