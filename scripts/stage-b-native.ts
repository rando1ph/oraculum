// Exercise the delivered Bridge DEB, never an imported Bridge/source runtime.
// No package installation or production writes. One official native model turn.
// ORACULUM_STAGE_B_DEB=/absolute/package.deb pnpm exec tsx scripts/stage-b-native.ts
// Public routing additionally requires an explicit URL/port and ALLOW_PUBLIC_PORT=1.
import { chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isIP, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { sessionSnapshot } from './ui-state';

const deb = process.env.ORACULUM_STAGE_B_DEB;
if (!deb || !deb.startsWith('/')) throw new Error('ORACULUM_STAGE_B_DEB must select an absolute built Bridge DEB');
const port = Number(process.env.ORACULUM_STAGE_B_PORT ?? 17861);
const url = new URL(process.env.ORACULUM_STAGE_B_URL ?? `http://127.0.0.1:${port}/`);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid isolated test port');
if (url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) throw new Error('Select a canonical test entry URL');
if (url.protocol !== 'https:' && url.href !== `http://127.0.0.1:${port}/`) throw new Error('Non-public testing uses the exact loopback root URL');
if (url.protocol === 'https:' && ['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Public testing requires the existing remote HTTPS entry');
if (port === 17860) {
  if (process.env.ORACULUM_STAGE_B_ALLOW_PUBLIC_PORT !== '1' || url.protocol !== 'https:') throw new Error('Public test port requires explicit authorization input and HTTPS URL');
  const service = spawn('systemctl', ['--user', 'is-active', 'oraculum-bridge.service'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let state = ''; service.stdout.on('data', chunk => { state += String(chunk); });
  await new Promise<void>((done, fail) => { service.once('error', fail); service.once('exit', () => done()); });
  if (!['inactive', 'failed'].includes(state.trim())) throw new Error('Production Bridge must already be inactive; this harness never changes service state');
}
await new Promise<void>((done, fail) => {
  const probe = createServer();
  probe.once('error', fail); probe.listen(port, '127.0.0.1', () => probe.close(error => error ? fail(error) : done()));
});
if (execFileSync('dpkg-deb', ['--field', deb, 'Package'], { encoding: 'utf8' }).trim() !== 'oraculum-bridge' ||
    execFileSync('dpkg-deb', ['--field', deb, 'Architecture'], { encoding: 'utf8' }).trim() !== 'amd64') throw new Error('Select an independent amd64 oraculum-bridge DEB');

await mkdir('.local/evidence/stage-b', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/stage-b', url.protocol === 'https:' ? 'native-public-' : 'native-local-'));
await chmod(output, 0o700);
const rootfs = join(output, 'rootfs'), runtime = join(rootfs, 'usr/lib/oraculum-bridge');
const launcher = join(runtime, 'bin/oraculum-bridge'), bundledNode = join(runtime, 'node/bin/node');
const nativeHome = join(output, 'native-home'), originalHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const state = join(output, 'state'), home = join(output, 'home'), data = join(output, 'data');
const cwd = join(data, 'oraculum/workspaces/controlled'), config = join(output, 'runtime.json');
const originals: Record<string, string> = {};
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
  entry[1] !== undefined && !/^(?:ORACULUM_|XDG_)/.test(entry[0])));
Object.assign(env, { HOME: home, XDG_DATA_HOME: data, XDG_STATE_HOME: join(output, 'xdg-state'),
  XDG_CONFIG_HOME: join(output, 'config'), XDG_CACHE_HOME: join(output, 'cache'), CODEX_HOME: nativeHome,
  ORACULUM_CONFIG_FILE: config, ORACULUM_INIT_STATE: '1' });
const checks: string[] = [], errors: string[] = [], cleanupErrors: string[] = [];
const evidence: Record<string, unknown> = { date: new Date().toISOString(), output, url: url.href, port,
  realCodex: true, packagedRuntime: true, sourceBridgeImported: false, packageInstalled: false,
  isolatedNativeHome: true, tlsVerification: true, deb, debSha256: createHash('sha256').update(await readFile(deb)).digest('hex'),
  git: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
let browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined;
let child: ChildProcess | undefined, pausedPid: number | undefined, deviceId: string | undefined;
let flushDiagnostics: (() => Promise<void>) | undefined;
let failure = '', stage = 'extract', modelTurns = 0, starts = 0;
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const fingerprint = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
function cli(args: string[]) {
  // Pairing codes are written privately by the packaged CLI, never stdout.
  return execFileSync(launcher, args, { env, cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
function databaseEvidence() {
  // Read only receipt/auth metadata, using the package's own Node runtime.
  return JSON.parse(execFileSync(bundledNode, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    try { console.log(JSON.stringify({
      schema: db.prepare('PRAGMA user_version').get().user_version,
      receipts: db.prepare('SELECT operation_id AS operationId, status, turn_id AS turnId FROM send_receipts ORDER BY created_at').all(),
      devices: db.prepare('SELECT id, revoked FROM devices').all(),
      projects: db.prepare('SELECT COUNT(*) AS count FROM projects').get().count
    })); } finally { db.close(); }
  `, join(state, 'trust.sqlite')], { env, cwd, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }));
}
async function start() {
  starts++;
  let startup = '', diagnostics = '';
  const number = starts;
  child = spawn(launcher, [], { env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', chunk => { startup = (startup + String(chunk)).slice(-65536); });
  // Bridge drains native stderr. Keep only its bounded metadata diagnostics;
  // never export arbitrary startup errors, config or authorization material.
  child.stderr!.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-131072); });
  flushDiagnostics = async () => {
    const safe = (startup + '\n' + diagnostics).split('\n').flatMap(line => {
      try {
        const value = JSON.parse(line);
        if (!value || !['native-read', 'bridge-rpc'].includes(value.layer)) return [];
        // Explicit metadata allowlist, even if future logging gains new fields.
        return [JSON.stringify(Object.fromEntries(['layer', 'requestId', 'parentRequestId', 'method', 'elapsedMs', 'outcome', 'seq']
          .filter(key => value[key] !== undefined).map(key => [key, value[key]])))];
      } catch { return []; }
    });
    await writeFile(join(output, `bridge-${number}-diagnostics.jsonl`), safe.join('\n') + '\n', { mode: 0o600 });
  };
  const running = child;
  let spawnFailed = false;
  running.once('error', () => { spawnFailed = true; errors.push('Packaged Bridge process could not start'); });
  for (let attempt = 0; attempt < 240; attempt++) {
    if (spawnFailed || running.exitCode !== null || running.signalCode !== null) throw new Error('Packaged Bridge exited before health');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        expect(await response.json()).toMatchObject({ protocol: 1, mode: 'authenticated' });
        const line = startup.split('\n').find(line => { try { return typeof JSON.parse(line).codex === 'string'; } catch { return false; } });
        if (line) evidence.codexVersion = JSON.parse(line).codex;
        evidence.bridgeStarts = starts;
        delete env.ORACULUM_INIT_STATE;
        return;
      }
    } catch { /* Readiness is bounded; startup can initialize the official CLI. */ }
    await delay(250);
  }
  throw new Error('Packaged Bridge health deadline exceeded');
}
async function stop() {
  if (!child) return;
  const running = child; child = undefined;
  const flush = flushDiagnostics; flushDiagnostics = undefined;
  if (pausedPid) { try { process.kill(pausedPid, 'SIGCONT'); } catch { /* Already exited. */ } pausedPid = undefined; }
  try {
    if (running.pid === undefined || running.exitCode !== null || running.signalCode !== null) return;
    const exited = new Promise<void>(done => running.once('exit', () => done()));
    running.kill('SIGTERM');
    if (!await Promise.race([exited.then(() => true), delay(12000).then(() => false)])) {
      try { process.kill(-running.pid!, 'SIGKILL'); } catch { /* Already exited. */ }
      await exited;
      throw new Error('Packaged Bridge required forced cleanup');
    }
  } finally { await flush?.(); }
}
const ready = () => expect(page!.locator('.connection-status')).toContainText('状态已查询', { timeout: 45000 });
async function screenshot(name: string) {
  await page!.evaluate(async () => { await document.fonts.ready; });
  await page!.screenshot({ path: join(output, name), animations: 'disabled' });
}

try {
  execFileSync('dpkg-deb', ['--extract', deb, rootfs], { stdio: ['ignore', 'pipe', 'pipe'] });
  evidence.build = JSON.parse(await readFile(join(runtime, 'build.json'), 'utf8'));
  evidence.nodeVersion = execFileSync(bundledNode, ['--version'], { encoding: 'utf8' }).trim();
  for (const path of [nativeHome, state, home, cwd]) await mkdir(path, { recursive: true, mode: 0o700 });
  stage = 'private native configuration copies';
  // No DB, sessions, caches, user project, JKS or other credential is copied.
  for (const file of ['config.toml', 'auth.json']) if (existsSync(join(originalHome, file))) {
    originals[file] = await fingerprint(join(originalHome, file));
    await copyFile(join(originalHome, file), join(nativeHome, file)); await chmod(join(nativeHome, file), 0o600);
  }
  const codexBinary = process.env.ORACULUM_CODEX_BIN ?? execFileSync('sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).trim();
  await writeFile(config, JSON.stringify({ ORACULUM_STATE_DIR: state, ORACULUM_WORKSPACE: cwd,
    ORACULUM_PORT: String(port), CODEX_HOME: nativeHome, ORACULUM_CODEX_BIN: codexBinary,
    ...(url.protocol === 'https:' ? { ORACULUM_REMOTE_ORIGIN: url.origin, ORACULUM_REMOTE_BASE_PATH: url.pathname } : {}) }), { mode: 0o600 });
  const configHash = await fingerprint(config);
  stage = 'packaged Bridge startup'; await start();
  browser = await chromium.launch({ args: ['--no-proxy-server', '--proxy-server=direct://', '--proxy-bypass-list=*'],
    env: Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:https?|all)_proxy$/i.test(key))) });
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const websockets: string[] = []; page.on('websocket', socket => websockets.push(new URL(socket.url()).protocol));
  stage = 'entry and unauthenticated access';
  const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  expect(response?.status()).toBe(200);
  evidence.serverAddress = await response!.serverAddr(); evidence.security = await response!.securityDetails();
  if (url.protocol === 'https:') {
    expect(evidence.security).toBeTruthy();
    if (isIP(url.hostname)) expect((evidence.serverAddress as { ipAddress: string }).ipAddress).toBe(url.hostname);
    expect((evidence.serverAddress as { port: number }).port).toBe(443);
  }
  expect(await page.evaluate(async () => (await fetch(new URL('auth/session', location.href))).status)).toBe(401);
  stage = 'packaged trust CLI pairing'; cli(['trust', 'pair']);
  const pairingFile = join(state, 'pairing.txt'), code = (await readFile(pairingFile, 'utf8')).trim();
  await page.getByLabel('设备名称', { exact: true }).fill('Stage B packaged native isolated');
  await page.getByLabel('配对码', { exact: true }).fill(code);
  await page.getByRole('button', { name: '配对并连接', exact: true }).click(); await ready();
  await rm(pairingFile, { force: true });
  const session = await page.evaluate(async () => (await fetch(new URL('auth/session', location.href))).json());
  deviceId = session.device.id;
  expect(await page.evaluate(() => document.cookie)).toBe('');
  evidence.cookies = (await context.cookies()).map(({ name, httpOnly, secure, sameSite }) => ({ name, httpOnly, secure, sameSite }));
  expect(evidence.cookies).toEqual([expect.objectContaining({ httpOnly: true, sameSite: 'Strict', secure: url.protocol === 'https:' })]);
  checks.push('extracted DEB private runtime.json; packaged Node/Bridge/Web UI; unauthenticated rejection and packaged trust CLI pairing');
  stage = 'official native turn';
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click(); await ready();
  await expect(page.locator('.conversation')).not.toHaveAttribute('data-thread-id', '', { timeout: 70000 });
  const threadId = await page.locator('.conversation').getAttribute('data-thread-id');
  await page.getByLabel('消息', { exact: true }).fill('这是一次独立 Bridge DEB 隔离回归测试。不要使用工具、Skills、MCP、Apps、文件或子代理。只回复 ORACULUM_STAGE_B_PACKAGED_OK，不执行任何其他任务。');
  await page.getByRole('button', { name: '发送', exact: true }).click(); modelTurns++;
  await expect(page.getByText('ORACULUM_STAGE_B_PACKAGED_OK', { exact: true })).toBeVisible({ timeout: 180000 });
  await expect(page.locator('.conversation')).toHaveAttribute('data-last-turn-status', 'completed', { timeout: 45000 });
  const first = await sessionSnapshot(page); expect(first.receipts).toHaveLength(1);
  expect(first.receipts![0].status).toBe('completed');
  const operationId = first.receipts![0].operationId;
  evidence.beforeRestart = databaseEvidence();
  checks.push('one official Codex turn via authenticated Chromium mobile; terminal receipt persisted in package-created SQLite');
  await screenshot('01-packaged-native-complete.png');
  stage = 'native read timeout and recovery';
  const children = (await readFile(`/proc/${child!.pid}/task/${child!.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
  const natives: number[] = [];
  for (const pid of children) if ((await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').includes('app-server')) natives.push(pid);
  if (natives.length !== 1) throw new Error('Cannot identify the single isolated native child');
  pausedPid = natives[0]; process.kill(pausedPid, 'SIGSTOP');
  await page.getByRole('button', { name: '会话菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '查询状态', exact: true }).click();
  await expect(page.locator('.connection-status')).toContainText('待查询状态');
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await expect(page.getByRole('button', { name: '新建会话', exact: true })).toBeEnabled();
  await delay(9000); process.kill(pausedPid, 'SIGCONT'); pausedPid = undefined;
  await page.getByRole('button', { name: '折叠导航', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('oraculum-resume'))); await ready();
  checks.push('only packaged Bridge native child paused beyond 8s read deadline; navigation remains usable; foreground recovery succeeds');
  stage = 'Bridge/native restart'; await stop();
  const timeouts = (await readFile(join(output, 'bridge-1-diagnostics.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(value => value.layer === 'native-read' && value.outcome === 'timeout');
  expect(timeouts.some(value => value.elapsedMs >= 7900)).toBe(true);
  evidence.nativeReadTimeouts = timeouts;
  await expect(page.locator('.connection-status')).toContainText('已断开');
  await start();
  // The shipped UI retries a closed socket. A reconnect button can disappear
  // while startup finishes; observe recovery instead of racing its click.
  await ready();
  await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', threadId!);
  await expect(page.getByText('ORACULUM_STAGE_B_PACKAGED_OK', { exact: true })).toBeVisible({ timeout: 45000 });
  const after = await sessionSnapshot(page); expect(after.receipts).toHaveLength(1);
  expect(after.receipts![0]).toMatchObject({ operationId, status: 'completed' });
  expect(after.thread.turns.map(turn => turn.id)).toEqual(first.thread.turns.map(turn => turn.id));
  evidence.afterRestart = databaseEvidence(); expect(evidence.afterRestart).toEqual(evidence.beforeRestart);
  expect(await page.evaluate(async () => (await fetch(new URL('auth/session', location.href))).status)).toBe(200);
  checks.push('Bridge/native restart restores same native history, one terminal receipt, original device trust and project registration; no replay or re-pair');
  await screenshot('02-packaged-native-restarted.png');
  stage = 'packaged trust revocation'; cli(['trust', 'revoke', deviceId!]);
  await expect(page.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible({ timeout: 10000 });
  expect(await page.evaluate(async () => (await fetch(new URL('auth/session', location.href))).status)).toBe(401);
  checks.push('packaged trust CLI revocation closes live authenticated UI and denies the existing session');
  evidence.webSocketProtocols = [...new Set(websockets)];
  expect(websockets).toContain(url.protocol === 'https:' ? 'wss:' : 'ws:');
  evidence.runtimeConfigUnchanged = await fingerprint(config) === configHash;
  expect(evidence.runtimeConfigUnchanged).toBe(true); expect(errors).toEqual([]);
} catch (error) {
  // Redact all credential-shaped strings from local assertion details. Reports
  // exported to Notion use the stage/class and synthetic test data only.
  await writeFile(join(output, 'failure-detail.txt'), String(error).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]') + '\n', { mode: 0o600 });
  failure = `${stage}: ${error instanceof Error ? error.name : 'Error'}`; process.exitCode = 1;
  if (page) {
    await page.getByLabel('配对码', { exact: true }).fill('', { timeout: 1000 }).catch(() => {});
    await screenshot('failure.png').catch(() => {});
  }
} finally {
  try { await stop(); } catch { cleanupErrors.push('Packaged Bridge process cleanup failed'); }
  if (deviceId) try { cli(['trust', 'revoke', deviceId]); } catch { cleanupErrors.push('Test device revocation failed'); }
  try { await context?.close(); await browser?.close(); } catch { cleanupErrors.push('Browser cleanup failed'); }
  await rm(nativeHome, { recursive: true, force: true });
  await rm(join(state, 'pairing.txt'), { force: true });
  const originalsUnchanged = (await Promise.all(Object.entries(originals).map(async ([file, hash]) => await fingerprint(join(originalHome, file)) === hash))).every(Boolean);
  if (!originalsUnchanged || cleanupErrors.length) { failure ||= 'Preservation or cleanup check failed'; process.exitCode = 1; }
  Object.assign(evidence, { checks, errors, cleanupErrors, failure, modelTurns, originalsUnchanged,
    privateNativeCopiesRemoved: !existsSync(nativeHome), result: failure ? 'failed' : 'passed' });
  await writeFile(join(output, 'report.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ output, checks, failure, result: evidence.result }));
}
