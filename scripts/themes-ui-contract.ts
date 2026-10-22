// Real Electron + emulated mobile Chromium; native Codex events are SIMULATED.
import { _electron as electron, chromium, expect, type ElectronApplication, type Browser, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Themes } from '../bridge/src/themes';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import type { WireMessage } from '../packages/shared/protocol';

const cwd = '/theme-contract', id = 'theme-contract-thread';
const history = { id: 'history', status: 'completed', error: null, itemsView: 'full', items: [
  { id: 'message', type: 'agentMessage', text: '## Theme contract\n\n模拟协议，仅用于主题合约。\n\n' + '长段落布局检查。\n\n'.repeat(30) },
] };
const thread = { id, name: '主题合约 · 模拟', cwd, preview: '', status: { type: 'idle' }, turns: [history] };
const bus = new EventEmitter(); const calls: string[] = [], replies: WireMessage[] = [];
const codex = {
  on: bus.on.bind(bus), send: (reply: WireMessage) => { replies.push(reply); bus.emit('message', { method: 'serverRequest/resolved', params: { threadId: id, requestId: reply.id } }); },
  request: async <T>(method: string, params: any): Promise<T> => {
    calls.push(method); let value: unknown;
    if (method === 'config/read') value = { config: { model: 'fixture', model_provider: 'fixture' } };
    else if (method === 'model/list') value = { data: [], nextCursor: null };
    else if (method === 'thread/list') value = { data: [thread], nextCursor: null };
    else if (method === 'thread/read' || method === 'thread/resume') value = { thread };
    else if (method === 'thread/turns/list') value = { data: [...thread.turns].reverse(), nextCursor: null };
    else if (method === 'thread/items/list') value = { data: thread.turns.find(turn => turn.id === params.turnId)!.items.map(item => ({ turnId: params.turnId, item })), nextCursor: null };
    else if (method === 'turn/interrupt') { const turn = thread.turns.at(-1)!; turn.status = 'interrupted'; bus.emit('message', { method: 'turn/completed', params: { threadId: id, turn } }); value = {}; }
    else throw new Error(`Unexpected fixture request: ${method}`);
    return structuredClone(value) as T;
  },
};
await mkdir('.local/evidence/phase3/themes-contract', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/phase3/themes-contract/run-'));
const themes = new Themes({ source: resolve('themes'), installed: join(output, 'installed') });
const service = new BridgeService(codex, cwd), port = 17870, origin = `http://127.0.0.1:${port}`;
const server = await createServer(service, port, resolve('apps/web/dist'), { themes, testOnlyUnauthenticated: true });
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron') });
let app: ElectronApplication | undefined, browser: Browser | undefined, desktop: Page, phone: Page;
const results: string[] = [], errors: string[] = [];
const ready = (page: Page) => expect(page.getByRole('status', { includeHidden: true })).toContainText('状态已查询');
async function settings(page: Page) {
  if (await page.locator('.app-settings').isVisible()) return;
  if (page === phone && !await page.locator('.app-shell').evaluate(e => e.classList.contains('drawer-open'))) await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('当前主题')).toBeEnabled();
}
async function closeSettings(page: Page) {
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  if (page === phone && await page.locator('.app-shell').evaluate(e => e.classList.contains('drawer-open'))) await page.getByRole('button', { name: '折叠导航', exact: true }).click();
}
async function select(page: Page, value: string) {
  await settings(page); await page.getByRole('button', { name: '刷新主题列表', exact: true }).click();
  await expect(page.getByLabel('当前主题')).toBeEnabled(); await page.getByLabel('当前主题').selectOption(value);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme-id', value); await closeSettings(page);
}
async function record(name: string) { results.push(name); console.log('PASS ' + name); }
try {
  await server.listen({ host: '127.0.0.1', port });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  desktop = await app.firstWindow(); desktop.on('pageerror', e => errors.push(e.message)); await ready(desktop);
  browser = await chromium.launch(); phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  phone.on('pageerror', e => errors.push(e.message)); await phone.goto(origin); await ready(phone);
  await settings(phone); await phone.getByText('从主机主题目录安装', { exact: true }).click();
  await phone.getByRole('button', { name: '安装 Violet · 验收测试', exact: true }).click();
  await expect(phone.getByLabel('当前主题')).toBeEnabled();
  await expect(phone.locator('.app-shell')).toHaveAttribute('data-theme-id', 'oracle-eye'); await closeSettings(phone);
  await select(desktop, 'test-violet');
  await expect(phone.locator('.app-shell')).toHaveAttribute('data-theme-id', 'oracle-eye');
  await expect.poll(() => desktop.locator('.app-shell').evaluate(e => getComputedStyle(e).getPropertyValue('--accent').trim())).toBe('#dbb3ff');
  await desktop.getByLabel('消息', { exact: true }).fill('主题切换不发送此草稿');
  await select(desktop, 'oracle-eye'); await expect(desktop.getByLabel('消息', { exact: true })).toHaveValue('主题切换不发送此草稿');
  await select(desktop, 'test-violet'); await app.close();
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env }); desktop = await app.firstWindow(); await ready(desktop);
  await expect(desktop.locator('.app-shell')).toHaveAttribute('data-theme-id', 'test-violet');
  await expect(phone.locator('.app-shell')).toHaveAttribute('data-theme-id', 'oracle-eye');
  await record('explicit GUI install, independent devices, no turn on switch, actual Electron process restart');
  await select(phone, 'test-violet');
  for (const [width, height] of [[375, 812], [390, 844], [844, 390], [782, 99]]) {
    await phone.setViewportSize({ width, height });
    await expect.poll(() => phone.locator('.composer').evaluate(e => e.getBoundingClientRect().bottom)).toBeLessThanOrEqual(height + 1);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const button = await phone.getByRole('button', { name: '发送', exact: true }).boundingBox(); expect(button!.height).toBeGreaterThanOrEqual(48);
  }
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.evaluate(() => { const b = document.createElement('button'); b.textContent = 'Future host control'; document.querySelector('.composer-toolbar')!.append(b); });
  const future = phone.getByRole('button', { name: 'Future host control' }); await expect(future).toBeVisible();
  expect(await future.evaluate(e => getComputedStyle(e).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)'); await future.evaluate(e => e.remove());
  await record('375/390, landscape/99px IME geometry and unknown future control defaults');
  const active = { ...history, id: 'active', status: 'inProgress', items: [] }; thread.turns.push(active);
  bus.emit('message', { method: 'turn/started', params: { threadId: id, turn: active } });
  for (const [requestId, label] of [[80, '允许本次'], [81, '拒绝']] as const) {
    bus.emit('message', { id: requestId, method: 'item/commandExecution/requestApproval', params: { threadId: id, turnId: 'active', itemId: String(requestId), command: 'printf simulated', cwd } });
    const button = phone.getByRole('button', { name: label, exact: true }); await expect(button).toBeVisible(); await button.scrollIntoViewIfNeeded();
    await expect(button).toBeEnabled(); expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    expect(await phone.locator('.approval').evaluate(e => getComputedStyle(e).getPropertyValue('--accent').trim())).toBe('#62d8ff');
    await button.click(); await expect(desktop.locator('.approval')).toHaveCount(0); await expect(phone.locator('.approval')).toHaveCount(0);
  }
  await phone.getByRole('button', { name: '停止', exact: true }).click(); expect(replies).toHaveLength(2);
  await expect(phone.getByTestId('last-turn-status')).toHaveText('interrupted');
  await record('themed allow/decline/stop remain reachable with protected host palette');
  const installed = join(themes.paths.installed, 'test-violet');
  const originalCss = await readFile(join(installed, 'theme.css'), 'utf8'), originalManifest = await readFile(join(installed, 'manifest.json'), 'utf8');
  for (const [name, file, broken] of [
    ['incompatible', 'manifest.json', originalManifest.replace('"themeApi": 1', '"themeApi": 99')],
    ['damaged', 'theme.css', ':root{--accent:'], ['concealed-actions', 'theme.css', '.send-button,.approval,.settings-button{display:none}'],
  ]) {
    await writeFile(join(installed, file), broken); await phone.reload(); await ready(phone);
    await expect(phone.locator('.app-shell')).toHaveAttribute('data-theme-id', 'oracle-eye'); await expect(phone.getByRole('alert')).toContainText('已恢复默认主题');
    await writeFile(join(installed, file), file === 'theme.css' ? originalCss : originalManifest); await select(phone, 'test-violet');
    await record(name + ' falls back to built-in default');
  }
  await rm(installed, { recursive: true }); await phone.reload(); await ready(phone);
  await expect(phone.getByRole('alert')).toContainText('已恢复默认主题'); await themes.install('test-violet');
  await select(phone, 'test-violet'); await phone.route('**/themes/test-violet/bundle', route => route.abort()); await phone.reload(); await ready(phone);
  await expect(phone.getByRole('alert')).toContainText('已恢复默认主题'); await phone.unroute('**/themes/test-violet/bundle');
  await record('missing package and network failure preserve usable default');
  // Deliberately bypass the package validator to simulate total page obstruction.
  // Native recovery must work even beyond what installed themes are allowed to do.
  await select(desktop, 'test-violet');
  await desktop.addStyleTag({ content: 'body{visibility:hidden!important}' });
  // CDP keyboard injection bypasses Electron native accelerators. Exercise the
  // actual native menu item, not a renderer handler or direct location change.
  await app.evaluate(({ Menu }) => { const item = Menu.getApplicationMenu()!.getMenuItemById('restore-default-theme')!; item.click(); });
  await ready(desktop);
  await expect(desktop.locator('.app-shell')).toHaveAttribute('data-theme-id', 'oracle-eye'); await expect(desktop.getByLabel('消息', { exact: true })).toBeVisible();
  await record('native Electron menu recovers a completely hidden page');
  expect(calls).not.toContain('turn/start'); expect(errors).toEqual([]);
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  await app?.close(); await browser?.close(); await server.close();
  await writeFile(join(output, 'contract.json'), JSON.stringify({ simulated: true, results, errors, passed: !process.exitCode }, null, 2));
  console.log(JSON.stringify({ simulated: true, output, checks: results.length, passed: !process.exitCode }));
}
