// Opt-in: real Codex lifecycle + authenticated source Bridge + Electron and
// optionally an actual Android Debug WebView. No model inference or user history.
import { _electron as electron, chromium, expect, type Browser, type Cookie, type ElectronApplication, type Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Codex } from '../bridge/src/codex';
import { BridgeService } from '../bridge/src/service';
import { ProjectDirectories } from '../bridge/src/projects';
import { TrustStore } from '../bridge/src/trust-store';
import { ReceiptStore } from '../bridge/src/receipts';
import { createServer } from '../bridge/src/server';
import type { Thread } from '../packages/shared/protocol';

const realAndroid = process.argv.includes('--android');
const port = realAndroid ? 17860 : 17877, origin = `http://127.0.0.1:${port}`;
try { await fetch(origin + '/health'); throw new Error('Test port occupied; refusing to replace a service'); }
catch (error) { if (!(error instanceof TypeError)) throw error; }
const output = resolve('.local/evidence/phase4d2', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true, mode: 0o700 });
const root = await mkdtemp(join(tmpdir(), 'oraculum-lifecycle-'));
const cwd = join(root, 'Lifecycle-Test'), isolatedHome = join(root, 'codex');
await mkdir(cwd); await mkdir(isolatedHome);
const previousHome = process.env.CODEX_HOME;
const configPath = join(previousHome ?? join(homedir(), '.codex'), 'config.toml');
const hashConfig = async () => createHash('sha256').update(await readFile(configPath).catch(() => Buffer.alloc(0))).digest('hex');
const originalConfig = await hashConfig();
await writeFile(join(isolatedHome, 'config.toml'), 'model = "lifecycle-test"\nmodel_provider = "lifecycle_probe"\n[model_providers.lifecycle_probe]\nname = "Offline lifecycle probe"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n', { mode: 0o600 });
process.env.CODEX_HOME = isolatedHome;
const trust = new TrustStore(join(root, 'bridge-state'));
const projects = new ProjectDirectories(root, cwd, trust.db); await projects.register(cwd);
const codex = new Codex(cwd), service = new BridgeService(codex, cwd, new ReceiptStore(trust.db), projects);
const terminalTurns = new Set<string>();
codex.on('message', message => { if (message.method === 'turn/completed') terminalTurns.add(message.params.turn.id); });
const checks: string[] = [], rendererErrors: string[] = [], cleanupErrors: string[] = [];
const evidence: Record<string, unknown> = { date: new Date().toISOString(), nativeVersion: codex.version,
  realElectron: true, realAndroid, inference: false, isolatedCodexHome: true,
  transport: realAndroid ? 'USB ADB reverse; Android Debug (not Release/public HTTPS)' : 'Loopback; Chromium mobile emulation', checks, rendererErrors, cleanupErrors };
const adbArgs = process.env.ORACULUM_ADB_SERIAL ? ['-s', process.env.ORACULUM_ADB_SERIAL] : ['-d'];
const adb = (...args: string[]) => execFileSync('adb', [...adbArgs, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim();
let server: Awaited<ReturnType<typeof createServer>> | undefined, app: ElectronApplication | undefined, browser: Browser | undefined;
let phone: Page | undefined, desktop: Page | undefined, forwarded: string | undefined, previousReverse: string | undefined;
let savedCookies: Cookie[] | undefined, savedStorage: { local: Record<string, string>; session: Record<string, string> } | undefined;
const ready = (page: Page) => expect(page.locator('.connection-status')).toContainText('状态已查询', { timeout: 20_000 });
async function pair(page: Page, label: string) {
  await expect(page.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible();
  await page.getByLabel('设备名称', { exact: true }).fill(label);
  await page.getByLabel('配对码', { exact: true }).fill(trust.createPairing().code);
  await page.getByRole('button', { name: '配对并连接', exact: true }).click(); await ready(page);
}
async function nav(page: Page) { if (await page.getByRole('button', { name: '打开导航', exact: true }).isVisible() && !await page.locator('.app-shell').evaluate(el => el.classList.contains('drawer-open'))) await page.getByRole('button', { name: '打开导航', exact: true }).click(); }
async function capture(page: Page, name: string) {
  await page.screenshot({ path: join(output, name + '.png') });
  if (realAndroid && page === phone) await writeFile(join(output, name + '-device.png'), execFileSync('adb', [...adbArgs, 'exec-out', 'screencap', '-p'], { maxBuffer: 16 * 1024 * 1024 }));
}
async function seed(name: string) {
  const { thread } = await codex.request<{ thread: Thread }>('thread/start', { cwd, ephemeral: false });
  await codex.request('thread/name/set', { threadId: thread.id, name });
  // Native list omits empty conversations. An offline turn creates a genuine
  // user history entry, is stopped against loopback, and never reaches a model.
  const { turn } = await codex.request<{ turn: { id: string } }>('turn/start', { threadId: thread.id,
    input: [{ type: 'text', text: '生命周期测试记录（离线测试，无模型推理）', text_elements: [] }] });
  await expect.poll(async () => terminalTurns.has(turn.id) || (await codex.request<{ thread: Thread }>('thread/read', { threadId: thread.id })).thread.status.type === 'active', { timeout: 20_000 }).toBe(true);
  if (!terminalTurns.has(turn.id)) await codex.request('turn/interrupt', { threadId: thread.id, turnId: turn.id });
  await expect.poll(() => terminalTurns.has(turn.id), { timeout: 20_000 }).toBe(true);
  return thread.id;
}
try {
  await codex.initialize();
  const mainId = await seed('归档与恢复 · 测试会话'), deleteId = await seed('删除确认 · 测试会话');
  const list = await service.dispatch('thread/list', { cwd }) as { data: Thread[] };
  assert.ok(list.data.some(t => t.id === mainId) && list.data.some(t => t.id === deleteId));
  await assert.rejects(service.dispatch('thread/delete', { threadId: deleteId }), /confirm|确认/i);
  checks.push('real native offline fixture persistence; unconfirmed delete rejected');
  server = await createServer(service, port, resolve('apps/web/dist'), { trust }); await server.listen({ host: '127.0.0.1', port });
  const unauth = await fetch(origin + '/auth/session'); assert.equal(unauth.status, 401);
  const require = createRequire(resolve('apps/desktop/package.json'));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron-profile') });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  await expect.poll(() => app!.windows().some(p => p.url().startsWith(origin))).toBe(true);
  desktop = app.windows().find(p => p.url().startsWith(origin))!; desktop.on('pageerror', error => rendererErrors.push(error.message));
  await pair(desktop, '4D.2 Electron fixture');
  if (realAndroid) {
    previousReverse = adb('reverse', '--list').split('\n').find(line => line.split(/\s+/)[1] === `tcp:${port}`)?.split(/\s+/)[2];
    adb('reverse', `tcp:${port}`, `tcp:${port}`); adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'); adb('shell', 'am', 'start', '-n', 'dev.oraculum.poc/.MainActivity');
    const pid = adb('shell', 'pidof', 'dev.oraculum.poc'); assert.match(pid, /^\d+$/);
    forwarded = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${forwarded}`, { noDefaults: true });
    phone = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith(origin) || p.url().startsWith('chrome-error://'));
    if (!phone) throw new Error('Debug WebView uses another entry; refusing to replace it');
    savedCookies = (await phone.context().cookies([origin])).filter(c => c.name === 'oraculum_local' && c.path === '/');
    // Quiesce the prior app before reading storage: neither connection effects
    // nor pagehide handlers may race this private backup/restore operation.
    await phone.goto(origin + '/auth/session'); savedStorage = await phone.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
    await writeFile(join(output, 'private-device-backup.json'), JSON.stringify({ cookies: savedCookies, storage: savedStorage }), { mode: 0o600 });
    await phone.context().clearCookies({ name: 'oraculum_local', domain: '127.0.0.1', path: '/' });
    await phone.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await phone.goto(origin);
    evidence.android = { manufacturer: adb('shell', 'getprop', 'ro.product.manufacturer'), model: adb('shell', 'getprop', 'ro.product.model'), release: adb('shell', 'getprop', 'ro.build.version.release') };
  } else {
    browser = await chromium.launch(); phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); await phone.goto(origin);
  }
  phone.on('pageerror', error => rendererErrors.push(error.message)); await pair(phone, '4D.2 Android fixture');
  if (realAndroid && /mInputShown=true/.test(adb('shell', 'dumpsys', 'input_method'))) adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  // UI assertions below intentionally use accessible labels shared by both shells.
  await desktop.locator(`.session-link[title="${mainId}"]`).click(); await ready(desktop);
  await nav(phone); await phone.locator(`.session-link[title="${mainId}"]`).click(); await ready(phone);
  await desktop.getByRole('button', { name: '会话操作：归档与恢复 · 测试会话', exact: true }).click();
  await capture(desktop, 'electron-session-menu');
  await desktop.getByRole('dialog').getByRole('button', { name: /^归档会话/ }).click();
  for (const page of [desktop, phone]) {
    await expect(page.getByTestId('thread-id')).not.toHaveText(mainId);
    await nav(page); await expect(page.locator(`.session-link[title="${mainId}"]`)).toHaveCount(0);
    await page.getByRole('button', { name: '已归档', exact: true }).click();
    await expect(page.locator(`.session-link[title="${mainId}"]`)).toBeVisible();
  }
  checks.push('Electron native archive removes selected thread and blocks stale composer on both authenticated clients; archived list synchronized');
  await capture(phone, 'android-archived-list');
  await phone.getByRole('button', { name: '会话操作：归档与恢复 · 测试会话', exact: true }).click();
  await phone.getByRole('dialog').getByRole('button', { name: /^恢复归档/ }).click();
  for (const page of [desktop, phone]) {
    await expect(page.locator(`.session-link[title="${mainId}"]`)).toHaveCount(0);
    await page.getByRole('button', { name: '会话', exact: true }).click();
    await expect(page.locator(`.session-link[title="${mainId}"]`)).toBeVisible();
  }
  checks.push('Android native unarchive appears in active list on both devices');
  await phone.getByRole('button', { name: '会话操作：删除确认 · 测试会话', exact: true }).click();
  await phone.getByRole('dialog').getByRole('button', { name: /^永久删除/ }).click();
  await expect(phone.getByRole('dialog')).toBeVisible(); await capture(phone, 'android-delete-confirmation');
  await phone.getByRole('button', { name: '取消', exact: true }).click();
  await phone.getByRole('button', { name: '关闭会话操作', exact: true }).click();
  assert.ok((await service.dispatch('thread/list', { cwd }) as { data: Thread[] }).data.some(t => t.id === deleteId));
  await phone.getByRole('button', { name: '会话操作：删除确认 · 测试会话', exact: true }).click();
  await phone.getByRole('dialog').getByRole('button', { name: /^永久删除/ }).click();
  await phone.getByRole('button', { name: '确认永久删除', exact: true }).click();
  for (const page of [desktop, phone]) await expect(page.locator(`.session-link[title="${deleteId}"]`)).toHaveCount(0);
  await assert.rejects(codex.request('thread/read', { threadId: deleteId }), /not loaded|not found|no rollout/i);
  checks.push('Android cancel preserves native thread; confirmed permanent delete synchronizes both clients and native read fails');
  // Remaining test thread is deleted from the archived view as a second path.
  await desktop.getByRole('button', { name: '会话操作：归档与恢复 · 测试会话', exact: true }).click();
  await desktop.getByRole('dialog').getByRole('button', { name: /^归档会话/ }).click();
  await desktop.getByRole('button', { name: '已归档', exact: true }).click();
  await desktop.getByRole('button', { name: '会话操作：归档与恢复 · 测试会话', exact: true }).click();
  await desktop.getByRole('dialog').getByRole('button', { name: /^永久删除/ }).click();
  await desktop.getByRole('button', { name: '确认永久删除', exact: true }).click();
  await expect(desktop.locator(`.session-link[title="${mainId}"]`)).toHaveCount(0);
  await assert.rejects(codex.request('thread/read', { threadId: mainId }), /not loaded|not found|no rollout/i);
  await phone.reload(); await ready(phone);
  assert.equal((await service.dispatch('thread/list', { cwd, archived: true }) as { data: Thread[] }).data.length, 0);
  assert.equal((await service.dispatch('thread/list', { cwd }) as { data: Thread[] }).data.length, 0);
  checks.push('archived native delete, reload and both native lists confirm removal');
  await desktop.getByRole('button', { name: '会话', exact: true }).click();
  await desktop.locator('.new-session').click(); await ready(desktop);
  await expect(desktop.getByTestId('thread-id')).toHaveText(/^[0-9a-f-]{36}$/);
  const emptyId = (await desktop.getByTestId('thread-id').textContent())!;
  await desktop.getByRole('button', { name: '会话操作：新会话', exact: true }).click();
  await desktop.getByRole('dialog').getByRole('button', { name: /^归档会话/ }).click();
  await expect(desktop.getByRole('dialog')).toContainText('空会话尚未进入原生历史');
  await desktop.getByRole('dialog').getByRole('button', { name: /^永久删除/ }).click();
  await desktop.getByRole('button', { name: '确认永久删除', exact: true }).click();
  await expect(desktop.getByRole('dialog')).toHaveCount(0);
  await assert.rejects(codex.request('thread/read', { threadId: emptyId }), /not loaded|not found|no rollout/i);
  checks.push('fresh empty thread archive safely refused; explicit confirmation deletes the real native empty thread');
  assert.deepEqual(rendererErrors, []); evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed'; evidence.error = String(error); process.exitCode = 1;
  if (desktop) await capture(desktop, 'failure-desktop').catch(() => {});
  if (phone) await capture(phone, 'failure-phone').catch(() => {});
} finally {
  async function clean(label: string, action: () => unknown | Promise<unknown>) { try { await action(); } catch (error) { cleanupErrors.push(`${label}: ${String(error)}`); process.exitCode = 1; } }
  await clean('Electron', () => app?.close());
  if (phone && savedStorage) await clean('Android storage', async () => {
    await phone!.goto(origin + '/auth/session');
    await phone!.evaluate(saved => { localStorage.clear(); sessionStorage.clear(); for (const [key, value] of Object.entries(saved.local)) localStorage.setItem(key, value); for (const [key, value] of Object.entries(saved.session)) sessionStorage.setItem(key, value); }, savedStorage!);
    assert.deepEqual(await phone!.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })), savedStorage); evidence.storageRestored = true;
  });
  if (phone && savedCookies) await clean('Android cookies', async () => {
    await phone!.context().clearCookies({ name: 'oraculum_local', domain: '127.0.0.1', path: '/' }); await phone!.context().addCookies(savedCookies!);
    assert.deepEqual((await phone!.context().cookies([origin])).filter(c => c.name === 'oraculum_local' && c.path === '/'), savedCookies); evidence.cookiesRestored = true;
  });
  if (realAndroid) await clean('Android background', () => adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'));
  if (phone && savedStorage) await clean('Android storage after background', async () => {
    assert.deepEqual(await phone!.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })), savedStorage);
  });
  await clean('browser', () => browser?.close()); await clean('Bridge', () => server?.close()); await clean('Codex', () => codex.close()); await clean('trust', () => trust.close());
  if (realAndroid) await clean('ADB reverse', () => previousReverse ? adb('reverse', `tcp:${port}`, previousReverse) : adb('reverse', '--remove', `tcp:${port}`));
  if (forwarded) await clean('ADB forward', () => adb('forward', '--remove', `tcp:${forwarded}`));
  if (!cleanupErrors.length) await rm(join(output, 'private-device-backup.json'), { force: true });
  evidence.globalConfigUnchanged = await hashConfig() === originalConfig;
  if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  // Native plugin extraction may finish just after App Server exits. Retry only
  // disposal of this isolated fixture; never apply this to the user's CODEX_HOME.
  await clean('isolated fixture', () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  await writeFile(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ output, ...evidence }));
}
