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
const threads: any[] = ['a', 'b'].map(id => ({ id, name: `用量合约 · 会话 ${id.toUpperCase()}`, cwd, preview: '', status: { type: 'idle' }, turns: [
  { id: `turn-${id}`, status: 'completed', itemsView: 'full', error: null, items: [{ id: `answer-${id}`, type: 'agentMessage', text: '这是合成的原生用量验收场景。\n\n累计与最近一次 Token 分开显示；缓存输入和推理输出是子集。\n\n| 项目 | 状态 |\n| --- | --- |\n| GFM 表格 | 保持正常 |\n| 上下文 | 仅显示原生窗口上限 |' }] },
] }));
const bus = new EventEmitter(), requests: string[] = [];
let unsupported = false;
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
  else if (method === 'account/rateLimits/read') { if (unsupported) throw new NativeRpcError('not found', -32601); result = rateLimits; }
  else if (method === 'account/usage/read') { if (unsupported) throw new NativeRpcError('not found', -32601); result = { summary: { lifetimeTokens: 1250000, peakDailyTokens: 84000 } }; }
  else throw new Error(`Unexpected fixture request: ${method}`);
  return structuredClone(result) as T;
} };
const emitUsage = (threadId: string, usage = tokenUsage) => bus.emit('message', { method: 'thread/tokenUsage/updated', params: { threadId, turnId: `turn-${threadId}`, tokenUsage: usage } });
await mkdir('.local/evidence/r1-b3/ui', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/r1-b3/ui/run-'));
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
  await page.getByRole('button', { name: '用量详情', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '用量', exact: true })).toBeVisible();
}
async function close(page: Page) { await page.getByRole('button', { name: '关闭用量', exact: true }).click(); }
async function geometry(page: Page) {
  const result = await page.locator('.usage-dialog').evaluate(el => {
    const r = el.getBoundingClientRect(), button = el.querySelector('button')!, b = button.getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight,
      overflow: el.scrollWidth > el.clientWidth + 1, hit: button.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)), buttonHeight: b.height };
  });
  expect(result.x).toBeGreaterThanOrEqual(0); expect(result.y).toBeGreaterThanOrEqual(0);
  expect(result.right).toBeLessThanOrEqual(result.width); expect(result.bottom).toBeLessThanOrEqual(result.height);
  expect(result.overflow).toBe(false); expect(result.hit).toBe(true); expect(result.buttonHeight).toBeGreaterThanOrEqual(44);
}
try {
  await server.listen({ host: '127.0.0.1', port });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  await expect.poll(() => app!.windows().some(page => page.url().startsWith(origin)), { timeout: 15_000 }).toBe(true);
  desktop = app.windows().find(page => page.url().startsWith(origin))!; await ready(desktop);
  browser = await chromium.launch(); phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.goto(origin); await ready(phone);
  for (const page of [desktop, phone]) page.on('pageerror', error => errors.push(error.message));
  emitUsage('a'); emitUsage('a'); emitUsage('private');
  emitUsage('b', { ...tokenUsage, total: { ...tokenUsage.total, totalTokens: 9000 }, modelContextWindow: 32000 });
  for (const page of [desktop, phone]) {
    await expect(page.locator('.usage-summary')).toContainText('42,000 Token'); await expect(page.locator('.usage-summary')).toContainText('已用 25%');
    await open(page); await geometry(page);
    await expect(page.locator('.usage-dialog')).toContainText('当前占用未知');
    await expect(page.locator('.usage-dialog progress')).toHaveCount(3);
    await expect(page.locator('.usage-counts').first()).toContainText('42,000');
    await page.locator('.usage-activity summary').click();
    await expect(page.locator('.usage-activity')).toContainText('1,250,000');
    await geometry(page);
    await page.locator('.usage-dialog').evaluate(element => element.scrollTop = 0);
    await page.screenshot({ path: join(output, `01-default-${page === phone ? 'mobile' : 'electron'}.png`) });
    await close(page);
  }
  record('real Electron and mobile share native snapshots, subset counters, unknown occupancy, multiple quota buckets and optional activity');
  // Rapid selection must never project A counters onto B or vice versa.
  await phone.getByRole('button', { name: '打开导航', exact: true }).click();
  await phone.locator('.session-link').filter({ hasText: '会话 B' }).click(); await ready(phone);
  await expect(phone.locator('.usage-summary')).toContainText('9,000 Token');
  await expect(desktop.locator('.usage-summary')).toContainText('42,000 Token');
  await phone.getByRole('button', { name: '打开导航', exact: true }).click();
  await phone.locator('.session-link').filter({ hasText: '会话 A' }).click(); await ready(phone);
  await expect(phone.locator('.usage-summary')).toContainText('42,000 Token');
  record('two threads and independent device selection remain isolated; duplicate delivery does not add tokens');
  bus.emit('message', { method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1793203300 } } } });
  for (const page of [desktop, phone]) {
    await expect(page.locator('.usage-summary')).toContainText('Codex 已用 31%');
    await open(page); await expect(page.locator('.usage-dialog')).toContainText('已用 42%'); await close(page);
  }
  record('sparse global updates arrive on both devices and retain secondary windows and bucket labels');
  await open(phone); await phone.locator('.usage-bucket').first().scrollIntoViewIfNeeded();
  await phone.screenshot({ path: join(output, '02-quota-mobile.png') }); await close(phone);
  for (const value of ['minimal-light', 'hong-kong-neon', 'old-terminal']) {
    for (const page of [desktop, phone]) { await theme(page, value); await open(page); await geometry(page); }
    await phone.screenshot({ path: join(output, `02-${value}-mobile.png`) });
    for (const page of [desktop, phone]) await close(page);
  }
  for (const [width, height] of [[375, 667], [844, 390], [390, 430]]) {
    await phone.setViewportSize({ width, height }); await open(phone); await geometry(phone); await close(phone);
  }
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.evaluate(() => document.documentElement.style.fontSize = '150%'); await open(phone); await geometry(phone); await close(phone);
  await phone.evaluate(() => document.documentElement.style.fontSize = '');
  record('four themes, 375/390 portrait, landscape, short viewport and font scaling preserve modal bounds and 44px close target');
  await theme(phone, 'oracle-eye'); await theme(desktop, 'oracle-eye');
  await open(phone); await phone.evaluate(() => window.oraculumAndroidBack?.()); await expect(phone.locator('.usage-dialog')).not.toBeVisible();
  await open(desktop); await desktop.keyboard.press('Escape'); await expect(desktop.locator('.usage-dialog')).not.toBeVisible();
  record('Android UI Back callback and desktop Escape dismiss the modal without disturbing Composer');
  await server.close();
  await expect(phone.locator('.usage-summary')).toContainText('已断线'); await open(phone);
  await expect(phone.locator('.usage-dialog')).toContainText('会话数据为缓存');
  await phone.screenshot({ path: join(output, '03-disconnected-mobile.png') }); await close(phone);
  server = await makeServer(); await server.listen({ host: '127.0.0.1', port });
  await phone.getByRole('button', { name: '重新连接', exact: true }).click(); await ready(phone);
  await expect(phone.locator('.usage-summary')).toContainText('42,000 Token');
  expect(requests.filter(m => m === 'turn/start')).toHaveLength(0);
  record('disconnect hides account values, labels cached thread data; reconnect restores snapshots without executing turns');
  unsupported = true; bus.emit('message', { method: 'account/updated', params: { authMode: null, accountId: 'do-not-forward' } });
  bus.emit('message', { method: 'account/rateLimits/updated', params: rateLimits });
  await open(phone); await expect(phone.locator('.usage-dialog')).toContainText('当前 Codex 不支持额度接口');
  await expect(phone.locator('.usage-dialog progress')).toHaveCount(0);
  await phone.screenshot({ path: join(output, '04-unsupported-mobile.png') });
  expect(await phone.locator('body').innerText()).not.toContain('do-not-forward');
  await close(phone); await expect(phone.getByRole('textbox', { name: '消息' })).toBeEnabled();
  record('account change clears old values and method-not-found degrades only the panel');
  expect(errors).toEqual([]);
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  for (const [name, page] of [['electron', desktop], ['mobile', phone]] as const) if (page) await page.screenshot({ path: join(output, `failure-${name}.png`) }).catch(() => {});
  throw error;
} finally {
  await writeFile(join(output, 'result.json'), JSON.stringify({ simulation: true, realElectron: true, androidDevice: false, checks, requests, errors, failure }, null, 2));
  console.log(output);
  await browser?.close(); await app?.close(); await server.close();
}
