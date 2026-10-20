import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { TrustStore, defaultStateDir } from './trust-store';

const dir = defaultStateDir();
const store = new TrustStore(dir);
try {
  const [command, id] = process.argv.slice(2);
  if (command === 'pair') {
    const { code, expiresAt } = store.createPairing();
    const path = join(dir, 'pairing.txt');
    const temporary = `${path}.${process.pid}`;
    writeFileSync(temporary, `${code}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
    console.log(`One-use pairing code written privately to ${path}; expires ${new Date(expiresAt).toISOString()}. Do not copy it into logs or Notion.`);
  } else if (command === 'list') {
    console.log(JSON.stringify(store.list(), null, 2));
  } else if (command === 'revoke' && id) {
    if (!store.revoke(id)) throw new Error('Unknown device ID');
    console.log('Device revoked. Existing sockets are closed within one second; requests/events are checked immediately.');
  } else {
    throw new Error('Usage: pnpm trust pair | list | revoke <device-id>');
  }
} finally { store.close(); }
