import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { Codex } from './codex';
import { BridgeService } from './service';
import { createServer } from './server';

const root = join(homedir(), '.cache/oraculum/workspaces');
await mkdir(root, { recursive: true, mode: 0o700 });
const cwd = await mkdtemp(join(root, 'poc-'));
await writeFile(join(cwd, 'fixture.txt'), 'ORACULUM_FIXTURE_OK\n');
const codex = new Codex(cwd);
const service = new BridgeService(codex, cwd);
try {
  await codex.initialize();
  const port = Number(process.env.ORACULUM_PORT ?? 17860);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  const app = await createServer(service, port, resolve('apps/web/dist'));
  await app.listen({ host: '127.0.0.1', port });
  console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, workspace: cwd, codex: '0.160.0' }));
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    await codex.close();
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
} catch (error) {
  await codex.close();
  throw error;
}
