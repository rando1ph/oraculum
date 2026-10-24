import { mkdir, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { Codex } from './codex';
import { BridgeService } from './service';
import { createServer } from './server';
import { TrustStore } from './trust-store';
import { ReceiptStore } from './receipts';
import { ThreadPermissionStore } from './thread-permissions';
import { ProjectDirectories } from './projects';
import { Themes } from './themes';
import { startupPaths } from './paths';

// Preflight path/config conflicts before creating state, a workspace or a child process.
const paths = startupPaths();
const created: string[] = [];
for (let path = paths.cwd; !existsSync(path); path = dirname(path)) created.push(path);
let codex: Codex | undefined, trust: TrustStore | undefined;
let app: Awaited<ReturnType<typeof createServer>> | undefined;
let closing: Promise<void> | undefined;
let stopping = false;
const close = () => {
  if (closing) return closing;
  stopping = true;
  // A stuck connection must not leave a failed Bridge advertising health
  // indefinitely. The user service also has a bounded stop timeout.
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  closing = Promise.allSettled([codex?.close(), app?.close()]).then(results => {
    trust?.close();
    if (results.some(result => result.status === 'rejected')) process.exitCode = 1;
  }).finally(() => clearTimeout(deadline));
  return closing;
};
try {
  await mkdir(paths.cwd, { recursive: true, mode: 0o700 });
  codex = new Codex(paths.cwd);
  await codex.initialize();
  // Do not create a new trust store when the installed CLI cannot initialize.
  trust = new TrustStore(paths.state);
  const projects = new ProjectDirectories(paths.workspaceRoot, paths.cwd, trust.db, paths.projectRoots);
  await projects.register(paths.cwd); // Only the explicit host-selected default is authorized at startup.
  const service = new BridgeService(codex, paths.cwd, new ReceiptStore(trust.db), projects, new ThreadPermissionStore(trust.db));
  app = await createServer(service, paths.port, paths.web, {
    trust, themes: new Themes({ installed: paths.themeInstalled, source: paths.themeSource }),
    remoteOrigin: paths.remoteOrigin, remoteBasePath: paths.remoteBasePath,
  });
  codex.once('unavailable', () => {
    if (stopping) return;
    // systemd Restart=on-failure restarts the Bridge and its one native child.
    // No RPC or unknown send is replayed as part of that process recovery.
    process.exitCode = 1;
    console.error('Codex App Server unavailable; stopping Bridge for service recovery. Outstanding sends remain unknown.');
    void close();
  });
  if (!codex.alive) throw new Error('Codex App Server became unavailable during Bridge startup');
  await app.listen({ host: '127.0.0.1', port: paths.port });
  if (!codex.alive) throw new Error('Codex App Server became unavailable during Bridge startup');
  console.log(JSON.stringify({ url: `http://127.0.0.1:${paths.port}`, workspace: paths.cwd, codex: codex.version }));
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
} catch (error) {
  await close();
  // Before state opens, roll back only empty directories created by this attempt.
  // After initialization, retain state AND its registered cwd for a coherent retry
  // (e.g. a late listen failure); never delete or downgrade a selected database.
  if (!trust) for (const path of created) { try { await rmdir(path); } catch { /* Preserve concurrent data. */ } }
  throw error;
}
