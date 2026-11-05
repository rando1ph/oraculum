// One official Codex turn, fresh native/Bridge databases, Chromium mobile, then
// native SIGSTOP/read timeout and Bridge/native restart. No production writes.
import { chromium, expect } from '@playwright/test';
import { mkdir, mkdtemp, copyFile, chmod, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Codex } from '../bridge/src/codex';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import { TrustStore } from '../bridge/src/trust-store';
import { ReceiptStore } from '../bridge/src/receipts';
import { ProjectDirectories } from '../bridge/src/projects';
import { sessionSnapshot } from './ui-state';

const port = Number(process.env.ORACULUM_SYNC_PORT ?? 17861), url = new URL(process.env.ORACULUM_SYNC_URL ?? `http://127.0.0.1:${port}/`);
await mkdir('.local/evidence/stage-a', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/stage-a/native-')), workspaceRoot = join(output, 'workspaces'), cwd = join(workspaceRoot, 'controlled');
const nativeHome = join(output, 'native-home'), originalHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
await mkdir(cwd, { recursive: true }); await mkdir(nativeHome, { mode: 0o700 });
const originals: Record<string, string> = {};
const previous = { ...process.env };
const trust = new TrustStore(join(output, 'state')), projects = new ProjectDirectories(workspaceRoot, cwd, trust.db); await projects.register(cwd);
let codex: Codex | undefined, app: Awaited<ReturnType<typeof createServer>> | undefined;
let paused = false, failure = '', modelTurns = 0;
const checks: string[] = [], evidence: Record<string, unknown> = { output, url: url.href, date: new Date().toISOString(), realCodex: true, isolatedNativeHome: true, tlsVerification: true };
const browser = await chromium.launch({ args: ['--no-proxy-server', '--proxy-server=direct://', '--proxy-bypass-list=*'], env: Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(?:https?|all)_proxy$/i.test(key))) as Record<string, string> });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage(), errors: string[] = [];
page.on('pageerror', e => errors.push(e.message));
async function start() {
  codex = new Codex(cwd); await codex.initialize(); evidence.codexVersion = codex.version;
  const service = new BridgeService(codex, cwd, new ReceiptStore(trust.db), projects);
  app = await createServer(service, port, resolve('apps/web/dist'), { trust, ...(url.protocol === 'https:' ? { remoteOrigin: url.origin, remoteBasePath: url.pathname } : {}) });
  await app.listen({ host: '127.0.0.1', port });
}
const ready = () => expect(page.locator('.connection-status')).toContainText('状态已查询', { timeout: 45000 });
try {
  // Only private, one-run copies of the effective config/login. No native DB,
  // session, cache or other user's project is copied; copies are removed on exit.
  for (const file of ['config.toml', 'auth.json']) if (existsSync(join(originalHome, file))) {
    originals[file] = createHash('sha256').update(await readFile(join(originalHome, file))).digest('hex');
    await copyFile(join(originalHome, file), join(nativeHome, file)); await chmod(join(nativeHome, file), 0o600);
  }
  Object.assign(process.env, { CODEX_HOME: nativeHome, HOME: join(output, 'home'), XDG_DATA_HOME: join(output, 'data'), XDG_STATE_HOME: join(output, 'xdg-state'), XDG_CONFIG_HOME: join(output, 'config'), XDG_CACHE_HOME: join(output, 'cache') });
  await mkdir(process.env.HOME!, { recursive: true, mode: 0o700 });
  await start();
  const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 }); evidence.serverAddress = await response!.serverAddr(); evidence.security = await response!.securityDetails();
  if (url.protocol === 'https:') { expect((evidence.serverAddress as any).ipAddress).toBe(url.hostname); expect(evidence.security).toBeTruthy(); }
  await page.getByLabel('设备名称', { exact: true }).fill('Stage A official native isolated');
  await page.getByLabel('配对码', { exact: true }).fill(trust.createPairing().code);
  await page.getByRole('button', { name: '配对并连接', exact: true }).click(); await ready();
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click(); await ready();
  await expect(page.locator('.conversation')).not.toHaveAttribute('data-thread-id', '', { timeout: 70000 });
  const threadId = await page.locator('.conversation').getAttribute('data-thread-id');
  await page.getByLabel('消息', { exact: true }).fill('这是一次隔离连接回归测试。不要使用工具、Skills、MCP、Apps、文件或子代理。只回复 ORACULUM_STAGE_A_NATIVE_OK，不执行任何其他任务。');
  await page.getByRole('button', { name: '发送', exact: true }).click(); modelTurns++;
  await expect(page.getByText('ORACULUM_STAGE_A_NATIVE_OK', { exact: true })).toBeVisible({ timeout: 180000 });
  await expect(page.locator('.conversation')).toHaveAttribute('data-last-turn-status', 'completed', { timeout: 45000 });
  const first = await sessionSnapshot(page); expect(first.receipts).toHaveLength(1); expect(first.receipts![0].status).toBe('completed');
  const operationId = first.receipts![0].operationId;
  checks.push('one official native turn through authenticated Chromium mobile; terminal receipt confirmed');
  await page.screenshot({ path: join(output, '01-native-complete.png') });
  const pid = (codex as unknown as { child: { pid: number } }).child.pid;
  process.kill(pid, 'SIGSTOP'); paused = true;
  await page.getByRole('button', { name: '会话菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '查询状态', exact: true }).click();
  await expect(page.locator('.connection-status')).toContainText('待查询状态');
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await expect(page.getByRole('button', { name: '新建会话', exact: true })).toBeEnabled();
  // Keep the native process paused beyond the actual 8s native read deadline.
  await new Promise<void>(yes => setTimeout(yes, 9000));
  process.kill(pid, 'SIGCONT'); paused = false;
  await page.getByRole('button', { name: '折叠导航', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('oraculum-resume'))); await ready();
  checks.push('only the test App Server was SIGSTOPped; native read deadline fired while UI navigation and WS remained available; SIGCONT plus foreground read recovered');
  await app!.close(); app = undefined; await codex!.close(); codex = undefined;
  await expect(page.locator('.connection-status')).toContainText('已断开');
  await start();
  await page.getByRole('button', { name: '重新连接', exact: true }).click(); await ready();
  await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', threadId!);
  await expect(page.getByText('ORACULUM_STAGE_A_NATIVE_OK', { exact: true })).toBeVisible({ timeout: 45000 });
  const after = await sessionSnapshot(page); expect(after.receipts).toHaveLength(1); expect(after.receipts![0]).toMatchObject({ operationId, status: 'completed' });
  await expect(page.locator('.conversation')).toHaveAttribute('data-last-turn-status', 'completed');
  checks.push('Bridge/native restart restores native history and the same single persisted receipt; no model turn is replayed');
  await page.screenshot({ path: join(output, '02-native-restarted.png') }); expect(errors).toEqual([]);
} catch (error) { failure = String(error); process.exitCode = 1; await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {}); }
finally {
  if (paused && codex) process.kill((codex as unknown as { child: { pid: number } }).child.pid, 'SIGCONT');
  await context.close(); await browser.close(); await app?.close(); await codex?.close();
  for (const device of trust.list()) trust.revoke(device.id); trust.close();
  await rm(nativeHome, { recursive: true, force: true });
  const originalsUnchanged = (await Promise.all(Object.entries(originals).map(async ([file, hash]) => createHash('sha256').update(await readFile(join(originalHome, file))).digest('hex') === hash))).every(Boolean);
  for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, previous);
  if (!originalsUnchanged) { failure ||= 'Original native config/login fingerprint changed'; process.exitCode = 1; }
  Object.assign(evidence, { checks, errors, failure, modelTurns, originalsUnchanged, privateNativeCopiesRemoved: !existsSync(nativeHome), result: failure ? 'failed' : 'passed' });
  await writeFile(join(output, 'report.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify({ output, checks, failure, result: evidence.result }));
}
