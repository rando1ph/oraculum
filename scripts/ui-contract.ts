// Deterministic Electron UI checks. All Codex messages in this file are simulated.
import { EventEmitter } from 'node:events';
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import type { WireMessage } from '../packages/shared/protocol';

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
        completeItem({ type: 'userMessage', id: 'user', content: [{ type: 'text', text: params.text }] });
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
const server = await createServer(service, 17861, resolve('apps/web/dist'));
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
env.ORACULUM_URL = 'http://127.0.0.1:17861';
let app: ElectronApplication | undefined;
const evidence: Record<string, unknown> = { simulated: true, date: new Date().toISOString() };
try {
  await mkdir('.local/evidence/phase1', { recursive: true });
  await server.listen({ host: '127.0.0.1', port: 17861 });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  const page = await app.firstWindow();
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
  evidence.result = 'passed'; evidence.checks = ['Markdown/XSS', 'command output', 'read-only CodeMirror diff and copy', 'allow approval', 'native snapshot', 'item dedup', 'failed turn and error', '393px layout'];
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) { evidence.failure = String(error); throw error; }
finally { await app?.close(); await server.close(); await writeFile('.local/evidence/phase1/ui-contract.json', JSON.stringify(evidence, null, 2)); }
