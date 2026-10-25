// Real Electron and mobile Chromium; the genuine app and Bridge render a controlled
// protocol fixture. Android device, native Codex and IME behavior are NOT validated.
// Reuses the existing same-state UI contract mechanics, never visual references.
import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import { Themes } from '../bridge/src/themes';
import { modelTrigger, permissionTrigger, selectPermission } from './composer-controls';
import type { WireMessage } from '../packages/shared/protocol';

const cwd = '/Oraculum', id = 'terminal-last-transmission', terminal = 'old-terminal';
const history: any = { id: 'archive-observation', status: 'completed', error: null, itemsView: 'full',
  startedAt: 1_792_900_800, completedAt: 1_792_900_842, durationMs: 42_000, items: [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text: '如果这台机器比我们所在的宇宙更古老，它还记得什么？', text_elements: [] }] },
    { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: '在被时间磨损的磁迹之间，辨认一束尚未熄灭的回声。' },
    { id: 'reasoning', type: 'reasoning', summary: ['模拟公开过程：整理古老机器与平行宇宙的文学意象。'], content: [] },
    { id: 'command', type: 'commandExecution', command: 'printf "the machine remembers the first dawn\\n"', cwd, status: 'completed', exitCode: 0, durationMs: 20, aggregatedOutput: 'the machine remembers the first dawn\n' },
    { id: 'file', type: 'fileChange', status: 'completed', changes: [{ path: cwd + '/archive.txt', kind: { type: 'update', move_path: null }, diff: '--- a/archive.txt\n+++ b/archive.txt\n@@ -1 +1,2 @@\n-The archive is silent.\n+The machine remembers the first dawn.\n+A small amber light outlives the stars.\n' }] },
    { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '## 比星辰更古老的回声。\n\n它记得第一颗恒星点亮之前的寂静。磁芯里保存着另一种时间，琥珀色的余辉划过玻璃，像一段终于抵达的低语。\n\n> 黑暗并不是空白。\n> 是机器还没有说完的话。\n\n*模拟协议会话 · 仅用于主题运行时验收*' },
  ] };
const thread: any = { id, name: '最后一次传讯', cwd, preview: '', status: { type: 'idle' }, turns: [history] };
const empty: any = { id: 'terminal-empty', name: '未开启的档案', cwd, preview: '', status: { type: 'idle' }, turns: [] };
const threads = [thread, empty];
const bus = new EventEmitter(), calls: string[] = [], replies: WireMessage[] = [];
let starts = 0;
const initial = { model: 'fixture', reasoningEffort: 'high', approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user' };
const emit = (method: string, params: object) => bus.emit('message', { method, params: { threadId: id, ...params } });
const codex = {
  on: bus.on.bind(bus),
  send: (reply: WireMessage) => { replies.push(reply); emit('serverRequest/resolved', { requestId: reply.id }); },
  request: async <T>(method: string, params: any): Promise<T> => {
    calls.push(method); let value: unknown;
    const selected = threads.find(entry => entry.id === params.threadId) ?? thread;
    if (method === 'config/read') value = { config: { model: 'fixture', model_reasoning_effort: 'high', model_provider: 'fixture', approval_policy: 'on-request', sandbox_mode: 'read-only' } };
    else if (method === 'model/list') value = { data: [
      { id: 'fixture', model: 'fixture', displayName: 'Codex · 模拟协议', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
      { id: 'fixture-alt', model: 'fixture-alt', displayName: '第二模型 · 模拟协议', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    ], nextCursor: null };
    else if (method === 'thread/list') value = { data: threads, nextCursor: null };
    else if (method === 'thread/read') value = { thread: selected };
    else if (method === 'thread/resume') value = { thread: selected, ...initial };
    else if (method === 'thread/turns/list') value = { data: [...selected.turns].reverse(), nextCursor: null };
    else if (method === 'thread/items/list') value = { data: selected.turns.find((turn: any) => turn.id === params.turnId).items.map((item: any) => ({ turnId: params.turnId, item })), nextCursor: null };
    else if (method === 'turn/start') {
      const turn = { ...history, id: `terminal-active-${++starts}`, status: 'inProgress', items: [{ id: `active-user-${starts}`, type: 'userMessage', content: params.input }], startedAt: null, completedAt: null, durationMs: null };
      thread.turns.push(turn); thread.status = { type: 'active', activeFlags: [] }; value = { turn };
      setTimeout(() => { emit('turn/started', { turn }); emit('thread/status/changed', { status: thread.status }); }, 30);
    } else if (method === 'turn/interrupt') {
      const turn = thread.turns.at(-1); turn.status = 'interrupted'; thread.status = { type: 'idle' };
      emit('turn/completed', { turn }); emit('thread/status/changed', { status: thread.status }); value = {};
    } else throw new Error(`Unexpected terminal fixture request: ${method}`);
    return structuredClone(value) as T;
  },
};
await mkdir('.local/evidence/phase4e2b/terminal-contract', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/phase4e2b/terminal-contract/run-'));
const themes = new Themes({ source: resolve('themes'), installed: join(output, 'installed'), builtin: resolve('themes') });
const service = new BridgeService(codex, cwd);
const port = Number(process.env.ORACULUM_TERMINAL_UI_PORT ?? '17887'), origin = `http://127.0.0.1:${port}`;
const server = await createServer(service, port, resolve('apps/web/dist'), { themes, testOnlyUnauthenticated: true });
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron-profile') });
let app: ElectronApplication | undefined, browser: Browser | undefined, desktop: Page | undefined, phone: Page | undefined;
const checks: string[] = [], errors: string[] = [], geometry: object[] = [], shifts: string[] = [], screenshots: string[] = [];
let failure: string | undefined;
const record = (value: string) => { checks.push(value); console.log('PASS ' + value); };
const ready = (page: Page) => expect(page.locator('.connection-status')).toContainText('状态已查询', { timeout: 15_000 });
const label = (page: Page) => page === phone ? 'mobile' : 'electron';
async function settle(page: Page) { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(200); }
async function settings(page: Page) {
  if (await page.locator('.app-settings').isVisible()) return;
  if (page === phone && !await page.locator('.app-shell').evaluate(e => e.classList.contains('drawer-open'))) await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('当前主题')).toBeEnabled();
}
async function closeSettings(page: Page) {
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  if (page === phone && await page.locator('.app-shell').evaluate(e => e.classList.contains('drawer-open'))) await page.getByRole('button', { name: '折叠导航', exact: true }).click();
}
async function theme(page: Page, value: string) {
  await settings(page); await page.getByLabel('当前主题').selectOption(value);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme-id', value); await closeSettings(page); await settle(page);
}
async function session(page: Page, value: string) {
  if (page === phone) await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.locator(`.session-link[data-thread-id="${value}"]`).click(); await ready(page);
  await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', value);
}
async function shot(page: Page, name: string) {
  await settle(page); await page.mouse.move(1, 1);
  const filename = `${label(page)}-${name}.png`; await page.screenshot({ path: join(output, filename) }); screenshots.push(filename);
}
async function controls(page: Page) {
  return page.locator('button,input,textarea,select,summary,[role="separator"]').evaluateAll(elements => elements.flatMap((element, index) => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || !element.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }) || style.visibility === 'hidden' || style.display === 'none' || element.closest('[hidden]')) return [];
    return [{ key: `${index}:${element.tagName}:${element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent?.trim() ?? ''}`,
      x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
  }));
}
// Both captures use the genuine settings selector. No replacement stylesheet or
// mock DOM is used to obtain the default layout or the themed screenshot.
async function sameControls(page: Page, name: string, open = async () => {}, close = async () => {}, viewport?: { width: number; height: number }) {
  const baselineSize = page === phone ? { width: 390, height: 844 } : { width: 1512, height: 982 };
  const captures = [];
  for (const themeId of ['oracle-eye', terminal]) {
    await page.setViewportSize(baselineSize); await theme(page, themeId);
    if (viewport) { await page.setViewportSize(viewport); await settle(page); }
    await open();
    await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 0; }); await settle(page);
    captures.push(await controls(page));
    if (themeId === terminal) await shot(page, name);
    await close();
  }
  const [baseline, themed] = captures;
  if (baseline.length !== themed.length) shifts.push(`${label(page)}/${name}: control count ${baseline.length} → ${themed.length}`);
  for (let i = 0; i < Math.min(baseline.length, themed.length); i++) {
    if (baseline[i].key !== themed[i].key) shifts.push(`${label(page)}/${name}: order ${baseline[i].key} → ${themed[i].key}`);
    for (const axis of ['x', 'y', 'width', 'height'] as const) if (Math.abs(baseline[i][axis] - themed[i][axis]) > 0.5) {
      shifts.push(`${label(page)}/${name}: ${baseline[i].key} ${axis} ${baseline[i][axis]} → ${themed[i][axis]}`);
    }
  }
  geometry.push({ surface: label(page), state: name, viewport: viewport ?? baselineSize, baseline, themed });
  await page.setViewportSize(baselineSize);
}
async function mobileGeometry(width: number, height: number) {
  const page = phone!; await page.setViewportSize({ width, height }); await settle(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const locator of [page.getByLabel('消息', { exact: true }), page.getByRole('button', { name: '发送', exact: true })]) {
    const bounds = (await locator.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(height + 1);
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
  }
}
try {
  await server.listen({ host: '127.0.0.1', port });
  console.log(`Old Terminal runtime evidence: ${output}`);
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  await expect.poll(() => app!.windows().some(page => page.url().startsWith(origin)), { timeout: 15_000 }).toBe(true);
  desktop = app.windows().find(page => page.url().startsWith(origin))!;
  desktop.on('pageerror', error => errors.push(error.message)); await desktop.setViewportSize({ width: 1512, height: 982 }); await ready(desktop);
  browser = await chromium.launch();
  phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
    userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36 OraculumAndroid/1' });
  phone.on('pageerror', error => errors.push(error.message)); await phone.goto(origin); await ready(phone);
  for (const page of [desktop, phone]) {
    await settings(page);
    await expect(page.getByLabel('当前主题').locator(`option[value="${terminal}"]`)).toContainText('内置');
    await expect(page.getByLabel('当前主题').locator(`option[value="${terminal}"]`)).toContainText('Old Terminal · 古老终端');
    await closeSettings(page); await theme(page, terminal);
    await page.reload(); await ready(page); await expect(page.locator('.app-shell')).toHaveAttribute('data-theme-id', terminal);
  }
  expect(await readdir(themes.paths.installed).catch(() => [])).toEqual([]);
  expect(calls).not.toContain('turn/start');
  record('Old Terminal is selectable out of box on both clients, without installation; reload preserves device choice and creates no model turn');

  for (const page of [desktop, phone]) {
    await sameControls(page, 'conversation');
    await expect(page.locator('[data-item-id="user"] .message-name')).toHaveText('你');
    await expect(page.locator('[data-item-id="answer"] .message-name')).toHaveText('Codex');
    await expect(page.locator('[data-item-id="answer"] .markdown h2')).toHaveText('比星辰更古老的回声。');
    await expect(page.locator('.message-avatar').first()).toBeVisible();
    await expect(page.locator('.process-records').first()).toBeHidden();
    await sameControls(page, 'project-menu', async () => { await page.getByRole('button', { name: /^项目：/ }).click(); }, async () => { await page.keyboard.press('Escape'); });
    await sameControls(page, 'more-menu', async () => {
      await page.getByRole('button', { name: '更多操作', exact: true }).click();
      await expect(page.getByRole('dialog', { name: '更多操作', exact: true }).getByRole('button')).toHaveCount(0);
    }, async () => { await page.keyboard.press('Escape'); });
    await sameControls(page, 'model-menu', async () => { await modelTrigger(page).click(); }, async () => { await page.keyboard.press('Escape'); });
    const menu = page.getByRole('dialog', { name: '模型与思考强度', exact: true });
    for (const level of ['模型', '思考强度'] as const) await sameControls(page, level === '模型' ? 'model-options' : 'effort-options', async () => {
      await modelTrigger(page).click(); await expect(menu.getByRole('button')).toHaveCount(2); await menu.getByRole('button', { name: level, exact: true }).click();
      await expect(menu.getByRole('radiogroup', { name: level, exact: true })).toBeVisible(); await expect(menu.locator('[aria-checked="true"]')).toHaveCount(1);
    }, async () => { await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); });
    await sameControls(page, 'permission-menu', async () => { await permissionTrigger(page).click(); }, async () => { await page.keyboard.press('Escape'); });
    const turnsBeforePermission = calls.filter(method => method === 'turn/start').length;
    await selectPermission(page, 'full-access');
    const permission = permissionTrigger(page);
    await expect(permission).toHaveClass(/full-access/);
    for (const state of ['closed', 'hover', 'expanded']) {
      if (state === 'hover') await permission.hover();
      else {
        if (state === 'expanded') await permission.click();
        await page.mouse.move(1, 1);
      }
      await expect(permission).toHaveAttribute('aria-expanded', state === 'expanded' ? 'true' : 'false');
      await expect.poll(() => permission.evaluate(element => {
        const style = getComputedStyle(element);
        const warning = style.getPropertyValue('--warning').trim();
        if (!warning || !CSS.supports('color', warning)) return false;
        // Normalize both CSS colors using the browser, without inserting test UI.
        const color = document.createElement('canvas').getContext('2d')!;
        color.fillStyle = style.color; const actual = color.fillStyle;
        color.fillStyle = warning;
        return actual === color.fillStyle;
      }), { message: `${label(page)} Full Access ${state} must retain --warning color` }).toBe(true);
    }
    await page.keyboard.press('Escape'); await selectPermission(page, 'read-only');
    await expect(permission).not.toHaveClass(/full-access/);
    expect(calls.filter(method => method === 'turn/start')).toHaveLength(turnsBeforePermission);
    await sameControls(page, 'settings', async () => {
      await settings(page); await page.locator('.app-settings').evaluate(element => { element.scrollTop = 0; });
    }, async () => { await closeSettings(page); });
    await sameControls(page, 'process', async () => {
      await page.locator('.process-toggle').first().click(); await expect(page.locator('.process-records').first()).toBeVisible();
      await expect(page.locator('[data-item-id="answer"]')).toBeVisible();
    }, async () => {
      await page.locator('.process-toggle').first().click(); await expect(page.locator('.process-records').first()).toBeHidden();
    });
    await sameControls(page, 'inspector', async () => {
      await page.locator('.process-toggle').first().click(); await page.getByRole('button', { name: '查看 Diff', exact: true }).first().click();
      await expect(page.locator('.cm-content')).toContainText('+The machine remembers the first dawn.');
    }, async () => {
      await page.getByRole('button', { name: '关闭面板', exact: true }).click(); await page.locator('.process-toggle').first().click();
    });
    await session(page, empty.id); await expect(page.locator('.empty-state')).toBeVisible(); await sameControls(page, 'empty-home'); await session(page, id);
  }
  record('Full Access retains the warning color when closed, hovered and expanded on both surfaces; restoring Read Only starts no model turn');
  await sameControls(phone, 'drawer', async () => { await phone!.getByRole('button', { name: '打开导航', exact: true }).click(); }, async () => { await phone!.getByRole('button', { name: '折叠导航', exact: true }).click(); });
  for (const [width, height] of [[375, 812], [844, 390], [390, 430], [782, 99]]) {
    await sameControls(phone, `${width}x${height}`, undefined, undefined, { width, height }); await mobileGeometry(width, height);
  }
  for (const [name, trigger] of [['permission', permissionTrigger(phone)], ['more', phone.getByRole('button', { name: '更多操作', exact: true })]] as const) {
    await sameControls(phone, `782x99-${name}-menu`, async () => {
      await trigger.click();
      const bounds = (await phone!.locator('.composer-popover').boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(783); expect(bounds.y + bounds.height).toBeLessThanOrEqual(100);
    }, async () => { await phone!.keyboard.press('Escape'); }, { width: 782, height: 99 });
  }
  await phone.setViewportSize({ width: 390, height: 844 });
  record('runtime screenshots cover conversation, project/empty + menus, both model menu levels, permissions, process, Diff, empty homepage, drawer and portrait/landscape/short IME layouts');

  for (const page of [desktop, phone]) {
    await settings(page);
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
      const ctx = canvas.getContext('2d')!; const gradient = ctx.createLinearGradient(0, 0, 256, 256);
      gradient.addColorStop(0, '#f1c87e'); gradient.addColorStop(1, '#694326'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, 256, 256);
      ctx.fillStyle = '#100d09'; ctx.beginPath(); ctx.arc(128, 128, 70, 0, Math.PI * 2); ctx.fill(); return canvas.toDataURL('image/png').split(',')[1];
    });
    for (const [role, name, nickname] of [['user', '用户', '守望最后一束琥珀余辉的档案管理员'], ['assistant', 'Codex', '来自另一个宇宙的神谕']] as const) {
      const card = page.locator(`.identity-card[data-identity-role="${role}"]`);
      await card.getByLabel(`${name}昵称`, { exact: true }).fill(nickname);
      await card.getByLabel(`${name}头像文件`, { exact: true }).setInputFiles({ name: 'fixture-avatar.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
      await expect(card.getByLabel('裁切预览', { exact: true })).toBeVisible();
      await expect(card.getByLabel(`${name}头像缩放`, { exact: true })).toBeEnabled();
      await card.getByRole('button', { name: '使用此头像', exact: true }).click();
      await card.getByRole('button', { name: `保存${name}身份`, exact: true }).click();
      await expect(card.getByRole('status')).toHaveText('已保存到本机');
    }
    await closeSettings(page);
    await expect(page.locator('[data-item-id="user"] canvas.custom-avatar')).toBeVisible();
    await expect(page.locator('[data-item-id="answer"] canvas.custom-avatar')).toBeVisible();
    await expect(page.locator('[data-item-id="user"] .message-name')).toHaveText('守望最后一束琥珀余辉的档案管理员');
    await expect(page.locator('[data-item-id="answer"] .message-name')).toHaveText('来自另一个宇宙的神谕');
    await sameControls(page, 'custom-identity');
    await settings(page);
    await page.getByRole('button', { name: '重置用户身份', exact: true }).click();
    await page.getByRole('button', { name: '重置Codex身份', exact: true }).click(); await closeSettings(page);
    await expect(page.locator('[data-item-id="user"] .message-name')).toHaveText('你');
    await expect(page.locator('[data-item-id="answer"] .message-name')).toHaveText('Codex');
  }
  record('both user and Codex local identity editors, long nicknames, PNG upload, crop, save, custom canvas avatars and reset work on both surfaces');

  for (const page of [desktop, phone]) {
    await page.getByLabel('消息', { exact: true }).fill('模拟协议验收：继续读取这段文学档案。'); await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeEnabled();
    await sameControls(page, 'active-stop');
    const active = thread.turns.at(-1);
    for (const decision of ['允许本次', '拒绝']) {
      const requestId = 900 + replies.length;
      bus.emit('message', { id: requestId, method: 'item/commandExecution/requestApproval', params: { threadId: id, turnId: active.id, itemId: String(requestId), command: 'printf simulated', cwd } });
      const button = page.getByRole('button', { name: decision, exact: true }); await expect(button).toBeEnabled(); await button.scrollIntoViewIfNeeded();
      if (decision === '允许本次') {
        await sameControls(page, 'approval-layout'); await button.scrollIntoViewIfNeeded(); await shot(page, 'approval');
      }
      await button.click(); for (const client of [desktop, phone]) await expect(client.locator('.approval')).toHaveCount(0);
    }
    await page.getByRole('button', { name: '停止', exact: true }).click();
    for (const client of [desktop, phone]) await expect(client.locator('.conversation')).toHaveAttribute('data-last-turn-status', 'interrupted');
  }
  expect(starts).toBe(2); expect(replies.map(reply => reply.result)).toEqual([{ decision: 'accept' }, { decision: 'decline' }, { decision: 'accept' }, { decision: 'decline' }]);
  record('both themed clients send, allow, decline and stop through existing Bridge handlers; native fixture events synchronize without replay');

  await desktop.getByLabel('消息', { exact: true }).fill('恢复默认后仍保留的草稿');
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.getMenuItemById('restore-default-theme')!.click(); });
  await ready(desktop); await expect(desktop.locator('.app-shell')).toHaveAttribute('data-theme-id', 'oracle-eye');
  await expect(desktop.getByLabel('消息', { exact: true })).toHaveValue('恢复默认后仍保留的草稿');
  await expect(phone.locator('.app-shell')).toHaveAttribute('data-theme-id', terminal);
  await settings(phone); await phone.getByRole('button', { name: '恢复默认主题', exact: true }).click(); await closeSettings(phone);
  await expect(phone.locator('.app-shell')).toHaveAttribute('data-theme-id', 'oracle-eye');
  await theme(desktop, terminal); await theme(phone, terminal);
  for (const page of [desktop, phone]) {
    await page.emulateMedia({ reducedMotion: 'reduce' }); await settle(page);
    expect(await page.evaluate(() => [...document.getAnimations()].every(animation => Number(animation.effect?.getTiming().duration ?? 0) <= 1))).toBe(true);
  }
  expect(calls.filter(method => method === 'turn/start')).toHaveLength(2);
  record('Electron native menu and mobile settings restore Oracle Eye; draft/device independence preserved; reduced motion disables atmospheric animation');

  expect(errors).toEqual([]);
  expect(shifts, 'Old Terminal must preserve actual control order and coordinates').toEqual([]);
  record('all recorded default/Old Terminal states have identical control order and bounds within 0.5 CSS px');
} catch (error) {
  failure = String(error); process.exitCode = 1; console.error(error);
  for (const page of [desktop, phone]) if (page && !page.isClosed()) await shot(page, 'failure').catch(() => {});
} finally {
  await app?.close(); await browser?.close(); await server.close();
  await writeFile(join(output, 'geometry.json'), JSON.stringify({ tolerance: 0.5, shifts, states: geometry }, null, 2));
  await writeFile(join(output, 'report.json'), JSON.stringify({ output, date: new Date().toISOString(), realElectron: true, emulatedAndroid: true,
    simulatedNative: true, physicalAndroid: false, checks, screenshots, errors, shifts, failure, passed: !failure }, null, 2));
  console.log(JSON.stringify({ output, checks: checks.length, screenshots: screenshots.length, coordinateDifferences: shifts.length, passed: !failure }));
}
