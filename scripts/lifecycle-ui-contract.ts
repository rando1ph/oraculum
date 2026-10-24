// Real Electron and Chromium touch viewport; deterministic native replies through
// the real Bridge. These contracts are not Android-device or native-Codex evidence.
import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import { NativeRpcError } from '../bridge/src/codex';
import type { NativeSessionSettings, Thread, WireMessage } from '../packages/shared/protocol';

const cwd = '/lifecycle-ui-fixture';
const ids = ['guarded', 'delete-confirm', 'stale-list', 'stale-snapshot', 'unsupported', 'unknown-send'];
const threads = new Map(ids.map(id => [id, { id, name: id, preview: '', cwd, model: 'fixture', reasoningEffort: 'low',
  parentThreadId: null, ephemeral: false, source: 'appServer', status: { type: 'idle' }, turns: [] } as unknown as Thread]));
const archived = new Set<string>(), bus = new EventEmitter();
const settings: NativeSessionSettings = { approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user' };
const requests: { method: string; params: Record<string, unknown> }[] = [];
let holdList = false, holdSnapshot = '', failArchived = false, unsupported = false;
let releaseList: (() => void) | undefined, releaseSnapshot: (() => void) | undefined;
const emit = (method: string, params: object) => bus.emit('message', { method, params });
const codex = { on: bus.on.bind(bus), send: (_message: WireMessage) => {}, request: async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
  requests.push({ method, params: structuredClone(params) });
  const id = String(params.threadId), thread = threads.get(id);
  let result: unknown;
  if (method === 'config/read') result = { config: { model: 'fixture', model_provider: 'fixture', approval_policy: 'on-request', sandbox_mode: 'read-only', approvals_reviewer: 'user' } };
  else if (method === 'model/list') result = { data: [], nextCursor: null };
  else if (method === 'thread/list') {
    if (failArchived && params.archived && params.cwd) { failArchived = false; throw new Error('模拟已归档查询失败'); }
    result = { data: structuredClone([...threads.values()].filter(t => archived.has(t.id) === !!params.archived)), nextCursor: null };
    if (holdList && params.cwd) { holdList = false; await new Promise<void>(accept => { releaseList = accept; }); }
  } else if (method === 'thread/read' || method === 'thread/resume') {
    if (!thread) throw new NativeRpcError('Thread not found', -32602);
    result = { thread, ...settings };
  } else if (method === 'thread/turns/list') {
    result = { data: structuredClone(thread!.turns), nextCursor: null };
    if (holdSnapshot === id) { holdSnapshot = ''; await new Promise<void>(accept => { releaseSnapshot = accept; }); }
  } else if (method === 'thread/items/list') result = { data: [], nextCursor: null };
  else if (['thread/archive', 'thread/unarchive', 'thread/delete'].includes(method)) {
    if (unsupported) { unsupported = false; throw new NativeRpcError('Method not found', -32601); }
    if (method === 'thread/archive') archived.add(id);
    else if (method === 'thread/unarchive') archived.delete(id);
    else { threads.delete(id); archived.delete(id); }
    emit(method === 'thread/archive' ? 'thread/archived' : method === 'thread/unarchive' ? 'thread/unarchived' : 'thread/deleted', { threadId: id });
    result = method === 'thread/unarchive' ? { thread } : {};
  } else if (method === 'turn/start') throw new Error('模拟发送结果未知');
  else throw new Error(`Unexpected fixture RPC ${method}`);
  return structuredClone(result) as T;
} };
const service = new BridgeService(codex, cwd), port = Number(process.env.ORACULUM_LIFECYCLE_UI_PORT ?? '17878');
const origin = `http://127.0.0.1:${port}`;
const server = await createServer(service, port, resolve('apps/web/dist'), { testOnlyUnauthenticated: true });
await mkdir('.local/evidence/phase4d2/contracts', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/phase4d2/contracts/run-'));
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron-profile') });
let app: ElectronApplication | undefined, browser: Browser | undefined, desktop: Page | undefined, phone: Page | undefined, failure: string | undefined;
const checks: string[] = [], errors: string[] = [];
const ready = (page: Page) => expect(page.locator('.connection-status')).toContainText('状态已查询', { timeout: 15_000 });
const row = (page: Page, id: string) => page.locator(`.session-link[data-thread-id="${id}"]`);
const actions = (page: Page, id: string) => page.getByRole('button', { name: `会话操作：${id}`, exact: true }).click();
const closeActions = (page: Page) => page.getByRole('button', { name: '关闭会话操作', exact: true }).click();
const archiveButton = (page: Page) => page.getByRole('button', { name: /^归档会话/ });
const deleteButton = (page: Page) => page.getByRole('button', { name: /^永久删除/ });
async function nav(page: Page) { if (await page.getByRole('button', { name: '打开导航', exact: true }).isVisible() && !await page.locator('.app-shell').evaluate(e => e.classList.contains('drawer-open'))) await page.getByRole('button', { name: '打开导航', exact: true }).click(); }
async function select(page: Page, id: string) { await nav(page); await row(page, id).click(); await ready(page); }
const mutations = () => requests.filter(r => ['thread/archive', 'thread/unarchive', 'thread/delete'].includes(r.method)).length;
try {
  await server.listen({ host: '127.0.0.1', port });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  await expect.poll(() => app!.windows().some(page => page.url().startsWith(origin))).toBe(true);
  desktop = app.windows().find(page => page.url().startsWith(origin))!; desktop.on('pageerror', error => errors.push(error.message)); await ready(desktop);
  browser = await chromium.launch(); phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  phone.on('pageerror', error => errors.push(error.message)); await phone.goto(origin); await ready(phone);

  const before = mutations();
  threads.get('guarded')!.status = { type: 'active', activeFlags: [] };
  emit('thread/status/changed', { threadId: 'guarded', status: threads.get('guarded')!.status });
  await actions(desktop, 'guarded'); await expect(archiveButton(desktop)).toBeDisabled(); await expect(deleteButton(desktop)).toBeDisabled();
  await expect(desktop.getByRole('dialog')).toContainText('正在执行'); await closeActions(desktop);
  threads.get('guarded')!.status = { type: 'idle' }; emit('thread/status/changed', { threadId: 'guarded', status: { type: 'idle' } });
  bus.emit('message', { id: 'pending', method: 'item/commandExecution/requestApproval', params: { threadId: 'guarded', turnId: 'test-turn', itemId: 'command', command: 'fixture', cwd } });
  await actions(desktop, 'guarded'); await expect(archiveButton(desktop)).toBeDisabled(); await expect(desktop.getByRole('dialog')).toContainText('待处理审批'); await closeActions(desktop);
  emit('serverRequest/resolved', { threadId: 'guarded', requestId: 'pending' });
  expect(mutations()).toBe(before); checks.push('running and pending approvals disable lifecycle controls without native mutations');

  await select(desktop, 'unknown-send');
  await desktop.getByLabel('消息', { exact: true }).fill('模拟不确定的发送'); await desktop.getByRole('button', { name: '发送', exact: true }).click();
  await expect(desktop.getByRole('alert')).toContainText('模拟发送结果未知');
  await desktop.getByRole('button', { name: '查询状态', exact: true }).click(); await ready(desktop);
  await actions(desktop, 'unknown-send'); await expect(archiveButton(desktop)).toBeDisabled(); await expect(desktop.getByRole('dialog')).toContainText('尚未确认'); await closeActions(desktop);
  checks.push('unknown send snapshot disables lifecycle controls');

  failArchived = true;
  await desktop.getByRole('button', { name: '已归档', exact: true }).click();
  await expect(desktop.locator('nav[aria-label="原生会话"]')).toContainText('模拟已归档查询失败');
  await expect(desktop.locator('nav .session-row')).toHaveCount(0);
  await expect(desktop.getByText('此项目没有已归档会话', { exact: true })).toHaveCount(0);
  await desktop.getByRole('button', { name: '刷新列表', exact: true }).click();
  await expect(desktop.getByText('此项目没有已归档会话', { exact: true })).toBeVisible();
  await desktop.getByRole('button', { name: '会话', exact: true }).click(); await expect(row(desktop, 'delete-confirm')).toBeVisible();
  checks.push('archived query failure is visible rather than an empty or stale active list; explicit refresh recovers');

  await nav(phone); await actions(phone, 'delete-confirm'); await deleteButton(phone).click();
  await expect(phone.getByRole('dialog', { name: '永久删除会话？', exact: true })).toBeVisible();
  await expect(phone.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await phone.keyboard.press('Tab'); await expect(phone.getByRole('button', { name: '确认永久删除', exact: true })).toBeFocused();
  await phone.keyboard.press('Tab'); await expect(phone.getByRole('button', { name: '关闭会话操作', exact: true })).toBeFocused();
  await actions(desktop, 'delete-confirm'); await deleteButton(desktop).click(); await desktop.getByRole('button', { name: '确认永久删除', exact: true }).click();
  await expect(phone.getByRole('dialog')).toHaveCount(0); await expect(row(phone, 'delete-confirm')).toHaveCount(0);
  expect(requests.filter(r => r.method === 'thread/delete' && r.params.threadId === 'delete-confirm')).toHaveLength(1);
  checks.push('confirmation focuses Cancel and traps keyboard focus; deletion from another device invalidates an open confirmation');

  await actions(desktop, 'unsupported'); unsupported = true; await archiveButton(desktop).click();
  await expect(desktop.getByRole('dialog')).toContainText('当前 Codex App Server 不支持此会话操作');
  await expect(row(desktop, 'unsupported')).toHaveCount(1); await desktop.keyboard.press('Escape');
  await expect(desktop.getByRole('dialog')).toHaveCount(0); await expect(desktop.getByRole('button', { name: '会话操作：unsupported', exact: true })).toBeFocused();
  checks.push('unsupported native operation remains visible with explicit limitation; Escape closes and restores trigger focus');

  holdList = true; await desktop.getByRole('button', { name: '刷新列表', exact: true }).click(); await expect.poll(() => !!releaseList).toBe(true);
  await service.dispatch('thread/archive', { threadId: 'stale-list', cwd });
  await expect(row(desktop, 'stale-list')).toHaveCount(0);
  releaseList!(); releaseList = undefined;
  await desktop.getByRole('button', { name: '已归档', exact: true }).click(); await expect(row(desktop, 'stale-list')).toBeVisible();
  await desktop.getByRole('button', { name: '会话', exact: true }).click(); await expect(row(desktop, 'stale-list')).toHaveCount(0);
  checks.push('delayed pre-archive list cannot reinsert removed session; archived and active views remain distinct');

  await select(desktop, 'stale-snapshot'); await desktop.getByLabel('消息', { exact: true }).fill('归档前保留的草稿');
  holdSnapshot = 'stale-snapshot'; await desktop.getByRole('button', { name: '查询状态', exact: true }).click(); await expect.poll(() => !!releaseSnapshot).toBe(true);
  // Simulate an external official client changing state while history is read.
  archived.add('stale-snapshot'); emit('thread/archived', { threadId: 'stale-snapshot' });
  await expect(desktop.locator('.conversation')).not.toHaveAttribute('data-thread-id', 'stale-snapshot');
  releaseSnapshot!(); releaseSnapshot = undefined;
  await expect(desktop.getByLabel('消息', { exact: true })).toHaveValue('');
  await expect(desktop.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  expect(await desktop.evaluate(key => sessionStorage.getItem(key), `oraculum.draft:${cwd}:stale-snapshot`)).toBe('归档前保留的草稿');
  await service.dispatch('thread/unarchive', { threadId: 'stale-snapshot', cwd });
  await select(desktop, 'stale-snapshot'); await expect(desktop.getByLabel('消息', { exact: true })).toHaveValue('归档前保留的草稿');
  checks.push('lifecycle event bypasses pending snapshot buffer; stale snapshot cannot revive selected thread or composer; unsent draft survives restore');
  expect(errors).toEqual([]);
} catch (error) {
  failure = String(error);
  for (const [page, name] of [[desktop, 'desktop'], [phone, 'mobile']] as const) if (page && !page.isClosed()) await page.screenshot({ path: join(output, `failure-${name}.png`) }).catch(() => {});
  throw error;
} finally {
  releaseList?.(); releaseSnapshot?.(); await app?.close(); await browser?.close(); await server.close();
  await writeFile(join(output, 'report.json'), JSON.stringify({ output, date: new Date().toISOString(), simulatedNative: true, realElectron: true, emulatedAndroid: true, checks, errors, failure }, null, 2));
  console.log(JSON.stringify({ output, checks, errors, failure }));
}
