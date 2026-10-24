// Real Electron and emulated mobile renderer; native requests are simulated.
// Tests native protocol adaptation, not account availability or live MCP access.
import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import type { WireMessage } from '../packages/shared/protocol';

const cwd = '/native-request-contract', threadId = 'native-request-thread', turnId = 'native-request-turn';
const thread = { id: threadId, name: '原生请求合约 · 模拟', cwd, preview: '', status: { type: 'idle' }, turns: [] };
const bus = new EventEmitter(), replies: WireMessage[] = [];
const codex = {
  on: bus.on.bind(bus), send: (reply: WireMessage) => { replies.push(reply); },
  request: async <T>(method: string): Promise<T> => {
    let value: unknown;
    if (method === 'config/read') value = { config: { model: 'fixture', model_provider: 'fixture', approval_policy: 'never', sandbox_mode: 'read-only', web_search: 'disabled' } };
    else if (method === 'model/list') value = { data: [], nextCursor: null };
    else if (method === 'thread/list') value = { data: [thread], nextCursor: null };
    else if (method === 'thread/read' || method === 'thread/resume') value = { thread, approvalPolicy: 'never', sandbox: { type: 'readOnly' }, approvalsReviewer: 'user' };
    else if (method === 'thread/turns/list') value = { data: [], nextCursor: null };
    else throw new Error(`Unexpected fixture request: ${method}`);
    return structuredClone(value) as T;
  },
};
const service = new BridgeService(codex, cwd), port = 17872, origin = `http://127.0.0.1:${port}`;
const server = await createServer(service, port, resolve('apps/web/dist'), { testOnlyUnauthenticated: true });
await mkdir('.local/evidence/native-requests-ui', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/native-requests-ui/run-'));
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron') });
let app: ElectronApplication | undefined, browser: Browser | undefined, desktop!: Page, phone!: Page;
let id = 0;
const checks: string[] = [], errors: string[] = [];
const ready = (page: Page) => expect(page.locator('.connection-status')).toContainText('状态已查询');
async function request(method: string, params: object) {
  const requestId = ++id;
  bus.emit('message', { id: requestId, method, params: { threadId, turnId, ...params } });
  for (const page of [desktop, phone]) await expect(page.locator('.approval')).toHaveCount(1);
  return requestId;
}
async function replied(requestId: number, expected: unknown) {
  await expect.poll(() => replies.filter(reply => reply.id === requestId)).toHaveLength(1);
  expect(replies.find(reply => reply.id === requestId)?.result).toEqual(expected);
  for (const page of [desktop, phone]) await expect(page.locator('.approval')).toHaveCount(0);
}
const mcp = (requestedSchema: unknown, extra: object = {}) => ({ serverName: 'contract', mode: 'form', _meta: null, message: '明确模拟的 MCP 表单', requestedSchema, ...extra });
async function screenshot(name: string) {
  for (const [label, page] of [['electron', desktop], ['mobile', phone]] as const) await page.screenshot({ path: join(output, `${name}-${label}.png`) });
}
try {
  await server.listen({ host: '127.0.0.1', port });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  await expect.poll(() => app!.windows().some(page => page.url().startsWith(origin)), { timeout: 15_000 }).toBe(true);
  desktop = app.windows().find(page => page.url().startsWith(origin))!; desktop.on('pageerror', error => errors.push(error.message)); await ready(desktop);
  browser = await chromium.launch(); phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  phone.on('pageerror', error => errors.push(error.message)); await phone.goto(origin); await ready(phone);
  await desktop.getByRole('button', { name: '设置', exact: true }).click();
  await desktop.locator('.permission-details summary').click();
  await expect(desktop.locator('.permission-details')).toContainText('never');
  await expect(desktop.locator('.permission-details')).toContainText('read-only');
  await desktop.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(desktop.locator('.composer').getByTestId('effective-permissions')).toHaveCount(0);
  checks.push('actual resumed custom permissions remain available in Settings without fixed presets or composer diagnostics');
  const form = { type: 'object', required: ['name', 'count', 'allow', 'tier', 'areas'], properties: {
    name: { type: 'string', title: '姓名', minLength: 2 }, count: { type: 'integer', title: '数量', minimum: 1, maximum: 3 },
    allow: { type: 'boolean', title: '同意条款' }, tier: { type: 'string', title: '级别', oneOf: [{ const: 'read', title: '只读' }, { const: 'write', title: '读写' }] },
    areas: { type: 'array', title: '区域', minItems: 1, items: { anyOf: [{ const: 'a', title: '区域 A' }, { const: 'b', title: '区域 B' }] } },
  } };
  let requestId = await request('mcpServer/elicitation/request', mcp(form, { turnId: null }));
  await phone.reload(); await ready(phone); await expect(phone.getByLabel('姓名 *', { exact: true })).toBeVisible();
  await phone.getByLabel('姓名 *', { exact: true }).fill('合约'); await phone.getByLabel('数量 *', { exact: true }).fill('2');
  await phone.getByLabel('同意条款 *', { exact: true }).selectOption('false'); await phone.getByLabel('级别 *', { exact: true }).selectOption({ label: '只读' }); await phone.getByLabel('区域 A', { exact: true }).check();
  for (const width of [375, 390]) { await phone.setViewportSize({ width, height: 844 }); expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
  await screenshot('form-pending'); await phone.getByRole('button', { name: '提交并允许', exact: true }).click();
  await replied(requestId, { action: 'accept', content: { name: '合约', count: 2, allow: false, tier: 'read', areas: ['a'] }, _meta: null });
  checks.push('MCP primitive fields, typed values, nullable turn, reconnect snapshot, both-client immediate resolution');

  requestId = await request('item/tool/requestUserInput', { itemId: 'questions', isBlocking: true, autoResolutionMs: null, questions: [
    { id: 'choice', header: '选择', question: '请选择一个选项', isOther: true, isSecret: false, options: [{ label: '只读', description: '只做读取' }, { label: '修改', description: '允许写入' }] },
    { id: 'free', header: '输入', question: '输入一段文字', isOther: false, isSecret: true, options: null },
  ] });
  await phone.getByLabel('其他答案', { exact: true }).check(); await phone.getByLabel('你的答案', { exact: true }).fill('自定义读取');
  await phone.getByLabel('保密答案', { exact: true }).fill('fixture-secret'); expect(await phone.getByLabel('保密答案').getAttribute('type')).toBe('password');
  await screenshot('user-input'); await phone.getByRole('button', { name: '提交答案', exact: true }).click();
  await replied(requestId, { answers: { choice: { answers: ['自定义读取'] }, free: { answers: ['fixture-secret'] } } });
  requestId = await request('item/tool/requestUserInput', { itemId: 'skip', isBlocking: false, autoResolutionMs: 5000, questions: [{ id: 'optional', header: '选择', question: '可跳过', isOther: false, isSecret: false, options: null }] });
  await desktop.getByRole('button', { name: '跳过', exact: true }).click(); await replied(requestId, { answers: {} });
  checks.push('native user input choices/other/secret, exact answers and skip');

  requestId = await request('item/permissions/requestApproval', { itemId: 'permission', environmentId: null, startedAtMs: Date.now(), cwd, reason: '模拟权限请求', permissions: { network: { enabled: true }, fileSystem: null } });
  await screenshot('permissions'); await desktop.getByRole('button', { name: '允许本轮', exact: true }).click();
  await replied(requestId, { permissions: { network: { enabled: true } }, scope: 'turn' });
  requestId = await request('item/permissions/requestApproval', { itemId: 'permission-decline', environmentId: null, startedAtMs: Date.now(), cwd, reason: '模拟拒绝', permissions: { network: null, fileSystem: { read: ['/fixture'], write: null } } });
  await phone.getByRole('button', { name: '拒绝', exact: true }).click(); await replied(requestId, { permissions: {}, scope: 'turn' });
  checks.push('permissions limited to requested grants and turn scope; decline grants nothing');

  requestId = await request('mcpServer/elicitation/request', { mode: 'url', serverName: 'contract', _meta: null, message: '外部授权模拟', url: 'https://example.test/authorize?fixture=true', elicitationId: 'external' });
  await expect(phone.getByRole('button', { name: '确认完成', exact: true })).toBeDisabled();
  await phone.locator('.native-request-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(replies.some(reply => reply.id === requestId)).toBe(false);
  expect(await phone.locator('.native-url a').count()).toBe(0);
  await phone.getByLabel('我已在外部浏览器完成操作', { exact: true }).check(); await screenshot('url');
  await phone.getByRole('button', { name: '确认完成', exact: true }).click(); await replied(requestId, { action: 'accept', content: null, _meta: null });
  requestId = await request('mcpServer/elicitation/request', mcp(null, { mode: 'openai/form', _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'fixture_read', tool_params: { query: '<img src=x onerror=alert(1)>' } } }));
  await expect(phone.getByLabel('待授权工具参数')).toContainText('<img src=x onerror=alert(1)>');
  expect(await phone.locator('.approval img').count()).toBe(0);
  await desktop.getByRole('button', { name: '提交并允许', exact: true }).click(); await replied(requestId, { action: 'accept', content: {}, _meta: null });
  requestId = await request('mcpServer/elicitation/request', mcp({ type: 'object', required: ['blank', 'choice'], properties: {
    blank: { type: 'string', title: '允许空字符串', default: '' }, choice: { type: 'string', title: '允许空枚举', enum: ['', 'read'], default: '' },
  } }));
  await phone.getByRole('button', { name: '提交并允许', exact: true }).click(); await replied(requestId, { action: 'accept', content: { blank: '', choice: '' }, _meta: null });
  requestId = await request('mcpServer/elicitation/request', mcp({ type: 'object', properties: { nested: { type: 'object', properties: {} } } }));
  await expect(phone.getByRole('alert')).toContainText('当前客户端尚不支持此表单结构'); await expect(phone.getByRole('button', { name: '提交并允许', exact: true })).toBeDisabled();
  await phone.locator('.native-request-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(replies.some(reply => reply.id === requestId)).toBe(false);
  await phone.getByRole('button', { name: '取消', exact: true }).click(); await replied(requestId, { action: 'cancel', content: null, _meta: null });
  checks.push('URL manual completion; OpenAI consent form; unsupported schema explicit and safely cancellable');

  requestId = await request('item/commandExecution/requestApproval', { itemId: 'legacy', command: 'printf NATIVE_CONTRACT', cwd, reason: 'Existing approval regression' });
  await phone.getByRole('button', { name: '允许本次', exact: true }).click(); await replied(requestId, { decision: 'accept' });
  requestId = await request('mcpServer/elicitation/request', mcp({ type: 'object', properties: { note: { type: 'string' } } }));
  bus.emit('message', { method: 'serverRequest/resolved', params: { threadId, requestId } });
  for (const page of [desktop, phone]) await expect(page.locator('.approval')).toHaveCount(0);
  expect(replies.some(reply => reply.id === requestId)).toBe(false);
  const childId = 'native-child-fixture';
  bus.emit('message', { method: 'thread/started', params: { thread: { ...thread, id: childId, parentThreadId: threadId } } });
  requestId = await request('item/tool/requestUserInput', { threadId: childId, turnId: 'child-turn', itemId: 'child-input', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'answer', header: '子代理', question: '子代理请求输入', isOther: false, isSecret: false, options: null }] });
  await phone.reload(); await ready(phone); await expect(phone.locator('.approval')).toContainText('来自子代理的请求');
  await expect(phone.locator('.approval')).not.toContainText(childId);
  await phone.getByLabel('你的答案', { exact: true }).fill('原生子线程答案'); await phone.getByRole('button', { name: '提交答案', exact: true }).click();
  await replied(requestId, { answers: { answer: { answers: ['原生子线程答案'] } } });
  requestId = await request('mcpServer/elicitation/request', mcp(null, { threadId: childId, turnId: 'child-turn' }));
  bus.emit('message', { method: 'turn/completed', params: { threadId: childId, turn: { id: 'child-turn', status: 'completed' } } });
  for (const page of [desktop, phone]) await expect(page.locator('.approval')).toHaveCount(0);
  expect(replies.some(reply => reply.id === requestId)).toBe(false);
  checks.push('same-project native child requests display in parent, survive reload, reply to original thread, expire on child completion');
  requestId = await request('mcpServer/elicitation/request', mcp(null)); bus.emit('unavailable', 'Simulated native exit');
  for (const page of [desktop, phone]) await expect(page.locator('.approval')).toHaveCount(0);
  expect(replies.some(reply => reply.id === requestId)).toBe(false);
  checks.push('legacy command regression, externally resolved and unavailable requests expire on both clients');
  expect(errors).toEqual([]);
} finally {
  await app?.close(); await browser?.close(); await server.close();
  await writeFile(join(output, 'report.json'), JSON.stringify({ simulatedNative: true, realElectron: true, emulatedMobile: true, date: new Date().toISOString(), checks, rendererErrors: errors }, null, 2));
}
console.log(JSON.stringify({ output, checks }));
