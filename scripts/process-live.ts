// Opt-in actual Ubuntu Electron + Android Debug + official Codex acceptance.
// Fresh: pnpm exec tsx scripts/process-live.ts --keep-fixture
// Recheck without model calls: pnpm exec tsx scripts/process-live.ts --reuse <fixture.json>
// A failed run retains only its own private fixture for repair/recheck. Successful
// runs delete that native thread unless --keep-fixture was explicitly supplied.
import { _electron as electron, chromium, expect, type Browser, type Cookie, type ElectronApplication, type Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as probeServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { Codex } from '../bridge/src/codex';
import { ProjectDirectories } from '../bridge/src/projects';
import { ReceiptStore } from '../bridge/src/receipts';
import { createServer } from '../bridge/src/server';
import { BridgeService } from '../bridge/src/service';
import { Themes } from '../bridge/src/themes';
import { ThreadPermissionStore } from '../bridge/src/thread-permissions';
import { TrustStore } from '../bridge/src/trust-store';
import type { BridgeEvent, Thread, ThreadItem, Turn } from '../packages/shared/protocol';
import { selectPermission } from './composer-controls';
import { sessionSnapshot } from './ui-state';

const args = process.argv.slice(2), reuseIndex = args.indexOf('--reuse');
const reusePath = reuseIndex >= 0 ? args[reuseIndex + 1] : undefined, keepFixture = args.includes('--keep-fixture');
assert.ok(reuseIndex < 0 || reusePath && !reusePath.startsWith('--'), '--reuse requires the fixture.json from an earlier run');
assert.ok(args.every((arg, index) => arg === '--keep-fixture' || arg === '--reuse' || index === reuseIndex + 1 && reuseIndex >= 0), 'Unknown argument');
const port = 17860, origin = `http://127.0.0.1:${port}`;
function productionStopped() {
  try { return execFileSync('systemctl', ['--user', 'is-active', 'oraculum-bridge.service'], { encoding: 'utf8' }).trim() === 'inactive'; }
  catch (error) { return String((error as { stdout?: unknown }).stdout).trim() === 'inactive'; }
}
assert.ok(productionStopped(), 'Installed production Bridge must already be stopped');
await new Promise<void>((resolve, reject) => {
  const probe = probeServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()));
});
const base = resolve('.local/evidence/phase4d4'), fixtureBase = join(base, 'fixtures');
await mkdir(fixtureBase, { recursive: true, mode: 0o700 });
const output = await mkdtemp(join(base, 'live-'));
// Other contract suites may rebuild dist while a real Turn is running. Serve
// one immutable test build so lazy Diff chunks stay paired with its index.
const webBuild = join(output, 'web-build'); await cp(resolve('apps/web/dist'), webBuild, { recursive: true });
type Fixture = { format: 'oraculum-phase4d4-live-v1'; cwd: string; threadId?: string; turnId?: string; items: ThreadItem[]; receivedOrder: string[]; turn?: Turn };
let root: string, fixtureDirectory: string, fixture: Fixture;
if (reusePath) {
  const file = await realpath(resolve(reusePath));
  assert.ok(file.startsWith(await realpath(fixtureBase) + sep) && file.endsWith('/fixture.json'), 'Only this runner\'s private fixtures may be reused');
  fixtureDirectory = dirname(file); fixture = JSON.parse(await readFile(file, 'utf8')) as Fixture;
  root = dirname(fixture.cwd);
  assert.equal(fixture.format, 'oraculum-phase4d4-live-v1'); assert.equal(fixture.cwd, join(root, 'Execution-Review'));
  assert.ok(root.startsWith(join(tmpdir(), 'oraculum-process-')) && dirname(root) === tmpdir(), 'Only this runner\'s isolated scratch project may be reused');
  assert.equal(await realpath(root), root, 'Scratch fixture must not be a symlink');
  assert.ok(fixture.threadId && fixture.turnId, 'Reuse requires an existing recorded native turn');
} else {
  fixtureDirectory = await mkdtemp(join(fixtureBase, 'run-'));
  // Stay outside the repository so its AGENTS.md does not turn the bounded
  // toy task into another project-development session.
  root = await mkdtemp(join(tmpdir(), 'oraculum-process-'));
  fixture = { format: 'oraculum-phase4d4-live-v1', cwd: join(root, 'Execution-Review'), items: [], receivedOrder: [] };
  await mkdir(fixture.cwd, { mode: 0o700 });
  await writeFile(join(fixture.cwd, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
  await writeFile(join(fixture.cwd, 'sum.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from './sum.mjs';\ntest('sum adds both numbers', () => assert.equal(sum(2, 3), 5));\n");
}
const cwd = fixture.cwd, fixturePath = join(fixtureDirectory, 'fixture.json');
const saveFixture = () => writeFile(fixturePath, JSON.stringify(fixture, null, 2), { mode: 0o600 });
await saveFixture();
const configPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
const hashConfig = async () => createHash('sha256').update(await readFile(configPath)).digest('hex');
const baselineConfig = await hashConfig();
const trust = new TrustStore(join(root, 'state')), themes = new Themes({ source: resolve('themes'), installed: join(root, 'themes') });
const projects = new ProjectDirectories(root, cwd, trust.db); await projects.register(cwd);
const codex = new Codex(cwd);
const service = new BridgeService(codex, cwd, new ReceiptStore(trust.db), projects, new ThreadPermissionStore(trust.db));
const checks: string[] = [], errors: string[] = [], cleanupErrors: string[] = [], limitations: string[] = [];
const evidence: Record<string, unknown> = {
  date: new Date().toISOString(), realElectron: true, realAndroid: true, simulated: false, reused: !!reusePath,
  transport: 'Ubuntu Electron + Android Debug WebView over USB ADB reverse; authenticated source Bridge; official Codex',
  nativeVersion: codex.version, gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  buildIndexSha256: createHash('sha256').update(await readFile(join(webBuild, 'index.html'))).digest('hex'),
  checks, errors, cleanupErrors, limitations,
};
const prompt = `这是 Oraculum 执行过程的隔离验收，只在当前目录工作，严格按顺序完成一次：
1. 先发一条简短中文进度说明。运行命令读取 sum.mjs 和 sum.test.mjs，并在同一次命令末尾 sleep 8；这个无副作用等待用于截图真实进行中状态。
2. 用 apply_patch 只把 sum.mjs 的减法改成加法，不修改测试；随后运行 node --test sum.test.mjs。
3. 如果当前配置提供 Notion MCP，调用一次只读 fetch，读取 https://app.notion.com/p/3ff5421e690b81bdae14c0675f0b3acf，仅在回答中报告页面标题；没有可用工具则如实说明，不重试，不写外部服务。
4. 最后以“## 过程清晰，结果可读”为标题，用三条简短中文列表报告改动、测试与 MCP 实际结果。
不要安装、不读写其他本地文件、不改配置、不用 Skills/网页/子代理、不提交、不额外开展工作。不要宣称界面验收已通过。`;
let threadId = fixture.threadId, turnId = fixture.turnId, starts = 0, turnStarts = 0;
let completed = !!reusePath && fixture.turn !== undefined && fixture.turn.status !== 'inProgress';
const items = new Map(fixture.items.map(item => [item.id, item])), receivedOrder = fixture.receivedOrder;
const nativeRequest = codex.request.bind(codex);
codex.request = async <T>(method: string, params: object): Promise<T> => {
  if (method === 'thread/start') { assert.ok(!reusePath, 'Reuse must never create a thread'); assert.equal(starts++, 0); assert.equal((params as { cwd?: string }).cwd, cwd); }
  if (method === 'turn/start') {
    assert.ok(!reusePath, 'Reuse must never call the model'); assert.equal(turnStarts++, 0, 'Exactly one bounded model turn');
    const p = params as { threadId: string; input: { type: string; text?: string }[] };
    assert.equal(p.threadId, threadId); assert.deepEqual(p.input.map(item => ({ type: item.type, text: item.text })), [{ type: 'text', text: prompt }]);
  }
  const result = await nativeRequest<T>(method, params);
  if (method === 'thread/start') { threadId = (result as { thread: Thread }).thread.id; fixture.threadId = threadId; await saveFixture(); }
  if (method === 'turn/start') { turnId = (result as { turn: Turn }).turn.id; fixture.turnId = turnId; await saveFixture(); }
  return result;
};
codex.on('message', message => {
  if (message.params?.threadId !== threadId) return;
  if (message.method === 'turn/started' || message.method === 'turn/completed') {
    const turn = message.params.turn as Turn; fixture.turn = turn; turnId = turn.id; fixture.turnId = turn.id;
    if (message.method === 'turn/completed') { completed = true; evidence.turnStatus = turn.status; }
  }
  if (message.method === 'item/started' || message.method === 'item/completed') {
    const item = message.params.item as ThreadItem;
    if (!receivedOrder.includes(item.id)) receivedOrder.push(item.id);
    items.set(item.id, item);
  }
});
service.on('event', (event: BridgeEvent) => {
  if (event.type === 'approval') errors.push(`Unexpected approval ${event.request.method}; this runner never approves an unreviewed request`);
});
const adbArgs = process.env.ORACULUM_ADB_SERIAL ? ['-s', process.env.ORACULUM_ADB_SERIAL] : ['-d'];
const adb = (...parts: string[]) => execFileSync('adb', [...adbArgs, ...parts], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim();
let server: Awaited<ReturnType<typeof createServer>> | undefined, app: ElectronApplication | undefined, android: Browser | undefined;
let desktop: Page | undefined, phone: Page | undefined, forwarded: string | undefined, previousReverse: string | undefined, reverseChanged = false;
let savedCookies: Cookie[] | undefined, savedStorage: { local: Record<string, string>; session: Record<string, string> } | undefined;
const ready = (page: Page) => expect(page.locator('.connection-status')).toContainText('状态已查询', { timeout: 30_000 });
const processGroup = (page: Page) => page.locator(`.turn-process[data-turn-id=${JSON.stringify(turnId)}]`);
const itemLocator = (page: Page, id: string) => page.locator(`[data-item-id=${JSON.stringify(id)}]`);
async function pair(page: Page, label: string) {
  await expect(page.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible();
  await page.getByLabel('设备名称', { exact: true }).fill(label); await page.getByLabel('配对码', { exact: true }).fill(trust.createPairing().code);
  await page.getByRole('button', { name: '配对并连接', exact: true }).click(); await ready(page);
}
async function nav(page: Page) {
  if (await page.getByRole('button', { name: '打开导航', exact: true }).isVisible() && !await page.locator('.app-shell').evaluate(el => el.classList.contains('drawer-open'))) await page.getByRole('button', { name: '打开导航', exact: true }).click();
}
async function selectThread(page: Page) {
  if (await page.locator('.conversation').getAttribute('data-thread-id') === threadId) return;
  // Mobile deliberately has no desktop list-refresh button. This isolated cwd
  // has one thread; a reload uses the same native list/default selection path.
  await expect.poll(async () => {
    const list = await service.dispatch('thread/list', { cwd }) as { data: Thread[] };
    return list.data.some(thread => thread.id === threadId);
  }, { timeout: 30_000 }).toBe(true);
  await page.reload(); await ready(page);
  await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', threadId!);
}
async function hideIme() { if (/\bmInputShown=true\b/.test(adb('shell', 'dumpsys', 'input_method'))) adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); }
async function toggleProcess(page: Page) {
  const toggle = processGroup(page).locator('.process-toggle');
  if (page !== phone) { await toggle.click(); return; }
  await hideIme(); await toggle.scrollIntoViewIfNeeded();
  const box = await toggle.boundingBox(), size = adb('shell', 'wm', 'size').match(/(\d+)x(\d+)/); assert.ok(box && size);
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const ratio = +size[1] / viewport.width;
  const topInset = Math.max(0, +size[2] - viewport.height * ratio) / 2;
  adb('shell', 'input', 'tap', String(Math.round((box.x + box.width / 2) * ratio)), String(Math.round((box.y + box.height / 2) * ratio + topInset)));
}
async function capture(page: Page, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.screenshot({ path: join(output, name + '.png'), animations: 'disabled', scale: 'css' });
  if (page === phone) await writeFile(join(output, name + '-device.png'), execFileSync('adb', [...adbArgs, 'exec-out', 'screencap', '-p'], { maxBuffer: 16 * 1024 * 1024 }));
}
async function switchTheme(page: Page, id: string) {
  await nav(page); await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('当前主题')).toBeEnabled(); await page.getByLabel('当前主题').selectOption(id);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme-id', id); await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  if (await page.locator('.app-shell').evaluate(el => el.classList.contains('drawer-open'))) await page.getByRole('button', { name: '折叠导航', exact: true }).click();
}
let finalId: string | undefined, step = 'setup';
async function finalVisible(page: Page) {
  assert.ok(finalId); const final = itemLocator(page, finalId);
  await expect(final).toBeVisible(); await expect(final).toContainText('过程清晰，结果可读');
  assert.equal(await final.evaluate(el => el.closest('.process-records') === null), true, 'Final answer must live outside the collapsible process');
}
async function collapsed(page: Page) {
  await expect(processGroup(page).locator('.process-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(processGroup(page).locator('.process-toggle')).toContainText('已完成');
  const timing = fixture.turn;
  if (timing?.durationMs != null || timing?.startedAt != null && timing.completedAt != null) await expect(processGroup(page).locator('.process-toggle')).toContainText('用时');
  await expect.poll(() => processGroup(page).locator('.process-records').evaluateAll(nodes => nodes.length > 0 && nodes.every(node => (node as HTMLElement).hidden))).toBe(true);
  await finalVisible(page);
}
try {
  await codex.initialize();
  const installedThemes = new Set((await themes.catalog()).installed.map(entry => entry.manifest?.id));
  for (const id of ['test-violet', 'hong-kong-rain', 'minimal-light']) if (!installedThemes.has(id)) await themes.install(id);
  if (reusePath) {
    const existing = await codex.request<{ thread: Thread }>('thread/read', { threadId });
    assert.equal(await realpath(existing.thread.cwd), await realpath(cwd), 'Reuse thread must belong to this exact fixture');
    const owned = await service.dispatch('thread/list', { cwd }) as { data: Thread[] };
    assert.ok(owned.data.some(thread => thread.id === threadId), 'Reuse must first register native ownership through the allowed project list');
    const snapshot = await service.dispatch('bridge/subscribe', { threadId }) as Awaited<ReturnType<typeof sessionSnapshot>>;
    const turn = snapshot.thread.turns.find(value => value.id === turnId); assert.ok(turn, 'Recorded turn must still exist');
    assert.equal(turn.status, 'completed', 'Reuse only checks completed native history; it never starts or continues a model turn');
    fixture.turn = turn; completed = true; evidence.turnStatus = turn.status;
    for (const item of turn.items) if (!items.has(item.id)) items.set(item.id, item);
    limitations.push('Reuse rechecks stored native history; no new running-state screenshot or live timer claim is made.');
  }
  server = await createServer(service, port, webBuild, { trust, themes }); await server.listen({ host: '127.0.0.1', port });
  const require = createRequire(resolve('apps/desktop/package.json'));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron-profile') });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  await expect.poll(() => app!.windows().some(page => page.url().startsWith(origin))).toBe(true);
  desktop = app.windows().find(page => page.url().startsWith(origin))!; desktop.on('pageerror', error => errors.push(error.message)); await pair(desktop, '4D.4 Electron');
  previousReverse = adb('reverse', '--list').split('\n').find(line => line.split(/\s+/)[1] === `tcp:${port}`)?.split(/\s+/)[2];
  adb('reverse', `tcp:${port}`, `tcp:${port}`); reverseChanged = true; adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'); adb('shell', 'am', 'start', '-n', 'dev.oraculum.poc/.MainActivity');
  const pid = adb('shell', 'pidof', 'dev.oraculum.poc'); assert.match(pid, /^\d+$/);
  forwarded = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
  await expect.poll(async () => { try { return (await fetch(`http://127.0.0.1:${forwarded}/json/list`).then(response => response.json())).length; } catch { return 0; } }, { timeout: 20_000 }).toBeGreaterThan(0);
  android = await chromium.connectOverCDP(`http://127.0.0.1:${forwarded}`, { noDefaults: true });
  phone = android.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith(origin) || page.url().startsWith('chrome-error://'));
  assert.ok(phone, 'Debug WebView must already use the local USB endpoint'); phone.on('pageerror', error => errors.push(error.message));
  savedCookies = (await phone.context().cookies([origin])).filter(cookie => cookie.name === 'oraculum_local' && cookie.path === '/');
  // Quiesce app/pagehide handlers before private backup, and restore on this
  // inert same-origin endpoint before backgrounding the real device again.
  await phone.goto(origin + '/auth/session'); savedStorage = await phone.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  await writeFile(join(output, 'private-device-backup.json'), JSON.stringify({ cookies: savedCookies, storage: savedStorage }), { mode: 0o600 });
  await phone.context().clearCookies({ name: 'oraculum_local', domain: '127.0.0.1', path: '/' }); await phone.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await phone.goto(origin); await pair(phone, '4D.4 Android Debug'); await hideIme();
  evidence.android = { manufacturer: adb('shell', 'getprop', 'ro.product.manufacturer'), model: adb('shell', 'getprop', 'ro.product.model'), release: adb('shell', 'getprop', 'ro.build.version.release'), viewport: await phone.evaluate(() => ({ width: innerWidth, height: innerHeight })) };
  if (!reusePath) {
    step = 'one tool-rich native turn'; await desktop.locator('.new-session').click();
    await expect.poll(() => threadId, { timeout: 20_000 }).toBeTruthy(); await ready(desktop); await selectPermission(desktop, 'auto');
    await desktop.getByLabel('消息', { exact: true }).fill(prompt); await desktop.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => turnId, { timeout: 20_000 }).toBeTruthy();
    await selectThread(phone); await hideIme();
    await expect.poll(() => [...items.values()].some(item => item.type === 'commandExecution' && item.status === 'inProgress'), { timeout: 180_000 }).toBe(true);
    for (const page of [desktop, phone]) {
      await expect.poll(() => processGroup(page).locator('.process-records').evaluateAll(nodes => nodes.length > 0 && nodes.every(node => !(node as HTMLElement).hidden))).toBe(true);
      await expect(processGroup(page).locator('.process-status')).toContainText(/\d+\s*秒/);
      await expect(page.getByRole('button', { name: '停止', exact: true })).toBeEnabled();
      assert.equal(completed, false, 'Running-state checks precede turn completion');
    }
    const beforeTimer = await processGroup(desktop).locator('.process-status').innerText();
    await expect.poll(() => processGroup(desktop!).locator('.process-status').innerText(), { timeout: 6000 }).not.toBe(beforeTimer);
    await processGroup(desktop).locator('.process-status').scrollIntoViewIfNeeded(); await capture(desktop, 'electron-running');
    evidence.runningCapture = { actualNativeTurn: true, timerAdvanced: true, includesDeliberateEightSecondCommandWait: true };
    checks.push('Both actual clients show a live native command, visible process records, advancing elapsed time and enabled Stop');
    step = 'native turn completion';
    await expect.poll(() => { assert.deepEqual(errors, []); return completed; }, { timeout: 240_000, intervals: [1000] }).toBe(true);
    assert.equal(evidence.turnStatus, 'completed');
  } else { await selectThread(desktop); await selectThread(phone); }
  fixture.items = [...items.values()]; await saveFixture();
  const observed = [...items.values()];
  const final = observed.find(item => item.type === 'agentMessage' && item.phase === 'final_answer' && item.text.includes('过程清晰，结果可读'))
    ?? observed.find(item => item.type === 'agentMessage' && item.text.includes('过程清晰，结果可读'));
  assert.ok(final && final.type === 'agentMessage', 'Native final answer must be present'); finalId = final.id;
  const commands = observed.filter((item): item is Extract<ThreadItem, { type: 'commandExecution' }> => item.type === 'commandExecution');
  const command = commands.find(item => item.command.includes('node --test') && item.exitCode === 0); assert.ok(command, 'Actual test command completed successfully');
  const files = observed.filter((item): item is Extract<ThreadItem, { type: 'fileChange' }> => item.type === 'fileChange');
  assert.ok(files.some(item => item.status === 'completed' && item.changes.some(change => change.path.endsWith('sum.mjs') && change.diff.includes('a + b'))), 'Actual native file-change Diff');
  const commentary = observed.filter(item => item.type === 'agentMessage' && item.phase === 'commentary');
  assert.ok(commentary.length, 'Official commentary phase must be exercised');
  const mcp = observed.filter(item => item.type === 'mcpToolCall');
  if (!mcp.length) limitations.push('The actual Turn provided no mcpToolCall Item; MCP GUI details need the separate deterministic contract.');
  evidence.native = { phases: observed.filter(item => item.type === 'agentMessage').map(item => ({ id: item.id, phase: item.phase })),
    itemTypes: observed.map(item => ({ id: item.id, type: item.type })), commandCount: commands.length,
    fileCount: new Set(files.flatMap(item => item.changes.map(change => change.path))).size,
    mcpCount: mcp.length, timing: fixture.turn && { startedAt: fixture.turn.startedAt, completedAt: fixture.turn.completedAt, durationMs: fixture.turn.durationMs } };
  evidence.independentTest = execFileSync(process.execPath, ['--test', 'sum.test.mjs'], { cwd, encoding: 'utf8' });
  step = 'automatic completion collapse';
  for (const page of [desktop, phone]) await collapsed(page);
  checks.push(reusePath ? 'Completed native history is folded on both clients; its real final answer remains outside the fold'
    : 'Completed Turn automatically folds process records on both clients; real final answer remains outside the fold');
  await processGroup(phone).locator('.process-toggle').evaluate(el => el.scrollIntoView({ block: 'start' })); await capture(phone, 'android-collapsed');
  step = 'expand real native records';
  for (const page of [desktop, phone]) {
    await toggleProcess(page); await expect(processGroup(page).locator('.process-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => processGroup(page).locator('.process-records').evaluateAll(nodes => nodes.length > 0 && nodes.every(node => !(node as HTMLElement).hidden))).toBe(true); await finalVisible(page);
    const order = await processGroup(page).locator('.process-records[data-item-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-item-id')!));
    const knownOrder = order.filter(id => receivedOrder.includes(id));
    assert.deepEqual(knownOrder, receivedOrder.filter(id => knownOrder.includes(id)), 'Expanded records retain actual native first-received order for observed Items');
    const details = itemLocator(page, command.id).locator('.command'); await details.locator('summary').click();
    await expect(details.getByLabel('命令输出')).toContainText('pass 1'); await expect(details).toContainText('退出码 0');
    await page.getByRole('button', { name: '查看 Diff', exact: true }).first().click(); await expect(page.locator('.cm-content')).toContainText('a + b');
    assert.notEqual(await page.locator('.cm-content').getAttribute('contenteditable'), 'true'); await page.getByRole('button', { name: '关闭面板', exact: true }).click();
    if (page === phone) {
      await processGroup(page).locator('.process-toggle').evaluate(el => el.scrollIntoView({ block: 'start' })); await capture(page, 'android-expanded');
      await details.evaluate(el => el.scrollIntoView({ block: 'center' })); await capture(page, 'android-output');
    }
    await toggleProcess(page); await collapsed(page);
  }
  checks.push('Both clients expand real commentary/tools in received order, display actual test output/exit code and read-only Diff, and collapse again without hiding the final; Android toggle uses actual ADB touch taps');
  step = 'refresh and reconnect';
  for (const page of [desktop, phone]) { await page.reload(); await ready(page); await collapsed(page); }
  await server.close();
  for (const page of [desktop, phone]) await expect(page.locator('.disconnect-banner')).toContainText('主机任务不会因此停止');
  server = await createServer(service, port, webBuild, { trust, themes }); await server.listen({ host: '127.0.0.1', port });
  for (const page of [desktop, phone]) {
    await page.getByRole('button', { name: '重新连接', exact: true }).click(); await ready(page); await collapsed(page);
  }
  assert.equal(turnStarts, reusePath ? 0 : 1);
  checks.push('Reload and source Bridge WebSocket reconnect preserve completed status, collapsed process and readable final; no additional turn');
  step = 'themes and mobile geometry';
  for (const id of ['test-violet', 'hong-kong-rain', 'minimal-light', 'oracle-eye']) for (const page of [desktop, phone]) {
    await switchTheme(page, id); await collapsed(page);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal document overflow');
    await expect(page.locator('.history-warning, .session-details, .events, [data-testid="send-receipt"]')).toHaveCount(0);
    // The real Notion MCP result quotes historical project requirements. Its
    // hidden raw content is not a UI warning and must not be rewritten by QA.
    assert.doesNotMatch(await page.locator('.conversation-content').innerText(), /部分历史未能恢复|会话信息与原生事件|最近发送回执|原生事件 · 最近/);
  }
  checks.push('Four shared themes retain process toggle, readable final and Android width without diagnostic/history-warning UI');
  assert.deepEqual(errors, []); evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed'; evidence.step = step; evidence.error = String(error); process.exitCode = 1;
  if (desktop) await capture(desktop, 'failure-electron').catch(() => {}); if (phone && savedStorage) await capture(phone, 'failure-android').catch(() => {});
  // A failed UI assertion should not discard a useful bounded native result.
  // Let the already authorized turn finish, then rerun UI checks with --reuse.
  if (turnStarts > 0 && threadId && turnId && !completed && !errors.length) {
    console.log('UI assertion failed; retaining the one in-flight native turn for a model-free recheck');
    await expect.poll(() => completed || errors.length > 0, { timeout: 240_000, intervals: [1000] }).toBe(true).catch(() => {});
  }
} finally {
  const clean = async (label: string, run: () => unknown | Promise<unknown>) => { try { await run(); } catch (error) { cleanupErrors.push(`${label}: ${String(error)}`); evidence.result = 'failed'; process.exitCode = 1; } };
  await clean('unfinished test turn', async () => {
    if (threadId && turnId && !completed) { await codex.request('turn/interrupt', { threadId, turnId }); await expect.poll(() => completed, { timeout: 20_000 }).toBe(true); }
  });
  fixture.items = [...items.values()]; fixture.threadId = threadId; fixture.turnId = turnId; await clean('save native fixture', saveFixture);
  if (!keepFixture && evidence.result === 'passed') await clean('test native thread', async () => {
    if (!threadId) return;
    await service.dispatch('thread/delete', { threadId, confirm: true }); await assert.rejects(codex.request('thread/read', { threadId }), /not loaded|not found|no rollout/i); evidence.testThreadDeleted = true;
  });
  await clean('Electron', () => app?.close());
  if (phone && savedStorage) await clean('Android storage', async () => {
    await phone!.goto(origin + '/auth/session'); await phone!.evaluate(saved => { localStorage.clear(); sessionStorage.clear(); for (const [key, value] of Object.entries(saved.local)) localStorage.setItem(key, value); for (const [key, value] of Object.entries(saved.session)) sessionStorage.setItem(key, value); }, savedStorage!);
    assert.deepEqual(await phone!.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })), savedStorage); evidence.storageRestored = true;
  });
  if (phone && savedCookies) await clean('Android cookies', async () => {
    await phone!.context().clearCookies({ name: 'oraculum_local', domain: '127.0.0.1', path: '/' }); await phone!.context().addCookies(savedCookies!);
    assert.deepEqual((await phone!.context().cookies([origin])).filter(cookie => cookie.name === 'oraculum_local' && cookie.path === '/'), savedCookies); evidence.cookiesRestored = true;
  });
  if (reverseChanged) await clean('Android background', () => adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'));
  if (phone && savedStorage) await clean('Android storage after background', async () => { assert.deepEqual(await phone!.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })), savedStorage); });
  await clean('CDP', () => android?.close()); await clean('Bridge', () => server?.close()); await clean('Codex', () => codex.close()); await clean('trust', () => trust.close());
  if (reverseChanged) await clean('ADB reverse', () => previousReverse ? adb('reverse', `tcp:${port}`, previousReverse) : adb('reverse', '--remove', `tcp:${port}`));
  if (forwarded) await clean('ADB forward', () => adb('forward', '--remove', `tcp:${forwarded}`));
  await clean('config unchanged', async () => { evidence.globalConfigUnchanged = await hashConfig() === baselineConfig; assert.equal(evidence.globalConfigUnchanged, true); });
  evidence.productionBridgeStopped = productionStopped(); if (!evidence.productionBridgeStopped) { cleanupErrors.push('Production Bridge is not stopped'); evidence.result = 'failed'; process.exitCode = 1; }
  if (!cleanupErrors.length) {
    await rm(join(output, 'private-device-backup.json'), { force: true });
    if (evidence.testThreadDeleted) await clean('isolated fixture', async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      await rm(fixtureDirectory, { recursive: true, force: true });
    });
  }
  if (!evidence.testThreadDeleted) evidence.reusableFixture = fixturePath;
  evidence.turnsStarted = turnStarts; await writeFile(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ output, ...evidence }));
}
