// Real Electron + Android + native Harness. One controlled model turn.
// Requires an app-specific CDP forward, ADB reverse, and FREE port 17860.
import { selectedThreadId, sessionSnapshot } from './ui-state';
import { _electron as electron, chromium, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { TrustStore, defaultStateDir } from '../bridge/src/trust-store';

const endpoint = new URL(process.env.ORACULUM_ANDROID_CDP ?? 'about:blank');
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password) throw new Error('Use app-specific local CDP');
if (!process.env.ORACULUM_WORKSPACE?.includes('/.cache/oraculum/workspaces/phase2-android-')) throw new Error('Use the controlled Android test workspace');
await new Promise<void>((yes, no) => {
  const probe = createServer(); probe.once('error', no);
  probe.listen(17860, '127.0.0.1', () => probe.close(() => yes()));
});
const trust = new TrustStore(defaultStateDir());
let bridge: ChildProcess | undefined;
async function startBridge() {
  bridge = spawn(process.execPath, ['--import', 'tsx', 'bridge/src/main.ts'], { stdio: 'ignore', env: process.env });
  await expect.poll(async () => {
    if (bridge?.exitCode !== null) throw new Error('Test Bridge exited');
    try { return (await fetch('http://127.0.0.1:17860/health')).status; } catch { return 0; }
  }, { timeout: 30_000 }).toBe(200);
}
async function stopBridge() {
  if (!bridge || bridge.exitCode !== null || bridge.signalCode !== null) return;
  const child = bridge;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try { await exited; } finally { clearTimeout(timer); }
  bridge = undefined;
}
const browser = await chromium.connectOverCDP(endpoint.href, { noDefaults: true });
const phone = browser.contexts()[0]?.pages().find(p => p.url() === 'http://127.0.0.1:17860/');
if (!phone) { await browser.close(); trust.close(); throw new Error('Expected Oraculum WebView'); }
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
env.ORACULUM_URL = 'http://127.0.0.1:17860';
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined;
const deviceIds: string[] = [];
let step = 'start';
const evidence: Record<string, unknown> = { date: new Date().toISOString(), real: true, modelTurns: 0,
  transport: 'Android USB ADB reverse + Electron loopback; not public HTTPS/WSS' };
async function pair(page: Page, label: string) {
  await expect(page.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible();
  await page.getByLabel('设备名称', { exact: true }).fill(label);
  await page.getByLabel('配对码', { exact: true }).fill(trust.createPairing().code);
  await page.getByRole('button', { name: '配对并连接', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('状态已查询', { timeout: 30_000 });
  deviceIds.push(await page.evaluate(async () => (await (await fetch('/auth/session')).json()).device.id));
}
const itemIds = (page: Page) => page.locator('[data-item-id]').evaluateAll(nodes => nodes.map(n =>
  `${n.getAttribute('data-turn-id')}/${n.getAttribute('data-item-id')}`).sort());
try {
  await startBridge();
  await phone.reload();
  desktop = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  const computer = await desktop.firstWindow();
  step = 'pair both devices';
  await pair(phone, 'Android local recovery E2E');
  await pair(computer, 'Electron local recovery E2E');
  step = 'native turn';
  await phone.getByLabel('模型', { exact: true }).selectOption(process.env.ORACULUM_TEST_MODEL ?? 'gpt-6-luna');
  await phone.getByLabel('思考强度', { exact: true }).selectOption('low');
  const previousThread = await selectedThreadId(phone);
  await phone.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(phone.locator('.conversation')).not.toHaveAttribute('data-thread-id', '');
  await expect(phone.locator('.conversation')).not.toHaveAttribute('data-thread-id', previousThread);
  const threadId = await selectedThreadId(phone);
  evidence.threadId = threadId;
  await computer.getByRole('button', { name: '刷新列表', exact: true }).click();
  await computer.locator(`.session-link[data-thread-id="${threadId}"]`).click();
  await expect(computer.getByRole('status')).toContainText('状态已查询');
  await phone.getByLabel('消息', { exact: true }).fill('Controlled Oraculum recovery test. Do not use any tools, execute commands, access files, or delegate. Reply only with Markdown heading "## ORACULUM_RECOVERY_OK" and the sentence "双端恢复验证。" No additional work.');
  await phone.getByRole('button', { name: '发送', exact: true }).click();
  evidence.modelTurns = 1;
  for (const page of [phone, computer]) {
    await expect(page.getByRole('heading', { name: 'ORACULUM_RECOVERY_OK', exact: true })).toBeVisible({ timeout: 180_000 });
    await expect(page.locator('.conversation')).toHaveAttribute('data-last-turn-status', 'completed', { timeout: 30_000 });
    await expect.poll(async () => (await sessionSnapshot(page)).receipts?.length).toBe(1);
    await expect.poll(async () => (await sessionSnapshot(page)).receipts?.[0]?.status).toBe('completed');
  }
  const ids = await itemIds(phone);
  expect(await itemIds(computer)).toEqual(ids);
  evidence.items = ids;
  evidence.operationId = (await sessionSnapshot(phone)).receipts?.[0]?.operationId;
  step = 'Bridge and App Server restart';
  await stopBridge();
  for (const page of [phone, computer]) await expect(page.getByRole('status')).toContainText('已断开');
  await startBridge();
  for (const page of [phone, computer]) {
    await page.getByRole('button', { name: '重新连接', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('状态已查询', { timeout: 30_000 });
    await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', threadId);
    await expect(page.locator('.conversation')).toHaveAttribute('data-last-turn-status', 'completed');
    expect(await itemIds(page)).toEqual(ids);
    await expect.poll(async () => (await sessionSnapshot(page)).receipts?.length).toBe(1);
    await expect.poll(async () => (await sessionSnapshot(page)).receipts?.[0]?.operationId).toBe(evidence.operationId as string);
    await expect.poll(async () => (await sessionSnapshot(page)).receipts?.[0]?.status).toBe('completed');
    await expect(page.locator('.history-warning').first()).toContainText('部分历史未能恢复');
  }
  evidence.restartRestored = true;
  await mkdir('.local/evidence/phase2', { recursive: true });
  await phone.screenshot({ path: '.local/evidence/phase2/recovery-local-android.png', fullPage: true });
  await computer.screenshot({ path: '.local/evidence/phase2/recovery-local-electron.png', fullPage: true });
  evidence.result = 'passed';
  console.log(JSON.stringify(evidence));
} catch (error) {
  evidence.result = 'failed'; evidence.step = step;
  evidence.failure = error instanceof Error ? error.name : 'Error';
  console.error(`Local recovery test failed at ${step}; sensitive assertion details omitted.`);
  process.exitCode = 1;
} finally {
  for (const id of deviceIds) trust.revoke(id);
  await desktop?.close();
  await browser.close();
  await stopBridge();
  trust.close();
  await mkdir('.local/evidence/phase2', { recursive: true });
  await writeFile('.local/evidence/phase2/recovery-local.json', JSON.stringify(evidence, null, 2) + '\n');
}
