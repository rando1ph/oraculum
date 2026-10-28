// Chromium mobile viewport + isolated Bridge; simulated Codex, no Android device.
import { chromium, expect } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import { Themes } from '../bridge/src/themes';

const neon = 'hong-kong-neon', cwd = '/theme-loading-fixture';
const thread = { id: 'theme-loading', name: '主题弱网回归 · 模拟', cwd, preview: '', status: { type: 'idle' }, turns: [] };
const bus = new EventEmitter();
const codex = {
  on: bus.on.bind(bus), send() {},
  async request<T>(method: string): Promise<T> {
    let value: unknown;
    if (method === 'config/read') value = { config: { model: 'fixture', model_provider: 'fixture' } };
    else if (method === 'model/list') value = { data: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null };
    else if (method === 'thread/list') value = { data: [thread], nextCursor: null };
    else if (method === 'thread/read') value = { thread };
    else if (method === 'thread/resume') value = { thread, model: 'fixture', reasoningEffort: 'low', approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user' };
    else if (method === 'thread/turns/list') value = { data: [], nextCursor: null };
    else throw new Error(`Unexpected fixture request: ${method}`);
    return structuredClone(value) as T;
  },
};
await mkdir('.local/evidence/r1-b1/themes', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/r1-b1/themes/run-'));
const themes = new Themes({ source: resolve('themes'), installed: join(output, 'installed'), builtin: resolve('themes') });
const port = 17893, origin = `http://127.0.0.1:${port}`;
const server = await createServer(new BridgeService(codex, cwd), port, resolve('apps/web/dist'), { themes, testOnlyUnauthenticated: true });
const responses: { path: string; status: number; bytes: number; conditional: boolean }[] = [];
server.addHook('onResponse', async (request, reply) => {
  if (request.url.includes('/themes/')) responses.push({ path: request.url, status: reply.statusCode, bytes: Number(reply.getHeader('content-length') ?? 0), conditional: !!request.headers['if-none-match'] });
});
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await page.addInitScript(() => {
  const timings: number[] = [];
  (window as any).__themeDecodeTimings = timings;
  const original = window.createImageBitmap;
  (window as any).createImageBitmap = (...args: unknown[]) => {
    const start = performance.now();
    return Reflect.apply(original, window, args).then((bitmap: ImageBitmap) => { timings.push(performance.now() - start); return bitmap; });
  };
});
const results: object[] = [], errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
const bundlePattern = '**/themes/hong-kong-neon/bundle';
const assetPattern = '**/themes/hong-kong-neon/assets/**';
const ready = () => expect(page.locator('.connection-status')).toContainText('状态已查询');
const preference = () => page.evaluate(() => localStorage.getItem('oraculum.theme:/'));
async function settings() {
  if (!await page.locator('.app-settings').isVisible()) {
    if (!await page.locator('.app-shell').evaluate(e => e.classList.contains('drawer-open'))) await page.getByRole('button', { name: '打开导航', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
  }
  await expect(page.getByLabel('当前主题')).toBeEnabled();
}
async function select(value: string) {
  await settings(); await page.getByLabel('当前主题').selectOption(value);
}
async function selected(value: string) {
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme-id', value, { timeout: 12_000 });
}
const focus = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
const record = (name: string, details: object = {}) => { results.push({ name, ...details }); console.log('PASS ' + name); };
try {
  await server.listen({ host: '127.0.0.1', port });
  await page.goto(origin); await ready(); await settings();
  // Every valid WebP takes six seconds to transfer, independently of decode.
  let assetRequests = 0;
  await page.route(assetPattern, async route => {
    assetRequests++;
    const response = await route.fetch();
    await new Promise(resolve => setTimeout(resolve, 6000));
    await route.fulfill({ response });
  });
  const started = Date.now();
  await select(neon); await selected(neon);
  expect(await preference()).toBe(neon);
  await page.locator('.theme-settings').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'slow-webp-loaded.png') });
  record('valid six-second WebP transfer survives the former five-second deadline', { elapsedMs: Date.now() - started, assetRequests, decodeMs: await page.evaluate(() => (window as any).__themeDecodeTimings) });
  await page.unrouteAll({ behavior: 'wait' });

  // Use actual browser HTTP cache (routing disables it). Warm once, then
  // observe the Bridge's 304 rather than only JS-visible status. Authentication
  // and revocation are covered separately by the real TrustStore HTTP tests.
  responses.length = 0;
  const decodesBefore = await page.evaluate(() => (window as any).__themeDecodeTimings.length);
  await focus(); await expect.poll(() => responses.filter(entry => entry.path.endsWith('/bundle')).length).toBe(1);
  await page.waitForTimeout(100);
  await focus(); await expect.poll(() => responses.filter(entry => entry.path.endsWith('/bundle')).length).toBe(2);
  const revalidation = responses.filter(entry => entry.path.endsWith('/bundle')).at(-1)!;
  expect(revalidation).toMatchObject({ status: 304, bytes: 0, conditional: true });
  expect(responses.filter(entry => entry.path.includes('/assets/'))).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).__themeDecodeTimings.length)).toBe(decodesBefore);
  record('unchanged revision revalidates with a real zero-body 304 and skips image requests/decoding', { responses: [...responses] });

  // One aborted transfer is retried; user does not have to select again.
  await select('oracle-eye'); let interrupted = 0;
  await page.route(bundlePattern, async route => { if (++interrupted === 1) await route.abort('failed'); else await route.continue(); });
  await select(neon); await selected(neon); expect(interrupted).toBe(2);
  await page.unroute(bundlePattern);
  record('one interrupted bundle request recovers with one bounded retry', { requests: interrupted });

  // Exhaust the bounded retry: temporary fallback must retain selected preference.
  let failed = 0;
  await page.route(bundlePattern, async route => { failed++; await route.abort('failed'); });
  await page.reload(); await ready();
  await expect(page.getByRole('alert')).toContainText('保留', { timeout: 12_000 });
  expect(failed).toBe(2); expect(await preference()).toBe(neon);
  await selected('oracle-eye');
  await settings(); await page.locator('.theme-settings').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'temporary-failure-keeps-preference.png') });
  await page.unroute(bundlePattern); await focus(); await selected(neon);
  expect(await preference()).toBe(neon);
  record('temporary network fallback retains preference and focus restores selected theme', { failedAttempts: failed });

  failed = 0;
  await page.route(bundlePattern, async route => { failed++; await route.abort('failed'); });
  await focus(); await expect(page.getByRole('alert')).toContainText('已保留所选主题');
  await selected(neon); expect(await preference()).toBe(neon);
  expect(await page.locator('style[data-oraculum-theme]').count()).toBe(1); expect(failed).toBe(2);
  await page.unroute(bundlePattern); await focus();
  await expect(page.getByRole('alert')).toHaveCount(0);
  record('temporary background failure retains the already-applied valid stylesheet');

  // The transfer is valid HTTP but cannot decode: genuinely corrupt content resets.
  await select('oracle-eye');
  await page.route(assetPattern, route => route.fulfill({ body: 'broken', contentType: 'image/webp' }));
  await select(neon);
  await expect(page.getByRole('alert')).toContainText('已恢复默认主题');
  await selected('oracle-eye'); expect(await preference()).toBe('oracle-eye');
  await page.unroute(assetPattern);
  record('corrupt image bytes safely reset stylesheet and saved preference');

  // A custom package edit is detected during focus, even while a theme is active.
  await themes.install('test-violet');
  await page.getByRole('button', { name: '刷新主题列表', exact: true }).click();
  await select('test-violet'); await selected('test-violet');
  await writeFile(join(themes.paths.installed, 'test-violet', 'theme.css'), ':root { --accent: #123456; }');
  await focus();
  await expect.poll(() => page.locator('.app-shell').evaluate(e => getComputedStyle(e).getPropertyValue('--accent').trim())).toBe('#123456');
  record('custom package revision updates on focus');

  await select('oracle-eye');
  await page.route(bundlePattern, async route => { await new Promise(resolve => setTimeout(resolve, 800)); await route.continue().catch(() => {}); });
  await select(neon); await page.getByRole('button', { name: '恢复默认主题', exact: true }).click();
  await page.waitForTimeout(1100); await selected('oracle-eye'); expect(await preference()).toBe('oracle-eye');
  record('manual recovery cancels pending selection and cannot be overwritten by late response');
  expect(errors).toEqual([]);
} catch (error) {
  process.exitCode = 1; console.error(error);
  results.push({ failure: String(error), preference: await preference(), notice: await page.getByRole('alert').allTextContents() });
  await page.screenshot({ path: join(output, 'failure.png') });
} finally {
  await browser.close(); await server.close();
  await writeFile(join(output, 'contract.json'), JSON.stringify({ simulated: true, output, passed: !process.exitCode, results, errors }, null, 2));
  console.log(JSON.stringify({ simulated: true, output, passed: !process.exitCode }));
}
