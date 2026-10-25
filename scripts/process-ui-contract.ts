// Real Electron + mobile Chromium with controlled native-protocol fixtures.
// These checks do not replace real Codex execution or Android Debug device QA.
import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import { ReceiptStore } from '../bridge/src/receipts';
import { Themes } from '../bridge/src/themes';
import type { WireMessage } from '../packages/shared/protocol';

const cwd = '/process-fixture', id = 'process-thread-fixture';
const patch = '--- a/sum.ts\n+++ b/sum.ts\n@@ -1 +1 @@\n-export const sum = (a, b) => a - b;\n+export const sum = (a, b) => a + b;\n';
const secondPatch = '--- a/second.ts\n+++ b/second.ts\n@@ -1 +1 @@\n-export const second = false;\n+export const second = true;\n';
const command = (itemId: string, output = 'tests 3\npass 3\nfail 0') => ({ id: itemId, type: 'commandExecution', command: 'node --test sum.test.ts', cwd, status: 'completed', exitCode: 0, durationMs: 25, aggregatedOutput: output });
const message = (itemId: string, text: string, phase: string | null = 'final_answer') => ({ id: itemId, type: 'agentMessage', text, phase });
type FixtureTurn = { id: string; status: string; error: { message: string } | null; itemsView: string; startedAt: number | null; completedAt: number | null; durationMs: number | null; items: any[] };
const turn = (turnId: string, items: any[], fields: Partial<FixtureTurn> = {}): FixtureTurn => ({ id: turnId, status: 'completed', error: null, itemsView: 'full', startedAt: null, completedAt: null, durationMs: null, items, ...fields });
const history = turn('history-known-time', [
  { id: 'user', type: 'userMessage', content: [{ type: 'text', text: '检查真实工具、聚合计数和最终回答。', text_elements: [] }] },
  message('commentary', '先检查函数和测试，再核验结果。', 'commentary'),
  { id: 'reasoning', type: 'reasoning', summary: ['原生公开摘要：先检查边界条件。'], content: [] },
  command('shared-command'),
  { id: 'files', type: 'fileChange', status: 'completed', changes: [
    { path: cwd + '/sum.ts', kind: { type: 'update', move_path: null }, diff: patch },
    { path: cwd + '/sum.test.ts', kind: { type: 'add' }, diff: '+test(sum(1, 2) === 3);' },
    // Repeated changes to the same path must not inflate the file count.
    { path: cwd + '/sum.ts', kind: { type: 'update', move_path: null }, diff: patch },
  ] },
  { id: 'mcp', type: 'mcpToolCall', server: 'fixture', tool: 'read_reference', arguments: { query: 'arithmetic' }, status: 'completed', result: { content: [{ type: 'text', text: 'MCP_REFERENCE_RESULT' }] }, error: null, durationMs: 42 },
  { id: 'native-plan', type: 'plan', text: '原生历史计划：检查、修改、验证。' },
  message('answer', '## 验证完成\n\n最终回答始终显示，**测试全部通过**。'),
  message('unphased', '未标注阶段的原生回答保留。', null),
  { id: 'legacy-answer', type: 'agentMessage', text: '旧协议没有 phase 的回答也保留。' },
  message('future-phase-answer', '未知阶段不猜测用途，保留可读。', 'future_phase'),
], { startedAt: 1_700_000_000, completedAt: 1_700_000_070, durationMs: 70_000 });
const untimed = turn('history-no-time', [
  message('untimed-progress', '没有时间数据的历史过程。', 'commentary'),
  message('reading', Array.from({ length: 38 }, (_, i) => `段落 ${i + 1}：长会话阅读位置应在流式更新、历史前插和重连时保持。`).join('\n\n')),
]);
const earlier = turn('earlier-history', [command('shared-command', 'OLDER_NATIVE_OUTPUT'), message('earlier-answer', '更早的原生历史。\n\n'.repeat(24))]);
const thread: any = { id, name: '执行过程 · 模拟合约', cwd, preview: '', status: { type: 'idle' }, turns: [history, untimed] };
const bus = new EventEmitter(), requests: string[] = [], replies: WireMessage[] = [];
let historyEnabled = false, releaseHistory: (() => void) | undefined;
const emit = (method: string, params: object) => bus.emit('message', { method, params: { threadId: id, ...params } });
const codex = {
  on: bus.on.bind(bus),
  send: (reply: WireMessage) => { replies.push(reply); emit('serverRequest/resolved', { requestId: reply.id }); },
  request: async <T>(method: string, params: any): Promise<T> => {
    requests.push(method); let result: unknown;
    if (method === 'config/read') result = { config: { model: 'fixture', model_provider: 'fixture' } };
    else if (method === 'model/list') result = { data: [], nextCursor: null };
    else if (method === 'thread/list') result = { data: [thread], nextCursor: null };
    else if (method === 'thread/read') result = { thread };
    else if (method === 'thread/resume') result = { thread, approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user' };
    else if (method === 'thread/turns/list') {
      if (params.cursor === 'earlier') {
        await new Promise<void>(accept => { releaseHistory = accept; });
        result = { data: [earlier], nextCursor: null };
      } else result = { data: [...thread.turns].reverse(), nextCursor: historyEnabled ? 'earlier' : null };
    } else if (method === 'thread/items/list') {
      const source = params.turnId === earlier.id ? earlier : thread.turns.find((item: any) => item.id === params.turnId);
      result = { data: source.items.map((item: any) => ({ turnId: params.turnId, item })), nextCursor: null };
    } else if (method === 'turn/interrupt') {
      const active = thread.turns.at(-1); active.status = 'interrupted'; thread.status = { type: 'idle' };
      emit('turn/completed', { turn: active }); emit('thread/status/changed', { status: thread.status }); result = {};
    } else throw new Error(`Unexpected process fixture request: ${method}`);
    return structuredClone(result) as T;
  },
};
await mkdir('.local/evidence/phase4d4/process-contract', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/phase4d4/process-contract/run-'));
const themes = new Themes({ source: resolve('themes'), installed: join(output, 'installed-themes') });
for (const value of ['test-violet', 'minimal-light', 'hong-kong-rain']) await themes.install(value);
const db = new DatabaseSync(':memory:'), receipts = new ReceiptStore(db);
const service = new BridgeService(codex, cwd, receipts), port = Number(process.env.ORACULUM_PROCESS_UI_PORT ?? '17877'), origin = `http://127.0.0.1:${port}`;
const makeServer = () => createServer(service, port, resolve('apps/web/dist'), { themes, testOnlyUnauthenticated: true });
let server = await makeServer();
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron-profile') });
let app: ElectronApplication | undefined, browser: Browser | undefined, desktop: Page | undefined, phone: Page | undefined;
const checks: string[] = [], errors: string[] = [];
let failure: string | undefined;
const ready = (page: Page) => expect(page.locator('.connection-status')).toContainText('状态已查询', { timeout: 15_000 });
const group = (page: Page, turnId: string) => page.locator(`.turn-process[data-turn-id="${turnId}"]`);
const item = (page: Page, turnId: string, itemId: string) => group(page, turnId).locator(`[data-item-id="${itemId}"]`);
const top = (page: Page) => page.locator('.conversation-scroll').evaluate(element => element.scrollTop);
const record = (value: string) => { checks.push(value); console.log('PASS ' + value); };
async function expandDetails(details: Locator) {
  if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
}
async function expand(page: Page, turnId: string, value = true) {
  const toggle = group(page, turnId).locator('.process-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== String(value)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', String(value));
}
async function noHistoryWarning(page: Page) {
  await expect(page.locator('.conversation-content')).not.toContainText(/部分历史未能恢复|历史不完整|历史缺失/);
  await expect(page.locator('.session-details, .events, [data-testid="send-receipt"]')).toHaveCount(0);
}
async function completed(page: Page) {
  const block = group(page, history.id);
  await expect(block.locator('.process-toggle')).toHaveText('已完成 · 用时 1 分 10 秒');
  await expect(block.locator('.process-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(block.locator('.process-counts')).toHaveText('1 条命令 · 2 个文件 · 1 次工具调用');
  for (const itemId of ['commentary', 'reasoning', 'shared-command', 'files', 'mcp', 'native-plan']) await expect(item(page, history.id, itemId)).toBeHidden();
  for (const itemId of ['user', 'answer', 'unphased', 'legacy-answer', 'future-phase-answer']) {
    await expect(item(page, history.id, itemId)).toBeVisible();
    await expect(item(page, history.id, itemId)).not.toHaveClass(/process-records/);
  }
  await expect(group(page, untimed.id).locator('.process-toggle')).toHaveText('已完成');
  await noHistoryWarning(page);
}
async function theme(page: Page, value: string) {
  if (page === phone) await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('当前主题')).toBeEnabled(); await page.getByLabel('当前主题').selectOption(value);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme-id', value);
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  if (page === phone) await page.getByRole('button', { name: '折叠导航', exact: true }).click();
}
function start(active: any) {
  thread.turns.push(active); thread.status = { type: 'active', activeFlags: [] };
  emit('turn/started', { turn: active }); emit('thread/status/changed', { status: thread.status });
}
function add(active: any, value: any, complete = false) {
  active.items.push(value); emit(complete ? 'item/completed' : 'item/started', { turnId: active.id, item: value });
}
function finish(active: any, status = 'completed') {
  active.status = status; thread.status = { type: 'idle' };
  emit('turn/completed', { turn: active }); emit('thread/status/changed', { status: thread.status });
}
try {
  await server.listen({ host: '127.0.0.1', port });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  await expect.poll(() => app!.windows().some(page => page.url().startsWith(origin)), { timeout: 15_000 }).toBe(true);
  desktop = app.windows().find(page => page.url().startsWith(origin))!; desktop.on('pageerror', error => errors.push(error.message)); await ready(desktop);
  browser = await chromium.launch();
  phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36 OraculumAndroid/1' });
  phone.on('pageerror', error => errors.push(error.message)); await phone.goto(origin); await ready(phone);
  const pages = [desktop, phone];
  for (const page of pages) {
    await completed(page); await expand(page, history.id);
    const order = await group(page, history.id).locator('.turn-records > [data-item-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-item-id')));
    expect(order).toEqual(history.items.map(value => value.id));
    await expandDetails(item(page, history.id, 'shared-command').locator('details'));
    await expect(item(page, history.id, 'shared-command').getByLabel('命令输出')).toHaveText('tests 3\npass 3\nfail 0');
    await expect(item(page, history.id, 'shared-command')).toContainText('退出码 0');
    await expandDetails(item(page, history.id, 'reasoning').locator('details'));
    await expect(item(page, history.id, 'reasoning')).toContainText('原生公开摘要');
    await expandDetails(item(page, history.id, 'mcp').locator('details'));
    await expect(item(page, history.id, 'mcp')).toContainText('arithmetic'); await expect(item(page, history.id, 'mcp')).toContainText('MCP_REFERENCE_RESULT');
    await item(page, history.id, 'files').getByRole('button', { name: '查看 Diff', exact: true }).first().click();
    await expect(page.locator('.cm-content')).toContainText('a + b'); expect(await page.locator('.cm-content').getAttribute('contenteditable')).not.toBe('true');
    await page.getByRole('button', { name: '关闭面板', exact: true }).click();
    await expand(page, history.id, false); await completed(page);
    await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: join(output, `completed-${page === phone ? 'mobile' : 'electron'}.png`) });
  }
  record('completed turns collapse only native process items; known 70-second duration and deduplicated native counts; final/null/legacy/unknown-phase answers remain visible; expanded order, output, MCP input/result and read-only Diff');

  for (const page of pages) {
    const toggle = group(page, history.id).locator('.process-toggle');
    await toggle.focus(); await toggle.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true'); await expect(toggle).toBeFocused();
    await expect(item(page, history.id, 'commentary')).toBeVisible();
    const controls = await toggle.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    expect(await page.evaluate(controlId => !!controlId && !!document.getElementById(controlId), controls)).toBe(true);
    await page.reload(); await ready(page);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(item(page, history.id, 'commentary')).toBeVisible(); await expect(item(page, history.id, 'answer')).toBeVisible();
    await toggle.focus(); await toggle.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await expect(toggle).toBeFocused();
    await page.reload(); await ready(page); await completed(page);
  }
  record('Enter/Space operate the native disclosure button with focus and aria-expanded intact; manually expanded process survives reload, and closing it restores persistent collapsed state on both clients');

  for (const value of ['test-violet', 'minimal-light', 'hong-kong-rain']) for (const page of pages) {
    await theme(page, value); await completed(page); await expand(page, history.id);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const toggle = (await group(page, history.id).locator('.process-toggle').boundingBox())!;
    expect(toggle.height).toBeGreaterThanOrEqual(page === phone ? 48 : 44);
    const composer = (await page.locator('.composer').boundingBox())!;
    expect(composer.y + composer.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight + 1));
    await expect(item(page, history.id, 'user').locator('.message-name')).toHaveText('你');
    await expect(item(page, history.id, 'answer').locator('.message-name')).toHaveText('Codex');
    await expand(page, history.id, false);
  }
  for (const page of pages) await theme(page, 'oracle-eye');
  record('Violet, Minimal Light and Hong Kong Rain retain process controls, accepted message cards, Composer and 390px mobile geometry');

  const active = turn('live-process', [], { status: 'inProgress', startedAt: Date.now() / 1000 - 5 }); start(active);
  for (const page of pages) {
    await expect(group(page, active.id).locator('.process-status')).toContainText(/执行中 · 已运行 \d+ 秒/);
    await expect(group(page, active.id).locator('.process-toggle')).toHaveCount(0);
  }
  await phone.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 350; });
  const readingTop = await top(phone);
  const progress = message('live-progress', '正在检查', 'commentary'); add(active, progress);
  progress.text += '本轮原生执行。'; emit('item/agentMessage/delta', { turnId: active.id, itemId: progress.id, delta: '本轮原生执行。' });
  const reasoning = { id: 'live-reasoning', type: 'reasoning', summary: [''], content: [] }; add(active, reasoning);
  reasoning.summary[0] = '检查边界条件后运行测试。'; emit('item/reasoning/summaryTextDelta', { turnId: active.id, itemId: reasoning.id, summaryIndex: 0, delta: reasoning.summary[0] });
  const liveCommand = { ...command('live-command', ''), status: 'inProgress', exitCode: null, durationMs: null }; add(active, liveCommand);
  liveCommand.aggregatedOutput = 'STREAMING_OUTPUT'; emit('item/commandExecution/outputDelta', { turnId: active.id, itemId: liveCommand.id, delta: liveCommand.aggregatedOutput });
  const plan = { id: 'live-plan', type: 'plan', text: '流式计划：' }; add(active, plan);
  plan.text += '验证工具结果'; emit('item/plan/delta', { turnId: active.id, itemId: plan.id, delta: '验证工具结果' });
  emit('turn/plan/updated', { turnId: active.id, explanation: 'PLAN_FOR_FIRST_TURN', plan: [{ step: '验证第一轮', status: 'inProgress' }] });
  emit('turn/diff/updated', { turnId: active.id, diff: patch });
  const mcp = { id: 'live-mcp', type: 'mcpToolCall', server: 'fixture', tool: 'read_reference', arguments: { query: 'live' }, status: 'inProgress', result: null, error: null, durationMs: null }; add(active, mcp);
  emit('item/mcpToolCall/progress', { turnId: active.id, itemId: mcp.id, message: '原生 MCP 正在检索参考资料' });
  for (const page of pages) {
    await expect(item(page, active.id, progress.id)).toContainText('正在检查本轮原生执行。');
    await expect(item(page, active.id, reasoning.id).locator('.tool-body')).toBeVisible();
    await expect(item(page, active.id, reasoning.id)).toContainText(reasoning.summary[0]);
    await expect(item(page, active.id, plan.id)).toContainText('流式计划：验证工具结果');
    await expect(item(page, active.id, mcp.id).getByText('原生 MCP 正在检索参考资料', { exact: true }).first()).toBeVisible();
    await expect(group(page, active.id).locator('.current-plan')).toContainText('PLAN_FOR_FIRST_TURN');
  }
  await expect.poll(() => top(phone!)).toBeCloseTo(readingTop, 0);
  await expect(phone.getByRole('button', { name: '返回最新', exact: true })).toBeVisible();
  for (const page of pages) {
    await expandDetails(item(page, active.id, liveCommand.id).locator('details'));
    await expect(item(page, active.id, liveCommand.id).getByLabel('命令输出')).toHaveText('STREAMING_OUTPUT');
  }
  Object.assign(liveCommand, { status: 'completed', exitCode: 0, durationMs: 200 }); emit('item/completed', { turnId: active.id, item: liveCommand });
  Object.assign(mcp, { status: 'completed', result: { content: [{ type: 'text', text: 'LIVE_MCP_RESULT' }] }, durationMs: 80 }); emit('item/completed', { turnId: active.id, item: mcp });
  add(active, { ...history.items.find(value => value.id === 'files'), id: 'live-files' }, true);
  add(active, message('live-final', '本轮最终回答正常显示。'), true);
  active.durationMs = 70_000; active.completedAt = active.startedAt! + 70; finish(active);
  for (const page of pages) {
    await expect(group(page, active.id).locator('.process-toggle')).toHaveText('已完成 · 用时 1 分 10 秒');
    await expect(group(page, active.id).locator('.process-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(item(page, active.id, progress.id)).toBeHidden(); await expect(item(page, active.id, 'live-final')).toBeVisible();
    await expect(group(page, active.id).locator('.process-counts')).toHaveText('1 条命令 · 2 个文件 · 1 次工具调用');
    await expand(page, active.id); await expect(item(page, active.id, mcp.id)).toContainText('LIVE_MCP_RESULT');
    await group(page, active.id).getByRole('button', { name: '查看变更 Diff', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('a + b'); await page.getByRole('button', { name: '关闭面板', exact: true }).click();
  }
  record('running native commentary/reasoning/plan/command/MCP deltas and elapsed time appear live without pulling an earlier reader; completion collapses process automatically and keeps final answer/output/Diff available');

  const second = turn('second-live-process', [], { status: 'inProgress', startedAt: Date.now() / 1000 }); start(second);
  add(second, message('second-progress', '第二轮进度。', 'commentary'));
  emit('turn/plan/updated', { turnId: second.id, explanation: 'PLAN_FOR_SECOND_TURN', plan: [{ step: '验证第二轮', status: 'inProgress' }] });
  emit('turn/diff/updated', { turnId: second.id, diff: secondPatch });
  for (const page of pages) {
    await expect(group(page, active.id).locator('.current-plan')).toContainText('PLAN_FOR_FIRST_TURN');
    await expect(group(page, active.id)).not.toContainText('PLAN_FOR_SECOND_TURN');
    await expect(group(page, second.id).locator('.current-plan')).toContainText('PLAN_FOR_SECOND_TURN');
    await group(page, second.id).getByRole('button', { name: '查看变更 Diff', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('second = true'); await expect(page.locator('.cm-content')).not.toContainText('a + b');
    await page.getByRole('button', { name: '关闭面板', exact: true }).click();
  }
  for (const [requestId, choice] of [[401, '允许本次'], [402, '拒绝']] as const) {
    bus.emit('message', { id: requestId, method: 'item/commandExecution/requestApproval', params: { threadId: id, turnId: second.id, itemId: 'approval-command', command: 'printf PROCESS_APPROVAL', cwd, reason: '执行过程审批合约' } });
    for (const page of pages) {
      await expect(group(page, second.id).locator('.process-status')).toContainText('待审批');
      await expect(page.locator('.approval')).toBeVisible(); await expect(page.locator('.approval').locator('xpath=ancestor::*[contains(@class,"process-records")]')).toHaveCount(0);
    }
    await phone.getByRole('button', { name: choice, exact: true }).click();
    for (const page of pages) await expect(page.locator('.approval')).toHaveCount(0);
  }
  expect(replies.map(reply => reply.result)).toEqual([{ decision: 'accept' }, { decision: 'decline' }]);
  await phone.getByRole('button', { name: '停止', exact: true }).click();
  for (const page of pages) {
    await expect(group(page, second.id).locator('.process-status')).toContainText('已中断');
    await expect(group(page, second.id).locator('.process-toggle')).toHaveCount(0); await expect(item(page, second.id, 'second-progress')).toBeVisible();
  }
  const failed = turn('failed-process', [message('failed-progress', '失败轮次进度仍可见。', 'commentary'), { ...command('failed-command', 'SIMULATED_TOOL_FAILURE'), status: 'failed', exitCode: 7 }], { status: 'inProgress' });
  start(failed); failed.error = { message: 'SIMULATED_TURN_FAILURE' } as any; finish(failed, 'failed');
  const recovered = turn('completed-with-error', [message('foldable-progress', '其余过程可折叠。', 'commentary'), { ...command('declined-command', ''), status: 'declined', exitCode: null }, { ...command('error-command', 'ACTIONABLE_TOOL_ERROR'), status: 'failed', exitCode: 2 }, message('recovered-final', '已说明工具失败的最终回答。')], { status: 'inProgress' });
  start(recovered); finish(recovered);
  for (const page of pages) {
    await expect(group(page, failed.id).locator('.process-status')).toContainText('执行失败'); await expect(group(page, failed.id).getByRole('alert')).toContainText('SIMULATED_TURN_FAILURE');
    await expect(item(page, failed.id, 'failed-progress')).toBeVisible(); await expect(group(page, failed.id).locator('.process-toggle')).toHaveCount(0);
    await expect(group(page, recovered.id).locator('.process-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(item(page, recovered.id, 'foldable-progress')).toBeHidden();
    for (const itemId of ['declined-command', 'error-command', 'recovered-final']) await expect(item(page, recovered.id, itemId)).toBeVisible();
  }
  record('per-turn plans and aggregate Diffs do not leak into another turn; pending approvals stay outside folding and allow/decline synchronize; interrupted/failed turns remain open and failed/declined tool rows remain visible after successful completion');

  for (const value of ['oracle-eye', 'test-violet', 'hong-kong-rain', 'minimal-light']) for (const page of pages) {
    await theme(page, value);
    for (const turnId of [second.id, failed.id]) {
      await expect(group(page, turnId).locator('.process-label')).toBeVisible();
      await expect(group(page, turnId).locator('.process-toggle')).toHaveCount(0);
    }
    await expect(group(page, failed.id).getByRole('alert')).toBeVisible();
    await expect(item(page, recovered.id, 'error-command')).toBeVisible();
    await expect(item(page, recovered.id, 'recovered-final')).toBeVisible();
  }
  record('all four themes keep interrupted/failed status, actionable tool errors and final answers visible on desktop/mobile');
  for (const page of pages) await theme(page, 'oracle-eye');

  historyEnabled = true;
  await phone.reload(); await ready(phone); await completed(phone);
  await phone.getByRole('button', { name: '加载更早历史', exact: true }).click(); await expect.poll(() => !!releaseHistory).toBe(true);
  await phone.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 500; });
  const anchor = item(phone, untimed.id, 'reading').locator('.markdown p').nth(8), anchorY = (await anchor.boundingBox())!.y;
  releaseHistory!(); releaseHistory = undefined;
  await expect(group(phone, earlier.id)).toHaveCount(1);
  await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - anchorY)).toBeLessThanOrEqual(1);
  await expand(phone, earlier.id); await expand(phone, history.id);
  await expect(item(phone, earlier.id, 'shared-command')).toHaveCount(1); await expect(item(phone, history.id, 'shared-command')).toHaveCount(1);
  await expect(item(phone, earlier.id, 'shared-command')).toContainText('OLDER_NATIVE_OUTPUT');
  await expect(item(phone, history.id, 'shared-command')).not.toContainText('OLDER_NATIVE_OUTPUT');
  await expand(phone, history.id, false);
  record('reload restores native turns without fabricated elapsed time; delayed history prepend preserves current reading anchor and repeated item IDs remain scoped to their native turn');

  const unknownOperation = '00000000-0000-4000-8000-000000000044';
  receipts.reserve(unknownOperation, cwd, id, 'fixture-device');
  await desktop.getByRole('button', { name: '查询状态', exact: true }).click(); await ready(desktop);
  await expect(desktop.getByRole('alert').filter({ hasText: '有发送尚未确认终态' })).toContainText('禁止重发');
  await desktop.getByLabel('消息', { exact: true }).fill('未知发送仍阻止重复操作'); await expect(desktop.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await phone.getByLabel('消息', { exact: true }).fill('重连后保留草稿');
  await server.close(); await expect(phone.locator('.disconnect-banner')).toContainText('主机任务不会因此停止');
  server = await makeServer(); await server.listen({ host: '127.0.0.1', port });
  await phone.getByRole('button', { name: '重新连接', exact: true }).click(); await ready(phone);
  await expect(phone.getByLabel('消息', { exact: true })).toHaveValue('重连后保留草稿'); await expect(phone.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  for (const page of pages) {
    await expect(item(page, history.id, 'answer')).toBeVisible(); await noHistoryWarning(page);
    await expect(group(page, history.id).locator('.process-toggle')).toHaveText('已完成 · 用时 1 分 10 秒');
  }
  expect(requests).not.toContain('turn/start'); expect(errors).toEqual([]);
  record('unknown-send remains visible and blocks repeat sends; disconnect/reconnect preserves draft, known native elapsed time, final answers and process identity without replay or history-completeness warnings');
} catch (error) {
  failure = String(error);
  for (const [name, page] of [['electron', desktop], ['mobile', phone]] as const) if (page && !page.isClosed()) await page.screenshot({ path: join(output, `failure-${name}.png`) }).catch(() => {});
  throw error;
} finally {
  releaseHistory?.(); await app?.close(); await browser?.close(); await server.close(); db.close();
  await writeFile(join(output, 'report.json'), JSON.stringify({ date: new Date().toISOString(), realElectron: true, emulatedAndroid: true, nativeCodex: false, nativeAndroid: false, checks, errors, failure, passed: !failure }, null, 2));
  console.log(JSON.stringify({ output, checks: checks.length, passed: !failure, failure }));
}
