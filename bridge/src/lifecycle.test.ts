import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Codex } from './codex';
import { BridgeService } from './service';
import { ReceiptStore } from './receipts';
import { TrustStore } from './trust-store';
import { createServer } from './server';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
const main = fileURLToPath(new URL('./main.ts', import.meta.url));
const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'oraculum-lifecycle-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const resources = join(root, 'resources');
  const home = join(root, 'home');
  const cwd = join(root, 'data/oraculum/workspaces/local');
  for (const path of [home, cwd, join(resources, 'apps/web/dist'), join(resources, 'themes')]) await mkdir(path, { recursive: true });
  await writeFile(join(resources, 'apps/web/dist/index.html'), '<html>isolated lifecycle fixture</html>');
  const binary = join(root, 'codex-fixture');
  await writeFile(binary, `#!${process.execPath}
const fs=require('node:fs');
if(process.argv[2]==='--version'){console.log('codex-cli 9.9.9-lifecycle-fixture');process.exit(0);}
fs.writeFileSync(process.env.FIXTURE_PID,String(process.pid));
process.on('SIGUSR1',()=>process.exit(Number(process.env.FIXTURE_EXIT_CODE||23)));
process.on('SIGUSR2',()=>console.log('invalid-json'));
const thread={id:'thread-fixture',cwd:process.cwd(),preview:'',turns:[],status:{type:'idle'}};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(process.env.FIXTURE_CALLS,m.method+'\\n');
 if(m.id===undefined)return;
 if(m.method==='turn/start'){
  console.log(JSON.stringify({id:77,method:'item/commandExecution/requestApproval',params:{threadId:thread.id,turnId:'turn-fixture',itemId:'item-fixture',command:'fixture'}}));
  return setTimeout(()=>process.exit(23),50);
 }
 if(m.method==='fixture/pending')return;
 const result=m.method==='initialize'?{userAgent:'fixture'}:
  m.method==='config/read'?{config:{model:null,model_provider:null,model_reasoning_effort:null}}:
  m.method==='thread/start'?{thread,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly'}}:
  {data:[],nextCursor:null};
 console.log(JSON.stringify({id:m.id,result}));
});
`);
  await chmod(binary, 0o700);
  const probe = createNetServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_STATE_HOME: join(root, 'state'), XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'), ORACULUM_STATE_DIR: join(root, 'state/oraculum'), ORACULUM_RESOURCE_DIR: resources,
    ORACULUM_WORKSPACE: cwd, ORACULUM_INIT_STATE: '1', ORACULUM_PORT: String(port), ORACULUM_CODEX_BIN: binary,
    FIXTURE_PID: join(root, 'fixture.pid'), FIXTURE_CALLS: join(root, 'calls'), PATH: '' };
  for (const key of ['ORACULUM_REMOTE_ORIGIN', 'ORACULUM_REMOTE_BASE_PATH', 'ORACULUM_WEB_DIR', 'ORACULUM_THEME_DIR', 'ORACULUM_THEME_SOURCE_DIR']) delete env[key];
  return { root, cwd, env, port, origin: `http://127.0.0.1:${port}`, web: join(resources, 'apps/web/dist') };
}
function launch(env: NodeJS.ProcessEnv, cwd: string) {
  const child = spawn(process.execPath, [tsx, main], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const done = once(child, 'exit');
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await done; }
  });
  return { child, done, output: () => output };
}
async function fixturePid(env: NodeJS.ProcessEnv) { return Number(await readFile(env.FIXTURE_PID!, 'utf8')); }
function localCodex(env: NodeJS.ProcessEnv, cwd: string) {
  for (const key of ['ORACULUM_CODEX_BIN', 'FIXTURE_PID', 'FIXTURE_CALLS']) vi.stubEnv(key, env[key]);
  const codex = new Codex(cwd);
  cleanup.push(() => codex.close());
  return codex;
}

it.each([0, 23])('exits Bridge nonzero when the initialized App Server unexpectedly exits %i, and permits a clean fresh restart', async code => {
  const { cwd, env, origin } = await fixture();
  const running = launch({ ...env, FIXTURE_EXIT_CODE: String(code) }, cwd);
  await expect.poll(running.output, { timeout: 10000 }).toContain('codex-cli 9.9.9-lifecycle-fixture');
  expect((await fetch(origin + '/health')).status).toBe(200);
  process.kill(await fixturePid(env), 'SIGUSR1');
  await expect.poll(() => running.child.exitCode, { timeout: 5000 }).toBe(1);
  await expect(fetch(origin + '/health')).rejects.toThrow();
  const restarted = launch({ ...env, ORACULUM_INIT_STATE: undefined }, cwd);
  await expect.poll(restarted.output, { timeout: 10000 }).toContain('codex-cli 9.9.9-lifecycle-fixture');
  expect((await fetch(origin + '/health')).status).toBe(200);
  restarted.child.kill('SIGTERM');
  expect((await restarted.done)[0]).toBe(0);
  const calls = await readFile(env.FIXTURE_CALLS!, 'utf8');
  expect(calls).not.toContain('turn/start'); expect(calls).not.toContain('thread/start');
}, 20000);

it('returns unavailable health as soon as the native process fails and invalidates pending requests', async () => {
  const { cwd, env, port, web } = await fixture();
  const codex = localCodex(env, cwd);
  await codex.initialize();
  const app = await createServer(new BridgeService(codex, cwd), port, web, { testOnlyUnauthenticated: true });
  cleanup.push(() => app.close());
  const pending = expect(codex.request('fixture/pending', {})).rejects.toThrow(/unknown/);
  const unavailable = once(codex, 'unavailable');
  process.kill(await fixturePid(env), 'SIGUSR1');
  await unavailable; await pending;
  const response = await app.inject({ url: '/health', headers: { host: `127.0.0.1:${port}` } });
  expect(response.statusCode).toBe(503);
  await expect(codex.request('thread/list', {})).rejects.toThrow('unavailable');
});

it('stops accepting requests immediately on deliberate close and finishes without leaving the native process alive', async () => {
  const { cwd, env } = await fixture();
  const codex = localCodex(env, cwd);
  await codex.initialize();
  const pid = await fixturePid(env);
  const pending = expect(codex.request('fixture/pending', {})).rejects.toThrow(/unknown/);
  const closing = codex.close();
  expect(codex.alive).toBe(false);
  await expect(codex.request('thread/list', {})).rejects.toThrow('unavailable');
  await closing; await pending;
  expect(() => process.kill(pid, 0)).toThrow();
});

it('preserves unknown delivery receipts through native failure and restart without replaying, and expires old approvals', async () => {
  const { cwd, env } = await fixture();
  const codex = localCodex(env, cwd);
  const trust = new TrustStore(env.ORACULUM_STATE_DIR!);
  const receipts = new ReceiptStore(trust.db);
  const service = new BridgeService(codex, cwd, receipts);
  let approvals = 0;
  service.on('event', event => { if (event.type === 'approval') approvals++; });
  const operationId = randomUUID();
  await codex.initialize();
  await service.dispatch('thread/start', {});
  await expect(service.dispatch('turn/start', { threadId: 'thread-fixture', text: 'fixture', operationId }, { deviceId: 'fixture-device' })).rejects.toThrow(/unknown/);
  expect(approvals).toBe(1);
  expect(service.pending.size).toBe(0);
  expect(receipts.list(cwd, 'thread-fixture')).toMatchObject([{ operationId, status: 'unknown', turnId: null }]);
  trust.close();
  const restarted = localCodex(env, cwd);
  const reopened = new TrustStore(env.ORACULUM_STATE_DIR!);
  cleanup.push(() => reopened.close());
  const resumed = new BridgeService(restarted, cwd, new ReceiptStore(reopened.db));
  await restarted.initialize();
  await resumed.dispatch('thread/start', {});
  await expect(resumed.dispatch('turn/start', { threadId: 'thread-fixture', text: 'fixture', operationId }, { deviceId: 'fixture-device' })).rejects.toThrow(/unknown/);
  expect((await readFile(env.FIXTURE_CALLS!, 'utf8')).split('\n').filter(method => method === 'turn/start')).toHaveLength(1);
});

it('exits Bridge nonzero after malformed native output, allowing the service manager to recover', async () => {
  const { cwd, env } = await fixture();
  const running = launch(env, cwd);
  await expect.poll(running.output, { timeout: 10000 }).toContain('codex-cli 9.9.9-lifecycle-fixture');
  process.kill(await fixturePid(env), 'SIGUSR2');
  await expect.poll(() => running.child.exitCode, { timeout: 5000 }).toBe(1);
}, 15000);
