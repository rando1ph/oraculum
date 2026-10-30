// Real authenticated HTTP uploads + Ubuntu Electron and Chromium Android layout.
// Codex responses are synthetic. No installed packages, user data, ADB or tokens.
import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { uiDesktop, uiResource } from './ui-target';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../bridge/src/server';
import { BridgeService } from '../bridge/src/service';
import { TrustStore } from '../bridge/src/trust-store';
import { ReceiptStore } from '../bridge/src/receipts';
import { AttachmentStore } from '../bridge/src/attachments';
import { ProjectDirectories } from '../bridge/src/projects';
import { Themes } from '../bridge/src/themes';
import { NativeRpcError } from '../bridge/src/codex';
import { officeFixture } from './fixtures/attachments';
import { rateLimits, tokenUsage } from './fixtures/usage';
import { loopbackTlsFixture } from './loopback-tls-fixture';

type FilePayload = { name: string; mimeType: string; buffer: Buffer };

await mkdir('.local/evidence/r1-b5a/ui', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/r1-b5a/ui/run-'));
const temporary = await mkdtemp(join(tmpdir(), 'oraculum-b5a-ui-')), root = join(temporary, 'Projects'), cwd = join(root, '附件验收'), otherCwd = join(root, '另一项目');
await mkdir(cwd, { recursive: true }); await mkdir(otherCwd);
const trust = new TrustStore(join(temporary, 'state')), receipts = new ReceiptStore(trust.db);
const projects = new ProjectDirectories(root, cwd, trust.db); await projects.register(cwd); await projects.register(otherCwd);
const threads = new Map<string, any>();
for (const [id, name, path] of [['attachments', '图片与文档 · 合成样例', cwd], ['second', '独立会话草稿', cwd], ['unknown', '发送结果待确认', cwd], ['other', '另一项目会话', otherCwd]]) threads.set(id!, { id, name, preview: '附件输入验收', cwd: path, parentThreadId: null, source: 'appServer', ephemeral: false, status: { type: 'idle' }, turns: [] });
const settings = { approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: [] }, approvalsReviewer: 'user', model: 'fixture', reasoningEffort: 'low' };
const bus = new EventEmitter(), calls: { method: string; params: any }[] = [];
let nativeFailure = false, sequence = 0;
const emit = (threadId: string, method: string, params: object) => bus.emit('message', { method, params: { threadId, ...params } });
const codex = { on: bus.on.bind(bus), send: () => {}, request: async <T>(method: string, params: any): Promise<T> => {
  calls.push({ method, params }); const thread = threads.get(params.threadId);
  let result: any;
  if (method === 'config/read') result = { config: { model: 'fixture', model_reasoning_effort: 'low', model_provider: 'fixture', approval_policy: 'on-request', sandbox_mode: 'workspace-write', approvals_reviewer: 'user' } };
  else if (method === 'model/list') result = { data: [{ id: 'fixture', model: 'fixture', displayName: 'Codex · 本地验证', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null };
  else if (method === 'account/rateLimits/read') result = { rateLimits, rateLimitsByLimitId: { codex: rateLimits } };
  else if (method === 'thread/list') result = { data: params.archived ? [] : [...threads.values()].filter(thread => thread.cwd === params.cwd), nextCursor: null };
  else if (method === 'thread/read') result = { thread };
  else if (method === 'thread/resume') result = { thread, ...settings };
  else if (method === 'thread/turns/list') result = { data: [...thread.turns].reverse(), nextCursor: null };
  else if (method === 'thread/items/list') result = { data: thread.turns.find((turn: any) => turn.id === params.turnId)!.items.map((item: any) => ({ turnId: params.turnId, item })), nextCursor: null };
  else if (method === 'turn/start') {
    if (thread.id === 'unknown') throw new Error('模拟连接中断：发送结果未知，请查询状态。');
    if (nativeFailure) { nativeFailure = false; throw new NativeRpcError('模拟原生明确拒绝', -32602); }
    for (const input of params.input) if (input.type === 'localImage') expect((await readFile(input.path)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const turn = { id: `synthetic-turn-${++sequence}`, status: 'inProgress', itemsView: 'full', items: [], startedAt: Date.now() / 1000, completedAt: null, durationMs: null, error: null };
    thread.turns.push(turn); thread.status = { type: 'active', activeFlags: [] }; result = { turn: structuredClone(turn) };
    emit(thread.id, 'turn/started', { turn: structuredClone(turn) });
    emit(thread.id, 'thread/status/changed', { status: thread.status });
    setTimeout(() => {
      const user = { id: `user-${turn.id}`, type: 'userMessage', clientId: null, content: params.input };
      const answer = { id: `answer-${turn.id}`, type: 'agentMessage', phase: 'final_answer', text: '已收到所附材料。\n\n图片作为原生图像输入；文档保存在当前项目，由 Codex 已有工具读取。\n\n这是合成会话，用于验证双端附件交付和恢复。' };
      turn.items = [user, answer] as any; turn.status = 'completed'; turn.completedAt = Date.now() / 1000 as any; turn.durationMs = 90 as any;
      for (const item of turn.items) emit(thread.id, 'item/completed', { turnId: turn.id, item });
      thread.status = { type: 'idle' }; emit(thread.id, 'turn/completed', { turn }); emit(thread.id, 'thread/status/changed', { status: thread.status });
      emit(thread.id, 'thread/tokenUsage/updated', { turnId: turn.id, tokenUsage });
    }, 90);
  } else throw new Error('Unexpected fixture method: ' + method);
  return structuredClone(result) as T;
} };
const service = new BridgeService(codex, cwd, receipts, projects, undefined, new AttachmentStore(trust.db));
const port = 17904, origin = `http://127.0.0.1:${port}`, proxy = await loopbackTlsFixture(port);
const server = await createServer(service, port, uiResource('apps/web/dist'), { trust, remoteOrigin: proxy.origin, remoteBasePath: '/console/',
  themes: new Themes({ source: uiResource('themes'), builtin: uiResource('themes'), installed: join(temporary, 'themes') }) });
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(temporary, 'electron-profile') });
let app: ElectronApplication | undefined, browser: Browser | undefined, desktop: Page | undefined, phone: Page | undefined, failure: string | undefined;
const checks: string[] = [], errors: string[] = [], screenshots: string[] = [];
const record = (message: string) => { checks.push(message); console.log('PASS ' + message); };
const ready = (page: Page) => expect(page.locator('.connection-status')).toContainText('状态已查询', { timeout: 15000 });
const starts = () => calls.filter(call => call.method === 'turn/start').length;
async function pair(page: Page, name: string) {
  await page.getByLabel('设备名称', { exact: true }).fill(name); await page.getByLabel('配对码', { exact: true }).fill(trust.createPairing().code);
  await page.getByRole('button', { name: '配对并连接', exact: true }).click(); await ready(page);
}
async function nav(page: Page) { const button = page.getByRole('button', { name: '打开导航', exact: true }); if (await button.isVisible() && !await page.locator('.app-shell').evaluate(el => el.classList.contains('drawer-open'))) await button.click(); }
async function select(page: Page, id: string) { await nav(page); await page.locator(`.session-link[data-thread-id="${id}"]`).click(); await ready(page); }
async function queryPhone(page: Page) {
  await page.getByRole('button', { name: '会话菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '查询状态', exact: true }).click(); await ready(page);
}
async function theme(page: Page, id: string) {
  await nav(page); await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByLabel('当前主题').selectOption(id);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme-id', id); await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  if (await page.locator('.app-shell').evaluate(el => el.classList.contains('drawer-open'))) await page.locator('.nav-close').click();
}
async function pick(page: Page, files: FilePayload[]) {
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '添加图片或文档', exact: true }).click();
  await (await chooser).setFiles(files);
}
const uploaded = (page: Page, count: number) => expect(page.locator('.attachment-tile[data-state="ready"]')).toHaveCount(count);
async function capture(page: Page, name: string) { const path = join(output, name + '.png'); await page.screenshot({ path, scale: 'css' }); screenshots.push(path); }
async function geometry(page: Page) {
  await expect.poll(() => page.locator('.composer').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight + 1)).toBe(true);
  const rect = await page.locator('.composer').evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth }; });
  expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.y).toBeGreaterThanOrEqual(0); expect(rect.right).toBeLessThanOrEqual(rect.width + 1); expect(rect.bottom).toBeLessThanOrEqual(rect.height + 1); expect(rect.overflow).toBe(false);
}
try {
  await server.listen({ host: '127.0.0.1', port });
  app = await electron.launch(uiDesktop(env));
  await expect.poll(() => app!.windows().some(page => page.url().startsWith(origin)), { timeout: 15000 }).toBe(true);
  desktop = app.windows().find(page => page.url().startsWith(origin))!; desktop.on('pageerror', error => errors.push(error.message));
  await desktop.setViewportSize({ width: 1440, height: 960 }); await pair(desktop, '附件输入 · 桌面合成验收');
  browser = await chromium.launch({ args: ['--no-proxy-server'] });
  phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36 OraculumAndroid/1' });
  phone.on('pageerror', error => errors.push(error.message)); await phone.goto(proxy.origin + '/console/'); await pair(phone, '附件输入 · 手机视口合成验收');
  await select(desktop, 'attachments'); await select(phone, 'attachments');
  const image = Buffer.from(await desktop.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 450; const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#0a1524'; ctx.fillRect(0, 0, 800, 450); ctx.fillStyle = '#b6e8ff'; ctx.font = '30px sans-serif'; ctx.fillText('ORACULUM · SYNTHETIC DATA', 40, 55);
    ctx.strokeStyle = '#233f58'; ctx.lineWidth = 2;
    for (let y = 110; y < 400; y += 60) { ctx.beginPath(); ctx.moveTo(50, y); ctx.lineTo(750, y); ctx.stroke(); }
    ctx.strokeStyle = '#52d5ff'; ctx.lineWidth = 6; ctx.beginPath(); [320, 290, 310, 210, 240, 130, 95].forEach((y, i) => i ? ctx.lineTo(60 + i * 110, y) : ctx.moveTo(60, y)); ctx.stroke();
    ctx.fillStyle = '#e9bf74'; for (let i = 0; i < 7; i++) { ctx.beginPath(); ctx.arc(60 + i * 110, [320, 290, 310, 210, 240, 130, 95][i]!, 7, 0, 2 * Math.PI); ctx.fill(); }
    return canvas.toDataURL('image/png').split(',')[1]!;
  }), 'base64');
  const png = { name: '合成趋势图.png', mimeType: 'image/png', buffer: image }, pdf = { name: '研究方案（合成）.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nSynthetic attachment fixture\n%%EOF\n') };
  const csv = { name: '观测数据.csv', mimeType: 'text/csv', buffer: Buffer.from('样本,数值\nA,12\nB,18\n') };
  const formats: FilePayload[] = [];
  for (const [extension, mime] of [['jpg', 'image/jpeg'], ['webp', 'image/webp']] as const) {
    const bytes = await desktop.evaluate(mime => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2; return canvas.toDataURL(mime).split(',')[1]!; }, mime);
    formats.push({ name: `合成格式.${extension}`, mimeType: mime, buffer: Buffer.from(bytes, 'base64') });
  }
  formats.push({ name: '较大合成数据.csv', mimeType: 'text/csv', buffer: Buffer.from('sample,value\n'.repeat(160000)) });
  await pick(desktop, formats); await uploaded(desktop, 3);
  for (const file of formats) await desktop.getByRole('button', { name: `移除附件：${file.name}`, exact: true }).click();
  await expect(desktop.locator('.attachment-tile')).toHaveCount(0);
  await pick(desktop, []); await expect(desktop.locator('.attachment-tile')).toHaveCount(0);
  record('JPEG/WebP signatures, multi-megabyte streamed CSV, removal, chooser cancellation and reselection');
  await pick(desktop, [png, pdf, csv]); await uploaded(desktop, 3);
  await desktop.getByLabel('消息', { exact: true }).fill('请结合趋势图和研究方案，检查观测数据。'); await geometry(desktop); await capture(desktop, '01-electron-oracle-queue');
  await expect(desktop.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  // Scope switching keeps each memory queue independent.
  await select(desktop, 'second'); await expect(desktop.locator('.attachment-tile')).toHaveCount(0); await select(desktop, 'attachments'); await uploaded(desktop, 3);
  await desktop.getByLabel('项目目录', { exact: true }).selectOption(otherCwd); await ready(desktop); await expect(desktop.locator('.attachment-tile')).toHaveCount(0);
  await desktop.getByLabel('项目目录', { exact: true }).selectOption(cwd); await ready(desktop); await select(desktop, 'attachments'); await uploaded(desktop, 3);
  // Browser file drop and image paste exercise actual shared event handlers.
  await desktop.locator('.composer').evaluate((element, bytes) => { const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], '拖拽文档.txt', { type: 'text/plain' })); element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })); }, [...Buffer.from('synthetic drop')]);
  await uploaded(desktop, 4); await desktop.getByRole('button', { name: '移除附件：拖拽文档.txt', exact: true }).click(); await uploaded(desktop, 3);
  await desktop.getByLabel('消息', { exact: true }).evaluate((element, bytes) => { const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], '粘贴图像.png', { type: 'image/png' })); element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); }, [...image]);
  await uploaded(desktop, 4); await desktop.getByRole('button', { name: '移除附件：粘贴图像.png', exact: true }).click(); await uploaded(desktop, 3);
  record('real authenticated HTTP file selection, drop, paste, removal and project/thread queue isolation on Electron');
  await theme(desktop, 'old-terminal'); await geometry(desktop); await capture(desktop, '02-electron-terminal-queue');
  // IME must not submit. Existing 16000 character limit stays intact.
  await desktop.getByLabel('消息', { exact: true }).dispatchEvent('compositionstart'); await desktop.getByLabel('消息', { exact: true }).press('Control+Enter'); expect(starts()).toBe(0);
  await desktop.getByLabel('消息', { exact: true }).dispatchEvent('compositionend');
  expect(await desktop.getByLabel('消息', { exact: true }).getAttribute('maxlength')).toBe('16000');
  await desktop.getByRole('button', { name: '发送', exact: true }).click();
  await expect(desktop.locator('.attachment-card')).toHaveCount(3); await expect(desktop.locator('.attachment-tile')).toHaveCount(0); await ready(desktop);
  expect(starts()).toBe(1); expect(calls.find(call => call.method === 'turn/start')!.params.input.some((input: any) => input.type === 'localImage')).toBe(true);
  await select(phone, 'second'); await select(phone, 'attachments'); await expect(phone.locator('.attachment-card')).toHaveCount(3);
  await capture(desktop, '03-electron-terminal-delivered');
  await theme(phone, 'minimal-light'); await geometry(phone); await capture(phone, '04-phone-light-history');
  record('native image/text payload, real delivery cards, cross-device history, IME and unchanged input limit');
  await theme(phone, 'hong-kong-neon');
  await pick(phone, [png, { name: '一份包含较长中文名称的合成研究方案用于验证手机窄屏排版.pdf', mimeType: 'application/pdf', buffer: pdf.buffer }]); await uploaded(phone, 2);
  await phone.getByLabel('消息', { exact: true }).fill('请读取手机选择的图片与文档。'); await geometry(phone);
  await phone.locator('.attachment-tray').evaluate(el => { el.scrollLeft = el.scrollWidth; }); await capture(phone, '05-phone-neon-queue');
  for (const size of [{ width: 320, height: 640 }, { width: 390, height: 430 }, { width: 844, height: 390 }]) { await phone.setViewportSize(size); await geometry(phone); }
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.getByRole('button', { name: '发送', exact: true }).click(); await expect(phone.locator('.attachment-card')).toHaveCount(5); await ready(phone);
  await expect(phone.getByLabel('消息', { exact: true })).toHaveValue('');
  record('HTTPS subpath mobile picker, long Chinese filenames, narrow/landscape/keyboard-height Composer and text-plus-file send');
  await pick(phone, [{ name: '空文档.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) }]);
  await expect(phone.locator('.attachment-tile[data-state="failed"]')).toHaveCount(1); await expect(phone.getByRole('button', { name: '发送', exact: true })).toBeDisabled(); await capture(phone, '06-phone-neon-failed');
  await phone.getByRole('button', { name: '移除附件：空文档.txt', exact: true }).click();
  await pick(phone, [{ name: '超过限制.txt', mimeType: 'text/plain', buffer: Buffer.alloc(20 * 1024 ** 2 + 1, 'x') }]);
  await expect(phone.locator('.attachment-tile[data-state="failed"]')).toHaveCount(1); await expect(phone.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await phone.getByRole('button', { name: '移除附件：超过限制.txt', exact: true }).click();
  const office = { name: '工作表.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: officeFixture('xlsx') };
  await pick(phone, [office]); await uploaded(phone, 1); nativeFailure = true;
  await phone.getByRole('button', { name: '发送', exact: true }).click(); await expect(phone.locator('.error').filter({ hasText: '明确拒绝' })).toBeVisible();
  await queryPhone(phone); await uploaded(phone, 1);
  await expect(phone.getByRole('button', { name: '发送', exact: true })).toBeEnabled(); await phone.getByRole('button', { name: '发送', exact: true }).click();
  await expect(phone.locator('.attachment-card')).toHaveCount(6); await ready(phone);
  record('empty-file failure is removable; Office upload and explicit native rejection are retryable only after status query; file-only send works');
  await select(phone, 'unknown'); await pick(phone, [csv]); await uploaded(phone, 1);
  await phone.getByRole('button', { name: '发送', exact: true }).click();
  await expect(phone.locator('.attachment-tile[data-state="unknown"]')).toHaveCount(1); const countUnknown = starts();
  await expect(phone.getByRole('button', { name: '移除附件：观测数据.csv', exact: true })).toBeDisabled(); await expect(phone.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await queryPhone(phone);
  await expect(phone.getByRole('button', { name: '发送', exact: true })).toBeDisabled(); expect(starts()).toBe(countUnknown); await capture(phone, '07-phone-neon-unknown');
  record('unknown send remains held through status recovery without resend or destructive removal');
  await select(phone, 'attachments'); await phone.reload(); await ready(phone); await expect(phone.locator('.attachment-card')).toHaveCount(6);
  expect(errors).toEqual([]);
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  for (const [name, page] of [['electron', desktop], ['phone', phone]] as const) if (page && !page.isClosed()) await page.screenshot({ path: join(output, `failure-${name}.png`) }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); await app?.close(); await server.close(); await proxy.close(); trust.close();
  await writeFile(join(output, 'result.json'), JSON.stringify({ output, simulatedNative: true, realHttpUploads: true, realElectron: true, androidDevice: false, checks, screenshots, errors, failure }, null, 2));
  console.log(JSON.stringify({ output, checks, screenshots, errors, failure }));
}
