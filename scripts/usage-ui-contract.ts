// Real Ubuntu Electron + Chromium mobile emulation, synthetic protocol only.
// No production Bridge, Android/ADB, user threads, or model calls.
import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BridgeService } from '../bridge/src/service';
import { NativeRpcError } from '../bridge/src/codex';
import { createServer } from '../bridge/src/server';
import { Themes } from '../bridge/src/themes';
import { rateLimits, tokenUsage } from './fixtures/usage';

const cwd = '/usage-fixture';
const patch = '--- a/usage.tsx\n+++ b/usage.tsx\n@@ -1 +1 @@\n-export const detail = false;\n+export const detail = true;\n';
const threads: any[] = ['a', 'b'].map(id => ({ id, name: `用量合约 · 会话 ${id.toUpperCase()}`, cwd, preview: '', status: { type: 'idle' }, turns: [
  { id: `turn-${id}`, status: 'completed', itemsView: 'full', error: null, items: [
    { id: `user-${id}`, type: 'userMessage', content: [{ type: 'text', text: '请把额度和会话用量放在更合适的位置，让界面更清晰。', text_elements: [] }] },
    { id: `answer-${id}`, type: 'agentMessage', text: '## 用量，一目了然\n\n本周剩余额度放在导航底部，会话用量收纳到右侧检查器。日常对话继续保持简洁。\n\n| 位置 | 内容 |\n| --- | --- |\n| 导航底部 | 本周剩余额度与重置时间 |\n| 检查器 | 会话累计、输入与输出 |\n\n详细数据可以按需展开。' },
    { id: `file-${id}`, type: 'fileChange', status: 'completed', changes: [{ path: cwd + '/usage.tsx', kind: { type: 'update', move_path: null }, diff: patch }] },
    { id: `command-${id}`, type: 'commandExecution', command: 'pnpm test', cwd, status: 'completed', exitCode: 0, durationMs: 25, aggregatedOutput: 'tests 3\npass 3\nfail 0' },
  ] },
] }));
const bus = new EventEmitter(), requests: string[] = [];
let unsupported = false, limits: unknown = rateLimits;
const codex = { on: bus.on.bind(bus), send: () => {}, request: async <T>(method: string, params: any): Promise<T> => {
  requests.push(method); let result: unknown;
  const thread = threads.find(thread => thread.id === params.threadId) ?? threads[0];
  if (method === 'config/read') result = { config: { model: 'fixture', model_provider: 'fixture', model_reasoning_effort: null } };
  else if (method === 'model/list') result = { data: [], nextCursor: null };
  else if (method === 'thread/list') result = { data: threads, nextCursor: null };
  else if (method === 'thread/read') result = { thread };
  else if (method === 'thread/resume') result = { thread, approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user' };
  else if (method === 'thread/turns/list') result = { data: thread.turns, nextCursor: null };
  else if (method === 'thread/items/list') result = { data: thread.turns[0].items.map((item: any) => ({ turnId: thread.turns[0].id, item })), nextCursor: null };
  else if (method === 'account/rateLimits/read') { if (unsupported) throw new NativeRpcError('not found', -32601); result = limits; }
  else if (method === 'account/usage/read') { if (unsupported) throw new NativeRpcError('not found', -32601); result = { summary: { lifetimeTokens: 1250000, peakDailyTokens: 84000 } }; }
  else throw new Error(`Unexpected fixture request: ${method}`);
  return structuredClone(result) as T;
} };
const emitUsage = (threadId: string, usage = tokenUsage) => bus.emit('message', { method: 'thread/tokenUsage/updated', params: { threadId, turnId: `turn-${threadId}`, tokenUsage: usage } });
await mkdir('.local/evidence/r1-b3-ui-revision/ui', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/r1-b3-ui-revision/ui/run-'));
const themes = new Themes({ source: resolve('themes'), builtin: resolve('themes'), installed: join(output, 'themes') });
const service = new BridgeService(codex, cwd), port = 17894, origin = `http://127.0.0.1:${port}`;
const makeServer = () => createServer(service, port, resolve('apps/web/dist'), { themes, testOnlyUnauthenticated: true });
let server = await makeServer();
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron-profile') });
let app: ElectronApplication | undefined, browser: Browser | undefined, desktop: Page | undefined, phone: Page | undefined;
const checks: string[] = [], errors: string[] = [];
let failure: string | undefined;
const record = (text: string) => { checks.push(text); console.log('PASS ' + text); };
const ready = (page: Page) => expect(page.locator('.connection-status')).toContainText('状态已查询', { timeout: 15_000 });
async function theme(page: Page, value: string) {
  if (page === phone) await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('当前主题')).toBeEnabled(); await page.getByLabel('当前主题').selectOption(value);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme-id', value);
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  if (page === phone) await page.getByRole('button', { name: '折叠导航', exact: true }).click();
}
async function open(page: Page) {
  if (page === phone && !await page.locator('.inspector').isVisible()) {
    await page.getByRole('button', { name: '会话菜单', exact: true }).click();
    await page.getByRole('menuitem', { name: '会话用量', exact: true }).click();
  } else {
    if (!await page.locator('.inspector').isVisible()) await page.getByRole('button', { name: '打开检查器', exact: true }).click();
    await page.locator('.inspector-tabs').getByRole('button', { name: '用量', exact: true }).click();
  }
  await expect(page.getByRole('region', { name: '会话用量面板', exact: true })).toBeVisible();
}
async function close(page: Page) { await page.getByRole('button', { name: '关闭面板', exact: true }).click(); }
async function drawer(open: boolean) { await phone!.getByRole('button', { name: open ? '打开导航' : '折叠导航', exact: true }).click(); }
async function geometry(page: Page, mobile = false) {
  const result = await page.locator('.inspector').evaluate(el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight,
      overflow: el.scrollWidth > el.clientWidth + 1, controls: Array.from(el.querySelectorAll('.inspector-header button')).filter(b => b.getBoundingClientRect().width > 0).map(button => {
        const b = button.getBoundingClientRect();
        return { height: b.height, x: b.x, right: b.right, hit: button.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)) };
      }) };
  });
  expect(result.x).toBeGreaterThanOrEqual(0); expect(result.y).toBeGreaterThanOrEqual(0);
  expect(result.right).toBeLessThanOrEqual(result.width + 1); expect(result.bottom).toBeLessThanOrEqual(result.height + 1);
  expect(result.overflow).toBe(false);
  for (const control of result.controls) { expect(control.hit).toBe(true); if (mobile) expect(control.height).toBeGreaterThanOrEqual(44); }
  if (!mobile && result.width >= 1280) {
    const boxes = await Promise.all(['.navigation', '.conversation', '.inspector'].map(selector => page.locator(selector).boundingBox()));
    expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(boxes[1]!.x);
    expect(boxes[1]!.x + boxes[1]!.width).toBeLessThanOrEqual(boxes[2]!.x);
  }
}
const screenshot = (page: Page, name: string) => page.screenshot({ path: join(output, name + '.png'), scale: 'css' });
async function replaceLimits(value: unknown) {
  limits = value; bus.emit('message', { method: 'account/updated', params: { authMode: 'chatgpt' } });
  await expect(desktop!.locator('.weekly-quota')).toContainText('本周额度暂不可用');
  await desktop!.getByRole('button', { name: '刷新用量', exact: true }).click();
  await expect(desktop!.getByRole('button', { name: '刷新用量', exact: true })).toBeEnabled();
}
try {
  await server.listen({ host: '127.0.0.1', port });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  await expect.poll(() => app!.windows().some(page => page.url().startsWith(origin)), { timeout: 15_000 }).toBe(true);
  desktop = app.windows().find(page => page.url().startsWith(origin))!; await ready(desktop);
  await desktop.setViewportSize({ width: 1440, height: 960 });
  browser = await chromium.launch(); phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
    userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36 OraculumAndroid/1' });
  await phone.goto(origin); await ready(phone);
  for (const page of [desktop, phone]) page.on('pageerror', error => errors.push(error.message));
  emitUsage('a'); emitUsage('a'); emitUsage('private');
  emitUsage('b', { ...tokenUsage, total: { totalTokens: 9000, inputTokens: 7000, cachedInputTokens: 5000, cacheWriteInputTokens: 0, outputTokens: 2000, reasoningOutputTokens: 1000 }, modelContextWindow: 32000 });
  for (const page of [desktop, phone]) {
    await expect(page.locator('.usage-summary, .usage-dialog')).toHaveCount(0);
    await open(page); await geometry(page, page === phone);
    await expect(page.locator('.usage-total')).toContainText('42k');
    await expect(page.locator('.usage-key-metrics')).toContainText('32,000');
    await expect(page.locator('.usage-key-metrics')).toContainText('10,000');
    await expect(page.locator('.usage-details')).not.toHaveAttribute('open', '');
    await expect(page.getByText('缓存输入', { exact: true }).first()).not.toBeVisible();
    await expect(page.locator('.token-split')).toHaveCount(1);
    await expect(page.locator('.usage-context')).toContainText('128k');
    await expect(page.locator('.session-usage progress')).toHaveCount(0);
    await page.locator('.usage-details summary').click();
    await expect(page.locator('.usage-details')).toContainText('24,000');
    await expect(page.locator('.usage-details')).toContainText('75%');
    await page.locator('.usage-details summary').click();
  }
  await expect(desktop.locator('.weekly-quota')).toContainText('58%');
  await expect(desktop.locator('.quota-ring')).toHaveAttribute('data-remaining', '58');
  await expect(desktop.locator('.weekly-quota time')).toHaveAttribute('datetime', new Date(1793635200 * 1000).toISOString());
  for (const forbidden of ['Primary', 'Secondary', 'Credits', 'review', '25%', '原生快照', '最近收到']) expect((await desktop.locator('.weekly-quota, .session-usage').allTextContents()).join('\n')).not.toContain(forbidden);
  await screenshot(desktop, '01-desktop-three-columns'); await screenshot(phone, '03-mobile-inspector');
  await close(phone); await drawer(true); await expect(phone.locator('.weekly-quota')).toContainText('58%');
  await screenshot(phone, '02-mobile-drawer'); await drawer(false);
  record('weekly remaining ring and true reset are in footer; session total and valid input/output chart are in Inspector; old banner/dialog and account activity reads are absent');
  for (const page of [desktop, phone]) {
    await open(page);
    await page.locator('.inspector-tabs').getByRole('button', { name: 'Diff', exact: true }).click();
    await expect(page.locator('.diff-editor')).toBeVisible(); await expect(page.locator('.diff-editor')).toContainText('detail = true');
    await page.locator('.inspector-tabs').getByRole('button', { name: '输出', exact: true }).click();
    await expect(page.locator('.inspector-scroll')).toContainText('tests 3');
    await page.locator('.inspector-tabs').getByRole('button', { name: '用量', exact: true }).click();
    await expect(page.locator('.usage-total')).toContainText('42k');
  }
  await phone.evaluate(() => window.oraculumAndroidBack?.()); await expect(phone.locator('.inspector')).toHaveCount(0);
  await drawer(true); await phone.locator('.session-link').filter({ hasText: '会话 B' }).click(); await ready(phone); await open(phone);
  await expect(phone.locator('.usage-total')).toContainText('9k'); await expect(desktop.locator('.usage-total')).toContainText('42k');
  await close(phone); await drawer(true); await phone.locator('.session-link').filter({ hasText: '会话 A' }).click(); await ready(phone);
  await open(phone); await expect(phone.locator('.usage-total')).toContainText('42k'); await close(phone);
  record('Diff/output remain usable; two selected threads and duplicate events stay isolated; Android Back restores the conversation');
  bus.emit('message', { method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1793203300 } } } });
  await expect(desktop.locator('.weekly-quota')).toContainText('58%');
  const fiveHours = { rateLimits: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1793203200 }, secondary: null },
    rateLimitsByLimitId: { review: { limitId: 'review', primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1793635200 } } } };
  await replaceLimits(fiveHours); await expect(desktop.locator('.weekly-quota')).toContainText('本周额度暂不可用');
  await expect(desktop.locator('.quota-ring')).toHaveCount(0);
  await phone.setViewportSize({ width: 375, height: 812 }); await drawer(true);
  await expect(phone.locator('.quota-ring')).toHaveCount(0); await screenshot(phone, '07-mobile-weekly-unavailable'); await drawer(false);
  const primaryWeek = { rateLimits: { limitId: 'codex', primary: rateLimits.rateLimits.secondary, secondary: rateLimits.rateLimits.primary } };
  await replaceLimits(primaryWeek); await expect(desktop.locator('.weekly-quota')).toContainText('58%');
  await replaceLimits(rateLimits); await expect(desktop.locator('.weekly-quota')).toContainText('58%');
  record('five-hour-only and other-product weekly buckets show unavailable; actual weekly duration works in either native window; account changes clear old quota');
  await phone.setViewportSize({ width: 390, height: 844 });
  for (const value of ['minimal-light', 'hong-kong-neon', 'old-terminal']) {
    await theme(desktop, value); await open(desktop); await geometry(desktop);
    await theme(phone, value); await open(phone); await geometry(phone, true);
    if (value === 'minimal-light') await screenshot(desktop, '04-desktop-minimal-light');
    if (value === 'hong-kong-neon') await screenshot(phone, '05-mobile-hong-kong-neon');
    if (value === 'old-terminal') await screenshot(desktop, '06-desktop-old-terminal');
    await close(phone);
  }
  for (const [width, height] of [[375, 667], [390, 844], [844, 390], [390, 430]]) {
    await phone.setViewportSize({ width, height }); await open(phone); await geometry(phone, true); await close(phone);
  }
  await phone.setViewportSize({ width: 782, height: 99 });
  await expect(phone.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  const send = (await phone.getByRole('button', { name: '发送', exact: true }).boundingBox())!;
  expect(send.y + send.height).toBeLessThanOrEqual(100);
  await phone.setViewportSize({ width: 390, height: 844 });
  await theme(desktop, 'oracle-eye'); await theme(phone, 'oracle-eye');
  record('four themes, three desktop columns, 375/390 portrait, landscape, keyboard height and 99px IME retain bounds and touch targets');
  await open(phone); await server.close();
  await expect(phone.locator('.usage-offline')).toContainText('已离线');
  await expect(phone.locator('.usage-total')).toContainText('42k'); await expect(desktop.locator('.quota-ring')).toHaveCount(0);
  await screenshot(phone, '08-mobile-offline'); await close(phone);
  server = await makeServer(); await server.listen({ host: '127.0.0.1', port });
  await phone.getByRole('button', { name: '重新连接', exact: true }).click(); await ready(phone); await open(phone);
  await expect(phone.locator('.usage-total')).toContainText('42k'); await close(phone);
  expect(requests.filter(method => method === 'turn/start')).toHaveLength(0);
  expect(requests.filter(method => method === 'account/usage/read')).toHaveLength(0);
  record('disconnect hides weekly quota, labels previous session values and reconnect restores data without sending turns or requesting account activity');
  // No server restart: method-not-found remains a read-only feature downgrade.
  unsupported = true; bus.emit('message', { method: 'account/updated', params: { authMode: null, accountId: 'do-not-forward' } });
  await open(phone); await phone.getByRole('button', { name: '刷新用量', exact: true }).click();
  await close(phone); await drawer(true); await expect(phone.locator('.weekly-quota')).toContainText('本周额度暂不可用');
  expect(await phone.locator('body').innerText()).not.toContain('do-not-forward'); await drawer(false);
  await expect(phone.getByRole('textbox', { name: '消息' })).toBeEnabled(); expect(errors).toEqual([]);
  record('unsupported interfaces and account changes leave quota unavailable while Composer remains enabled');
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  for (const [name, page] of [['electron', desktop], ['mobile', phone]] as const) if (page) await page.screenshot({ path: join(output, `failure-${name}.png`) }).catch(() => {});
  throw error;
} finally {
  await writeFile(join(output, 'result.json'), JSON.stringify({ simulation: true, realElectron: true, androidDevice: false, checks, requests, errors, failure }, null, 2));
  console.log(output);
  await browser?.close(); await app?.close(); await server.close();
}
