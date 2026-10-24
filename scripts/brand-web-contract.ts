// Real Chromium rendering with an explicitly simulated native Codex/registry.
// No model calls, phone installation, production service or Electron sandbox claim.
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { createServer as createPortProbe } from 'node:net';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import { Themes } from '../bridge/src/themes';
import type { Thread, WireMessage } from '../packages/shared/protocol';

const cwd = '/brand-contract';
const threads: Thread[] = [];
const bus = new EventEmitter(), calls: string[] = [];
let available = true;
const codex = {
  on: bus.on.bind(bus), send: (_message: WireMessage) => { throw new Error('No native replies are expected'); },
  request: async <T>(method: string, params: any): Promise<T> => {
    calls.push(method);
    let result: unknown;
    if (method === 'config/read') result = { config: { model: 'fixture', model_provider: 'fixture' } };
    else if (method === 'model/list') result = { data: [], nextCursor: null };
    else if (method === 'thread/list') result = { data: [...threads].reverse(), nextCursor: null };
    else if (method === 'thread/start') {
      const thread = { id: `brand-thread-${threads.length + 1}`, cwd, name: '', preview: '', status: { type: 'idle' }, turns: [] } as unknown as Thread;
      threads.push(thread); result = { thread };
    } else if (method === 'thread/read' || method === 'thread/resume') result = { thread: threads.find(thread => thread.id === params.threadId) };
    else if (method === 'thread/turns/list') result = { data: [], nextCursor: null };
    else throw new Error(`Unexpected simulated native request: ${method}`);
    return structuredClone(result) as T;
  },
};
const service = new BridgeService(codex, cwd);
const dispatch = service.dispatch.bind(service);
service.dispatch = async (method, params, context) => method === 'bridge/projects'
  ? { root: '/', projects: [{ cwd, name: '品牌验收 · 模拟项目', available }] }
  : dispatch(method, params, context);
const probe = createPortProbe(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = (probe.address() as { port: number }).port;
await new Promise<void>(accept => probe.close(() => accept()));
const origin = `http://127.0.0.1:${port}`;
await mkdir('.local/evidence/phase4b/brand-web', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/phase4b/brand-web/run-'));
const themes = new Themes({ source: resolve('themes'), installed: join(output, 'installed-themes') });
await themes.install('minimal-light');
const server = await createServer(service, port, resolve('apps/web/dist'), { themes, testOnlyUnauthenticated: true });
const results: string[] = [], errors: string[] = [];
let browser: Browser | undefined;
const ready = (page: Page) => expect(page.getByRole('status', { includeHidden: true })).toContainText('状态已查询');
const state = async (page: Page, kind: string, copy: string) => {
  await expect(page.locator('.empty-state')).toHaveAttribute('data-brand-state', kind);
  await expect(page.locator('.empty-state h2')).toHaveText(copy);
  await expect(page.locator('.empty-state h2')).toBeVisible();
};
const record = (name: string) => { results.push(name); console.log(`PASS ${name}`); };
async function geometry(page: Page) {
  const viewport = page.viewportSize()!;
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const heading = await page.locator('.empty-state h2').boundingBox();
  const logo = await page.locator('.oracle-logo').boundingBox();
  const scroll = await page.locator('.conversation-scroll').boundingBox();
  expect(heading).not.toBeNull(); expect(heading!.x).toBeGreaterThanOrEqual(0);
  expect(heading!.x + heading!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(logo!.y, 'brand mark must remain inside the reading viewport').toBeGreaterThanOrEqual(scroll!.y - 1);
  expect(heading!.y + heading!.height, 'brand copy must not be hidden by the composer').toBeLessThanOrEqual(scroll!.y + scroll!.height + 1);
  await expect.poll(async () => (await page.locator('.composer').boundingBox())!.y + (await page.locator('.composer').boundingBox())!.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await page.locator('.oracle-logo-eye').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
}
try {
  await server.listen({ host: '127.0.0.1', port });
  browser = await chromium.launch();
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  desktop.on('pageerror', error => errors.push(error.message));
  await desktop.goto(origin); await ready(desktop);
  await expect(desktop).toHaveTitle('Oraculum · 神谕');
  await state(desktop, 'beforeThread', '万象俯首，静候神谕。');
  expect(calls.filter(method => method === 'thread/start' || method === 'turn/start')).toEqual([]);
  await expect(desktop.getByLabel('消息', { exact: true })).toHaveAttribute('placeholder', '意志将临…');
  await expect(desktop.getByLabel('消息', { exact: true })).toHaveAttribute('maxlength', '16000');
  await desktop.getByRole('button', { name: '打开检查器', exact: true }).click();
  await expect(desktop.locator('.inspector-empty h2')).toHaveText('洞见幽微');
  await expect(desktop.locator('.inspector-empty p')).toHaveText('所行皆迹，所隐皆明。');
  await geometry(desktop); await desktop.screenshot({ path: join(output, 'desktop-before-thread.png') });
  await desktop.getByRole('button', { name: '关闭面板', exact: true }).click();
  await desktop.getByRole('button', { name: '启封神谕', exact: true }).click();
  await state(desktop, 'createdThread', '谕章初启，诸界屏息。');
  expect(calls.filter(method => method === 'thread/start')).toHaveLength(1);
  await desktop.getByLabel('消息', { exact: true }).fill('保留中文草稿，不发送。');
  await desktop.screenshot({ path: join(output, 'desktop-created-thread.png') });
  await desktop.getByRole('button', { name: '查询状态', exact: true }).click(); await ready(desktop);
  await state(desktop, 'existingThread', '谕令未书，万象屏息。');
  await expect(desktop.getByLabel('消息', { exact: true })).toHaveValue('保留中文草稿，不发送。');
  record('exact eight approved copy, creation semantics, explicit refresh and preserved draft');

  await desktop.getByRole('button', { name: '新建会话', exact: true }).click();
  await state(desktop, 'createdThread', '谕章初启，诸界屏息。');
  await desktop.locator('nav[aria-label="原生会话"] button[data-thread-id="brand-thread-1"]').click(); await ready(desktop);
  await state(desktop, 'existingThread', '谕令未书，万象屏息。');
  await desktop.locator('nav[aria-label="原生会话"] button[data-thread-id="brand-thread-2"]').click(); await ready(desktop);
  await state(desktop, 'existingThread', '谕令未书，万象屏息。');
  await desktop.reload(); await ready(desktop);
  await state(desktop, 'existingThread', '谕令未书，万象屏息。');
  expect(calls.filter(method => method === 'thread/start')).toHaveLength(2);
  record('creation marker is ephemeral across switch, reopening and page reload');

  available = false; service.emit('event', { type: 'projectsChanged' });
  await state(desktop, 'noProject', '万象无疆，诸界未名。');
  await expect(desktop.getByRole('alert')).toContainText('项目已移除或目录失效');
  await expect(desktop.getByRole('button', { name: '新建会话', exact: true })).toBeDisabled();
  await expect(desktop.getByRole('button', { name: '选择项目', exact: true })).toBeEnabled();
  await desktop.screenshot({ path: join(output, 'desktop-unavailable-project.png') });
  available = true; service.emit('event', { type: 'projectsChanged' });
  await state(desktop, 'existingThread', '谕令未书，万象屏息。');
  record('real unavailable-project event takes precedence and preserves recovery controls');

  await desktop.getByRole('button', { name: '设置', exact: true }).click();
  await expect(desktop.getByLabel('当前主题')).toBeEnabled();
  await desktop.getByLabel('当前主题').selectOption('minimal-light');
  await expect(desktop.locator('.app-shell')).toHaveAttribute('data-theme-id', 'minimal-light');
  await desktop.getByRole('button', { name: '关闭设置', exact: true }).click();
  await state(desktop, 'existingThread', '谕令未书，万象屏息。');
  expect(await desktop.locator('.empty-state h2').evaluate(element => getComputedStyle(element).color)).toBe('rgb(32, 43, 56)');
  expect(await desktop.locator('.oracle-logo-eye').evaluate(element => getComputedStyle(element).mixBlendMode)).toBe('normal');
  await desktop.screenshot({ path: join(output, 'desktop-light-theme.png') });
  await desktop.getByRole('button', { name: '设置', exact: true }).click();
  await desktop.getByLabel('当前主题').selectOption('oracle-eye');
  await desktop.getByRole('button', { name: '关闭设置', exact: true }).click();
  record('brand typography follows the selected Trusted CSS palette and preserves the mark on light surfaces');

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36 OraculumAndroid/1' });
  phone.on('pageerror', error => errors.push(error.message));
  await phone.goto(origin); await ready(phone);
  for (const [width, height] of [[375, 812], [390, 844], [844, 390]]) {
    await phone.setViewportSize({ width, height });
    await state(phone, 'existingThread', '谕令未书，万象屏息。');
    await geometry(phone);
    await phone.screenshot({ path: join(output, `mobile-${width}x${height}.png`) });
  }
  await phone.emulateMedia({ reducedMotion: 'reduce' });
  await phone.setViewportSize({ width: 390, height: 844 }); await phone.reload(); await ready(phone);
  await state(phone, 'existingThread', '谕令未书，万象屏息。'); await geometry(phone);
  await phone.screenshot({ path: join(output, 'mobile-reduced-motion.png') });
  record('375/390 portrait, coarse-pointer landscape and reduced-motion rendering');

  await phone.route('**/auth/session', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  await phone.reload();
  await expect(phone.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible();
  await expect(phone.locator('.empty-state')).toHaveCount(0);
  await expect(phone.getByLabel('配对码', { exact: true })).toBeVisible();
  await phone.unroute('**/auth/session');
  await phone.route('**/auth/session', route => route.abort()); await phone.reload();
  await expect(phone.getByRole('alert')).toContainText('无法连接 Bridge');
  await expect(phone.getByRole('button', { name: '重新检查连接', exact: true })).toBeEnabled();
  await phone.unroute('**/auth/session');
  await phone.getByRole('button', { name: '重新检查连接', exact: true }).click(); await ready(phone);
  record('pairing, disconnected recovery and subsequent return remain functional');

  expect(calls.filter(method => method === 'turn/start')).toHaveLength(0);
  expect(calls.filter(method => method === 'thread/start')).toHaveLength(2);
  expect(errors).toEqual([]);
  record('zero model turns; only the two explicit create actions make native threads');
} finally {
  await browser?.close(); await server.close();
  await writeFile(join(output, 'acceptance.json'), JSON.stringify({ simulated: true, nativeCodex: false, actualAndroid: false,
    actualElectron: false, osSandboxAcceptance: false, date: new Date().toISOString(), results, rendererErrors: errors,
    threadStarts: calls.filter(method => method === 'thread/start').length, turnStarts: calls.filter(method => method === 'turn/start').length }, null, 2));
}
console.log(JSON.stringify({ simulated: true, output, passed: results.length }));
