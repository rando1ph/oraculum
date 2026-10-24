// Actual Electron + emulated mobile Chromium, with deterministic native replies.
// Android Back and IME composition below are simulated; device/native acceptance
// belongs to composer-live.ts, not to this fixture suite.
import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BridgeService } from '../bridge/src/service';
import { ProjectDirectories } from '../bridge/src/projects';
import { createServer } from '../bridge/src/server';
import { Themes } from '../bridge/src/themes';
import { modelTrigger, permissionTrigger, selectEffort, selectModel } from './composer-controls';

await mkdir('.local/evidence/phase4d3-patch-menu/composer-contract', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/phase4d3-patch-menu/composer-contract/run-'));
const projectRoot = join(output, 'projects'), cwd = join(projectRoot, 'Oraculum'), other = join(projectRoot, 'Notes');
await Promise.all([cwd, other].map(path => mkdir(path, { recursive: true })));
const db = new DatabaseSync(':memory:'), projects = new ProjectDirectories(projectRoot, cwd, db);
await projects.register(cwd); await projects.register(other);
const themes = new Themes({ source: resolve('themes'), installed: join(output, 'installed-themes') });
for (const id of ['test-violet', 'minimal-light', 'hong-kong-rain']) await themes.install(id);
const initial = { model: 'fixture-one', reasoningEffort: 'low', approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user' };
const threads: any[] = [cwd, other].map((path, index) => ({ id: `composer-${index}`, name: index ? '另一项目' : '简洁的对话', cwd: path,
  preview: '', status: { type: 'idle' }, turns: [{ id: `history-${index}`, status: 'completed', error: null, itemsView: 'full', items: [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text: '保留舒适的阅读与自然的输入。', text_elements: [] }] },
    { id: 'answer', type: 'agentMessage', text: '常规回复保持自然、清晰。\n\n## 清晰的结构\n\n- 项目与模型随手可选\n- 对话保留双角色卡片\n\n```ts\nconst message = "你好，神谕";\n```\n\n' + '长正文用于检查菜单打开时的阅读区域与滚动。\n\n'.repeat(15) },
  ] }] }));
const settings = new Map(threads.map(thread => [thread.id, structuredClone(initial)]));
const bus = new EventEmitter(), requests: { method: string; params: any }[] = [];
const service = new BridgeService({ on: bus.on.bind(bus), send: () => {}, request: async <T>(method: string, params: any): Promise<T> => {
  requests.push({ method, params: structuredClone(params) }); let result: unknown;
  const thread = threads.find(item => item.id === params.threadId);
  if (method === 'config/read') result = { config: { model: initial.model, model_reasoning_effort: initial.reasoningEffort,
    approval_policy: 'on-request', sandbox_mode: 'read-only', model_provider: 'fixture', approvals_reviewer: 'user' } };
  else if (method === 'model/list') result = { data: [
    { id: 'fixture-one', model: 'fixture-one', displayName: 'Fixture One', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
    { id: 'fixture-two', model: 'fixture-two', displayName: 'Fixture Two', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] },
    { id: 'fixture-long', model: 'fixture-long', displayName: 'Long model name to verify narrow menu wrapping', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
  ], nextCursor: null };
  else if (method === 'thread/list') result = { data: threads.filter(thread => thread.cwd === params.cwd), nextCursor: null };
  else if (method === 'thread/read') result = { thread };
  else if (method === 'thread/resume') result = { thread, ...settings.get(thread!.id) };
  else if (method === 'thread/turns/list') result = { data: [...thread!.turns].reverse(), nextCursor: null };
  else if (method === 'thread/items/list') result = { data: thread!.turns.find((turn: any) => turn.id === params.turnId).items.map((item: any) => ({ turnId: params.turnId, item })), nextCursor: null };
  else throw new Error(`Unexpected fixture request: ${method}`);
  return structuredClone(result) as T;
}}, cwd, undefined, projects);
const port = Number(process.env.ORACULUM_COMPOSER_UI_PORT ?? '17879'), origin = `http://127.0.0.1:${port}`;
const server = await createServer(service, port, resolve('apps/web/dist'), { testOnlyUnauthenticated: true, themes });
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron-profile') });
let app: ElectronApplication | undefined, browser: Browser | undefined, desktop: Page | undefined, phone: Page | undefined;
const checks: string[] = [], errors: string[] = [];
let failure: string | undefined;
const ready = (page: Page) => expect(page.locator('.connection-status')).toContainText('状态已查询', { timeout: 15_000 });
const projectTrigger = (page: Page) => page.locator('.composer').getByRole('button', { name: /^项目：/ });
const moreTrigger = (page: Page) => page.getByRole('button', { name: '更多操作', exact: true });
const dialog = (page: Page, label: string) => page.getByRole('dialog', { name: label, exact: true });
const record = (check: string) => { checks.push(check); console.log('PASS ' + check); };
async function noNoise(page: Page) {
  await expect(page.locator('.history-warning, .permission-intent, .permission-warning, .composer-caption')).toHaveCount(0);
  await expect(page.getByText(/部分历史未能恢复/)).toHaveCount(0);
  await expect(page.locator('.composer').getByText(/模型\s*\/\s*思考强度继承|下一轮继承|原生已确认/)).toHaveCount(0);
  expect(await page.locator('.composer').innerText()).not.toMatch(/继承|默认|即将支持|上传|模式选择/);
}
async function geometry(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await expect.poll(async () => (await page.locator('.composer').boundingBox())!.y + (await page.locator('.composer').boundingBox())!.height).toBeLessThanOrEqual(height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const element of [page.getByLabel('消息', { exact: true }), page.getByRole('button', { name: '发送', exact: true })]) {
    const box = (await element.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
    expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44);
  }
  if (height >= 300) for (const element of [projectTrigger(page), modelTrigger(page), moreTrigger(page), permissionTrigger(page)]) {
    const box = (await element.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  }
}
async function insideViewport(page: Page, element: Locator) {
  const bounds = (await element.boundingBox())!, viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1); expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
}
async function rootMenu(page: Page) {
  const menu = dialog(page, '模型与思考强度');
  await expect(page.locator('.composer').getByRole('dialog')).toHaveCount(1);
  await expect(menu.getByRole('button')).toHaveCount(2);
  await expect(menu.getByRole('radiogroup')).toHaveCount(0);
  await expect(menu.getByRole('radio')).toHaveCount(0);
  const model = menu.getByRole('button', { name: '模型', exact: true });
  const effort = menu.getByRole('button', { name: '思考强度', exact: true });
  await expect(model).toBeVisible(); await expect(effort).toBeVisible();
  const first = (await model.boundingBox())!, second = (await effort.boundingBox())!;
  expect(first.height).toBeGreaterThanOrEqual(44); expect(second.height).toBeGreaterThanOrEqual(44);
  expect(first.y + first.height).toBeLessThanOrEqual(second.y + 1);
  await insideViewport(page, menu);
}
async function choiceMenu(page: Page, label: '模型' | '思考强度', values: string[]) {
  const menu = dialog(page, '模型与思考强度');
  await expect(page.locator('.composer').getByRole('dialog')).toHaveCount(1);
  await expect(menu.getByRole('radiogroup')).toHaveCount(1);
  await expect(menu.getByRole('button', { name: '模型', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('button', { name: '思考强度', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('button', { name: '返回模型与思考强度', exact: true })).toBeVisible();
  const options = menu.getByRole('radiogroup', { name: label, exact: true }).getByRole('radio');
  expect(await options.evaluateAll(elements => elements.map(element => element.getAttribute('data-value')))).toEqual(values);
  const bounds = await options.evaluateAll(elements => elements.map(element => {
    const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
  }));
  for (const [index, box] of bounds.entries()) {
    expect(box.height).toBeGreaterThanOrEqual(page === phone ? 44 : 40);
    expect(Math.abs(box.x - bounds[0].x)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.width - bounds[0].width)).toBeLessThanOrEqual(1);
    if (index) expect(bounds[index - 1].y + bounds[index - 1].height).toBeLessThanOrEqual(box.y + 1);
  }
  await insideViewport(page, menu);
}
async function setTheme(page: Page, id: string) {
  if (page === phone) await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('当前主题')).toBeEnabled(); await page.getByLabel('当前主题').selectOption(id);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme-id', id);
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  if (page === phone) await page.getByRole('button', { name: '折叠导航', exact: true }).click();
}
try {
  await server.listen({ host: '127.0.0.1', port });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  await expect.poll(() => app!.windows().some(page => page.url().startsWith(origin)), { timeout: 15_000 }).toBe(true);
  desktop = app.windows().find(page => page.url().startsWith(origin))!; desktop.on('pageerror', error => errors.push(error.message)); await ready(desktop);
  browser = await chromium.launch();
  phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
    userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36 OraculumAndroid/1' });
  phone.on('pageerror', error => errors.push(error.message)); await phone.goto(origin); await ready(phone);
  for (const page of [desktop, phone]) {
    await noNoise(page); await expect(modelTrigger(page)).toHaveAccessibleName(/Fixture One.*low/);
    await expect(permissionTrigger(page)).toHaveAccessibleName(/Read Only/);
    const context = (await page.locator('.composer-context').boundingBox())!, input = (await page.getByLabel('消息', { exact: true }).boundingBox())!;
    const toolbar = (await page.locator('.composer-toolbar').boundingBox())!;
    expect(context.y + context.height).toBeLessThanOrEqual(input.y + 1); expect(input.y + input.height).toBeLessThanOrEqual(toolbar.y + 1);
    await expect(page.locator('[data-item-id="user"] .message-name')).toHaveText('你'); await expect(page.locator('[data-item-id="answer"] .message-name')).toHaveText('Codex');
    await expect(page.locator('[data-item-id="answer"] .markdown h2')).toHaveText('清晰的结构');
  }
  record('actual native fixture values, compact top/bottom order, no configuration/history noise, identities/cards and Markdown headings preserved');
  for (const page of [desktop, phone]) for (const [label, trigger] of [
    ['项目', projectTrigger(page)], ['模型与思考强度', modelTrigger(page)], ['权限', permissionTrigger(page)], ['更多操作', moreTrigger(page)],
  ] as const) {
    await trigger.click(); await expect(dialog(page, label)).toBeVisible(); await insideViewport(page, dialog(page, label));
    expect(await dialog(page, label).innerText()).not.toMatch(/继承|默认|即将支持/);
    if (label === '更多操作') {
      await expect(dialog(page, label)).toHaveText(''); await expect(dialog(page, label).locator('*')).toHaveCount(0);
      await expect(dialog(page, label).locator('button, a, input, [role="button"], [role="menuitem"]')).toHaveCount(0);
    }
    await page.keyboard.press('Escape'); await expect(dialog(page, label)).toHaveCount(0);
    await trigger.click(); await page.locator('.conversation-header').click({ position: { x: 100, y: 20 } }); await expect(dialog(page, label)).toHaveCount(0);
    if (page === phone) {
      await trigger.click(); expect(await page.evaluate(() => (window as any).oraculumAndroidBack())).toBe(true); await expect(dialog(page, label)).toHaveCount(0);
    }
  }
  record('all menus open/close by Escape and outside click; emulated Android Back closes menus; + tray has no text, children or actions');
  const modelValues = ['fixture-one', 'fixture-two', 'fixture-long'];
  for (const page of [desktop, phone]) {
    const menu = dialog(page, '模型与思考强度');
    const modelRow = menu.getByRole('button', { name: '模型', exact: true });
    const effortRow = menu.getByRole('button', { name: '思考强度', exact: true });
    await modelTrigger(page).click(); await rootMenu(page); await expect(modelRow).toBeFocused();
    await expect(modelRow).toContainText('Fixture One'); await expect(effortRow).toContainText('low');
    await page.keyboard.press('Enter'); await choiceMenu(page, '模型', modelValues);
    await expect(menu.locator('[role="radio"][data-value="fixture-one"]')).toBeFocused();
    await page.keyboard.press('End'); await expect(menu.locator('[role="radio"][data-value="fixture-long"]')).toBeFocused();
    await page.keyboard.press('ArrowUp'); await expect(menu.locator('[role="radio"][data-value="fixture-two"]')).toBeFocused();
    await page.keyboard.press('Home'); await expect(menu.locator('[role="radio"][data-value="fixture-one"]')).toBeFocused();
    await expect(menu.locator('[role="radio"][data-value="fixture-one"]')).toHaveAttribute('aria-checked', 'true');
    await expect(modelTrigger(page)).toHaveAccessibleName(/Fixture One.*low/);
    await menu.getByRole('button', { name: '返回模型与思考强度', exact: true }).click();
    await rootMenu(page); await expect(modelRow).toBeFocused();
    await page.keyboard.press('Tab'); await expect(effortRow).toBeFocused();
    await page.keyboard.press('ArrowUp'); await expect(modelRow).toBeFocused();
    await page.keyboard.press('ArrowDown'); await expect(effortRow).toBeFocused();
    await page.keyboard.press('Space'); await choiceMenu(page, '思考强度', ['low', 'high']);
    await expect(menu.locator('[role="radio"][data-value="low"]')).toBeFocused();
    await page.keyboard.press('Space'); await rootMenu(page); await expect(effortRow).toBeFocused();
    await page.keyboard.press('Enter'); await choiceMenu(page, '思考强度', ['low', 'high']);
    await page.keyboard.press('Escape'); await rootMenu(page); await expect(effortRow).toBeFocused();
    await page.keyboard.press('ArrowRight'); await choiceMenu(page, '思考强度', ['low', 'high']);
    await page.keyboard.press('ArrowLeft'); await rootMenu(page); await expect(effortRow).toBeFocused();
    await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(modelTrigger(page)).toBeFocused();
    await modelTrigger(page).click(); await modelRow.click();
    await page.locator('.conversation-header').click({ position: { x: 100, y: 20 } }); await expect(menu).toHaveCount(0);
    if (page === phone) {
      await modelTrigger(page).tap(); await effortRow.tap();
      expect(await page.evaluate(() => (window as any).oraculumAndroidBack())).toBe(true);
      await rootMenu(page); await expect(effortRow).toBeFocused();
      expect(await page.evaluate(() => (window as any).oraculumAndroidBack())).toBe(true);
      await expect(menu).toHaveCount(0); await expect(modelTrigger(page)).toBeFocused();
    }
  }
  record('two-row root replaces itself with one vertical list; touch, Enter/Space/Tab, arrows/Home/End, Back, Escape, outside close and focus return work without changing selection on navigation');
  await selectModel(desktop, 'fixture-long');
  await modelTrigger(desktop).click(); await dialog(desktop, '模型与思考强度').getByRole('button', { name: '思考强度', exact: true }).click();
  await choiceMenu(desktop, '思考强度', ['high']);
  await expect(dialog(desktop, '模型与思考强度').getByRole('radio')).toHaveAttribute('aria-checked', 'true');
  await desktop.keyboard.press('Escape'); await desktop.keyboard.press('Escape');
  await selectModel(desktop, 'fixture-two'); await selectEffort(desktop, 'medium');
  await modelTrigger(desktop).click(); await dialog(desktop, '模型与思考强度').getByRole('button', { name: '思考强度', exact: true }).click();
  await choiceMenu(desktop, '思考强度', ['medium', 'high']);
  await expect(dialog(desktop, '模型与思考强度').locator('[role="radio"][data-value="medium"]')).toHaveAttribute('aria-checked', 'true');
  await desktop.keyboard.press('Escape'); await desktop.keyboard.press('Escape');
  record('reasoning submenu lists only the selected model supported efforts and preserves the selected radio');
  await selectModel(desktop, 'fixture-two'); await selectEffort(desktop, 'high');
  await expect(modelTrigger(desktop)).toHaveAccessibleName(/Fixture Two.*high/);
  await modelTrigger(desktop).click();
  await rootMenu(desktop); await dialog(desktop, '模型与思考强度').getByRole('button', { name: '模型', exact: true }).click();
  await expect(dialog(desktop, '模型与思考强度').getByRole('radiogroup', { name: '模型', exact: true }).locator('[data-value="fixture-two"]')).toBeFocused();
  await desktop.keyboard.press('Escape'); await rootMenu(desktop);
  await desktop.keyboard.press('Escape'); await expect(modelTrigger(desktop)).toBeFocused();
  expect(requests.some(request => request.method === 'turn/start')).toBe(false);
  await desktop.reload(); await ready(desktop); await expect(modelTrigger(desktop)).toHaveAccessibleName(/Fixture Two.*high/);
  await desktop.getByLabel('消息', { exact: true }).fill('当前项目的草稿');
  await projectTrigger(desktop).click(); await dialog(desktop, '项目').getByRole('radio').filter({ hasText: 'Notes' }).click(); await ready(desktop);
  await expect(desktop.locator('.conversation')).toHaveAttribute('data-thread-id', 'composer-1');
  await expect(modelTrigger(desktop)).toHaveAccessibleName(/Fixture One.*low/); await expect(desktop.getByLabel('消息', { exact: true })).toHaveValue('');
  await projectTrigger(desktop).click(); await dialog(desktop, '项目').getByRole('radio').filter({ hasText: 'Oraculum' }).click(); await ready(desktop);
  await expect(desktop.getByLabel('消息', { exact: true })).toHaveValue('当前项目的草稿'); await expect(modelTrigger(desktop)).toHaveAccessibleName(/Fixture Two.*high/);
  record('pending model/effort choices survive reload and project switch; projects keep separate sessions and drafts without a native send');
  for (const [width, height] of [[375, 812], [390, 844], [844, 390], [390, 430]]) {
    await geometry(phone, width, height);
    for (const trigger of [modelTrigger(phone), permissionTrigger(phone), moreTrigger(phone)]) {
      await trigger.click(); await insideViewport(phone, phone.locator('.composer').getByRole('dialog')); await phone.keyboard.press('Escape');
    }
    await modelTrigger(phone).click(); await rootMenu(phone);
    for (const label of ['模型', '思考强度'] as const) {
      await dialog(phone, '模型与思考强度').getByRole('button', { name: label, exact: true }).click();
      await choiceMenu(phone, label, label === '模型' ? modelValues : ['low', 'high']);
      await phone.keyboard.press('Escape'); await rootMenu(phone);
    }
    await phone.keyboard.press('Escape');
  }
  await modelTrigger(phone).click(); await dialog(phone, '模型与思考强度').getByRole('button', { name: '模型', exact: true }).click();
  const scrollMenu = dialog(phone, '模型与思考强度');
  expect(await scrollMenu.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await phone.keyboard.press('End');
  const lastModel = scrollMenu.locator('[role="radio"][data-value="fixture-long"]');
  await expect(lastModel).toBeFocused();
  expect((await lastModel.boundingBox())!.y + (await lastModel.boundingBox())!.height).toBeLessThanOrEqual((await scrollMenu.boundingBox())!.y + (await scrollMenu.boundingBox())!.height);
  await phone.keyboard.press('Home');
  const firstModel = scrollMenu.locator('[role="radio"][data-value="fixture-one"]'), back = scrollMenu.locator('header');
  await expect(firstModel).toBeFocused();
  expect((await firstModel.boundingBox())!.y).toBeGreaterThanOrEqual((await back.boundingBox())!.y + (await back.boundingBox())!.height);
  await phone.keyboard.press('Escape'); await phone.keyboard.press('Escape');
  await geometry(phone, 782, 99); await geometry(phone, 390, 844);
  record('375/390 portrait, landscape and keyboard-sized menus stay within viewport with 44px touch targets; End/Home keeps focus clear of sticky Back; 99px height retains reachable input/send');
  const message = phone.getByLabel('消息', { exact: true });
  await message.fill('中文输入'); await message.press('End'); await message.press('Enter'); await message.press('A'); await expect(message).toHaveValue('中文输入\nA');
  await message.dispatchEvent('compositionstart', { data: '拼音' });
  await message.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, isComposing: true, bubbles: true });
  await message.dispatchEvent('compositionend', { data: '拼音' });
  await phone.getByRole('button', { name: '展开输入框', exact: true }).click(); await geometry(phone, 390, 430);
  expect(await phone.evaluate(() => (window as any).oraculumAndroidBack())).toBe(true);
  await geometry(phone, 390, 844); await phone.reload(); await ready(phone); await expect(message).toHaveValue('中文输入\nA');
  expect(requests.some(request => request.method === 'turn/start')).toBe(false);
  record('Enter newline, simulated composition guard, expanded input/Back and reload preserve draft without sending');
  for (const id of ['oracle-eye', 'test-violet', 'hong-kong-rain', 'minimal-light']) for (const page of [desktop, phone]) {
    await setTheme(page, id); await noNoise(page);
    await modelTrigger(page).click(); await rootMenu(page);
    await page.screenshot({ path: join(output, `${id}-${page === phone ? 'mobile' : 'electron'}-root-menu.png`) });
    for (const label of ['模型', '思考强度'] as const) {
      await dialog(page, '模型与思考强度').getByRole('button', { name: label, exact: true }).click();
      await choiceMenu(page, label, label === '模型' ? modelValues : page === phone ? ['low', 'high'] : ['medium', 'high']);
      await page.screenshot({ path: join(output, `${id}-${page === phone ? 'mobile' : 'electron'}-${label === '模型' ? 'model' : 'effort'}-menu.png`) });
      await page.keyboard.press('Escape'); await rootMenu(page);
    }
    await page.keyboard.press('Escape'); await moreTrigger(page).click(); await expect(dialog(page, '更多操作')).toHaveText(''); await page.keyboard.press('Escape');
  }
  await phone.addStyleTag({ content: '[data-theme-slot="composer"] { border-radius: 20px; } [data-theme-slot="user-message"], [data-theme-slot="assistant-message"] { border-radius: 18px; }' });
  await geometry(phone, 375, 812); await expect(phone.locator('.composer')).toHaveCSS('border-radius', '20px');
  await expect(phone.locator('[data-item-id="user"] .message')).toHaveCSS('border-radius', '18px');
  await expect(phone.locator('[data-item-id="answer"] .message')).toHaveCSS('border-radius', '18px');
  record('all four themes and existing custom CSS composer/message slots retain compact menus and unchanged identities');
  expect(errors).toEqual([]);
} catch (error) {
  failure = String(error);
  if (desktop && !desktop.isClosed()) await desktop.screenshot({ path: join(output, 'failure-electron.png') }).catch(() => {});
  if (phone && !phone.isClosed()) await phone.screenshot({ path: join(output, 'failure-mobile.png') }).catch(() => {});
  throw error;
} finally {
  await app?.close(); await browser?.close(); await server.close(); db.close();
  await writeFile(join(output, 'report.json'), JSON.stringify({ output, realElectron: true, emulatedAndroid: true, simulatedNative: true,
    date: new Date().toISOString(), checks, errors, failure }, null, 2));
  console.log(JSON.stringify({ output, checks, failure }));
}
