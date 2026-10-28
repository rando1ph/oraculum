// Chromium mobile viewports and Codex protocol are simulated. No Android device,
// ADB, production Bridge, user data, or native Codex process is used.
import { chromium, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import { Themes } from '../bridge/src/themes';
import { modelTrigger, permissionTrigger } from './composer-controls';

const cwd = '/controlled-mobile-menu', threadId = 'mobile-menu-long-message';
const turn: any = { id: 'menu-turn', status: 'completed', error: null, itemsView: 'full', items: [
  { id: 'long-answer', type: 'agentMessage', phase: 'final_answer', text: '## 会话菜单遮挡回归\n\n' + Array.from({ length: 24 }, (_, i) => `段落 ${i + 1}：这是模拟协议的长消息，用于检查霓虹玻璃卡片与顶部菜单的真实浏览器层级。菜单中的三个操作应保持完整可见，并收到点击。`).join('\n\n') },
  { id: 'file', type: 'fileChange', status: 'completed', changes: [{ path: cwd + '/menu.txt', kind: { type: 'update', move_path: null }, diff: '--- a/menu.txt\n+++ b/menu.txt\n@@ -1 +1 @@\n-covered\n+reachable\n' }] },
] };
const thread: any = { id: threadId, name: '长消息 · 菜单层级回归', cwd, preview: '', status: { type: 'idle' }, turns: [turn] };
const threads = [thread], requests: string[] = [], bus = new EventEmitter();
const options = { model: 'fixture', reasoningEffort: 'high', approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user' };
const codex = {
  on: bus.on.bind(bus), send: () => {},
  request: async <T>(method: string, params: any): Promise<T> => {
    requests.push(method); let value: unknown;
    const selected = threads.find(value => value.id === params.threadId) ?? thread;
    if (method === 'config/read') value = { config: { model: 'fixture', model_reasoning_effort: 'high', model_provider: 'fixture', approval_policy: 'on-request', sandbox_mode: 'read-only' } };
    else if (method === 'model/list') value = { data: [{ id: 'fixture', model: 'fixture', displayName: '模拟模型', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], nextCursor: null };
    else if (method === 'thread/list') value = { data: threads, nextCursor: null };
    else if (method === 'thread/read') value = { thread: selected };
    else if (method === 'thread/resume') value = { thread: selected, ...options };
    else if (method === 'thread/turns/list') value = { data: [...selected.turns].reverse(), nextCursor: null };
    else if (method === 'thread/items/list') value = { data: selected.turns.find((turn: any) => turn.id === params.turnId).items.map((item: any) => ({ turnId: params.turnId, item })), nextCursor: null };
    else if (method === 'thread/start') {
      const created = { ...thread, id: `created-${threads.length}`, name: '新建模拟会话', turns: [] }; threads.push(created); value = { thread: created, ...options };
    } else throw new Error(`Unexpected mobile menu fixture request: ${method}`);
    return structuredClone(value) as T;
  },
};
await mkdir('.local/evidence/r1-b1/menu', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/r1-b1/menu/run-'));
const themes = new Themes({ source: resolve('themes'), installed: join(output, 'installed'), builtin: resolve('themes') });
const port = Number(process.env.ORACULUM_MENU_UI_PORT ?? '17892'), origin = `http://127.0.0.1:${port}`;
const server = await createServer(new BridgeService(codex, cwd), port, resolve('apps/web/dist'), { themes, testOnlyUnauthenticated: true });
const checks: string[] = [], errors: string[] = [], snapshots: object[] = [];
let browser: Browser | undefined, page: Page | undefined, failure: string | undefined;
const ready = () => expect(page!.locator('.connection-status')).toContainText('状态已查询', { timeout: 15_000 });
const record = (name: string) => { checks.push(name); console.log('PASS ' + name); };
const settle = () => page!.waitForTimeout(100);
async function setTheme(id: string) {
  await page!.setViewportSize({ width: 390, height: 844 });
  await page!.getByRole('button', { name: '打开导航', exact: true }).click();
  await page!.getByRole('button', { name: '设置', exact: true }).click();
  await page!.getByLabel('当前主题').selectOption(id);
  await expect(page!.locator('.app-shell')).toHaveAttribute('data-theme-id', id);
  await page!.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page!.getByRole('button', { name: '折叠导航', exact: true }).click();
  await settle();
}
async function hit(locator: Locator, name: string) {
  await expect(locator).toBeVisible();
  const result = await locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    const points = [[box.x + box.width / 2, box.y + box.height / 2], [box.x + 8, box.y + 8], [box.right - 8, box.bottom - 8]];
    return { width: box.width, height: box.height, x: box.x, y: box.y, right: box.right, bottom: box.bottom,
      hits: points.map(([x, y]) => { const target = document.elementFromPoint(x, y); return { ok: !!target && element.contains(target), target: target?.tagName + '.' + target?.className }; }) };
  });
  expect(result.height, `${name}: touch height`).toBeGreaterThanOrEqual(44);
  expect(result.width, `${name}: touch width`).toBeGreaterThanOrEqual(44);
  expect(result.y, `${name}: top bound`).toBeGreaterThanOrEqual(0);
  expect(result.bottom, `${name}: bottom bound`).toBeLessThanOrEqual(page!.viewportSize()!.height + 1);
  expect(result.hits.every(value => value.ok), `${name}: actual hit targets ${JSON.stringify(result.hits)}`).toBe(true);
}
async function rawClick(locator: Locator) {
  const box = (await locator.boundingBox())!;
  await page!.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
async function menuSnapshot(name: string) {
  snapshots.push({ name, viewport: page!.viewportSize(), ...(await page!.evaluate(() => ({
    styles: ['.conversation', '.conversation-header', '.mobile-session-menu', '.conversation-scroll', '.message', '.composer', '.inspector', '.navigation'].map(selector => {
      const element = document.querySelector(selector); if (!element) return { selector, absent: true };
      const style = getComputedStyle(element); const box = element.getBoundingClientRect();
      return { selector, position: style.position, zIndex: style.zIndex, overflow: style.overflow, backdropFilter: style.backdropFilter, transform: style.transform, isolation: style.isolation, opacity: style.opacity, bounds: { x: box.x, y: box.y, width: box.width, height: box.height } };
    }),
    items: Array.from(document.querySelectorAll('.mobile-session-menu button')).map(element => {
      const box = element.getBoundingClientRect(), target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { label: element.textContent, receivesClick: !!target && element.contains(target), actualTarget: target?.tagName + '.' + target?.className };
    }),
  }))) });
}
try {
  await server.listen({ host: '127.0.0.1', port }); browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message)); await page.goto(origin); await ready();
  // Neon first: the old Header's backdrop-filter traps the child's z-index
  // below the later message cards. Preserve screenshot and hit results on failure.
  for (const theme of ['hong-kong-neon', 'oracle-eye', 'old-terminal', 'minimal-light']) {
    await setTheme(theme);
    for (const [width, height] of [[390, 844], [844, 390], [390, 260], [390, 180]]) {
      await page.setViewportSize({ width, height }); await settle();
      await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 0; });
      await page.getByRole('button', { name: '会话菜单', exact: true }).click();
      const menu = page.getByRole('menu', { name: '会话操作', exact: true });
      await expect(menu.getByRole('menuitem')).toHaveText(['新建会话', '查询状态', '当前会话操作', '项目成果', '会话用量', '设置']);
      await menuSnapshot(`${theme}-${width}x${height}`);
      if (theme === 'hong-kong-neon' && height === 844) await page.screenshot({ path: join(output, 'neon-menu-portrait.png') });
      const bounds = (await menu.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
      expect(bounds.y).toBe(60); expect(width - bounds.x - bounds.width).toBe(12);
      for (const name of ['新建会话', '查询状态', '当前会话操作', '项目成果', '会话用量', '设置']) {
        const item = menu.getByRole('menuitem', { name, exact: true });
        await item.scrollIntoViewIfNeeded(); await hit(item, `${theme}/${width}x${height}/${name}`);
      }
      if (theme === 'hong-kong-neon' && height === 180) await page.screenshot({ path: join(output, 'neon-menu-short-ime.png') });
      const before = requests.filter(value => value === 'thread/read').length;
      const query = menu.getByRole('menuitem', { name: '查询状态', exact: true }); await query.scrollIntoViewIfNeeded(); await rawClick(query);
      await expect(menu).toHaveCount(0); await expect.poll(() => requests.filter(value => value === 'thread/read').length).toBeGreaterThan(before); await ready();
      record(`${theme} ${width}x${height}: 5 menu items retain order, >=44px targets, viewport bounds and real hit testing; status click reaches Bridge`);
    }
    await page.setViewportSize({ width: 390, height: 844 }); await settle();
    await page.getByRole('button', { name: '会话菜单', exact: true }).click();
    await rawClick(page.getByRole('menuitem', { name: '设置', exact: true }));
    await hit(page.getByRole('button', { name: '关闭设置', exact: true }), `${theme}/settings`);
    await rawClick(page.getByRole('button', { name: '关闭设置', exact: true }));
    // Leave the header menu open under each overlay to detect stacking regressions.
    await page.getByRole('button', { name: '会话菜单', exact: true }).click();
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
    await hit(page.getByRole('button', { name: '折叠导航', exact: true }), `${theme}/drawer`);
    expect(await page.locator('.conversation').getAttribute('inert')).not.toBeNull();
    await rawClick(page.getByRole('button', { name: '折叠导航', exact: true })); await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 430 }); await settle();
    await modelTrigger(page).click();
    // Keyboard activation keeps both overlays open without the normal outside
    // pointerdown closing the Composer menu. Hit-test the resulting overlap.
    await page.getByRole('button', { name: '会话菜单', exact: true }).focus();
    await page.getByRole('button', { name: '会话菜单', exact: true }).press('Enter');
    const sessionMenu = page.getByRole('menu', { name: '会话操作', exact: true });
    const composerMenu = page.getByRole('dialog', { name: '模型与思考强度', exact: true });
    const sessionBounds = (await sessionMenu.boundingBox())!, composerBounds = (await composerMenu.boundingBox())!;
    expect(composerBounds.y).toBeLessThan(sessionBounds.y + sessionBounds.height);
    expect(composerBounds.y + composerBounds.height).toBeGreaterThan(sessionBounds.y);
    await hit(sessionMenu.getByRole('menuitem', { name: '设置', exact: true }), `${theme}/header above overlapping composer`);
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await modelTrigger(page).click();
    await hit(page.getByRole('dialog', { name: '模型与思考强度', exact: true }).getByRole('button', { name: '模型', exact: true }), `${theme}/composer`);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 }); await settle();
    await page.locator('.process-toggle').click();
    await page.getByRole('button', { name: '查看 Diff', exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: '会话菜单', exact: true }).click();
    await page.getByRole('button', { name: '查看 Diff', exact: true }).click();
    await expect(page.locator('.mobile-session-menu')).toHaveCount(1);
    await hit(page.getByRole('button', { name: '关闭面板', exact: true }), `${theme}/inspector`);
    expect(await page.locator('.conversation').getAttribute('inert')).not.toBeNull();
    await rawClick(page.getByRole('button', { name: '关闭面板', exact: true })); await page.keyboard.press('Escape'); await page.locator('.process-toggle').click();
    await page.setViewportSize({ width: 782, height: 99 }); await settle();
    await expect(page.getByRole('button', { name: '会话菜单', exact: true })).toBeHidden();
    await hit(page.getByRole('button', { name: '发送', exact: true }), `${theme}/extreme IME send`);
    await permissionTrigger(page).click();
    const panel = page.getByRole('dialog', { name: '权限', exact: true });
    const permission = panel.getByRole('radio').first(); await permission.scrollIntoViewIfNeeded(); await hit(permission, `${theme}/extreme IME permission`);
    await page.keyboard.press('Escape');
    record(`${theme}: Settings, Drawer, Composer, Inspector and extreme 782x99 IME targets stay reachable without click-through`);
  }
  await page.setViewportSize({ width: 390, height: 844 }); await settle();
  await page.getByRole('button', { name: '会话菜单', exact: true }).click();
  await rawClick(page.getByRole('menuitem', { name: '新建会话', exact: true }));
  await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', 'created-1');
  expect(requests.filter(value => value === 'thread/start')).toHaveLength(1); expect(requests).not.toContain('turn/start');
  expect(errors).toEqual([]); record('New session click reaches existing handler once; no model turn or browser error');
} catch (error) {
  failure = String(error); process.exitCode = 1; console.error(error);
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
} finally {
  await browser?.close(); await server.close();
  await writeFile(join(output, 'report.json'), JSON.stringify({ date: new Date().toISOString(), passed: !failure, simulatedCodex: true, chromiumMobileViewports: true, physicalAndroid: false, checks, snapshots, errors, failure }, null, 2));
  console.log(JSON.stringify({ output, checks: checks.length, passed: !failure }));
}
