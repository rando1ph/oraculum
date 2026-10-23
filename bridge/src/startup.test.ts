import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { TrustStore } from './trust-store';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const main = fileURLToPath(new URL('./main.ts', import.meta.url));
const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'oraculum-startup-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), cwd = join(root, 'unrelated'), resources = join(root, 'usr/lib/oraculum/resources');
  for (const path of [home, cwd, join(resources, 'apps/web/dist'), join(resources, 'themes')]) await mkdir(path, { recursive: true });
  await writeFile(join(resources, 'apps/web/dist/index.html'), '<html>installed-resource-fixture</html>');
  const binary = join(root, 'codex-fixture');
  await writeFile(binary, `#!${process.execPath}\nconst fs=require('node:fs');
if(process.argv[2]==='--version'){console.log('codex-cli 9.9.9-fixture');process.exit(0);}
fs.appendFileSync(process.env.FIXTURE_CALLS,'spawn\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);fs.appendFileSync(process.env.FIXTURE_CALLS,m.method+'\\n');if(m.id===undefined)return;
let result=m.method==='initialize'?{userAgent:'fixture'}:m.method==='config/read'?{config:{model:null,model_provider:null,model_reasoning_effort:null}}:{data:[],nextCursor:null};
console.log(JSON.stringify(process.env.FIXTURE_BAD==='1'&&m.method==='initialize'?{id:m.id,result:{}}:{id:m.id,result}));
});\n`);
  await chmod(binary, 0o700);
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(root, 'state'), XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'), ORACULUM_STATE_DIR: join(root, 'state/oraculum'), ORACULUM_RESOURCE_DIR: resources,
    ORACULUM_WORKSPACE: join(root, 'data/oraculum/workspaces/local'), ORACULUM_INIT_STATE: '1',
    ORACULUM_PORT: String(port), ORACULUM_CODEX_BIN: binary, FIXTURE_CALLS: join(root, 'calls'), PATH: '' };
  for (const key of ['ORACULUM_REMOTE_ORIGIN', 'ORACULUM_REMOTE_BASE_PATH', 'ORACULUM_WEB_DIR', 'ORACULUM_THEME_DIR', 'ORACULUM_THEME_SOURCE_DIR']) delete (env as NodeJS.ProcessEnv)[key];
  return { root, home, cwd, resources, env, origin: `http://127.0.0.1:${port}` };
}
function launch(cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [tsx, main], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const done = once(child, 'exit');
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await done; } });
  return { child, done, output: () => output };
}
async function stop(child: ChildProcess) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
it('runs from unrelated cwd with installed resources, minimal PATH and alternate HOME/XDG; restarts with the same device', async () => {
  const { cwd, env, origin } = await setup();
  const first = launch(cwd, env);
  await expect.poll(first.output, { timeout: 10000 }).toContain('codex-cli 9.9.9-fixture');
  expect(await (await fetch(origin)).text()).toContain('installed-resource-fixture');
  const store = new TrustStore(env.ORACULUM_STATE_DIR);
  const { code } = store.createPairing(); store.close();
  const paired = await fetch(origin + '/auth/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code, label: 'isolated fixture' }) });
  expect(paired.status).toBe(200);
  const cookie = paired.headers.get('set-cookie')!.split(';')[0];
  const device = (await paired.json()).device;
  await stop(first.child);
  const second = launch(cwd, { ...env, ORACULUM_INIT_STATE: undefined });
  await expect.poll(second.output, { timeout: 10000 }).toContain('codex-cli 9.9.9-fixture');
  const session = await fetch(origin + '/auth/session', { headers: { Cookie: cookie } });
  expect(session.status).toBe(200);
  expect((await session.json()).device.id).toBe(device.id);
  expect(existsSync(join(cwd, '.local'))).toBe(false);
  const calls = await readFile(env.FIXTURE_CALLS, 'utf8');
  expect(calls).not.toContain('thread/start'); expect(calls).not.toContain('turn/start');
  await stop(second.child);
}, 20000);
it('fails before spawn or creating state when resources conflict', async () => {
  const { root, cwd, env } = await setup();
  const process = launch(cwd, { ...env, ORACULUM_WEB_DIR: join(root, 'missing') });
  expect((await process.done)[0]).not.toBe(0);
  expect(process.output()).toContain('Web resources missing');
  expect(existsSync(env.ORACULUM_STATE_DIR)).toBe(false);
  expect(existsSync(env.ORACULUM_WORKSPACE)).toBe(false);
  expect(existsSync(env.FIXTURE_CALLS)).toBe(false);
});
it('rolls back only newly-created empty workspace directories after incompatible CLI initialization', async () => {
  const { cwd, env } = await setup();
  const process = launch(cwd, { ...env, FIXTURE_BAD: '1' });
  expect((await process.done)[0]).not.toBe(0);
  expect(process.output()).toContain('incompatible App Server initialize');
  expect(existsSync(env.ORACULUM_STATE_DIR)).toBe(false);
  expect(existsSync(env.XDG_DATA_HOME)).toBe(false);
}, 10000);
it('preserves initialized state and its registered workspace together on a late listen failure', async () => {
  const { cwd, env, origin } = await setup();
  const occupied = createServer(); occupied.listen(Number(env.ORACULUM_PORT), '127.0.0.1'); await once(occupied, 'listening');
  cleanup.push(() => new Promise<void>(resolve => occupied.close(() => resolve())));
  const failed = launch(cwd, env);
  expect((await failed.done)[0]).not.toBe(0);
  expect(failed.output()).toContain('EADDRINUSE');
  expect(existsSync(join(env.ORACULUM_STATE_DIR, 'trust.sqlite'))).toBe(true);
  expect(existsSync(env.ORACULUM_WORKSPACE)).toBe(true);
  await new Promise<void>(resolve => occupied.close(() => resolve()));
  const recovered = launch(cwd, { ...env, ORACULUM_INIT_STATE: undefined });
  await expect.poll(recovered.output, { timeout: 10000 }).toContain('codex-cli 9.9.9-fixture');
  expect((await fetch(origin + '/health')).status).toBe(200);
  await stop(recovered.child);
}, 15000);
it('rejects invalid trust CLI commands before initializing or migrating a state directory', async () => {
  const { cwd, env } = await setup();
  const child = spawn(process.execPath, [tsx, fileURLToPath(new URL('./trust.ts', import.meta.url)), 'typo'], { cwd, env, stdio: 'ignore' });
  expect((await once(child, 'exit'))[0]).not.toBe(0);
  expect(existsSync(env.ORACULUM_STATE_DIR)).toBe(false);
});
