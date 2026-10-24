// Deterministic UI regression contracts, using simulated Codex responses only.
// This is not evidence of native Codex or real-workflow acceptance.
import { EventEmitter } from 'node:events';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import type { WireMessage } from '../packages/shared/protocol';

const cwd = '/controlled-workspace';
const recentId = 'contract-recent';
const olderId = 'contract-older-page-2';
const historicalTurn = { id: 'history', status: 'completed', error: null, itemsView: 'full', items: [
  { type: 'agentMessage', id: 'history-message', text: Array.from({ length: 50 }, (_, i) => `段落 ${i + 1}：用于检查阅读锚点、长输入框和滚动按钮的确定性模拟文本。`).join('\n\n') },
] };
const earlierTurn = { id: 'earlier-history', status: 'completed', error: null, itemsView: 'full', items: [
  { type: 'agentMessage', id: 'earlier-message', text: '载入的更早历史。\n\n'.repeat(30) },
] };
const threads: Record<string, any> = Object.fromEntries([recentId, olderId].map(id => [id, {
  id, name: id === recentId ? '近期模拟会话' : '第二页模拟会话', preview: '', cwd,
  model: 'contract-model', reasoningEffort: 'low', status: { type: 'idle' }, turns: id === recentId ? [historicalTurn] : [],
}]));
const bus = new EventEmitter();
let nextAck: (() => void) | undefined;
let sendingTurn: any;
let historyEnabled = false;
let releaseHistory: (() => void) | undefined;
const requests: { method: string; params: any }[] = [];
const emit = (method: string, params: object) => bus.emit('message', { method, params });
const codex = {
  on: bus.on.bind(bus),
  request: async <T>(method: string, params: any): Promise<T> => {
    requests.push({ method, params });
    let response: any;
    if (method === 'config/read') response = { config: { model: 'contract-model', model_reasoning_effort: 'low', model_provider: 'fixture' } };
    else if (method === 'model/list') response = { data: [{ id: 'contract-model', model: 'contract-model', displayName: 'Simulated contract model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null };
    else if (method === 'thread/list') response = { data: [threads[params.cursor ? olderId : recentId]], nextCursor: params.cursor ? null : 'second-page' };
    else if (method === 'thread/read') response = { thread: threads[params.threadId] };
    else if (method === 'thread/resume') response = { thread: threads[params.threadId], approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user' };
    else if (method === 'thread/turns/list') {
      if (params.cursor === 'older-history') {
        await new Promise<void>(accept => { releaseHistory = accept; });
        response = { data: [earlierTurn], nextCursor: null };
      } else response = { data: [...threads[params.threadId].turns].reverse(), nextCursor: historyEnabled && params.threadId === recentId ? 'older-history' : null };
    }
    else if (method === 'thread/items/list') response = { data: (params.turnId === earlierTurn.id ? earlierTurn : threads[params.threadId].turns.find((turn: any) => turn.id === params.turnId)).items.map((item: any) => ({ turnId: params.turnId, item })), nextCursor: null };
    else if (method === 'turn/start') {
      sendingTurn = { id: 'delayed-ack-turn', status: 'inProgress', items: [], itemsView: 'full', error: null };
      threads[params.threadId].turns.push(sendingTurn);
      threads[params.threadId].status = { type: 'active', activeFlags: [] };
      emit('turn/started', { threadId: params.threadId, turn: sendingTurn });
      await new Promise<void>(accept => { nextAck = accept; });
      response = { turn: sendingTurn };
    } else throw new Error(`Unexpected simulated method: ${method}`);
    return structuredClone(response) as T;
  },
  send: (_message: WireMessage) => { throw new Error('This contract does not request approvals'); },
};
const service = new BridgeService(codex, cwd);
const port = Number(process.env.ORACULUM_CONTRACT_PORT ?? '17868');
const server = await createServer(service, port, resolve('apps/web/dist'), { testOnlyUnauthenticated: true });
await mkdir('.local/evidence/phase3/contracts', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/phase3/contracts/run-'));
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
env.ORACULUM_URL = `http://127.0.0.1:${port}`;
env.ORACULUM_USER_DATA_DIR = join(output, 'electron-profile');
const results: { name: string; passed: boolean; error?: string }[] = [];
let app: ElectronApplication | undefined;
let page: Page;
const errors: string[] = [];
async function run(name: string, test: () => Promise<void>) {
  try { await test(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) {
    results.push({ name, passed: false, error: String(error) }); console.error(`FAIL ${name}: ${String(error)}`);
    await page.screenshot({ path: join(output, `simulated-${name}.png`) });
  }
}
async function ready() { await expect(page.locator('.connection-status')).toContainText('状态已查询', { timeout: 15_000 }); }
async function resetRecent() {
  await page.evaluate(key => localStorage.removeItem(key), `oraculum.thread:${cwd}`);
  await page.reload(); await ready();
  await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', recentId);
}
try {
  await server.listen({ host: '127.0.0.1', port });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  await expect.poll(() => app!.windows().some(page => page.url().startsWith(env.ORACULUM_URL)), { timeout: 15_000 }).toBe(true);
  page = app.windows().find(page => page.url().startsWith(env.ORACULUM_URL))!; page.on('pageerror', error => errors.push(error.message));
  await ready();
  await run('delayed-ack-preserves-next-draft', async () => {
    const message = page.getByLabel('消息', { exact: true });
    await message.fill('第一条待确认消息');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => !!nextAck).toBe(true);
    await message.fill('ACK 等待期间写下的下一条草稿');
    nextAck!(); nextAck = undefined;
    await expect(page.getByRole('button', { name: '新建会话', exact: true })).toBeEnabled();
    await expect(message).toHaveValue('ACK 等待期间写下的下一条草稿');
    expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
    expect(requests.find(request => request.method === 'turn/start')!.params.input[0].text).toBe('第一条待确认消息');
  });
  if (sendingTurn) {
    sendingTurn.status = 'completed'; threads[recentId].status = { type: 'idle' };
    emit('turn/completed', { threadId: recentId, turn: sendingTurn });
    emit('thread/status/changed', { threadId: recentId, status: threads[recentId].status });
    await ready();
  }
  await run('saved-thread-on-second-page', async () => {
    await page.getByRole('button', { name: '加载更多会话', exact: true }).click();
    await page.locator(`nav[aria-label="原生会话"] button[data-thread-id="${olderId}"]`).click();
    await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', olderId);
    await ready(); await page.reload(); await ready();
    await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', olderId);
    await expect(page.locator(`nav[aria-label="原生会话"] button[data-thread-id="${olderId}"]`)).toHaveAttribute('aria-current', 'page');
  });
  await resetRecent();
  await run('reconnect-serialized', async () => {
    let release: (() => void) | undefined;
    let intercepted = false;
    await page.route('**/auth/session', async route => {
      const held = !intercepted;
      if (held) {
        intercepted = true;
        await new Promise<void>(resolve => { release = resolve; });
      }
      await route.continue();
    });
    try {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const reconnect = page.locator('.settings-dialog').getByRole('button', { name: '重新连接', exact: true });
      const configReads = requests.filter(request => request.method === 'config/read').length;
      await reconnect.click(); await expect.poll(() => intercepted).toBe(true);
      await expect(reconnect).toBeDisabled();
      // Even a queued native click cannot launch another connect while disabled.
      await reconnect.evaluate(button => (button as HTMLButtonElement).click());
      release!();
      await ready(); await expect(reconnect).toBeEnabled();
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();
      // One connection reads the default config, then the selected project config.
      expect(requests.filter(request => request.method === 'config/read')).toHaveLength(configReads + 2);
      await expect(page.getByRole('alert')).toHaveCount(0);
    } finally { release?.(); await page.unroute('**/auth/session'); }
  });
  historyEnabled = true;
  await resetRecent();
  await run('delayed-history-preserves-latest-reading-anchor', async () => {
    await page.getByRole('button', { name: '加载更早历史', exact: true }).click();
    await expect.poll(() => !!releaseHistory).toBe(true);
    await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 500; });
    const anchor = page.locator('[data-item-id="history-message"] .markdown p').nth(12);
    const before = (await anchor.boundingBox())!.y;
    releaseHistory!(); releaseHistory = undefined;
    await expect(page.locator('[data-item-id="earlier-message"]')).toHaveCount(1);
    await expect.poll(async () => (await anchor.boundingBox())!.y, { message: 'History should preserve the position at response time, including scrolling while awaiting it' }).toBeCloseTo(before, 0);
  });
  historyEnabled = false;
  await resetRecent();
  await run('expanded-composer-keeps-reading-controls-clear', async () => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(720, 560));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(720);
    await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 0; });
    const jump = page.getByRole('button', { name: /返回最新/ });
    await expect(jump).toBeVisible();
    await page.getByLabel('消息', { exact: true }).fill('长提示词中的每一行都应留在输入框中，不应遮挡阅读控件。\n'.repeat(100));
    await page.getByRole('button', { name: '展开输入框', exact: true }).click();
    const composer = await page.locator('.composer').boundingBox();
    const jumpBox = await jump.boundingBox();
    const input = await page.getByLabel('消息', { exact: true }).boundingBox();
    expect(composer).not.toBeNull(); expect(jumpBox).not.toBeNull(); expect(input).not.toBeNull();
    expect(jumpBox!.y + jumpBox!.height, 'jump-latest must remain above composer').toBeLessThanOrEqual(composer!.y);
    expect(input!.y + input!.height).toBeLessThanOrEqual(560);
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(560);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  expect(errors, 'Unexpected renderer errors').toEqual([]);
} finally {
  nextAck?.();
  releaseHistory?.();
  await app?.close(); await server.close();
  await writeFile(join(output, 'simulated-ui-contract.json'), JSON.stringify({ simulated: true, nativeCodex: false, date: new Date().toISOString(), results, rendererErrors: errors }, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;
console.log(JSON.stringify({ simulated: true, output, passed: results.filter(result => result.passed).length, total: results.length }));
