// Opt-in actual Electron + running authenticated local Bridge; no model turns.
import { selectedThreadId } from './ui-state';
import { _electron as electron, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { TrustStore, defaultStateDir } from '../bridge/src/trust-store';

const trust = new TrustStore(defaultStateDir());
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
env.ORACULUM_URL = 'http://127.0.0.1:17860';
const app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
const evidence: Record<string, unknown> = { real: true, modelTurns: 0, transport: 'loopback HTTP; not public TLS' };
let deviceId: string | undefined;
try {
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible();
  expect(await page.getByRole('button', { name: /^模型与思考强度：/ }).count()).toBe(0);
  expect(await page.evaluate(async () => (await fetch('/auth/session')).status)).toBe(401);
  const { code } = trust.createPairing();
  await page.getByLabel('设备名称', { exact: true }).fill('Electron auth E2E');
  await page.getByLabel('配对码', { exact: true }).fill(code);
  await page.getByRole('button', { name: '配对并连接', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('状态已查询', { timeout: 30_000 });
  expect(await page.getByRole('button', { name: /^模型与思考强度：/ }).count()).toBe(1);
  const session = await page.evaluate(async () => (await fetch('/auth/session')).json());
  deviceId = session.device.id;
  evidence.deviceId = deviceId;
  evidence.nativeThread = await selectedThreadId(page);
  evidence.cookies = (await page.context().cookies()).map(({ name, httpOnly, secure, sameSite }) => ({ name, httpOnly, secure, sameSite }));
  expect(evidence.cookies).toEqual([expect.objectContaining({ name: 'oraculum_local', httpOnly: true, sameSite: 'Strict' })]);
  expect(await page.evaluate(() => document.cookie)).toBe('');
  const replay = await page.evaluate(async code => (await fetch('/auth/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, label: 'replay' }),
  })).status, code);
  expect(replay).toBe(401);
  await mkdir('.local/evidence/phase2', { recursive: true });
  await page.screenshot({ path: '.local/evidence/phase2/auth-electron-paired.png' });
  trust.revoke(deviceId!);
  await expect(page.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible({ timeout: 10_000 });
  expect(await page.getByRole('button', { name: /^模型与思考强度：/ }).count()).toBe(0);
  evidence.revocation = 'open WebSocket closed; private GUI removed; re-pair required';
  evidence.result = 'passed';
  console.log(JSON.stringify(evidence));
} catch (error) {
  evidence.result = 'failed';
  // Do not serialize browser assertion details that could include a pairing code.
  evidence.failure = error instanceof Error ? error.name : 'Error';
  console.error('Authentication UI test failed; inspect the assertion locally without exporting credentials.');
  process.exitCode = 1;
} finally {
  if (deviceId) trust.revoke(deviceId);
  await app.close();
  trust.close();
  await mkdir('.local/evidence/phase2', { recursive: true });
  await writeFile('.local/evidence/phase2/auth-electron.json', JSON.stringify(evidence, null, 2) + '\n');
}
