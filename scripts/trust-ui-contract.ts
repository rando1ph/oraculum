// Isolated Chromium + real HTTP/WebSocket/SQLite auth; Codex is simulated.
// No existing Bridge, user profile, trust database or native Codex is opened.
import { chromium, expect } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as reservePort } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrustStore } from '../bridge/src/trust-store';
import { createServer } from '../bridge/src/server';
import type { BridgeService } from '../bridge/src/service';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'oraculum-trust-browser-'));
let now = Date.now();
const trust = new TrustStore(dir, () => now);
const reservation = reservePort();
await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = (reservation.address() as import('node:net').AddressInfo).port;
await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
const cwd = join(dir, 'fixture-project');
const calls: string[] = [];
const service = Object.assign(new EventEmitter(), { dispatch: async (method: string) => {
  calls.push(method);
  if (method === 'bridge/config') return { cwd, model: null, effort: null, provider: null, approvalPolicy: null,
    sandbox: null, approvalsReviewer: null, webSearch: null };
  if (method === 'bridge/projects') return { root: dir, projects: [{ name: 'fixture-project', cwd }] };
  if (method === 'model/list' || method === 'thread/list') return { data: [], nextCursor: null };
  throw new Error('Unexpected simulated request');
} });
const server = await createServer(service as unknown as BridgeService, port, join(root, 'apps/web/dist'), { trust });
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.name));
let checks = 0;
page.on('request', request => { if (new URL(request.url()).pathname === '/auth/session') checks++; });
try {
  await server.listen({ host: '127.0.0.1', port });
  await page.clock.install({ time: new Date(now) });
  await page.goto(`http://127.0.0.1:${port}`);
  await expect(page.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible();
  await expect(page.getByText('设备配对后持续可信', { exact: false })).toBeVisible();
  const pair = trust.createPairing();
  await page.getByLabel('设备名称', { exact: true }).fill('Isolated browser fixture');
  await page.getByLabel('配对码', { exact: true }).fill(pair.code);
  await page.getByRole('button', { name: '配对并连接', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect.poll(() => calls.includes('thread/list')).toBe(true);
  const cookie = (await context.cookies()).find(cookie => cookie.name === 'oraculum_local')!;
  expect({ httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, path: cookie.path }).toEqual({ httpOnly: true, sameSite: 'Strict', path: '/' });
  expect(cookie.expires - Date.now() / 1000).toBeGreaterThan(364 * 86400);
  expect(await page.evaluate(() => document.cookie)).toBe('');
  await page.locator('.app-shell').evaluate(element => { element.setAttribute('data-continuity', 'preserved'); });
  const before = checks;
  now += 2 * 86400000;
  await page.clock.fastForward(2 * 86400000);
  await expect.poll(() => checks).toBeGreaterThan(before);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-continuity', 'preserved');
  expect(trust.list().filter(device => !device.revoked)).toHaveLength(1);
  expect(trust.list()[0].expiresAt).toBeNull();

  // Restore a near-expiry browser cookie to prove foreground checks extend it.
  await context.addCookies([{ ...cookie, expires: Date.now() / 1000 + 120 }]);
  const foreground = checks;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => checks).toBeGreaterThan(foreground);
  await expect.poll(async () => ((await context.cookies()).find(cookie => cookie.name === 'oraculum_local')?.expires ?? 0) - Date.now() / 1000).toBeGreaterThan(364 * 86400);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-continuity', 'preserved');
  expect(calls.filter(method => !['bridge/config', 'bridge/projects', 'model/list', 'thread/list'].includes(method))).toEqual([]);

  await context.clearCookies();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible();
  expect((await context.cookies()).length).toBe(0);
  expect(trust.list()[0].revoked).toBe(0);
  expect(errors).toEqual([]);
  console.log('PASS isolated Chromium: year cookie, HttpOnly, cross-day trust, daily and foreground renewal, view continuity, cleared-cookie re-pair; simulated Codex only');
} catch {
  // Assertions may contain synthetic credentials; never serialize those values.
  console.error('FAIL isolated trust browser contract; inspect locally without exporting credentials');
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
  trust.close();
  await rm(dir, { recursive: true, force: true });
}
