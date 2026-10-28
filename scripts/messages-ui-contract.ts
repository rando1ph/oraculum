// Real Electron + emulated mobile Chromium. Native events, receipts and IME
// composition are controlled fixtures; this does not replace Android device QA.
import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Page } from '@playwright/test';
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
import { alignedTable, gfmMessage, partialTable } from './fixtures/markdown';

const cwd = '/message-card-fixture', id = 'internal-thread-fixture';
const patch = '--- a/sum.ts\n+++ b/sum.ts\n@@ -1 +1 @@\n-export const sum = (a, b) => a - b;\n+export const sum = (a, b) => a + b;\n';
const history: any = { id: 'internal-history-fixture', status: 'completed', error: null, itemsView: 'full', items: [
  { id: 'user', type: 'userMessage', content: [{ type: 'text', text: '请检查消息卡片，保留清晰的阅读体验。\n第二行用户文本。', text_elements: [] }] },
  { id: 'answer', type: 'agentMessage', text: '## 清晰的对话\n\n**Markdown** 与 `inline code` 保持可读。\n\n- 同样的卡片布局\n- 宽度跟随设备\n\n> 保留重要的执行信息。\n\n```ts\nconst longLine = "' + 'long-code-'.repeat(30) + '";\n```\n\n<script>window.BAD=true</script>\n[unsafe](javascript:alert(1))' },
  { id: 'gfm', type: 'agentMessage', text: gfmMessage },
  { id: 'plan', type: 'plan', text: alignedTable },
  { id: 'reasoning', type: 'reasoning', summary: [alignedTable], content: [] },
  { id: 'command', type: 'commandExecution', command: 'node --test sum.test.ts', cwd, status: 'completed', exitCode: 0, durationMs: 25, aggregatedOutput: 'tests 3\npass 3\nfail 0' },
  { id: 'file', type: 'fileChange', status: 'completed', changes: [{ path: cwd + '/sum.ts', kind: { type: 'update', move_path: null }, diff: patch }] },
  { id: 'future', type: 'futureTool', status: 'completed', rawInternalFixturePayload: 'internal-payload-fixture' },
  { id: 'reading', type: 'agentMessage', text: '## 阅读位置\n\n' + Array.from({ length: 42 }, (_, index) => `段落 ${index + 1}：这段模拟文本用于验证阅读位置、长文和流式更新。`).join('\n\n') },
] };
const thread: any = { id, name: '消息卡片 · 模拟合约', cwd, preview: '', status: { type: 'idle' }, turns: [history] };
const bus = new EventEmitter(), requests: string[] = [], replies: WireMessage[] = [];
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
    else if (method === 'thread/turns/list') result = { data: [...thread.turns].reverse(), nextCursor: null };
    else if (method === 'thread/items/list') result = { data: thread.turns.find((turn: any) => turn.id === params.turnId).items.map((item: any) => ({ turnId: params.turnId, item })), nextCursor: null };
    else if (method === 'turn/interrupt') {
      const turn = thread.turns.at(-1); turn.status = 'interrupted'; thread.status = { type: 'idle' };
      emit('turn/completed', { turn }); emit('thread/status/changed', { status: thread.status }); result = {};
    } else throw new Error(`Unexpected fixture request: ${method}`);
    return structuredClone(result) as T;
  },
};
await mkdir('.local/evidence/r1-b2/messages-contract', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/r1-b2/messages-contract/run-'));
const themes = new Themes({ source: resolve('themes'), builtin: resolve('themes'), installed: join(output, 'installed-themes') });
for (const theme of ['test-violet', 'hong-kong-rain']) await themes.install(theme);
const db = new DatabaseSync(':memory:'), receipts = new ReceiptStore(db);
const completedReceipt = '00000000-0000-4000-8000-000000000001';
receipts.reserve(completedReceipt, cwd, id, 'fixture-device'); receipts.accepted(completedReceipt, history.id); receipts.observe(cwd, id, history);
const service = new BridgeService(codex, cwd, receipts), port = Number(process.env.ORACULUM_MESSAGES_UI_PORT ?? '17875'), origin = `http://127.0.0.1:${port}`;
const makeServer = () => createServer(service, port, resolve('apps/web/dist'), { themes, testOnlyUnauthenticated: true });
let server = await makeServer();
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron-profile') });
let app: ElectronApplication | undefined, browser: Browser | undefined, desktop: Page | undefined, phone: Page | undefined;
const checks: string[] = [], errors: string[] = [];
const tableGeometry: object[] = [];
const failureLayout: object[] = [];
let failure: string | undefined;
const ready = (page: Page) => expect(page.locator('.connection-status')).toContainText('状态已查询', { timeout: 15_000 });
const scrollTop = (page: Page) => page.locator('.conversation-scroll').evaluate(element => element.scrollTop);
const record = (check: string) => { checks.push(check); console.log('PASS ' + check); };
async function theme(page: Page, value: string) {
  if (page === phone) await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('当前主题')).toBeEnabled(); await page.getByLabel('当前主题').selectOption(value);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme-id', value);
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  if (page === phone) await page.getByRole('button', { name: '折叠导航', exact: true }).click();
}
async function cards(page: Page, mobile = false) {
  const user = page.locator('[data-item-id="user"] .message'), assistant = page.locator('[data-item-id="answer"] .message');
  await expect(user).toHaveAttribute('data-theme-slot', 'user-message'); await expect(assistant).toHaveAttribute('data-theme-slot', 'assistant-message');
  await expect(user.locator('.message-name')).toHaveText('你'); await expect(assistant.locator('.message-name')).toHaveText('Codex');
  const bounds = await Promise.all([user, assistant].map(locator => locator.boundingBox()));
  expect(bounds[0]!.x).toBeCloseTo(bounds[1]!.x, 0); expect(bounds[0]!.width).toBeCloseTo(bounds[1]!.width, 0);
  for (const card of [user, assistant]) {
    const style = await card.evaluate(element => { const s = getComputedStyle(element); return { radius: parseFloat(s.borderRadius), border: parseFloat(s.borderLeftWidth), textAlign: s.textAlign }; });
    expect(style.radius).toBeGreaterThan(0); expect(style.border).toBeGreaterThan(0); expect(style.textAlign).not.toBe('right');
    const avatar = await card.locator('.message-avatar').boundingBox(); expect(avatar!.width).toBeGreaterThanOrEqual(24); expect(avatar!.width).toBeLessThanOrEqual(40);
    const body = await card.locator('.message-body').boundingBox(), box = (await card.boundingBox())!;
    expect(body!.x - box.x, 'body uses card width without an avatar gutter').toBeLessThanOrEqual(mobile ? 16 : 28);
    expect(body!.width).toBeGreaterThanOrEqual(box.width - (mobile ? 32 : 56));
  }
}
async function noNoise(page: Page) {
  const content = page.locator('.conversation-content');
  await expect(content.locator('.session-details, .events, .native-event, [data-testid="send-receipt"]')).toHaveCount(0);
  const visibleText = await content.innerText();
  for (const text of ['会话信息与原生事件', '原生事件 · 最近', '最近发送回执', id, history.id, completedReceipt, 'internal-payload-fixture', 'rawInternalFixturePayload']) expect(visibleText).not.toContain(text);
}
async function geometry(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await expect.poll(() => page.evaluate(() => parseFloat(document.documentElement.style.getPropertyValue('--app-height')))).toBe(height);
  await expect.poll(async () => { const box = await page.locator('.composer').boundingBox(); return box ? box.y + box.height : Infinity; }).toBeLessThanOrEqual(height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const send = (await page.getByRole('button', { name: '发送', exact: true }).boundingBox())!;
  expect(send.height).toBeGreaterThanOrEqual(48); expect(send.width).toBeGreaterThanOrEqual(48); expect(send.y).toBeGreaterThanOrEqual(0); expect(send.y + send.height).toBeLessThanOrEqual(height + 1);
  const input = (await page.getByLabel('消息', { exact: true }).boundingBox())!;
  expect(input.height).toBeGreaterThan(0); expect(input.y).toBeGreaterThanOrEqual(0); expect(input.y + input.height).toBeLessThanOrEqual(height + 1);
}
async function revealTable(page: Page, selector: string) {
  // Scroll the actual reading panel. scrollIntoView on a tall fixture also
  // scrolls overflow:hidden ancestors, which is not a user conversation scroll.
  await page.locator(selector).evaluate(element => {
    const panel = element.closest('.conversation-scroll')!;
    panel.scrollTop += element.getBoundingClientRect().top - panel.getBoundingClientRect().top;
  });
}
async function tables(page: Page, label: string) {
  const message = page.locator('[data-item-id="gfm"]');
  const table = message.getByRole('table').first();
  await expect(message.getByRole('table')).toHaveCount(2);
  await expect(table.locator('thead th')).toHaveText(['项目 Project', '数量', '状态', '语法']);
  await expect(table.locator('tbody tr').first().locator('td')).toHaveText(['神谕 English', '42', '通过', '转义 a|b 与 x|y']);
  expect(await table.locator('tbody tr').first().locator('td').evaluateAll(cells => cells.map(cell => getComputedStyle(cell).textAlign))).toEqual(['left', 'right', 'center', 'left']);
  expect(await table.evaluate(element => getComputedStyle(element).display)).toBe('table');
  expect(await table.locator('thead').evaluate(element => getComputedStyle(element).display)).toBe('table-header-group');
  await expect(message.locator('input[type="checkbox"]:disabled')).toHaveCount(2);
  await expect(message.locator('.markdown a, .markdown img, .markdown script')).toHaveCount(0);
  await expect(message.locator('.message-link').first()).toHaveAttribute('title', 'https://example.com/gfm');
  const scrolls = message.getByRole('region', { name: '表格（可横向滚动）', exact: true });
  await expect(scrolls).toHaveCount(2);
  const wide = scrolls.last();
  await revealTable(page, '[data-item-id="gfm"] .markdown-table-scroll:last-child');
  expect(await wide.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await wide.evaluate(element => (element as HTMLElement).focus({ preventScroll: true }));
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => wide.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await wide.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await expect.poll(() => wide.evaluate(element => element.scrollLeft)).toBeGreaterThan(100);
  await wide.evaluate(element => { element.scrollLeft = 0; (element as HTMLElement).blur(); });
  const bounds = await message.evaluate(element => {
    const card = element.querySelector('.message')!, markdown = element.querySelector('.markdown')!;
    return { viewport: innerWidth, page: document.documentElement.scrollWidth, card: card.getBoundingClientRect().toJSON(), cardClient: card.clientWidth, cardScroll: card.scrollWidth,
      markdownClient: markdown.clientWidth, markdownScroll: markdown.scrollWidth,
      scrolls: Array.from(element.querySelectorAll('.markdown-table-scroll')).map(el => ({ client: el.clientWidth, scroll: el.scrollWidth, box: el.getBoundingClientRect().toJSON() })) };
  });
  expect(bounds.page, label).toBeLessThanOrEqual(bounds.viewport);
  expect(bounds.cardScroll, label).toBeLessThanOrEqual(bounds.cardClient + 1);
  expect(bounds.markdownScroll, label).toBeLessThanOrEqual(bounds.markdownClient + 1);
  expect(bounds.card.x, label).toBeGreaterThanOrEqual(0);
  expect(bounds.card.right, label).toBeLessThanOrEqual(bounds.viewport + 1);
  for (const scroll of bounds.scrolls) {
    expect(scroll.box.x, label).toBeGreaterThanOrEqual(bounds.card.x);
    expect(scroll.box.right, label).toBeLessThanOrEqual(bounds.card.right);
  }
  tableGeometry.push({ label, ...bounds });
}
try {
  await server.listen({ host: '127.0.0.1', port });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  await expect.poll(() => app!.windows().some(page => page.url().startsWith(origin)), { timeout: 15_000 }).toBe(true);
  desktop = app.windows().find(page => page.url().startsWith(origin))!; desktop.on('pageerror', error => errors.push(error.message)); await ready(desktop);
  browser = await chromium.launch();
  phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36 OraculumAndroid/1' });
  await phone.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  phone.on('pageerror', error => errors.push(error.message)); await phone.goto(origin); await ready(phone);
  await desktop.setViewportSize({ width: 1920, height: 1080 }); await cards(desktop);
  const readingWidth = (await desktop.locator('.conversation-content').boundingBox())!.width;
  expect(readingWidth).toBeGreaterThanOrEqual(920); expect(readingWidth).toBeLessThanOrEqual(1000);
  for (const page of [desktop, phone]) {
    await revealTable(page, '[data-item-id="gfm"]');
    await page.screenshot({ path: join(output, `gfm-initial-${page === phone ? 'mobile' : 'electron'}.png`) });
  }
  await tables(desktop, 'oracle-eye/electron');
  await tables(phone, 'oracle-eye/390x844');
  for (const page of [desktop, phone]) {
    await revealTable(page, '[data-item-id="gfm"]');
    await page.screenshot({ path: join(output, `gfm-oracle-eye-${page === phone ? 'mobile' : 'electron'}.png`) });
  }
  record('GFM semantic DOM, cell order/alignment, escaped pipes, tasks, safe autolinks and keyboard horizontal scrolling');
  for (const page of [desktop, phone]) {
    await cards(page, page === phone); await noNoise(page);
    await expect(page.locator('.history-warning')).toHaveCount(0);
    await expect(page.getByText(/部分历史未能恢复/)).toHaveCount(0);
    await expect(page.locator('[data-item-id="answer"] .markdown h2')).toHaveText('清晰的对话');
    await expect(page.locator('[data-item-id="answer"] .markdown strong')).toHaveText('Markdown');
    await expect(page.locator('[data-item-id="answer"] .markdown li')).toHaveCount(2);
    await expect(page.locator('[data-item-id="answer"] .markdown blockquote')).toContainText('保留重要的执行信息');
    expect(await page.evaluate(() => (window as any).BAD)).toBeUndefined(); await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
    expect(await page.locator('.code-block pre').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await page.locator('.code-block .copy').click(); await expect(page.locator('.code-block .copy')).toHaveText('已复制');
    await page.locator('.process-toggle').click();
    await expect(page.locator('[data-item-id="plan"] table')).toHaveCount(1);
    await page.locator('[data-item-id="reasoning"] summary').click();
    await expect(page.locator('[data-item-id="reasoning"] table')).toBeVisible();
    await page.locator('.command summary').click(); await expect(page.getByLabel('命令输出')).toContainText('pass 3');
    await page.getByRole('button', { name: '查看 Diff', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('a + b'); expect(await page.locator('.cm-content').getAttribute('contenteditable')).not.toBe('true');
    await page.getByRole('button', { name: '关闭面板', exact: true }).click();
    await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: join(output, `default-${page === phone ? 'mobile' : 'electron'}.png`) });
  }
  record('default cards share left alignment, avatars and names; 920–1000px desktop width; Markdown, code copy, horizontal code scrolling and read-only Diff preserved');
  for (const [width, height] of [[375, 812], [390, 844], [844, 390], [390, 430], [782, 99]]) {
    await geometry(phone, width, height); await cards(phone, true);
    const card = (await phone.locator('[data-item-id="answer"] .message').boundingBox())!;
    expect(card.x).toBeGreaterThanOrEqual(0); expect(card.x + card.width).toBeLessThanOrEqual(width + 1);
    expect(card.width).toBeGreaterThanOrEqual(width - 24);
  }
  record('375/390 portrait, landscape, 430px keyboard-sized and 99px short-height geometry retains near-full cards and reachable input/send');
  await geometry(phone, 390, 844);
  const message = phone.getByLabel('消息', { exact: true });
  await message.fill('中文输入'); await message.press('End'); await message.press('Enter'); await message.press('A'); await expect(message).toHaveValue('中文输入\nA');
  await message.dispatchEvent('compositionstart', { data: '拼音' });
  await message.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, isComposing: true, bubbles: true });
  await message.dispatchEvent('compositionend', { data: '拼音' }); expect(requests).not.toContain('turn/start');
  await phone.getByRole('button', { name: '展开输入框', exact: true }).click(); await geometry(phone, 390, 430);
  await phone.getByRole('button', { name: '收起输入框', exact: true }).click(); await geometry(phone, 390, 844);
  await phone.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 620; window.dispatchEvent(new PageTransitionEvent('pagehide')); });
  const savedTop = await scrollTop(phone); await phone.reload(); await ready(phone);
  await expect(message).toHaveValue('中文输入\nA'); await expect.poll(() => scrollTop(phone!)).toBeCloseTo(savedTop, 0);
  await tables(phone, 'oracle-eye/history-reload');
  record('Enter newline, simulated composition guard, expand/collapse, unsent draft and reload reading position preserved');
  for (const value of ['test-violet', 'minimal-light', 'hong-kong-rain', 'hong-kong-neon', 'old-terminal']) {
    for (const page of [desktop, phone]) {
      await theme(page, value); await cards(page, page === phone); await noNoise(page);
      const process = page.locator('.process-toggle').first();
      if (await process.getAttribute('aria-expanded') === 'false') await process.click();
      await page.getByRole('button', { name: '查看 Diff', exact: true }).click(); await expect(page.locator('.cm-content')).toContainText('a + b');
      await page.getByRole('button', { name: '关闭面板', exact: true }).click();
      if (value === 'test-violet') expect(await page.locator('.message').first().evaluate(element => getComputedStyle(element).getPropertyValue('--accent').trim())).toBe('#dbb3ff');
      if (value === 'minimal-light') expect(await page.locator('.app-shell').evaluate(element => getComputedStyle(element).colorScheme)).toBe('light');
      await tables(page, `${value}/${page === phone ? '390x844' : 'electron'}`);
      await revealTable(page, '[data-item-id="gfm"]');
      await page.screenshot({ path: join(output, `gfm-${value}-${page === phone ? 'mobile' : 'electron'}.png`) });
    }
    for (const [width, height] of [[375, 667], [390, 844], [844, 390], [390, 430], [782, 99]]) {
      await geometry(phone, width, height);
      // The 99px IME layout intentionally leaves no conversation reading area.
      if (height > 160) await tables(phone, `${value}/${width}x${height}`);
    }
    await geometry(phone, 390, 844); await expect(message).toHaveValue('中文输入\nA');
  }
  await theme(desktop, 'oracle-eye'); await theme(phone, 'oracle-eye');
  for (const [width, height] of [[375, 667], [844, 390], [390, 430]]) {
    await geometry(phone, width, height); await tables(phone, `oracle-eye/${width}x${height}`);
  }
  await geometry(phone, 390, 844);
  await desktop.addStyleTag({ content: '[data-theme-slot="assistant-message"] { border-radius: 23px; } .message-name { letter-spacing: 1px; }' });
  expect(await desktop.locator('.agent-message').first().evaluate(element => getComputedStyle(element).borderRadius)).toBe('23px');
  expect(await desktop.locator('.message-name').first().evaluate(element => getComputedStyle(element).letterSpacing)).toBe('1px');
  record('all four built-in themes plus Violet/Rain retain semantic tables, bounded horizontal scrolling, cards, Diff and portrait/landscape/short geometry');

  const active: any = { id: 'internal-active-fixture', status: 'inProgress', error: null, itemsView: 'full', items: [] };
  thread.turns.push(active); thread.status = { type: 'active', activeFlags: [] }; emit('turn/started', { turn: active });
  for (const page of [desktop, phone]) await expect(page.getByTestId('turn-status')).toHaveText('执行中');
  await phone.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 540; });
  await expect.poll(() => scrollTop(phone!)).toBeCloseTo(540, 0);
  const live = { id: 'streaming', type: 'agentMessage', text: '正在检查布局。' }; active.items.push(live); emit('item/started', { turnId: active.id, item: live });
  emit('item/agentMessage/delta', { turnId: active.id, itemId: live.id, delta: '\n\n新增进度文字。' });
  await expect(phone.locator('[data-item-id="streaming"]')).toContainText('新增进度文字');
  await expect.poll(() => scrollTop(phone!)).toBeCloseTo(540, 0); await expect(phone.getByRole('button', { name: '返回最新', exact: true })).toBeVisible();
  const streamingTable = { id: 'streaming-table', type: 'agentMessage', text: partialTable };
  active.items.push(streamingTable); emit('item/started', { turnId: active.id, item: streamingTable });
  for (const page of [desktop, phone]) await expect(page.locator('[data-item-id="streaming-table"] table')).toHaveCount(1);
  const delta = '` | 7 |'; streamingTable.text += delta;
  emit('item/agentMessage/delta', { turnId: active.id, itemId: streamingTable.id, delta });
  for (const page of [desktop, phone]) await expect(page.locator('[data-item-id="streaming-table"] td')).toHaveText(['未闭合', '7']);
  await expect.poll(() => scrollTop(phone!)).toBeCloseTo(540, 0);
  await phone.reload(); await ready(phone);
  await expect(phone.locator('[data-item-id="streaming-table"] td')).toHaveText(['未闭合', '7']);
  await expect(phone.locator('[data-item-id="gfm"] .message-actions .copy')).toHaveCount(1);
  await phone.locator('[data-item-id="gfm"] .message-actions .copy').click();
  await expect(phone.locator('[data-item-id="gfm"] .message-actions .copy')).toHaveText('已复制');
  expect(await phone.evaluate(() => navigator.clipboard.readText())).toBe(gfmMessage);
  record('partial streamed table completes through agentMessage delta, survives native-history reread and copies original Markdown');
  for (const [requestId, decision] of [[71, '允许本次'], [72, '拒绝']] as const) {
    bus.emit('message', { id: requestId, method: 'item/commandExecution/requestApproval', params: { threadId: id, turnId: active.id, itemId: 'internal-approval-fixture', command: 'printf CARD_CONTRACT', cwd, reason: '模拟审批合约' } });
    await expect(desktop.getByTestId('turn-status')).toHaveText('待审批');
    const button = phone.getByRole('button', { name: decision, exact: true }); await button.scrollIntoViewIfNeeded(); await expect(button).toBeEnabled();
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(48); await noNoise(phone);
    expect(await phone.locator('.approval').innerText()).not.toContain('internal-approval-fixture');
    await button.click(); await expect(desktop.locator('.approval')).toHaveCount(0); await expect(phone.locator('.approval')).toHaveCount(0);
  }
  expect(replies.map(reply => reply.result)).toEqual([{ decision: 'accept' }, { decision: 'decline' }]);
  await phone.getByRole('button', { name: '停止', exact: true }).click(); await expect(desktop.getByTestId('turn-status')).toHaveText('已停止');
  active.status = 'failed'; active.error = { message: 'Simulated provider failure' }; emit('turn/completed', { turn: active });
  emit('error', { error: active.error, willRetry: true });
  for (const page of [desktop, phone]) {
    await expect(page.getByTestId('turn-status')).toHaveText('执行失败'); await expect(page.getByRole('alert')).toContainText('Simulated provider failure');
    await expect(page.locator('.history-warning').last()).toContainText('Codex 正在重试'); await noNoise(page);
  }
  record('streaming progress preserves an earlier reading position; allow/decline synchronize across clients; Stop, interruption, failure and retry notices remain actionable');
  const rejectedReceipt = '00000000-0000-4000-8000-000000000003', newerReceipt = '00000000-0000-4000-8000-000000000004';
  receipts.reserve(rejectedReceipt, cwd, id, 'fixture-device'); receipts.rejected(rejectedReceipt);
  await desktop.getByRole('button', { name: '查询状态', exact: true }).click();
  await expect(desktop.getByRole('alert').filter({ hasText: '最近一次发送已被拒绝' })).toHaveCount(1);
  receipts.reserve(newerReceipt, cwd, id, 'fixture-device'); receipts.accepted(newerReceipt, history.id); receipts.observe(cwd, id, history);
  await desktop.getByRole('button', { name: '查询状态', exact: true }).click();
  await expect(desktop.getByRole('alert').filter({ hasText: '最近一次发送已被拒绝' })).toHaveCount(0);
  record('latest rejected receipt remains visible and a newer completed receipt removes the stale rejection warning');
  receipts.reserve('00000000-0000-4000-8000-000000000002', cwd, id, 'fixture-device');
  await desktop.getByRole('button', { name: '查询状态', exact: true }).click(); await ready(desktop);
  await expect(desktop.getByRole('alert').filter({ hasText: '有发送尚未确认终态' })).toContainText('禁止重发');
  await desktop.getByLabel('消息', { exact: true }).fill('未知结果时禁止重复发送'); await expect(desktop.getByRole('button', { name: '发送', exact: true })).toBeDisabled(); await noNoise(desktop);
  await desktop.reload(); await ready(desktop); await expect(desktop.getByRole('button', { name: '发送', exact: true })).toBeDisabled(); expect(requests).not.toContain('turn/start');
  record('persisted unknown receipt retains precise warning and blocks sends across reload without exposing receipt dumps or replaying an operation');
  await server.close(); await expect(phone.locator('.disconnect-banner')).toContainText('主机任务不会因此停止');
  await expect(phone.getByRole('button', { name: '重新连接', exact: true })).toBeEnabled();
  server = await makeServer(); await server.listen({ host: '127.0.0.1', port });
  await phone.getByRole('button', { name: '重新连接', exact: true }).click(); await ready(phone); await expect(phone.locator('.disconnect-banner')).toHaveCount(0);
  await expect(message).toHaveValue('中文输入\nA'); await noNoise(phone); expect(errors).toEqual([]);
  record('disconnect and explicit reconnect preserve the draft and unknown-send state');
} catch (error) {
  failure = String(error);
  for (const [name, page] of [['electron', desktop], ['mobile', phone]] as const) if (page && !page.isClosed()) {
    failureLayout.push({ name, ...await page.evaluate(() => ({ viewport: [innerWidth, innerHeight], appHeight: document.documentElement.style.getPropertyValue('--app-height'), scroll: [scrollX, scrollY], active: document.activeElement?.outerHTML.slice(0, 200), boxes: ['.app-shell', '.conversation', '.conversation-scroll', '.composer', '.composer textarea', '.send-button'].map(selector => { const el = document.querySelector(selector); return { selector, box: el?.getBoundingClientRect().toJSON(), scrollTop: el?.scrollTop }; }) })) });
    await page.screenshot({ path: join(output, `failure-${name}.png`) }).catch(() => {});
  }
  throw error;
} finally {
  await app?.close(); await browser?.close(); await server.close(); db.close();
  await writeFile(join(output, 'report.json'), JSON.stringify({ date: new Date().toISOString(), realElectron: true, emulatedAndroid: true, nativeCodex: false, nativeIME: false, checks, errors, tableGeometry, failureLayout, failure, passed: !failure }, null, 2));
  console.log(JSON.stringify({ output, checks: checks.length, passed: !failure, failure }));
}
