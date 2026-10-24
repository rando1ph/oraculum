// Opt-in: one harmless official Codex turn, actual Electron and HONOR WebView.
// Additional new request shapes are explicitly simulated, after that real turn.
import { sessionSnapshot } from './ui-state';
import { _electron as electron, chromium, expect, type Browser, type Cookie, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Codex } from '../bridge/src/codex';
import { BridgeService } from '../bridge/src/service';
import { ProjectDirectories } from '../bridge/src/projects';
import { TrustStore } from '../bridge/src/trust-store';
import { ReceiptStore } from '../bridge/src/receipts';
import { createServer } from '../bridge/src/server';
import type { Approval, BridgeEvent, Model, WireMessage } from '../packages/shared/protocol';
import type { ThreadStartResponse } from '../.local/codex-protocol/v2/ThreadStartResponse';

const port = 17860, origin = `http://127.0.0.1:${port}`;
try { await fetch(origin + '/health'); throw new Error('Port 17860 is occupied; refusing to replace a service'); } catch (error) { if (!(error instanceof TypeError)) throw error; }
const output = resolve('.local/evidence/native-requests-live', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true, mode: 0o700 });
const root = join(homedir(), '.cache/oraculum/workspaces'); await mkdir(root, { recursive: true });
const cwd = await mkdtemp(join(root, 'native-requests-'));
const adbArgs = process.env.ORACULUM_ADB_SERIAL ? ['-s', process.env.ORACULUM_ADB_SERIAL] : ['-d'];
const adb = (...args: string[]) => execFileSync('adb', [...adbArgs, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim();
const previousReverse = adb('reverse', '--list').split('\n').find(line => line.split(/\s+/)[1] === `tcp:${port}`)?.split(/\s+/)[2];
const configPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
const hashConfig = async () => createHash('sha256').update(await readFile(configPath)).digest('hex');
const initialConfig = await hashConfig();
const trust = new TrustStore(join(output, 'state')), projects = new ProjectDirectories(root, cwd, trust.db); await projects.register(cwd);
const codex = new Codex(cwd), receipts = new ReceiptStore(trust.db), service = new BridgeService(codex, cwd, receipts, projects);
const evidence: Record<string, any> = { date: new Date().toISOString(), cwd, output, nativeTurns: [], checks: [], mockChecks: [], approvals: [], cleanupErrors: [],
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  testOnlySessionPolicy: { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
  transport: 'Ubuntu Electron + actual HONOR Android WebView over USB ADB reverse; authenticated isolated Bridge' };
const prompt = [
  '这是 Oraculum 原生审批端到端验收，当前目录是专用空测试目录。只执行下面两个无副作用命令。不要读写文件，不使用 MCP、Skills、Apps、web、子代理。',
  '依次请求两个独立 shell 审批，sandbox_permissions=require_escalated：准确命令 `printf ORACULUM_NATIVE_ALLOW`，justification="Oraculum native allow test"；随后准确命令 `printf ORACULUM_NATIVE_DECLINE`，justification="Oraculum native decline test"。第二个会拒绝，绝不重试或绕过。',
  '最后回复 Markdown 标题 `## 原生审批验收记录` 并简短报告允许和拒绝的实际结果，不要声称 GUI 验收成功。',
].join('\n');
let turns = 0, threadId = '', pending: Approval | undefined;
const nativeRequest = codex.request.bind(codex), nativeSend = codex.send.bind(codex), simulatedReplies: WireMessage[] = [];
codex.request = async <T>(method: string, params: object): Promise<T> => {
  if (method === 'thread/start' || method === 'thread/resume') params = { ...params, ...evidence.testOnlySessionPolicy };
  if (method === 'turn/start') {
    if (++turns !== 1 || (params as any).input?.[0]?.text !== prompt) throw new Error('Only the exact single acceptance turn is allowed');
    evidence.turnRequest = { ...(params as any), input: '[bounded approval prompt]' };
  }
  return nativeRequest<T>(method, params);
};
codex.send = message => { if (typeof message.id === 'string' && message.id.startsWith('ui-fixture-')) simulatedReplies.push(message); else nativeSend(message); };
service.on('event', (event: BridgeEvent) => {
  if (event.type === 'approval') pending = event.request;
  if (event.type === 'event' && event.event.method === 'turn/completed') evidence.nativeTurns.push({ id: event.event.params.turn.id, status: event.event.params.turn.status });
});
let server: Awaited<ReturnType<typeof createServer>> | undefined, app: ElectronApplication | undefined, android: Browser | undefined;
let phone!: Page, desktop!: Page, forwarded: string | undefined, savedCookies: Cookie[] | undefined;
let savedStorage: { local: Record<string, string>; session: Record<string, string> } | undefined;
const errors: string[] = [];
const ready = (page: Page) => expect(page.getByRole('status', { includeHidden: true })).toContainText('状态已查询', { timeout: 30_000 });
async function attach() {
  await android?.close(); const pid = adb('shell', 'pidof', 'dev.oraculum.poc'); if (!/^\d+$/.test(pid)) throw new Error('Expected one Oraculum Android process');
  if (forwarded) adb('forward', `tcp:${forwarded}`, `localabstract:webview_devtools_remote_${pid}`);
  else forwarded = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
  android = await chromium.connectOverCDP(`http://127.0.0.1:${forwarded}`, { noDefaults: true });
  phone = android.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith(origin) || page.url().startsWith('chrome-error://'))!;
  if (!phone) throw new Error('Android is using a different server; refusing to replace that entry');
  phone.on('pageerror', error => errors.push(error.message));
}
async function pair(page: Page, name: string) {
  await expect(page.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible();
  await page.getByLabel('设备名称', { exact: true }).fill(name); await page.getByLabel('配对码', { exact: true }).fill(trust.createPairing().code);
  await page.getByRole('button', { name: '配对并连接', exact: true }).click(); await ready(page);
}
async function hideIme() {
  if (/\bmInputShown=true\b/.test(adb('shell', 'dumpsys input_method | grep mInputShown='))) adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
}
async function capture(name: string) {
  await desktop.screenshot({ path: join(output, `${name}-electron.png`) });
  await phone.screenshot({ path: join(output, `${name}-webview.png`) });
  await writeFile(join(output, `${name}-device.png`), execFileSync('adb', [...adbArgs, 'exec-out', 'screencap', '-p'], { maxBuffer: 16 * 1024 * 1024 }));
}
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron') });
try {
  await codex.initialize(true);
  const started = await service.dispatch('thread/start', { cwd }) as ThreadStartResponse; threadId = started.thread.id;
  evidence.threadId = threadId; evidence.actualPolicy = { approvalPolicy: started.approvalPolicy, sandbox: started.sandbox, approvalsReviewer: started.approvalsReviewer };
  const models = await service.dispatch('model/list', {}) as { data: Model[] };
  const inexpensive = models.data.find(model => /mini/i.test(model.model) && model.supportedReasoningEfforts.some(effort => effort.reasoningEffort === 'low'));
  server = await createServer(service, port, resolve('apps/web/dist'), { trust }); await server.listen({ host: '127.0.0.1', port });
  adb('reverse', `tcp:${port}`, `tcp:${port}`); adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'); adb('shell', 'am', 'start', '-n', 'dev.oraculum.poc/.MainActivity');
  await attach(); savedCookies = (await phone.context().cookies([origin])).filter(cookie => cookie.name === 'oraculum_local' && cookie.path === '/');
  await phone.goto(origin + '/'); savedStorage = await phone.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  await writeFile(join(output, 'private-device-backup.json'), JSON.stringify({ cookies: savedCookies, storage: savedStorage }), { mode: 0o600 });
  await phone.context().clearCookies({ name: 'oraculum_local', domain: '127.0.0.1', path: '/' }); await phone.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await phone.reload();
  await pair(phone, 'P0 HONOR fixture'); await hideIme();
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env }); desktop = await app.firstWindow(); desktop.on('pageerror', error => errors.push(error.message)); await pair(desktop, 'P0 Electron fixture');
  for (const page of [desktop, phone]) await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', threadId);
  evidence.android = { manufacturer: adb('shell', 'getprop', 'ro.product.manufacturer'), model: adb('shell', 'getprop', 'ro.product.model'), release: adb('shell', 'getprop', 'ro.build.version.release') };
  expect(evidence.android.manufacturer.toUpperCase()).toBe('HONOR');
  if (inexpensive) { await desktop.getByLabel('模型', { exact: true }).selectOption(inexpensive.model); await desktop.getByLabel('思考强度', { exact: true }).selectOption('low'); }
  await desktop.getByLabel('消息', { exact: true }).fill(prompt); await desktop.getByRole('button', { name: '发送', exact: true }).click();
  for (const [marker, button, decision] of [['ORACULUM_NATIVE_ALLOW', '允许本次', 'accept'], ['ORACULUM_NATIVE_DECLINE', '拒绝', 'decline']] as const) {
    await expect.poll(() => pending?.method === 'item/commandExecution/requestApproval' ? pending.params.command : '', { timeout: 180_000 }).toContain(marker);
    const request = pending!; if (request.method !== 'item/commandExecution/requestApproval') throw new Error('Unexpected native approval');
    expect([`printf ${marker}`, `/bin/bash -lc 'printf ${marker}'`, `/bin/bash -lc "printf ${marker}"`, `/bin/sh -lc 'printf ${marker}'`]).toContain(request.params.command);
    if (decision === 'accept') { await phone.reload(); await ready(phone); }
    for (const page of [desktop, phone]) await expect(page.getByRole('heading', { name: '需要审批', exact: true })).toBeVisible();
    await phone.getByRole('button', { name: button, exact: true }).scrollIntoViewIfNeeded(); await capture(`native-${decision}`);
    expect((await phone.getByRole('button', { name: button, exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(47.9);
    evidence.approvals.push({ requestId: request.id, command: request.params.command, decision });
    await phone.getByRole('button', { name: button, exact: true }).click(); await expect(desktop.locator('.approval')).toHaveCount(0); pending = undefined;
  }
  await expect(phone.getByRole('heading', { name: '原生审批验收记录', exact: true })).toBeVisible({ timeout: 180_000 });
  await expect(phone.locator('.conversation')).toHaveAttribute('data-last-turn-status', 'completed'); await ready(phone);
  for (const page of [desktop, phone]) { await page.reload(); await ready(page); await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', threadId); await expect.poll(async () => (await sessionSnapshot(page)).receipts?.[0]?.status).toBe('completed'); }
  evidence.checks.push('One official Codex turn: exact harmless command allowed and second declined on HONOR; Electron synchronized; pending reload and both-client receipt/history reload');
  await capture('native-completed');

  // Deliberately simulated: test the new renderer adapters on actual hardware.
  async function mock(id: string, method: string, params: object, button: string, fill?: () => Promise<void>) {
    codex.emit('message', { id, method, params: { threadId, turnId: null, ...params } });
    for (const page of [desktop, phone]) await expect(page.locator('.approval')).toHaveCount(1);
    await phone.reload(); await ready(phone); await fill?.(); await hideIme();
    await phone.getByRole('button', { name: button, exact: true }).scrollIntoViewIfNeeded(); await capture(id);
    await phone.getByRole('button', { name: button, exact: true }).click();
    for (const page of [desktop, phone]) await expect(page.locator('.approval')).toHaveCount(0);
    expect(simulatedReplies.filter(reply => reply.id === id)).toHaveLength(1); evidence.mockChecks.push({ id, method, result: simulatedReplies.find(reply => reply.id === id)?.result });
  }
  await mock('ui-fixture-form', 'mcpServer/elicitation/request', { serverName: 'explicit-ui-fixture', mode: 'form', _meta: null, message: '模拟请求：此表单仅验证真机交互，不访问外部服务', requestedSchema: { type: 'object', required: ['note'], properties: { note: { type: 'string', title: '模拟答案' } } } }, '提交并允许', () => phone.getByLabel('模拟答案 *', { exact: true }).fill('真机合约'));
  await mock('ui-fixture-user-input', 'item/tool/requestUserInput', { turnId: 'simulated-turn', itemId: 'fixture', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'choice', header: '模拟', question: '仅验证真机选项', isOther: false, isSecret: false, options: [{ label: '只读', description: '无外部操作' }, { label: '取消', description: '无外部操作' }] }] }, '提交答案', () => phone.getByRole('radio', { name: /只读/ }).check());
  await mock('ui-fixture-permissions', 'item/permissions/requestApproval', { turnId: 'simulated-turn', itemId: 'fixture', environmentId: null, startedAtMs: Date.now(), cwd, reason: '模拟额外权限拒绝；无真实工具执行', permissions: { network: { enabled: true }, fileSystem: null } }, '拒绝');
  await mock('ui-fixture-url', 'mcpServer/elicitation/request', { serverName: 'explicit-ui-fixture', mode: 'url', _meta: null, message: '模拟外部授权取消', url: 'https://example.test/fixture', elicitationId: 'fixture' }, '取消');
  expect(turns).toBe(1); expect(errors).toEqual([]); expect(await hashConfig()).toBe(initialConfig); evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed'; evidence.error = String(error); process.exitCode = 1;
  if (phone && desktop) await capture('failure').catch(() => {});
} finally {
  const clean = async (name: string, action: () => unknown | Promise<unknown>) => { try { await action(); } catch { evidence.cleanupErrors.push(name); evidence.result = 'failed'; process.exitCode = 1; } };
  await clean('Electron', () => app?.close()); await clean('revoke fixture devices', () => { for (const device of trust.list()) trust.revoke(device.id); });
  if (savedStorage) await clean('Android storage', async () => {
    await attach(); await phone.goto(origin + '/'); await expect(phone.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible();
    await phone.evaluate(saved => { localStorage.clear(); sessionStorage.clear(); for (const [key, value] of Object.entries(saved.local)) localStorage.setItem(key, value); for (const [key, value] of Object.entries(saved.session)) sessionStorage.setItem(key, value); }, savedStorage!);
    expect(await phone.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual(savedStorage); evidence.storageRestored = true;
  });
  if (savedCookies) await clean('Android cookies', async () => { await phone.context().clearCookies({ name: 'oraculum_local', domain: '127.0.0.1', path: '/' }); await phone.context().addCookies(savedCookies!); expect((await phone.context().cookies([origin])).filter(cookie => cookie.name === 'oraculum_local' && cookie.path === '/')).toEqual(savedCookies); evidence.cookiesRestored = true; });
  await clean('flush Android state', () => adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')); await clean('CDP', () => android?.close());
  await clean('Bridge', () => server?.close()); await clean('Codex', () => codex.close()); await clean('trust store', () => trust.close());
  await clean('ADB reverse', () => previousReverse ? adb('reverse', `tcp:${port}`, previousReverse) : adb('reverse', '--remove', `tcp:${port}`));
  if (forwarded) await clean('ADB forward', () => adb('forward', '--remove', `tcp:${forwarded}`));
  if (!evidence.cleanupErrors.length) await rm(join(output, 'private-device-backup.json'), { force: true });
  evidence.globalConfigUnchanged = await hashConfig() === initialConfig; evidence.rendererErrors = errors;
  await writeFile(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ output, result: evidence.result, error: evidence.error, checks: evidence.checks, mockChecks: evidence.mockChecks, cleanupErrors: evidence.cleanupErrors }));
}
