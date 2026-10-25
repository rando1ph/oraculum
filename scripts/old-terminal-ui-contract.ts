// Real Electron renderer and Android-sized Chromium, using controlled protocol
// fixtures. No native Codex run, physical Android, installation or production use.
import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import { Themes } from '../bridge/src/themes';
import type { WireMessage } from '../packages/shared/protocol';
import { modelTrigger, permissionTrigger, selectEffort, selectModel, selectPermission } from './composer-controls';

const terminal = 'old-terminal', cwd = '/Oraculum', threadId = 'terminal-design';
const history: any = {
  id: 'display-study', status: 'completed', error: null, itemsView: 'full',
  startedAt: 1_792_925_100, completedAt: 1_792_925_142, durationMs: 42_000,
  items: [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text: '让界面像黑暗中浮现的电子信号。保留纯黑、清冷的绿光，以及安静的留白。', text_elements: [] }] },
    { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: '先保留所有真实控件的位置，再让文字和细线成为光源。' },
    { id: 'reasoning', type: 'reasoning', summary: ['模拟公开过程：核对控件布局、电子荧光与 OLED 黑色背景。'], content: [] },
    { id: 'command', type: 'commandExecution', command: 'printf "signal received\\n"', cwd, status: 'completed', exitCode: 0, durationMs: 18, aggregatedOutput: 'signal received\n' },
    { id: 'file', type: 'fileChange', status: 'completed', changes: [{ path: cwd + '/display.txt', kind: { type: 'update', move_path: null }, diff: '--- a/display.txt\n+++ b/display.txt\n@@ -1 +1,2 @@\n-opaque surface\n+black background\n+cool green phosphor\n' }] },
    { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '## 黑暗之中，信号浮现。\n\n屏幕安静下来。清冷的绿光从文字边缘散开，细线像仍在传输的信号，留下深黑而开阔的空间。\n\n> 不必照亮整块屏幕。\n> 让需要回应的地方，轻轻发光。\n\n保留原来的导航、消息与输入方式。熟悉的对话，换一种显示质感。\n\n*模拟协议对话 · 仅用于主题运行截图与交互验收*' },
  ],
};
const conversation: any = { id: threadId, name: '黑暗中的信号', cwd, preview: '', status: { type: 'idle' }, turns: [history] };
const empty: any = { id: 'terminal-empty', name: '新的对话', cwd, preview: '', status: { type: 'idle' }, turns: [] };
const threads = [conversation, empty];
const bus = new EventEmitter(), calls: { method: string; params: any }[] = [], replies: WireMessage[] = [];
const initial = { model: 'fixture', reasoningEffort: 'high', approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user' };
let starts = 0;
const emit = (method: string, params: object) => bus.emit('message', { method, params: { threadId, ...params } });
const codex = {
  on: bus.on.bind(bus),
  send: (reply: WireMessage) => { replies.push(reply); emit('serverRequest/resolved', { requestId: reply.id }); },
  request: async <T>(method: string, params: any): Promise<T> => {
    calls.push({ method, params: structuredClone(params) });
    const selected = threads.find(thread => thread.id === params.threadId) ?? conversation;
    let result: unknown;
    if (method === 'config/read') result = { config: { model: 'fixture', model_reasoning_effort: 'high', model_provider: 'fixture', approval_policy: 'on-request', sandbox_mode: 'read-only' } };
    else if (method === 'model/list') result = { data: [
      { id: 'fixture', model: 'fixture', displayName: 'Codex · 模拟协议', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
      { id: 'fixture-alt', model: 'fixture-alt', displayName: '第二模型 · 模拟协议', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    ], nextCursor: null };
    else if (method === 'thread/list') result = { data: threads, nextCursor: null };
    else if (method === 'thread/read') result = { thread: selected };
    else if (method === 'thread/resume') result = { thread: selected, ...initial };
    else if (method === 'thread/turns/list') result = { data: [...selected.turns].reverse(), nextCursor: null };
    else if (method === 'thread/items/list') result = { data: selected.turns.find((turn: any) => turn.id === params.turnId).items.map((item: any) => ({ turnId: params.turnId, item })), nextCursor: null };
    else if (method === 'turn/start') {
      const turn = { ...history, id: `terminal-active-${++starts}`, status: 'inProgress', startedAt: null, completedAt: null, durationMs: null,
        items: [{ id: `active-user-${starts}`, type: 'userMessage', content: params.input },
          { id: `active-progress-${starts}`, type: 'agentMessage', phase: 'commentary', text: '模拟执行过程：正在检查显示效果。' }] };
      conversation.turns.push(turn); conversation.status = { type: 'active', activeFlags: [] }; result = { turn };
      setTimeout(() => { emit('turn/started', { turn }); emit('thread/status/changed', { status: conversation.status }); }, 30);
    } else if (method === 'turn/interrupt') {
      const turn = conversation.turns.at(-1); turn.status = 'interrupted'; conversation.status = { type: 'idle' };
      emit('turn/completed', { turn }); emit('thread/status/changed', { status: conversation.status }); result = {};
    } else throw new Error(`Unexpected terminal fixture request: ${method}`);
    return structuredClone(result) as T;
  },
};

await mkdir('.local/evidence/phase4e2b-redesign/terminal-contract', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/phase4e2b-redesign/terminal-contract/run-'));
const themes = new Themes({ source: resolve('themes'), installed: join(output, 'installed'), builtin: resolve('themes') });
const port = Number(process.env.ORACULUM_TERMINAL_UI_PORT ?? '17887'), origin = `http://127.0.0.1:${port}`;
const server = await createServer(new BridgeService(codex, cwd), port, resolve('apps/web/dist'), { themes, testOnlyUnauthenticated: true });
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron-profile') });
let app: ElectronApplication | undefined, browser: Browser | undefined, desktop: Page | undefined, phone: Page | undefined, failure: string | undefined;
const checks: string[] = [], errors: string[] = [], shifts: string[] = [], contentChanges: string[] = [], screenshots: string[] = [], geometry: object[] = [];
const ready = (page: Page) => expect(page.locator('.connection-status')).toContainText('状态已查询', { timeout: 15_000 });
const record = (check: string) => { checks.push(check); console.log('PASS ' + check); };
const surface = (page: Page) => page === phone ? 'mobile' : 'electron';
const size = (page: Page) => page === phone ? { width: 390, height: 844 } : { width: 1512, height: 982 };
const group = (page: Page, id: string) => page.locator(`.turn-process[data-turn-id="${id}"]`);
const projectTrigger = (page: Page) => page.locator('.composer').getByRole('button', { name: /^项目：/ });
const moreTrigger = (page: Page) => page.getByRole('button', { name: '更多操作', exact: true });
const dialog = (page: Page, name: string) => page.getByRole('dialog', { name, exact: true });
async function settle(page: Page) { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(180); }
async function resize(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  // Mobile shell height is updated by the real visualViewport resize listener.
  // Waiting for that event avoids measuring the previous IME viewport's layout.
  if (page === phone) await expect.poll(() => page.evaluate(() => ({
    width: innerWidth, height: visualViewport?.height ?? innerHeight,
    appHeight: Number.parseFloat(document.documentElement.style.getPropertyValue('--app-height')),
  }))).toEqual({ width: viewport.width, height: viewport.height, appHeight: viewport.height });
}
async function settings(page: Page) {
  if (await page.locator('.app-settings').isVisible()) return;
  if (page === phone && !await page.locator('.app-shell').evaluate(element => element.classList.contains('drawer-open'))) await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click(); await expect(page.getByLabel('当前主题')).toBeEnabled();
}
async function closeSettings(page: Page) {
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  if (page === phone && await page.locator('.app-shell').evaluate(element => element.classList.contains('drawer-open'))) await page.getByRole('button', { name: '折叠导航', exact: true }).click();
}
async function theme(page: Page, id: string) {
  await settings(page); await page.getByLabel('当前主题').selectOption(id);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme-id', id); await closeSettings(page); await settle(page);
}
async function session(page: Page, id: string) {
  if (page === phone) await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.locator(`.session-link[data-thread-id="${id}"]`).click(); await ready(page);
  await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', id);
}
async function shot(page: Page, name: string) {
  await settle(page); await page.mouse.move(1, 1);
  const filename = `${surface(page)}-${name}.png`; await page.screenshot({ path: join(output, filename) }); screenshots.push(filename);
}
async function controls(page: Page) {
  return page.locator('button,input,textarea,select,summary,a[href],[role="button"],[role="radio"],[role="menuitem"],[role="separator"]').evaluateAll(elements => elements.flatMap((element, index) => {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || !element.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }) || element.closest('[hidden]')) return [];
    return [{ key: `${index}:${element.tagName}:${element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent?.trim() ?? ''}`,
      x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
  }));
}
async function displayedContent(page: Page) {
  return page.locator('.app-shell').evaluate(root => ({
    text: root.textContent,
    pseudoText: [root, ...Array.from(root.querySelectorAll('*'))].flatMap((element, index) => ['::before', '::after'].flatMap(pseudo => {
      const content = getComputedStyle(element, pseudo).content;
      return ['none', 'normal', '""', "''"].includes(content) ? [] : [{ index, tag: element.tagName, pseudo, content }];
    })),
  }));
}
// Compare the same real application state through its real theme selector.
// Control order/count detects invented or concealed controls, in addition to
// coordinate changes; no substitute DOM or stylesheet supplies the baseline.
async function sameControls(page: Page, name: string, open = async () => {}, close = async () => {}, viewport = size(page)) {
  const captures = [], contents = [];
  for (const id of ['oracle-eye', terminal]) {
    await resize(page, size(page)); await theme(page, id); await resize(page, viewport); await settle(page);
    await open(); await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 0; }); await settle(page);
    captures.push(await controls(page)); contents.push(await displayedContent(page));
    if (id === terminal) await shot(page, name);
    await close();
  }
  const [baseline, themed] = captures;
  if (JSON.stringify(contents[0]) !== JSON.stringify(contents[1])) contentChanges.push(`${surface(page)}/${name}: DOM text or nonempty pseudo-element content differs`);
  if (baseline.length !== themed.length) shifts.push(`${surface(page)}/${name}: count ${baseline.length} → ${themed.length}`);
  for (let index = 0; index < Math.min(baseline.length, themed.length); index++) {
    if (baseline[index].key !== themed[index].key) shifts.push(`${surface(page)}/${name}: order ${baseline[index].key} → ${themed[index].key}`);
    for (const axis of ['x', 'y', 'width', 'height'] as const) if (Math.abs(baseline[index][axis] - themed[index][axis]) > 0.5) {
      shifts.push(`${surface(page)}/${name}: ${baseline[index].key} ${axis} ${baseline[index][axis]} → ${themed[index][axis]}`);
    }
  }
  geometry.push({ surface: surface(page), state: name, viewport, baseline, themed, contentUnchanged: JSON.stringify(contents[0]) === JSON.stringify(contents[1]) });
  await resize(page, size(page));
}
async function inViewport(page: Page, selector: string) {
  const bounds = (await page.locator(selector).boundingBox())!, viewport = page.viewportSize()!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1); expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
}
try {
  await server.listen({ host: '127.0.0.1', port }); console.log('Terminal runtime evidence: ' + output);
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  await expect.poll(() => app!.windows().some(page => page.url().startsWith(origin)), { timeout: 15_000 }).toBe(true);
  desktop = app.windows().find(page => page.url().startsWith(origin))!; desktop.on('pageerror', error => errors.push(error.message));
  await desktop.setViewportSize(size(desktop)); await ready(desktop);
  browser = await chromium.launch();
  phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
    userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36 OraculumAndroid/1' });
  phone.on('pageerror', error => errors.push(error.message)); await phone.goto(origin); await ready(phone);
  const pages = [desktop, phone];
  for (const page of pages) {
    await settings(page); await expect(page.getByLabel('当前主题').locator(`option[value="${terminal}"]`)).toContainText('内置');
    await expect(page.getByLabel('当前主题').locator('option[value="hong-kong-neon"]')).toContainText('内置');
    await closeSettings(page); await theme(page, terminal); await page.reload(); await ready(page);
    await expect(page.locator('.app-shell')).toHaveAttribute('data-theme-id', terminal);
  }
  expect(await readdir(themes.paths.installed).catch(() => [])).toEqual([]); expect(starts).toBe(0);
  record('both built-in themes remain available; Old Terminal needs no install, survives reload, and switching creates no native turn');

  for (const page of pages) {
    await sameControls(page, 'conversation');
    await expect(page.locator('[data-item-id="user"] .message-name')).toHaveText('你');
    await expect(page.locator('[data-item-id="answer"] .message-name')).toHaveText('Codex');
    await expect(page.locator('[data-item-id="answer"] .markdown h2')).toHaveText('黑暗之中，信号浮现。');
    for (const [name, trigger] of [['project', projectTrigger(page)], ['model', modelTrigger(page)], ['permission', permissionTrigger(page)], ['more', moreTrigger(page)]] as const) {
      await sameControls(page, name + '-menu', async () => {
        await trigger.click(); await inViewport(page, '.composer-popover');
        if (name === 'more') { await expect(dialog(page, '更多操作')).toHaveText(''); await expect(dialog(page, '更多操作').locator('*')).toHaveCount(0); }
      }, async () => { await page.keyboard.press('Escape'); });
    }
    for (const level of ['模型', '思考强度'] as const) {
      await sameControls(page, level === '模型' ? 'model-options' : 'effort-options', async () => {
        await modelTrigger(page).click(); await expect(dialog(page, '模型与思考强度').getByRole('button')).toHaveCount(2);
        await dialog(page, '模型与思考强度').getByRole('button', { name: level, exact: true }).click();
        await expect(dialog(page, '模型与思考强度').getByRole('radiogroup', { name: level, exact: true })).toBeVisible();
        await expect(dialog(page, '模型与思考强度').locator('[aria-checked="true"]')).toHaveCount(1);
      }, async () => { await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); });
    }
    await sameControls(page, 'settings', async () => { await settings(page); await page.locator('.app-settings').evaluate(element => { element.scrollTop = 0; }); }, async () => { await closeSettings(page); });
    await sameControls(page, 'process', async () => { await group(page, history.id).locator('.process-toggle').click(); }, async () => { await group(page, history.id).locator('.process-toggle').click(); });
    await sameControls(page, 'inspector', async () => {
      await group(page, history.id).locator('.process-toggle').click(); await page.getByRole('button', { name: '查看 Diff', exact: true }).first().click();
      await expect(page.locator('.cm-content')).toContainText('+cool green phosphor'); expect(await page.locator('.cm-content').getAttribute('contenteditable')).not.toBe('true');
    }, async () => { await page.getByRole('button', { name: '关闭面板', exact: true }).click(); await group(page, history.id).locator('.process-toggle').click(); });
    await session(page, empty.id); await sameControls(page, 'empty-home'); await session(page, threadId);
  }
  await sameControls(phone, 'drawer', async () => { await phone!.getByRole('button', { name: '打开导航', exact: true }).click(); }, async () => { await phone!.getByRole('button', { name: '折叠导航', exact: true }).click(); });
  for (const [width, height] of [[375, 812], [844, 390], [390, 430], [782, 99]]) {
    await sameControls(phone, `${width}x${height}`, undefined, undefined, { width, height }); await resize(phone, { width, height });
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const selector of ['.composer textarea', '.send-button']) { await inViewport(phone, selector); expect((await phone.locator(selector).boundingBox())!.height).toBeGreaterThanOrEqual(44); }
  }
  for (const [name, trigger] of [['permission', permissionTrigger(phone)], ['more', moreTrigger(phone)]] as const) {
    await sameControls(phone, `782x99-${name}`, async () => { await trigger.click(); await inViewport(phone!, '.composer-popover'); }, async () => { await phone!.keyboard.press('Escape'); }, { width: 782, height: 99 });
  }
  await resize(phone, size(phone));
  record('default/theme geometry covers every composer menu, both menu levels, cards, settings, process, Diff, homepage, drawer and narrow/landscape/IME viewports');

  for (const page of pages) {
    for (const [name, trigger] of [['项目', projectTrigger(page)], ['模型与思考强度', modelTrigger(page)], ['权限', permissionTrigger(page)], ['更多操作', moreTrigger(page)]] as const) {
      await trigger.click(); await expect(dialog(page, name)).toBeVisible(); await page.keyboard.press('Escape'); await expect(dialog(page, name)).toHaveCount(0);
      await trigger.click(); await page.locator('.conversation-header').click({ position: { x: 100, y: 20 } }); await expect(dialog(page, name)).toHaveCount(0);
      if (page === phone) { await trigger.click(); expect(await page.evaluate(() => (window as any).oraculumAndroidBack())).toBe(true); await expect(dialog(page, name)).toHaveCount(0); }
    }
    await modelTrigger(page).click(); const menu = dialog(page, '模型与思考强度');
    await expect(menu.getByRole('button', { name: '模型', exact: true })).toBeFocused(); await page.keyboard.press('Enter');
    await expect(menu.locator('[role="radio"][aria-checked="true"]')).toBeFocused(); await page.keyboard.press('End'); await page.keyboard.press('Home');
    await menu.getByRole('button', { name: '返回模型与思考强度', exact: true }).click(); await expect(menu.getByRole('button')).toHaveCount(2);
    await menu.getByRole('button', { name: '思考强度', exact: true }).click();
    if (page === phone) expect(await page.evaluate(() => (window as any).oraculumAndroidBack())).toBe(true); else await page.keyboard.press('Escape');
    await expect(menu.getByRole('button', { name: '思考强度', exact: true })).toBeFocused(); await page.keyboard.press('Escape'); await expect(modelTrigger(page)).toBeFocused();
    await selectModel(page, 'fixture-alt'); await expect(modelTrigger(page)).toHaveAccessibleName(/第二模型/);
    await selectModel(page, 'fixture'); await selectEffort(page, 'low'); await expect(modelTrigger(page)).toHaveAccessibleName(/low/); await selectEffort(page, 'high');
    await selectPermission(page, 'full-access'); await expect(permissionTrigger(page)).toHaveClass(/full-access/);
    const warning = await page.locator('.app-shell').evaluate(element => {
      const hex = getComputedStyle(element).getPropertyValue('--warning').trim();
      return `rgb(${[1, 3, 5].map(start => Number.parseInt(hex.slice(start, start + 2), 16)).join(', ')})`;
    });
    await permissionTrigger(page).hover(); await expect(permissionTrigger(page)).toHaveCSS('color', warning);
    await page.mouse.move(1, 1); await selectPermission(page, 'read-only');
  }
  expect(starts).toBe(0);
  record('all menus support Escape/outside close/Android Back simulation; two-level focus/back navigation and model/effort/permission choices work without sends');

  for (const page of pages) {
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256; const context = canvas.getContext('2d')!;
      context.fillStyle = '#001d14'; context.fillRect(0, 0, 256, 256); context.strokeStyle = '#7bffd1'; context.lineWidth = 12;
      context.beginPath(); context.arc(128, 128, 72, 0, Math.PI * 2); context.stroke(); return canvas.toDataURL('image/png').split(',')[1];
    });
    for (const [role, label, nickname] of [['user', '用户', '夜行者'], ['assistant', 'Codex', '回声']] as const) {
      await settings(page); const card = page.locator(`.identity-card[data-identity-role="${role}"]`);
      await card.getByLabel(`${label}昵称`, { exact: true }).fill(nickname + (page === phone ? ' · 移动' : ' · 桌面'));
      await card.getByLabel(`${label}头像文件`, { exact: true }).setInputFiles({ name: 'fixture-avatar.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
      await expect(card.getByLabel('裁切预览', { exact: true })).toBeVisible(); await card.getByLabel(`${label}头像缩放`, { exact: true }).fill('1.3');
      await card.getByRole('button', { name: '使用此头像', exact: true }).click(); await card.getByRole('button', { name: `保存${label}身份`, exact: true }).click(); await closeSettings(page);
    }
    await expect(page.locator('[data-item-id="user"] canvas.custom-avatar')).toBeVisible(); await expect(page.locator('[data-item-id="answer"] canvas.custom-avatar')).toBeVisible();
    await sameControls(page, 'both-custom-identities'); await page.reload(); await ready(page);
    await expect(page.locator('[data-item-id="user"] .message-name')).toHaveText('夜行者' + (page === phone ? ' · 移动' : ' · 桌面'));
    await expect(page.locator('[data-item-id="answer"] .message-name')).toHaveText('回声' + (page === phone ? ' · 移动' : ' · 桌面'));
  }
  await expect(desktop.locator('[data-item-id="user"] .message-name')).toHaveText('夜行者 · 桌面');
  for (const page of pages) {
    await settings(page); for (const label of ['用户', 'Codex']) await page.getByRole('button', { name: `重置${label}身份`, exact: true }).click(); await closeSettings(page);
    await expect(page.locator('[data-item-id="user"] .message-name')).toHaveText('你'); await expect(page.locator('[data-item-id="answer"] .message-name')).toHaveText('Codex');
  }
  expect(JSON.stringify(calls)).not.toMatch(/夜行者|回声|data:image/);
  record('both identity roles accept local PNG crop/save/reset; custom canvases and nicknames retain layout, persist on reload and remain device-local');

  for (const page of pages) {
    await page.getByLabel('消息', { exact: true }).fill('继续检查这束清冷的绿光。'); await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeEnabled(); await sameControls(page, 'active-stop');
    const active = conversation.turns.at(-1);
    for (const decision of ['允许本次', '拒绝']) {
      const requestId = 1200 + replies.length;
      bus.emit('message', { id: requestId, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: active.id, itemId: String(requestId), command: 'printf simulated', cwd } });
      const button = page.getByRole('button', { name: decision, exact: true }); await expect(button).toBeEnabled();
      if (decision === '允许本次') await sameControls(page, 'approval');
      await button.scrollIntoViewIfNeeded(); await button.click(); for (const client of pages) await expect(client.locator('.approval')).toHaveCount(0);
    }
    await page.getByRole('button', { name: '停止', exact: true }).click();
    for (const client of pages) { await expect(group(client, active.id).locator('.process-status')).toContainText('已中断'); await expect(group(client, active.id).locator('.process-toggle')).toHaveCount(0); }
    await sameControls(page, 'interrupted');
  }
  expect(starts).toBe(2); expect(replies.map(reply => reply.result)).toEqual([{ decision: 'accept' }, { decision: 'decline' }, { decision: 'accept' }, { decision: 'decline' }]);
  const failed = { ...history, id: 'terminal-failed', status: 'inProgress', startedAt: null, completedAt: null, durationMs: null, items: [
    { id: 'failed-progress', type: 'agentMessage', phase: 'commentary', text: '模拟失败：检查输出保留，等待处理。' },
    { id: 'failed-command', type: 'commandExecution', command: 'fixture-check', cwd, status: 'failed', exitCode: 7, durationMs: 10, aggregatedOutput: 'SIMULATED_DISPLAY_CHECK_FAILURE' },
  ], error: null as any };
  conversation.turns.push(failed); emit('turn/started', { turn: failed }); failed.status = 'failed'; failed.error = { message: '模拟错误：显示检查未通过。' }; emit('turn/completed', { turn: failed });
  for (const page of pages) {
    await expect(group(page, failed.id).locator('.process-status')).toContainText('执行失败'); await expect(group(page, failed.id).getByRole('alert')).toContainText('模拟错误');
    await expect(group(page, failed.id).locator('[data-item-id="failed-progress"]')).toBeVisible(); await expect(group(page, failed.id).locator('.process-toggle')).toHaveCount(0);
    await sameControls(page, 'failed');
  }
  record('real UI send/allow/decline/stop handlers synchronize fixture events without replay; interrupted and failed states keep progress and actionable errors visible');

  await desktop.getByLabel('消息', { exact: true }).fill('主题恢复后保留这段草稿');
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.getMenuItemById('restore-default-theme')!.click(); });
  await ready(desktop); await expect(desktop.locator('.app-shell')).toHaveAttribute('data-theme-id', 'oracle-eye');
  await expect(desktop.getByLabel('消息', { exact: true })).toHaveValue('主题恢复后保留这段草稿'); await expect(phone.locator('.app-shell')).toHaveAttribute('data-theme-id', terminal);
  await settings(phone); await phone.getByRole('button', { name: '恢复默认主题', exact: true }).click(); await closeSettings(phone);
  await expect(phone.locator('.app-shell')).toHaveAttribute('data-theme-id', 'oracle-eye');
  for (const page of pages) {
    await theme(page, terminal); await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await page.evaluate(() => [...document.getAnimations()].every(animation => Number(animation.effect?.getTiming().duration ?? 0) <= 1))).toBe(true);
    const scanLayer = await page.locator('.app-shell').evaluate(element => {
      const style = getComputedStyle(element, '::after');
      return { content: style.content, pointerEvents: style.pointerEvents, animationName: style.animationName };
    });
    expect(['none', 'normal', '""', "''"]).toContain(scanLayer.content); expect(scanLayer.pointerEvents).toBe('none'); expect(scanLayer.animationName).toBe('none');
  }
  expect(calls.filter(call => call.method === 'turn/start')).toHaveLength(2);
  record('native Electron recovery and mobile default reset retain draft/device independence; reduced-motion is respected and decoration contains no labels or click targets');
  expect(errors).toEqual([]); expect(shifts, 'Old Terminal must preserve every recorded real control and its bounds').toEqual([]);
  expect(contentChanges, 'Old Terminal must not fabricate DOM text or nonempty pseudo-element content').toEqual([]);
  record('all default/Old Terminal control inventories, ordering and coordinates match within 0.5 CSS px; DOM text and nonempty pseudo-element content are identical');
} catch (error) {
  failure = String(error); process.exitCode = 1; console.error(error);
  for (const page of [desktop, phone]) if (page && !page.isClosed()) await shot(page, 'failure').catch(() => {});
} finally {
  await app?.close(); await browser?.close(); await server.close();
  await writeFile(join(output, 'geometry.json'), JSON.stringify({ tolerance: 0.5, shifts, contentChanges, states: geometry }, null, 2));
  await writeFile(join(output, 'report.json'), JSON.stringify({ output, date: new Date().toISOString(), realElectron: true, emulatedAndroid: true,
    simulatedNative: true, physicalAndroid: false, checks, screenshots, errors, shifts, contentChanges, failure, passed: !failure }, null, 2));
  console.log(JSON.stringify({ output, checks: checks.length, screenshots: screenshots.length, coordinateDifferences: shifts.length, contentDifferences: contentChanges.length, passed: !failure }));
}
