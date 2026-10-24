// Opt-in public deployment acceptance. One native model turn; no deployment writes.
// Run only with the separately approved Bridge/tunnel already running. The operator
// controls their recorded tunnel PID when tunnel.ready / tunnel.disconnected appear.
import { selectModel, selectEffort } from './composer-controls';
import { selectedThreadId, sessionSnapshot } from './ui-state';
import { chromium, _electron as electron, expect, type Page } from '@playwright/test';
import WebSocket from 'ws';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { basePath, httpsOrigin } from '../packages/shared/entry';
import { TrustStore, defaultStateDir } from '../bridge/src/trust-store';
import type { Approval, BridgeEvent } from '../packages/shared/protocol';

if (!process.env.ORACULUM_REMOTE_ORIGIN || !process.env.ORACULUM_TEST_EVIDENCE ||
    process.env.ORACULUM_TEST_PUBLIC !== '1' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  throw new Error('Explicit public test origin, evidence directory and normal TLS verification required');
}
const origin = httpsOrigin(process.env.ORACULUM_REMOTE_ORIGIN);
const base = basePath(process.env.ORACULUM_REMOTE_BASE_PATH);
const entry = origin + base;
const output = resolve(process.env.ORACULUM_TEST_EVIDENCE);
if (!output.startsWith(resolve('.local/evidence') + '/')) throw new Error('Evidence must stay in ignored local directory');
await mkdir(output, { recursive: true });
for (const name of ['tunnel.ready', 'tunnel.disconnected', 'tunnel.restored']) {
  if (await access(join(output, name)).then(() => true, () => false)) throw new Error('Use a fresh evidence directory');
}
const configHash = async () => createHash('sha256').update(await readFile(join(homedir(), '.codex/config.toml'))).digest('hex');
const baseline = await configHash();
const trust = new TrustStore(defaultStateDir());
const devices: string[] = [];
const evidence: Record<string, any> = { date: new Date().toISOString(), transport: 'real public HTTPS/WSS + local Electron',
  entry, android: 'deferred; not exercised by this test', modelTurns: 0, approvals: [], events: [] };
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined;
let step = 'public transport';
const negative = async (headers: Record<string, string>) => new Promise<number>((yes, no) => {
  // Give each deliberately rejected upgrade an independent client connection.
  const socket = new WebSocket(entry.replace('https:', 'wss:') + 'ws', { headers, agent: false, handshakeTimeout: 15_000 });
  // Settle the rejection status before terminate emits its expected local error.
  socket.once('unexpected-response', (_request, response) => { response.resume(); yes(response.statusCode!); socket.terminate(); });
  socket.once('open', () => { socket.close(); no(new Error('Unauthenticated socket opened')); });
  socket.once('error', no);
});
const itemIds = (page: Page) => page.locator('[data-item-id]').evaluateAll(nodes => nodes.map(n =>
  `${n.getAttribute('data-turn-id')}/${n.getAttribute('data-item-id')}`).sort());
async function pair(page: Page, label: string, url: string) {
  await expect(page.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible();
  await page.getByLabel('设备名称', { exact: true }).fill(label);
  const code = trust.createPairing().code;
  await page.getByLabel('配对码', { exact: true }).fill(code);
  await page.getByRole('button', { name: '配对并连接', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('状态已查询', { timeout: 30_000 });
  const id = await page.evaluate(async url => (await (await fetch(url + 'auth/session')).json()).device.id, url);
  devices.push(id);
  return code;
}
try {
  expect((await fetch(entry + 'health')).status).toBe(200);
  expect(await (await fetch(entry + 'health')).json()).toEqual({ protocol: 1, mode: 'authenticated' });
  expect((await fetch(entry + 'auth/session')).status).toBe(401);
  expect((await fetch(entry + 'auth/session', { headers: { Origin: 'https://untrusted.invalid' } })).status).toBe(403);
  expect((await fetch(entry + 'auth/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
  step = 'negative WSS Origin and authentication';
  expect(await negative({})).toBe(403);
  expect(await negative({ Origin: 'https://untrusted.invalid' })).toBe(403);
  expect(await negative({ Origin: origin })).toBe(401);
  expect(await negative({ Origin: origin, Cookie: '__Host-dsh_ma_session=synthetic-untrusted' })).toBe(401);
  evidence.unauthenticatedBoundaries = 'HTTP 401; missing/foreign WS Origin 403; missing/fake DSH cookie WS 401';
  step = 'public browser launch';
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(); // No TLS exceptions, saved sessions, or DSH credentials.
  const remote = await context.newPage();
  const pageErrors: string[] = [];
  remote.on('pageerror', error => pageErrors.push(error.name));
  let pending: Approval | undefined;
  const nativeMethods = new Set<string>();
  const outboundTurns: string[] = [];
  remote.on('websocket', socket => {
    expect(socket.url()).toBe(entry.replace('https:', 'wss:') + 'ws');
    socket.on('framesent', frame => {
      const message = JSON.parse(frame.payload.toString());
      if (message.method === 'turn/start') outboundTurns.push(message.params.operationId);
    });
    socket.on('framereceived', frame => {
      const message = JSON.parse(frame.payload.toString()) as BridgeEvent;
      if (message.type === 'approval') pending = message.request;
      if (message.type === 'event') nativeMethods.add(message.event.method);
    });
  });
  await remote.goto(entry);
  step = 'pair independent devices';
  const usedCode = await pair(remote, 'Public closeout E2E', entry);
  expect((await fetch(entry + 'auth/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: usedCode, label: 'replay must fail' }) })).status).toBe(401);
  const ownCookie = (await context.cookies(entry)).find(c => c.name === '__Secure-oraculum_session')!;
  expect(ownCookie).toBeTruthy();
  expect({ secure: ownCookie.secure, httpOnly: ownCookie.httpOnly, sameSite: ownCookie.sameSite, path: ownCookie.path })
    .toEqual({ secure: true, httpOnly: true, sameSite: 'Strict', path: base });
  const cookie = `${ownCookie.name}=${ownCookie.value}`;
  expect(await negative({ Origin: origin, Cookie: `${cookie}; ${cookie}` })).toBe(401);
  expect((await fetch('http://127.0.0.1:17860/auth/session', { headers: { Cookie: cookie } })).status).toBe(401);
  evidence.cookie = { name: ownCookie.name, secure: true, httpOnly: true, sameSite: 'Strict', path: base, replayRejected: true, localScopeRejected: true };
  const require = createRequire(resolve('apps/desktop/package.json'));
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.ORACULUM_URL = 'http://127.0.0.1:17860';
  desktop = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  const local = await desktop.firstWindow();
  await pair(local, 'Electron public closeout E2E', 'http://127.0.0.1:17860/');
  step = 'official native turn and approvals';
  const previous = await selectedThreadId(remote);
  await remote.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(remote.locator('.conversation')).not.toHaveAttribute('data-thread-id', '');
  await expect(remote.locator('.conversation')).not.toHaveAttribute('data-thread-id', previous);
  const threadId = await selectedThreadId(remote); evidence.threadId = threadId;
  await selectModel(remote, process.env.ORACULUM_TEST_MODEL ?? 'gpt-6-luna');
  await selectEffort(remote, 'low');
  await local.getByRole('button', { name: '刷新列表', exact: true }).click();
  await local.locator(`.session-link[data-thread-id="${threadId}"]`).click();
  await expect(local.getByRole('status')).toContainText('状态已查询');
  await remote.getByLabel('消息', { exact: true }).fill('Controlled Oraculum public HTTPS/WSS acceptance test. Work only in cwd. No files, skills, MCP, web, subagents, configuration changes or other work. Make TWO SEPARATE shell approval requests sequentially with sandbox_permissions=require_escalated: first command exactly `printf ORACULUM_PUBLIC_ALLOW_OK` with justification="Oraculum harmless public allow test"; then exactly `printf ORACULUM_PUBLIC_DECLINE_OK` with justification="Oraculum harmless public decline test". The second will be declined: do not retry or run it another way. Finish with Markdown heading `## ORACULUM_PUBLIC_OK` and briefly report approval outcomes.');
  await remote.getByRole('button', { name: '发送', exact: true }).click(); evidence.modelTurns = 1;
  for (const [marker, button, actor] of [['ORACULUM_PUBLIC_ALLOW_OK', '允许本次', remote], ['ORACULUM_PUBLIC_DECLINE_OK', '拒绝', local]] as const) {
    await expect.poll(() => pending?.method === 'item/commandExecution/requestApproval' ? pending.params.command : '', { timeout: 180_000 }).toContain(marker);
    const request = pending!;
    if (request.method !== 'item/commandExecution/requestApproval') throw new Error('Unexpected approval');
    expect([`printf ${marker}`, `/bin/bash -lc 'printf ${marker}'`, `/bin/bash -lc "printf ${marker}"`, `/bin/sh -lc 'printf ${marker}'`]).toContain(request.params.command);
    for (const page of [remote, local]) await expect(page.getByRole('heading', { name: '需要审批', exact: true })).toBeVisible();
    evidence.approvals.push({ requestId: request.id, itemId: request.params.itemId, command: request.params.command, decision: button, via: actor === remote ? 'public WSS' : 'local Electron' });
    await actor.getByRole('button', { name: button, exact: true }).click();
    for (const page of [remote, local]) await expect(page.getByRole('heading', { name: '需要审批', exact: true })).toHaveCount(0);
  }
  for (const page of [remote, local]) {
    await expect(page.getByRole('heading', { name: 'ORACULUM_PUBLIC_OK', exact: true })).toBeVisible({ timeout: 180_000 });
    await expect(page.locator('.conversation')).toHaveAttribute('data-last-turn-status', 'completed', { timeout: 30_000 });
    await expect.poll(async () => (await sessionSnapshot(page)).receipts?.length).toBe(1);
    await expect.poll(async () => (await sessionSnapshot(page)).receipts?.[0]?.status).toBe('completed');
  }
  const ids = await itemIds(remote); expect(await itemIds(local)).toEqual(ids); evidence.items = ids;
  evidence.operationId = (await sessionSnapshot(remote)).receipts?.[0]?.operationId;
  evidence.events = [...nativeMethods];
  expect(nativeMethods.has('item/agentMessage/delta')).toBe(true);
  await remote.screenshot({ path: join(output, 'public-completed.png'), fullPage: true });
  await local.screenshot({ path: join(output, 'electron-completed.png'), fullPage: true });
  step = 'operator-controlled tunnel interruption';
  await writeFile(join(output, 'tunnel.ready'), JSON.stringify({ threadId, operationId: evidence.operationId }));
  console.log('Native turn and approvals passed; ready for recorded tunnel PID interruption.');
  await expect(remote.getByRole('status')).toContainText('已断开', { timeout: 180_000 });
  await expect(local.getByRole('status')).toContainText('状态已查询');
  await writeFile(join(output, 'tunnel.disconnected'), 'public disconnected; Electron retained native state\n');
  await expect.poll(() => access(join(output, 'tunnel.restored')).then(() => true, () => false), { timeout: 180_000 }).toBe(true);
  await remote.getByRole('button', { name: '重新连接', exact: true }).click();
  await expect(remote.getByRole('status')).toContainText('状态已查询', { timeout: 30_000 });
  await expect(remote.locator('.conversation')).toHaveAttribute('data-thread-id', threadId);
  await expect(remote.locator('.conversation')).toHaveAttribute('data-last-turn-status', 'completed');
  expect(await itemIds(remote)).toEqual(ids);
  await expect.poll(async () => (await sessionSnapshot(remote)).receipts?.length).toBe(1);
  await expect.poll(async () => (await sessionSnapshot(remote)).receipts?.[0]?.operationId).toBe(evidence.operationId);
  expect(outboundTurns).toEqual([evidence.operationId]);
  evidence.tunnelRecovery = { nativeIdsRetained: true, receiptRetained: true, turnStartCount: outboundTurns.length, localUnaffected: true };
  step = 'revoke public device';
  trust.revoke(devices[0]);
  await expect(remote.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible({ timeout: 15_000 });
  expect((await fetch(entry + 'auth/session', { headers: { Cookie: cookie } })).status).toBe(401);
  expect(await negative({ Origin: origin, Cookie: cookie })).toBe(401);
  evidence.revocation = 'open WSS closed; UI cleared; HTTP and new WSS rejected';
  expect(pageErrors).toEqual([]);
  expect(await configHash()).toBe(baseline);
  evidence.globalConfigUnchanged = true;
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed'; evidence.step = step;
  evidence.failure = error instanceof Error ? error.name : 'Error';
  evidence.failureLocation = error instanceof Error ? error.stack?.split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 4) : [];
  console.error(`Public test failed at ${step}; sensitive assertion details omitted.`);
  process.exitCode = 1;
} finally {
  for (const id of devices) trust.revoke(id);
  await desktop?.close(); await browser?.close(); trust.close();
  evidence.globalConfigUnchanged = await configHash() === baseline;
  await writeFile(join(output, 'public-live.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ result: evidence.result, step, threadId: evidence.threadId, modelTurns: evidence.modelTurns }));
}
