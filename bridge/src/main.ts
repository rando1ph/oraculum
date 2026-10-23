import { mkdir, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { Codex } from './codex';
import { BridgeService } from './service';
import { createServer } from './server';
import { TrustStore } from './trust-store';
import { ReceiptStore } from './receipts';
import { ProjectDirectories } from './projects';
import { Themes } from './themes';
import { startupPaths } from './paths';

// Preflight path/config conflicts before creating state, a workspace or a child process.
const paths = startupPaths();
const created: string[] = [];
for (let path = paths.cwd; !existsSync(path); path = dirname(path)) created.push(path);
let codex: Codex | undefined, trust: TrustStore | undefined;
try {
  await mkdir(paths.cwd, { recursive: true, mode: 0o700 });
  codex = new Codex(paths.cwd);
  await codex.initialize();
  // Do not create a new trust store when the installed CLI cannot initialize.
  trust = new TrustStore(paths.state);
  const projects = new ProjectDirectories(paths.workspaceRoot, paths.cwd, trust.db, paths.projectRoots);
  await projects.register(paths.cwd); // Only the explicit host-selected default is authorized at startup.
  const service = new BridgeService(codex, paths.cwd, new ReceiptStore(trust.db), projects);
  const app = await createServer(service, paths.port, paths.web, {
    trust, themes: new Themes({ installed: paths.themeInstalled, source: paths.themeSource }),
    remoteOrigin: paths.remoteOrigin, remoteBasePath: paths.remoteBasePath,
  });
  await app.listen({ host: '127.0.0.1', port: paths.port });
  console.log(JSON.stringify({ url: `http://127.0.0.1:${paths.port}`, workspace: paths.cwd, codex: codex.version }));
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    await codex!.close();
    trust!.close();
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
} catch (error) {
  await codex?.close();
  trust?.close();
  // Before state opens, roll back only empty directories created by this attempt.
  // After initialization, retain state AND its registered cwd for a coherent retry
  // (e.g. a late listen failure); never delete or downgrade a selected database.
  if (!trust) for (const path of created) { try { await rmdir(path); } catch { /* Preserve concurrent data. */ } }
  throw error;
}
