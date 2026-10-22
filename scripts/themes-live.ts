// Opt-in actual HONOR USB WebView + Ubuntu Electron + official Codex.
// Isolated authenticated Bridge; two bounded turns (fixture Diff, harmless approvals + stop).
// No production server, user project, remote deployment or global Codex edits.
import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Page, type Cookie } from '@playwright/test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, rename, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Codex } from '../bridge/src/codex';
import { BridgeService } from '../bridge/src/service';
import { ProjectDirectories } from '../bridge/src/projects';
import { TrustStore } from '../bridge/src/trust-store';
import { ReceiptStore } from '../bridge/src/receipts';
import { Themes } from '../bridge/src/themes';
import { createServer } from '../bridge/src/server';
import type { Approval, BridgeEvent, Model, Snapshot } from '../packages/shared/protocol';

const port = 17860, origin = `http://127.0.0.1:${port}`;
try { await fetch(origin + '/health'); throw new Error('Port 17860 is in use; do not replace a running service'); }
catch (error) { if (!(error instanceof TypeError)) throw error; }
const output = resolve('.local/evidence/phase3/themes-live', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true, mode: 0o700 });
const workspaceRoot = join(homedir(), '.cache/oraculum/workspaces'); await mkdir(workspaceRoot, { recursive: true });
const reviewPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (reviewPath && !reviewPath.startsWith(resolve('.local/evidence/phase3/themes-live') + '/')) throw new Error('Read-only review requires a local theme acceptance report');
const review = reviewPath ? JSON.parse(await readFile(reviewPath, 'utf8')) : undefined;
if (review && (!review.real || !review.threadId || !review.cwd?.startsWith(join(workspaceRoot, 'phase3-themes-')) || await realpath(review.cwd) !== review.cwd)) throw new Error('Invalid real fixture report');
const cwd: string = review?.cwd ?? await mkdtemp(join(workspaceRoot, 'phase3-themes-'));
const adbArgs = process.env.ORACULUM_ADB_SERIAL ? ['-s', process.env.ORACULUM_ADB_SERIAL] : ['-d'];
const adb = (...args: string[]) => execFileSync('adb', [...adbArgs, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim();
const previousReverse = adb('reverse', '--list').split('\n').find(line => line.split(/\s+/)[1] === `tcp:${port}`)?.split(/\s+/)[2];
const configPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
const hashConfig = async () => createHash('sha256').update(await readFile(configPath)).digest('hex');
const baselineConfig = await hashConfig();
const stateDirectory = review?.stateDirectory ?? (review ? join(review.output, 'state') : join(output, 'state'));
const installedDirectory = review?.installedDirectory ?? (review ? join(review.output, 'themes') : join(output, 'themes'));
if (![stateDirectory, installedDirectory].every(p => typeof p === 'string' && resolve(p) === p && p.startsWith(resolve('.local/evidence/phase3/themes-live') + '/'))) throw new Error('Fixture state must stay in private theme evidence');
const trust = new TrustStore(stateDirectory);
const themes = new Themes({ source: resolve('themes'), installed: installedDirectory });
const projects = new ProjectDirectories(workspaceRoot, cwd, trust.db); await projects.register(cwd);
const codex = new Codex(cwd), service = new BridgeService(codex, cwd, new ReceiptStore(trust.db), projects);
const evidence: Record<string, any> = { real: true, simulated: false, date: new Date().toISOString(), cwd, output,
  readOnlyNativeReview: !!review, sourceAcceptance: reviewPath, stateDirectory, installedDirectory,
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  buildIndexSha256: createHash('sha256').update(await readFile('apps/web/dist/index.html')).digest('hex'),
  transport: 'HONOR Android 15 USB ADB reverse + Ubuntu Electron, isolated authenticated Bridge, official Codex App Server',
  checks: [], screenshots: [], requests: [], approvals: [], turns: [], items: [], cleanupErrors: [] };
const prompt = [
  '这是 Oraculum Trusted CSS 真实设备验收。工作目录是专用空测试目录。先仅用 apply_patch 创建 theme-proof.txt，内容为两行 Theme API v1 和 Trusted CSS。只允许写此文件，不读其他文件。不使用 Skills/MCP/web/子代理。然后仅执行以下两个无副作用命令，不执行其他命令。',
  '依次请求独立 shell 审批 sandbox_permissions=require_escalated：准确命令 `printf ORACULUM_3C_ALLOW`，justification="Oraculum theme allow test"；然后准确命令 `printf ORACULUM_3C_DECLINE`，justification="Oraculum theme decline test"。第二条会被拒绝，不得重试或绕过。',
  '结束时使用 Markdown 标题 `## 主题验收执行记录`，报告文件和允许/拒绝结果，再写 12 段每段两句的中文 CSS 主题使用建议，供真实滚动检查。不要声称界面验收通过。',
].join('\n');
const stopPrompt = 'Controlled Oraculum theme stop test. Only run `sleep 30` in cwd, then say done. Do not read/write files, request approvals, or use Skills/MCP/web/subagents.';
const nativeRequest = codex.request.bind(codex);
codex.request = async <T>(method: string, params: object): Promise<T> => {
  if (review && (method === 'turn/start' || method === 'thread/start')) throw new Error('Read-only review forbids new sessions or turns');
  if (method === 'turn/start') {
    const p = params as any;
    if (evidence.requests.length >= 2 || p.input?.[0]?.text !== (evidence.requests.length ? stopPrompt : prompt)) throw new Error('Only two exact bounded acceptance turns are authorized');
    evidence.requests.push({ method, threadId: p.threadId, model: p.model, effort: p.effort });
  }
  return nativeRequest<T>(method, params);
};
let pending: Approval | undefined;
service.on('event', (message: BridgeEvent) => {
  if (message.type === 'approval') pending = message.request;
  if (message.type !== 'event') return;
  if (message.event.method === 'turn/completed') evidence.turns.push({ id: message.event.params.turn.id, status: message.event.params.turn.status });
  if (message.event.method === 'item/completed' && message.event.params.item.type === 'commandExecution') evidence.items.push(message.event.params.item);
});
let server: Awaited<ReturnType<typeof createServer>> | undefined, android: Browser | undefined, app: ElectronApplication | undefined;
let phone!: Page, desktop!: Page;
let forwarded: string | undefined, savedCookies: Cookie[] | undefined;
let savedStorage: { local: Record<string, string>; session: Record<string, string> } | undefined;
const errors: string[] = [];
let step = 'setup', authenticated = false;
let restoreFixture: (() => Promise<void>) | undefined;
const ready = (page: Page) => expect(page.getByRole('status', { includeHidden: true })).toContainText('状态已查询', { timeout: 30_000 });
const currentTheme = (page: Page, id: string) => expect(page.locator('.app-shell')).toHaveAttribute('data-theme-id', id);
async function attach() {
  await android?.close();
  const pid = adb('shell', 'pidof', 'dev.oraculum.poc');
  if (!/^\d+$/.test(pid)) throw new Error('Expected one running Oraculum Android process');
  if (forwarded) adb('forward', `tcp:${forwarded}`, `localabstract:webview_devtools_remote_${pid}`);
  else forwarded = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
  await expect.poll(async () => { try { return (await fetch(`http://127.0.0.1:${forwarded}/json/list`).then(r => r.json())).length; } catch { return 0; } }, { timeout: 20_000 }).toBeGreaterThan(0);
  android = await chromium.connectOverCDP(`http://127.0.0.1:${forwarded}`, { noDefaults: true });
  phone = android.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith(origin) || p.url().startsWith('chrome-error://'))!;
  if (!phone) throw new Error('The current Android entry is not the local USB fixture; do not replace a user server');
  phone.on('pageerror', e => errors.push(e.message));
}
async function pair(page: Page, label: string) {
  await expect(page.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible();
  await page.getByLabel('设备名称', { exact: true }).fill(label); await page.getByLabel('配对码', { exact: true }).fill(trust.createPairing().code);
  await page.getByRole('button', { name: '配对并连接', exact: true }).click(); await ready(page);
}
async function hideIme() {
  const shown = () => /\bmInputShown=true\b/.test(adb('shell', 'dumpsys input_method | grep mInputShown='));
  if (shown()) { adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); await expect.poll(shown).toBe(false); }
}
async function drawer() {
  await hideIme();
  if (!await phone.locator('.app-shell').evaluate(e => e.classList.contains('drawer-open'))) await phone.getByRole('button', { name: '打开导航', exact: true }).click();
}
async function settings(page: Page) {
  if (await page.locator('.app-settings').isVisible()) return;
  if (page === phone) await drawer();
  await page.getByRole('button', { name: '设置', exact: true }).click(); await expect(page.getByLabel('当前主题')).toBeEnabled();
}
async function closeSettings(page: Page) {
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  if (page === phone && await page.locator('.app-shell').evaluate(e => e.classList.contains('drawer-open'))) await page.getByRole('button', { name: '折叠导航', exact: true }).click();
}
async function select(page: Page, id: string) {
  await settings(page); await page.getByRole('button', { name: '刷新主题列表', exact: true }).click();
  await expect(page.getByLabel('当前主题')).toBeEnabled(); await page.getByLabel('当前主题').selectOption(id); await currentTheme(page, id); await closeSettings(page);
}
async function screenshot(page: Page, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.screenshot({ path: join(output, name + '.png'), animations: 'disabled' });
  const capture: Record<string, unknown> = { name, web: name + '.png', theme: await page.locator('.app-shell').getAttribute('data-theme-id') };
  if (page === phone) { capture.device = name + '-device.png'; await writeFile(join(output, String(capture.device)), execFileSync('adb', [...adbArgs, 'exec-out', 'screencap', '-p'], { maxBuffer: 16 * 1024 * 1024 })); }
  evidence.screenshots.push(capture);
}
async function nativeRecoveryTap() {
  adb('shell', 'input', 'keyevent', '--longpress', 'KEYCODE_VOLUME_UP');
  adb('shell', 'uiautomator', 'dump', '/sdcard/oraculum-3c-window.xml');
  const xml = adb('exec-out', 'cat', '/sdcard/oraculum-3c-window.xml');
  const node = xml.match(/<node[^>]*text="恢复默认主题"[^>]*resource-id="android:id\/button1"[^>]*>/)?.[0];
  const bounds = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!bounds) throw new Error('Native theme recovery action not found');
  await writeFile(join(output, 'android-native-recovery.png'), execFileSync('adb', [...adbArgs, 'exec-out', 'screencap', '-p'], { maxBuffer: 16 * 1024 * 1024 }));
  adb('shell', 'input', 'tap', String((+bounds[1] + +bounds[3]) / 2), String((+bounds[2] + +bounds[4]) / 2));
  await attach(); await ready(phone); await currentTheme(phone, 'oracle-eye');
}
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron') });
async function launchDesktop(x11 = false) {
  app = await electron.launch({ executablePath: require('electron'), args: [...(x11 ? ['--ozone-platform=x11'] : []), resolve('apps/desktop/main.cjs')], env });
  desktop = await app.firstWindow(); desktop.on('pageerror', e => errors.push(e.message));
}
try {
  await codex.initialize(); server = await createServer(service, port, resolve('apps/web/dist'), { trust, themes }); await server.listen({ host: '127.0.0.1', port });
  adb('reverse', `tcp:${port}`, `tcp:${port}`); adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'); adb('shell', 'am', 'start', '-n', 'dev.oraculum.poc/.MainActivity');
  await attach();
  savedCookies = (await phone.context().cookies([origin])).filter(c => c.name === 'oraculum_local' && c.path === '/');
  await phone.goto(origin + '/');
  savedStorage = await phone.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  if (review?.cleanupErrors?.length) {
    const original = JSON.parse(await readFile(join(review.output, 'private-device-backup.json'), 'utf8'));
    const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
    const storageMatches = JSON.stringify(canonical(savedStorage)) === JSON.stringify(canonical(original.storage));
    const cookiesMatch = JSON.stringify(canonical(savedCookies)) === JSON.stringify(canonical(original.cookies));
    const extra = Object.keys(savedStorage.local).filter(k => !(k in original.storage.local));
    evidence.previousCleanup = { storageMatches, cookiesMatch, extraLocalKeys: extra };
    // Keep the ORIGINAL baseline if a pagehide/visibility callback ran after
    // restoration. Revoking/unmounting the fixture before restoring fixes this.
    const observed = savedStorage; savedStorage = original.storage; savedCookies = original.cookies;
    console.log(JSON.stringify({ previousCleanup: { storageMatches, cookiesMatch, extraLocalKeys: extra.length } }));
    expect(cookiesMatch).toBe(true);
    for (const bucket of ['local', 'session'] as const) for (const [key, value] of Object.entries(original.storage[bucket])) expect(observed[bucket][key] === value, 'original storage value retained').toBe(true);
    expect(extra.every(k => k.startsWith(`oraculum.reading:${cwd}:`))).toBe(true);
    evidence.checks.push(storageMatches ? 'previous run restored original phone cookie/local/session storage exactly' : 'original values/cookies intact; removed fixture reading key written by visibility callback during prior cleanup');
  }
  // Private recovery backup for an interrupted runner, never printed/uploaded.
  await writeFile(join(output, 'private-device-backup.json'), JSON.stringify({ cookies: savedCookies, storage: savedStorage }), { mode: 0o600 });
  await phone.context().clearCookies({ name: 'oraculum_local', domain: '127.0.0.1', path: '/' });
  await phone.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await phone.reload();
  await pair(phone, '3C HONOR test'); authenticated = true; await hideIme();
  await launchDesktop(); await pair(desktop, '3C Electron test');
  evidence.android = { manufacturer: adb('shell', 'getprop', 'ro.product.manufacturer'), model: adb('shell', 'getprop', 'ro.product.model'), release: adb('shell', 'getprop', 'ro.build.version.release'), viewport: await phone.evaluate(() => ({ width: innerWidth, height: innerHeight })), userAgent: await phone.evaluate(() => navigator.userAgent) };
  expect(evidence.android.manufacturer.toUpperCase()).toBe('HONOR'); expect(evidence.android.release).toBe('15');
  evidence.electron = await app!.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome }));
  step = 'install and independent preferences';
  await settings(phone); await phone.getByText('从主机主题目录安装', { exact: true }).click();
  for (const name of ['Violet · 验收测试', '香港雨夜 · CSS 验收', 'Minimal Light · CSS 验收']) {
    const install = phone.getByRole('button', { name: `安装 ${name}`, exact: true });
    if (await install.isEnabled()) await install.click();
    await expect(phone.getByLabel('当前主题')).toBeEnabled();
  }
  await expect(phone.getByLabel('当前主题')).toBeEnabled();
  await screenshot(phone, '01-android-install'); await closeSettings(phone);
  await select(desktop, 'test-violet'); await currentTheme(phone, 'oracle-eye'); await screenshot(desktop, '02-electron-violet');
  await app!.close(); await launchDesktop(); await ready(desktop); await currentTheme(desktop, 'test-violet'); await currentTheme(phone, 'oracle-eye');
  await select(phone, 'hong-kong-rain'); await select(desktop, 'minimal-light'); await screenshot(phone, '03-android-rain'); await screenshot(desktop, '03-electron-light');
  await settings(phone); await phone.locator('.theme-settings').scrollIntoViewIfNeeded(); await screenshot(phone, '04-android-theme-settings'); await closeSettings(phone);
  step = 'normal client process restarts';
  await app!.close(); await launchDesktop(); await ready(desktop); await currentTheme(desktop, 'minimal-light');
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await expect.poll(() => adb('shell', 'dumpsys window | grep mCurrentFocus=')).not.toContain('dev.oraculum.poc');
  adb('shell', 'am', 'force-stop', 'dev.oraculum.poc'); adb('shell', 'am', 'start', '-n', 'dev.oraculum.poc/.MainActivity');
  await attach(); await ready(phone); await currentTheme(phone, 'hong-kong-rain');
  evidence.checks.push(review ? 'existing installed fixture retained without reinstallation' : 'actual Android GUI directory installation, no auto-apply', 'independent preferences across both client process restarts');
  step = 'native Codex approvals with themes';
  if (!review) { await drawer(); await phone.getByRole('button', { name: '新建会话', exact: true }).click(); await ready(phone); }
  const threadId = (await phone.getByTestId('thread-id').textContent())!; expect(threadId).not.toBe('尚未选择会话'); evidence.threadId = threadId;
  await desktop.getByRole('button', { name: '刷新列表', exact: true }).click(); await desktop.locator(`nav[aria-label="原生会话"] button[title="${threadId}"]`).click(); await ready(desktop);
  if (!review) {
  const catalog = await service.dispatch('model/list', {}) as { data: Model[] };
  const model = catalog.data.find(m => m.model === (process.env.ORACULUM_TEST_MODEL ?? 'gpt-6-luna')) ?? catalog.data[0];
  if (!model) throw new Error('No official model available'); const effort = model.supportedReasoningEfforts.find(e => e.reasoningEffort === 'low')?.reasoningEffort ?? model.supportedReasoningEfforts[0].reasoningEffort;
  evidence.model = { model: model.model, effort, source: 'official model/list' };
  await phone.getByLabel('模型', { exact: true }).selectOption(model.model); await phone.getByLabel('思考强度', { exact: true }).selectOption(effort);
  await phone.getByLabel('消息', { exact: true }).fill(prompt); await hideIme(); await phone.getByRole('button', { name: '发送', exact: true }).click();
  for (const [marker, decision, label] of [['ORACULUM_3C_ALLOW', 'accept', '允许本次'], ['ORACULUM_3C_DECLINE', 'decline', '拒绝']] as const) {
    await expect.poll(() => pending?.method === 'item/commandExecution/requestApproval' ? pending.params.command : '', { timeout: 180_000 }).toContain(marker);
    const request = pending!, command = request.method === 'item/commandExecution/requestApproval' ? request.params.command : '';
    expect([`printf ${marker}`, `/bin/bash -lc 'printf ${marker}'`, `/bin/bash -lc "printf ${marker}"`, `/bin/sh -lc 'printf ${marker}'`]).toContain(command);
    // Changing theme while a real approval is pending must preserve its identity.
    await select(desktop, decision === 'accept' ? 'hong-kong-rain' : 'minimal-light');
    await select(phone, decision === 'accept' ? 'minimal-light' : 'hong-kong-rain');
    expect(service.pending.has(request.id)).toBe(true);
    await expect(desktop.getByRole('heading', { name: '需要审批', exact: true })).toBeVisible();
    const button = phone.getByRole('button', { name: label, exact: true }); await expect(button).toBeEnabled(); await button.scrollIntoViewIfNeeded();
    // Device-pixel conversion can report 47.99997 CSS px for a 48px target.
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(47.9);
    await screenshot(phone, `05-android-${decision}`); await screenshot(desktop, `06-electron-${decision}`);
    evidence.approvals.push({ requestId: request.id, itemId: request.params.itemId, command, decision });
    await button.click(); await expect(desktop.locator('.approval')).toHaveCount(0); await expect(phone.locator('.approval')).toHaveCount(0); pending = undefined;
  }
  await expect(phone.getByRole('heading', { name: '主题验收执行记录', exact: true })).toBeVisible({ timeout: 180_000 });
  await expect(phone.getByTestId('last-turn-status')).toHaveText('completed', { timeout: 30_000 }); await ready(phone);
  expect(evidence.items.find((i: any) => i.id === evidence.approvals[0].itemId)).toMatchObject({ status: 'completed', exitCode: 0 });
  expect(evidence.items.find((i: any) => i.id === evidence.approvals[1].itemId)).toMatchObject({ status: 'declined' });
  await screenshot(phone, '07-android-native-result');
  await phone.getByLabel('消息', { exact: true }).fill(stopPrompt); await hideIme(); await phone.getByRole('button', { name: '发送', exact: true }).click();
  await expect(phone.getByTestId('turn-status')).toHaveText('执行中'); await phone.getByRole('button', { name: '停止', exact: true }).click();
  await expect(phone.getByTestId('last-turn-status')).toHaveText('interrupted', { timeout: 30_000 });
  await phone.reload(); await ready(phone); await currentTheme(phone, 'hong-kong-rain');
  const snapshot = await service.dispatch('bridge/subscribe', { threadId }) as Snapshot;
  expect(snapshot.receipts?.map(r => r.status).sort()).toEqual(['completed', 'interrupted']);
  expect(evidence.requests).toHaveLength(2); evidence.checks.push('official Codex send/allow/decline/stop under test theme; pending request survives theme switch; cross-device invalidation; completed/interrupted receipt reload');
  } else {
    expect(threadId).toBe(review.threadId);
    const snapshot = await service.dispatch('bridge/subscribe', { threadId }) as Snapshot;
    expect(snapshot.receipts?.map(r => r.status).sort()).toEqual(['completed', 'interrupted']);
    await expect(phone.getByRole('heading', { name: '主题验收执行记录', exact: true })).toBeVisible();
    await screenshot(phone, '07-android-native-result'); evidence.checks.push('existing official native history and receipts after fresh App Server; zero new turns');
  }
  step = 'complex and light visuals, native Diff and reading';
  for (const id of ['hong-kong-rain', 'minimal-light']) {
    for (const page of [desktop, phone]) {
      await select(page, id);
      await page.getByRole('button', { name: '查看 Diff', exact: true }).first().click();
      await expect(page.locator('.cm-content')).toContainText('Trusted CSS');
      await screenshot(page, `12-${page === phone ? 'android' : 'electron'}-${id}-diff`);
      if (page === phone) { adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); await expect(page.locator('.inspector')).toHaveCount(0); }
      else await page.getByRole('button', { name: '关闭面板', exact: true }).click();
      const scroll = page.locator('.conversation-scroll');
      await scroll.evaluate(e => { e.scrollTop = e.scrollHeight / 2; });
      const before = await scroll.evaluate(e => e.scrollTop); expect(before).toBeGreaterThan(0);
      await screenshot(page, `13-${page === phone ? 'android' : 'electron'}-${id}-reading`);
      await page.getByRole('button', { name: '返回最新', exact: true }).click();
      await page.getByLabel('消息', { exact: true }).fill('主题切换保留草稿，不能发送。');
      await select(page, id === 'minimal-light' ? 'hong-kong-rain' : 'minimal-light');
      await expect(page.getByLabel('消息', { exact: true })).toHaveValue('主题切换保留草稿，不能发送。');
      await page.getByLabel('消息', { exact: true }).fill('');
      evidence.checks.push(`${page === phone ? 'HONOR' : 'Electron'} ${id} native Diff, reading, return-latest and draft retention`);
    }
  }
  if (process.env.ORACULUM_THEME_DEVICE_HOLD === '1') {
    step = 'native IME device hold';
    await select(phone, 'hong-kong-rain');
    await writeFile(join(output, 'device-ready.json'), JSON.stringify({ output, cdp: `http://127.0.0.1:${forwarded}`, threadId: evidence.threadId }));
    console.log('DEVICE_HOLD ' + output);
    await expect.poll(async () => { try { return JSON.parse(await readFile(join(output, 'device-checks.json'), 'utf8')).result; } catch { return 'waiting'; } }, { timeout: 900_000, intervals: [1000] }).toBe('passed');
    evidence.deviceChecks = JSON.parse(await readFile(join(output, 'device-checks.json'), 'utf8'));
    // System font/orientation checks can recreate Android's WebView. Rebind to
    // the current native page rather than retaining the pre-check CDP target.
    await attach(); await ready(phone); await hideIme();
  }
  step = 'failure matrix on actual clients';
  const installed = join(themes.paths.installed, 'test-violet');
  const manifest = await readFile(join(installed, 'manifest.json'), 'utf8'), css = await readFile(join(installed, 'theme.css'), 'utf8');
  restoreFixture = async () => {
    await rename(installed + '-missing', installed).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await writeFile(join(installed, 'manifest.json'), manifest); await writeFile(join(installed, 'theme.css'), css);
  };
  for (const page of [desktop, phone]) {
    for (const [name, file, broken] of [['incompatible', 'manifest.json', manifest.replace('"themeApi": 1', '"themeApi": 2')], ['damaged', 'theme.css', ':root{--accent:']]) {
      await select(page, 'test-violet'); await writeFile(join(installed, file), broken); await page.reload(); await ready(page);
      await currentTheme(page, 'oracle-eye'); await expect(page.getByRole('alert')).toContainText('已恢复默认主题');
      if (name === 'damaged') { await page.getByRole('alert').scrollIntoViewIfNeeded(); await screenshot(page, page === phone ? '08-android-damaged-fallback' : '09-electron-damaged-fallback'); }
      await writeFile(join(installed, file), file === 'theme.css' ? css : manifest);
      evidence.checks.push(`${page === phone ? 'HONOR' : 'Electron'} ${name} fallback`);
    }
    await select(page, 'test-violet'); await rename(installed, installed + '-missing'); await page.reload(); await ready(page); await currentTheme(page, 'oracle-eye');
    await rename(installed + '-missing', installed); evidence.checks.push(`${page === phone ? 'HONOR' : 'Electron'} missing fallback`);
  }
  step = 'native recovery from installed CSS hiding the entire page';
  await writeFile(join(installed, 'theme.css'), 'html,body,body *{visibility:hidden!important}');
  await settings(desktop); await desktop.getByLabel('当前主题').selectOption('test-violet');
  await currentTheme(desktop, 'test-violet'); await expect(desktop.getByLabel('当前主题')).toBeHidden();
  await app!.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('restore-default-theme')!.click());
  await ready(desktop); await currentTheme(desktop, 'oracle-eye'); await expect(desktop.getByLabel('消息', { exact: true })).toBeVisible(); await screenshot(desktop, '10-electron-restored');
  // Normal tests above use the platform default (Wayland here). XTest requires
  // an X11 window: restart this same real Electron profile on XWayland solely
  // for OS keyboard injection, not renderer/CDP synthetic keyboard events.
  await app!.close(); await launchDesktop(true); await ready(desktop); await currentTheme(desktop, 'oracle-eye');
  evidence.shortcutBackend = 'X11 via --ozone-platform=x11; other Electron checks use the platform default';
  await settings(desktop); await desktop.getByLabel('当前主题').selectOption('test-violet'); await currentTheme(desktop, 'test-violet');
  const windowId = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readUInt32LE());
  execFileSync('python3', ['-c', `
import ctypes, time
x=ctypes.CDLL('libX11.so.6'); t=ctypes.CDLL('libXtst.so.6')
x.XOpenDisplay.restype=ctypes.c_void_p
x.XKeysymToKeycode.argtypes=[ctypes.c_void_p,ctypes.c_ulong]
x.XSetInputFocus.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_int,ctypes.c_ulong]
x.XFlush.argtypes=[ctypes.c_void_p]
t.XTestFakeKeyEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong]
d=x.XOpenDisplay(None)
if not d: raise RuntimeError('X11 display unavailable')
x.XSetInputFocus(d,${windowId},1,0); x.XFlush(d); time.sleep(.2)
keys=[x.XKeysymToKeycode(d,k) for k in [0xffe3,0xffe1,0x30]]
for k in keys:
 t.XTestFakeKeyEvent(d,k,1,0); x.XFlush(d); time.sleep(.05)
for k in reversed(keys):
 t.XTestFakeKeyEvent(d,k,0,0); x.XFlush(d); time.sleep(.05)
x.XFlush(d)
`]);
  await ready(desktop); await currentTheme(desktop, 'oracle-eye');
  evidence.checks.push('Electron Ctrl+Shift+0 via actual X11 XTest keyboard events');
  await settings(phone); await phone.getByLabel('当前主题').selectOption('test-violet');
  await currentTheme(phone, 'test-violet'); await expect(phone.getByLabel('当前主题')).toBeHidden();
  await nativeRecoveryTap(); await expect(phone.getByLabel('消息', { exact: true })).toBeVisible(); await screenshot(phone, '11-android-restored');
  await writeFile(join(installed, 'theme.css'), css);
  await expect(phone.getByTestId('thread-id')).toHaveText(threadId); expect(evidence.requests).toHaveLength(review ? 0 : 2);
  evidence.checks.push('actual Electron native menu and HONOR ADB long-key native dialog recover entirely concealed page, preserving thread and no replay');
  expect(errors).toEqual([]); expect(await hashConfig()).toBe(baselineConfig); evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed'; evidence.step = step; evidence.error = authenticated ? String(error) : (error instanceof Error ? error.name : 'setup failure'); process.exitCode = 1;
  console.error(`Theme acceptance failed at ${step}: ${evidence.error}`);
  if (authenticated) {
    for (const [name, page] of [['phone', phone], ['desktop', desktop]] as const) {
      try {
        evidence[name + 'Failure'] = { url: page.url(), title: await page.title(), text: (await page.locator('body').innerText()).slice(0, 3000) };
        await page.screenshot({ path: join(output, name + '-failure.png') });
      } catch { /* A dead target is itself useful evidence. */ }
    }
  }
} finally {
  const clean = async (name: string, run: () => unknown | Promise<unknown>) => { try { await run(); } catch { evidence.cleanupErrors.push(name); evidence.result = 'failed'; process.exitCode = 1; } };
  await clean('restore theme fixture', () => restoreFixture?.());
  await clean('Electron', () => app?.close());
  await clean('revoke fixture devices', () => { for (const d of trust.list()) trust.revoke(d.id); });
  if (savedStorage) await clean('Android storage', async () => {
    await attach(); await phone.goto(origin + '/'); await expect(phone.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible();
    await phone.evaluate(saved => { localStorage.clear(); sessionStorage.clear(); for (const [k, v] of Object.entries(saved.local)) localStorage.setItem(k, v); for (const [k, v] of Object.entries(saved.session)) sessionStorage.setItem(k, v); }, savedStorage!);
    const restored = await phone.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(restored).toEqual(savedStorage); evidence.storageRestored = true;
  });
  if (savedCookies) await clean('Android cookie', async () => { await phone.context().clearCookies({ name: 'oraculum_local', domain: '127.0.0.1', path: '/' }); await phone.context().addCookies(savedCookies!); expect((await phone.context().cookies([origin])).filter(c => c.name === 'oraculum_local' && c.path === '/')).toEqual(savedCookies); evidence.cookiesRestored = true; });
  await clean('flush Android state', () => adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'));
  await clean('CDP', () => android?.close());
  await clean('Bridge', () => server?.close()); await clean('Codex', () => codex.close());
  await clean('fixture trust', () => trust.close());
  await clean('ADB reverse', () => previousReverse ? adb('reverse', `tcp:${port}`, previousReverse) : adb('reverse', '--remove', `tcp:${port}`));
  if (forwarded) await clean('ADB forward', () => adb('forward', '--remove', `tcp:${forwarded}`));
  await clean('native UI dump', () => adb('shell', 'rm', '-f', '/sdcard/oraculum-3c-window.xml'));
  if (!evidence.cleanupErrors.length) await rm(join(output, 'private-device-backup.json'), { force: true });
  evidence.globalConfigUnchanged = await hashConfig() === baselineConfig; evidence.rendererErrors = errors;
  await writeFile(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ result: evidence.result, output, step, checks: evidence.checks, turns: evidence.turns, cleanupErrors: evidence.cleanupErrors }, null, 2));
}
