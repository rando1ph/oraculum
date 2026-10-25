// Real Ubuntu Electron and optional real Android Debug; controlled Codex history.
// No model calls. Phone cookies/local/session storage are backed up and restored.
import { _electron as electron, chromium, expect, type Browser, type Cookie, type ElectronApplication, type Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import { ReceiptStore } from '../bridge/src/receipts';
import { TrustStore } from '../bridge/src/trust-store';
import { Themes } from '../bridge/src/themes';

const realAndroid = process.argv.includes('--android');
const port = realAndroid ? 17860 : 17878, origin = `http://127.0.0.1:${port}`;
const base = resolve('.local/evidence/phase4d5'); await mkdir(base, { recursive: true, mode: 0o700 });
const output = await mkdtemp(join(base, 'identity-'));
console.log('Evidence: ' + output);
const cwd = '/Avatar-Review', id = 'local-identity-fixture';
const turn: any = { id: 'completed-turn', status: 'completed', error: null, itemsView: 'full', durationMs: 1200, startedAt: null, completedAt: null, items: [
  { id: 'user', type: 'userMessage', content: [{ type: 'text', text: '让每一段对话，都有熟悉的模样。', text_elements: [] }] },
  { id: 'progress', type: 'agentMessage', text: '正在检查本地显示设置。', phase: 'commentary' },
  { id: 'command', type: 'commandExecution', command: 'node --test', cwd, status: 'completed', exitCode: 0, durationMs: 20, aggregatedOutput: 'pass 1\nfail 0' },
  { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '## 你好，神谕\n\n头像与昵称让对话更亲切。每台设备，都可以保留自己的选择。\n\n- 本机保存，即刻呈现\n- 双方身份，分别设置\n- 执行过程，依然清晰' },
] };
const thread: any = { id, name: '本地身份 · 界面验收', cwd, preview: '', status: { type: 'idle' }, turns: [turn] };
const bus = new EventEmitter(), requests: { method: string; params: unknown }[] = [];
const codex = { on: bus.on.bind(bus), send: () => { throw new Error('No approvals expected'); }, request: async <T>(method: string, params: any): Promise<T> => {
  requests.push({ method, params }); let result: unknown;
  if (method === 'config/read') result = { config: { model: 'fixture', model_provider: 'fixture' } };
  else if (method === 'model/list') result = { data: [], nextCursor: null };
  else if (method === 'thread/list') result = { data: [thread], nextCursor: null };
  else if (method === 'thread/read') result = { thread };
  else if (method === 'thread/resume') result = { thread, approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user' };
  else if (method === 'thread/turns/list') result = { data: [turn], nextCursor: null };
  else if (method === 'thread/items/list') result = { data: turn.items.map((item: any) => ({ turnId: turn.id, item })), nextCursor: null };
  else throw new Error('Unexpected native operation ' + method);
  return structuredClone(result) as T;
} };
const trust = new TrustStore(join(output, 'trust'));
const themes = new Themes({ source: resolve('themes'), installed: join(output, 'themes') });
for (const theme of ['test-violet', 'minimal-light', 'hong-kong-rain']) await themes.install(theme);
const service = new BridgeService(codex, cwd, new ReceiptStore(trust.db));
const server = await createServer(service, port, resolve('apps/web/dist'), { trust, themes });
const require = createRequire(resolve('apps/desktop/package.json'));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(output, 'electron-profile') });
const errors: string[] = [], checks: string[] = [], cleanupErrors: string[] = [], wire: string[] = [];
const configFile = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
const configHash = async () => createHash('sha256').update(await readFile(configFile)).digest('hex');
const beforeConfig = await configHash();
const evidence: Record<string, unknown> = { date: new Date().toISOString(), realElectron: true, realAndroid, nativeProtocol: 'controlled fixture; no model turn', checks, errors, cleanupErrors };
let app: ElectronApplication | undefined, mobile: Browser | undefined, desktop: Page | undefined, phone: Page | undefined;
let backup: { local: Record<string, string>; session: Record<string, string> } | undefined, cookies: Cookie[] | undefined, previousReverse: string | undefined, reverseChanged = false, forwarded: string | undefined;
const adbArgs = process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : [];
const adb = (...args: string[]) => execFileSync('adb', [...adbArgs, ...args], { encoding: 'utf8', timeout: 20000 }).trim();
const key = 'oraculum.identities.v1:/';
const deviceFiles: string[] = [];
let stage = 'setup';
function stopped() { try { return execFileSync('systemctl', ['--user', 'is-active', 'oraculum-bridge.service'], { encoding: 'utf8' }).trim() === 'inactive'; } catch (e) { return String((e as any).stdout).trim() === 'inactive'; } }
function observe(page: Page) { page.on('pageerror', e => errors.push(e.message)); page.on('websocket', socket => socket.on('framesent', frame => wire.push(String(frame.payload)))); }
async function launch() {
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  await expect.poll(() => app!.windows().some(page => page.url().startsWith(origin))).toBe(true);
  desktop = app.windows().find(page => page.url().startsWith(origin))!; observe(desktop); return desktop;
}
async function attachPhone() {
  adb('shell', 'am', 'start', '-n', 'dev.oraculum.poc/.MainActivity');
  const pid = adb('shell', 'pidof', 'dev.oraculum.poc'); assert.match(pid, /^\d+$/);
  forwarded = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
  await expect.poll(async () => { try { return (await fetch(`http://127.0.0.1:${forwarded}/json/list`).then(r => r.json())).length; } catch { return 0; } }).toBeGreaterThan(0);
  mobile = await chromium.connectOverCDP(`http://127.0.0.1:${forwarded}`, { noDefaults: true });
  phone = mobile.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith(origin) || page.url().startsWith('chrome-error://'));
  assert.ok(phone, 'Existing Debug profile must use the USB localhost endpoint'); observe(phone); return phone;
}
async function pair(page: Page) {
  if (await page.getByLabel('配对码', { exact: true }).isVisible()) {
    await page.getByLabel('设备名称', { exact: true }).fill('头像界面验收'); await page.getByLabel('配对码', { exact: true }).fill(trust.createPairing().code);
    await page.getByRole('button', { name: '配对并连接', exact: true }).click();
  }
  await expect(page.locator('.app-shell')).toBeVisible();
}
async function ready(page: Page) {
  await expect(page.locator('.connection-status')).toContainText('状态已查询');
  if (!(await page.locator('.message.user').count())) await page.locator('.session-link').filter({ hasText: thread.name }).click();
  await expect(page.locator('.message.user')).toBeVisible();
}
async function settings(page: Page) {
  if (await page.getByRole('button', { name: '打开导航', exact: true }).isVisible()) await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click(); await expect(page.locator('.identity-settings')).toBeVisible();
}
async function closeSettings(page: Page) {
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  if (await page.locator('.app-shell').evaluate(el => el.classList.contains('drawer-open'))) await page.getByRole('button', { name: '折叠导航', exact: true }).click();
}
const card = (page: Page, role: string) => page.locator(`.identity-card[data-identity-role="${role}"]`);
async function choose(page: Page, role: string, file: string) {
  const chooser = page.waitForEvent('filechooser'); await card(page, role).getByRole('button', { name: /选择图片|替换头像/ }).click();
  await (await chooser).setFiles(file); await expect(card(page, role).locator('.avatar-crop')).toBeVisible();
}
async function useAvatar(page: Page, role: string) {
  await card(page, role).getByRole('button', { name: '使用此头像', exact: true }).click();
  await expect(card(page, role).locator('canvas.custom-avatar')).toBeVisible();
}
async function save(page: Page, role: string, nickname: string) {
  const label = role === 'user' ? '用户' : 'Codex'; await card(page, role).getByLabel(label + '昵称', { exact: true }).fill(nickname);
  await card(page, role).getByRole('button', { name: '保存' + label + '身份', exact: true }).click(); await expect(card(page, role).getByRole('status')).toHaveText('已保存到本机');
}
async function verifyCards(page: Page, user: string, assistant: string, avatars = true) {
  await expect(page.locator('.message.user .message-name')).toHaveText(user); await expect(page.locator('.agent-message .message-name').last()).toHaveText(assistant);
  if (avatars) { await expect(page.locator('.message.user canvas')).toBeVisible(); await expect(page.locator('.agent-message canvas').last()).toBeVisible(); }
  await expect(page.locator('.process-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-item-id="answer"]')).toBeVisible();
}
async function capture(page: Page, name: string) {
  await (name === 'electron-settings' ? page.locator('.app-settings') : page).screenshot({ path: join(output, name + '.png'), animations: 'disabled', scale: 'css' });
  if (realAndroid && page === phone) await writeFile(join(output, name + '-device.png'), execFileSync('adb', [...adbArgs, 'exec-out', 'screencap', '-p'], { maxBuffer: 16 * 1024 * 1024 }));
}
async function invalidFiles(page: Page) {
  const target = card(page, 'user'), before = await page.evaluate(key => localStorage.getItem(key), key);
  const invalid: { name: string; mimeType: string; buffer: Buffer }[] = [
    { name: 'not-an-image.png', mimeType: 'image/png', buffer: Buffer.from('<svg onload="alert(1)"/>') },
    { name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) },
    { name: 'oversize.png', mimeType: 'image/png', buffer: Buffer.alloc(8 * 1024 * 1024 + 1) },
  ];
  const huge = Buffer.alloc(30); huge.set([137, 80, 78, 71, 13, 10, 26, 10]); huge.writeUInt32BE(10000, 16); huge.writeUInt32BE(10000, 20);
  invalid.push({ name: 'huge.png', mimeType: 'image/png', buffer: huge });
  const corrupt = Buffer.from(huge); corrupt.writeUInt32BE(20, 16); corrupt.writeUInt32BE(20, 20);
  invalid.push({ name: 'corrupt.png', mimeType: 'image/png', buffer: corrupt });
  const real = await readFile(join(output, 'avatar.png')); invalid.push({ name: 'mismatch.jpg', mimeType: 'image/jpeg', buffer: real });
  for (const file of invalid) { await target.locator('input[type=file]').setInputFiles(file); await expect(target.getByRole('alert')).toBeVisible(); assert.equal(await page.evaluate(key => localStorage.getItem(key), key), before); }
  await target.getByLabel('用户昵称', { exact: true }).fill('x'.repeat(33)); await target.getByRole('button', { name: '保存用户身份', exact: true }).click(); await expect(target.getByRole('alert')).toContainText('32');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key), before);
  await target.getByLabel('用户昵称', { exact: true }).fill('<img src=x onerror=alert(1)>'); await target.getByRole('button', { name: '保存用户身份', exact: true }).click();
  await closeSettings(page); await expect(page.locator('.message.user .message-name')).toHaveText('<img src=x onerror=alert(1)>'); await expect(page.locator('.message-name img')).toHaveCount(0); await settings(page);
}
async function nativeTap(page: Page, selector: ReturnType<typeof card>) {
  await selector.scrollIntoViewIfNeeded(); const box = await selector.boundingBox(); assert.ok(box);
  const xml = await dump(); const node = xml.match(/<node\b[^>]*>/g)?.find(node => /class="android.webkit.WebView"/.test(node)); assert.ok(node, 'Native WebView bounds');
  const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)!;
  const view = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const ratio = (+bounds[3] - +bounds[1]) / view.width;
  adb('shell', 'input', 'tap', String(Math.round((box.x + box.width / 2) * ratio + +bounds[1])), String(Math.round((box.y + box.height / 2) * ratio + +bounds[2])));
}
async function dump() { adb('shell', 'uiautomator', 'dump', '/sdcard/oraculum-avatar-window.xml'); return adb('shell', 'cat', '/sdcard/oraculum-avatar-window.xml'); }
async function systemTap(pattern: RegExp) {
  const xml = await dump(); const node = xml.match(/<node\b[^>]*>/g)?.find(node => pattern.test(node));
  if (!node) { await writeFile(join(output, 'private-picker-last.xml'), xml, { mode: 0o600 }); return false; }
  const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)!;
  adb('shell', 'input', 'tap', String(Math.round((+bounds[1] + +bounds[3]) / 2)), String(Math.round((+bounds[2] + +bounds[4]) / 2))); return true;
}
async function nativeChoose(page: Page, role: string, filename: string) {
  await nativeTap(page, card(page, role).getByRole('button', { name: /选择图片|替换头像/ }));
  // ACTION_OPEN_DOCUMENT, using the actual Android DocumentsUI activity.
  await expect.poll(async () => /(?:topResumedActivity|mResumedActivity)[^\n]*documentsui/i.test(adb('shell', 'dumpsys', 'activity', 'activities'))).toBe(true);
  if (!(await systemTap(new RegExp(`text="${filename.replaceAll('.', '\\.')}"`)))) {
    await systemTap(/content-desc="(?:显示根目录|Show roots|打开导航抽屉|Open navigation drawer)"/);
    assert.ok(await systemTap(/text="(?:下载|下载内容|Downloads)"[^>]*resource-id="android:id\/title"/), 'System Downloads location');
    if (!(await systemTap(new RegExp(`text="${filename.replaceAll('.', '\\.')}"`)))) {
      // Downloads lists folders first; search the exact generated name instead
      // of scrolling through unrelated personal folders or relying on MediaStore.
      assert.ok(await systemTap(/content-desc="(?:搜索|Search)"/), 'System file search');
      adb('shell', 'input', 'text', filename.match(/\d+/)![0]); adb('shell', 'input', 'keyevent', 'KEYCODE_ENTER');
      await expect.poll(async () => systemTap(new RegExp(`text="${filename.replaceAll('.', '\\.')}"`)), { timeout: 20000 }).toBe(true);
    }
  }
  await expect(card(page, role).locator('.avatar-crop')).toBeVisible({ timeout: 20000 }); console.log('Native picker passed: ' + role + ' ' + filename.split('.').at(-1));
}
try {
  if (realAndroid) { assert.ok(stopped()); assert.match(adb('shell', 'dumpsys', 'package', 'dev.oraculum.poc'), /DEBUGGABLE/); }
  await server.listen({ host: '127.0.0.1', port }); desktop = await launch(); await pair(desktop); await ready(desktop);
  const images = await desktop.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 320; const c = canvas.getContext('2d')!;
    const gradient = c.createLinearGradient(0, 0, 480, 320); gradient.addColorStop(0, '#51b6dd'); gradient.addColorStop(1, '#123759'); c.fillStyle = gradient; c.fillRect(0, 0, 480, 320);
    c.fillStyle = '#d7f7ff'; c.beginPath(); c.arc(240, 125, 55, 0, Math.PI * 2); c.fill(); c.beginPath(); c.ellipse(240, 300, 110, 98, 0, 0, Math.PI * 2); c.fill();
    const png = canvas.toDataURL('image/png'), jpeg = canvas.toDataURL('image/jpeg', 0.9);
    c.fillStyle = '#281c4c'; c.fillRect(0, 0, 480, 320); c.fillStyle = '#cfb5fb'; c.font = 'bold 150px sans-serif'; c.textAlign = 'center'; c.fillText('✦', 240, 220);
    return { png, jpeg, webp: canvas.toDataURL('image/webp', 0.9) };
  });
  for (const [type, data] of Object.entries(images)) await writeFile(join(output, `avatar.${type === 'jpeg' ? 'jpg' : type}`), Buffer.from(data.split(',')[1], 'base64'));
  stage = 'Electron selection/crop/save'; await settings(desktop);
  await card(desktop, 'user').locator('input[type=file]').evaluate(el => el.dispatchEvent(new Event('cancel', { bubbles: true })));
  await expect(desktop.locator('.identity-settings')).toBeVisible();
  await choose(desktop, 'user', join(output, 'avatar.jpg')); await card(desktop, 'user').getByLabel('用户头像缩放').fill('1.4'); await card(desktop, 'user').getByLabel('用户头像水平位置').fill('65'); await useAvatar(desktop, 'user'); await save(desktop, 'user', '星河');
  await choose(desktop, 'assistant', join(output, 'avatar.webp')); await useAvatar(desktop, 'assistant'); await save(desktop, 'assistant', '神谕');
  await desktop.locator('.app-settings').evaluate(el => { el.scrollTop = 0; }); await capture(desktop, 'electron-settings'); await closeSettings(desktop); await verifyCards(desktop, '星河', '神谕');
  await desktop.reload(); await ready(desktop); await verifyCards(desktop, '星河', '神谕');
  await app!.close(); app = undefined; desktop = await launch(); await ready(desktop); await verifyCards(desktop, '星河', '神谕');
  checks.push('Real Ubuntu Electron file input, JPEG/WebP decode, adjustable square crop, both identity saves and reload/full process restart persist');
  stage = 'Electron failures'; await settings(desktop); await invalidFiles(desktop); await save(desktop, 'user', '星河');
  // Force a storage write failure only in this disposable renderer, then restore it.
  await desktop.evaluate(() => { (window as any).originalStorageWrite = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.startsWith('oraculum.identities')) throw new DOMException('Full', 'QuotaExceededError'); (window as any).originalStorageWrite.call(this, key, value); }; });
  await card(desktop, 'user').getByLabel('用户昵称', { exact: true }).fill('未保存'); await card(desktop, 'user').getByRole('button', { name: '保存用户身份' }).click(); await expect(card(desktop, 'user').getByRole('alert')).toContainText('原设置已保留');
  await desktop.evaluate(() => { Storage.prototype.setItem = (window as any).originalStorageWrite; delete (window as any).originalStorageWrite; }); await closeSettings(desktop); await verifyCards(desktop, '星河', '神谕');
  checks.push('Invalid signature/MIME, empty/over-8MB/over-resolution/truncated-decode files and overlong nickname preserve prior config; XSS is text; storage quota error is explicit and atomic');
  if (realAndroid) {
    stage = 'Android backup'; previousReverse = adb('reverse', '--list').split('\n').find(line => line.split(/\s+/)[1] === `tcp:${port}`)?.split(/\s+/)[2]; adb('reverse', `tcp:${port}`, `tcp:${port}`); reverseChanged = true;
    adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'); adb('shell', 'am', 'force-stop', 'dev.oraculum.poc'); phone = await attachPhone();
    cookies = (await phone.context().cookies([origin])).filter(cookie => cookie.name === 'oraculum_local' && cookie.path === '/');
    await phone.goto(origin + '/auth/session'); backup = await phone.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
    await writeFile(join(output, 'private-phone-backup.json'), JSON.stringify({ cookies, backup }), { mode: 0o600 });
    await phone.context().clearCookies({ name: 'oraculum_local', domain: '127.0.0.1', path: '/' }); await phone.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await phone.goto(origin); await pair(phone); await ready(phone);
    evidence.android = { model: adb('shell', 'getprop', 'ro.product.model'), version: adb('shell', 'getprop', 'ro.build.version.release') };
  } else {
    mobile = await chromium.launch(); phone = await mobile.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); observe(phone); await phone.goto(origin); await pair(phone); await ready(phone);
  }
  stage = 'phone identity selection'; await settings(phone);
  if (realAndroid) {
    // Cancel the real system picker before selecting, proving the callback is released.
    await nativeTap(phone, card(phone, 'user').getByRole('button', { name: '选择图片' })); await expect.poll(async () => /(?:topResumedActivity|mResumedActivity)[^\n]*documentsui/i.test(adb('shell', 'dumpsys', 'activity', 'activities'))).toBe(true); adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); await expect.poll(async () => /(?:topResumedActivity|mResumedActivity)[^\n]*dev.oraculum.poc/.test(adb('shell', 'dumpsys', 'activity', 'activities'))).toBe(true); await expect(card(phone, 'user')).toBeVisible();
    for (const extension of ['png', 'webp', 'jpg']) { const name = `oraculum-avatar-${Date.now()}.${extension}`, path = '/sdcard/Download/' + name; adb('push', join(output, 'avatar.' + extension), path); deviceFiles.push(path); }
    await nativeChoose(phone, 'user', deviceFiles[0].split('/').at(-1)!);
  } else await choose(phone, 'user', join(output, 'avatar.png'));
  await useAvatar(phone, 'user'); await save(phone, 'user', '月光');
  if (realAndroid) await nativeChoose(phone, 'assistant', deviceFiles[1].split('/').at(-1)!); else await choose(phone, 'assistant', join(output, 'avatar.webp'));
  await useAvatar(phone, 'assistant'); await save(phone, 'assistant', '星语'); await closeSettings(phone); await verifyCards(phone, '月光', '星语'); await capture(phone, realAndroid ? 'android-cards' : 'mobile-simulated-cards');
  await verifyCards(desktop, '星河', '神谕'); await phone.reload(); await ready(phone); await verifyCards(phone, '月光', '星语');
  if (realAndroid) {
    stage = 'Android full restart'; await mobile!.close(); mobile = undefined; adb('forward', '--remove', `tcp:${forwarded}`); forwarded = undefined;
    adb('shell', 'am', 'force-stop', 'dev.oraculum.poc'); phone = await attachPhone(); await ready(phone); await verifyCards(phone, '月光', '星语');
  }
  checks.push(realAndroid ? 'Real Android 15 Debug: system DocumentsUI cancel and PNG/WebP selections, crop preview, independent identities, reload and force-stop/relaunch persistence' : 'Mobile Chromium simulation: independent local identities and reload persistence (not device acceptance)');
  stage = 'phone replacement/errors/reset'; await settings(phone);
  if (realAndroid) await nativeChoose(phone, 'user', deviceFiles[2].split('/').at(-1)!); else await choose(phone, 'user', join(output, 'avatar.jpg'));
  await card(phone, 'user').getByRole('button', { name: '取消裁切' }).click(); await closeSettings(phone); await verifyCards(phone, '月光', '星语'); await settings(phone);
  await invalidFiles(phone); await save(phone, 'user', '月光');
  if (realAndroid) await nativeChoose(phone, 'user', deviceFiles[2].split('/').at(-1)!); else await choose(phone, 'user', join(output, 'avatar.jpg'));
  await useAvatar(phone, 'user'); await save(phone, 'user', '月光');
  await closeSettings(phone); await verifyCards(phone, '月光', '星语');
  checks.push((realAndroid ? 'Real Android WebView' : 'Simulated mobile Chromium') + ': JPEG replacement/cancel-crop preserve prior state; invalid files and unsafe/long names checked through File API');
  stage = 'themes';
  for (const page of [desktop, phone]) for (const theme of ['test-violet', 'minimal-light', 'hong-kong-rain', 'oracle-eye']) {
    await settings(page); await expect(page.getByLabel('当前主题')).toBeEnabled(); await page.getByLabel('当前主题').selectOption(theme); await expect(page.locator('.app-shell')).toHaveAttribute('data-theme-id', theme);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await expect(card(page, 'user').getByRole('button', { name: '保存用户身份' })).toBeVisible();
    await expect(card(page, 'user').locator('.identity-preview canvas')).toHaveCSS('width', '64px');
    await choose(page, 'user', join(output, 'avatar.png'));
    const crop = card(page, 'user').locator('.avatar-crop'), preview = await crop.locator('canvas').boundingBox();
    assert.ok(preview && preview.width > 0 && Math.abs(preview.width - preview.height) < 1, 'Themed crop stays square');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await crop.screenshot({ path: join(output, `${theme}-${page === desktop ? 'electron' : realAndroid ? 'android' : 'mobile-simulated'}-crop.png`), animations: 'disabled' });
    await crop.getByRole('button', { name: '取消裁切', exact: true }).click();
    await closeSettings(page); await verifyCards(page, page === desktop ? '星河' : '月光', page === desktop ? '神谕' : '星语');
    await page.locator('.conversation-scroll').evaluate(el => { el.scrollTop = 0; });
    await capture(page, `${theme}-${page === desktop ? 'electron' : realAndroid ? 'android' : 'mobile-simulated'}-cards`);
  }
  checks.push('Four themes preserve custom avatars/nicknames, square crop preview and cancel, both message cards, final answer and collapsed execution process; no document overflow');
  stage = 'reset/replacement';
  for (const page of [desktop, phone]) {
    await settings(page);
    for (const role of ['user', 'assistant']) {
      await card(page, role).getByRole('button', { name: role === 'user' ? '重置用户身份' : '重置Codex身份' }).click(); await expect(card(page, role).getByRole('status')).toContainText('已保存');
    }
    await closeSettings(page); await verifyCards(page, '你', 'Codex', false); await expect(page.locator('.message.user svg.user-avatar')).toBeVisible(); await expect(page.locator('.agent-message img.oracle-eye').last()).toBeVisible();
    await page.reload(); await ready(page); await verifyCards(page, '你', 'Codex', false);
  }
  checks.push('Both roles reset independently to generic user/Oracle Eye defaults and remain reset after reload');
  assert.doesNotMatch(wire.join('\n'), /星河|神谕|月光|星语|data:image|未保存|onerror/); assert.doesNotMatch(JSON.stringify(requests), /星河|月光|星语|data:image|onerror/);
  assert.equal(requests.some(request => request.method === 'turn/start'), false); assert.equal(await configHash(), beforeConfig); assert.deepEqual(errors, []);
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed'; evidence.stage = stage; evidence.error = String(error); process.exitCode = 1;
  if (realAndroid && phone) { for (let attempt = 0; attempt < 8 && /(?:topResumedActivity|mResumedActivity)[^\n]*documentsui/i.test(adb('shell', 'dumpsys', 'activity', 'activities')); attempt++) adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); }
  if (desktop) await capture(desktop, 'failure-electron').catch(() => {}); if (phone && backup) await capture(phone, 'failure-android').catch(() => {});
} finally {
  const clean = async (name: string, fn: () => unknown | Promise<unknown>) => { try { await fn(); } catch (error) { cleanupErrors.push(name + ': ' + String(error)); process.exitCode = 1; evidence.result = 'failed'; } };
  await clean('Electron close', () => app?.close());
  if (realAndroid && phone && backup) await clean('phone storage restore', async () => {
    await phone!.goto(origin + '/auth/session'); await phone!.evaluate(saved => { localStorage.clear(); sessionStorage.clear(); for (const [key, value] of Object.entries(saved.local)) localStorage.setItem(key, value); for (const [key, value] of Object.entries(saved.session)) sessionStorage.setItem(key, value); }, backup!);
    assert.deepEqual(await phone!.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })), backup);
    await phone!.context().clearCookies({ name: 'oraculum_local', domain: '127.0.0.1', path: '/' }); await phone!.context().addCookies(cookies!);
    assert.deepEqual((await phone!.context().cookies([origin])).filter(cookie => cookie.name === 'oraculum_local' && cookie.path === '/'), cookies);
    evidence.phoneRestored = true; adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  });
  await clean('CDP/browser close', () => mobile?.close());
  if (forwarded) await clean('forward restore', () => adb('forward', '--remove', `tcp:${forwarded}`));
  if (reverseChanged) await clean('reverse restore', () => previousReverse ? adb('reverse', `tcp:${port}`, previousReverse) : adb('reverse', '--remove', `tcp:${port}`));
  for (const path of deviceFiles) await clean('own generated device image', () => adb('shell', 'rm', '-f', path));
  if (realAndroid) await clean('UI dump cleanup', () => adb('shell', 'rm', '-f', '/sdcard/oraculum-avatar-window.xml'));
  await clean('source Bridge close', () => server.close()); await clean('trust close', () => trust.close());
  evidence.configUnchanged = await configHash() === beforeConfig; evidence.productionBridgeStopped = stopped(); evidence.outgoingIdentityLeak = wire.some(value => /data:image|星河|月光|星语/.test(value));
  if (cleanupErrors.length === 0 && backup) await rm(join(output, 'private-phone-backup.json'), { force: true });
  evidence.gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await writeFile(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 }); console.log(JSON.stringify({ output, ...evidence }, null, 2));
}
