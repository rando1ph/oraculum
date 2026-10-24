// Opt-in actual Android WebView + authenticated local Bridge, no model turns.
// CDP must be forwarded from Oraculum only. Credentials never enter evidence.
import { selectedThreadId } from './ui-state';
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { TrustStore, defaultStateDir } from '../bridge/src/trust-store';

const endpoint = new URL(process.env.ORACULUM_ANDROID_CDP ?? 'about:blank');
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password) {
  throw new Error('Set ORACULUM_ANDROID_CDP to the local Oraculum ADB-forwarded endpoint');
}
const browser = await chromium.connectOverCDP(endpoint.href, { noDefaults: true });
const page = browser.contexts()[0]?.pages().find(p => p.url() === 'http://127.0.0.1:17860/');
if (!page) { await browser.close(); throw new Error('Expected the Oraculum debug WebView'); }
const trust = new TrustStore(defaultStateDir());
const ids: string[] = [];
const evidence: Record<string, unknown> = {
  date: new Date().toISOString(), real: true, modelTurns: 0,
  transport: 'USB ADB reverse; not public HTTPS/WSS',
};
let step = 'unpaired';
try {
  await page.reload();
  await expect(page.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible();
  expect(await page.getByRole('button', { name: /^模型与思考强度：/ }).count()).toBe(0);
  expect(await page.evaluate(async () => (await fetch('/auth/session')).status)).toBe(401);
  const pair = async () => {
    const { code } = trust.createPairing();
    await page.getByLabel('设备名称', { exact: true }).fill('Android auth E2E');
    await page.getByLabel('配对码', { exact: true }).fill(code);
    await page.getByRole('button', { name: '配对并连接', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('状态已查询', { timeout: 30_000 });
    const session = await page.evaluate(async () => (await fetch('/auth/session')).json());
    ids.push(session.device.id);
    return code;
  };
  step = 'pair';
  const firstCode = await pair();
  await expect(page.locator('aside .path')).toContainText('/.cache/oraculum/workspaces/phase2-android-');
  const threadId = await selectedThreadId(page);
  expect(threadId).not.toBe('');
  await expect(page.locator('.conversation')).toHaveAttribute('data-last-turn-status', 'completed');
  evidence.threadId = threadId;
  evidence.cookies = (await page.context().cookies()).map(({ name, httpOnly, secure, sameSite }) => ({ name, httpOnly, secure, sameSite }));
  expect(evidence.cookies).toEqual([expect.objectContaining({ name: 'oraculum_local', httpOnly: true, sameSite: 'Strict' })]);
  expect(await page.evaluate(() => document.cookie)).toBe('');
  step = 'reload';
  await page.reload();
  await expect(page.getByRole('status')).toContainText('状态已查询', { timeout: 30_000 });
  await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', threadId);
  await expect(page.locator('.conversation')).toHaveAttribute('data-last-turn-status', 'completed');
  evidence.nativeHistoryReload = true;
  step = 'replay';
  const replay = await page.evaluate(async code => (await fetch('/auth/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, label: 'replay' }),
  })).status, firstCode);
  expect(replay).toBe(401);
  evidence.consumedCodeReplayStatus = replay;
  await mkdir('.local/evidence/phase2', { recursive: true });
  await page.screenshot({ path: '.local/evidence/phase2/auth-android-paired.png' });
  step = 'revoke';
  trust.revoke(ids[0]);
  await expect(page.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible({ timeout: 10_000 });
  expect(await page.getByRole('button', { name: /^模型与思考强度：/ }).count()).toBe(0);
  expect(await page.evaluate(async () => (await fetch('/auth/session')).status)).toBe(401);
  evidence.revocation = 'open socket closed; private GUI removed; HTTP denied';
  await page.screenshot({ path: '.local/evidence/phase2/auth-android-revoked.png' });
  step = 're-pair';
  await pair();
  expect(ids[1]).not.toBe(ids[0]);
  await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', threadId);
  await expect(page.locator('.conversation')).toHaveAttribute('data-last-turn-status', 'completed');
  evidence.repaired = true;
  evidence.result = 'passed';
  console.log(JSON.stringify(evidence));
} catch (error) {
  evidence.result = 'failed';
  evidence.step = step;
  // No assertion dump or failure screenshot: either might contain a credential.
  evidence.failure = error instanceof Error ? error.name : 'Error';
  console.error(`Android authentication check failed at ${step}; credentials omitted.`);
  process.exitCode = 1;
} finally {
  for (const id of ids) trust.revoke(id);
  trust.close();
  await browser.close(); // Detach only; leave user's app and device intact.
  await mkdir('.local/evidence/phase2', { recursive: true });
  await writeFile('.local/evidence/phase2/auth-android.json', JSON.stringify(evidence, null, 2) + '\n');
}
