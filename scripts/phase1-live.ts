// Opt-in real subscription E2E. Exactly three small turns; never part of pnpm test.
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { Codex } from '../bridge/src/codex';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import type { Approval, BridgeEvent, Snapshot, Thread } from '../packages/shared/protocol';

const model = process.env.ORACULUM_TEST_MODEL ?? 'gpt-6-luna';
const root = join(homedir(), '.cache/oraculum/workspaces');
await mkdir(root, { recursive: true, mode: 0o700 });
const cwd = await mkdtemp(join(root, 'phase1-'));
await writeFile(join(cwd, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
await writeFile(join(cwd, 'sum.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from './sum.mjs';\ntest('sum adds both numbers', () => assert.equal(sum(2, 3), 5));\n");
const configPath = join(homedir(), '.codex/config.toml');
const fingerprint = async () => createHash('sha256').update(await readFile(configPath)).digest('hex');
const baseline = await fingerprint();
const evidence: Record<string, any> = { real: true, date: new Date().toISOString(), cwd, model, turns: [], approvals: [], items: [], events: [] };
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
env.ORACULUM_URL = 'http://127.0.0.1:17862';
let codex: Codex;
let service: BridgeService;
let server: Awaited<ReturnType<typeof createServer>>;
let app: ElectronApplication | undefined;
let pending: Approval | undefined;
const methods = new Set<string>();
const errors: string[] = [];
async function startBackend() {
  codex = new Codex(cwd); service = new BridgeService(codex, cwd);
  service.on('event', (message: BridgeEvent) => {
    if (message.type === 'approval') pending = message.request;
    if (message.type !== 'event') return;
    const { method, params } = message.event;
    methods.add(method);
    if (method === 'turn/completed') evidence.turns.push({ id: params.turn.id, status: params.turn.status, error: params.turn.error });
    if (method === 'item/completed') evidence.items.push({ turnId: params.turnId, id: params.item.id, type: params.item.type,
      ...('status' in params.item ? { status: params.item.status } : {}),
      ...(params.item.type === 'commandExecution' ? { command: params.item.command, exitCode: params.item.exitCode, output: params.item.aggregatedOutput } : {}),
      ...(params.item.type === 'fileChange' ? { changes: params.item.changes } : {}) });
  });
  await codex.initialize();
  server = await createServer(service, 17862, resolve('apps/web/dist'), { testOnlyUnauthenticated: true });
  await server.listen({ host: '127.0.0.1', port: 17862 });
}
async function launch() {
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env, timeout: 30_000 });
  const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await expect(page.getByRole('status')).toContainText('状态已查询', { timeout: 30_000 });
  return page;
}
try {
  await mkdir('.local/evidence/phase1', { recursive: true });
  await startBackend();
  let page = await launch();
  evidence.config = await service!.dispatch('bridge/config', {});
  const renderer = await page.evaluate(() => ({ require: typeof (window as any).require, process: typeof (window as any).process }));
  expect(renderer).toEqual({ require: 'undefined', process: 'undefined' }); evidence.renderer = renderer;
  await page.getByLabel('模型', { exact: true }).selectOption(model);
  await page.getByLabel('思考强度', { exact: true }).selectOption('low');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByTestId('thread-id')).not.toHaveText('尚未选择会话');
  const threadId = await page.getByTestId('thread-id').innerText(); evidence.threadId = threadId;
  await page.getByLabel('消息', { exact: true }).fill('Controlled Oraculum GUI E2E, work ONLY in cwd. No skills, MCP, web, subagents, other projects or global configuration. Read sum.mjs and sum.test.mjs. Fix sum.mjs to add both numbers using apply_patch (leave the test unchanged), then run `node --test sum.test.mjs`. After tests, make TWO SEPARATE approval requests sequentially using the shell tool with sandbox_permissions=require_escalated: first command exactly `printf ORACULUM_ALLOW_OK` with justification="Oraculum harmless allow test"; then command exactly `printf ORACULUM_DECLINE_OK` with justification="Oraculum harmless decline test". The second will be declined: do not retry or run it by another route. Finish with Markdown heading `## ORACULUM_PHASE1_OK` and briefly report the test and approval outcomes. Do not perform any additional work.');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  for (const [marker, decision, button] of [['ORACULUM_ALLOW_OK', 'accept', '允许本次'], ['ORACULUM_DECLINE_OK', 'decline', '拒绝']] as const) {
    await expect.poll(() => pending?.method === 'item/commandExecution/requestApproval' ? pending.params.command : '', { timeout: 180_000 }).toContain(marker);
    await expect(page.getByRole('heading', { name: '需要审批', exact: true })).toBeVisible({ timeout: 180_000 });
    const request = pending!;
    expect(request.method).toBe('item/commandExecution/requestApproval');
    const command = request.method === 'item/commandExecution/requestApproval' ? request.params.command : '';
    const allowed = [`printf ${marker}`, `/bin/bash -lc 'printf ${marker}'`, `/bin/bash -lc "printf ${marker}"`, `/bin/sh -lc 'printf ${marker}'`];
    expect(allowed, 'Only the exact harmless printf may be approved').toContain(command);
    evidence.approvals.push({ method: request.method, requestId: request.id, itemId: 'itemId' in request.params ? request.params.itemId : undefined, command, decision });
    await page.screenshot({ path: `.local/evidence/phase1/live-${decision}.png`, fullPage: true });
    await page.getByRole('button', { name: button, exact: true }).click();
    await expect.poll(() => service!.pending.has(request.id), { timeout: 15_000 }).toBe(false);
  }
  await expect(page.getByRole('heading', { name: 'ORACULUM_PHASE1_OK', exact: true })).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId('last-turn-status')).toHaveText('completed', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: '查看 Diff', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '查看 Diff', exact: true }).first().click();
  await expect(page.locator('.cm-content')).toContainText('a + b');
  const testItem = evidence.items.find((i: any) => i.type === 'commandExecution' && i.command.includes('node --test') && i.exitCode === 0);
  expect(testItem).toBeTruthy();
  expect(evidence.items.some((i: any) => i.type === 'commandExecution' && i.status === 'declined')).toBe(true);
  evidence.independentTest = execFileSync(process.execPath, ['--test', 'sum.test.mjs'], { cwd, encoding: 'utf8' });
  await page.screenshot({ path: '.local/evidence/phase1/live-diff.png', fullPage: true });
  await page.getByRole('button', { name: '查询状态', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('状态已查询');
  const restored = await service!.dispatch('bridge/subscribe', { threadId }) as Snapshot;
  const restoredIds = restored.thread.turns.flatMap(t => t.items.map(i => i.id));
  evidence.history = { source: restored.history?.source, warning: restored.history?.warning, model: restored.thread.model, effort: restored.thread.reasoningEffort,
    declinedItemRestored: evidence.approvals.filter((a: any) => a.decision === 'decline').every((a: any) => restoredIds.includes(a.itemId)) };
  await page.getByLabel('消息', { exact: true }).fill('Controlled follow-up, ONLY run `sleep 4; cat sum.mjs` in cwd. Do not edit files or use other tools. Finish exactly ORACULUM_REOPEN_OK.');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByTestId('turn-status')).toHaveText('执行中', { timeout: 30_000 });
  await app!.close(); app = undefined;
  page = await launch();
  await expect(page.getByTestId('thread-id')).toHaveText(threadId);
  await expect(page.locator('.message:not(.user)').last()).toContainText('ORACULUM_REOPEN_OK', { timeout: 180_000 });
  await expect(page.getByTestId('last-turn-status')).toHaveText('completed', { timeout: 30_000 });
  evidence.guiReopen = 'same native thread completed with GUI closed/reopened';
  await app!.close(); app = undefined;
  await server!.close(); await codex!.close();
  await startBackend();
  page = await launch();
  await expect(page.getByTestId('thread-id')).toHaveText(threadId);
  await expect(page.locator('.message:not(.user)').last()).toContainText('ORACULUM_REOPEN_OK');
  await expect(page.locator('.history-warning').first()).toContainText('部分历史未能恢复');
  evidence.backendRestart = 'native thread/list, resume and paginated history restored after fresh App Server + Bridge';
  await page.getByLabel('模型', { exact: true }).selectOption(model);
  await page.getByLabel('思考强度', { exact: true }).selectOption('low');
  await page.getByLabel('消息', { exact: true }).fill('Controlled interruption test. Only run `sleep 30` in cwd, then say done. Do not inspect or change files.');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByTestId('turn-status')).toHaveText('执行中', { timeout: 30_000 });
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByTestId('last-turn-status')).toHaveText('interrupted', { timeout: 30_000 });
  evidence.interrupt = 'continued restored native thread and interrupted via GUI';
  await page.screenshot({ path: '.local/evidence/phase1/live-restored.png', fullPage: true });
  expect(await fingerprint()).toBe(baseline); evidence.globalConfigUnchanged = true;
  expect(errors).toEqual([]); evidence.rendererErrors = errors;
  evidence.result = 'passed';
  console.log(JSON.stringify({ result: evidence.result, threadId, turns: evidence.turns, history: evidence.history, cwd }, null, 2));
} catch (error) {
  evidence.failure = String(error); console.error(evidence.failure); process.exitCode = 1;
  if (app) await (await app.firstWindow()).screenshot({ path: '.local/evidence/phase1/live-failure.png', fullPage: true }).catch(() => {});
} finally {
  await app?.close();
  if (server!) await server.close();
  if (codex!) await codex.close();
  evidence.events = [...methods];
  evidence.globalConfigUnchanged = await fingerprint() === baseline;
  await writeFile('.local/evidence/phase1/live-e2e.json', JSON.stringify(evidence, null, 2) + '\n');
}
