// Real local Electron + emulated Android renderer, using deterministic native
// replies through the real Bridge. This is not native Codex or Android device QA.
import { permissionTrigger, selectPermission } from './composer-controls';
import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BridgeService } from '../bridge/src/service';
import { NativeRpcError } from '../bridge/src/codex';
import { ReceiptStore } from '../bridge/src/receipts';
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
let preserveCustomSandbox = false, rejectNext = false, unknownNext = false, dropNextAck = false, droppedOperation = '';
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
      threads.set(id, thread); settings.set(id, value); result = { thread, ...value, model: 'fixture-model', reasoningEffort: 'low' };
    } else if (method === 'thread/read') result = { thread };
    else if (method === 'thread/resume') {
      if (holdReadback) { holdReadback = false; await new Promise<void>(accept => { releaseReadback = accept; }); }
      result = { thread, ...settings.get(id), model: 'fixture-model', reasoningEffort: 'low' };
    } else if (method === 'thread/turns/list') result = { data: [...thread!.turns].reverse(), nextCursor: null };
    else if (method === 'thread/items/list') result = { data: thread!.turns.find(turn => turn.id === params.turnId)!.items.map(item => ({ turnId: params.turnId, item })), nextCursor: null };
    else if (method === 'turn/start') {
      if (rejectNext) { rejectNext = false; throw new NativeRpcError('Simulated rejected permission send', -32602); }
      if (unknownNext) { unknownNext = false; throw new Error('Simulated uncertain native transport'); }
      if (holdTurn) { holdTurn = false; await new Promise<void>(accept => { releaseTurn = accept; }); }
      const current = settings.get(id)!;
      settings.set(id, { ...current, approvalPolicy: (params.approvalPolicy ?? current.approvalPolicy) as NativeSessionSettings['approvalPolicy'], sandbox: (preserveCustomSandbox ? current.sandbox : params.sandboxPolicy ?? current.sandbox) as NativeSessionSettings['sandbox'] });
      const turn = { id: `permission-turn-${++nextTurn}`, status: 'inProgress', items: [], itemsView: 'full', error: null } as unknown as Turn;
      thread!.turns.push(turn); thread!.status = { type: 'active', activeFlags: [] };
      emit('turn/started', { threadId: id, turn }); result = { turn };
    } else throw new Error(`Unexpected fixture RPC: ${method}`);
    return structuredClone(result) as T;
  },
};
const db = new DatabaseSync(':memory:'), receipts = new ReceiptStore(db);
const service = new BridgeService(codex, cwd, receipts), port = Number(process.env.ORACULUM_PERMISSION_UI_PORT ?? '17876');
const origin = `http://127.0.0.1:${port}`;
const server = await createServer(service, port, resolve('apps/web/dist'), { testOnlyUnauthenticated: true });
const dispatch = service.dispatch.bind(service);
service.dispatch = async (method, params, context) => {
  // Exercise the real receipt store without pairing a fixture-only renderer.
  const result = await dispatch(method, params, context ?? { deviceId: 'permission-fixture-device' });
  if (method === 'turn/start' && dropNextAck) {
    dropNextAck = false; droppedOperation = String(params.operationId);
    for (const socket of server.websocketServer.clients) socket.close(1001, 'Fixture accepted turn ACK lost');
  }
  return result;
};
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
const choice = permissionTrigger;
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
    await expect(choice(page)).toHaveAccessibleName('权限：Read Only');
    await choice(page).click();
    const menu = page.getByRole('dialog', { name: '权限', exact: true });
    expect(await menu.getByRole('radio').allTextContents()).toEqual(['Read Only', 'Auto', 'Full Access']);
    await expect(menu.getByRole('radio', { name: 'Read Only', exact: true })).toHaveAttribute('aria-checked', 'true');
    expect(await menu.innerText()).not.toMatch(/继承|默认/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.permission-intent, .permission-warning, .composer-caption')).toHaveCount(0);
  }
  await selectPermission(desktop, 'full-access');
  await expect(choice(desktop)).toHaveAccessibleName('权限：Full Access');
  await expect(choice(phone)).toHaveAccessibleName('权限：Read Only');
  expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(0);
  await screenshot(desktop, 'desktop-pending-full-access');
  checks.push('actual native Read Only is selected without inherit/default; selecting Full Access changes no executing turn or other client before send');

  holdTurn = true; holdReadback = true;
  await desktop.getByLabel('消息', { exact: true }).fill('模拟权限传递，不执行真实工具');
  await desktop.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => !!releaseTurn).toBe(true);
  const sent = requests.find(request => request.method === 'turn/start')!.params;
  expect(sent).toMatchObject({ threadId: firstId, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
  releaseTurn!(); await expect.poll(() => !!releaseReadback).toBe(true);
  await expect(choice(phone)).not.toHaveAccessibleName('权限：Full Access');
  releaseReadback!();
  for (const page of [desktop, phone]) await expect(choice(page)).toHaveAccessibleName('权限：Full Access');
  await screenshot(desktop, 'desktop-confirmed-full-access');
  checks.push('permission override reaches actual Bridge request; second client displays Full Access only after native readback');
  await finish(firstId);

  await desktop.getByLabel('消息', { exact: true }).fill('第二条继续使用已确认的权限');
  await desktop.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => requests.filter(request => request.method === 'turn/start').length).toBe(2);
  await expect(choice(desktop)).toHaveAccessibleName('权限：Full Access');
  expect(settings.get(firstId)).toMatchObject({ approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } });
  await finish(firstId);
  await desktop.reload(); await ready(desktop);
  for (const page of [desktop, phone]) await expect(choice(page)).toHaveAccessibleName('权限：Full Access');
  checks.push('a second send and reload retain the effective native Full Access value without another selection');

  await desktop.locator(`.session-link[data-thread-id="${secondId}"]`).click(); await ready(desktop);
  await expect(choice(desktop)).toHaveAccessibleName('权限：Read Only');
  await selectPermission(desktop, 'auto'); await desktop.reload(); await ready(desktop);
  await expect(choice(desktop)).toHaveAccessibleName('权限：Auto');
  await desktop.locator(`.session-link[data-thread-id="${firstId}"]`).click(); await ready(desktop);
  await expect(choice(desktop)).toHaveAccessibleName('权限：Full Access');
  await desktop.locator(`.session-link[data-thread-id="${secondId}"]`).click(); await ready(desktop);
  await expect(choice(desktop)).toHaveAccessibleName('权限：Auto');
  await desktop.getByLabel('消息', { exact: true }).fill('第二个会话使用 Auto');
  await desktop.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => settings.get(secondId)?.sandbox?.type).toBe('workspaceWrite');
  expect(settings.get(firstId)?.sandbox?.type).toBe('dangerFullAccess');
  await finish(secondId);
  await expect(choice(phone)).toHaveAccessibleName('权限：Full Access');
  checks.push('pending choices survive thread switches/reload; the second thread independently confirms Auto without leaking into the first thread');

  for (const [width, height] of [[375, 812], [390, 460], [844, 390], [844, 99]]) await geometry(phone, width, height);
  checks.push('mobile permission/send at 375x812, 390x460, 844x390 and tiny landscape IME 844x99 stay reachable without overflow');
  await phone.setViewportSize({ width: 390, height: 844 });
  for (const socket of server.websocketServer.clients) socket.close(1001, 'Fixture connection interruption');
  await expect(desktop.locator('.disconnect-banner')).toBeVisible();
  await expect(choice(desktop)).toBeDisabled(); await screenshot(desktop, 'desktop-disconnected');
  await desktop.locator('.disconnect-banner').getByRole('button', { name: '重新连接', exact: true }).click(); await ready(desktop);
  await expect(choice(desktop)).toHaveAccessibleName('权限：Auto');
  checks.push('disconnect remains actionable and prevents permission changes; reconnect restores the actual thread value');

  // Native Auto may retain extra writable roots. A lost transport ACK must not
  // leave an optimistic preset selected after its exact receipt is recovered.
  settings.set(firstId, { ...initial, sandbox: { type: 'workspaceWrite', writableRoots: ['/fixture-retained-root'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } });
  await desktop.locator(`.session-link[data-thread-id="${firstId}"]`).click(); await ready(desktop);
  await expect(choice(desktop)).toHaveAccessibleName('权限：自定义');
  preserveCustomSandbox = true; dropNextAck = true;
  await selectPermission(desktop, 'auto');
  await desktop.getByLabel('消息', { exact: true }).fill('模拟已接受但丢失 ACK 的自定义权限');
  await desktop.getByRole('button', { name: '发送', exact: true }).click();
  await expect(desktop.locator('.disconnect-banner')).toBeVisible(); await expect.poll(() => droppedOperation).not.toBe('');
  const completed = threads.get(firstId)!.turns.at(-1)!; completed.status = 'completed'; threads.get(firstId)!.status = { type: 'idle' };
  emit('turn/completed', { threadId: firstId, turn: completed });
  expect(receipts.list(cwd, firstId).find(receipt => receipt.operationId === droppedOperation)?.status).toBe('completed');
  const startsBeforeReconnect = requests.filter(request => request.method === 'turn/start').length;
  await desktop.locator('.disconnect-banner').getByRole('button', { name: '重新连接', exact: true }).click(); await ready(desktop);
  await expect(choice(desktop)).toHaveAccessibleName('权限：自定义');
  await desktop.reload(); await ready(desktop); await expect(choice(desktop)).toHaveAccessibleName('权限：自定义');
  expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(startsBeforeReconnect);
  checks.push('lost ACK plus unchanged native custom policy recovers the exact completed receipt and releases optimistic Auto after reconnect/reload without resend');

  rejectNext = true; await selectPermission(desktop, 'full-access');
  await desktop.getByLabel('消息', { exact: true }).fill('模拟明确拒绝，保留尚未生效的选择');
  await desktop.getByRole('button', { name: '发送', exact: true }).click();
  await expect(desktop.getByRole('alert').filter({ hasText: 'Simulated rejected permission send' })).toBeVisible();
  expect(receipts.list(cwd, firstId)[0].status).toBe('rejected');
  await desktop.getByRole('button', { name: '查询状态', exact: true }).click(); await ready(desktop);
  await expect(choice(desktop)).toHaveAccessibleName('权限：Full Access');
  unknownNext = true; await selectPermission(desktop, 'auto');
  await desktop.getByLabel('消息', { exact: true }).fill('模拟发送结果未知，禁止重放');
  await desktop.getByRole('button', { name: '发送', exact: true }).click();
  await expect(desktop.getByRole('alert').filter({ hasText: 'Simulated uncertain native transport' })).toBeVisible();
  expect(receipts.list(cwd, firstId)[0].status).toBe('unknown');
  await desktop.getByRole('button', { name: '查询状态', exact: true }).click(); await ready(desktop);
  await expect(choice(desktop)).toHaveAccessibleName('权限：Auto');
  await expect(desktop.getByRole('alert').filter({ hasText: '有发送尚未确认终态' })).toBeVisible();
  await expect(desktop.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  checks.push('rejected and unknown receipts never clear their pending choice; unknown delivery still blocks sending');
  expect(rendererErrors).toEqual([]);
} catch (error) {
  failure = String(error);
  if (desktop && !desktop.isClosed()) await screenshot(desktop, 'failure-desktop').catch(() => {});
  if (phone && !phone.isClosed()) await screenshot(phone, 'failure-mobile').catch(() => {});
  throw error;
} finally {
  releaseTurn?.(); releaseReadback?.();
  await app?.close(); await browser?.close(); await server.close(); db.close();
  await writeFile(join(output, 'report.json'), JSON.stringify({ output, simulatedNative: true, realElectron: true, emulatedAndroid: true, date: new Date().toISOString(), checks, rendererErrors, failure }, null, 2));
  console.log(JSON.stringify({ output, checks, failure }));
}
