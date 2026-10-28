// Real Ubuntu Electron + Chromium touch viewports, isolated synthetic Codex RPC.
// No user threads, model calls, production services, Android device or ADB.
import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BridgeService } from '../bridge/src/service';
import { ReceiptStore } from '../bridge/src/receipts';
import { NativeRpcError } from '../bridge/src/codex';
import { createServer } from '../bridge/src/server';
import { Themes } from '../bridge/src/themes';
import type { WireMessage } from '../packages/shared/protocol';
import { rateLimits, tokenUsage } from './fixtures/usage';

const cwd = '/session-control-fixture', mainId = 'native-controls';
const history = (prefix: string) => [1, 2, 3].map(index => ({ id: `${prefix}-turn-${index}`, status: 'completed', error: null, itemsView: 'full', items: [
  { id: `${prefix}-user-${index}`, type: 'userMessage', content: [{ type: 'text', text: `第 ${index} 轮：请检查原生会话控制。`, text_elements: [] }] },
  { id: `${prefix}-answer-${index}`, type: 'agentMessage', text: `## 第 ${index} 轮结果\n\n原生会话操作保留清晰的消息、导航和检查器。` },
] }));
const makeThread = (id: string, name: string) => ({ id, name, preview: '隔离的原生会话测试', cwd,
  parentThreadId: null, ephemeral: false, source: 'appServer', model: 'fixture', reasoningEffort: 'low',
  status: { type: 'idle' }, turns: history(id) });
// Only this fixture Map is mutated by Fork/Revert/Review. It never reaches Codex.
const threads = new Map<string, any>([
  [mainId, makeThread(mainId, '原生控制 · 主会话')],
  ['unsupported', makeThread('unsupported', '原生控制 · 不支持')],
  ['unknown', makeThread('unknown', '原生控制 · 结果未知')],
]);
const bus = new EventEmitter(), requests: { method: string; params: Record<string, any> }[] = [], replies: WireMessage[] = [];
let forkNumber = 0, turnNumber = 0;
let unsupportedMethod = '', unknownMethod = '', compactFailure = false;
let heldMethod = '', releaseMutation: (() => void) | undefined;
let holdList = false, releaseList: (() => void) | undefined;
const emit = (threadId: string, method: string, params: object) => bus.emit('message', { method, params: { threadId, ...params } });
const settings = { approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user', model: 'fixture', reasoningEffort: 'low' };
function begin(threadId: string, kind: 'review' | 'compact' | 'turn') {
  const thread = threads.get(threadId)!;
  const turn = { id: `${kind}-${++turnNumber}`, status: 'inProgress', error: null, itemsView: 'full', items: [] as any[] };
  thread.turns.push(turn); thread.status = { type: 'active', activeFlags: [] };
  emit(threadId, 'turn/started', { turn: structuredClone(turn) });
  emit(threadId, 'thread/status/changed', { status: thread.status });
  return turn;
}
function item(threadId: string, turn: any, value: any) {
  turn.items.push(value); emit(threadId, 'item/started', { turnId: turn.id, item: value });
  emit(threadId, 'item/completed', { turnId: turn.id, item: value });
}
function complete(threadId: string, turn: any, failed = false) {
  turn.status = failed ? 'failed' : 'completed';
  turn.error = failed ? { message: '模拟原生整理失败', codexErrorInfo: null, additionalDetails: null } : null;
  threads.get(threadId)!.status = { type: 'idle' };
  emit(threadId, 'turn/completed', { turn: structuredClone(turn) });
  emit(threadId, 'thread/status/changed', { status: { type: 'idle' } });
}
const codex = {
  on: bus.on.bind(bus),
  send: (reply: WireMessage) => {
    replies.push(reply);
    emit(mainId, 'serverRequest/resolved', { requestId: reply.id });
  },
  request: async <T>(method: string, params: Record<string, any>): Promise<T> => {
    requests.push({ method, params: structuredClone(params) });
    const thread = threads.get(String(params.threadId)); let result: unknown;
    if (method === unsupportedMethod) { unsupportedMethod = ''; throw new NativeRpcError('Method not found', -32601); }
    if (method === unknownMethod) { unknownMethod = ''; throw new Error('模拟连接丢失，原生操作结果未知'); }
    if (method === heldMethod) { heldMethod = ''; await new Promise<void>(accept => { releaseMutation = accept; }); }
    if (method === 'config/read') result = { config: { model: 'fixture', model_provider: 'fixture', model_reasoning_effort: 'low', approval_policy: 'on-request', sandbox_mode: 'read-only', approvals_reviewer: 'user' } };
    else if (method === 'model/list') result = { data: [], nextCursor: null };
    else if (method === 'thread/list') {
      result = structuredClone({ data: params.archived ? [] : [...threads.values()], nextCursor: null });
      if (holdList && params.cwd) { holdList = false; await new Promise<void>(accept => { releaseList = accept; }); }
    }
    else if (method === 'thread/read' || method === 'thread/resume') {
      if (!thread) throw new NativeRpcError('Thread not found', -32602);
      result = { thread, ...settings };
    } else if (method === 'thread/turns/list') result = { data: [...thread!.turns].reverse(), nextCursor: null };
    else if (method === 'thread/items/list') result = { data: thread!.turns.find((turn: any) => turn.id === params.turnId).items.map((item: any) => ({ turnId: params.turnId, item })), nextCursor: null };
    else if (method === 'account/rateLimits/read') result = rateLimits;
    else if (method === 'thread/name/set') {
      thread!.name = params.name; emit(thread!.id, 'thread/name/updated', { threadName: params.name }); result = {};
    } else if (method === 'thread/fork') {
      const fork = structuredClone(thread!); fork.id = `fixture-fork-${++forkNumber}`;
      fork.name = `${thread!.name} · 分叉`;
      if (params.lastTurnId) fork.turns = fork.turns.slice(0, fork.turns.findIndex((turn: any) => turn.id === params.lastTurnId) + 1);
      threads.set(fork.id, fork); result = { thread: fork, cwd, ...settings };
    } else if (method === 'thread/revert') {
      const at = thread!.turns.findIndex((turn: any) => turn.id === params.beforeTurnId);
      if (at < 0) throw new NativeRpcError('Unknown turn', -32602);
      thread!.turns = thread!.turns.slice(0, at);
      // Native revert can return no turns. The Bridge must read native pages.
      result = { thread: { ...thread!, turns: [] } };
    } else if (method === 'turn/steer') {
      const active = thread!.turns.find((turn: any) => turn.status === 'inProgress');
      if (active?.id !== params.expectedTurnId) throw new NativeRpcError('Turn is no longer active', -32602);
      item(thread!.id, active, { id: `steer-input-${requests.length}`, type: 'userMessage', content: params.input });
      result = { turnId: active.id };
    } else if (method === 'review/start') {
      const turn = begin(thread!.id, 'review');
      item(thread!.id, turn, { id: `review-enter-${turn.id}`, type: 'enteredReviewMode', review: '正在审阅当前工作区未提交的更改。' });
      result = { turn, reviewThreadId: thread!.id };
    } else if (method === 'thread/compact/start') {
      if (compactFailure) { compactFailure = false; throw new NativeRpcError('模拟原生整理不可用', -32000); }
      begin(thread!.id, 'compact'); result = {};
    } else if (method === 'turn/interrupt') {
      const active = thread!.turns.find((turn: any) => turn.id === params.turnId); active.status = 'interrupted';
      thread!.status = { type: 'idle' }; emit(thread!.id, 'turn/completed', { turn: active }); emit(thread!.id, 'thread/status/changed', { status: thread!.status }); result = {};
    } else if (method === 'turn/start') {
      const turn = begin(thread!.id, 'turn');
      item(thread!.id, turn, { id: 'ordinary-start-input', type: 'userMessage', content: params.input }); result = { turn };
    }
    else throw new Error(`Unexpected fixture RPC: ${method}`);
    return structuredClone(result) as T;
  },
};

await mkdir('.local/evidence/r1-b4/session-controls-ui', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/r1-b4/session-controls-ui/run-'));
const themes = new Themes({ source: resolve('themes'), builtin: resolve('themes'), installed: join(output, 'themes') });
const db = new DatabaseSync(':memory:'), receipts = new ReceiptStore(db);
const service = new BridgeService(codex, cwd, receipts), port = Number(process.env.ORACULUM_SESSION_CONTROLS_UI_PORT ?? '17896');
const origin = `http://127.0.0.1:${port}`;
const makeServer = () => createServer(service, port, resolve('apps/web/dist'), { themes, testOnlyUnauthenticated: true });
let server = await makeServer();
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron-profile') });
let app: ElectronApplication | undefined, browser: Browser | undefined, desktop: Page | undefined, phone: Page | undefined, failure: string | undefined;
const checks: string[] = [], errors: string[] = [];
const record = (check: string) => { checks.push(check); console.log('PASS ' + check); };
const count = (method: string) => requests.filter(request => request.method === method).length;
const ready = (page: Page) => expect(page.locator('.connection-status')).toContainText('状态已查询', { timeout: 15_000 });
const row = (page: Page, id: string) => page.locator(`.session-link[data-thread-id="${id}"]`);
async function nav(page: Page) {
  const open = page.getByRole('button', { name: '打开导航', exact: true });
  if (await open.isVisible() && !await page.locator('.app-shell').evaluate(el => el.classList.contains('drawer-open'))) await open.click();
}
async function select(page: Page, id: string) { await nav(page); await row(page, id).click(); await ready(page); }
async function actions(page: Page, name: string) { await nav(page); await page.getByRole('button', { name: `会话操作：${name}`, exact: true }).click(); }
async function closeActions(page: Page) { await page.getByRole('button', { name: '关闭会话操作', exact: true }).click(); }
async function theme(page: Page, value: string) {
  await nav(page); await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('当前主题')).toBeEnabled(); await page.getByLabel('当前主题').selectOption(value);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme-id', value);
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  if (page === phone) { const close = page.getByRole('button', { name: '折叠导航', exact: true }); if (await close.isVisible()) await close.click(); }
}
async function geometry(page: Page, mobile = false) {
  const box = await page.getByRole('dialog').evaluate(el => {
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight,
      overflow: document.documentElement.scrollWidth > innerWidth,
      buttons: Array.from(el.querySelectorAll('button')).filter(button => button.getBoundingClientRect().height > 0).map(button => {
        const r = button.getBoundingClientRect(); return { height: r.height, hit: button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
      }) };
  });
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(box.width + 1); expect(box.bottom).toBeLessThanOrEqual(box.height + 1); expect(box.overflow).toBe(false);
  for (const button of box.buttons) { expect(button.hit).toBe(true); if (mobile) expect(button.height).toBeGreaterThanOrEqual(44); }
}
const screenshot = (page: Page, name: string) => page.screenshot({ path: join(output, `${name}.png`), scale: 'css' });

try {
  await server.listen({ host: '127.0.0.1', port });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  await expect.poll(() => app!.windows().some(page => page.url().startsWith(origin)), { timeout: 15_000 }).toBe(true);
  desktop = app.windows().find(page => page.url().startsWith(origin))!; desktop.on('pageerror', error => errors.push(error.message));
  await desktop.setViewportSize({ width: 1440, height: 960 }); await ready(desktop);
  browser = await chromium.launch(); phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
    userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36 OraculumAndroid/1' });
  phone.on('pageerror', error => errors.push(error.message)); await phone.goto(origin); await ready(phone);
  const pages: Page[] = [desktop, phone];

  // Assertions are intentionally performed through visible shared UI; native
  // calls below are fixture lifecycle notifications, never a second agent loop.
  emit(mainId, 'thread/tokenUsage/updated', { turnId: `${mainId}-turn-3`, tokenUsage });

  let renamed = '原生控制 · 双端名称';
  await actions(desktop, '原生控制 · 主会话'); await desktop.getByRole('button', { name: '重命名', exact: true }).click();
  await expect(desktop.getByLabel('会话名称', { exact: true })).toHaveValue('原生控制 · 主会话');
  await desktop.getByLabel('会话名称', { exact: true }).fill('   '); await desktop.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(desktop.getByRole('alert')).toContainText('请输入会话名称'); expect(count('thread/name/set')).toBe(0);
  await desktop.getByLabel('会话名称', { exact: true }).fill(renamed); await desktop.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(desktop.getByRole('dialog')).toHaveCount(0); await expect(desktop.locator('.session-title')).toContainText(renamed);
  await nav(phone); await expect(row(phone, mainId)).toContainText(renamed); await row(phone, mainId).click(); await ready(phone);
  await expect(phone.locator('.session-title')).toContainText(renamed);
  record('native rename validates empty names and synchronizes selected titles and navigation across Electron and phone');

  holdList = true; await desktop.getByRole('button', { name: '刷新列表', exact: true }).click();
  await expect.poll(() => !!releaseList).toBe(true);
  await actions(phone, renamed); await phone.getByRole('button', { name: '重命名', exact: true }).click();
  renamed = '原生控制 · 名称保持同步';
  await phone.getByLabel('会话名称', { exact: true }).fill(renamed); await phone.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(phone.getByRole('dialog')).toHaveCount(0); await expect(desktop.locator('.session-title')).toContainText(renamed);
  releaseList!(); releaseList = undefined;
  await expect(row(desktop, mainId)).toContainText(renamed);
  await expect(desktop.locator('nav[aria-label="原生会话"]')).not.toHaveAttribute('aria-busy', 'true');
  await expect(row(desktop, mainId)).toContainText(renamed);
  record('a delayed native list from before another device rename cannot restore an obsolete session name');

  await actions(phone, renamed); await phone.getByRole('button', { name: '分叉会话', exact: true }).click();
  await expect(phone.getByRole('dialog')).toContainText('共享同一主机项目目录');
  await expect(phone.getByRole('dialog')).toContainText('不会复制文件');
  await expect(phone.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await screenshot(phone, '01-phone-fork-confirmation');
  await phone.getByRole('button', { name: '确认分叉', exact: true }).click();
  const forkId = 'fixture-fork-1';
  await expect(phone.locator('.conversation')).toHaveAttribute('data-thread-id', forkId); await ready(phone);
  expect(threads.get(forkId).cwd).toBe(cwd); expect(threads.get(forkId).turns).toHaveLength(3);
  await expect(row(desktop, forkId)).toBeVisible();
  await expect(desktop.locator('.conversation')).toHaveAttribute('data-thread-id', mainId);
  expect(requests.find(request => request.method === 'thread/fork')!.params).not.toHaveProperty('beforeTurnId');
  record('confirmed native Fork selects the new persistent thread on the requesting device and keeps its authorized project');

  await select(phone, mainId);
  await actions(desktop, renamed); await desktop.getByRole('button', { name: '回退会话', exact: true }).click();
  await desktop.getByLabel('从这一轮开始移除', { exact: true }).selectOption(`${mainId}-turn-2`);
  await expect(desktop.getByRole('dialog')).toContainText('选中轮次及之后'); await expect(desktop.getByRole('dialog')).toContainText('不会撤销已写到项目文件的修改');
  await desktop.getByRole('button', { name: '继续回退', exact: true }).click();
  await expect(desktop.getByRole('dialog', { name: '确认回退会话？', exact: true })).toBeVisible();
  await expect(desktop.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  expect(count('thread/revert')).toBe(0); await screenshot(desktop, '02-electron-revert-confirmation');
  await desktop.getByRole('button', { name: '确认移除历史', exact: true }).click();
  await expect(desktop.getByRole('dialog')).toHaveCount(0);
  for (const page of pages) {
    await expect(page.locator(`[data-item-id="${mainId}-answer-1"]`)).toHaveCount(1);
    await expect(page.locator(`[data-item-id="${mainId}-answer-2"], [data-item-id="${mainId}-answer-3"]`)).toHaveCount(0);
  }
  expect(threads.get(mainId).turns).toHaveLength(1);
  expect(requests.find(request => request.method === 'thread/revert')!.params.beforeTurnId).toBe(`${mainId}-turn-2`);
  record('Revert requires a second confirmation, explains file semantics and reloads native pages on both devices even when response turns are empty');

  // Go through real Bridge receipt reservation/acceptance. A phone subscription
  // sees the accepted active ordinary send; it must still allow exact-Turn Steer.
  await service.dispatch('turn/start', { threadId: mainId, text: '开始模拟原生运行', operationId: randomUUID() }, { deviceId: 'fixture-origin-device' });
  const active = threads.get(mainId).turns.at(-1);
  await phone.getByRole('button', { name: '会话菜单', exact: true }).click(); await phone.getByRole('menuitem', { name: '查询状态', exact: true }).click(); await ready(phone);
  expect(receipts.list(cwd, mainId)[0]).toMatchObject({ status: 'accepted', turnId: active.id });
  for (const page of pages) { await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '补充指令', exact: true })).toBeVisible(); }
  await phone.getByLabel('消息', { exact: true }).fill('请保留正在执行的检查，先验证主题。');
  await phone.getByLabel('消息', { exact: true }).dispatchEvent('compositionstart');
  await phone.getByLabel('消息', { exact: true }).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, isComposing: true, keyCode: 229 });
  expect(count('turn/steer')).toBe(0); expect(count('turn/start')).toBe(1);
  await phone.getByLabel('消息', { exact: true }).dispatchEvent('compositionend');
  await phone.getByRole('button', { name: '补充指令', exact: true }).click();
  await expect.poll(() => count('turn/steer')).toBe(1);
  expect(requests.find(request => request.method === 'turn/steer')!.params.expectedTurnId).toBe(active.id);
  expect(requests.find(request => request.method === 'turn/steer')!.params).not.toHaveProperty('model');
  expect(requests.find(request => request.method === 'turn/steer')!.params).not.toHaveProperty('approvalPolicy');
  await expect(phone.getByLabel('消息', { exact: true })).toHaveValue('');
  await screenshot(phone, '03-phone-running-steer');
  await actions(desktop, renamed); await expect(desktop.getByRole('button', { name: '回退会话', exact: true })).toBeDisabled();
  await expect(desktop.getByRole('button', { name: '压缩上下文', exact: true })).toBeDisabled(); await closeActions(desktop);
  await phone.getByLabel('消息', { exact: true }).fill('只属于这一轮的补充草稿'); complete(mainId, active);
  await expect(phone.getByRole('button', { name: '补充指令', exact: true })).toHaveCount(0);
  await expect(phone.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  const nextActive = begin(mainId, 'turn');
  await expect(phone.getByRole('button', { name: '补充指令', exact: true })).toBeDisabled();
  await phone.getByLabel('消息', { exact: true }).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true });
  expect(count('turn/steer')).toBe(1); await expect(phone.getByLabel('消息', { exact: true })).toHaveValue('只属于这一轮的补充草稿');
  complete(mainId, nextActive); await phone.getByLabel('消息', { exact: true }).fill('');
  expect(count('turn/start')).toBe(1);
  record('Steer binds the observed Turn, preserves IME and stale drafts, refuses a replacement Turn and never changes model/permissions or starts a new turn');

  await actions(desktop, renamed); await desktop.getByRole('button', { name: '审阅未提交更改', exact: true }).click();
  await expect(desktop.getByRole('dialog')).toHaveCount(0); const reviewTurn = threads.get(mainId).turns.at(-1);
  await expect(desktop.getByTestId('turn-status')).toHaveText('执行中');
  await expect(phone.getByTestId('turn-status')).toHaveText('执行中');
  expect(requests.find(request => request.method === 'review/start')!.params.target).toEqual({ type: 'uncommittedChanges' });
  expect(requests.find(request => request.method === 'review/start')!.params.delivery).toBe('inline');
  bus.emit('message', { id: 'review-approval', method: 'item/commandExecution/requestApproval', params: { threadId: mainId, turnId: reviewTurn.id, itemId: 'review-command', command: 'git diff --check', cwd } });
  for (const page of pages) await expect(page.getByRole('button', { name: '允许本次', exact: true })).toBeVisible();
  await phone.getByRole('button', { name: '允许本次', exact: true }).click();
  for (const page of pages) await expect(page.getByRole('button', { name: '允许本次', exact: true })).toHaveCount(0);
  expect(replies.filter(reply => reply.id === 'review-approval')).toHaveLength(1);
  await phone.getByLabel('消息', { exact: true }).fill('审阅时请特别核对项目归属。');
  await expect(phone.getByRole('button', { name: '补充指令', exact: true })).toBeEnabled();
  await phone.getByRole('button', { name: '补充指令', exact: true }).click();
  await expect.poll(() => count('turn/steer')).toBe(2);
  const reviewSteer = requests.filter(request => request.method === 'turn/steer').at(-1)!;
  expect(reviewSteer.params.expectedTurnId).toBe(reviewTurn.id); expect(reviewSteer.params).not.toHaveProperty('model');
  expect(reviewSteer.params).not.toHaveProperty('approvalPolicy');
  await expect(phone.getByLabel('消息', { exact: true })).toHaveValue('');
  item(mainId, reviewTurn, { id: 'review-result', type: 'exitedReviewMode', review: '## 审阅完成\n\n未发现阻断问题；此内容来自模拟原生 Review 结果。' }); complete(mainId, reviewTurn);
  for (const page of pages) { await expect(page.locator('[data-item-id="review-result"]')).toContainText('未发现阻断问题'); await expect(page.getByTestId('turn-status')).toHaveText('已完成'); }
  await desktop.locator(`.turn-process[data-turn-id="${reviewTurn.id}"] .process-toggle`).click();
  await expect(desktop.locator('[data-item-id="review-result"]')).toBeVisible();
  await desktop.locator('[data-item-id="review-result"] summary').click();
  await expect(desktop.getByRole('heading', { name: '审阅完成', exact: true })).toBeVisible();
  await desktop.locator('.conversation-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await screenshot(desktop, '04-electron-native-review-result');
  record('inline native Review shares Turn progress, cross-device approval, exact active-Turn Steer and its native result card');

  compactFailure = true; await actions(desktop, renamed); await desktop.getByRole('button', { name: '压缩上下文', exact: true }).click();
  await expect(desktop.getByRole('dialog')).toContainText('模拟原生整理不可用'); await closeActions(desktop);
  await expect(desktop.getByLabel('消息', { exact: true })).toBeEnabled();
  await actions(desktop, renamed); await desktop.getByRole('button', { name: '压缩上下文', exact: true }).click();
  await expect(desktop.getByRole('dialog')).toHaveCount(0); const compactTurn = threads.get(mainId).turns.at(-1);
  await expect(desktop.getByTestId('turn-status')).toHaveText('执行中');
  item(mainId, compactTurn, { id: 'native-compaction', type: 'contextCompaction' }); complete(mainId, compactTurn);
  for (const page of pages) { await expect(page.locator('[data-item-id="native-compaction"]')).toHaveCount(1); await expect(page.getByTestId('turn-status')).toHaveText('已完成'); }
  expect(count('thread/compact/start')).toBe(2); expect(count('turn/start')).toBe(1);
  record('Compact surfaces native rejection, stays retryable only after known rejection and renders actual contextCompaction completion');

  heldMethod = 'thread/name/set'; await actions(desktop, renamed); await desktop.getByRole('button', { name: '重命名', exact: true }).click();
  await desktop.getByLabel('会话名称', { exact: true }).fill(renamed); await desktop.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect.poll(() => !!releaseMutation).toBe(true); const heldRenameCount = count('thread/name/set');
  await actions(phone, renamed); await expect(phone.getByRole('button', { name: '重命名', exact: true })).toBeDisabled();
  await expect(phone.getByRole('button', { name: '分叉会话', exact: true })).toBeDisabled(); await closeActions(phone);
  releaseMutation!(); releaseMutation = undefined;
  await expect(desktop.getByRole('dialog')).toHaveCount(0); expect(count('thread/name/set')).toBe(heldRenameCount);
  record('in-flight native mutation is broadcast to the other device and prevents competing native actions or duplicate submission');

  for (const value of ['oracle-eye', 'minimal-light', 'hong-kong-neon', 'old-terminal']) {
    for (const page of pages) {
      await theme(page, value); await actions(page, renamed); await geometry(page, page === phone);
      await expect(page.getByRole('button', { name: '归档会话', exact: false })).toBeEnabled();
      await expect(page.getByRole('button', { name: '永久删除', exact: false })).toBeEnabled();
      if (value === 'hong-kong-neon' && page === phone) await screenshot(page, '05-phone-hong-kong-neon-actions');
      if (value === 'old-terminal' && page === desktop) await screenshot(page, '06-electron-old-terminal-actions');
      if (value === 'minimal-light' && page === desktop) await screenshot(page, '09-electron-minimal-light-actions');
      await closeActions(page);
      if (page === phone) { const close = page.getByRole('button', { name: '折叠导航', exact: true }); if (await close.isVisible()) await close.click(); }
    }
  }
  for (const [width, height] of [[375, 667], [390, 844], [844, 390]]) {
    await phone.setViewportSize({ width, height }); await actions(phone, renamed); await phone.getByRole('button', { name: '重命名', exact: true }).click(); await geometry(phone, true);
    await phone.keyboard.press('Escape'); await expect(phone.getByRole('dialog')).toHaveCount(0);
    const close = phone.getByRole('button', { name: '折叠导航', exact: true }); if (await close.isVisible()) await close.click();
  }
  await phone.setViewportSize({ width: 390, height: 844 }); await theme(desktop, 'oracle-eye'); await theme(phone, 'oracle-eye');
  await actions(phone, renamed); await phone.getByRole('button', { name: /^Plan 模式/ }).click();
  await expect(phone.getByRole('dialog')).toContainText('当前版本暂不支持');
  expect(count('collaborationMode/list')).toBe(0); await phone.evaluate(() => window.oraculumAndroidBack?.());
  await expect(phone.getByRole('dialog')).toHaveCount(0);
  record('four themes retain session action geometry and archive/delete controls; narrow and landscape dialogs, Escape and Android Back work; Plan clearly degrades without experimental RPC');

  await nav(phone); await expect(phone.locator('.weekly-quota')).toContainText('58%');
  const drawerClose = phone.getByRole('button', { name: '折叠导航', exact: true }); if (await drawerClose.isVisible()) await drawerClose.click();
  await phone.getByRole('button', { name: '会话菜单', exact: true }).click(); await phone.getByRole('menuitem', { name: '会话用量', exact: true }).click();
  await expect(phone.locator('.usage-total')).toContainText('42k'); await screenshot(phone, '07-phone-usage-inspector');
  await phone.evaluate(() => window.oraculumAndroidBack?.()); await expect(phone.locator('.inspector')).toHaveCount(0);
  await phone.getByLabel('消息', { exact: true }).fill('未发送草稿在切换会话后保留');
  await select(phone, forkId); await select(phone, mainId); await expect(phone.getByLabel('消息', { exact: true })).toHaveValue('未发送草稿在切换会话后保留');
  await phone.setViewportSize({ width: 390, height: 430 });
  await expect.poll(async () => { const composer = (await phone!.locator('.composer').boundingBox())!; return composer.y + composer.height; }).toBeLessThanOrEqual(431);
  await phone.setViewportSize({ width: 390, height: 844 });
  record('B3 weekly footer and session Inspector, navigation, unsent draft and keyboard-height Composer survive native history operations');

  await select(desktop, 'unsupported'); await actions(desktop, '原生控制 · 不支持');
  unsupportedMethod = 'thread/name/set'; await desktop.getByRole('button', { name: '重命名', exact: true }).click();
  await desktop.getByLabel('会话名称', { exact: true }).fill('不应保存的名称'); await desktop.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(desktop.getByRole('dialog').getByRole('alert')).toContainText('不支持此操作'); await closeActions(desktop);
  await desktop.getByLabel('消息', { exact: true }).fill('已知不支持不影响正常发送');
  await expect(desktop.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  await desktop.getByLabel('消息', { exact: true }).fill('');
  record('method-not-found is an explicit per-action limitation and leaves Composer available');

  await select(desktop, 'unknown'); await select(phone, 'unknown'); await actions(desktop, '原生控制 · 结果未知');
  unknownMethod = 'thread/fork'; await desktop.getByRole('button', { name: '分叉会话', exact: true }).click();
  await desktop.getByRole('button', { name: '确认分叉', exact: true }).click();
  await expect(desktop.getByRole('dialog').getByRole('alert')).toContainText('未知'); const unknownForks = count('thread/fork');
  await closeActions(desktop); await server.close(); await expect(phone.getByRole('button', { name: '重新连接', exact: true })).toBeVisible();
  server = await makeServer(); await server.listen({ host: '127.0.0.1', port });
  await phone.getByRole('button', { name: '重新连接', exact: true }).click(); await ready(phone);
  await phone.getByLabel('消息', { exact: true }).fill('Fork 结果未知不会拦住正常消息草稿');
  await expect(phone.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  await phone.getByLabel('消息', { exact: true }).fill('');
  await actions(phone, '原生控制 · 结果未知'); await expect(phone.getByRole('button', { name: '分叉会话', exact: true })).toBeDisabled();
  await expect(phone.getByRole('button', { name: '审阅未提交更改', exact: true })).toBeEnabled();
  await expect(phone.getByRole('dialog').getByRole('status')).toContainText(/尚未确认|待确认|结果未知/); expect(count('thread/fork')).toBe(unknownForks); expect(count('turn/start')).toBe(1);
  await screenshot(phone, '08-phone-unknown-outcome'); await closeActions(phone);
  record('uncertain native Fork remains blocked across disconnect and status recovery without retrying or creating ordinary turns');

  expect(errors).toEqual([]);
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  for (const [name, page] of [['electron', desktop], ['phone', phone]] as const) if (page && !page.isClosed()) await page.screenshot({ path: join(output, `failure-${name}.png`) }).catch(() => {});
  throw error;
} finally {
  releaseMutation?.(); releaseList?.(); await browser?.close(); await app?.close(); await server.close();
  db.close();
  await writeFile(join(output, 'result.json'), JSON.stringify({ output, simulatedNative: true, realElectron: true, androidDevice: false, checks, requests, replies, errors, failure }, null, 2));
  console.log(JSON.stringify({ output, checks, errors, failure }));
}
