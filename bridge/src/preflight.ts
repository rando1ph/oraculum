// Read-only candidate validation. Never imports BridgeService, starts Codex,
// initializes a store, migrates schema, or writes a receipt.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { startupPaths } from './paths';
import { validateTrustSchema } from './trust-schema';

const paths = startupPaths();
const database = new DatabaseSync(join(paths.state, 'trust.sqlite'), { readOnly: true });
try {
  const schemaVersion = validateTrustSchema(database);
  const check = database.prepare('PRAGMA quick_check').get() as { quick_check: string };
  if (check.quick_check !== 'ok') throw new Error('State database failed integrity check');
  console.log(JSON.stringify({ compatible: true, schemaVersion, stateChanged: false }));
} finally { database.close(); }
