// Opt-in real Electron + USB Android acceptance against the normal Bridge entry.
// Only read-only pwd and exact harmless printf approvals in TWO EXISTING folders.
// Run with ORACULUM_EXISTING_PROJECTS='["/absolute/project-a","/absolute/project-b"]'
// and ORACULUM_ANDROID_CDP=http://127.0.0.1:<adb-forwarded-Oraculum-port>.
import { selectedThreadId, sessionSnapshot } from './ui-state';
import { _electron as electron, chromium, expect, type ElectronApplication, type Browser, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, realpath, stat, readdir, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, relative } from 'node:path';
import { TrustStore } from '../bridge/src/trust-store';
import type { LocalConfig, Model, Snapshot, Thread, WireMessage } from '../packages/shared/protocol';
const targets: string[] = JSON.parse(process.env.ORACULUM_EXISTING_PROJECTS ?? '[]');
const hostRoot = join(homedir(), 'Projects');
if (targets.length !== 2 || targets[0] === targets[1]) throw new Error('Provide two distinct existing project paths');
for (const target of targets) {
  if (!target.startsWith(hostRoot + '/') || await realpath(target) !== target || !(await stat(target)).isDirectory()) throw new Error('Targets must be existing canonical directories under ~/Projects');
}
const endpoint = new URL(process.env.ORACULUM_ANDROID_CDP ?? 'about:blank');
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password) throw new Error('Use the local forwarded Oraculum WebView endpoint');
const origin = 'http://127.0.0.1:17860';
try { await fetch(origin + '/health'); throw new Error('Port 17860 is already in use; do not replace an existing service'); }
catch (error) { if (!(error instanceof TypeError)) throw error; }
const output = resolve('.local/evidence/projects', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true, mode: 0o700 });
const workspaceRoot = join(homedir(), '.cache/oraculum/workspaces');
await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
const defaultCwd = await mkdtemp(join(workspaceRoot, 'projects-acceptance-'));
const stateDir = join(output, 'state');
const trust = new TrustStore(stateDir);
const configPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
const configHash = () => readFile(configPath).then(bytes => createHash('sha256').update(bytes).digest('hex'));
// Metadata only; do not read project secrets/content. Ignore this test's own artifacts.
async function fingerprint(root: string) {
  const hash = createHash('sha256'); let count = 0;
  async function walk(path: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name), rel = relative(root, full);
      if (root === resolve('.') && (['.git', '.local', 'node_modules'].includes(entry.name) || /(^|\/)(dist|build|\.gradle|\.kotlin)(\/|$)/.test(rel))) continue;
      const info = await lstat(full, { bigint: true });
      hash.update(`${rel}\0${info.mode}\0${info.size}\0${info.mtimeNs}\0${info.ino}\n`); count++;
      if (entry.isDirectory()) await walk(full);
    }
  }
  await walk(root);
  const info = await stat(root, { bigint: true });
  return { digest: hash.digest('hex'), count, dev: String(info.dev), ino: String(info.ino) };
}
const before = await Promise.all(targets.map(fingerprint));
const baselineConfig = await configHash();
const evidence: Record<string, any> = { real: true, simulated: false, date: new Date().toISOString(), output, targets,
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  buildIndexSha256: createHash('sha256').update(await readFile('apps/web/dist/index.html')).digest('hex'),
  transport: 'actual HONOR Android WebView via USB ADB reverse + actual Ubuntu Electron; local authenticated normal Bridge, no VPS changes',
  threads: [], completed: [], commands: [], approvals: [], checks: [], screenshots: [] };
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
for (const key of ['ELECTRON_RUN_AS_NODE', 'ORACULUM_REMOTE_ORIGIN', 'ORACULUM_REMOTE_BASE_PATH']) delete env[key];
Object.assign(env, { ORACULUM_STATE_DIR: stateDir, ORACULUM_WORKSPACE: defaultCwd, ORACULUM_PORT: '17860', ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron-profile') });
let bridge: ChildProcess | undefined, app: ElectronApplication | undefined, android: Browser | undefined;
let desktop: Page | undefined, phone: Page | undefined;
let savedPhoneCookies: import('@playwright/test').Cookie[] | undefined;
let savedPhoneStorage: { local: Record<string, string>; session: Record<string, string> } | undefined;
let model = '', effort = '', step = 'start';
const testIds = new Set<string>(), errors: string[] = [];
const adb = (...args: string[]) => execFileSync('adb', ['-d', ...args], { encoding: 'utf8' }).trim();
const previousReverse = adb('reverse', '--list').split('\n').find(line => line.split(/\s+/)[1] === 'tcp:17860')?.split(/\s+/)[2];
async function startBridge() {
  bridge = spawn(process.execPath, ['--import', 'tsx', 'bridge/src/main.ts'], { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  bridge.stdout!.on('data', () => {}); bridge.stderr!.on('data', () => {});
  await expect.poll(async () => { try { return (await fetch(origin + '/health')).ok; } catch { return false; } }, { timeout: 30_000 }).toBe(true);
}
async function stopBridge() {
  if (!bridge || bridge.exitCode !== null) return;
  const stopped = new Promise<void>(resolve => bridge!.once('exit', () => resolve()));
  bridge.kill('SIGTERM'); await stopped;
}
function observe(page: Page) {
  page.on('pageerror', e => errors.push(e.message));
  page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    const event = JSON.parse(String(payload));
    if (event.type !== 'event' || !testIds.has(event.event.params?.threadId)) return;
    const { method, params } = event.event;
    if (method === 'turn/completed' && !evidence.completed.some((t: any) => t.id === params.turn.id)) evidence.completed.push({ threadId: params.threadId, id: params.turn.id, status: params.turn.status });
    if (method === 'item/completed' && params.item.type === 'commandExecution' && !evidence.commands.some((c: any) => c.id === params.item.id)) {
      evidence.commands.push({ threadId: params.threadId, turnId: params.turnId, id: params.item.id, command: params.item.command, cwd: params.item.cwd, exitCode: params.item.exitCode, output: params.item.aggregatedOutput });
    }
  }));
}
async function rpc<T>(page: Page, method: string, params: object): Promise<T> {
  const response = await page.evaluate(({ method, params }) => new Promise<WireMessage>((resolve, reject) => {
    const socket = new WebSocket(new URL('/ws', location.href).href.replace(/^http/, 'ws'));
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { socket.close(); reject(new Error('Test query timeout')); }, 65000);
    socket.onopen = () => socket.send(JSON.stringify({ id, method, params }));
    socket.onerror = () => { clearTimeout(timer); reject(new Error('Test query socket failed')); };
    socket.onmessage = event => { const response = JSON.parse(event.data); if (response.id === id) { clearTimeout(timer); socket.close(); resolve(response); } };
  }), { method, params });
  if (response.error) throw new Error(response.error.message);
  return response.result as T;
}
const ready = (page: Page) => expect(page.getByRole('status', { includeHidden: true })).toContainText('状态已查询', { timeout: 45_000 });
async function pair(page: Page, label: string) {
  await expect(page.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible();
  await page.getByLabel('设备名称', { exact: true }).fill(label);
  await page.getByLabel('配对码', { exact: true }).fill(trust.createPairing().code);
  await page.getByRole('button', { name: '配对并连接', exact: true }).click();
  await ready(page);
}
async function navigation(page: Page) {
  if (!await page.getByLabel('项目目录', { exact: true }).isVisible()) await page.getByRole('button', { name: '打开导航', exact: true }).click();
}
async function screenshot(page: Page, name: string) {
  if (page === phone) adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  await page.screenshot({ path: join(output, name + '.png'), animations: 'disabled' });
  if (page === phone) await writeFile(join(output, name + '-device.png'), execFileSync('adb', ['-d', 'exec-out', 'screencap', '-p']));
  evidence.screenshots.push(name);
}
async function register(page: Page, cwd: string, name: string) {
  await navigation(page);
  await page.getByRole('button', { name: '浏览主机文件夹 / 添加项目', exact: true }).click();
  await expect(page.getByTestId('browsed-directory')).toHaveText(hostRoot);
  await screenshot(page, name + '-browse');
  await page.getByRole('button', { name: cwd.slice(cwd.lastIndexOf('/') + 1), exact: true }).click();
  await expect(page.getByTestId('browsed-directory')).toHaveText(cwd);
  await screenshot(page, name + '-folder');
  await page.getByRole('button', { name: '添加当前文件夹为项目', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 45_000 });
  await ready(page); await navigation(page);
  await expect(page.getByLabel('项目目录', { exact: true })).toHaveValue(cwd);
  await page.getByLabel('模型', { exact: true }).selectOption(model);
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await ready(page);
  await expect(page.locator('.conversation')).not.toHaveAttribute('data-thread-id', '', { timeout: 30_000 });
  const id = (await selectedThreadId(page))!;
  expect(id).not.toBe(''); testIds.add(id);
  const snapshot = await rpc<Snapshot>(page, 'bridge/subscribe', { threadId: id });
  expect(snapshot.thread.cwd).toBe(cwd);
  evidence.threads.push({ id, cwd, registeredFrom: name });
  return id;
}
async function select(page: Page, cwd: string, threadId: string) {
  await navigation(page); await page.getByLabel('项目目录', { exact: true }).selectOption(cwd); await ready(page);
  if (await selectedThreadId(page) !== threadId) {
    await navigation(page); await page.locator(`nav[aria-label="原生会话"] button[data-thread-id="${threadId}"]`).click(); await ready(page);
  }
  await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', threadId);
  if (page === phone && await page.getByRole('button', { name: '关闭导航遮罩', exact: true }).isVisible()) await page.getByRole('button', { name: '折叠导航', exact: true }).click();
}
async function send(page: Page, marker: string, approvals = false) {
  await page.getByLabel('模型', { exact: true }).selectOption(model);
  await page.getByLabel('思考强度', { exact: true }).selectOption(effort);
  await page.getByLabel('消息', { exact: true }).fill([
    '这是已获用户授权的 Oraculum 只读工作目录验收，不是项目开发。只执行准确的 shell 命令 `pwd` 来核对本会话真实 cwd。',
    '不要读取、创建、编辑、移动或删除任何项目文件；不要运行仓库命令、Git、Skills、MCP、web、子代理，也不要读取任何凭据或配置。',
    approvals ? '随后按顺序分别请求两个无副作用的 shell 审批，sandbox_permissions=require_escalated：第一条准确为 `printf ORACULUM_PROJECT_ALLOW`，justification="Oraculum harmless allow test"；第二条准确为 `printf ORACULUM_PROJECT_DECLINE`，justification="Oraculum harmless decline test"。第二条会被拒绝，不要重试或绕过。' : '',
    `最后以 Markdown 标题 \`## ${marker}\` 加一行实际 pwd 结果结束。不要做其他工作。`,
  ].join('\n'));
  await page.getByRole('button', { name: '发送', exact: true }).click();
}
async function finish(page: Page, marker: string) {
  await expect(page.getByRole('heading', { name: marker, exact: true })).toBeVisible({ timeout: 180_000 });
  await expect(page.locator('.conversation')).toHaveAttribute('data-last-turn-status', 'completed', { timeout: 30_000 });
  await expect.poll(async () => (await sessionSnapshot(page)).receipts?.[0]?.status, { timeout: 30_000 }).toBe('completed');
}
try {
  await startBridge(); adb('reverse', 'tcp:17860', 'tcp:17860');
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  android = await chromium.connectOverCDP(endpoint.href, { noDefaults: true });
  phone = android.contexts()[0]?.pages().find(p => p.url() === origin + '/');
  if (!phone) throw new Error('Expected actual Oraculum WebView');
  savedPhoneCookies = await phone.context().cookies([origin]);
  savedPhoneStorage = await phone.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  observe(phone); await phone.reload(); await pair(phone, 'Project acceptance HONOR');
  const require = createRequire(resolve('apps/desktop/package.json'));
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  desktop = await app.firstWindow(); observe(desktop); await pair(desktop, 'Project acceptance Electron');
  evidence.electron = await app.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome }));
  evidence.android = { manufacturer: adb('shell', 'getprop', 'ro.product.manufacturer'), model: adb('shell', 'getprop', 'ro.product.model'), release: adb('shell', 'getprop', 'ro.build.version.release'), userAgent: await phone.evaluate(() => navigator.userAgent), viewport: await phone.evaluate(() => ({ width: innerWidth, height: innerHeight })) };
  const config = await rpc<LocalConfig>(desktop, 'bridge/config', {});
  const catalog: Model[] = []; let cursor: string | null = null;
  do { const page: { data: Model[]; nextCursor: string | null } = await rpc(desktop, 'model/list', { cursor }); catalog.push(...page.data); cursor = page.nextCursor; } while (cursor);
  model = process.env.ORACULUM_TEST_MODEL || catalog.find(m => m.model === 'gpt-6-luna')?.model || config.model || catalog[0].model;
  const choice = catalog.find(m => m.model === model)!; expect(choice).toBeTruthy();
  effort = choice.supportedReasoningEfforts.find(e => e.reasoningEffort === 'low')?.reasoningEffort || choice.supportedReasoningEfforts[0].reasoningEffort;
  evidence.model = { model, effort, source: 'native model/list' };
  step = 'desktop register and run'; console.log(step);
  const first = await register(desktop, targets[0], 'electron');
  await send(desktop, 'ORACULUM_PROJECT_DESKTOP_OK', true);
  for (const [marker, decision, button] of [['ORACULUM_PROJECT_ALLOW', 'accept', '允许本次'], ['ORACULUM_PROJECT_DECLINE', 'decline', '拒绝']] as const) {
    const approval = desktop.locator('.approval').filter({ hasText: marker });
    await expect(approval).toBeVisible({ timeout: 180_000 });
    const command = await approval.locator(':scope > pre').innerText();
    expect([`printf ${marker}`, `/bin/bash -lc 'printf ${marker}'`, `/bin/bash -lc "printf ${marker}"`, `/bin/sh -lc 'printf ${marker}'`]).toContain(command);
    await select(phone, targets[0], first);
    await expect(phone.locator('.approval').filter({ hasText: marker })).toBeVisible();
    await screenshot(phone, 'android-approval-' + decision);
    const actor = decision === 'accept' ? phone : desktop;
    await actor.locator('.approval').filter({ hasText: marker }).getByRole('button', { name: button, exact: true }).click();
    await expect(approval).toHaveCount(0);
    evidence.approvals.push({ command, decision, actor: decision === 'accept' ? 'HONOR' : 'Electron', threadId: first });
  }
  await finish(desktop, 'ORACULUM_PROJECT_DESKTOP_OK'); await screenshot(desktop, 'electron-completed');
  step = 'android register and run'; console.log(step);
  const second = await register(phone, targets[1], 'android');
  await send(phone, 'ORACULUM_PROJECT_ANDROID_OK'); await finish(phone, 'ORACULUM_PROJECT_ANDROID_OK');
  await screenshot(phone, 'android-completed');
  for (const page of [desktop, phone]) {
    for (const [cwd, id, other] of [[targets[0], first, second], [targets[1], second, first]]) {
      const listing = await rpc<{ data: Thread[] }>(page, 'thread/list', { cwd });
      expect(listing.data.every(t => t.cwd === cwd)).toBe(true); expect(listing.data.some(t => t.id === id)).toBe(true); expect(listing.data.some(t => t.id === other)).toBe(false);
    }
    await expect(rpc(page, 'thread/start', { cwd: '/etc' })).rejects.toThrow();
    await expect(rpc(page, 'bridge/browse', { path: hostRoot + '/../.ssh' })).rejects.toThrow();
    const snapshot = await rpc<Snapshot>(page, 'bridge/subscribe', { threadId: second, cwd: targets[0] });
    expect(snapshot.thread.cwd).toBe(targets[1]); expect(snapshot.receipts?.every(r => r.status === 'completed')).toBe(true);
  }
  evidence.checks.push('both GUI registrations, native cwd/command output, isolated thread lists, cross-device approval, receipts, forged cwd refusal');
  step = 'normal Bridge and App Server process restart'; console.log(step);
  await stopBridge(); await expect(desktop.getByText('连接已断开，主机任务不会因此停止。')).toBeVisible();
  await startBridge();
  for (const page of [desktop, phone]) { await page.reload(); await ready(page); }
  await expect(desktop.locator('.conversation')).toHaveAttribute('data-thread-id', first);
  await expect(phone.locator('.conversation')).toHaveAttribute('data-thread-id', second);
  await expect(desktop.getByRole('heading', { name: 'ORACULUM_PROJECT_DESKTOP_OK', exact: true })).toBeVisible();
  await expect(phone.getByRole('heading', { name: 'ORACULUM_PROJECT_ANDROID_OK', exact: true })).toBeVisible();
  expect(await rpc(desktop, 'bridge/projects', {})).toMatchObject({ projects: expect.arrayContaining(targets.map(cwd => expect.objectContaining({ cwd, available: true }))) });
  await screenshot(phone, 'android-restarted'); await screenshot(desktop, 'electron-restarted');
  step = 'cross-device resume and continue'; console.log(step);
  await select(phone, targets[0], first); await select(desktop, targets[1], second);
  await send(phone, 'ORACULUM_PROJECT_RESUMED_A'); await finish(phone, 'ORACULUM_PROJECT_RESUMED_A');
  await send(desktop, 'ORACULUM_PROJECT_RESUMED_B'); await finish(desktop, 'ORACULUM_PROJECT_RESUMED_B');
  await screenshot(phone, 'android-resumed-a'); await screenshot(desktop, 'electron-resumed-b');
  evidence.checks.push('normal Bridge child + native App Server restart; durable registry, paired credentials, remembered per-project sessions, native history and completed receipts; cross-device continued turns');
  for (const [cwd, id] of [[targets[0], first], [targets[1], second]]) {
    const snapshot = await rpc<Snapshot>(desktop, 'bridge/subscribe', { threadId: id });
    expect(snapshot.thread.cwd).toBe(cwd); expect(snapshot.receipts).toHaveLength(2);
    expect(snapshot.receipts!.every(receipt => receipt.status === 'completed')).toBe(true);
    expect(evidence.commands.some((command: any) => command.threadId === id && command.command.includes('pwd') && command.output?.trim() === cwd)).toBe(true);
  }
  expect(evidence.completed).toHaveLength(4);
  expect(evidence.completed.every((turn: any) => turn.status === 'completed')).toBe(true);
  expect(errors).toEqual([]);
  evidence.projectMetadataUnchanged = (await Promise.all(targets.map(fingerprint))).map((after, i) => JSON.stringify(after) === JSON.stringify(before[i]));
  expect(evidence.projectMetadataUnchanged).toEqual([true, true]);
  evidence.codexConfigUnchanged = await configHash() === baselineConfig; expect(evidence.codexConfigUnchanged).toBe(true);
  evidence.result = 'passed'; console.log(JSON.stringify({ result: evidence.result, output, threads: evidence.threads, turns: evidence.completed }));
} catch (error) {
  evidence.result = 'failed'; evidence.step = step; evidence.failure = step === 'start' ? (error instanceof Error ? error.name : 'Setup error') : error instanceof Error ? error.message : String(error);
  // Screenshots only after pairing, to avoid recording a one-time code.
  if (desktop && await desktop.getByRole('heading', { name: '信任此设备', exact: true }).count() === 0) await screenshot(desktop, 'failure-desktop').catch(() => {});
  if (phone && await phone.getByRole('heading', { name: '信任此设备', exact: true }).count() === 0) await screenshot(phone, 'failure-android').catch(() => {});
  console.error(`Failed at ${step}: ${evidence.failure}`); process.exitCode = 1;
} finally {
  await app?.close();
  if (phone && savedPhoneStorage) await phone.evaluate(saved => { localStorage.clear(); sessionStorage.clear(); for (const [key, value] of Object.entries(saved.local)) localStorage.setItem(key, value); for (const [key, value] of Object.entries(saved.session)) sessionStorage.setItem(key, value); }, savedPhoneStorage).catch(() => {});
  if (phone && savedPhoneCookies) { await phone.context().clearCookies({ domain: '127.0.0.1' }); await phone.context().addCookies(savedPhoneCookies); }
  await android?.close(); await stopBridge();
  for (const device of trust.list()) trust.revoke(device.id);
  trust.close();
  if (previousReverse) adb('reverse', 'tcp:17860', previousReverse); else adb('reverse', '--remove', 'tcp:17860');
  await writeFile(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
}
