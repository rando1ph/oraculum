import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { Codex } from './codex';
import { BridgeService } from './service';
import { createServer } from './server';
import { TrustStore, defaultStateDir } from './trust-store';
import { ReceiptStore } from './receipts';

const root = join(homedir(), '.cache/oraculum/workspaces');
await mkdir(root, { recursive: true, mode: 0o700 });
// A stable, controlled workspace lets native threads survive Bridge restarts.
// Phase 1 deliberately does not expose a renderer-selected arbitrary host path.
const requested = resolve(process.env.ORACULUM_WORKSPACE ?? join(root, 'local'));
const realRoot = await realpath(root);
if (!requested.startsWith(realRoot + sep)) throw new Error('Workspace must be inside the Oraculum test workspace root');
await mkdir(requested, { recursive: true, mode: 0o700 });
const cwd = await realpath(requested);
if (!cwd.startsWith(realRoot + sep)) throw new Error('Workspace symlink escapes the Oraculum test workspace root');
const trust = new TrustStore(defaultStateDir());
const codex = new Codex(cwd);
const service = new BridgeService(codex, cwd, new ReceiptStore(trust.db));
try {
  await codex.initialize();
  const port = Number(process.env.ORACULUM_PORT ?? 17860);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  const app = await createServer(service, port, resolve('apps/web/dist'), {
    trust, remoteOrigin: process.env.ORACULUM_REMOTE_ORIGIN,
    remoteBasePath: process.env.ORACULUM_REMOTE_BASE_PATH,
  });
  await app.listen({ host: '127.0.0.1', port });
  console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, workspace: cwd, codex: '0.160.0' }));
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    await codex.close();
    trust.close();
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
} catch (error) {
  await codex.close();
  trust.close();
  throw error;
}
