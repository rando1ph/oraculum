// Same 600-message controlled history before/after; real Electron and opt-in
// Android Debug. Measures backing pixels/decode lifecycle, not GPU/process RSS.
import { _electron as electron, chromium, expect, type Browser, type Cookie, type ElectronApplication, type Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import { ReceiptStore } from '../bridge/src/receipts';
import { TrustStore } from '../bridge/src/trust-store';

const realAndroid = process.argv.includes('--android'), optimized = process.argv.includes('--optimized');
const count = 600, cwd = '/Avatar-Performance', origin = 'http://127.0.0.1:17860', port = 17860;
const base = resolve('.local/evidence/phase4d5/performance'); await mkdir(base, { recursive: true, mode: 0o700 });
const output = await mkdtemp(join(base, optimized ? 'after-' : 'before-')); console.log('Evidence: ' + output);
const web = join(output, 'web'); await cp(resolve('apps/web/dist'), web, { recursive: true });
const thread = (id: string, name: string, length: number): any => ({ id, name, cwd, preview: '', status: { type: 'idle' }, turns: length ? [{ id: id + '-turn', status: 'completed', error: null, itemsView: 'full', durationMs: 1000, startedAt: null, completedAt: null,
  items: Array.from({ length }, (_, n) => n % 2 === 0 ? { id: `${id}-${n}`, type: 'userMessage', content: [{ type: 'text', text: `合成消息 ${n + 1}：头像性能验收。`, text_elements: [] }] } : { id: `${id}-${n}`, type: 'agentMessage', phase: 'final_answer', text: `合成回答 ${n + 1}：保持双方身份、滚动和阅读。` }) }] : [] });
const threads = [thread('long-a', '600 条合成消息 A', count), thread('empty', '空会话 · 资源释放', 0), thread('long-b', '600 条合成消息 B', count)];
const bus = new EventEmitter(), nativeCalls: string[] = [];
const codex = { on: bus.on.bind(bus), send: () => { throw new Error('Unexpected approval'); }, request: async <T>(method: string, params: any): Promise<T> => {
  nativeCalls.push(method); const selected = threads.find(t => t.id === params?.threadId) ?? threads[0]; let result: unknown;
  if (method === 'config/read') result = { config: { model: null, model_provider: null } };
  else if (method === 'model/list') result = { data: [], nextCursor: null };
  else if (method === 'thread/list') result = { data: threads, nextCursor: null };
  else if (method === 'thread/read') result = { thread: selected };
  else if (method === 'thread/resume') result = { thread: selected, approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user' };
  else if (method === 'thread/turns/list') result = { data: selected.turns, nextCursor: null };
  else if (method === 'thread/items/list') {
    const start = Number(params.cursor ?? 0), items = selected.turns[0].items;
    result = { data: items.slice(start, start + 100).map((item: any) => ({ turnId: params.turnId, item })), nextCursor: start + 100 < items.length ? String(start + 100) : null };
  } else throw new Error('Unexpected native method ' + method);
  return structuredClone(result) as T;
} };
const trust = new TrustStore(join(output, 'trust')), service = new BridgeService(codex, cwd, new ReceiptStore(trust.db));
const server = await createServer(service, port, web, { trust });
const errors: string[] = [], cleanupErrors: string[] = [], checks: string[] = [], measurements: Record<string, unknown> = {};
const evidence: Record<string, unknown> = { optimized, messageCount: count, realElectron: true, realAndroid, nativeProtocol: 'controlled paginated fixture; no model calls', measurements, checks, errors, cleanupErrors,
  sourceGit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), buildIndexSha256: createHash('sha256').update(await readFile(join(web, 'index.html'))).digest('hex') };
let app: ElectronApplication | undefined, phoneBrowser: Browser | undefined, desktop: Page | undefined, phone: Page | undefined;
let backup: { local: Record<string, string>; session: Record<string, string> } | undefined, cookies: Cookie[] | undefined, previousReverse: string | undefined, forwarded: string | undefined, reversed = false;
const adbArgs = process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : [];
const adb = (...args: string[]) => execFileSync('adb', [...adbArgs, ...args], { encoding: 'utf8', timeout: 20000 }).trim();
function stopped() { try { return execFileSync('systemctl', ['--user', 'is-active', 'oraculum-bridge.service'], { encoding: 'utf8' }).trim() === 'inactive'; } catch (error) { return String((error as any).stdout).trim() === 'inactive'; } }
function observe(page: Page) { page.on('pageerror', error => errors.push(error.message)); }
// Test-only instrumentation installed before application JS on every document.
function instrument() {
  const probe = { calls: 0, closes: 0, live: 0, pending: 0, draws: 0, drawMs: 0, decodeMs: 0, longTasks: [] as number[] };
  (window as any).avatarProbe = probe;
  const create = window.createImageBitmap.bind(window), close = ImageBitmap.prototype.close;
  const tracked = new WeakSet<ImageBitmap>(), closed = new WeakSet<ImageBitmap>();
  window.createImageBitmap = (async (...args: any[]) => {
    probe.calls++; probe.pending++; const start = performance.now();
    try { const bitmap = await (create as any)(...args); tracked.add(bitmap); probe.live++; probe.decodeMs += performance.now() - start;
      if ((window as any).holdAvatarDecodes) await new Promise<void>(resolve => { ((window as any).heldAvatarDecodes ??= []).push(resolve); });
      return bitmap; }
    finally { probe.pending--; }
  }) as typeof createImageBitmap;
  ImageBitmap.prototype.close = function() { if (tracked.has(this) && !closed.has(this)) { closed.add(this); probe.closes++; probe.live--; } return close.call(this); };
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function(...args: any[]) {
    const start = performance.now(); const result = (draw as any).apply(this, args);
    if (this.canvas.classList.contains('custom-avatar')) { probe.draws++; probe.drawMs += performance.now() - start; } return result;
  };
  try { new PerformanceObserver(list => { for (const entry of list.getEntries()) probe.longTasks.push(entry.duration); }).observe({ type: 'longtask', buffered: true }); } catch { /* Unsupported metric is omitted. */ }
}
async function pair(page: Page) {
  if (await page.getByLabel('配对码', { exact: true }).isVisible()) {
    await page.getByLabel('设备名称', { exact: true }).fill('头像性能验收'); await page.getByLabel('配对码', { exact: true }).fill(trust.createPairing().code); await page.getByRole('button', { name: '配对并连接' }).click();
  }
  await expect(page.locator('.app-shell')).toBeVisible(); await expect(page.locator('.connection-status')).toContainText('状态已查询');
}
async function select(page: Page, id: string, length: number) {
  if (await page.getByRole('button', { name: '打开导航', exact: true }).isVisible()) await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.locator(`.session-link`).filter({ hasText: threads.find(t => t.id === id).name }).click();
  await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', id); await expect(page.locator('.message')).toHaveCount(length);
  if (length) await expect.poll(() => page.locator('.message canvas.custom-avatar:not([hidden])').count(), { timeout: 30000 }).toBe(length);
  await expect.poll(() => page.evaluate(() => (window as any).avatarProbe.pending), { timeout: 30000 }).toBe(0);
}
async function settings(page: Page) {
  if (await page.getByRole('button', { name: '打开导航', exact: true }).isVisible()) await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
}
async function closeSettings(page: Page) {
  await page.getByRole('button', { name: '关闭设置' }).click();
  if (await page.locator('.app-shell').evaluate(el => el.classList.contains('drawer-open'))) await page.getByRole('button', { name: '折叠导航', exact: true }).click();
}
async function snapshot(page: Page) {
  return page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>('.message canvas'));
    const sizes: Record<string, number> = {};
    for (const c of canvases) { const key = `${c.width}x${c.height}`; sizes[key] = (sizes[key] ?? 0) + 1; }
    return { ...((window as any).avatarProbe), dpr: devicePixelRatio, canvases: canvases.length, pixels: canvases.reduce((sum, c) => sum + c.width * c.height, 0), sizes,
      cssSize: canvases.length ? { width: getComputedStyle(canvases[0]).width, height: getComputedStyle(canvases[0]).height } : null };
  });
}
async function run(page: Page, label: string) {
  const result: Record<string, any> = {}; measurements[label] = result; observe(page);
  await page.goto(origin + '/auth/session');
  const images = await page.evaluate(() => {
    const painter = { create(color: string, mark: string) { const c = document.createElement('canvas'); c.width = c.height = 256; const ctx = c.getContext('2d')!; ctx.fillStyle = color; ctx.fillRect(0, 0, 256, 256); ctx.fillStyle = '#fff'; ctx.font = 'bold 140px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(mark, 128, 175); return c.toDataURL('image/webp', 0.86); } };
    return { user: painter.create('#176182', 'U'), assistant: painter.create('#543085', 'A'), replacement: painter.create('#8e334f', 'R') };
  });
  await page.evaluate(images => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('oraculum.identities.v1:/', JSON.stringify({ version: 1, user: { nickname: '测试用户', avatar: images.user }, assistant: { nickname: '测试神谕', avatar: images.assistant } })); }, images);
  await page.addInitScript(instrument); await page.goto(origin); await pair(page);
  const start = await page.evaluate(() => performance.now()); await select(page, 'long-a', count);
  result.initial = { ...(await snapshot(page)), displayMs: await page.evaluate(() => performance.now()) - start, readyFromNavigationMs: await page.evaluate(() => performance.now()) };
  assert.equal(result.initial.calls, optimized ? 2 : count);
  if (optimized) { assert.ok(result.initial.pixels < count * 256 * 256); assert.equal(result.initial.live, 2); }
  result.scroll = await page.evaluate(async () => {
    const scroller = document.querySelector('.conversation-scroll')!; const gaps: number[] = []; let previous = performance.now();
    for (let n = 0; n < 90; n++) { await new Promise(requestAnimationFrame); const now = performance.now(); gaps.push(now - previous); previous = now; scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * n / 89; }
    return { frames: gaps.length, maxGapMs: Math.max(...gaps), meanGapMs: gaps.reduce((a, b) => a + b, 0) / gaps.length, over50ms: gaps.filter(n => n > 50).length, reachedBottom: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 2 };
  }); assert.equal(result.scroll.reachedBottom, true);
  const beforeSwitch = await page.evaluate(() => performance.now()); await select(page, 'empty', 0); result.empty = await snapshot(page);
  assert.equal(result.empty.live, 0); await select(page, 'long-b', count); result.switched = { ...(await snapshot(page)), elapsedMs: await page.evaluate(() => performance.now()) - beforeSwitch };
  await page.reload(); await pair(page); await expect(page.locator('.message')).toHaveCount(count); await expect.poll(() => page.locator('.message canvas:not([hidden])').count(), { timeout: 30000 }).toBe(count); result.reloaded = await snapshot(page);
  assert.equal(result.reloaded.calls, optimized ? 2 : count);
  await settings(page); const user = page.locator('[data-identity-role="user"]'); await user.getByLabel('用户昵称', { exact: true }).fill('改名仍清晰'); await user.getByRole('button', { name: '保存用户身份' }).click();
  result.nickname = await snapshot(page); assert.equal(result.nickname.calls, optimized ? 2 : count + 2);
  await user.locator('input[type=file]').setInputFiles({ name: 'replacement.webp', mimeType: 'image/webp', buffer: Buffer.from(images.replacement.split(',')[1], 'base64') });
  await expect(user.locator('.avatar-crop-preview')).toBeVisible(); assert.equal(await user.locator('.avatar-crop-preview').evaluate((c: HTMLCanvasElement) => c.width), 256);
  await user.getByRole('button', { name: '使用此头像' }).click(); await user.getByRole('button', { name: '保存用户身份' }).click(); await closeSettings(page);
  await expect.poll(() => page.evaluate(() => (window as any).avatarProbe.pending)).toBe(0); result.replaced = await snapshot(page);
  await expect(page.locator('.message.user .message-name').first()).toHaveText('改名仍清晰'); await expect(page.locator('.agent-message .message-name').first()).toHaveText('测试神谕');
  const colors = await page.locator('.message canvas').evaluateAll(nodes => [nodes[0], nodes[1]].map(node => { const c = node as HTMLCanvasElement; return [...c.getContext('2d')!.getImageData(0, 0, 1, 1).data]; })); assert.notDeepEqual(colors[0], colors[1]); assert.ok(colors[0][0] > 100 && colors[0][2] < 110, 'Replacement must show the new rose image, not the prior teal image');
  await page.screenshot({ path: join(output, `${label}-long-session.png`), scale: 'css' });
  if (optimized) {
    await page.addStyleTag({ content: '.message-heading .message-avatar { width: 80px !important; height: 80px !important; flex-basis: 80px !important; }' });
    result.resizeSamples = [];
    await expect.poll(async () => { try { const sample = await page.evaluate(() => { const c = document.querySelector<HTMLCanvasElement>('.message canvas')!; return { width: c.width, dpr: devicePixelRatio, css: getComputedStyle(c).width }; }); result.resizeSamples.push(sample); return sample.width; } catch (error) { result.resizeSamples.push({ error: String(error) }); throw error; } }).toBe(Math.min(256, Math.ceil(80 * result.initial.dpr)));
    result.resized = await snapshot(page); assert.equal(result.resized.calls, result.replaced.calls);
  }
  if (optimized) {
    // Hold a fully decoded preview until its consumers have saved/reset it.
    // Resolving it afterward must close the stale bitmap and keep user defaults.
    await settings(page);
    await user.locator('input[type=file]').setInputFiles({ name: 'rapid.webp', mimeType: 'image/webp', buffer: Buffer.from(images.user.split(',')[1], 'base64') });
    await expect(user.locator('.avatar-crop-preview')).toBeVisible();
    await page.evaluate(() => { (window as any).holdAvatarDecodes = true; (window as any).heldAvatarDecodes = []; });
    await user.getByRole('button', { name: '使用此头像' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).heldAvatarDecodes.length)).toBe(1);
    await user.getByRole('button', { name: '保存用户身份' }).click(); await user.getByRole('button', { name: '重置用户身份' }).click();
    await page.evaluate(() => { (window as any).holdAvatarDecodes = false; for (const finish of (window as any).heldAvatarDecodes.splice(0)) finish(); });
    await expect.poll(() => page.evaluate(() => (window as any).avatarProbe.pending)).toBe(0);
    await closeSettings(page); await expect(page.locator('.message.user canvas')).toHaveCount(0); await expect(page.locator('.agent-message canvas')).toHaveCount(count / 2);
    result.cancelledDecode = await snapshot(page); assert.equal(result.cancelledDecode.live, 1);
  }
  await settings(page);
  const resetUser = page.getByRole('button', { name: '重置用户身份' }); if (await resetUser.isEnabled()) await resetUser.click();
  await page.getByRole('button', { name: '重置Codex身份' }).click(); await closeSettings(page);
  await expect.poll(() => page.evaluate(() => (window as any).avatarProbe.live)).toBe(0); result.reset = await snapshot(page);
  if (optimized) assert.equal(result.reset.canvases, 0);
  await select(page, 'empty', 0); result.released = await snapshot(page); assert.equal(result.released.live, 0); assert.equal(result.released.canvases, 0);
  await page.goto(origin + '/auth/session'); assert.equal(await page.locator('canvas.custom-avatar').count(), 0); result.navigated = await snapshot(page);
  console.log(label + ' passed: ' + JSON.stringify(result.initial)); checks.push(label + ': 600 messages, scroll, thread switch, reload, nickname, replace, 256px crop, reset and unmount/navigation');
}
try {
  assert.ok(stopped(), 'Production Bridge must stay stopped');
  await server.listen({ host: '127.0.0.1', port });
  const require = createRequire(resolve('apps/desktop/package.json')), env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron-profile') });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  await expect.poll(() => app!.windows().some(p => p.url().startsWith(origin))).toBe(true); desktop = app.windows().find(p => p.url().startsWith(origin))!; await pair(desktop); await run(desktop, 'electron');
  if (realAndroid) {
    assert.match(adb('shell', 'dumpsys', 'package', 'dev.oraculum.poc'), /DEBUGGABLE/);
    previousReverse = adb('reverse', '--list').split('\n').find(line => line.split(/\s+/)[1] === `tcp:${port}`)?.split(/\s+/)[2]; adb('reverse', `tcp:${port}`, `tcp:${port}`); reversed = true;
    adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'); adb('shell', 'am', 'force-stop', 'dev.oraculum.poc'); adb('shell', 'am', 'start', '-n', 'dev.oraculum.poc/.MainActivity');
    const pid = adb('shell', 'pidof', 'dev.oraculum.poc'); forwarded = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
    await expect.poll(async () => { try { return (await fetch(`http://127.0.0.1:${forwarded}/json/list`).then(r => r.json())).length; } catch { return 0; } }, { timeout: 20000 }).toBeGreaterThan(0);
    phoneBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${forwarded}`, { noDefaults: true }); phone = phoneBrowser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith(origin) || p.url().startsWith('chrome-error://')); assert.ok(phone);
    cookies = (await phone.context().cookies([origin])).filter(c => c.name === 'oraculum_local' && c.path === '/');
    await phone.goto(origin + '/auth/session'); backup = await phone.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })); await writeFile(join(output, 'private-device-backup.json'), JSON.stringify({ cookies, backup }), { mode: 0o600 });
    await phone.context().clearCookies({ name: 'oraculum_local', domain: '127.0.0.1', path: '/' }); await run(phone, 'android-debug');
  }
  assert.ok(!nativeCalls.some(m => m === 'turn/start' || m === 'thread/start')); assert.deepEqual(errors, []); evidence.result = 'passed';
} catch (error) { evidence.result = 'failed'; evidence.error = String(error); if (phone) evidence.failureSnapshot = await snapshot(phone).catch(() => null); process.exitCode = 1; console.log(String(error)); }
finally {
  const clean = async (name: string, fn: () => unknown | Promise<unknown>) => { try { await fn(); } catch (error) { cleanupErrors.push(name + ': ' + String(error)); evidence.result = 'failed'; process.exitCode = 1; } };
  await clean('Electron', () => app?.close());
  if (phone && backup) await clean('phone restore', async () => {
    await phone!.goto(origin + '/auth/session'); await phone!.evaluate(saved => { localStorage.clear(); sessionStorage.clear(); for (const [k, v] of Object.entries(saved.local)) localStorage.setItem(k, v); for (const [k, v] of Object.entries(saved.session)) sessionStorage.setItem(k, v); }, backup!);
    assert.deepEqual(await phone!.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })), backup);
    await phone!.context().clearCookies({ name: 'oraculum_local', domain: '127.0.0.1', path: '/' }); await phone!.context().addCookies(cookies!); assert.deepEqual((await phone!.context().cookies([origin])).filter(c => c.name === 'oraculum_local' && c.path === '/'), cookies); evidence.phoneRestored = true; adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  });
  await clean('CDP', () => phoneBrowser?.close()); if (forwarded) await clean('forward', () => adb('forward', '--remove', `tcp:${forwarded}`));
  if (reversed) await clean('reverse', () => previousReverse ? adb('reverse', `tcp:${port}`, previousReverse) : adb('reverse', '--remove', `tcp:${port}`));
  await clean('Bridge', () => server.close()); await clean('trust', () => trust.close()); evidence.productionBridgeStopped = stopped();
  if (backup && !cleanupErrors.length) await rm(join(output, 'private-device-backup.json'), { force: true });
  await writeFile(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 }); console.log(JSON.stringify({ output, result: evidence.result, errors, cleanupErrors, checks }));
}
