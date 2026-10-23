import type { DatabaseSync } from 'node:sqlite';

const pairingSql = 'CREATE TABLE pairing (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)';
const devicesSql = (version: number) => `CREATE TABLE devices (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, digest TEXT UNIQUE NOT NULL,
  origin TEXT NOT NULL, expires_at INTEGER${version === 0 ? ' NOT NULL' : ''}, revoked INTEGER NOT NULL DEFAULT 0
)`;
// SQLite quotes the table name after ALTER TABLE RENAME; these are the only
// cosmetic differences emitted by our known creators/migration.
const normalize = (sql: string) => sql.replace(/[\s"]/g, '').toLowerCase();
const invalid = () => { throw new Error('Selected database has an unknown trust schema; no changes made'); };

// Metadata only: callers use this before creating tables or upgrading devices.
// Reject extensions that a table rebuild would silently discard. Other stores
// (projects/receipts) remain untouched and do not need to be read here.
export function validateTrustSchema(db: DatabaseSync, allowEmpty = false): number {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version > 1) throw new Error('Trust database schema is newer than this Bridge supports');
  if (version !== 0 && version !== 1) invalid();
  const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all() as
    { type: string; name: string; tbl_name: string; sql: string | null }[];
  if (allowEmpty && version === 0 && objects.length === 0) return version;
  for (const [table, sql, names] of [
    ['pairing', pairingSql, ['digest', 'expires_at']],
    ['devices', devicesSql(version), ['id', 'label', 'digest', 'origin', 'expires_at', 'revoked']],
  ] as const) {
    const definition = objects.find(object => object.type === 'table' && object.name === table);
    if (!definition?.sql || normalize(definition.sql) !== normalize(sql)) invalid();
    const columns = db.prepare('SELECT name, hidden FROM pragma_table_xinfo(?) ORDER BY cid').all(table);
    if (columns.length !== names.length || columns.some((column, index) => column.name !== names[index] || column.hidden !== 0)) invalid();
    if (objects.some(object => object.tbl_name === table && ['index', 'trigger'].includes(object.type))) invalid();
  }
  // SQLite can rewrite references when a table is renamed or cascade deletes
  // when it is dropped. Unknown dependent tables must not be migrated blindly.
  for (const table of objects.filter(object => object.type === 'table')) {
    const foreignKeys = db.prepare('SELECT "table" FROM pragma_foreign_key_list(?)').all(table.name);
    if (foreignKeys.some(key => String(key.table).toLowerCase() === 'devices')) invalid();
  }
  return version;
}
