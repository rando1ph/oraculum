// Actual Ubuntu Electron + Chromium touch viewports, isolated authenticated
// Bridge and synthetic native events. No ADB, Android device, packaging or install.
import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../bridge/src/server';
import { BridgeService } from '../bridge/src/service';
import { TrustStore } from '../bridge/src/trust-store';
import { ReceiptStore } from '../bridge/src/receipts';
import { ProjectDirectories } from '../bridge/src/projects';
import { Themes } from '../bridge/src/themes';
import { NativeRpcError } from '../bridge/src/codex';
import { rateLimits } from './fixtures/usage';
import { loopbackTlsFixture } from './loopback-tls-fixture';

await mkdir('.local/evidence/r1-b6/ui', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/r1-b6/ui/run-'));
const temporary = await mkdtemp(join(tmpdir(), 'oraculum-b6-')), root = join(temporary, 'Projects'), cwd = join(root, '协作演示');
await mkdir(cwd, { recursive: true });
const trust = new TrustStore(join(temporary, 'state')), projects = new ProjectDirectories(root, cwd, trust.db);
await projects.register(cwd);
const turn: any = { id: 'parent-turn', status: 'completed', itemsView: 'full', error: null, startedAt: 100, completedAt: 110, durationMs: 10000, items: [
  { id: 'user', type: 'userMessage', content: [{ type: 'text', text: '请并行核对文档与界面，汇总验证结果。' }] },
  { id: 'answer', type: 'agentMessage', text: '已准备协作验证。此会话只使用合成数据。', phase: 'final_answer' },
] };
const parent: any = { id: 'parent', name: '协作验证 · 合成数据', preview: '合成数据', cwd, parentThreadId: null, source: 'appServer', ephemeral: false, status: { type: 'idle' }, turns: [turn] };
const threads = new Map<string, any>([['parent', parent]]);
const second = { ...parent, id: 'second', name: '独立会话 · 合成数据', turns: [{ ...turn, id: 'second-turn' }] }; threads.set('second', second);
const settings = { approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: [] }, approvalsReviewer: 'user', model: 'fixture', reasoningEffort: 'low' };
const bus = new EventEmitter(), calls: string[] = [];
let inventoryMode = 'ready', slowInventory: Promise<void> | undefined;
const codex = { on: bus.on.bind(bus), send: () => {}, request: async <T>(method: string, params: any): Promise<T> => {
  calls.push(method); const thread = threads.get(params.threadId); let value: any;
  if (['skills/list', 'mcpServerStatus/list', 'app/installed', 'plugin/list'].includes(method)) {
    await slowInventory;
    if (inventoryMode === 'empty') value = method === 'skills/list' ? { data: [{ cwd, skills: [], errors: [] }] } : method === 'app/installed' ? { apps: [] } : method === 'plugin/list' ? { marketplaces: [], marketplaceLoadErrors: [] } : { data: [], nextCursor: null };
    else if (inventoryMode === 'errors' && method === 'app/installed') throw new NativeRpcError('403 Cloudflare fixture', -32000);
    else if (inventoryMode === 'errors' && method === 'plugin/list') throw new NativeRpcError('Method not found', -32601);
    else if (method === 'skills/list') value = { data: [{ cwd, skills: [
      { name: 'scientific-critical-thinking', description: '评估科学论断与证据质量。', scope: 'user', enabled: true },
      { name: 'project-review', description: '核对项目变更与验证结果。', scope: 'repo', enabled: true },
      { name: 'archived-workflow', description: '已停用的历史工作流。', scope: 'user', enabled: false },
    ], errors: [] }] };
    else if (method === 'mcpServerStatus/list') value = { data: params.cursor ? [{ name: 'reference-library', runtimeStatus: 'disabled', authStatus: 'unknown', tools: {} }] : [
      { name: 'documentation', runtimeStatus: 'connected', authStatus: 'unsupported', tools: { read: {}, search: {} } },
      { name: 'workspace-notes', runtimeStatus: 'authenticationRequired', authStatus: 'notLoggedIn', tools: {} },
    ], nextCursor: params.cursor ? null : 'mcp-page-2' };
    else if (method === 'app/installed') value = { apps: [
      { id: 'drive', runtimeName: 'Google Drive', enabled: true, callable: true },
      { id: 'calendar', runtimeName: 'Calendar', enabled: false, callable: false },
    ] };
    else value = { marketplaces: [{ plugins: [
      { id: 'writing', name: 'Research Writing', installed: true, enabled: true, source: { type: 'remote' }, availability: 'AVAILABLE', interface: { shortDescription: '组织文献资料与研究写作流程。' } },
      { id: 'local', name: 'Project Notes', installed: true, enabled: false, source: { type: 'local' }, availability: 'AVAILABLE', interface: { shortDescription: '本地笔记扩展，当前已禁用。' } },
      { id: 'catalog', name: 'Catalog only', installed: false, enabled: false },
    ] }], marketplaceLoadErrors: [] };
  } else if (method === 'config/read') value = { config: { model: 'fixture', model_reasoning_effort: 'low', model_provider: 'fixture', approval_policy: 'on-request', sandbox_mode: 'workspace-write', approvals_reviewer: 'user' } };
  else if (method === 'model/list') value = { data: [{ id: 'fixture', model: 'fixture', displayName: 'Codex · 界面验证', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null };
  else if (method === 'account/rateLimits/read') value = { rateLimits, rateLimitsByLimitId: { codex: rateLimits } };
  else if (method === 'thread/list') value = { data: params.archived ? [] : [parent, second], nextCursor: null };
  else if (method === 'thread/read') value = { thread };
  else if (method === 'thread/resume') value = { thread, ...settings };
  else if (method === 'thread/turns/list') value = { data: [...thread.turns].reverse(), nextCursor: null };
  else if (method === 'thread/items/list') value = { data: thread.turns.filter((turn: any) => turn.id === params.turnId).flatMap((turn: any) => turn.items.map((item: any) => ({ turnId: turn.id, item }))), nextCursor: null };
  else throw new Error('Unexpected fixture method: ' + method);
  return structuredClone(value) as T;
} };
const service = new BridgeService(codex, cwd, new ReceiptStore(trust.db), projects);
const port = 17906, origin = `http://127.0.0.1:${port}`, proxy = await loopbackTlsFixture(port);
const server = await createServer(service, port, resolve('apps/web/dist'), { trust, remoteOrigin: proxy.origin, remoteBasePath: '/console/',
  themes: new Themes({ source: resolve('themes'), builtin: resolve('themes'), installed: join(temporary, 'themes') }) });
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(temporary, 'electron-profile') });
let app: ElectronApplication | undefined, browser: Browser | undefined, failure: string | undefined;
const checks: string[] = [], screenshots: string[] = [], errors: string[] = [];
const record = (message: string) => { checks.push(message); console.log('PASS ' + message); };
const ready = (page: Page) => expect(page.locator('.connection-status')).toContainText('状态已查询', { timeout: 15000 });
async function pair(page: Page, name: string) {
  await page.getByLabel('设备名称', { exact: true }).fill(name); await page.getByLabel('配对码', { exact: true }).fill(trust.createPairing().code);
  await page.getByRole('button', { name: '配对并连接', exact: true }).click(); await ready(page);
}
async function openSettings(page: Page) {
  const nav = page.getByRole('button', { name: '打开导航', exact: true });
  if (await nav.isVisible() && !await page.locator('.app-shell').evaluate(el => el.classList.contains('drawer-open'))) await nav.click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
}
async function closeSettings(page: Page) {
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  if (await page.locator('.app-shell').evaluate(el => el.classList.contains('drawer-open'))) await page.locator('.nav-close').click();
}
async function theme(page: Page, id: string) {
  await openSettings(page); await page.getByLabel('当前主题').selectOption(id);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme-id', id); await closeSettings(page);
}
async function openExtensions(page: Page) {
  await openSettings(page); await page.locator('.extension-settings > summary').click();
  await expect(page.locator('.extension-group')).toHaveCount(4); await page.locator('.extension-settings').scrollIntoViewIfNeeded();
}
async function group(page: Page, kind: string) { await page.locator(`[data-extension-kind="${kind}"] > summary`).click(); }
async function geometry(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  for (const element of await page.locator('.extension-settings summary, .extension-toolbar button').all()) {
    if (!await element.isVisible()) continue;
    const box = await element.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeLessThan(page.viewportSize()!.width);
  }
}
async function capture(page: Page, name: string) {
  const path = join(output, name + '.png'); await page.screenshot({ path, scale: 'css' }); screenshots.push(path);
}
async function selectThread(page: Page, id: string) {
  const nav = page.getByRole('button', { name: '打开导航', exact: true });
  if (await nav.isVisible() && !await page.locator('.app-shell').evaluate(el => el.classList.contains('drawer-open'))) await nav.click();
  await page.locator(`.session-link[data-thread-id="${id}"]`).click(); await ready(page);
}
function emit(method: string, params: object) { bus.emit('message', { method, params: structuredClone(params) }); }
function itemEvent(thread: any, item: any, completed = true) {
  const turn = thread.turns.at(-1);
  const index = turn.items.findIndex((value: any) => value.id === item.id);
  if (index === -1) turn.items.push(item); else turn.items[index] = item;
  emit(completed ? 'item/completed' : 'item/started', { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now(), startedAtMs: Date.now() });
}
function collaboration(id: string, tool: string, sender: string, receivers: string[], states: Record<string, any>, prompt: string | null = null) {
  return { id, type: 'collabAgentToolCall', tool, status: 'completed', senderThreadId: sender, receiverThreadIds: receivers, agentsStates: states, prompt, model: null, reasoningEffort: null };
}
async function showTree(page: Page) { await page.locator('.subagent-tree').evaluate((element: HTMLDetailsElement) => { element.open = true; }); await page.locator('.subagent-tree').scrollIntoViewIfNeeded(); }
try {
  await server.listen({ host: '127.0.0.1', port });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  await expect.poll(() => app!.windows().some(page => page.url().startsWith(origin)), { timeout: 15000 }).toBe(true);
  const desktop = app.windows().find(page => page.url().startsWith(origin))!;
  await desktop.setViewportSize({ width: 1440, height: 960 }); desktop.on('pageerror', error => errors.push(error.message)); await pair(desktop, 'B6 桌面验证');
  browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const phone = await context.newPage(); phone.on('pageerror', error => errors.push(error.message)); await phone.goto(proxy.origin + '/console/'); await pair(phone, 'B6 移动模拟');
  for (const id of ['oracle-eye', 'hong-kong-neon', 'old-terminal', 'minimal-light']) {
    for (const page of [desktop, phone]) {
      await theme(page, id); await openExtensions(page);
      await group(page, 'skills'); await expect(page.locator('[data-extension-kind="skills"] .extension-entry')).toHaveCount(3);
      await expect(page.locator('[data-extension-kind="skills"]')).toContainText('已禁用'); await group(page, 'skills');
      await group(page, 'mcp'); await expect(page.locator('[data-extension-kind="mcp"] .extension-entry')).toHaveCount(3);
      await expect(page.locator('[data-extension-kind="mcp"]')).toContainText('不提供认证状态'); await geometry(page);
      if (page === desktop && id === 'oracle-eye') { await page.locator('.extension-settings').evaluate(el => el.scrollIntoView({ block: 'start' })); await capture(page, '01-desktop-extensions-mcp'); }
      await group(page, 'mcp'); await group(page, 'apps'); await group(page, 'plugins');
      await expect(page.locator('[data-extension-kind="apps"]')).toContainText('可调用');
      await expect(page.locator('[data-extension-kind="plugins"] .extension-entry')).toHaveCount(2); await geometry(page);
      if (page === phone && id === 'minimal-light') { await page.locator('.extension-settings').evaluate(el => el.scrollIntoView({ block: 'start' })); await capture(page, '02-phone-extensions-apps-plugins'); }
      await closeSettings(page);
    }
  }
  record('four themes: real Electron and HTTPS subpath Chromium 390px; native scopes, installed/enabled/callable distinctions, MCP pagination and unsupported auth');
  inventoryMode = 'errors'; await openExtensions(phone); await group(phone, 'apps'); await group(phone, 'plugins');
  await expect(phone.locator('[data-extension-kind="apps"]')).toContainText('拒绝访问'); await expect(phone.locator('[data-extension-kind="plugins"]')).toContainText('不支持');
  await phone.locator('.extension-settings').evaluate(el => el.scrollIntoView({ block: 'start' })); await capture(phone, '07-phone-extension-degradation');
  inventoryMode = 'empty'; await phone.getByRole('button', { name: '刷新扩展' }).click();
  await expect(phone.locator('[data-extension-kind="apps"]')).toContainText('暂无项目'); await expect(phone.locator('[data-extension-kind="plugins"]')).toContainText('未返回');
  let release!: () => void; slowInventory = new Promise(resolve => { release = resolve; });
  await phone.getByRole('button', { name: '刷新扩展' }).click(); await expect(phone.locator('.extension-content')).toContainText('正在读取扩展');
  await expect(phone.getByRole('button', { name: '刷新扩展' })).toBeDisabled(); release(); slowInventory = undefined;
  await expect(phone.locator('.extension-group')).toHaveCount(4); await closeSettings(phone); inventoryMode = 'ready';
  record('manual refresh, loading, empty, independent 403 and unsupported degradation preserve core connection');
  for (const viewport of [{ width: 375, height: 812 }, { width: 844, height: 390 }, { width: 390, height: 420 }]) {
    await phone.setViewportSize(viewport); await openExtensions(phone); await group(phone, 'skills'); await geometry(phone); await closeSettings(phone);
  }
  record('375px, landscape and short keyboard viewport retain bounded list scrolling and touch targets');

  await phone.setViewportSize({ width: 390, height: 844 });
  const started = Math.floor(Date.now() / 1000) - 25;
  const active: any = { id: 'collaboration-turn', status: 'inProgress', itemsView: 'full', startedAt: started, completedAt: null, durationMs: null, error: null, items: [] };
  parent.turns.push(active); parent.status = { type: 'active', activeFlags: [] };
  emit('turn/started', { threadId: 'parent', turn: active });
  itemEvent(parent, { id: 'request', type: 'userMessage', content: [{ type: 'text', text: '请并行核对文档与界面，检查移动布局后汇总。' }] });
  const child = (id: string, name: string, role: string, parentId: string) => ({ ...parent, id, name: null, parentThreadId: parentId, agentNickname: name, agentRole: role,
    source: { subAgent: { thread_spawn: { parent_thread_id: parentId, depth: parentId === 'parent' ? 1 : 2, agent_path: null, agent_nickname: name, agent_role: role } } },
    turns: [{ ...active, id: id + '-turn', startedAt: started + 2, items: [{ id: id + '-task', type: 'userMessage', content: [{ type: 'text', text: id === 'docs' ? '只读核对文档与接口说明。' : '检查四套主题与移动布局。' }] }] }], status: { type: 'active', activeFlags: [] } });
  const docs = child('docs', '文档核对', 'explorer', 'parent'), ui = child('ui', '界面验证', 'worker', 'parent'), nested = child('mobile', '移动布局', 'reviewer', 'ui');
  for (const thread of [docs, ui, nested]) { threads.set(thread.id, thread); emit('thread/started', { thread }); emit('turn/started', { threadId: thread.id, turn: thread.turns[0] }); }
  itemEvent(parent, collaboration('spawn-docs', 'spawnAgent', 'parent', ['docs'], { docs: { status: 'running', message: null } }, '只读核对文档与接口说明。'));
  itemEvent(parent, collaboration('spawn-ui', 'spawnAgent', 'parent', ['ui'], { ui: { status: 'running', message: null } }, '检查四套主题与移动布局。'));
  itemEvent(ui, collaboration('spawn-mobile', 'spawnAgent', 'ui', ['mobile'], { mobile: { status: 'running', message: null } }, '检查 375 / 390px 移动布局。'));
  itemEvent(ui, { id: 'ui-progress', type: 'agentMessage', phase: 'commentary', text: '正在检查四套主题的扩展设置与触摸布局。' });
  itemEvent(nested, { id: 'mobile-progress', type: 'agentMessage', phase: 'commentary', text: '已完成 390px 检查，正在核对窄屏滚动与返回位置。' });
  itemEvent(docs, { id: 'docs-final', type: 'agentMessage', phase: 'final_answer', text: '文档与接口说明一致，已核对扩展只读边界。' });
  Object.assign(docs.turns[0], { status: 'completed', completedAt: started + 12, durationMs: 10000 }); docs.status = { type: 'idle' };
  emit('turn/completed', { threadId: docs.id, turn: docs.turns[0] });
  itemEvent(parent, collaboration('wait-docs', 'wait', 'parent', ['docs'], { docs: { status: 'completed', message: '文档与接口说明一致，已核对扩展只读边界。' } }));
  for (const id of ['oracle-eye', 'hong-kong-neon', 'old-terminal', 'minimal-light']) {
    for (const page of [desktop, phone]) {
      await theme(page, id); await showTree(page); await expect(page.locator('.agent-tree-list > li')).toHaveCount(3);
      await expect(page.locator('[data-agent-id="docs"]')).toHaveAttribute('data-agent-state', 'completed');
      await expect(page.locator('[data-agent-id="ui"]')).toHaveAttribute('data-agent-state', 'running');
      await expect(page.locator('[data-agent-id="mobile"]')).toHaveAttribute('data-depth', '1');
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      if (page === desktop && id === 'hong-kong-neon') await capture(page, '03-desktop-agents-running');
      if (page === phone && id === 'old-terminal') await capture(page, '04-phone-agents-running');
    }
  }
  record('four themes: mixed completed/running native agents, verified nested hierarchy and native progress in existing process');

  for (const page of [desktop, phone]) {
    await showTree(page); await page.getByRole('button', { name: '查看子代理 文档核对', exact: true }).scrollIntoViewIfNeeded();
    const reading = await page.locator('.conversation-scroll').evaluate(el => el.scrollTop);
    await page.getByRole('button', { name: '查看子代理 文档核对', exact: true }).click();
    await expect(page.locator('.agent-transcript')).toContainText('文档与接口说明一致');
    await expect(page.locator('.agent-detail-meta')).toContainText('只读');
    await page.getByRole('button', { name: '返回父任务', exact: true }).click();
    await expect.poll(() => page.locator('.conversation-scroll').evaluate(el => el.scrollTop)).toBeCloseTo(reading, 0);
    await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', 'parent');
  }
  record('read-only child history in desktop/mobile Inspector; returning preserves parent identity and reading position');

  // Late/duplicate agent and collaboration events must not revive completed work.
  emit('turn/started', { threadId: 'docs', turn: { ...docs.turns[0], status: 'inProgress' } });
  emit('item/completed', { threadId: 'parent', turnId: active.id, item: collaboration('wait-docs', 'wait', 'parent', ['docs'], { docs: { status: 'running', message: 'late stale state' } }), completedAtMs: Date.now() });
  await expect(phone.locator('[data-agent-id="docs"]')).toHaveAttribute('data-agent-state', 'completed');
  await selectThread(phone, 'second'); await expect(phone.locator('.subagent-tree')).toHaveCount(0); await selectThread(phone, 'parent'); await showTree(phone);
  await expect(phone.locator('.agent-tree-list > li')).toHaveCount(3);
  await phone.reload(); await ready(phone); await showTree(phone); await expect(phone.locator('[data-agent-id="mobile"]')).toHaveAttribute('data-depth', '1');
  record('duplicate and late events retain terminal states; thread switching and history replay retain only matching hierarchy');

  // Chromium's HTTP offline emulation keeps existing WebSockets alive. Close
  // actual sockets at this isolated server to test real transport recovery.
  for (const socket of server.websocketServer.clients) socket.close(1012, 'B6 controlled reconnect');
  await expect(phone.locator('.disconnect-banner')).toBeVisible();
  await expect(phone.locator('.agent-stale')).toContainText('上次可见状态');
  for (const page of [desktop, phone]) { await page.getByRole('button', { name: '重新连接', exact: true }).first().click(); await ready(page); await showTree(page); }
  record('disconnect marks agent state stale and reconnect restores the native projection without model calls');

  for (const thread of [ui, nested]) {
    itemEvent(thread, { id: thread.id + '-final', type: 'agentMessage', phase: 'final_answer', text: thread === ui ? '四套主题的控件顺序一致；桌面与移动布局检查完成。' : '375 / 390px、横屏与短键盘视口通过，返回父任务保留阅读位置。' });
    Object.assign(thread.turns[0], { status: 'completed', completedAt: started + 24, durationMs: 22000 }); thread.status = { type: 'idle' };
    emit('turn/completed', { threadId: thread.id, turn: thread.turns[0] });
  }
  itemEvent(parent, collaboration('wait-all', 'wait', 'parent', ['ui'], { ui: { status: 'completed', message: '四套主题与移动布局检查完成。' } }));
  itemEvent(parent, { id: 'parent-final', type: 'agentMessage', phase: 'final_answer', text: '文档、四套主题与移动布局的只读验证已完成。\n\n- 文档核对：扩展只读边界一致。\n- 界面验证：控件顺序与状态清晰。\n- 移动布局：窄屏滚动与返回位置通过。\n\n以上为本次合成事件的验证结果。' });
  Object.assign(active, { status: 'completed', completedAt: started + 25, durationMs: 25000 }); parent.status = { type: 'idle' }; emit('turn/completed', { threadId: 'parent', turn: active });
  for (const page of [desktop, phone]) {
    await ready(page); await expect(page.locator('.turn-process[data-turn-id="collaboration-turn"] .process-toggle')).toHaveAttribute('aria-expanded', 'false');
    await page.locator('.turn-process[data-turn-id="collaboration-turn"] .process-toggle').click(); await showTree(page);
    await expect(page.locator('.agent-tree-list > li[data-agent-state="completed"]')).toHaveCount(3);
  }
  await theme(desktop, 'minimal-light'); await showTree(desktop); await capture(desktop, '05-desktop-agents-completed');
  await theme(phone, 'oracle-eye'); await showTree(phone); await phone.getByRole('button', { name: '查看子代理 移动布局', exact: true }).click();
  await expect(phone.locator('.agent-transcript')).toContainText('375 / 390px'); await capture(phone, '06-phone-agent-details');
  await phone.getByRole('button', { name: '返回父任务', exact: true }).click();
  record('native completion retains Phase 4D process folding; completed nested child history is safely readable without switching or resuming threads');

  const beforeDetails = calls.length;
  threads.get('mobile').cwd = '/unrelated-fixture';
  await phone.getByRole('button', { name: '查看子代理 移动布局', exact: true }).click();
  await expect(phone.locator('.agent-detail')).toContainText('详情暂不可用'); await expect(phone.locator('.agent-visible-summary')).toContainText('375 / 390px');
  await phone.getByRole('button', { name: '返回父任务', exact: true }).click(); threads.get('mobile').cwd = cwd;
  expect(calls.slice(beforeDetails)).not.toContain('thread/resume');
  record('changed child project refuses transcript access and preserves the already visible parent summary');

  const failureTurn: any = { ...active, id: 'attention-turn', status: 'inProgress', startedAt: started + 30, items: [] };
  parent.turns.push(failureTurn); emit('turn/started', { threadId: 'parent', turn: failureTurn });
  for (const [id, state] of [['failed-agent', 'errored'], ['stopped-agent', 'interrupted'], ['empty-agent', 'pendingInit']]) {
    const agent = child(id!, id === 'failed-agent' ? '失败示例' : id === 'stopped-agent' ? '中断示例' : '空记录示例', 'worker', 'parent');
    agent.turns = []; threads.set(id!, agent); emit('thread/started', { thread: agent });
    itemEvent(parent, collaboration('spawn-' + id, 'spawnAgent', 'parent', [id!], { [id!]: { status: state, message: state === 'errored' ? '合成读取失败' : null } }));
  }
  Object.assign(failureTurn, { status: 'completed' }); emit('turn/completed', { threadId: 'parent', turn: failureTurn });
  for (const page of [desktop, phone]) {
    await ready(page); const process = page.locator('.turn-process[data-turn-id="attention-turn"]');
    await expect(process.locator('.subagent-tree')).toBeVisible();
    await expect(process.locator('[data-agent-id="failed-agent"]')).toContainText('执行失败');
    await expect(process.locator('[data-agent-id="stopped-agent"]')).toContainText('已中断');
    await process.getByRole('button', { name: '查看子代理 空记录示例', exact: true }).click();
    await expect(page.locator('.agent-transcript')).toContainText('暂无可读记录');
    await page.getByRole('button', { name: '返回父任务', exact: true }).click();
  }
  record('failed/interrupted agents remain visible after parent completion; empty native child history has an explicit fallback');
  expect(calls).not.toContain('app/list'); expect(calls).not.toContain('plugin/read'); expect(errors).toEqual([]);
} catch (error) { failure = error instanceof Error ? error.stack : String(error); console.error(failure); }
finally {
  await writeFile(join(output, 'report.json'), JSON.stringify({ scope: 'synthetic native data; actual Electron and Chromium mobile emulation; no Android device', checks, screenshots, errors, failure }, null, 2));
  await app?.close(); await browser?.close(); await server.close(); await proxy.close(); trust.close(); await rm(temporary, { recursive: true, force: true });
}
console.log('Evidence: ' + output); if (failure) process.exitCode = 1;
