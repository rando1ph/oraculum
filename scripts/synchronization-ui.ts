// Authenticated real Bridge + controlled native faults, in Chromium mobile mode.
// Remote mode uses only the existing HTTPS/WSS endpoint and local test listener.
import { chromium, expect, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import { TrustStore } from '../bridge/src/trust-store';
import { ReceiptStore } from '../bridge/src/receipts';
import { ProjectDirectories } from '../bridge/src/projects';
import type { Thread, WireMessage } from '../packages/shared/protocol';

const port = Number(process.env.ORACULUM_SYNC_PORT ?? 17861);
const url = new URL(process.env.ORACULUM_SYNC_URL ?? `http://127.0.0.1:${port}/`);
const remote = url.protocol === 'https:';
if (remote && port !== 17860) throw new Error('Use the approved existing tunnel destination for remote acceptance');
await mkdir('.local/evidence/stage-a', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/stage-a', remote ? 'public-' : 'local-'));
const root = join(output, 'workspaces'), cwd = join(root, 'fixture'), invalid = join(root, 'removed');
await mkdir(cwd, { recursive: true }); await mkdir(invalid);
const trust = new TrustStore(join(output, 'state')), receipts = new ReceiptStore(trust.db);
const projects = new ProjectDirectories(root, cwd, trust.db); await projects.register(cwd); await projects.register(invalid);
const threads = new Map(['long', 'healthy', 'unknown', 'slow', 'stale', 'pending'].map(id => [id, { id, name: id, preview: '', cwd,
  status: { type: 'idle' }, turns: [], parentThreadId: null, source: 'appServer', ephemeral: false } as unknown as Thread]));
const settings = { approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user', model: 'fixture', reasoningEffort: 'low' };
const counts: Record<string, number> = {}, writes: Record<string, number> = {};
let failHistory = true, slowModels = true, failSubscribe = 0, holdStale = false, releaseStale: (() => void) | undefined;
let badCursor = false, badModels = false, newId = 0;
let releasePending: (() => void) | undefined, releaseStart: (() => void) | undefined;
let holdStart = false;
const bus = new EventEmitter();
const emit = (method: string, params: object) => bus.emit('message', { method, params });
const native = Object.assign(bus, { alive: true, send: (_message: WireMessage) => {}, request: async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
  counts[method] = (counts[method] ?? 0) + 1;
  const id = String(params.threadId), thread = threads.get(id);
  let result: unknown;
  if (method === 'config/read') result = { config: { model: 'fixture', model_provider: 'fixture', model_reasoning_effort: 'low', approval_policy: 'on-request', sandbox_mode: 'read-only', approvals_reviewer: 'user' } };
  else if (method === 'model/list') {
    if (slowModels) return new Promise<T>(() => {});
    result = { data: [], nextCursor: badModels ? 'same-model-page' : null };
  } else if (method === 'thread/list') result = { data: [...threads.values()].map(t => ({ ...t, turns: [] })), nextCursor: null };
  else if (method === 'thread/read' || method === 'thread/resume') {
    if (id === 'slow' && failSubscribe-- > 0) return new Promise<T>(() => {});
    if (!thread) throw new Error('Thread no longer exists');
    result = { thread: { ...thread, turns: [] }, ...settings };
  } else if (method === 'thread/turns/list') {
    if (id === 'long' && failHistory) return new Promise<T>(() => {});
    if (id === 'stale' && holdStale) { holdStale = false; await new Promise<void>(yes => { releaseStale = yes; }); }
    const start = Number(params.cursor ?? 0), total = id === 'long' ? 500 : 1;
    result = { data: Array.from({ length: Math.min(Number(params.limit ?? 5), total - start) }, (_, i) => ({ id: `${id}-turn-${total - start - i}`, items: [], status: 'completed' })), nextCursor: start + 5 < total ? String(start + 5) : null };
  } else if (method === 'thread/items/list') {
    const turnId = String(params.turnId), older = !!params.cursor;
    const item = id === 'long' && !older ? { id: `${turnId}-tool`, type: 'commandExecution', command: 'synthetic-long-output', cwd, status: 'completed', aggregatedOutput: 'synthetic-output\n'.repeat(140000), exitCode: 0, commandActions: [] }
      : { id: `${turnId}-${older ? 'old' : 'reply'}`, type: 'agentMessage', text: older ? '更早内容' : '近期消息已恢复', phase: null };
    result = { data: [{ turnId, item }], nextCursor: badCursor ? params.cursor ?? 'bad' : id === 'long' && !older ? 'older-items' : null };
  } else if (method === 'thread/start') {
    const fresh = { ...threads.get('healthy')!, id: `new-${++newId}`, name: 'new isolated session', turns: [] }; threads.set(fresh.id, fresh); result = { thread: fresh, ...settings };
    if (holdStart) { holdStart = false; await new Promise<void>(yes => { releaseStart = yes; }); }
  } else if (method === 'turn/start') {
    writes[id] = (writes[id] ?? 0) + 1;
    if (id === 'pending') return new Promise<T>((_, reject) => { releasePending = () => reject(new Error('挂起发送结果未知，不要重发')); });
    throw new Error('受控 ACK 丢失：执行结果未知，不要重发');
  } else if (method === 'account/rateLimits/read') result = { rateLimits: {}, rateLimitsByLimitId: {} };
  else throw new Error('Unsupported fixture read');
  return structuredClone(result) as T;
} });
const service = new BridgeService(native, cwd, receipts, projects, undefined, undefined, undefined, { readTimeoutMs: 250 });
const server = await createServer(service, port, resolve('apps/web/dist'), { trust,
  ...(remote ? { remoteOrigin: url.origin, remoteBasePath: url.pathname } : {}) });
let remoteRequests = 0;
server.addHook('onRequest', async request => { if (request.headers.host === url.host && request.headers['x-forwarded-proto'] === 'https') remoteRequests++; });
const checks: string[] = [], errors: string[] = [], evidence: Record<string, unknown> = { date: new Date().toISOString(), url: url.href, remote, output, simulatedNative: true, chromiumMobile: true, tlsVerification: true };
let failure = '';
const browser = await chromium.launch({ args: ['--no-proxy-server', '--proxy-server=direct://', '--proxy-bypass-list=*'], env: Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(?:https?|all)_proxy$/i.test(key))) as Record<string, string> });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await context.addInitScript(() => {
  const Native = window.WebSocket;
  const state = window as unknown as { sockets: WebSocket[]; dropMethod: string; lastFrame: string; droppedFrame: string };
  state.sockets = []; state.dropMethod = '';
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols); state.sockets.push(this);
      this.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.type) { state.lastFrame = event.data; if (message.event?.method === state.dropMethod) { state.dropMethod = ''; state.droppedFrame = event.data; event.stopImmediatePropagation(); } }
      });
    }
  };
});
const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
const ready = () => expect(page.locator('.connection-status')).toContainText('状态已查询', { timeout: 20_000 });
async function nav() { if (!await page.locator('.app-shell').evaluate(e => e.classList.contains('drawer-open'))) await page.getByRole('button', { name: '打开导航', exact: true }).click(); }
async function select(id: string, wait = true) { await nav(); await page.locator(`.session-link[data-thread-id="${id}"]`).click(); if (wait) { await ready(); await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', id); } }
async function refresh() { await page.getByRole('button', { name: '会话菜单', exact: true }).click(); await page.getByRole('menuitem', { name: '查询状态', exact: true }).click(); }
async function rpc(method: string, params: object) {
  return page.evaluate(({ method, params }) => new Promise<any>((resolve, reject) => {
    const url = new URL('ws', location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url), id = crypto.randomUUID();
    const timer = setTimeout(() => { ws.close(); reject(new Error('test read timeout')); }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ id, method, params }));
    ws.onmessage = ({ data }) => { const message = JSON.parse(data); if (message.id === id) { clearTimeout(timer); ws.close(); resolve(message); } };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('test read socket failed')); };
  }), { method, params });
}
try {
  await server.listen({ host: '127.0.0.1', port });
  const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 }); evidence.serverAddress = await response!.serverAddr(); evidence.security = await response!.securityDetails();
  if (remote) { expect((evidence.serverAddress as { ipAddress: string }).ipAddress).toBe(url.hostname); expect(evidence.security).toBeTruthy(); }
  await page.getByLabel('设备名称', { exact: true }).fill('Stage A isolated Chromium');
  await page.getByLabel('配对码', { exact: true }).fill(trust.createPairing().code);
  const started = performance.now(); await page.getByRole('button', { name: '配对并连接', exact: true }).click(); await ready();
  evidence.initialReadyMs = Math.round(performance.now() - started);
  expect(evidence.initialReadyMs).toBeLessThan(remote ? 30000 : 5000);
  await expect(page.getByText(/历史加载失败/)).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: join(output, '01-history-timeout.png') });
  await select('healthy'); await page.getByLabel('消息', { exact: true }).fill('independent healthy session'); await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  checks.push('initial state ready before slow model catalog/history; persistent history timeout leaves healthy session usable');
  holdStart = true;
  await nav(); await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect.poll(() => !!releaseStart).toBe(true);
  await select('healthy');
  if (await page.locator('.app-shell').evaluate(element => element.classList.contains('drawer-open'))) await page.getByRole('button', { name: '折叠导航', exact: true }).click();
  await page.getByLabel('消息', { exact: true }).fill('healthy while new-thread ACK is pending');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  const readsBeforeWake = counts['thread/read'];
  await page.evaluate(() => window.dispatchEvent(new Event('oraculum-resume')));
  await expect.poll(() => counts['thread/read']).toBeGreaterThan(readsBeforeWake);
  releaseStart!(); releaseStart = undefined;
  await ready(); await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', 'new-1', { timeout: 20000 });
  expect(counts['thread/start']).toBe(1);
  checks.push('delayed creation ACK survives read reconciliation without blocking healthy sends or repeating thread/start');
  checks.push('new session remains available while another thread history repeatedly times out');
  slowModels = false; badModels = true;
  const catalogReads = counts['model/list'];
  await page.getByRole('button', { name: '重新读取模型目录', exact: true }).click();
  await expect.poll(() => counts['model/list']).toBeGreaterThanOrEqual(catalogReads + 2);
  await expect(page.getByRole('button', { name: '重新读取模型目录', exact: true })).toBeVisible();
  badModels = false; await page.getByRole('button', { name: '重新读取模型目录', exact: true }).click();
  await expect(page.getByRole('button', { name: '重新读取模型目录', exact: true })).toHaveCount(0);
  checks.push('slow and repeated model catalog pagination stays separate from usable session state and recovers manually');
  failHistory = false; await select('long');
  await expect(page.getByText('较长内容已提供预览，可按需分段读取。', { exact: false })).toBeVisible({ timeout: 15000 });
  const snapshot = (await rpc('bridge/history', { threadId: 'long', bounded: true })).result;
  expect(snapshot.thread.turns).toHaveLength(5); expect(JSON.stringify(snapshot).length).toBeLessThan(60000);
  const detail = snapshot.history.details[0], part = (await rpc('bridge/historyText', { threadId: 'long', historyRevision: snapshot.historyRevision, ...detail, offset: 0 })).result;
  expect(part.text.length).toBe(32000); expect(part.nextOffset).toBe(32000);
  await page.getByRole('button', { name: '加载轮次更早内容', exact: true }).first().click();
  await expect(page.getByText('更早内容', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '加载更早历史', exact: true }).click();
  await expect(page.locator('.turn-process')).toHaveCount(10);
  await page.screenshot({ path: join(output, '02-long-history.png') });
  checks.push('500-turn native history loads five turns at a time; multi-megabyte tool output preview is bounded; item/turn pagination and 32k detail segments work');
  badCursor = true;
  const invalidPage = await rpc('bridge/historyItems', { threadId: 'long', turnId: detail.turnId, cursor: 'bad', historyRevision: snapshot.historyRevision });
  expect(invalidPage.error.message).toContain('cursor repeated'); badCursor = false;
  checks.push('repeated native item cursor fails visibly without a global state failure');
  failSubscribe = 1; await select('slow', false); await ready(); await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', 'slow');
  checks.push('WS remains connected while a native metadata read times out; bounded read retry restores the selected thread');
  failSubscribe = 20; await refresh();
  await expect(page.getByText('会话状态查询失败，可重试或选择其他会话。', { exact: false })).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.connection-status')).toContainText('查询失败');
  expect(writes.slow).toBeUndefined();
  failSubscribe = 0; await page.getByRole('button', { name: '重新查询', exact: true }).click(); await ready();
  checks.push('persistent live-WS subscribe failure exhausts bounded retries with a visible manual recovery exit');
  holdStale = true; await select('stale'); await expect.poll(() => !!releaseStale).toBe(true);
  await select('healthy'); releaseStale!(); releaseStale = undefined; await ready(); await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', 'healthy');
  checks.push('switch cancels stale history projection; late old-thread reply cannot revive the previous selection');
  await select('pending'); await page.getByLabel('消息', { exact: true }).fill('pending once'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => writes.pending).toBe(1); await select('healthy');
  await page.getByLabel('消息', { exact: true }).fill('healthy while another mutation is pending'); await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  releasePending!(); releasePending = undefined;
  await select('pending'); await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled(); expect(writes.pending).toBe(1);
  checks.push('a hung mutation and its late unknown result are confined to that thread while a healthy thread remains sendable');
  await select('unknown'); await page.getByLabel('消息', { exact: true }).fill('send once only'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '受控 ACK 丢失' })).toBeVisible();
  await refresh(); await ready(); expect(writes.unknown).toBe(1); await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await context.setOffline(true);
  // Abruptly close only this test Bridge's real sockets. A graceful browser
  // close while offline can legitimately wait for the WS closing handshake.
  for (const socket of server.websocketServer.clients) socket.terminate();
  await expect(page.locator('.connection-status')).toContainText('已断开');
  await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); await ready(); expect(writes.unknown).toBe(1);
  await select('healthy'); await page.getByLabel('消息', { exact: true }).fill('healthy after unknown'); await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  checks.push('unknown send stays blocked across offline/WSS reconnect and is never replayed; unrelated healthy thread remains sendable');
  await page.evaluate(() => { (window as any).dropMethod = 'thread/name/updated'; });
  threads.get('healthy')!.name = 'replayed-name';
  emit('thread/name/updated', { threadId: 'healthy', threadName: 'replayed-name' });
  await expect.poll(() => page.evaluate(() => !!(window as any).droppedFrame)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('oraculum-resume')));
  await expect(page.locator('.conversation-header')).toContainText('replayed-name', { timeout: 20000 });
  await page.evaluate(() => { const state = window as any, socket = state.sockets.find((s: WebSocket) => s.readyState === 1); if (socket) socket.dispatchEvent(new MessageEvent('message', { data: state.droppedFrame })); });
  expect(writes.unknown).toBe(1);
  checks.push('foreground reconciliation restores a deliberately dropped native event via replay/snapshot; duplicate event sequence is ignored without side effects');
  const unsupported = await rpc('unexpected/request', { threadId: 'healthy' }); expect(unsupported.error.message).toMatch(/not exposed/);
  expect(counts['unexpected/request']).toBeUndefined(); await ready();
  checks.push('an unknown RPC is rejected without native dispatch, transport closure or global UI lock');
  await rm(invalid, { recursive: true }); service.emit('event', { type: 'projectsChanged' });
  await nav(); await expect(page.getByRole('button', { name: /removed · 目录失效/ })).toBeDisabled();
  await page.getByRole('button', { name: '折叠导航', exact: true }).click();
  checks.push('removed project is marked unavailable without blocking another registered project');
  await page.screenshot({ path: join(output, '03-recovered.png') });
  expect(errors).toEqual([]); if (remote) expect(remoteRequests).toBeGreaterThan(10);
} catch (error) {
  failure = String(error); await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {}); process.exitCode = 1;
} finally {
  releaseStale?.(); releasePending?.(); releaseStart?.();
  await context.close(); await browser.close(); await server.close();
  for (const device of trust.list()) trust.revoke(device.id);
  trust.close();
  Object.assign(evidence, { checks, counts, writes, errors, failure, remoteRequests, result: failure ? 'failed' : 'passed' });
  await writeFile(join(output, 'report.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ output, checks, failure, result: evidence.result }));
}
