// Deterministic mobile UI contracts. Codex events and composition are simulated.
// This does not replace HONOR WebView, real IME, Android Back, or native Codex acceptance.
import { EventEmitter } from 'node:events';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { join, resolve } from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import type { WireMessage } from '../packages/shared/protocol';

const cwd = '/controlled-mobile-contract';
const firstId = 'mobile-contract-first', secondId = 'mobile-contract-second';
const patch = '--- a/sum.mjs\n+++ b/sum.mjs\n@@ -1 +1 @@\n-export const sum = (a, b) => a - b;\n+export const sum = (a, b) => a + b;\n';
const history: any = { id: 'history', status: 'completed', error: null, itemsView: 'full', items: [
  { type: 'userMessage', id: 'user-message', content: [{ type: 'text', text: '请检查加法并报告结果。', text_elements: [] }] },
  { type: 'agentMessage', id: 'reading-message', text: '## 阅读位置合约\n\n' + Array.from({ length: 45 }, (_, i) => `段落 ${i + 1}：这是明确标识的模拟文本，用于确认手机正文宽度和阅读位置保持。`).join('\n\n') + '\n\n```js\n' + 'const veryLongLine = "' + 'long-code-'.repeat(25) + '";\n```' },
  { type: 'commandExecution', id: 'command', command: 'node --test sum.test.mjs', cwd, status: 'completed', exitCode: 0, durationMs: 20, aggregatedOutput: 'tests 3\npass 3\nfail 0' },
  { type: 'fileChange', id: 'file', status: 'completed', changes: [{ path: cwd + '/sum.mjs', kind: { type: 'update', move_path: null }, diff: patch }] },
] };
const earlier: any = { id: 'earlier', status: 'completed', error: null, itemsView: 'full', items: [{ type: 'agentMessage', id: 'earlier-message', text: '更早的模拟历史。\n\n'.repeat(20) }] };
const threads: Record<string, any> = Object.fromEntries([firstId, secondId].map(id => [id, { id, name: id === firstId ? '移动阅读合约' : '第二个草稿会话', preview: '', cwd, model: 'contract-model', reasoningEffort: 'low', status: { type: 'idle' }, turns: id === firstId ? [history] : [] }]));
const bus = new EventEmitter();
const requests: { method: string; params: any }[] = [], replies: WireMessage[] = [];
let historyEnabled = false, holdHistory = true, releaseHistory: (() => void) | undefined;
let holdSubscribe = false, releaseSubscribe: (() => void) | undefined;
const emit = (method: string, params: object) => bus.emit('message', { method, params: { threadId: firstId, ...params } });
const codex = {
  on: bus.on.bind(bus),
  request: async <T>(method: string, params: any): Promise<T> => {
    requests.push({ method, params }); let result: any;
    if (method === 'config/read') result = { config: { model: 'contract-model', model_reasoning_effort: 'low', model_provider: 'fixture' } };
    else if (method === 'model/list') result = { data: [{ id: 'contract-model', model: 'contract-model', displayName: 'Contract model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], nextCursor: null };
    else if (method === 'thread/list') result = { data: Object.values(threads), nextCursor: null };
    else if (method === 'thread/read' || method === 'thread/resume') {
      if (method === 'thread/read' && holdSubscribe) { holdSubscribe = false; await new Promise<void>(accept => { releaseSubscribe = accept; }); }
      result = { thread: threads[params.threadId] };
    }
    else if (method === 'thread/turns/list') {
      if (params.cursor === 'earlier') { if (holdHistory) await new Promise<void>(accept => { releaseHistory = accept; }); result = { data: [earlier], nextCursor: null }; }
      else result = { data: [...threads[params.threadId].turns].reverse(), nextCursor: historyEnabled && params.threadId === firstId ? 'earlier' : null };
    } else if (method === 'thread/items/list') result = { data: (params.turnId === earlier.id ? earlier : threads[params.threadId].turns.find((t: any) => t.id === params.turnId)).items.map((item: any) => ({ turnId: params.turnId, item })), nextCursor: null };
    else if (method === 'turn/start') throw new Error('Simulated uncertain transport failure after dispatch');
    else throw new Error(`Unexpected simulated method: ${method}`);
    return structuredClone(result) as T;
  },
  send: (message: WireMessage) => { replies.push(message); emit('serverRequest/resolved', { requestId: message.id }); },
};
const service = new BridgeService(codex, cwd);
const port = Number(process.env.ORACULUM_MOBILE_CONTRACT_PORT ?? '17869');
const server = await createServer(service, port, resolve('apps/web/dist'), { testOnlyUnauthenticated: true });
await mkdir('.local/evidence/phase3/mobile-contracts', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/phase3/mobile-contracts/run-'));
const results: { name: string; passed: boolean; error?: string }[] = [], errors: string[] = [];
let browser: Browser | undefined, page: Page;
const ready = () => expect(page.getByRole('status', { includeHidden: true })).toContainText('状态已查询', { timeout: 15_000 });
const scrollTop = () => page.locator('.conversation-scroll').evaluate(element => element.scrollTop);
async function back() { expect(await page.evaluate(() => (window as any).oraculumAndroidBack?.())).toBe(true); }
async function openDrawer() { await page.getByRole('button', { name: '打开导航', exact: true }).click(); await expect(page.locator('.app-shell')).toHaveClass(/drawer-open/); }
async function select(id: string) { await openDrawer(); await page.locator(`nav[aria-label="原生会话"] button[title="${id}"]`).click(); await ready(); await expect(page.getByTestId('thread-id')).toHaveText(id); }
async function reset() {
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await ready();
  await expect(page.getByTestId('thread-id')).toHaveText(firstId);
}
async function run(name: string, test: () => Promise<void>) {
  try { await reset(); await test(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); console.error(`FAIL ${name}: ${String(error)}`); await page.screenshot({ path: join(output, `simulated-${name}-failure.png`) }); }
}
async function noOverflow() {
  const viewport = page.viewportSize()!;
  // visualViewport resize is delivered after the emulated metrics update.
  await expect.poll(async () => { const box = await page.locator('.composer').boundingBox(); return box ? box.y + box.height : Infinity; }).toBeLessThanOrEqual(viewport.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await page.locator('.composer').boundingBox();
  expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
}
async function target(label: string, minimum = 44) {
  const box = await page.getByRole('button', { name: label, exact: true }).boundingBox();
  expect(box, label).not.toBeNull(); expect(box!.width, label).toBeGreaterThanOrEqual(minimum); expect(box!.height, label).toBeGreaterThanOrEqual(minimum);
}
try {
  await server.listen({ host: '127.0.0.1', port });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36 OraculumAndroid/1' });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`); await ready();
  await run('portrait-landscape-and-touch-targets', async () => {
    for (const [width, height] of [[375, 812], [390, 844], [844, 390]]) {
      await page.setViewportSize({ width, height }); await noOverflow();
      await expect(page.getByRole('button', { name: '打开导航', exact: true })).toBeVisible();
      await expect(page.locator('.navigation')).not.toBeInViewport();
      await target('打开导航', 48); await target('发送', 48); await target('会话菜单');
      const body = await page.locator('[data-item-id="reading-message"] .message-body').boundingBox();
      expect(body!.width, 'Body should use mobile width without avatar indentation').toBeGreaterThanOrEqual(width - 36);
      await page.screenshot({ path: join(output, `simulated-${width}x${height}.png`) });
    }
  });
  await run('drawer-backdrop-back-drafts-and-reading', async () => {
    const message = page.getByLabel('消息', { exact: true }); await message.fill('第一会话中文草稿');
    await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 560; }); const before = await scrollTop();
    await openDrawer(); await target('折叠导航'); await page.getByRole('button', { name: '折叠导航', exact: true }).click();
    await expect(message).toHaveValue('第一会话中文草稿'); expect(await scrollTop()).toBeCloseTo(before, 0);
    await openDrawer(); await page.getByRole('button', { name: '关闭导航遮罩', exact: true }).click({ position: { x: 385, y: 200 } });
    await expect(page.locator('.app-shell')).not.toHaveClass(/drawer-open/);
    await openDrawer(); await back(); await expect(page.locator('.app-shell')).not.toHaveClass(/drawer-open/);
    await select(secondId); await message.fill('第二会话独立草稿'); await select(firstId);
    await expect(message).toHaveValue('第一会话中文草稿'); await expect.poll(scrollTop).toBeCloseTo(before, 0);
    await select(secondId); await expect(message).toHaveValue('第二会话独立草稿');
  });
  await run('reload-restores-reading-and-draft', async () => {
    await page.getByLabel('消息', { exact: true }).fill('重载后保留的中文草稿');
    const saved = await page.locator('.conversation-scroll').evaluate(element => {
      element.scrollTop = 650;
      // pagehide can arrive before the queued scroll event updates follow state.
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      return JSON.parse(localStorage.getItem('oraculum.reading:/controlled-mobile-contract:mobile-contract-first') ?? 'null');
    });
    expect(saved).toMatchObject({ top: 650, bottom: false });
    await expect.poll(scrollTop).toBeCloseTo(650, 0);
    await page.reload(); await ready();
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('重载后保留的中文草稿');
    await expect.poll(scrollTop).toBeCloseTo(650, 0);
  });
  await run('composition-enter-and-expanded-composer', async () => {
    const message = page.getByLabel('消息', { exact: true }); const starts = requests.filter(r => r.method === 'turn/start').length;
    await message.fill('中文输入'); await message.press('End'); await message.press('Enter'); await message.press('A');
    await expect(message).toHaveValue('中文输入\nA');
    await message.dispatchEvent('compositionstart', { data: '拼音' });
    await message.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, isComposing: true, bubbles: true });
    await message.dispatchEvent('compositionend', { data: '拼音' });
    expect(requests.filter(r => r.method === 'turn/start')).toHaveLength(starts);
    await message.fill('很长的中文提示词。\n'.repeat(80)); await page.getByRole('button', { name: '展开输入框', exact: true }).click();
    await noOverflow(); await back(); await expect(page.getByRole('button', { name: '展开输入框', exact: true })).toBeVisible();
    await expect(message).toHaveValue('很长的中文提示词。\n'.repeat(80));
  });
  await run('fullscreen-diff-back-retains-reading', async () => {
    const button = page.getByRole('button', { name: '查看 Diff', exact: true }); await button.scrollIntoViewIfNeeded();
    const before = await scrollTop(); await button.click();
    const panel = page.getByLabel('文件 Diff 面板', { exact: true }); await expect(panel).toBeVisible();
    await expect(page.locator('.cm-content')).toContainText('a + b');
    expect(await page.locator('.cm-content').getAttribute('contenteditable')).not.toBe('true');
    const box = await panel.boundingBox(); expect(box!.x).toBe(0); expect(box!.y).toBe(0); expect(box!.width).toBe(390); expect(box!.height).toBe(844);
    await target('关闭面板', 48); await back(); await expect(panel).toHaveCount(0); expect(await scrollTop()).toBeCloseTo(before, 0);
  });
  await run('menu-settings-back-layering', async () => {
    await page.getByRole('button', { name: '会话菜单', exact: true }).click(); await expect(page.getByRole('menu')).toBeVisible();
    await back(); await expect(page.getByRole('menu')).toHaveCount(0);
    await openDrawer(); await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.locator('.settings-dialog')).toBeVisible(); await back(); await expect(page.locator('.settings-dialog')).not.toBeVisible();
    // Closing settings must never discard the selected thread or draft state.
    await expect(page.getByTestId('thread-id')).toHaveText(firstId);
  });
  await run('font-scale-and-reduced-height', async () => {
    const original = await page.locator('[data-item-id="reading-message"] .markdown').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    await openDrawer(); await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('slider', { name: '正文大小', exact: true }).focus();
    await page.getByRole('slider', { name: '正文大小', exact: true }).press('End'); await back();
    if (await page.locator('.app-shell').evaluate(element => element.classList.contains('drawer-open'))) await back();
    expect(await page.locator('[data-item-id="reading-message"] .markdown').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(original * 1.5, 1);
    await page.reload(); await ready();
    expect(await page.locator('[data-item-id="reading-message"] .markdown').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(original * 1.5, 1);
    await page.getByLabel('消息', { exact: true }).fill('字体放大后，长提示词仍须可读。\n'.repeat(15));
    await noOverflow(); await page.setViewportSize({ width: 390, height: 430 }); await noOverflow();
    await target('发送', 48); await openDrawer();
    const close = await page.getByRole('button', { name: '折叠导航', exact: true }).boundingBox(); expect(close!.y + close!.height).toBeLessThanOrEqual(430);
    await back(); await page.screenshot({ path: join(output, 'simulated-font-150-reduced-height.png') });
  });
  await run('landscape-keyboard-99px-keeps-input-and-send-reachable', async () => {
    const message = page.getByLabel('消息', { exact: true });
    const draft = '横屏中文候选栏占据大部分屏幕时，输入与发送仍须可操作。\n'.repeat(12);
    const starts = requests.filter(request => request.method === 'turn/start').length;
    await message.fill(draft); await page.setViewportSize({ width: 782, height: 99 }); await noOverflow();
    await expect(message).toHaveValue(draft); await target('发送', 48);
    const input = await message.boundingBox(), send = await page.getByRole('button', { name: '发送', exact: true }).boundingBox();
    expect(input!.height, 'The editable input remains a 44px touch target').toBeGreaterThanOrEqual(44);
    for (const box of [input!, send!]) { expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(99); }
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
    await page.screenshot({ path: join(output, 'simulated-landscape-keyboard-782x99.png') });
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow();
    await expect(message).toHaveValue(draft); expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(starts);
  });
  await run('stream-preserves-reader-and-follows-bottom', async () => {
    const turn: any = { id: 'stream', status: 'inProgress', error: null, itemsView: 'full', items: [] };
    const item: any = { type: 'agentMessage', id: 'stream-message', text: '' };
    emit('turn/started', { turn }); emit('item/started', { turnId: turn.id, item });
    await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 400; });
    const before = await scrollTop(); emit('item/agentMessage/delta', { turnId: turn.id, itemId: item.id, delta: '模拟流式新增段落。\n\n'.repeat(40) });
    await expect(page.locator('[data-item-id="stream-message"]')).toContainText('模拟流式新增段落'); expect(await scrollTop()).toBeCloseTo(before, 0);
    await page.getByRole('button', { name: /返回最新/ }).click();
    await expect.poll(() => page.locator('.conversation-scroll').evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThan(5);
    emit('item/agentMessage/delta', { turnId: turn.id, itemId: item.id, delta: '位于底部继续追流。\n\n'.repeat(10) });
    await expect(page.locator('[data-item-id="stream-message"]')).toContainText('位于底部继续追流');
    await expect.poll(() => page.locator('.conversation-scroll').evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThan(5);
    emit('turn/completed', { turn: { ...turn, status: 'completed' } }); await ready();
  });
  await run('same-thread-query-preserves-new-reading-position', async () => {
    await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 400; }); await expect.poll(scrollTop).toBeCloseTo(400, 0);
    holdSubscribe = true; await page.getByRole('button', { name: '会话菜单', exact: true }).click();
    await page.getByRole('menuitem', { name: '查询状态', exact: true }).click(); await expect.poll(() => !!releaseSubscribe).toBe(true);
    await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 900; }); await expect.poll(scrollTop).toBeCloseTo(900, 0);
    releaseSubscribe!(); releaseSubscribe = undefined; await ready();
    await expect.poll(scrollTop, { message: 'A delayed same-thread query must preserve scrolling performed while awaiting it' }).toBeCloseTo(900, 0);
  });
  historyEnabled = true;
  await run('delayed-history-preserves-current-anchor', async () => {
    await page.getByRole('button', { name: '加载更早历史', exact: true }).click(); await expect.poll(() => !!releaseHistory).toBe(true);
    await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 480; });
    const anchor = page.locator('[data-item-id="reading-message"] .markdown p').nth(8), before = (await anchor.boundingBox())!.y;
    releaseHistory!(); releaseHistory = undefined; await expect(page.locator('[data-item-id="earlier-message"]')).toHaveCount(1);
    await expect.poll(async () => (await anchor.boundingBox())!.y).toBeCloseTo(before, 0);
  });
  holdHistory = false;
  await run('older-page-anchor-survives-session-and-reload', async () => {
    await page.getByRole('button', { name: '加载更早历史', exact: true }).click();
    const anchor = page.locator('[data-item-id="earlier-message"] .markdown p').nth(6);
    await expect(anchor).toHaveCount(1); await anchor.scrollIntoViewIfNeeded(); await expect(anchor).toBeInViewport();
    const before = (await anchor.boundingBox())!.y;
    await select(secondId); await select(firstId);
    await expect(anchor).toHaveCount(1); await expect.poll(async () => (await anchor.boundingBox())!.y).toBeCloseTo(before, 0);
    await page.reload(); await ready();
    await expect(anchor).toHaveCount(1); await expect.poll(async () => (await anchor.boundingBox())!.y).toBeCloseTo(before, 0);
  }); historyEnabled = false; holdHistory = true;
  await run('approval-touch-and-external-invalidation', async () => {
    bus.emit('message', { id: 31, method: 'item/commandExecution/requestApproval', params: { threadId: firstId, turnId: history.id, itemId: 'approval-command', command: 'printf MOBILE_CONTRACT', cwd, reason: 'Simulated approval contract' } });
    await expect(page.getByRole('heading', { name: '需要审批', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '允许本次', exact: true }).scrollIntoViewIfNeeded();
    await target('允许本次', 48); await target('拒绝', 48);
    const count = replies.length; emit('serverRequest/resolved', { requestId: 31 });
    await expect(page.locator('.approval')).toHaveCount(0); expect(replies).toHaveLength(count);
  });
  await run('native-unavailable-expires-approval', async () => {
    bus.emit('message', { id: 32, method: 'item/commandExecution/requestApproval', params: { threadId: firstId, turnId: history.id, itemId: 'expiring-command', command: 'printf EXPIRED_CONTRACT', cwd, reason: 'Simulated unavailable App Server' } });
    await expect(page.getByRole('heading', { name: '需要审批', exact: true })).toBeVisible();
    const count = replies.length; bus.emit('unavailable', 'Simulated App Server unavailable');
    await expect.poll(async () => {
      if (!await page.locator('.approval').count()) return true;
      return await page.getByRole('button', { name: '允许本次', exact: true }).isDisabled() && await page.getByRole('button', { name: '拒绝', exact: true }).isDisabled();
    }, { message: 'Expired approvals must disappear or disable both decisions' }).toBe(true);
    expect(replies).toHaveLength(count);
  });
  await run('unknown-send-never-replayed', async () => {
    const starts = requests.filter(r => r.method === 'turn/start').length;
    await page.getByLabel('消息', { exact: true }).fill('只允许发出一次的模拟消息'); await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Simulated uncertain transport failure');
    await page.reload(); await ready(); await expect(page.getByRole('alert')).toContainText('有发送尚未确认终态，禁止重发');
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled(); expect(requests.filter(r => r.method === 'turn/start')).toHaveLength(starts + 1);
  });
  expect(errors, 'Unexpected renderer errors').toEqual([]);
} finally {
  releaseHistory?.(); releaseSubscribe?.(); await browser?.close(); await server.close();
  await writeFile(join(output, 'simulated-mobile-contract.json'), JSON.stringify({ simulated: true, nativeCodex: false, nativeIME: false, nativeAndroidBack: false, date: new Date().toISOString(), results, rendererErrors: errors }, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;
console.log(JSON.stringify({ simulated: true, output, passed: results.filter(result => result.passed).length, total: results.length }));
