// Deterministic Electron UI checks. All Codex messages in this file are simulated.
import { EventEmitter } from 'node:events';
import { _electron as electron, chromium, expect, type ElectronApplication, type Browser } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import type { WireMessage } from '../packages/shared/protocol';
import { TrustStore } from '../bridge/src/trust-store';
import { loopbackTlsFixture } from './loopback-tls-fixture';
import { basePath } from '../packages/shared/entry';

const cwd = '/controlled-workspace';
const thread: any = { id: 'ui-thread', name: '模拟会话', preview: '', cwd, model: 'fixture-model', reasoningEffort: 'low', status: { type: 'idle' }, turns: [] };
const turn: any = { id: 'ui-turn', status: 'inProgress', items: [], error: null, itemsView: 'full' };
const patch = '--- a/sum.js\n+++ b/sum.js\n@@ -1 +1 @@\n-export const sum = (a,b) => a-b;\n+export const sum = (a,b) => a+b;\n';
const bus = new EventEmitter();
let starts = 0;
let decision: unknown;
const emit = (method: string, params: object) => bus.emit('message', { method, params: { threadId: thread.id, turnId: turn.id, ...params } });
const completeItem = (item: any) => { turn.items.push(item); emit('item/completed', { item }); };
const codex = {
  on: bus.on.bind(bus),
  request: async <T>(method: string, params: any): Promise<T> => {
    let response: any = {};
    if (method === 'config/read') response = { config: { model: 'fixture-model', model_reasoning_effort: 'low', model_provider: 'fixture' } };
    if (method === 'model/list') response = { data: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], nextCursor: null };
    if (method === 'thread/list') response = { data: [thread], nextCursor: null };
    if (method === 'thread/read' || method === 'thread/start' || method === 'thread/resume') response = { thread };
    if (method === 'thread/turns/list') response = { data: thread.turns, nextCursor: null };
    if (method === 'thread/items/list') response = { data: turn.items.map((item: any) => ({ turnId: turn.id, item })), nextCursor: null };
    if (method === 'turn/start') {
      starts++; thread.status = { type: 'active', activeFlags: [] }; thread.turns = [turn];
      setTimeout(() => {
        emit('turn/started', { turn });
        emit('thread/status/changed', { status: thread.status });
        completeItem({ type: 'userMessage', id: 'user', content: params.input });
        completeItem({ type: 'agentMessage', id: 'message', text: '## 验证结果\n\n**Markdown** 与代码：\n\n```js\nconst sum = (a, b) => a + b;\n```\n\n<script>window.BAD=true</script>\n[unsafe](javascript:alert(1))' });
        completeItem({ type: 'commandExecution', id: 'command', command: 'node --test', cwd, status: 'completed', exitCode: 0, durationMs: 42, aggregatedOutput: 'tests 1\npass 1\nfail 0' });
        completeItem({ type: 'fileChange', id: 'file', status: 'completed', changes: [{ path: 'sum.js', kind: { type: 'update', move_path: null }, diff: patch }] });
        emit('turn/diff/updated', { diff: patch });
        bus.emit('message', { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: thread.id, turnId: turn.id, itemId: 'approval-command', command: 'printf UI_OK', cwd, reason: 'Simulated safe approval' } });
      }, 30);
      response = { turn };
    }
    return response as T;
  },
  send: (message: WireMessage) => {
    expect(message.id).toBe(7); decision = message.result;
    emit('serverRequest/resolved', { requestId: 7 });
    turn.status = 'completed'; thread.status = { type: 'idle' };
    emit('turn/completed', { turn }); emit('thread/status/changed', { status: thread.status });
  },
};
const service = new BridgeService(codex, cwd);
const remoteBase = process.env.ORACULUM_TEST_REMOTE_BASE;
const proxy = remoteBase ? await loopbackTlsFixture(17861) : undefined;
const state = proxy ? await mkdtemp(resolve(tmpdir(), 'oraculum-ui-trust-')) : undefined;
const trust = state ? new TrustStore(state) : undefined;
const server = await createServer(service, 17861, resolve('apps/web/dist'), proxy
  ? { trust, remoteOrigin: proxy.origin, remoteBasePath: remoteBase }
  : { testOnlyUnauthenticated: true });
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
env.ORACULUM_URL = 'http://127.0.0.1:17861';
const profile = await mkdtemp(resolve(tmpdir(), 'oraculum-ui-contract-profile-'));
env.ORACULUM_USER_DATA_DIR = profile;
let app: ElectronApplication | undefined;
let browser: Browser | undefined;
const evidence: Record<string, unknown> = { simulated: true, date: new Date().toISOString() };
try {
  await mkdir('.local/evidence/phase1', { recursive: true });
  await server.listen({ host: '127.0.0.1', port: 17861 });
  if (proxy) browser = await chromium.launch({ args: ['--no-proxy-server'] });
  else app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  const page = browser ? await browser.newPage({ ignoreHTTPSErrors: true }) : await app!.firstWindow();
  const paths: string[] = [];
  page.on('request', req => paths.push(new URL(req.url()).pathname));
  const sockets: string[] = [];
  page.on('websocket', ws => sockets.push(new URL(ws.url()).pathname));
  if (proxy) {
    await page.context().grantPermissions(['clipboard-write'], { origin: proxy.origin });
    await page.goto(proxy.origin + basePath(remoteBase));
    await expect(page.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible();
    await page.getByLabel('设备名称', { exact: true }).fill('Isolated HTTPS fixture');
    await page.getByLabel('配对码', { exact: true }).fill(trust!.createPairing().code);
    await page.getByRole('button', { name: '配对并连接', exact: true }).click();
  }
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await expect(page.getByRole('status')).toContainText('状态已查询');
  await page.getByLabel('消息', { exact: true }).fill('Controlled UI fixture');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('heading', { name: '需要审批', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '验证结果', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).BAD)).toBeUndefined();
  expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
  await page.locator('.command summary').click();
  await expect(page.getByLabel('命令输出')).toContainText('pass 1');
  await page.getByRole('button', { name: '查看 Diff', exact: true }).click();
  await expect(page.getByLabel('文件 Diff 面板')).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('a+b');
  expect(await page.locator('.cm-content').getAttribute('contenteditable')).not.toBe('true');
  await page.locator('.inspector .copy').click();
  await expect(page.locator('.inspector .copy')).toHaveText('已复制');
  expect(await page.evaluate(async () => {
    try { await navigator.clipboard.readText(); return 'unexpectedly allowed'; }
    catch { return 'denied'; }
  })).toBe('denied');
  await page.screenshot({ path: '.local/evidence/phase1/simulated-diff.png', fullPage: true });
  await page.getByRole('button', { name: '允许本次', exact: true }).click();
  await expect(page.getByTestId('last-turn-status')).toHaveText('completed');
  expect(decision).toEqual({ decision: 'accept' }); expect(starts).toBe(1);
  await page.getByRole('button', { name: '查询状态', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('状态已查询');
  await expect(page.locator('.history-warning').first()).toContainText('部分历史未能恢复');
  expect(await page.locator('[data-item-id="file"]').count()).toBe(1);
  turn.status = 'failed'; turn.error = { message: 'Simulated provider failure' };
  emit('turn/started', { turn: { ...turn, status: 'inProgress' } });
  emit('error', { error: turn.error, willRetry: false });
  emit('turn/completed', { turn });
  await expect(page.getByTestId('last-turn-status')).toHaveText('failed');
  await expect(page.getByRole('alert')).toContainText('Simulated provider failure');
  await page.setViewportSize({ width: 393, height: 851 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/evidence/phase1/simulated-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
  if (proxy) {
    expect(paths.every(path => path.startsWith(basePath(remoteBase)))).toBe(true);
    expect(paths.some(path => /\/assets\/diff-.*\.js$/.test(path))).toBe(true);
    expect(sockets).toEqual([basePath(remoteBase) + 'ws']);
    const cookies = await page.context().cookies();
    expect(cookies).toEqual([expect.objectContaining({ name: '__Secure-oraculum_session', path: basePath(remoteBase), secure: true, httpOnly: true, sameSite: 'Strict' })]);
    expect(await page.evaluate(() => document.cookie)).toBe('');
    await page.reload();
    await expect(page.getByRole('status')).toContainText('状态已查询');
    await expect(page.getByTestId('thread-id')).toHaveText(thread.id);
    trust!.revoke(trust!.list()[0].id);
    await expect(page.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible({ timeout: 10_000 });
    evidence.remote = { base: basePath(remoteBase), transport: 'loopback TLS fixture with isolated test-browser certificate exception; not public TLS', resources: paths, sockets, reload: true, revoked: true };
  }
  evidence.result = 'passed'; evidence.checks = ['Markdown/XSS', 'command output', 'read-only CodeMirror diff and copy', 'allow approval', 'native snapshot', 'item dedup', 'failed turn and error', '393px layout'];
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  // Authenticated fixtures may fail while a secret is in an input: do not dump
  // Playwright call arguments or page snapshots into logs/evidence.
  evidence.failure = proxy ? (error instanceof Error ? error.name : 'Error') : String(error);
  if (proxy) { console.error('HTTPS UI fixture failed; sensitive assertion details omitted.'); process.exitCode = 1; }
  else throw error;
}
finally {
  await app?.close(); await browser?.close(); await server.close(); await proxy?.close(); trust?.close();
  await rm(profile, { recursive: true, force: true });
  if (state) await rm(state, { recursive: true });
  const dir = proxy ? '.local/evidence/phase2/configurable-entry' : '.local/evidence/phase1';
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/ui-contract${proxy ? basePath(remoteBase).replaceAll('/', '-') : ''}.json`, JSON.stringify(evidence, null, 2));
}
