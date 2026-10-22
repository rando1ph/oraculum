import { DatabaseSync } from 'node:sqlite';
// Opt-in acceptance using the real Ubuntu Electron window and official Codex.
// Exactly two controlled model turns; generated fixtures/evidence stay outside Git.
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { Codex } from '../bridge/src/codex';
import { BridgeService } from '../bridge/src/service';
import { ProjectDirectories } from '../bridge/src/projects';
import { createServer } from '../bridge/src/server';
import type { Approval, BridgeEvent, LocalConfig, Model, Snapshot } from '../packages/shared/protocol';

const workspaceRoot = join(homedir(), '.cache/oraculum/workspaces');
await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
const projectsRoot = await mkdtemp(join(workspaceRoot, 'phase3-desktop-'));
const cwd = join(projectsRoot, 'sum-lab');
const secondProject = join(projectsRoot, 'sandbox-notes');
await mkdir(cwd);
await mkdir(secondProject);
const output = resolve('.local/evidence/phase3/desktop', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true, mode: 0o700 });
await writeFile(join(cwd, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
await writeFile(join(cwd, 'sum.test.mjs'), [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { sum } from './sum.mjs';",
  "test('adds positive numbers', () => assert.equal(sum(2, 3), 5));",
  "test('adds negative numbers', () => assert.equal(sum(-2, -3), -5));",
  "test('keeps zero unchanged', () => assert.equal(sum(7, 0), 7));",
  '',
].join('\n'));
const originalTest = await readFile(join(cwd, 'sum.test.mjs'), 'utf8');
const configPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
const fingerprint = async () => createHash('sha256').update(await readFile(configPath)).digest('hex');
const baseline = await fingerprint();
const port = Number(process.env.ORACULUM_TEST_PORT ?? '17864');
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
env.ORACULUM_URL = `http://127.0.0.1:${port}`;
env.ORACULUM_USER_DATA_DIR = join(output, 'electron-profile');
const evidence: Record<string, any> = {
  real: true, simulated: false, date: new Date().toISOString(), cwd, output,
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  buildIndexSha256: createHash('sha256').update(await readFile(resolve('apps/web/dist/index.html'))).digest('hex'),
  transport: 'isolated loopback test Bridge; no VPS, SSH or production service changes',
  turns: [], approvals: [], items: [], screenshots: [], checks: [], requests: [],
};
let app: ElectronApplication | undefined;
let server: Awaited<ReturnType<typeof createServer>> | undefined;
let codex: Codex | undefined;
let service: BridgeService | undefined;
let pending: Approval | undefined;
const methods = new Set<string>();
const errors: string[] = [];

async function screenshot(page: Page, name: string) {
  const filename = join(output, name + '.png');
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.screenshot({ path: filename, animations: 'disabled' });
  evidence.screenshots.push({ name, filename, viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })) });
}
async function resize(width: number, height: number) {
  await app!.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setContentSize(bounds.width, bounds.height), { width, height });
  const page = await app!.firstWindow();
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
}
async function assertNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const composer = await page.getByLabel('消息', { exact: true }).boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(composer).not.toBeNull();
  expect(composer!.x).toBeGreaterThanOrEqual(0);
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(viewport.height);
  if (await page.locator('.jump-latest').isVisible()) {
    const jump = await page.locator('.jump-latest').boundingBox();
    const form = await page.locator('.composer').boundingBox();
    expect(jump!.y + jump!.height).toBeLessThanOrEqual(form!.y + 1);
  }
}
async function drag(page: Page, label: string, delta: number) {
  const handle = page.getByRole('separator', { name: label, exact: true });
  const bounds = await handle.boundingBox();
  expect(bounds, label).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width / 2 + delta, bounds!.y + bounds!.height / 2, { steps: 10 });
  await page.mouse.up();
}
async function selectThread(page: Page, id: string) {
  await page.locator(`nav[aria-label="原生会话"] button[title="${id}"]`).click();
  await expect(page.getByTestId('thread-id')).toHaveText(id);
  await expect(page.getByRole('status', { includeHidden: true })).toContainText('状态已查询');
}
async function selectedThreadId(page: Page) {
  const id = (await page.getByTestId('thread-id').textContent())?.trim() ?? '';
  expect(id).not.toBe('');
  expect(id).not.toBe('尚未选择会话');
  return id;
}

try {
  codex = new Codex(cwd);
  const nativeRequest = codex.request.bind(codex);
  codex.request = async <T>(method: string, params: object): Promise<T> => {
    if (method === 'turn/start') {
      const request = params as { threadId: string; model?: string; effort?: string };
      evidence.requests.push({ method, threadId: request.threadId, model: request.model, effort: request.effort });
    }
    return nativeRequest<T>(method, params);
  };
  const projects = new ProjectDirectories(projectsRoot, cwd, new DatabaseSync(':memory:'));
  await projects.register(cwd); await projects.register(secondProject);
  service = new BridgeService(codex, cwd, undefined, projects);
  service.on('event', (message: BridgeEvent) => {
    if (message.type === 'approval') pending = message.request;
    if (message.type !== 'event') return;
    const { method, params } = message.event;
    methods.add(method);
    if (method === 'turn/completed') evidence.turns.push({ id: params.turn.id, threadId: params.threadId, status: params.turn.status, error: params.turn.error });
    if (method === 'item/completed') evidence.items.push({
      turnId: params.turnId, id: params.item.id, type: params.item.type,
      ...('status' in params.item ? { status: params.item.status } : {}),
      ...(params.item.type === 'commandExecution' ? { command: params.item.command, exitCode: params.item.exitCode, output: params.item.aggregatedOutput } : {}),
      ...(params.item.type === 'fileChange' ? { changes: params.item.changes } : {}),
    });
  });
  await codex.initialize();
  server = await createServer(service, port, resolve('apps/web/dist'), { testOnlyUnauthenticated: true });
  await server.listen({ host: '127.0.0.1', port });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env, timeout: 30_000 });
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await resize(1440, 960);
  await expect(page.getByRole('status', { includeHidden: true })).toContainText('状态已查询', { timeout: 30_000 });
  evidence.electron = await app.evaluate(({ app }) => ({ version: process.versions.electron, chromium: process.versions.chrome, ready: app.isReady(), userData: app.getPath('userData') }));
  expect(evidence.electron.userData).toBe(env.ORACULUM_USER_DATA_DIR);
  evidence.renderer = await page.evaluate(() => ({ require: typeof (window as any).require, process: typeof (window as any).process }));
  expect(evidence.renderer).toEqual({ require: 'undefined', process: 'undefined' });
  const config = await service.dispatch('bridge/config', {}) as LocalConfig;
  const catalog: Model[] = [];
  let cursor: string | null = null;
  do {
    const result = await service.dispatch('model/list', { cursor }) as { data: Model[]; nextCursor: string | null };
    catalog.push(...result.data); cursor = result.nextCursor;
  } while (cursor);
  const model = process.env.ORACULUM_TEST_MODEL || catalog.find(item => item.model === 'gpt-6-luna')?.model || config.model || catalog[0]?.model;
  const available = catalog.find(item => item.model === model);
  expect(available, 'The test model must come from native model/list').toBeTruthy();
  const efforts = available!.supportedReasoningEfforts.map(item => item.reasoningEffort);
  const effort = efforts.includes('low') ? 'low' : efforts[0];
  expect(effort).toBeTruthy();
  evidence.model = { model, effort, source: 'official model/list', availableCount: catalog.length };
  await page.getByLabel('模型', { exact: true }).selectOption(model!);
  await page.getByLabel('思考强度', { exact: true }).selectOption(effort);
  console.log(`Connected real Electron ${evidence.electron.version}; native model ${model}, effort ${effort}.`);
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByTestId('thread-id')).not.toHaveText('尚未选择会话');
  const threadId = await selectedThreadId(page); evidence.threadId = threadId;
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByTestId('thread-id')).not.toHaveText(threadId);
  await expect(page.getByTestId('thread-id')).not.toHaveText('尚未选择会话');
  const secondId = await selectedThreadId(page); evidence.secondThreadId = secondId;
  await selectThread(page, threadId);
  await page.getByLabel('模型', { exact: true }).selectOption(model!);
  await page.getByLabel('思考强度', { exact: true }).selectOption(effort);
  await screenshot(page, '01-connected-workspace');
  await page.getByLabel('消息', { exact: true }).fill([
    '这是 Oraculum 桌面真实验收。只在当前工作目录执行以下有限任务；不使用 Skills、MCP、web、子代理，不读取其他目录或全局配置。',
    '读取 sum.mjs 和 sum.test.mjs，用 apply_patch 修复 sum.mjs 中的加法错误，保持测试文件原样；运行 node --test sum.test.mjs。',
    '测试后，顺序发起两个独立命令审批（shell 工具 sandbox_permissions=require_escalated）：先执行准确命令 `printf ORACULUM_PHASE3_ALLOW`，justification="Oraculum harmless allow test"；再请求准确命令 `printf ORACULUM_PHASE3_DECLINE`，justification="Oraculum harmless decline test"。第二个将被拒绝；不要重试或绕过。',
    '最后使用中文 Markdown：标题 `## 加法修复完成`，简述实际修复、真实测试结果与两个审批结果，给出修复代码块，以及为什么正数、负数和零值测试能够覆盖本次改动。只报告真实执行事实，不声称 UI 验收已通过，约 400–600 字。不再执行其他工作。',
  ].join('\n'));
  await page.getByRole('button', { name: '发送', exact: true }).click();
  console.log('Started controlled native repair turn; waiting for exact harmless approval requests.');
  for (const [marker, decision, button] of [
    ['ORACULUM_PHASE3_ALLOW', 'accept', '允许本次'],
    ['ORACULUM_PHASE3_DECLINE', 'decline', '拒绝'],
  ] as const) {
    await expect.poll(() => pending?.method === 'item/commandExecution/requestApproval' ? pending.params.command : '', { timeout: 180_000 }).toContain(marker);
    await expect(page.getByRole('heading', { name: '需要审批', exact: true })).toBeVisible({ timeout: 30_000 });
    const request = pending!;
    const command = request.method === 'item/commandExecution/requestApproval' ? request.params.command : '';
    expect([`printf ${marker}`, `/bin/bash -lc 'printf ${marker}'`, `/bin/bash -lc "printf ${marker}"`, `/bin/sh -lc 'printf ${marker}'`], 'Never approve anything except the exact harmless fixture printf').toContain(command);
    if (decision === 'accept') {
      await selectThread(page, secondId);
      await expect(page.locator(`nav[aria-label="原生会话"] button[title="${threadId}"]`)).toContainText('待审批', { timeout: 10_000 });
      await selectThread(page, threadId);
      await expect(page.getByRole('heading', { name: '需要审批', exact: true })).toBeVisible();
      expect(service.pending.has(request.id)).toBe(true);
      evidence.checks.push('pending native approval survives session switching with accurate navigation status');
    }
    evidence.approvals.push({ method: request.method, requestId: request.id, itemId: request.params.itemId, command, decision });
    await page.getByRole('button', { name: button, exact: true }).scrollIntoViewIfNeeded();
    await screenshot(page, decision === 'accept' ? '02-command-allow' : '03-command-decline');
    await page.getByRole('button', { name: button, exact: true }).click();
    await expect.poll(() => service!.pending.has(request.id), { timeout: 15_000 }).toBe(false);
    console.log(`Real command approval ${decision} submitted and resolved.`);
  }
  await expect(page.getByRole('heading', { name: '加法修复完成', exact: true })).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId('last-turn-status')).toHaveText('completed', { timeout: 30_000 });
  await expect(page.getByRole('status', { includeHidden: true })).toContainText('状态已查询', { timeout: 30_000 });
  expect(evidence.requests[0]).toMatchObject({ model, effort });
  const testItem = evidence.items.find((item: any) => item.type === 'commandExecution' && item.command.includes('node --test') && item.exitCode === 0);
  expect(testItem).toBeTruthy();
  const allowedItem = evidence.items.find((item: any) => item.type === 'commandExecution' && item.id === evidence.approvals[0].itemId);
  const declinedItem = evidence.items.find((item: any) => item.type === 'commandExecution' && item.id === evidence.approvals[1].itemId);
  expect(allowedItem).toMatchObject({ status: 'completed', exitCode: 0 });
  expect(allowedItem.output).toContain('ORACULUM_PHASE3_ALLOW');
  expect(declinedItem).toMatchObject({ status: 'declined' });
  expect(declinedItem.output ?? '').not.toContain('ORACULUM_PHASE3_DECLINE');
  expect(await readFile(join(cwd, 'sum.test.mjs'), 'utf8')).toBe(originalTest);
  evidence.independentTest = execFileSync(process.execPath, ['--test', 'sum.test.mjs'], { cwd, encoding: 'utf8' });
  evidence.checks.push('native model/effort applied', 'native file edit and independent passing tests', 'real allow/decline approvals');
  console.log('Native repair/test/approvals completed; checking desktop interactions and actual screenshots.');
  await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await screenshot(page, '04-conversation-completed');
  const testCommand = page.locator('.command').filter({ hasText: 'node --test' }).last();
  if (await testCommand.getAttribute('open') === null) await testCommand.locator('summary').click();
  await testCommand.getByRole('button', { name: '查看输出', exact: true }).click();
  await expect(page.locator('.inspector .detail-output').first()).toHaveText(testItem.output);
  await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await screenshot(page, '04b-native-command-output');
  await page.getByRole('button', { name: '关闭面板', exact: true }).click();
  await page.getByRole('button', { name: '查看 Diff', exact: true }).first().click();
  await expect(page.locator('.inspector .cm-content')).toContainText(/a\s*\+\s*b/);
  expect(await page.locator('.inspector .cm-content').getAttribute('contenteditable')).not.toBe('true');
  await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await screenshot(page, '05-native-file-diff');

  const navBefore = await page.locator('.navigation').boundingBox();
  const inspectorBefore = await page.locator('.inspector').boundingBox();
  await drag(page, '调整导航宽度', 36);
  await drag(page, '调整检查器宽度', -42);
  const navAfter = await page.locator('.navigation').boundingBox();
  const inspectorAfter = await page.locator('.inspector').boundingBox();
  expect(navAfter!.width).toBeGreaterThan(navBefore!.width);
  expect(inspectorAfter!.width).toBeGreaterThan(inspectorBefore!.width);
  evidence.panelWidths = { nav: navAfter!.width, inspector: inspectorAfter!.width };
  await page.locator('.desktop-nav-toggle').click();
  await expect(page.locator('.navigation')).not.toBeVisible();
  await expect(page.locator('.inspector')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('status', { includeHidden: true })).toContainText('状态已查询', { timeout: 30_000 });
  await expect(page.locator('.navigation')).not.toBeVisible();
  await page.getByRole('button', { name: '展开导航', exact: true }).click();
  if (!await page.locator('.inspector').isVisible()) await page.getByRole('button', { name: '查看 Diff', exact: true }).first().click();
  await page.getByRole('button', { name: '关闭面板', exact: true }).click();
  await expect(page.locator('.inspector')).not.toBeVisible();
  await expect(page.locator('.navigation')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('status', { includeHidden: true })).toContainText('状态已查询', { timeout: 30_000 });
  await expect(page.getByTestId('thread-id')).toHaveText(threadId);
  await expect(page.locator('.inspector')).not.toBeVisible();
  expect((await page.locator('.navigation').boundingBox())!.width).toBeCloseTo(navAfter!.width, 0);
  await page.getByRole('button', { name: '查看 Diff', exact: true }).first().click();
  expect((await page.locator('.inspector').boundingBox())!.width).toBeCloseTo(inspectorAfter!.width, 0);
  await page.getByRole('button', { name: '关闭面板', exact: true }).click();
  evidence.checks.push('independent panels collapse/expand', 'panel pointer resize and saved widths survive reload');

  const longDraft = '真实长提示词验收：保留当前会话草稿，检查输入框扩展与独立发送。\n'.repeat(30);
  await page.getByLabel('消息', { exact: true }).fill(longDraft);
  await page.getByLabel('项目目录', { exact: true }).selectOption(secondProject);
  await expect(page.getByTestId('thread-id')).toHaveText('尚未选择会话');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByTestId('thread-id')).not.toHaveText('尚未选择会话');
  const projectThreadId = await selectedThreadId(page);
  await page.getByLabel('消息', { exact: true }).fill('隔离项目的独立草稿；不向模型发送。');
  const projectThread = await service.dispatch('bridge/subscribe', { threadId: projectThreadId }) as Snapshot;
  expect(projectThread.thread.cwd).toBe(secondProject);
  await page.getByLabel('项目目录', { exact: true }).selectOption(cwd);
  await expect(page.getByTestId('thread-id')).toHaveText(threadId);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue(longDraft);
  expect(await page.locator(`nav[aria-label="原生会话"] button[title="${projectThreadId}"]`).count()).toBe(0);
  evidence.checks.push('GUI directory switching creates a native thread in the selected controlled project');
  evidence.projectThread = { id: projectThreadId, cwd: projectThread.thread.cwd };
  await selectThread(page, secondId);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('');
  await page.getByLabel('消息', { exact: true }).fill('第二个真实原生会话的独立草稿。');
  await selectThread(page, threadId);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue(longDraft);
  await selectThread(page, secondId);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('第二个真实原生会话的独立草稿。');
  await selectThread(page, threadId);
  await page.getByLabel('搜索会话', { exact: true }).fill(secondId);
  await expect(page.locator('nav[aria-label="原生会话"] button')).toHaveCount(1);
  await expect(page.locator(`nav[aria-label="原生会话"] button[title="${secondId}"]`)).toBeVisible();
  await page.getByLabel('搜索会话', { exact: true }).fill('');
  await expect(page.locator(`nav[aria-label="原生会话"] button[title="${threadId}"]`)).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText(cwd);
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  evidence.checks.push('native session search and Settings open/close');
  await resize(980, 760);
  await assertNoOverflow(page);
  await screenshot(page, '06-narrow-long-composer');
  await resize(1440, 960);
  await assertNoOverflow(page);
  await screenshot(page, '07-session-draft-restored');
  evidence.checks.push('two native sessions switch with isolated drafts', 'long composer and 980px real Electron window');

  await page.getByLabel('模型', { exact: true }).selectOption(model!);
  await page.getByLabel('思考强度', { exact: true }).selectOption(effort);
  await page.getByLabel('消息', { exact: true }).fill('Controlled stop test. Only run `sleep 30` in cwd, then say done. Do not read or change files, request approvals, use skills, MCP, web or subagents.');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByTestId('turn-status')).toHaveText('执行中', { timeout: 30_000 });
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByTestId('last-turn-status')).toHaveText('interrupted', { timeout: 30_000 });
  expect(evidence.requests).toHaveLength(2);
  expect(evidence.requests[1]).toMatchObject({ model, effort, threadId });
  expect(evidence.turns.map((turn: any) => turn.status)).toEqual(['completed', 'interrupted']);
  evidence.checks.push('native turn interrupt from GUI');
  const restored = await service.dispatch('bridge/subscribe', { threadId }) as Snapshot;
  evidence.history = { source: restored.history?.source, warning: restored.history?.warning, model: restored.thread.model, effort: restored.thread.reasoningEffort };
  await page.getByRole('button', { name: '查看 Diff', exact: true }).first().click();
  await screenshot(page, '08-desktop-final');
  expect(await fingerprint()).toBe(baseline);
  expect(errors).toEqual([]);
  evidence.result = 'passed';
  console.log(JSON.stringify({ result: evidence.result, output, threadId, checks: evidence.checks }, null, 2));
} catch (error) {
  evidence.result = 'failed'; evidence.failure = String(error); process.exitCode = 1;
  console.error(evidence.failure);
  if (app) await screenshot(await app.firstWindow(), 'failure').catch(() => {});
} finally {
  try {
    for (const close of [() => app?.close(), () => server?.close(), () => codex?.close()]) {
      try { await close(); }
      catch (error) { evidence.cleanupErrors = [...(evidence.cleanupErrors ?? []), String(error)]; process.exitCode = 1; }
    }
  } finally {
    evidence.events = [...methods];
    evidence.rendererErrors = errors;
    evidence.globalConfigUnchanged = await fingerprint() === baseline;
    if (evidence.cleanupErrors?.length || !evidence.globalConfigUnchanged) evidence.result = 'failed';
    await writeFile(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
}
