// Opt-in actual Ubuntu Electron + Android Debug + source Bridge acceptance.
// Five bounded official Codex turns in a disposable project, with native settings readback.
// The fifth turn exercises two harmless command approvals; no global config edits.
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
import { ThreadPermissionStore } from '../bridge/src/thread-permissions';
import { Themes } from '../bridge/src/themes';
import { createServer } from '../bridge/src/server';
import type { Approval, BridgeEvent, Model, NativeSessionSettings, Thread } from '../packages/shared/protocol';
import { sessionSnapshot } from './ui-state';
import { modelTrigger, permissionTrigger, selectModel, selectEffort, selectPermission } from './composer-controls';

const port = 17860, origin = `http://127.0.0.1:${port}`;
try { await fetch(origin + '/health'); throw new Error('Port 17860 occupied; refusing to replace a service'); }
catch (error) { if (!(error instanceof TypeError)) throw error; }
function productionStopped() {
  try { return execFileSync('systemctl', ['--user', 'is-active', 'oraculum-bridge.service'], { encoding: 'utf8' }).trim() === 'inactive'; }
  catch (error) { return String((error as { stdout?: unknown }).stdout).trim() === 'inactive'; }
}
assert.ok(productionStopped(), 'Installed production Bridge must already be stopped');
const output = resolve('.local/evidence/phase4d3-patch/live', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true, mode: 0o700 });
const root = await mkdtemp(join(tmpdir(), 'oraculum-messages-')), cwd = join(root, 'Composer-Review'); await mkdir(cwd);
const configPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
const hashConfig = async () => createHash('sha256').update(await readFile(configPath)).digest('hex');
const baselineConfig = await hashConfig();
const trust = new TrustStore(join(root, 'state')), themes = new Themes({ source: resolve('themes'), installed: join(root, 'themes') });
const projects = new ProjectDirectories(root, cwd, trust.db); await projects.register(cwd);
let codex = new Codex(cwd);
const receipts = new ReceiptStore(trust.db), permissionStore = new ThreadPermissionStore(trust.db);
let service = new BridgeService(codex, cwd, receipts, projects, permissionStore);
const checks: string[] = [], errors: string[] = [], cleanupErrors: string[] = [];
const evidence: Record<string, unknown> = { date: new Date().toISOString(), realElectron: true, realAndroid: true, simulated: false,
  transport: 'Ubuntu Electron + Android Debug WebView over USB ADB reverse; source-built authenticated Bridge; official Codex',
  nativeVersion: codex.version, gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  buildIndexSha256: createHash('sha256').update(await readFile('apps/web/dist/index.html')).digest('hex'), checks, errors, cleanupErrors };
const prompts = [
  '这是隔离的界面验收。请直接用中文回复一句简短问候，不使用任何工具、命令、Skills、MCP、网络或子代理。',
  '继续用一句中文描述清晰对话的好处。只输出文字，不使用任何工具或子代理。',
  '请用普通正文和两条简短列表给出阅读建议。只输出文字，不使用任何工具或子代理。',
  '请输出一个简短的Markdown二级标题“从容对话”，然后用两句话说明清晰输入的价值，最后给一个3行TypeScript问候函数代码块。只输出文字，不使用任何工具或子代理。',
  '这是隔离空目录中的原生审批验收。依次请求两个独立shell审批，sandbox_permissions=require_escalated：准确命令 `printf ORACULUM_PATCH_ALLOW`，justification="Oraculum patch allow test"；随后准确命令 `printf ORACULUM_PATCH_DECLINE`，justification="Oraculum patch decline test"。第二个会拒绝，绝不重试或绕过。不读取或写入文件、不用其他工具/Skills/MCP/网络/子代理。最后仅用一句中文报告实际允许与拒绝结果，不声称界面测试通过。',
];
let threadId: string | undefined, turnId: string | undefined, starts = 0, turnStarts = 0, completed = false;
let pending: Approval | undefined;
const testThreads: string[] = [], nativeTurns: { request: Record<string, unknown>; actual?: NativeSessionSettings; status?: string }[] = [];
evidence.nativeTurns = nativeTurns;
function observeNative() {
  const nativeRequest = codex.request.bind(codex);
  codex.request = async <T>(method: string, params: object): Promise<T> => {
    if (method === 'thread/start') { assert.ok(starts++ < 2, 'Only two disposable test threads'); assert.equal((params as { cwd?: string }).cwd, cwd); }
    if (method === 'turn/start') {
      const p = params as { threadId: string; input: { type: string; text?: string }[] };
      assert.ok(turnStarts < 5, 'Exactly five bounded native turns'); assert.equal(p.threadId, threadId);
      assert.deepEqual(p.input.map(i => ({ type: i.type, text: i.text })), [{ type: 'text', text: prompts[turnStarts] }]);
      nativeTurns.push({ request: { ...params, input: '[bounded acceptance prompt]' } }); turnStarts++; completed = false;
      console.log(`Native turn ${turnStarts}/5 requested`);
    }
    const result = await nativeRequest<T>(method, params);
    if (method === 'thread/start') { const id = (result as { thread: Thread }).thread.id; testThreads.push(id); threadId ??= id; }
    if (method === 'turn/start') turnId = (result as { turn: { id: string } }).turn.id;
    return result;
  };
  codex.on('message', message => {
    if (message.method === 'turn/completed' && message.params.threadId === threadId) {
      completed = true; evidence.turnStatus = message.params.turn.status;
      if (nativeTurns.length) nativeTurns.at(-1)!.status = message.params.turn.status;
      console.log(`Native turn ${turnStarts}/5 ${message.params.turn.status}`);
    }
    if (message.method === 'item/started' && message.params.threadId === threadId) {
      const permitted = turnStarts === 5 ? ['userMessage', 'agentMessage', 'reasoning', 'commandExecution'] : ['userMessage', 'agentMessage', 'reasoning'];
      if (!permitted.includes(message.params.item.type)) errors.push(`Unexpected native item: ${message.params.item.type}`);
    }
  });
  service.on('event', (event: BridgeEvent) => { if (event.type === 'approval') pending = event.request; });
}
observeNative();
const adbArgs = process.env.ORACULUM_ADB_SERIAL ? ['-s', process.env.ORACULUM_ADB_SERIAL] : ['-d'];
const adb = (...args: string[]) => execFileSync('adb', [...adbArgs, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim();
let server: Awaited<ReturnType<typeof createServer>> | undefined, app: ElectronApplication | undefined, android: Browser | undefined;
let desktop: Page | undefined, phone: Page | undefined, forwarded: string | undefined, previousReverse: string | undefined, reverseChanged = false;
let savedCookies: Cookie[] | undefined, savedStorage: { local: Record<string, string>; session: Record<string, string> } | undefined;
const ready = (page: Page) => expect(page.locator('.connection-status')).toContainText('状态已查询', { timeout: 30_000 });
async function attach() {
  await android?.close(); const pid = adb('shell', 'pidof', 'dev.oraculum.poc'); assert.match(pid, /^\d+$/);
  if (forwarded) adb('forward', `tcp:${forwarded}`, `localabstract:webview_devtools_remote_${pid}`);
  else forwarded = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
  await expect.poll(async () => { try { return (await fetch(`http://127.0.0.1:${forwarded}/json/list`).then(r => r.json())).length; } catch { return 0; } }, { timeout: 20_000 }).toBeGreaterThan(0);
  android = await chromium.connectOverCDP(`http://127.0.0.1:${forwarded}`, { noDefaults: true });
  phone = android.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith(origin) || p.url().startsWith('chrome-error://'));
  assert.ok(phone, 'Debug WebView must already use the local USB endpoint'); phone.on('pageerror', error => errors.push(error.message));
}
async function pair(page: Page, label: string) {
  await expect(page.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible();
  await page.getByLabel('设备名称', { exact: true }).fill(label); await page.getByLabel('配对码', { exact: true }).fill(trust.createPairing().code);
  await page.getByRole('button', { name: '配对并连接', exact: true }).click(); await ready(page);
}
async function hideIme() { if (/\bmInputShown=true\b/.test(adb('shell', 'dumpsys', 'input_method'))) adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); }
async function nav(page: Page) {
  if (await page.getByRole('button', { name: '打开导航', exact: true }).isVisible() && !await page.locator('.app-shell').evaluate(el => el.classList.contains('drawer-open'))) await page.getByRole('button', { name: '打开导航', exact: true }).click();
}
async function theme(page: Page, id: string) {
  if (page === phone) await hideIme(); await nav(page); await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('当前主题')).toBeEnabled(); await page.getByLabel('当前主题').selectOption(id);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme-id', id); await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  if (await page.locator('.app-shell').evaluate(el => el.classList.contains('drawer-open'))) await page.getByRole('button', { name: '折叠导航', exact: true }).click();
}
async function cards(page: Page) {
  await expect(page.locator('.message.user .message-name')).toHaveText(Array(5).fill('你')); await expect(page.locator('.agent-message .message-name').last()).toHaveText('Codex');
  const geometry = await page.locator('.message').evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    return { avatar: !!node.querySelector('.message-avatar'), border: parseFloat(style.borderTopWidth), left: rect.left, right: rect.right, viewport: innerWidth };
  }));
  evidence.cardGeometry = geometry;
  // CSS borders can resolve to fractional pixels on a scaled Android display.
  assert.ok(geometry.every(g => g.avatar && g.border > 0 && g.left >= 0 && g.right <= g.viewport + 1), JSON.stringify(geometry));
  const user = await page.locator('.message.user').first().boundingBox(), assistant = await page.locator('.agent-message').last().boundingBox();
  assert.ok(user && assistant && Math.abs(user.x - assistant.x) <= 1 && Math.abs(user.width - assistant.width) <= 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await expect(page.locator('.agent-message .code-block pre').first()).toBeVisible();
  await expect(page.getByText(/会话信息与原生事件|最近发送回执|原生事件 · 最近|部分历史未能恢复|下一轮继承|模型 \/ 思考强度继承/)).toHaveCount(0);
}
async function capture(page: Page, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.screenshot({ path: join(output, name + '.png'), animations: 'disabled', scale: 'css' });
  if (page === phone) await writeFile(join(output, name + '-device.png'), execFileSync('adb', [...adbArgs, 'exec-out', 'screencap', '-p'], { maxBuffer: 16 * 1024 * 1024 }));
}
let step = 'setup';
try {
  await codex.initialize(); for (const id of ['test-violet', 'hong-kong-rain', 'minimal-light']) await themes.install(id);
  server = await createServer(service, port, resolve('apps/web/dist'), { trust, themes }); await server.listen({ host: '127.0.0.1', port });
  const require = createRequire(resolve('apps/desktop/package.json'));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron-profile') });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  await expect.poll(() => app!.windows().some(p => p.url().startsWith(origin))).toBe(true);
  desktop = app.windows().find(p => p.url().startsWith(origin))!; desktop.on('pageerror', error => errors.push(error.message)); await pair(desktop, '4D.3 Electron');
  previousReverse = adb('reverse', '--list').split('\n').find(line => line.split(/\s+/)[1] === `tcp:${port}`)?.split(/\s+/)[2];
  adb('reverse', `tcp:${port}`, `tcp:${port}`); reverseChanged = true; adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'); adb('shell', 'am', 'start', '-n', 'dev.oraculum.poc/.MainActivity'); await attach();
  savedCookies = (await phone!.context().cookies([origin])).filter(c => c.name === 'oraculum_local' && c.path === '/');
  // Quiesce first so app/pagehide handlers cannot race the private backup.
  await phone!.goto(origin + '/auth/session'); savedStorage = await phone!.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  await writeFile(join(output, 'private-device-backup.json'), JSON.stringify({ cookies: savedCookies, storage: savedStorage }), { mode: 0o600 });
  await phone!.context().clearCookies({ name: 'oraculum_local', domain: '127.0.0.1', path: '/' }); await phone!.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await phone!.goto(origin); await pair(phone!, '4D.3 Android Debug'); await hideIme();
  evidence.android = { manufacturer: adb('shell', 'getprop', 'ro.product.manufacturer'), model: adb('shell', 'getprop', 'ro.product.model'), release: adb('shell', 'getprop', 'ro.build.version.release'), viewport: await phone!.evaluate(() => ({ width: innerWidth, height: innerHeight })) };
  step = 'native initial settings'; await desktop.locator('.new-session').click();
  await expect.poll(() => threadId, { timeout: 20_000 }).toBeTruthy();
  await expect(desktop.locator('.conversation')).toHaveAttribute('data-thread-id', threadId!); await ready(desktop);
  const initial = (await sessionSnapshot(desktop)).settings!;
  assert.ok(initial.model, 'Thread start must expose native model'); evidence.initial = initial;
  const catalog = (await service.dispatch('model/list', {}) as { data: Model[] }).data;
  const alternatives = catalog.filter(m => m.model !== initial.model && m.supportedReasoningEfforts.some(e => e.reasoningEffort === 'low'));
  assert.ok(alternatives.length, 'Native catalog must expose another selectable model');
  const second = alternatives[0]!;
  const fourth = catalog.find(m => m.model !== second.model && m.model !== initial.model && m.supportedReasoningEfforts.some(e => e.reasoningEffort === 'medium'))
    ?? catalog.find(m => m.model === initial.model)!;
  const fourthEffort = fourth.supportedReasoningEfforts.find(e => e.reasoningEffort === 'medium')?.reasoningEffort ?? fourth.defaultReasoningEffort;
  evidence.sequence = { initial: initial.model, second: second.model, fourth: fourth.model, fourthEffort };
  async function values(page: Page, model: string, effort?: string) {
    await modelTrigger(page).click();
    const dialog = page.getByRole('dialog', { name: '模型与思考强度', exact: true });
    await expect(dialog.getByRole('radiogroup', { name: '模型', exact: true }).locator(`[role="radio"][data-value=${JSON.stringify(model)}]`)).toHaveAttribute('aria-checked', 'true');
    if (effort) await expect(dialog.getByRole('radiogroup', { name: '思考强度', exact: true }).locator(`[role="radio"][data-value=${JSON.stringify(effort)}]`)).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
  }
  async function choose(page: Page, model: string, effort: string, permission: 'read-only' | 'auto' | 'full-access') {
    if (page === phone) await hideIme();
    await selectModel(page, model); await selectEffort(page, effort); await selectPermission(page, permission);
  }
  async function send(page: Page, index: number) {
    await page.getByLabel('消息', { exact: true }).fill(prompts[index]!); await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => turnStarts).toBe(index + 1);
  }
  async function finished(index: number, model?: string, effort?: string, sandbox?: string) {
    await expect.poll(() => completed, { timeout: 180_000, intervals: [1000] }).toBe(true);
    assert.equal(nativeTurns[index]!.status, 'completed'); assert.deepEqual(errors, []);
    const actual = (await sessionSnapshot(desktop!)).settings!; nativeTurns[index]!.actual = actual;
    if (model) assert.equal(actual.model, model); if (effort) assert.equal(actual.effort, effort); if (sandbox) assert.equal(actual.sandbox.type, sandbox);
    for (const page of [desktop!, phone!]) { await page.reload(); await ready(page); await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', threadId!); await values(page, actual.model!, effort); }
  }
  await values(desktop, initial.model!);
  await send(desktop, 0); await finished(0, initial.model);
  // Choose once, survive refresh before sending, then send from the chosen client.
  step = 'second turn changes all three controls'; await choose(phone!, second.model, 'low', 'auto');
  await phone!.reload(); await ready(phone!); await values(phone!, second.model, 'low');
  await send(phone!, 1); await finished(1, second.model, 'low', 'workspaceWrite');
  step = 'thread switch and sticky third turn';
  await desktop.locator('.new-session').click();
  await expect.poll(() => testThreads.length, { timeout: 20_000 }).toBe(2);
  const spareId = testThreads[1]!; assert.ok(spareId && spareId !== threadId);
  await expect(desktop.locator('.conversation')).toHaveAttribute('data-thread-id', spareId); await ready(desktop);
  const spare = (await sessionSnapshot(desktop)).settings!; assert.equal(spare.model, initial.model);
  await codex.request('thread/name/set', { threadId, name: '从容对话 · Composer' });
  await desktop.getByRole('button', { name: '刷新列表', exact: true }).click();
  await desktop.locator('.session-link').filter({ hasText: '从容对话 · Composer' }).click(); await ready(desktop);
  await values(desktop, second.model, 'low'); await send(desktop, 2); await finished(2, second.model, 'low', 'workspaceWrite');
  assert.equal(nativeTurns[2]!.request.model, undefined); assert.equal(nativeTurns[2]!.request.effort, undefined); assert.equal(nativeTurns[2]!.request.sandboxPolicy, undefined);
  step = 'fourth turn changes model effort and permission'; await choose(desktop, fourth.model, fourthEffort, 'read-only');
  await send(desktop, 3); await finished(3, fourth.model, fourthEffort, 'readOnly');
  step = 'fifth turn keeps settings and exercises native approval'; await send(phone!, 4);
  const approvals: unknown[] = []; evidence.approvals = approvals;
  for (const [marker, button, decision] of [['ORACULUM_PATCH_ALLOW', '允许本次', 'accept'], ['ORACULUM_PATCH_DECLINE', '拒绝', 'decline']] as const) {
    await expect.poll(() => pending?.method === 'item/commandExecution/requestApproval' ? pending.params.command : '', { timeout: 180_000 }).toContain(marker);
    const request = pending!; assert.equal(request.method, 'item/commandExecution/requestApproval');
    if (request.method !== 'item/commandExecution/requestApproval') throw new Error('Unexpected native approval');
    assert.ok([`printf ${marker}`, `/bin/bash -lc 'printf ${marker}'`, `/bin/bash -lc "printf ${marker}"`, `/bin/sh -lc 'printf ${marker}'`].includes(request.params.command!));
    if (decision === 'accept') { await phone!.reload(); await ready(phone!); }
    for (const page of [desktop, phone!]) await expect(page.getByRole('heading', { name: '需要审批', exact: true })).toBeVisible();
    await phone!.getByRole('button', { name: button, exact: true }).click(); pending = undefined;
    await expect(desktop.locator('.approval')).toHaveCount(0); approvals.push({ command: request.params.command, decision });
  }
  await finished(4, fourth.model, fourthEffort, 'readOnly');
  assert.equal(nativeTurns[4]!.request.model, undefined); assert.equal(nativeTurns[4]!.request.effort, undefined); assert.equal(nativeTurns[4]!.request.sandboxPolicy, undefined);
  checks.push('Five real completed turns: actual initial config; changes on turns 2/4; omitted overrides persist on 3/5; reload, thread switch, Android/Electron readback; two native allow/decline approvals');
  console.log('Five native turns and approvals passed; checking restart and actual client interactions');
  step = 'source Bridge and native App Server restart';
  // Empty scratch threads have no rollout; finish their lifecycle before restart.
  for (const id of testThreads.filter(id => id !== threadId)) {
    await service.dispatch('thread/delete', { threadId: id, confirm: true });
    testThreads.splice(testThreads.indexOf(id), 1);
  }
  const beforeRestart = (await sessionSnapshot(desktop)).settings!;
  await server.close(); await codex.close(); codex = new Codex(cwd);
  service = new BridgeService(codex, cwd, receipts, projects, permissionStore); observeNative(); await codex.initialize();
  server = await createServer(service, port, resolve('apps/web/dist'), { trust, themes }); await server.listen({ host: '127.0.0.1', port });
  for (const page of [desktop, phone!]) { await page.reload(); await ready(page); await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', threadId!); await values(page, fourth.model, fourthEffort); }
  const afterRestart = (await sessionSnapshot(desktop)).settings!; assert.deepEqual(afterRestart, beforeRestart);
  evidence.restart = { before: beforeRestart, after: afterRestart, noAdditionalTurn: turnStarts === 5 };
  checks.push('Isolated source Bridge/App Server restart: native model and effort persist; confirmed user permission reapplied on first resume and read back; no extra turn');
  step = 'cards and themes';
  for (const id of ['oracle-eye', 'test-violet', 'hong-kong-rain', 'minimal-light']) for (const page of [desktop, phone!]) {
    step = `cards and themes: ${id}, ${page === phone ? 'Android' : 'Electron'}`;
    await theme(page, id); await cards(page); await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', threadId!);
  }
  checks.push('both role headers, avatars, equal left alignment/width, Markdown/code and no document overflow in four themes on both actual clients');
  await theme(desktop, 'oracle-eye'); await desktop.locator('.conversation-scroll').evaluate(el => { el.scrollTop = 0; }); await capture(desktop, 'electron-cards');
  await theme(phone!, 'oracle-eye'); await phone!.locator('.conversation-scroll').evaluate(el => { el.scrollTop = 0; }); await capture(phone!, 'android-cards');
  step = 'real device composer menus';
  for (const page of [desktop, phone!]) {
    await page.getByRole('button', { name: '更多操作', exact: true }).click();
    const tray = page.getByRole('dialog', { name: '更多操作', exact: true });
    await expect(tray).toBeVisible(); assert.equal(await tray.textContent(), ''); assert.equal(await tray.locator('*').count(), 0);
    if (page === phone) { await capture(page, 'android-empty-tray'); adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); }
    else await page.keyboard.press('Escape');
    await expect(tray).toHaveCount(0);
    await modelTrigger(page).click(); await capture(page, page === phone ? 'android-model-menu' : 'electron-model-menu'); await page.keyboard.press('Escape');
    await permissionTrigger(page).click(); await capture(page, page === phone ? 'android-permission-menu' : 'electron-permission-menu');
    if (page === phone) adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); else await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '权限', exact: true })).toHaveCount(0);
  }
  checks.push('Real desktop/Android compact menus; completely empty plus tray; Android system Back closes each popup');
  step = 'Android keyboard, touch and draft';
  const viewportBefore = await phone!.evaluate(() => visualViewport!.height); await phone!.getByLabel('消息', { exact: true }).click();
  await expect.poll(() => /\bmInputShown=true\b/.test(adb('shell', 'dumpsys', 'input_method')), { timeout: 15_000 }).toBe(true);
  adb('shell', 'input', 'text', 'Oraculum%scard%sdraft');
  // The user's active Chinese IME may convert Latin keystrokes. First Enter
  // commits composition; a second Enter inserts a newline without sending.
  adb('shell', 'input', 'keyevent', 'KEYCODE_ENTER'); adb('shell', 'input', 'keyevent', 'KEYCODE_ENTER');
  await expect(phone!.getByLabel('消息', { exact: true })).toHaveValue(/.+\n$/s);
  const nativeDraft = await phone!.getByLabel('消息', { exact: true }).inputValue();
  const viewportIme = await phone!.evaluate(() => visualViewport!.height); assert.ok(viewportIme < viewportBefore);
  const sendBounds = await phone!.getByRole('button', { name: '发送', exact: true }).boundingBox(); assert.ok(sendBounds && sendBounds.y + sendBounds.height <= viewportIme + 2);
  await capture(phone!, 'android-ime'); await hideIme(); await phone!.reload(); await ready(phone!);
  await expect(phone!.getByLabel('消息', { exact: true })).toHaveValue(nativeDraft); await phone!.getByLabel('消息', { exact: true }).fill(''); await hideIme();
  const scroll = phone!.locator('.conversation-scroll'); await scroll.evaluate(el => { el.scrollTop = 0; });
  const bounds = await scroll.boundingBox(); assert.ok(bounds); const size = adb('shell', 'wm', 'size').match(/(\d+)x(\d+)/); assert.ok(size);
  const ratio = +size[1] / await phone!.evaluate(() => innerWidth), x = Math.round((bounds.x + bounds.width / 2) * ratio);
  // Native touch coordinates include the status bar above the WebView.
  const statusBar = Math.max(0, +size[2] - await phone!.evaluate(() => innerHeight) * ratio) / 2;
  adb('shell', 'input', 'swipe', String(x), String(Math.round((bounds.y + bounds.height * .8) * ratio + statusBar)), String(x), String(Math.round((bounds.y + bounds.height * .25) * ratio + statusBar)), '450');
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(20);
  const reading = await scroll.evaluate(el => el.scrollTop); await phone!.reload(); await ready(phone!);
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(10);
  evidence.ime = { kind: 'actual active Android IME, injected Latin keystrokes, composition commit then native Enter; no manual candidate selection', convertedToChinese: /[\u3400-\u9fff]/.test(nativeDraft), viewportBefore, viewportIme };
  evidence.reading = { nativeSwipeScrollTop: reading, restoredScrollTop: await scroll.evaluate(el => el.scrollTop) };
  checks.push('Android native IME commit/Enter keeps composer visible; draft survives reload without send; native touch scroll and reading restore');
  step = 'native theme recovery'; await theme(desktop, 'test-violet');
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('restore-default-theme')!.click()); await ready(desktop);
  await expect(desktop.locator('.app-shell')).toHaveAttribute('data-theme-id', 'oracle-eye');
  await theme(phone!, 'test-violet'); adb('shell', 'input', 'keyevent', '--longpress', 'KEYCODE_VOLUME_UP');
  adb('shell', 'uiautomator', 'dump', '/sdcard/oraculum-composer-window.xml'); const xml = adb('exec-out', 'cat', '/sdcard/oraculum-composer-window.xml');
  const node = xml.match(/<node[^>]*text="恢复默认主题"[^>]*resource-id="android:id\/button1"[^>]*>/)?.[0];
  const button = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/); assert.ok(button, 'Android native recovery dialog');
  adb('shell', 'input', 'tap', String((+button[1] + +button[3]) / 2), String((+button[2] + +button[4]) / 2)); await attach(); await ready(phone!);
  await expect(phone!.locator('.app-shell')).toHaveAttribute('data-theme-id', 'oracle-eye'); await expect(phone!.locator('.conversation')).toHaveAttribute('data-thread-id', threadId!);
  assert.equal(turnStarts, 5); assert.deepEqual(errors, []); checks.push('Electron native menu and Android native long-volume dialog recover Oracle Eye without replay or thread change');
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed'; evidence.step = step; evidence.error = String(error); process.exitCode = 1;
  if (desktop) await capture(desktop, 'failure-electron').catch(() => {}); if (phone && savedStorage) await capture(phone, 'failure-android').catch(() => {});
} finally {
  const clean = async (label: string, run: () => unknown | Promise<unknown>) => { try { await run(); } catch (error) { cleanupErrors.push(`${label}: ${String(error)}`); evidence.result = 'failed'; process.exitCode = 1; } };
  await clean('test native thread', async () => {
    if (!threadId) return;
    if (turnId && !completed) { await codex.request('turn/interrupt', { threadId, turnId }); await expect.poll(() => completed, { timeout: 20_000 }).toBe(true); }
    for (const id of testThreads) { await service.dispatch('thread/delete', { threadId: id, confirm: true }); await assert.rejects(codex.request('thread/read', { threadId: id }), /not loaded|not found|no rollout/i); } evidence.testThreadsDeleted = true;
  });
  await clean('Electron', () => app?.close());
  if (phone && savedStorage) await clean('Android storage', async () => {
    await phone!.goto(origin + '/auth/session'); await phone!.evaluate(saved => { localStorage.clear(); sessionStorage.clear(); for (const [k, v] of Object.entries(saved.local)) localStorage.setItem(k, v); for (const [k, v] of Object.entries(saved.session)) sessionStorage.setItem(k, v); }, savedStorage!);
    assert.deepEqual(await phone!.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })), savedStorage); evidence.storageRestored = true;
  });
  if (phone && savedCookies) await clean('Android cookies', async () => {
    await phone!.context().clearCookies({ name: 'oraculum_local', domain: '127.0.0.1', path: '/' }); await phone!.context().addCookies(savedCookies!);
    assert.deepEqual((await phone!.context().cookies([origin])).filter(c => c.name === 'oraculum_local' && c.path === '/'), savedCookies); evidence.cookiesRestored = true;
  });
  if (reverseChanged) await clean('Android background', () => adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'));
  if (phone && savedStorage) await clean('Android storage after background', async () => { assert.deepEqual(await phone!.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })), savedStorage); });
  await clean('CDP', () => android?.close()); await clean('Bridge', () => server?.close()); await clean('Codex', () => codex.close()); await clean('trust', () => trust.close());
  if (reverseChanged) await clean('ADB reverse', () => previousReverse ? adb('reverse', `tcp:${port}`, previousReverse) : adb('reverse', '--remove', `tcp:${port}`));
  if (forwarded) await clean('ADB forward', () => adb('forward', '--remove', `tcp:${forwarded}`));
  if (reverseChanged) await clean('native UI dump', () => adb('shell', 'rm', '-f', '/sdcard/oraculum-composer-window.xml'));
  await clean('config unchanged', async () => { evidence.globalConfigUnchanged = await hashConfig() === baselineConfig; assert.equal(evidence.globalConfigUnchanged, true); });
  evidence.productionBridgeStopped = productionStopped(); if (!evidence.productionBridgeStopped) { cleanupErrors.push('Production Bridge is not stopped'); evidence.result = 'failed'; process.exitCode = 1; }
  if (!cleanupErrors.length) { await rm(join(output, 'private-device-backup.json'), { force: true }); await clean('isolated fixture', () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })); }
  evidence.turnsStarted = turnStarts; await writeFile(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 }); console.log(JSON.stringify({ output, ...evidence }));
}
