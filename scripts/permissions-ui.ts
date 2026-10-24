// Real local Electron + emulated Android renderer, using deterministic native
// replies through the real Bridge. This is not native Codex or Android device QA.
import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import type { NativeSessionSettings, Thread, Turn, WireMessage } from '../packages/shared/protocol';

const cwd = '/permission-ui-fixture', firstId = 'permission-first', secondId = 'permission-second';
const initial: NativeSessionSettings = { approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user' };
const threads = new Map<string, Thread>([firstId, secondId].map((id, index) => [id, {
  id, name: `权限模拟会话 ${index + 1}`, cwd, preview: '', model: 'fixture-model', reasoningEffort: 'low', status: { type: 'idle' }, turns: [],
} as unknown as Thread]));
const settings = new Map([...threads.keys()].map(id => [id, structuredClone(initial)]));
const bus = new EventEmitter(), requests: { method: string; params: Record<string, unknown> }[] = [];
let nextThread = 2, nextTurn = 0, holdTurn = false, holdReadback = false;
let releaseTurn: (() => void) | undefined, releaseReadback: (() => void) | undefined;
const emit = (method: string, params: object) => bus.emit('message', { method, params });
const codex = {
  on: bus.on.bind(bus), send: (_message: WireMessage) => {},
  request: async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    requests.push({ method, params: structuredClone(params) });
    let result: unknown;
    const id = String(params.threadId), thread = threads.get(id);
    if (method === 'config/read') result = { config: { model: 'fixture-model', model_reasoning_effort: 'low', model_provider: 'fixture', approval_policy: 'on-request', sandbox_mode: 'read-only', approvals_reviewer: 'user' } };
    else if (method === 'model/list') result = { data: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], nextCursor: null };
    else if (method === 'thread/list') result = { data: [...threads.values()], nextCursor: null };
    else if (method === 'thread/start') {
      const id = `permission-created-${++nextThread}`;
      const thread = { ...structuredClone(threads.get(firstId)!), id, name: `新权限模拟会话 ${nextThread}`, status: { type: 'idle' }, turns: [] } as Thread;
      const sandbox: NativeSessionSettings['sandbox'] = params.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
        : params.sandbox === 'workspace-write' ? { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
        : initial.sandbox;
      const value = { ...initial, sandbox, approvalPolicy: (params.approvalPolicy ?? initial.approvalPolicy) as NativeSessionSettings['approvalPolicy'] };
      threads.set(id, thread); settings.set(id, value); result = { thread, ...value };
    } else if (method === 'thread/read') result = { thread };
    else if (method === 'thread/resume') {
      if (holdReadback) { holdReadback = false; await new Promise<void>(accept => { releaseReadback = accept; }); }
      result = { thread, ...settings.get(id) };
    } else if (method === 'thread/turns/list') result = { data: [...thread!.turns].reverse(), nextCursor: null };
    else if (method === 'thread/items/list') result = { data: thread!.turns.find(turn => turn.id === params.turnId)!.items.map(item => ({ turnId: params.turnId, item })), nextCursor: null };
    else if (method === 'turn/start') {
      if (holdTurn) { holdTurn = false; await new Promise<void>(accept => { releaseTurn = accept; }); }
      const current = settings.get(id)!;
      settings.set(id, { ...current, approvalPolicy: (params.approvalPolicy ?? current.approvalPolicy) as NativeSessionSettings['approvalPolicy'], sandbox: (params.sandboxPolicy ?? current.sandbox) as NativeSessionSettings['sandbox'] });
      const turn = { id: `permission-turn-${++nextTurn}`, status: 'inProgress', items: [], itemsView: 'full', error: null } as unknown as Turn;
      thread!.turns.push(turn); thread!.status = { type: 'active', activeFlags: [] };
      emit('turn/started', { threadId: id, turn }); result = { turn };
    } else throw new Error(`Unexpected fixture RPC: ${method}`);
    return structuredClone(result) as T;
  },
};
const service = new BridgeService(codex, cwd), port = Number(process.env.ORACULUM_PERMISSION_UI_PORT ?? '17876');
const origin = `http://127.0.0.1:${port}`;
const server = await createServer(service, port, resolve('apps/web/dist'), { testOnlyUnauthenticated: true });
await mkdir('.local/evidence/phase4d1/ui', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/phase4d1/ui/run-'));
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron-profile') });
let app: ElectronApplication | undefined, browser: Browser | undefined, desktop: Page | undefined, phone: Page | undefined;
const checks: string[] = [], rendererErrors: string[] = [];
let failure: string | undefined;
const ready = (page: Page) => expect(page.locator('.connection-status')).toContainText('状态已查询', { timeout: 15_000 });
const effective = (page: Page) => page.getByTestId('effective-permissions');
const choice = (page: Page) => page.getByRole('combobox', { name: '权限模式', exact: true });
async function screenshot(page: Page, name: string) { await page.screenshot({ path: join(output, name + '.png') }); }
async function finish(id: string) {
  const thread = threads.get(id)!, turn = thread.turns.at(-1)!;
  turn.status = 'completed'; thread.status = { type: 'idle' };
  emit('turn/completed', { threadId: id, turn });
  for (const page of [desktop!, phone!]) await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
}
async function geometry(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await expect.poll(async () => { const box = await page.locator('.composer').boundingBox(); return box ? box.y + box.height : Infinity; }).toBeLessThanOrEqual(height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const locator of [choice(page), page.getByRole('button', { name: '发送', exact: true })]) {
    await expect(locator).toBeInViewport();
    const box = (await locator.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
  }
  await screenshot(page, `mobile-${width}x${height}`);
}
try {
  await server.listen({ host: '127.0.0.1', port });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  // The branded splash is transient; select the actual application page.
  await expect.poll(() => app!.windows().some(page => page.url().startsWith(origin)), { timeout: 15_000 }).toBe(true);
  desktop = app.windows().find(page => page.url().startsWith(origin))!;
  desktop.on('pageerror', error => rendererErrors.push(error.message)); await ready(desktop);
  browser = await chromium.launch();
  phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36 OraculumAndroid/1' });
  phone.on('pageerror', error => rendererErrors.push(error.message)); await phone.goto(origin); await ready(phone);
  for (const page of [desktop, phone]) {
    await expect(choice(page)).toHaveValue('inherit');
    expect(await choice(page).locator('option').allTextContents()).toEqual(['继承原生', 'Read Only', 'Auto', 'Full Access']);
    await expect(effective(page)).toContainText('沙盒 read-only · 审批 on-request');
  }
  await choice(desktop).selectOption('full-access');
  await expect(effective(desktop)).toContainText('read-only');
  await expect(desktop.locator('.permission-intent')).toContainText('下一次新建 / 发送使用 Full Access');
  await expect(desktop.locator('.permission-warning')).toBeVisible();
  expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(0);
  await screenshot(desktop, 'desktop-pending-full-access');
  checks.push('default inherit; selecting Full Access is pending only and does not dispatch a native mutation');

  holdTurn = true; holdReadback = true;
  await desktop.getByLabel('消息', { exact: true }).fill('模拟权限传递，不执行真实工具');
  await desktop.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => !!releaseTurn).toBe(true);
  for (const page of [desktop, phone]) await expect(effective(page)).toContainText('实际权限待 Codex 确认');
  const sent = requests.find(request => request.method === 'turn/start')!.params;
  expect(sent).toMatchObject({ threadId: firstId, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
  releaseTurn!(); await expect.poll(() => !!releaseReadback).toBe(true);
  await expect(effective(desktop)).toContainText('实际权限待 Codex 确认');
  releaseReadback!();
  for (const page of [desktop, phone]) await expect(effective(page)).toContainText('原生已确认：沙盒 danger-full-access · 审批 never');
  await expect(choice(phone)).toHaveValue('inherit');
  await expect(phone.locator('.permission-intent')).toContainText('保留此前覆盖');
  await screenshot(desktop, 'desktop-confirmed-full-access');
  checks.push('actual Bridge native override; both clients wait through dispatch and ACK until readback; cross-device effective settings do not auto-select Full Access');
  await finish(firstId);

  await choice(desktop).selectOption('auto');
  await desktop.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(effective(desktop)).toContainText('原生已确认：沙盒 workspace-write · 审批 on-request');
  expect(requests.find(request => request.method === 'thread/start')!.params).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  await screenshot(desktop, 'desktop-created-auto');
  await choice(desktop).selectOption('full-access');
  await desktop.locator(`.session-link[data-thread-id="${secondId}"]`).click(); await ready(desktop);
  await expect(choice(desktop)).toHaveValue('inherit'); await expect(effective(desktop)).toContainText('read-only');
  await choice(desktop).selectOption('full-access'); await desktop.reload(); await ready(desktop);
  await expect(choice(desktop)).toHaveValue('inherit'); await expect(effective(desktop)).toContainText('read-only');
  checks.push('new thread shows returned native Auto settings; switching threads and reloading reset pending Full Access to inherit');

  await choice(phone).selectOption('full-access');
  for (const [width, height] of [[375, 812], [390, 460], [844, 390], [844, 99]]) await geometry(phone, width, height);
  checks.push('mobile touch selector/send at 375x812, 390x460, 844x390 and tiny landscape IME 844x99; no horizontal or composer overflow');

  for (const socket of server.websocketServer.clients) socket.close(1001, 'Fixture connection interruption');
  await expect(effective(desktop)).toContainText('上次确认 · 待重新查询');
  await expect(choice(desktop)).toBeDisabled(); await screenshot(desktop, 'desktop-disconnected');
  await desktop.locator('.disconnect-banner').getByRole('button', { name: '重新连接', exact: true }).click(); await ready(desktop);
  await expect(choice(desktop)).toHaveValue('inherit'); await expect(effective(desktop)).toContainText('原生已确认');
  checks.push('disconnected effective state is explicitly stale; reconnect refreshes native state and resets explicit selection');
  expect(rendererErrors).toEqual([]);
} catch (error) {
  failure = String(error);
  if (desktop && !desktop.isClosed()) await screenshot(desktop, 'failure-desktop').catch(() => {});
  if (phone && !phone.isClosed()) await screenshot(phone, 'failure-mobile').catch(() => {});
  throw error;
} finally {
  releaseTurn?.(); releaseReadback?.();
  await app?.close(); await browser?.close(); await server.close();
  await writeFile(join(output, 'report.json'), JSON.stringify({ output, simulatedNative: true, realElectron: true, emulatedAndroid: true, date: new Date().toISOString(), checks, rendererErrors, failure }, null, 2));
  console.log(JSON.stringify({ output, checks, failure }));
}
