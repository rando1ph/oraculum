// Opt-in real HONOR WebView + official Codex acceptance over USB ADB reverse.
// Requires the running Oraculum debug app at http://127.0.0.1:17860/ and an
// ORACULUM_ANDROID_CDP=http://127.0.0.1:<forwarded-webview-port> endpoint.
// Two bounded model turns in a new private fixture; no production services.
// Real Chinese IME and native server settings are separate manual/device checks.
// Pass a prior acceptance.json as the first argument for zero-turn visual review.
// Add --stop to that review command only to finish one interrupted-turn check.
// Or --approvals for one harmless approval-only turn and final device captures.
// --manual-hold keeps the fixture online until <output>/manual-finish is created.
// ORACULUM_MANUAL_PROJECT checks a manually registered path reaches Electron.
import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { Codex } from '../bridge/src/codex';
import { BridgeService } from '../bridge/src/service';
import { ProjectDirectories } from '../bridge/src/projects';
import { TrustStore } from '../bridge/src/trust-store';
import { ReceiptStore } from '../bridge/src/receipts';
import { createServer } from '../bridge/src/server';
import type { Approval, BridgeEvent, LocalConfig, Model, Snapshot } from '../packages/shared/protocol';

const endpoint = new URL(process.env.ORACULUM_ANDROID_CDP ?? 'about:blank');
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password) throw new Error('Set ORACULUM_ANDROID_CDP to the local forwarded Oraculum WebView endpoint');
const port = 17860, origin = `http://127.0.0.1:${port}`;
try { await fetch(origin + '/health'); throw new Error('Port 17860 is already in use; do not replace an existing service'); }
catch (error) { if (!(error instanceof TypeError)) throw error; }
const workspaceRoot = join(homedir(), '.cache/oraculum/workspaces');
await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
const reviewArgument = process.argv.slice(2).find(argument => !argument.startsWith('--'));
const reviewPath = reviewArgument ? resolve(reviewArgument) : undefined;
if (reviewPath && !reviewPath.startsWith(resolve('.local/evidence/phase3/android') + '/')) throw new Error('Review report must be inside the private Phase 3 Android evidence directory');
const review = reviewPath ? JSON.parse(await readFile(reviewPath, 'utf8')) : undefined;
if (process.argv.includes('--stop') && !review) throw new Error('--stop requires a prior completed fixture report');
if (process.argv.includes('--approvals') && (!review || process.argv.includes('--stop'))) throw new Error('--approvals requires a prior report and cannot combine with --stop');
if (review && (review.real !== true || review.simulated !== false || typeof review.cwd !== 'string' || !review.cwd.startsWith(join(workspaceRoot, 'phase3-android-')) || await realpath(review.cwd) !== review.cwd || typeof review.threadId !== 'string')) throw new Error('Review requires an existing real Phase 3 Android fixture report');
const cwd: string = review?.cwd ?? await mkdtemp(join(workspaceRoot, 'phase3-android-'));
const reviewStop = !!review && process.argv.includes('--stop');
const reviewApprovals = !!review && process.argv.includes('--approvals');
const stopPrompt = 'Controlled stop test. Only run `sleep 30` in cwd, then say done. Do not read or change files, request approvals, use skills, MCP, web or subagents.';
const approvalsPrompt = [
  '这是 Oraculum 最终真机审批截图复核，只在当前 cwd 执行以下两个无副作用命令。不读取、创建、编辑、删除任何文件；不用 Skills、MCP、web、子代理或其他命令。',
  '顺序发起两个独立 shell 审批，sandbox_permissions=require_escalated：首先准确命令 `printf ORACULUM_3B_ALLOW_FINAL`，justification="Oraculum final harmless allow capture"；然后准确命令 `printf ORACULUM_3B_DECLINE_FINAL`，justification="Oraculum final harmless decline capture"。第二条将被拒绝，不要重试或绕过。',
  '最后以中文 Markdown 标题 `## 移动审批复核完成` 和一段简洁说明实际两个审批结果结束。不再执行其他工作。',
].join('\n');
const output = resolve('.local/evidence/phase3/android', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true, mode: 0o700 });
if (!review) {
await writeFile(join(cwd, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
await writeFile(join(cwd, 'sum.test.mjs'), [
  "import { test } from 'node:test';", "import assert from 'node:assert/strict';", "import { sum } from './sum.mjs';",
  "test('adds positive numbers', () => assert.equal(sum(2, 3), 5));",
  "test('adds negative numbers', () => assert.equal(sum(-2, -3), -5));",
  "test('keeps zero unchanged', () => assert.equal(sum(7, 0), 7));", '',
].join('\n'));
}
const originalTest = await readFile(join(cwd, 'sum.test.mjs'), 'utf8');
const originalSum = await readFile(join(cwd, 'sum.mjs'), 'utf8');
const configPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
const configHash = () => readFile(configPath).then(bytes => createHash('sha256').update(bytes).digest('hex'));
const baselineConfig = await configHash();
const adbArgs = process.env.ORACULUM_ADB_SERIAL ? ['-s', process.env.ORACULUM_ADB_SERIAL] : ['-d'];
const adb = (...args: string[]) => execFileSync('adb', [...adbArgs, ...args], { encoding: 'utf8' }).trim();
const previousReverse = adb('reverse', '--list').split('\n').find(line => line.split(/\s+/)[1] === `tcp:${port}`)?.split(/\s+/)[2];
const stateDirectory = reviewPath ? resolve(typeof review.stateDirectory === 'string' ? review.stateDirectory : join(dirname(reviewPath), 'state')) : join(output, 'state');
if (reviewPath && (!stateDirectory.startsWith(resolve('.local/evidence/phase3/android') + '/') || await realpath(stateDirectory) !== stateDirectory)) throw new Error('Review state must be the existing private fixture directory');
const trust = new TrustStore(stateDirectory);
const projects = new ProjectDirectories(workspaceRoot, cwd, trust.db, [join(homedir(), 'Projects'), workspaceRoot]);
await projects.register(cwd);
const codex = new Codex(cwd);
const service = new BridgeService(codex, cwd, new ReceiptStore(trust.db), projects);
const evidence: Record<string, any> = { real: true, simulated: false, date: new Date().toISOString(), cwd, output,
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  buildIndexSha256: createHash('sha256').update(await readFile('apps/web/dist/index.html')).digest('hex'),
  transport: 'actual HONOR Android WebView via USB ADB reverse + real Ubuntu Electron; isolated authenticated Bridge',
  nativeIME: 'not exercised by this runner; recorded separately', nativeServerSettings: 'recorded separately',
  reviewOnly: !!review && !reviewStop && !reviewApprovals, continuedStop: reviewStop, continuedApprovals: reviewApprovals, sourceAcceptance: reviewPath, stateDirectory,
  turns: [], approvals: [], items: [], requests: [], screenshots: [], checks: [] };
const nativeRequest = codex.request.bind(codex);
let manualChecks = false;
codex.request = async <T>(method: string, params: object): Promise<T> => {
  if (manualChecks && method === 'turn/start') throw new Error('Manual hold permits empty native sessions but never a model turn');
  if (review && method === 'thread/start' && !manualChecks) throw new Error('Automated review forbids new native sessions');
  if (review && method === 'turn/start' && ((!reviewStop && !reviewApprovals) || evidence.requests.length || (params as any).input?.[0]?.text !== (reviewStop ? stopPrompt : approvalsPrompt))) throw new Error('Review permits no model turn except one explicitly requested bounded continuation');
  if (method === 'turn/start') { const p = params as any; evidence.requests.push({ method, threadId: p.threadId, model: p.model, effort: p.effort }); }
  const result = await nativeRequest<T>(method, params);
  if (manualChecks && method === 'thread/start') {
    const thread = (result as any).thread;
    evidence.manualNativeSessions = [...(evidence.manualNativeSessions ?? []), { id: thread.id, cwd: thread.cwd }];
  }
  return result;
};
let pending: Approval | undefined;
service.on('event', (message: BridgeEvent) => {
  if (message.type === 'approval') pending = message.request;
  if (message.type !== 'event') return;
  const { method, params } = message.event;
  if (method === 'turn/completed') evidence.turns.push({ id: params.turn.id, threadId: params.threadId, status: params.turn.status });
  if (method === 'item/completed') evidence.items.push({ id: params.item.id, turnId: params.turnId, type: params.item.type,
    ...('status' in params.item ? { status: params.item.status } : {}),
    ...(params.item.type === 'commandExecution' ? { command: params.item.command, exitCode: params.item.exitCode, output: params.item.aggregatedOutput } : {}),
    ...(params.item.type === 'fileChange' ? { changes: params.item.changes } : {}),
  });
});
let server: Awaited<ReturnType<typeof createServer>> | undefined, android: Browser | undefined, app: ElectronApplication | undefined;
let phone: Page | undefined, desktop: Page | undefined;
let savedCookies: import('@playwright/test').Cookie[] | undefined;
let savedStorage: { local: Record<string, string>; session: Record<string, string> } | undefined;
const errors: string[] = []; let step = 'initialization', authenticated = false;
const ready = (page: Page) => expect(page.getByRole('status', { includeHidden: true })).toContainText('状态已查询', { timeout: 45_000 });
async function pair(page: Page, label: string) {
  await expect(page.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible();
  await page.getByLabel('设备名称', { exact: true }).fill(label);
  await page.getByLabel('配对码', { exact: true }).fill(trust.createPairing().code);
  await page.getByRole('button', { name: '配对并连接', exact: true }).click(); await ready(page);
}
async function drawer(page: Page) { if (page === phone && !await page.locator('.app-shell').evaluate(element => element.classList.contains('drawer-open'))) await page.getByRole('button', { name: '打开导航', exact: true }).click(); }
async function select(page: Page, id: string) {
  await drawer(page); await page.locator(`nav[aria-label="原生会话"] button[title="${id}"]`).click(); await ready(page); await expect(page.getByTestId('thread-id')).toHaveText(id);
  // The native list may already select this thread on initial connect. Ensure
  // the reading test never scrolls the inert conversation beneath a drawer.
  if (page === phone && await page.locator('.app-shell').evaluate(element => element.classList.contains('drawer-open'))) await page.getByRole('button', { name: '折叠导航', exact: true }).click();
}
async function screenshot(page: Page, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.screenshot({ path: join(output, name + '-webview.png'), animations: 'disabled' });
  const capture = { name, viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), webview: name + '-webview.png', device: undefined as string | undefined };
  if (page === phone) { capture.device = name + '-device.png'; await writeFile(join(output, capture.device), execFileSync('adb', [...adbArgs, 'exec-out', 'screencap', '-p'], { maxBuffer: 16 * 1024 * 1024 })); }
  evidence.screenshots.push(capture);
}
async function androidBack() { adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); }
async function hideIme() {
  // Filter on-device: the complete IME dump can contain large unrelated state.
  const shown = () => /\bmInputShown=true\b/.test(adb('shell', 'dumpsys input_method | grep mInputShown='));
  if (shown()) { await androidBack(); await expect.poll(shown).toBe(false); }
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await page.locator('.composer').boundingBox(), height = await page.evaluate(() => innerHeight);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height + 1);
}
async function readingState(page: Page, stage: string) {
  const state = await page.evaluate(() => {
    const element = document.querySelector('.conversation-scroll')!;
    return { top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight, viewport: innerHeight, visualViewport: visualViewport?.height, activeElement: document.activeElement?.tagName, drawer: document.querySelector('.app-shell')!.classList.contains('drawer-open') };
  });
  evidence.readingStates = [...(evidence.readingStates ?? []), { stage, ...state }]; return state;
}
async function settleReading(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
try {
  step = 'initialize native App Server and fixture Bridge';
  await codex.initialize(); server = await createServer(service, port, resolve('apps/web/dist'), { trust }); await server.listen({ host: '127.0.0.1', port });
  adb('reverse', `tcp:${port}`, `tcp:${port}`); adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  // A previous native Back check may leave the app in the background; paused
  // Android WebViews cannot reliably complete navigation or frame-based clicks.
  adb('shell', 'am', 'start', '-n', 'dev.oraculum.poc/.MainActivity');
  step = 'connect current Android WebView';
  android = await chromium.connectOverCDP(endpoint.href, { noDefaults: true });
  const pages = android.contexts()[0]?.pages() ?? [];
  phone = pages.find(page => page.url() === origin + '/') ?? (pages.length === 1 && pages[0].url().startsWith('chrome-error://chromewebdata') ? pages[0] : undefined);
  if (!phone) throw new Error('Expected the current Oraculum debug WebView at the local root entry');
  savedCookies = (await phone.context().cookies([origin])).filter(cookie => cookie.name === 'oraculum_local' && cookie.path === '/');
  if (phone.url() !== origin + '/') await phone.goto(origin + '/');
  savedStorage = await phone.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  await phone.context().clearCookies({ name: 'oraculum_local', domain: '127.0.0.1', path: '/' });
  await phone.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  phone.on('pageerror', error => errors.push(error.message)); step = 'reload and pair Android fixture';
  await phone.reload(); await pair(phone, 'Phase 3B HONOR acceptance'); authenticated = true;
  evidence.android = { manufacturer: adb('shell', 'getprop', 'ro.product.manufacturer'), model: adb('shell', 'getprop', 'ro.product.model'), release: adb('shell', 'getprop', 'ro.build.version.release'), userAgent: await phone.evaluate(() => navigator.userAgent), viewport: await phone.evaluate(() => ({ width: innerWidth, height: innerHeight })) };
  expect(evidence.android.manufacturer.toUpperCase()).toBe('HONOR'); expect(evidence.android.release).toBe('15');
  const require = createRequire(resolve('apps/desktop/package.json'));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron-profile') });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env }); desktop = await app.firstWindow();
  desktop.on('pageerror', error => errors.push(error.message)); await pair(desktop, 'Phase 3B Electron regression');
  evidence.electron = await app.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome }));
  const config = await service.dispatch('bridge/config', {}) as LocalConfig, catalog: Model[] = []; let cursor: string | null = null;
  do { const page = await service.dispatch('model/list', { cursor }) as { data: Model[]; nextCursor: string | null }; catalog.push(...page.data); cursor = page.nextCursor; } while (cursor);
  const model = process.env.ORACULUM_TEST_MODEL || catalog.find(item => item.model === 'gpt-6-luna')?.model || config.model || catalog[0]?.model;
  const available = catalog.find(item => item.model === model); expect(available).toBeTruthy();
  const effort = available!.supportedReasoningEfforts.find(item => item.reasoningEffort === 'low')?.reasoningEffort || available!.supportedReasoningEfforts[0].reasoningEffort;
  evidence.model = { model, effort, source: 'official model/list' };
  if (review) {
    step = 'zero-turn native history and visual review';
    const threadId: string = review.threadId; evidence.threadId = threadId;
    await select(phone, threadId); await select(desktop, threadId); await hideIme();
    const snapshot = await service.dispatch('bridge/subscribe', { threadId }) as Snapshot;
    expect(snapshot.thread.cwd).toBe(cwd); expect(snapshot.thread.turns.some(turn => turn.status === 'completed')).toBe(true);
    expect(snapshot.receipts?.some(receipt => receipt.status === 'completed')).toBe(true);
    evidence.history = { source: snapshot.history?.source, warning: snapshot.history?.warning, turnStatuses: snapshot.thread.turns.map(turn => turn.status), receiptStatuses: snapshot.receipts?.map(receipt => receipt.status) };
    await phone.getByRole('heading', { name: '移动端修复完成', exact: true }).scrollIntoViewIfNeeded(); await noOverflow(phone); await screenshot(phone, 'review-01-conversation');
    const scroll = phone.locator('.conversation-scroll'); await scroll.evaluate(e => { e.scrollTop = Math.max(0, e.scrollHeight - e.clientHeight - 400); }); await settleReading(phone);
    const before = (await readingState(phone, 'before drawer')).top; await drawer(phone); await readingState(phone, 'drawer opened'); await screenshot(phone, 'review-02-drawer'); await androidBack(); await settleReading(phone); await readingState(phone, 'after native Back');
    await expect(phone.locator('.app-shell')).not.toHaveClass(/drawer-open/); expect(await scroll.evaluate(e => e.scrollTop)).toBeCloseTo(before, 0);
    const nativeListing = await service.dispatch('thread/list', { cwd }) as { data: { id: string }[] };
    if (typeof review.secondThreadId === 'string' && nativeListing.data.some(thread => thread.id === review.secondThreadId)) {
      evidence.secondThreadId = review.secondThreadId;
      await phone.getByLabel('消息', { exact: true }).fill('复核第一会话草稿；不发送。'); await select(phone, review.secondThreadId);
      await phone.getByLabel('消息', { exact: true }).fill('复核第二会话独立草稿；不发送。'); await select(phone, threadId);
      await expect(phone.getByLabel('消息', { exact: true })).toHaveValue('复核第一会话草稿；不发送。');
      await phone.getByLabel('消息', { exact: true }).fill(''); await hideIme();
      evidence.checks.push('persisted native sessions retain independent mobile drafts');
    } else evidence.limitations = ['The prior empty native session is absent from native thread/list after restart; this zero-turn review cannot repeat its draft switch.'];
    await phone.getByRole('button', { name: '查看 Diff', exact: true }).first().scrollIntoViewIfNeeded(); const diffTop = await scroll.evaluate(e => e.scrollTop);
    await phone.getByRole('button', { name: '查看 Diff', exact: true }).first().click(); await expect(phone.locator('.inspector .cm-content')).toContainText(/a\s*\+\s*b/);
    expect(await phone.locator('.inspector .cm-content').getAttribute('contenteditable')).not.toBe('true'); await screenshot(phone, 'review-03-fullscreen-diff');
    await androidBack(); await expect(phone.locator('.inspector')).toHaveCount(0); expect(await scroll.evaluate(e => e.scrollTop)).toBeCloseTo(diffTop, 0);
    await drawer(phone); await phone.getByRole('button', { name: '设置', exact: true }).click(); await screenshot(phone, 'review-04-web-settings'); await androidBack();
    await expect(phone.locator('.settings-dialog')).not.toBeVisible();
    if (await phone.locator('.app-shell').evaluate(e => e.classList.contains('drawer-open'))) await androidBack();
    await desktop.getByRole('button', { name: '查看 Diff', exact: true }).first().click(); await expect(desktop.locator('.inspector .cm-content')).toContainText(/a\s*\+\s*b/); await screenshot(desktop, 'review-05-electron');
    await phone.reload(); await ready(phone); await expect(phone.getByTestId('thread-id')).toHaveText(threadId);
    expect(evidence.requests).toHaveLength(0); expect(await readFile(join(cwd, 'sum.test.mjs'), 'utf8')).toBe(originalTest);
    evidence.checks.push(reviewStop || reviewApprovals ? 'prior repair reused; only an explicit bounded continuation may start' : 'zero new native sessions/turns enforced', 'native persisted history and completed receipt after new App Server process', 'Android Back closes drawer/settings/Diff and restores reading', 'Electron real persisted Diff regression');
  } else {
  step = 'create native sessions'; await drawer(phone); await phone.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(phone.getByTestId('thread-id')).not.toHaveText('尚未选择会话'); const threadId = (await phone.getByTestId('thread-id').textContent())!; evidence.threadId = threadId;
  await drawer(phone); await phone.getByRole('button', { name: '新建会话', exact: true }).click(); await expect(phone.getByTestId('thread-id')).not.toHaveText(threadId);
  const secondId = (await phone.getByTestId('thread-id').textContent())!; evidence.secondThreadId = secondId;
  await select(phone, threadId); await desktop.getByRole('button', { name: '刷新列表', exact: true }).click(); await select(desktop, threadId);
  await phone.getByLabel('模型', { exact: true }).selectOption(model!); await phone.getByLabel('思考强度', { exact: true }).selectOption(effort);
  await phone.getByLabel('消息', { exact: true }).fill([
    '这是 Oraculum Android 真机受控验收。只在当前 cwd 进行以下有限任务，不用 Skills、MCP、web、子代理，不读其他目录或全局配置。',
    '读取 sum.mjs 和 sum.test.mjs，用 apply_patch 修复 sum.mjs 的加法错误，测试文件保持原样；运行 node --test sum.test.mjs。',
    '随后按顺序分别发起两个独立的 shell 审批，sandbox_permissions=require_escalated：先执行准确命令 `printf ORACULUM_3B_ALLOW`，justification="Oraculum harmless Android allow test"；再请求准确命令 `printf ORACULUM_3B_DECLINE`，justification="Oraculum harmless Android decline test"。第二条将被拒绝，不要重试或绕过。',
    '最后中文 Markdown 标题 `## 移动端修复完成`，约 600–800 字说明真实修复、测试输出与审批结果，含代码块和分段。只报告真实执行事实，不声称界面验收通过，不再执行其他工作。',
  ].join('\n'));
  await hideIme();
  step = 'native repair and approvals'; console.log('Running bounded native repair and exact harmless approvals on HONOR.');
  await phone.getByRole('button', { name: '发送', exact: true }).click();
  for (const [marker, decision, label] of [['ORACULUM_3B_ALLOW', 'accept', '允许本次'], ['ORACULUM_3B_DECLINE', 'decline', '拒绝']] as const) {
    await expect.poll(() => pending?.method === 'item/commandExecution/requestApproval' ? pending.params.command : '', { timeout: 180_000 }).toContain(marker);
    const request = pending!, command = request.method === 'item/commandExecution/requestApproval' ? request.params.command : '';
    expect([`printf ${marker}`, `/bin/bash -lc 'printf ${marker}'`, `/bin/bash -lc "printf ${marker}"`, `/bin/sh -lc 'printf ${marker}'`], 'Never approve an unexpected command').toContain(command);
    await expect(phone.getByRole('heading', { name: '需要审批', exact: true })).toBeVisible();
    await expect(desktop.getByRole('heading', { name: '需要审批', exact: true })).toBeVisible();
    if (decision === 'accept') {
      await select(phone, secondId); await drawer(phone); await expect(phone.locator(`nav[aria-label="原生会话"] button[title="${threadId}"]`)).toContainText('待审批');
      await phone.locator(`nav[aria-label="原生会话"] button[title="${threadId}"]`).click(); await ready(phone);
      expect(service.pending.has(request.id)).toBe(true);
    }
    await phone.getByRole('button', { name: label, exact: true }).scrollIntoViewIfNeeded(); await screenshot(phone, `01-approval-${decision}`);
    const buttonBounds = await phone.getByRole('button', { name: label, exact: true }).boundingBox(); expect(buttonBounds!.height).toBeGreaterThanOrEqual(48);
    evidence.approvals.push({ requestId: request.id, itemId: request.params.itemId, method: request.method, command, decision });
    await phone.getByRole('button', { name: label, exact: true }).click(); await expect(desktop.locator('.approval')).toHaveCount(0); pending = undefined;
  }
  await expect(phone.getByRole('heading', { name: '移动端修复完成', exact: true })).toBeVisible({ timeout: 180_000 });
  await expect(phone.getByTestId('last-turn-status')).toHaveText('completed', { timeout: 30_000 }); await ready(phone);
  expect(evidence.requests).toEqual([{ method: 'turn/start', threadId, model, effort }]);
  const allowed = evidence.items.find((item: any) => item.id === evidence.approvals[0].itemId), declined = evidence.items.find((item: any) => item.id === evidence.approvals[1].itemId);
  expect(allowed).toMatchObject({ status: 'completed', exitCode: 0 }); expect(allowed.output).toContain('ORACULUM_3B_ALLOW');
  expect(declined).toMatchObject({ status: 'declined' }); expect(declined.output ?? '').not.toContain('ORACULUM_3B_DECLINE');
  expect(await readFile(join(cwd, 'sum.test.mjs'), 'utf8')).toBe(originalTest);
  evidence.independentTest = execFileSync(process.execPath, ['--test', 'sum.test.mjs'], { cwd, encoding: 'utf8' });
  evidence.checks.push('official model/effort parameters', 'native apply_patch, unchanged test fixture and independent tests', 'actual HONOR allow/decline; desktop observes invalidation', 'pending approval survives native session switching');
  step = 'mobile reading, drawer, draft and full-screen diff';
  await phone.getByRole('heading', { name: '移动端修复完成', exact: true }).scrollIntoViewIfNeeded(); await noOverflow(phone); await screenshot(phone, '02-conversation');
  const scroll = phone.locator('.conversation-scroll'); await scroll.evaluate(e => { e.scrollTop = Math.max(0, e.scrollHeight - e.clientHeight - 400); });
  const before = await scroll.evaluate(e => e.scrollTop); await hideIme(); await drawer(phone); await screenshot(phone, '03-drawer'); await androidBack();
  await expect(phone.locator('.app-shell')).not.toHaveClass(/drawer-open/); expect(await scroll.evaluate(e => e.scrollTop)).toBeCloseTo(before, 0);
  const draft = '移动端独立草稿；此文本不发送。\n'.repeat(16); await phone.getByLabel('消息', { exact: true }).fill(draft);
  await select(phone, secondId); await phone.getByLabel('消息', { exact: true }).fill('第二会话草稿，不发送。'); await select(phone, threadId);
  await expect(phone.getByLabel('消息', { exact: true })).toHaveValue(draft);
  // CDP fill is not an IME test; the physical keyboard capture is recorded separately.
  await phone.getByLabel('消息', { exact: true }).fill(''); await hideIme(); await phone.getByRole('button', { name: '查看 Diff', exact: true }).first().scrollIntoViewIfNeeded();
  const diffTop = await scroll.evaluate(e => e.scrollTop); await phone.getByRole('button', { name: '查看 Diff', exact: true }).first().click();
  await expect(phone.locator('.inspector .cm-content')).toContainText(/a\s*\+\s*b/); expect(await phone.locator('.inspector .cm-content').getAttribute('contenteditable')).not.toBe('true');
  const panel = await phone.locator('.inspector').boundingBox(), viewport = await phone.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(panel).toMatchObject({ x: 0, y: 0, width: viewport.width, height: viewport.height }); await screenshot(phone, '04-fullscreen-diff');
  await androidBack(); await expect(phone.locator('.inspector')).toHaveCount(0); expect(await scroll.evaluate(e => e.scrollTop)).toBeCloseTo(diffTop, 0);
  await drawer(phone); await phone.getByRole('button', { name: '设置', exact: true }).click(); await screenshot(phone, '05-web-settings'); await androidBack();
  await expect(phone.locator('.settings-dialog')).not.toBeVisible();
  if (await phone.locator('.app-shell').evaluate(e => e.classList.contains('drawer-open'))) await androidBack();
  await desktop.getByRole('button', { name: '查看 Diff', exact: true }).first().click(); await expect(desktop.locator('.inspector .cm-content')).toContainText(/a\s*\+\s*b/); await screenshot(desktop, '06-electron-regression');
  evidence.checks.push('native Android Back closes drawer/settings/full-screen Diff', 'real Diff read-only/full viewport and reading position restored', 'native sessions retain independent mobile drafts', 'Electron three-column native Diff regression');
  step = 'reload and completed receipt recovery'; await phone.reload(); await ready(phone); await expect(phone.getByTestId('thread-id')).toHaveText(threadId);
  await expect(phone.getByRole('heading', { name: '移动端修复完成', exact: true })).toBeVisible();
  const restored = await service.dispatch('bridge/subscribe', { threadId }) as Snapshot;
  expect(restored.receipts).toEqual([expect.objectContaining({ status: 'completed' })]);
  evidence.history = { source: restored.history?.source, warning: restored.history?.warning, receiptStatuses: restored.receipts?.map(receipt => receipt.status) };
  await screenshot(phone, '07-native-history-reload'); evidence.checks.push('native history reload and completed receipt, no replay');
  }
  if (!review || reviewStop) {
  const threadId: string = evidence.threadId;
  step = 'native stop'; await phone.getByLabel('模型', { exact: true }).selectOption(model!); await phone.getByLabel('思考强度', { exact: true }).selectOption(effort);
  await phone.getByLabel('消息', { exact: true }).fill(stopPrompt);
  await phone.getByRole('button', { name: '发送', exact: true }).click(); await expect(phone.getByTestId('turn-status')).toHaveText('执行中', { timeout: 30_000 });
  await phone.getByRole('button', { name: '停止', exact: true }).click(); await expect(phone.getByTestId('last-turn-status')).toHaveText('interrupted', { timeout: 30_000 });
  expect(evidence.requests).toHaveLength(reviewStop ? 1 : 2); expect(evidence.requests.at(-1)).toMatchObject({ model, effort, threadId });
  expect(evidence.turns.map((turn: any) => turn.status)).toEqual(reviewStop ? ['interrupted'] : ['completed', 'interrupted']);
  evidence.checks.push('actual HONOR send/stop produces native interrupted turn');
  }
  if (reviewApprovals) {
    step = 'final native approval captures';
    const threadId: string = evidence.threadId;
    await phone.getByLabel('模型', { exact: true }).selectOption(model!); await phone.getByLabel('思考强度', { exact: true }).selectOption(effort);
    await phone.getByLabel('消息', { exact: true }).fill(approvalsPrompt); await hideIme(); await phone.getByRole('button', { name: '发送', exact: true }).click();
    for (const [marker, decision, label] of [['ORACULUM_3B_ALLOW_FINAL', 'accept', '允许本次'], ['ORACULUM_3B_DECLINE_FINAL', 'decline', '拒绝']] as const) {
      await expect.poll(() => pending?.method === 'item/commandExecution/requestApproval' ? pending.params.command : '', { timeout: 180_000 }).toContain(marker);
      const request = pending!, command = request.method === 'item/commandExecution/requestApproval' ? request.params.command : '';
      expect([`printf ${marker}`, `/bin/bash -lc 'printf ${marker}'`, `/bin/bash -lc "printf ${marker}"`, `/bin/sh -lc 'printf ${marker}'`], 'Never approve an unexpected command').toContain(command);
      await expect(phone.getByRole('heading', { name: '需要审批', exact: true })).toBeVisible();
      await expect(desktop.getByRole('heading', { name: '需要审批', exact: true })).toBeVisible();
      await phone.getByRole('button', { name: label, exact: true }).scrollIntoViewIfNeeded(); await screenshot(phone, `final-approval-${decision}`);
      evidence.approvals.push({ requestId: request.id, itemId: request.params.itemId, method: request.method, command, decision });
      await phone.getByRole('button', { name: label, exact: true }).click(); await expect(desktop.locator('.approval')).toHaveCount(0); pending = undefined;
    }
    await expect(phone.getByRole('heading', { name: '移动审批复核完成', exact: true })).toBeVisible({ timeout: 180_000 });
    await expect(phone.getByTestId('last-turn-status')).toHaveText('completed', { timeout: 30_000 }); await ready(phone);
    expect(evidence.requests).toEqual([{ method: 'turn/start', threadId, model, effort }]);
    expect(evidence.turns.map((turn: any) => turn.status)).toEqual(['completed']);
    const allowed = evidence.items.find((item: any) => item.id === evidence.approvals[0].itemId), declined = evidence.items.find((item: any) => item.id === evidence.approvals[1].itemId);
    expect(allowed).toMatchObject({ status: 'completed', exitCode: 0 }); expect(allowed.output).toContain('ORACULUM_3B_ALLOW_FINAL');
    expect(declined).toMatchObject({ status: 'declined' }); expect(declined.output ?? '').not.toContain('ORACULUM_3B_DECLINE_FINAL');
    expect(await readFile(join(cwd, 'sum.mjs'), 'utf8')).toBe(originalSum); expect(await readFile(join(cwd, 'sum.test.mjs'), 'utf8')).toBe(originalTest);
    evidence.checks.push('final actual device allow/decline captures; exact harmless commands only, no fixture edit');
  }
  expect(errors).toEqual([]); expect(await configHash()).toBe(baselineConfig); evidence.result = 'passed';
  if (process.argv.includes('--manual-hold')) {
    manualChecks = true;
    step = 'manual device checks'; evidence.manualHold = { started: new Date().toISOString(), completionMarker: join(output, 'manual-finish') };
    // Write the verified automated result before waiting; this marker never
    // claims the separate manual IME/settings/orientation checks have passed.
    await writeFile(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ manualReady: true, output, threadId: evidence.threadId }));
    const deadline = Date.now() + 30 * 60_000;
    let finished = false;
    while (Date.now() < deadline) {
      try { await access(join(output, 'manual-finish')); finished = true; break; } catch { /* Poll only the opt-in local marker. */ }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!finished) throw new Error('Manual device hold timed out without completion marker');
    manualChecks = false;
    evidence.manualHold.finished = new Date().toISOString();
    evidence.postHoldBuildIndexSha256 = createHash('sha256').update(await readFile('apps/web/dist/index.html')).digest('hex');
    if (process.env.ORACULUM_MANUAL_PROJECT) {
      const expectedProject = resolve(process.env.ORACULUM_MANUAL_PROJECT);
      // Inspect the existing observer's selector only: never select the user's
      // project or subscribe to its previous native sessions for this check.
      await expect.poll(() => desktop!.getByLabel('项目目录', { exact: true }).locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toContain(expectedProject);
      evidence.manualProjectPropagation = { path: expectedProject, observedBy: 'existing Electron client project selector', selectedOrReadHistory: false };
      evidence.checks.push('manual Android project registration propagated to existing Electron client');
    }
  }
  console.log(JSON.stringify({ result: evidence.result, output, threadId: evidence.threadId, reviewOnly: !!review && !reviewStop && !reviewApprovals, turns: evidence.turns, checks: evidence.checks }, null, 2));
} catch (error) {
  evidence.result = 'failed'; evidence.step = step; evidence.failure = authenticated ? String(error) : (error instanceof Error ? error.name : 'Setup error'); process.exitCode = 1;
  console.error(`Android acceptance failed at ${step}: ${evidence.failure}`);
  if (authenticated && phone && await phone.getByRole('heading', { name: '信任此设备', exact: true }).count() === 0) await screenshot(phone, 'failure').catch(() => {});
} finally {
  const cleanup = async (name: string, operation: () => unknown | Promise<unknown>) => {
    try { await operation(); } catch { evidence.cleanupErrors = [...(evidence.cleanupErrors ?? []), name]; evidence.result = 'failed'; process.exitCode = 1; }
  };
  await cleanup('close Electron', () => app?.close());
  if (process.argv.includes('--manual-hold') && android) await cleanup('reacquire default Android WebView', async () => {
    if (!android!.isConnected()) android = await chromium.connectOverCDP(endpoint.href, { noDefaults: true });
    const current = android!.contexts().flatMap(context => context.pages()).find(page => !page.isClosed() && page.url() === origin + '/');
    if (!current) throw new Error('Return to the original local server before completing manual checks');
    phone = current;
  });
  if (phone && savedStorage) await cleanup('restore Android storage', () => phone!.evaluate(saved => { localStorage.clear(); sessionStorage.clear(); for (const [key, value] of Object.entries(saved.local)) localStorage.setItem(key, value); for (const [key, value] of Object.entries(saved.session)) sessionStorage.setItem(key, value); }, savedStorage!));
  if (phone && savedCookies) await cleanup('restore Android loopback cookie', async () => { await phone!.context().clearCookies({ name: 'oraculum_local', domain: '127.0.0.1', path: '/' }); await phone!.context().addCookies(savedCookies!); });
  await cleanup('detach Android CDP', () => android?.close());
  await cleanup('close fixture Bridge', () => server?.close());
  await cleanup('close native App Server', () => codex.close());
  await cleanup('revoke fixture devices', () => { for (const device of trust.list()) trust.revoke(device.id); trust.close(); });
  await cleanup('restore ADB reverse', () => previousReverse ? adb('reverse', `tcp:${port}`, previousReverse) : adb('reverse', '--remove', `tcp:${port}`));
  evidence.rendererErrors = errors; evidence.globalConfigUnchanged = await configHash() === baselineConfig;
  if (!evidence.globalConfigUnchanged) { evidence.result = 'failed'; process.exitCode = 1; }
  await writeFile(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
}
