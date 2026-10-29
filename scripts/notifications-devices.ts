// Real Electron + Android Debug hardware, authenticated isolated Bridge.
// Native protocol events are controlled fixtures, not claims of model execution.
import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import { TrustStore } from '../bridge/src/trust-store';
import { ReceiptStore } from '../bridge/src/receipts';
import { ProjectDirectories } from '../bridge/src/projects';

const port = 17907, origin = `http://127.0.0.1:${port}`, pkg = 'dev.oraculum.poc.debug';
const skipScreenshots = process.env.ORACULUM_SKIP_SCREENSHOTS === '1';
await mkdir('.local/evidence/r1-b7', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/r1-b7/run-'));
const root = join(output, 'Projects'), cwd = join(root, '通知与恢复验收'); await mkdir(cwd, { recursive: true });
const adbArgs = process.env.ORACULUM_ADB_SERIAL ? ['-s', process.env.ORACULUM_ADB_SERIAL] : ['-d'];
const adb = (...args: string[]) => execFileSync('adb', [...adbArgs, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
const originalPackage = adb('shell', 'pm', 'path', 'dev.oraculum.poc');
const originalHash = adb('shell', 'sha256sum', originalPackage.replace('package:', ''));
const previousReverse = adb('reverse', '--list').split('\n').find(line => line.split(/\s+/)[1] === `tcp:${port}`)?.split(/\s+/)[2];
const trust = new TrustStore(join(output, 'state')), projects = new ProjectDirectories(root, cwd, trust.db); await projects.register(cwd);
const receipt = new ReceiptStore(trust.db), bus = new EventEmitter();
const turns: any[] = Array.from({ length: 14 }, (_, index) => ({ id: 'history-' + index, status: 'completed', itemsView: 'full', error: null,
  items: [{ id: 'u' + index, type: 'userMessage', content: [{ type: 'text', text: `受控验收记录 ${index + 1}：核对通知与阅读位置。` }] },
    { id: 'a' + index, type: 'agentMessage', text: '这是受控协议事件场景，用于验证真实系统通知、跨端状态与快速恢复。\n\n主机任务状态与审批继续以 Codex 为准。', phase: 'final_answer' }] }));
const parent: any = { id: 'b7-parent', name: '通知与恢复 · 受控事件', preview: 'B7 实机验收', cwd, parentThreadId: null, source: 'appServer', ephemeral: false, status: { type: 'idle' }, turns };
const other = { ...parent, id: 'b7-other', name: '另一会话 · 草稿保留', turns: [] };
const threads = new Map([[parent.id, parent], [other.id, other]]);
const settings = { approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: [] }, approvalsReviewer: 'user', model: 'fixture', reasoningEffort: 'low' };
const calls: string[] = [], replies: any[] = [], checks: string[] = [], screenshots: string[] = [], errors: string[] = [];
const codex = { on: bus.on.bind(bus), send: (reply: any) => { replies.push(reply); }, request: async <T>(method: string, params: any): Promise<T> => {
  calls.push(method); const thread = threads.get(params.threadId); let value: any;
  if (method === 'config/read') value = { config: { model: 'fixture', model_reasoning_effort: 'low', model_provider: 'fixture', approval_policy: 'on-request', sandbox_mode: 'workspace-write', approvals_reviewer: 'user' } };
  else if (method === 'model/list') value = { data: [{ id: 'fixture', model: 'fixture', displayName: 'Codex · 受控事件验收', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null };
  else if (method === 'account/rateLimits/read') value = { rateLimits: null };
  else if (method === 'thread/list') value = { data: params.archived ? [] : [...threads.values()], nextCursor: null };
  else if (method === 'thread/read') value = { thread };
  else if (method === 'thread/resume') value = { thread, ...settings };
  else if (method === 'thread/turns/list') value = { data: [...thread.turns].reverse(), nextCursor: null };
  else if (method === 'thread/items/list') value = { data: thread.turns.filter((turn: any) => turn.id === params.turnId).flatMap((turn: any) => turn.items.map((item: any) => ({ turnId: turn.id, item }))), nextCursor: null };
  else throw new Error('Unexpected fixture method: ' + method);
  return structuredClone(value) as T;
} };
const service = new BridgeService(codex, cwd, receipt, projects);
const server = await createServer(service, port, resolve('apps/web/dist'), { trust });
let offline = false, authOffline = false;
server.addHook('onRequest', async (request, reply) => { if (offline || authOffline && request.url === '/auth/session') return reply.code(503).send({ error: 'Controlled transport outage' }); });
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((x): x is [string, string] => x[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron-profile') });
let app: ElectronApplication | undefined, android: Browser | undefined, phone: Page | undefined, desktop: Page | undefined, forward = '';
let failure: string | undefined;
const monitor = spawn('dbus-monitor', ['--session', "interface='org.freedesktop.Notifications',member='Notify'"], { stdio: ['ignore', 'pipe', 'ignore'] });
let notificationBus = '', monitorLine = '';
monitor.stdout.setEncoding('utf8');
monitor.stdout.on('data', value => {
  monitorLine += value;
  const lines = monitorLine.split('\n'); monitorLine = lines.pop()!;
  for (const line of lines) if (line.startsWith('method call time=') || line.includes('string "神谕 ·')) notificationBus += line + '\n';
});
const ready = async (page: Page) => { await expect(page.locator('.connection-status')).toContainText('状态已查询', { timeout: 20000 }); };
async function pair(page: Page, name: string) {
  await page.getByLabel('设备名称', { exact: true }).fill(name); await page.getByLabel('配对码', { exact: true }).fill(trust.createPairing().code);
  await page.getByRole('button', { name: '配对并连接', exact: true }).click(); await ready(page);
}
function ownNotifications() {
  const dump = adb('shell', 'dumpsys', 'notification', '--noredact');
  return dump.split(/(?=NotificationRecord\()/).filter(block => block.startsWith('NotificationRecord(') && block.split('\n')[0].includes(`pkg=${pkg}`)).join('\n');
}
const hasNotice = (title: string) => ownNotifications().includes('android.title=String (神谕 · ' + title + ')');
function emit(method: string, params: object) { bus.emit('message', { method, params: { threadId: parent.id, ...params } }); }
function begin(id: string) {
  const turn = { id, status: 'inProgress', items: [], itemsView: 'full', error: null };
  parent.turns.push(turn); parent.status = { type: 'active', activeFlags: [] }; emit('turn/started', { turn }); return turn;
}
async function finish(id: string, status = 'completed') {
  const turn = begin(id); turn.status = status; parent.status = { type: 'idle' }; emit('turn/completed', { turn });
  return (await service.notificationFeed()).notices[0].id;
}
async function capturePhone(name: string) {
  if (skipScreenshots) return;
  const path = join(output, name + '.png'); await writeFile(path, execFileSync('adb', [...adbArgs, 'exec-out', 'screencap', '-p'], { maxBuffer: 16 * 1024 * 1024 })); screenshots.push(path);
}
async function captureShade(name: string) {
  if (skipScreenshots) return;
  adb('shell', 'cmd', 'statusbar', 'expand-notifications');
  await new Promise(resolve => setTimeout(resolve, 900)); await capturePhone(name);
  adb('shell', 'cmd', 'statusbar', 'collapse');
}
async function captureDesktop(name: string) {
  if (skipScreenshots) return;
  const path = join(output, name + '.png');
  expect(execFileSync('gdbus', ['call', '--session', '--dest', 'org.gnome.ScreenSaver', '--object-path', '/org/gnome/ScreenSaver', '--method', 'org.gnome.ScreenSaver.GetActive'], { encoding: 'utf8' })).toContain('false');
  if (process.env.ORACULUM_GNOME_CAPTURE) {
    execFileSync('python3', [process.env.ORACULUM_GNOME_CAPTURE, path]);
    await app!.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http:'));
      if (win?.isMinimized()) win.restore(); win?.show(); win?.focus();
    });
  }
  else throw new Error('Set ORACULUM_GNOME_CAPTURE to the local GNOME Shift+Print capture helper');
  screenshots.push(path);
}
async function backgroundDesktop() {
  if (skipScreenshots) return;
  if (!process.env.ORACULUM_GNOME_CAPTURE) throw new Error('GNOME capture helper required');
  execFileSync('python3', [process.env.ORACULUM_GNOME_CAPTURE, '--show-desktop']);
  // Let an earlier screenshot banner expire before creating the new task notice.
  await new Promise(resolve => setTimeout(resolve, 6500));
}
try {
  await server.listen({ host: '127.0.0.1', port });
  adb('reverse', `tcp:${port}`, `tcp:${port}`);
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  adb('shell', 'am', 'start', '-n', `${pkg}/dev.oraculum.poc.MainActivity`);
  await expect.poll(() => { try { return adb('shell', 'pidof', pkg); } catch { return ''; } }, { timeout: 15000 }).toMatch(/^\d+$/);
  await expect.poll(async () => {
    try {
      const pid = adb('shell', 'pidof', pkg); forward = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
      android = await chromium.connectOverCDP(`http://127.0.0.1:${forward}`, { noDefaults: true, timeout: 2000 }); return true;
    } catch { if (forward) adb('forward', '--remove', `tcp:${forward}`); forward = ''; return false; }
  }, { timeout: 15000 }).toBe(true);
  await expect.poll(() => android!.contexts().flatMap(c => c.pages()).length).toBeGreaterThan(0);
  phone = android!.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith(origin) || p.url().startsWith('chrome-error://'));
  if (!phone) throw new Error('Debug APK must use -PoraculumDebugPort=17907; refusing another entry');
  phone.on('pageerror', error => errors.push(error.message));
  // Permission belongs only to our isolated Debug package, equivalent to granting
  // the displayed OS permission prompt. Existing package permissions are untouched.
  adb('shell', 'pm', 'grant', pkg, 'android.permission.POST_NOTIFICATIONS');
  await phone.goto(origin + '/'); await pair(phone, 'B7 Android Debug');
  if (/\bmInputShown=true\b/.test(adb('shell', 'dumpsys input_method | grep mInputShown='))) adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  await expect.poll(async () => (await app!.windows()).some(p => p.url().startsWith(origin)), { timeout: 15000 }).toBe(true);
  desktop = (await app.windows()).find(p => p.url().startsWith(origin))!;
  await pair(desktop, 'B7 Ubuntu Electron'); desktop.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http:')); win?.maximize(); win?.focus(); });
  for (const page of [desktop, phone]) await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', parent.id);
  await expect.poll(() => ownNotifications()).toContain('神谕 · 后台任务提醒');
  checks.push('Android 15 Debug package isolated; real native foreground service started after pairing');

  await backgroundDesktop();
  const completedId = await finish('foreground-completion');
  await expect.poll(() => hasNotice('任务已完成')).toBe(true);
  await expect.poll(() => notificationBus).toContain('神谕 · 任务已完成');
  await captureShade('01-android-foreground-completed'); await captureDesktop('02-ubuntu-system-completed');
  checks.push('Foreground Android NotificationManager and Ubuntu org.freedesktop.Notifications received completed event');
  await new Promise(resolve => setTimeout(resolve, 2000));
  const count = (notificationBus.match(/神谕 · 任务已完成/g) ?? []).length;
  emit('turn/completed', { turn: parent.turns.at(-1) });
  await new Promise(resolve => setTimeout(resolve, 4500));
  await writeFile(join(output, 'desktop-notification-bus.txt'), notificationBus.split(/(?=method call time=)/).filter(part => part.includes('神谕 ·')).join('\n'));
  expect((notificationBus.match(/神谕 · 任务已完成/g) ?? []).length).toBe(count);
  checks.push('Duplicate native completion event and repeated feed polls produced one Ubuntu OS post');

  await phone.getByLabel('消息', { exact: true }).fill('手机草稿：返回后继续检查，不自动发送。');
  await phone.locator('.conversation-scroll').evaluate(el => { el.scrollTop = 140; });
  const reading = await phone.locator('.conversation-scroll').evaluate(el => el.scrollTop);
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  expect(adb('shell', 'dumpsys activity activities').split('\n').find(line => line.includes('topResumedActivity'))).toContain('launcher');
  await new Promise(resolve => setTimeout(resolve, 12000));
  await finish('background-failed', 'failed');
  await expect.poll(() => hasNotice('任务执行失败')).toBe(true);
  await capturePhone('03-android-home-background'); await captureShade('04-android-home-background-failed');
  checks.push('After Home + 12 seconds on actual launcher, a fresh failed-event OS notification arrived');

  adb('shell', 'am', 'start', '-n', `${pkg}/dev.oraculum.poc.MainActivity`); await ready(phone);
  await expect(phone.getByLabel('消息', { exact: true })).toHaveValue('手机草稿：返回后继续检查，不自动发送。');
  await expect.poll(async () => Math.abs((await phone!.locator('.conversation-scroll').evaluate(el => el.scrollTop)) - reading)).toBeLessThan(80);
  checks.push('Returning from Home reconciled state and preserved draft and reading position');
  const readCount = calls.filter(method => method === 'thread/read').length;
  offline = true;
  for (const socket of server.websocketServer.clients) socket.terminate();
  await expect(phone.locator('.connection-status')).toContainText('已断开');
  await new Promise(resolve => setTimeout(resolve, 2500));
  offline = false;
  await expect.poll(() => calls.filter(method => method === 'thread/read').length, { timeout: 20000 }).toBeGreaterThan(readCount + 1);
  await ready(phone); await ready(desktop);
  await expect(phone.getByLabel('消息', { exact: true })).toHaveValue('手机草稿：返回后继续检查，不自动发送。');
  expect(calls.filter(method => method === 'turn/start')).toHaveLength(0);
  await capturePhone('08-android-recovered-draft');
  checks.push('Both clients automatically reconciled fresh native reads after socket loss and HTTP 503 outage, without sending or replaying a turn');

  const approvalTurn = begin('approval-turn');
  await backgroundDesktop();
  bus.emit('message', { id: 'approval-b7', method: 'item/commandExecution/requestApproval', params: { threadId: parent.id, turnId: approvalTurn.id, itemId: 'command', command: 'PRIVATE_COMMAND_NEVER_IN_NOTIFICATION' } });
  await expect.poll(() => hasNotice('任务等待审批')).toBe(true);
  await expect(desktop.getByRole('heading', { name: '需要审批', exact: true })).toBeVisible();
  await captureShade('05-android-native-approval'); await captureDesktop('06-ubuntu-system-approval');
  expect(ownNotifications()).not.toContain('PRIVATE_COMMAND_NEVER_IN_NOTIFICATION');
  await desktop.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect.poll(() => hasNotice('任务等待审批')).toBe(false);
  expect(replies.filter(reply => reply.id === 'approval-b7')).toHaveLength(1);
  checks.push('Approval notice used fixed private copy and disappeared after one cross-device native response');

  bus.emit('message', { id: 'input-b7', method: 'item/tool/requestUserInput', params: { threadId: parent.id, turnId: approvalTurn.id, itemId: 'question', isBlocking: true, autoResolutionMs: null,
    questions: [{ id: 'note', header: '验收', question: '受控问题：输入一段尚未提交的答案', isOther: false, isSecret: false, options: null }] } });
  await expect.poll(() => hasNotice('任务等待你的回答')).toBe(true);
  await expect(phone.getByRole('heading', { name: '需要你的输入', exact: true })).toBeVisible();
  await captureShade('07-android-native-question');
  await phone.getByRole('button', { name: '打开导航', exact: true }).click();
  await phone.getByRole('button', { name: /另一会话 · 草稿保留/ }).first().click();
  await expect(phone.locator('.conversation')).toHaveAttribute('data-thread-id', other.id);
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  adb('shell', 'cmd', 'statusbar', 'expand-notifications');
  const hierarchy = `/data/local/tmp/oraculum-b7-notice-${Date.now()}.xml`;
  try {
    adb('shell', 'uiautomator', 'dump', hierarchy);
    const xml = adb('shell', 'cat', hierarchy);
    const node = xml.match(/<node\b[^>]*text="神谕 · 任务等待你的回答"[^>]*>/)?.[0];
    const bounds = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bounds) throw new Error('The actual system notification title is not accessible');
    const [, x1, y1, x2, y2] = bounds.map(Number);
    adb('shell', 'input', 'tap', String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2)));
  } finally { adb('shell', 'rm', hierarchy); }
  await expect.poll(() => adb('shell', 'dumpsys activity activities').split('\n').find(line => line.includes('topResumedActivity'))).toContain(pkg);
  await ready(phone); await expect(phone.locator('.conversation')).toHaveAttribute('data-thread-id', parent.id);
  emit('serverRequest/resolved', { requestId: 'input-b7' }); await expect.poll(() => hasNotice('任务等待你的回答')).toBe(false);
  checks.push('Tapping the real Android system notification from Home reopened its parent conversation from another selected session, without answering automatically');
  await desktop.evaluate(id => { location.hash = 'notice=' + id; }, completedId);
  await expect(desktop.getByRole('alert')).toContainText('已处理或已过期');
  checks.push('Stale notice routing rejected after replacement, with no native mutation');
  threads.delete(parent.id); service.threads.delete(parent.id);
  for (const socket of server.websocketServer.clients) socket.terminate();
  for (const page of [phone, desktop]) {
    await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', other.id, { timeout: 20000 }); await ready(page);
  }
  expect(await phone.evaluate(key => localStorage.getItem(key), `oraculum.draft:${cwd}:${parent.id}`)).toBe('手机草稿：返回后继续检查，不自动发送。');
  checks.push('A selected conversation removed while offline falls back to a current session while retaining its old draft');
  authOffline = true; await phone.reload();
  await expect(phone.getByRole('alert')).toContainText('无法连接 Bridge');
  authOffline = false; await ready(phone);
  checks.push('An already-paired app reopened during an outage automatically leaves the connection gate after recovery');
  expect(errors).toEqual([]);
  expect(adb('shell', 'pm', 'path', 'dev.oraculum.poc')).toBe(originalPackage);
  expect(adb('shell', 'sha256sum', originalPackage.replace('package:', ''))).toBe(originalHash);
  checks.push('Existing installed package APK hash/path and private application data untouched');
} catch (error) { failure = String(error); console.error(failure); process.exitCode = 1; }
finally {
  monitor.kill();
  if (failure && phone) await capturePhone('failure-device').catch(() => {});
  await app?.close(); await android?.close();
  // Cleanup only the dedicated Debug process. No package is removed or cleared.
  adb('shell', 'am', 'force-stop', pkg);
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  if (forward) adb('forward', '--remove', `tcp:${forward}`);
  if (previousReverse) adb('reverse', `tcp:${port}`, previousReverse); else adb('reverse', '--remove', `tcp:${port}`);
  await server.close(); trust.close();
  const ownBus = notificationBus.split(/(?=method call time=)/).filter(part => part.includes('神谕 ·'));
  await writeFile(join(output, 'acceptance.json'), JSON.stringify({ result: failure ? 'failed' : 'passed', failure, checks, screenshots, errors,
    transport: 'Real Ubuntu Electron and HONOR Android 15 over ADB reverse; controlled native protocol events; no model turn',
    desktopNotificationCount: ownBus.length, nativeMutationCalls: calls.filter(m => m === 'turn/start').length }, null, 2));
  console.log(JSON.stringify({ output, failure, checks, screenshots }));
}
