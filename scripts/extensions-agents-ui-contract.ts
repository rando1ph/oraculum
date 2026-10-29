// Actual Ubuntu Electron + Chromium touch viewports, isolated authenticated
// Bridge and synthetic native events. No ADB, Android device, packaging or install.
import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../bridge/src/server';
import { BridgeService } from '../bridge/src/service';
import { TrustStore } from '../bridge/src/trust-store';
import { ReceiptStore } from '../bridge/src/receipts';
import { ProjectDirectories } from '../bridge/src/projects';
import { Themes } from '../bridge/src/themes';
import { NativeRpcError } from '../bridge/src/codex';
import { rateLimits } from './fixtures/usage';
import { loopbackTlsFixture } from './loopback-tls-fixture';

await mkdir('.local/evidence/r1-b6/ui', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/r1-b6/ui/run-'));
const temporary = await mkdtemp(join(tmpdir(), 'oraculum-b6-')), root = join(temporary, 'Projects'), cwd = join(root, '协作演示');
await mkdir(cwd, { recursive: true });
const trust = new TrustStore(join(temporary, 'state')), projects = new ProjectDirectories(root, cwd, trust.db);
await projects.register(cwd);
const turn: any = { id: 'parent-turn', status: 'completed', itemsView: 'full', error: null, startedAt: 100, completedAt: 110, durationMs: 10000, items: [
  { id: 'user', type: 'userMessage', content: [{ type: 'text', text: '请并行核对文档与界面，汇总验证结果。' }] },
  { id: 'answer', type: 'agentMessage', text: '已准备协作验证。此会话只使用合成数据。', phase: 'final_answer' },
] };
const parent: any = { id: 'parent', name: '协作验证 · 合成数据', preview: '合成数据', cwd, parentThreadId: null, source: 'appServer', ephemeral: false, status: { type: 'idle' }, turns: [turn] };
const threads = new Map<string, any>([['parent', parent]]);
const settings = { approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: [] }, approvalsReviewer: 'user', model: 'fixture', reasoningEffort: 'low' };
const bus = new EventEmitter(), calls: string[] = [];
let inventoryMode = 'ready', slowInventory: Promise<void> | undefined;
const codex = { on: bus.on.bind(bus), send: () => {}, request: async <T>(method: string, params: any): Promise<T> => {
  calls.push(method); const thread = threads.get(params.threadId); let value: any;
  if (['skills/list', 'mcpServerStatus/list', 'app/installed', 'plugin/list'].includes(method)) {
    await slowInventory;
    if (inventoryMode === 'empty') value = method === 'skills/list' ? { data: [{ cwd, skills: [], errors: [] }] } : method === 'app/installed' ? { apps: [] } : method === 'plugin/list' ? { marketplaces: [], marketplaceLoadErrors: [] } : { data: [], nextCursor: null };
    else if (inventoryMode === 'errors' && method === 'app/installed') throw new NativeRpcError('403 Cloudflare fixture', -32000);
    else if (inventoryMode === 'errors' && method === 'plugin/list') throw new NativeRpcError('Method not found', -32601);
    else if (method === 'skills/list') value = { data: [{ cwd, skills: [
      { name: 'scientific-critical-thinking', description: '评估科学论断与证据质量。', scope: 'user', enabled: true },
      { name: 'project-review', description: '核对项目变更与验证结果。', scope: 'repo', enabled: true },
      { name: 'archived-workflow', description: '已停用的历史工作流。', scope: 'user', enabled: false },
    ], errors: [] }] };
    else if (method === 'mcpServerStatus/list') value = { data: params.cursor ? [{ name: 'reference-library', runtimeStatus: 'disabled', authStatus: 'unknown', tools: {} }] : [
      { name: 'documentation', runtimeStatus: 'connected', authStatus: 'unsupported', tools: { read: {}, search: {} } },
      { name: 'workspace-notes', runtimeStatus: 'authenticationRequired', authStatus: 'notLoggedIn', tools: {} },
    ], nextCursor: params.cursor ? null : 'mcp-page-2' };
    else if (method === 'app/installed') value = { apps: [
      { id: 'drive', runtimeName: 'Google Drive', enabled: true, callable: true },
      { id: 'calendar', runtimeName: 'Calendar', enabled: false, callable: false },
    ] };
    else value = { marketplaces: [{ plugins: [
      { id: 'writing', name: 'Research Writing', installed: true, enabled: true, source: { type: 'remote' }, availability: 'AVAILABLE', interface: { shortDescription: '组织文献资料与研究写作流程。' } },
      { id: 'local', name: 'Project Notes', installed: true, enabled: false, source: { type: 'local' }, availability: 'AVAILABLE', interface: { shortDescription: '本地笔记扩展，当前已禁用。' } },
      { id: 'catalog', name: 'Catalog only', installed: false, enabled: false },
    ] }], marketplaceLoadErrors: [] };
  } else if (method === 'config/read') value = { config: { model: 'fixture', model_reasoning_effort: 'low', model_provider: 'fixture', approval_policy: 'on-request', sandbox_mode: 'workspace-write', approvals_reviewer: 'user' } };
  else if (method === 'model/list') value = { data: [{ id: 'fixture', model: 'fixture', displayName: 'Codex · 界面验证', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null };
  else if (method === 'account/rateLimits/read') value = { rateLimits, rateLimitsByLimitId: { codex: rateLimits } };
  else if (method === 'thread/list') value = { data: params.archived ? [] : [parent], nextCursor: null };
  else if (method === 'thread/read') value = { thread };
  else if (method === 'thread/resume') value = { thread, ...settings };
  else if (method === 'thread/turns/list') value = { data: thread.turns, nextCursor: null };
  else if (method === 'thread/items/list') value = { data: thread.turns.flatMap((turn: any) => turn.items.map((item: any) => ({ turnId: turn.id, item }))), nextCursor: null };
  else throw new Error('Unexpected fixture method: ' + method);
  return structuredClone(value) as T;
} };
const service = new BridgeService(codex, cwd, new ReceiptStore(trust.db), projects);
const port = 17906, origin = `http://127.0.0.1:${port}`, proxy = await loopbackTlsFixture(port);
const server = await createServer(service, port, resolve('apps/web/dist'), { trust, remoteOrigin: proxy.origin, remoteBasePath: '/console/',
  themes: new Themes({ source: resolve('themes'), builtin: resolve('themes'), installed: join(temporary, 'themes') }) });
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(temporary, 'electron-profile') });
let app: ElectronApplication | undefined, browser: Browser | undefined, failure: string | undefined;
const checks: string[] = [], screenshots: string[] = [], errors: string[] = [];
const record = (message: string) => { checks.push(message); console.log('PASS ' + message); };
const ready = (page: Page) => expect(page.locator('.connection-status')).toContainText('状态已查询', { timeout: 15000 });
async function pair(page: Page, name: string) {
  await page.getByLabel('设备名称', { exact: true }).fill(name); await page.getByLabel('配对码', { exact: true }).fill(trust.createPairing().code);
  await page.getByRole('button', { name: '配对并连接', exact: true }).click(); await ready(page);
}
async function openSettings(page: Page) {
  const nav = page.getByRole('button', { name: '打开导航', exact: true });
  if (await nav.isVisible() && !await page.locator('.app-shell').evaluate(el => el.classList.contains('drawer-open'))) await nav.click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
}
async function closeSettings(page: Page) {
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  if (await page.locator('.app-shell').evaluate(el => el.classList.contains('drawer-open'))) await page.locator('.nav-close').click();
}
async function theme(page: Page, id: string) {
  await openSettings(page); await page.getByLabel('当前主题').selectOption(id);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme-id', id); await closeSettings(page);
}
async function openExtensions(page: Page) {
  await openSettings(page); await page.locator('.extension-settings > summary').click();
  await expect(page.locator('.extension-group')).toHaveCount(4); await page.locator('.extension-settings').scrollIntoViewIfNeeded();
}
async function group(page: Page, kind: string) { await page.locator(`[data-extension-kind="${kind}"] > summary`).click(); }
async function geometry(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  for (const element of await page.locator('.extension-settings summary, .extension-toolbar button').all()) {
    if (!await element.isVisible()) continue;
    const box = await element.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeLessThan(page.viewportSize()!.width);
  }
}
async function capture(page: Page, name: string) {
  const path = join(output, name + '.png'); await page.screenshot({ path, scale: 'css' }); screenshots.push(path);
}
try {
  await server.listen({ host: '127.0.0.1', port });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  await expect.poll(() => app!.windows().some(page => page.url().startsWith(origin)), { timeout: 15000 }).toBe(true);
  const desktop = app.windows().find(page => page.url().startsWith(origin))!;
  await desktop.setViewportSize({ width: 1440, height: 960 }); desktop.on('pageerror', error => errors.push(error.message)); await pair(desktop, 'B6 桌面验证');
  browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const phone = await context.newPage(); phone.on('pageerror', error => errors.push(error.message)); await phone.goto(proxy.origin + '/console/'); await pair(phone, 'B6 移动模拟');
  for (const id of ['oracle-eye', 'hong-kong-neon', 'old-terminal', 'minimal-light']) {
    for (const page of [desktop, phone]) {
      await theme(page, id); await openExtensions(page);
      await group(page, 'skills'); await expect(page.locator('[data-extension-kind="skills"] .extension-entry')).toHaveCount(3);
      await expect(page.locator('[data-extension-kind="skills"]')).toContainText('已禁用'); await group(page, 'skills');
      await group(page, 'mcp'); await expect(page.locator('[data-extension-kind="mcp"] .extension-entry')).toHaveCount(3);
      await expect(page.locator('[data-extension-kind="mcp"]')).toContainText('不提供认证状态'); await geometry(page);
      if (page === desktop && id === 'oracle-eye') { await page.locator('.extension-settings').evaluate(el => el.scrollIntoView({ block: 'start' })); await capture(page, '01-desktop-extensions-mcp'); }
      await group(page, 'mcp'); await group(page, 'apps'); await group(page, 'plugins');
      await expect(page.locator('[data-extension-kind="apps"]')).toContainText('可调用');
      await expect(page.locator('[data-extension-kind="plugins"] .extension-entry')).toHaveCount(2); await geometry(page);
      if (page === phone && id === 'minimal-light') { await page.locator('.extension-settings').evaluate(el => el.scrollIntoView({ block: 'start' })); await capture(page, '02-phone-extensions-apps-plugins'); }
      await closeSettings(page);
    }
  }
  record('four themes: real Electron and HTTPS subpath Chromium 390px; native scopes, installed/enabled/callable distinctions, MCP pagination and unsupported auth');
  inventoryMode = 'errors'; await openExtensions(phone); await group(phone, 'apps'); await group(phone, 'plugins');
  await expect(phone.locator('[data-extension-kind="apps"]')).toContainText('拒绝访问'); await expect(phone.locator('[data-extension-kind="plugins"]')).toContainText('不支持');
  inventoryMode = 'empty'; await phone.getByRole('button', { name: '刷新扩展' }).click();
  await expect(phone.locator('[data-extension-kind="apps"]')).toContainText('暂无项目'); await expect(phone.locator('[data-extension-kind="plugins"]')).toContainText('未返回');
  let release!: () => void; slowInventory = new Promise(resolve => { release = resolve; });
  await phone.getByRole('button', { name: '刷新扩展' }).click(); await expect(phone.locator('.extension-content')).toContainText('正在读取扩展');
  await expect(phone.getByRole('button', { name: '刷新扩展' })).toBeDisabled(); release(); slowInventory = undefined;
  await expect(phone.locator('.extension-group')).toHaveCount(4); await closeSettings(phone); inventoryMode = 'ready';
  record('manual refresh, loading, empty, independent 403 and unsupported degradation preserve core connection');
  for (const viewport of [{ width: 375, height: 812 }, { width: 844, height: 390 }, { width: 390, height: 420 }]) {
    await phone.setViewportSize(viewport); await openExtensions(phone); await group(phone, 'skills'); await geometry(phone); await closeSettings(phone);
  }
  record('375px, landscape and short keyboard viewport retain bounded list scrolling and touch targets');
  expect(calls).not.toContain('app/list'); expect(calls).not.toContain('plugin/read'); expect(errors).toEqual([]);
} catch (error) { failure = error instanceof Error ? error.stack : String(error); console.error(failure); }
finally {
  await writeFile(join(output, 'report.json'), JSON.stringify({ scope: 'synthetic native data; actual Electron and Chromium mobile emulation; no Android device', checks, screenshots, errors, failure }, null, 2));
  await app?.close(); await browser?.close(); await server.close(); await proxy.close(); trust.close(); await rm(temporary, { recursive: true, force: true });
}
console.log('Evidence: ' + output); if (failure) process.exitCode = 1;
