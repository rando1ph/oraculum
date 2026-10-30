// Real authenticated HTTP output reads. Native Codex responses and documents are
// synthetic; Electron uses a temporary profile/save directory. No ADB or install.
import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { uiDesktop, uiResource } from './ui-target';
import { mkdir, mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../bridge/src/server';
import { BridgeService } from '../bridge/src/service';
import { TrustStore } from '../bridge/src/trust-store';
import { ReceiptStore } from '../bridge/src/receipts';
import { AttachmentStore } from '../bridge/src/attachments';
import { ArtifactStore } from '../bridge/src/artifacts';
import { ProjectDirectories } from '../bridge/src/projects';
import { Themes } from '../bridge/src/themes';
import { officeFixture } from './fixtures/attachments';
import { artifactPdf } from './fixtures/artifacts';
import { rateLimits, tokenUsage } from './fixtures/usage';
import { loopbackTlsFixture } from './loopback-tls-fixture';

await mkdir('.local/evidence/r1-b5b/ui', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/r1-b5b/ui/run-'));
const temporary = await mkdtemp(join(tmpdir(), 'oraculum-b5b-ui-')), root = join(temporary, 'Projects'), cwd = join(root, '成果演示'), otherCwd = join(root, '独立项目');
await mkdir(join(cwd, '成果'), { recursive: true }); await mkdir(otherCwd); await mkdir(join(temporary, 'downloads'));
const samples = new Map<string, Buffer>([['研究报告.pdf', artifactPdf()], ['汇报演示.pptx', officeFixture('pptx')], ['观测数据.xlsx', officeFixture('xlsx')],
  ['成果说明.md', Buffer.from('# 合成实验成果\n\n| 指标 | 结果 |\n|---|---|\n| 样本数 | 24 |\n| 通过率 | 96% |\n\n<script>globalThis.artifactExecuted=true</script>\n[受限链接](javascript:alert(1))\n![远程图片](https://invalid.example/secret.png)')],
  ['样本.csv', Buffer.from('样本,观测值\nA,12\nB,18\n')], ['空白.txt', Buffer.alloc(0)], ['较大成果.txt', Buffer.alloc(4 * 1024 ** 2, 'x')]]);
for (const [name, bytes] of samples) await writeFile(join(cwd, '成果', name), bytes);
await writeFile(join(cwd, '.env'), 'synthetic private'); await writeFile(join(cwd, 'credentials.txt'), 'synthetic private'); await writeFile(join(otherCwd, '独立.txt'), 'another project');
const trust = new TrustStore(join(temporary, 'state')), projects = new ProjectDirectories(root, cwd, trust.db);
await projects.register(cwd); await projects.register(otherCwd);
const threads = new Map<string, any>();
for (const [id, name, path] of [['results', '成果交付 · 合成实验', cwd], ['second', '另一会话', cwd], ['other', '独立项目会话', otherCwd]]) threads.set(id!, { id, name, preview: '合成成果验证', cwd: path,
  parentThreadId: null, source: 'appServer', ephemeral: false, status: { type: 'idle' }, turns: [{ id: id + '-turn', status: 'completed', itemsView: 'full', startedAt: 1, completedAt: 2, durationMs: 1000, error: null, items: [
    { id: id + '-user', type: 'userMessage', content: [{ type: 'text', text: '请整理实验结果，生成报告、演示和工作表。' }] },
    { id: id + '-answer', type: 'agentMessage', text: '已整理合成实验成果。可以在文件面板查看研究报告、演示文稿和观测数据。\n\n这是用于验证的合成会话；消息中的文件描述需要通过项目文件列表核实。', phase: 'final_answer' },
  ] }] });
const settings = { approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: [] }, approvalsReviewer: 'user', model: 'fixture', reasoningEffort: 'low' };
const bus = new EventEmitter(), calls: string[] = [];
const codex = { on: bus.on.bind(bus), send: () => {}, request: async <T>(method: string, params: any): Promise<T> => {
  calls.push(method); const thread = threads.get(params.threadId); let result: any;
  if (method === 'config/read') result = { config: { model: 'fixture', model_reasoning_effort: 'low', model_provider: 'fixture', approval_policy: 'on-request', sandbox_mode: 'workspace-write', approvals_reviewer: 'user' } };
  else if (method === 'model/list') result = { data: [{ id: 'fixture', model: 'fixture', displayName: 'Codex · 本地验证', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null };
  else if (method === 'account/rateLimits/read') result = { rateLimits, rateLimitsByLimitId: { codex: rateLimits } };
  else if (method === 'thread/list') result = { data: params.archived ? [] : [...threads.values()].filter(thread => thread.cwd === params.cwd), nextCursor: null };
  else if (method === 'thread/read') result = { thread };
  else if (method === 'thread/resume') result = { thread, ...settings };
  else if (method === 'thread/turns/list') result = { data: thread.turns, nextCursor: null };
  else if (method === 'thread/items/list') result = { data: thread.turns[0].items.map((item: any) => ({ turnId: thread.turns[0].id, item })), nextCursor: null };
  else throw new Error('Unexpected fixture method: ' + method);
  return structuredClone(result) as T;
} };
const service = new BridgeService(codex, cwd, new ReceiptStore(trust.db), projects, undefined, new AttachmentStore(trust.db), new ArtifactStore(trust.db));
let slow = false;
const download = service.downloadArtifact.bind(service);
service.downloadArtifact = async (...args) => {
  const result = await download(...args);
  if (!slow || result.file.name !== '较大成果.txt') return result;
  const source = result.stream;
  const stream = Readable.from((async function* () {
    try { for await (const chunk of source) { await new Promise(resolve => setTimeout(resolve, 40)); yield chunk; } }
    finally { source.destroy(); }
  })());
  source.once('error', error => stream.destroy(error));
  return { ...result, stream };
};
const port = 17905, origin = `http://127.0.0.1:${port}`, proxy = await loopbackTlsFixture(port);
const server = await createServer(service, port, uiResource('apps/web/dist'), { trust, remoteOrigin: proxy.origin, remoteBasePath: '/console/',
  themes: new Themes({ source: uiResource('themes'), builtin: uiResource('themes'), installed: join(temporary, 'themes') }) });
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, { ORACULUM_URL: origin, ORACULUM_USER_DATA_DIR: join(temporary, 'electron-profile') });
let app: ElectronApplication | undefined, browser: Browser | undefined, desktop: Page | undefined, phone: Page | undefined, shellPhone: Page | undefined, failure: string | undefined;
const checks: string[] = [], errors: string[] = [], screenshots: string[] = [];
const record = (message: string) => { checks.push(message); console.log('PASS ' + message); };
const ready = (page: Page) => expect(page.locator('.connection-status')).toContainText('状态已查询', { timeout: 15000 });
async function pair(page: Page, name: string) {
  await page.getByLabel('设备名称', { exact: true }).fill(name); await page.getByLabel('配对码', { exact: true }).fill(trust.createPairing().code);
  await page.getByRole('button', { name: '配对并连接', exact: true }).click(); await ready(page);
}
async function nav(page: Page) { const button = page.getByRole('button', { name: '打开导航', exact: true }); if (await button.isVisible() && !await page.locator('.app-shell').evaluate(el => el.classList.contains('drawer-open'))) await button.click(); }
async function closePanel(page: Page) { if (await page.locator('.inspector').isVisible()) await page.locator('.inspector').getByRole('button', { name: '关闭面板', exact: true }).click(); }
async function filePanel(page: Page) {
  if (!await page.locator('.inspector').isVisible()) {
    const toggle = page.getByRole('button', { name: '打开检查器', exact: true });
    if (await toggle.isVisible()) await toggle.click();
    else { await page.getByRole('button', { name: '会话菜单', exact: true }).click(); await page.getByRole('menuitem', { name: '项目成果', exact: true }).click(); }
  }
  await page.getByRole('button', { name: '文件', exact: true }).click();
}
async function openFiles(page: Page) {
  await filePanel(page); await expect(page.locator('.artifact-name', { hasText: '成果' })).toBeVisible();
  await page.getByRole('button', { name: '成果', exact: true }).click(); await expect(page.locator('.artifact-card')).toHaveCount(samples.size);
}
async function theme(page: Page, id: string) {
  await closePanel(page); await nav(page); await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByLabel('当前主题').selectOption(id);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme-id', id); await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  if (await page.locator('.app-shell').evaluate(el => el.classList.contains('drawer-open'))) await page.locator('.nav-close').click();
}
async function capture(page: Page, name: string) { const path = join(output, name + '.png'); await page.screenshot({ path, scale: 'css' }); screenshots.push(path); }
async function preview(page: Page, name: string) {
  await page.getByRole('button', { name: '预览 ' + name, exact: true }).click(); await expect(page.locator('.artifact-detail')).toContainText(name);
  await expect(page.locator('.artifact-transfer')).toHaveCount(0, { timeout: 20000 });
}
async function geometry(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  for (const locator of [page.locator('.artifact-toolbar'), page.locator('.inspector-tabs')]) {
    const box = await locator.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  }
}
async function browserDownload(page: Page, name: string) {
  const event = page.waitForEvent('download'); await page.getByRole('button', { name: '下载 ' + name, exact: true }).click();
  const transfer = await event; expect(transfer.suggestedFilename()).toBe(name);
  const path = join(temporary, 'downloads', 'mobile-' + name); await transfer.saveAs(path); expect(await readFile(path)).toEqual(samples.get(name));
}
try {
  await server.listen({ host: '127.0.0.1', port });
  app = await electron.launch(uiDesktop(env));
  await expect.poll(() => app!.windows().some(page => page.url().startsWith(origin)), { timeout: 15000 }).toBe(true);
  desktop = app.windows().find(page => page.url().startsWith(origin))!; desktop.on('pageerror', error => errors.push(error.message));
  await desktop.setViewportSize({ width: 1440, height: 960 }); await pair(desktop, '成果验收桌面');
  await app.evaluate(({ session, dialog, shell }, destination) => {
    const state = globalThis as any; state.artifactDownloads = []; state.artifactOpened = []; state.openChoice = 0;
    (dialog as any).showMessageBox = async () => ({ response: state.openChoice, checkboxChecked: false });
    shell.openPath = async path => { state.artifactOpened.push(path); return ''; };
    session.defaultSession.on('will-download', (_event, item) => {
      item.setSavePath(destination + '/' + item.getFilename());
      item.once('done', (_event, status) => state.artifactDownloads.push({ name: item.getFilename(), status }));
    });
  }, join(temporary, 'downloads'));
  const image = Buffer.from(await desktop.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 450; const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#0a1524'; ctx.fillRect(0, 0, 800, 450); ctx.fillStyle = '#b6e8ff'; ctx.font = '30px sans-serif'; ctx.fillText('ORACULUM - SYNTHETIC RESULTS', 36, 58);
    ctx.strokeStyle = '#29465e'; ctx.lineWidth = 2; for (let y = 120; y < 420; y += 60) { ctx.beginPath(); ctx.moveTo(50, y); ctx.lineTo(750, y); ctx.stroke(); }
    ctx.strokeStyle = '#62ddff'; ctx.lineWidth = 6; ctx.beginPath(); [345, 290, 310, 210, 235, 145, 110].forEach((y, i) => i ? ctx.lineTo(60 + i * 110, y) : ctx.moveTo(60, y)); ctx.stroke();
    return canvas.toDataURL('image/png').split(',')[1]!;
  }), 'base64'); samples.set('趋势图.png', image); await writeFile(join(cwd, '成果', '趋势图.png'), image);
  browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, isMobile: true, hasTouch: true, viewport: { width: 393, height: 851 }, deviceScaleFactor: 1 });
  phone = await context.newPage(); phone.on('pageerror', error => errors.push(error.message)); await phone.goto(proxy.origin + '/console/'); await pair(phone, '成果验收手机');
  bus.emit('message', { method: 'thread/tokenUsage/updated', params: { threadId: 'results', turnId: 'results-turn', tokenUsage } });

  for (const id of ['oracle-eye', 'old-terminal', 'minimal-light', 'hong-kong-neon']) {
    await theme(desktop, id); await openFiles(desktop); await preview(desktop, '研究报告.pdf');
    await expect(desktop.locator('.artifact-pdf canvas')).toHaveAttribute('data-ready', 'true', { timeout: 15000 }); await geometry(desktop);
    await desktop.getByRole('button', { name: '下一页', exact: true }).click(); await expect(desktop.locator('.artifact-pdf canvas')).toHaveAttribute('aria-label', 'PDF 第 2 页');
    await expect(desktop.locator('.artifact-pdf canvas')).toHaveAttribute('data-ready', 'true'); await capture(desktop, 'desktop-' + id + '-pdf');
    expect(await desktop.evaluate(() => (globalThis as any).artifactExecuted)).toBeUndefined();
    await theme(phone, id); await openFiles(phone); await preview(phone, '趋势图.png'); await expect(phone.locator('.artifact-image')).toBeVisible(); await geometry(phone); await capture(phone, 'phone-' + id + '-image');
  }
  record('actual Electron and HTTPS subpath Chromium touch viewport: four themes, bounded image and two-page canvas PDF previews, no PDF scripts');
  for (const name of ['研究报告.pdf', '汇报演示.pptx', '观测数据.xlsx', '趋势图.png', '样本.csv']) {
    await desktop.getByRole('button', { name: '下载 ' + name, exact: true }).click();
    await expect.poll(() => app!.evaluate((_electron, name) => (globalThis as any).artifactDownloads.some((item: any) => item.name === name && item.status === 'completed'), name), { timeout: 20000 }).toBe(true);
    expect(await readFile(join(temporary, 'downloads', name))).toEqual(samples.get(name));
    await browserDownload(phone, name);
  }
  expect(await app.evaluate(() => (globalThis as any).artifactOpened)).toEqual([]);
  await app.evaluate(() => { (globalThis as any).openChoice = 1; });
  await desktop.getByRole('button', { name: '下载 汇报演示.pptx', exact: true }).click();
  await expect.poll(() => app!.evaluate(() => (globalThis as any).artifactOpened.length)).toBe(1);
  record('complete PDF/PPTX/XLSX/PNG/CSV bytes saved by Electron and mobile Chromium; controlled desktop system-open only after native dialog choice (save/open dialogs mocked)');
  await preview(phone, '成果说明.md'); await expect(phone.locator('.artifact-detail table')).toHaveCount(1);
  expect(await phone.evaluate(() => (globalThis as any).artifactExecuted)).toBeUndefined(); await expect(phone.locator('.artifact-detail script, .artifact-detail iframe, .artifact-detail a[href^="javascript:"]')).toHaveCount(0);
  await capture(phone, 'phone-markdown'); await preview(phone, '空白.txt'); await expect(phone.locator('.artifact-text')).toContainText('空文件');
  await preview(phone, '研究报告.pdf'); await expect(phone.locator('.artifact-pdf canvas')).toHaveAttribute('data-ready', 'true', { timeout: 15000 }); await capture(phone, 'phone-pdf');
  record('safe GFM/UTF-8/empty text and mobile PDF canvas; no HTML scripts, executable links or remote image loads');
  slow = true;
  await phone.getByRole('button', { name: '下载 较大成果.txt', exact: true }).click();
  await expect.poll(async () => Number(await phone!.getByRole('progressbar', { name: '文件传输进度' }).getAttribute('value'))).toBeGreaterThan(0);
  await phone.locator('.artifact-transfer').getByRole('button', { name: '取消', exact: true }).click(); await expect(phone.locator('.artifacts')).toContainText('已取消');
  slow = false;
  const errorFile = join(cwd, '成果', '样本.csv'); await rename(errorFile, errorFile + '.old');
  await phone.getByRole('button', { name: '下载 样本.csv', exact: true }).click(); await expect(phone.locator('.artifact-error')).toContainText('已变化'); await capture(phone, 'phone-missing-file'); await rename(errorFile + '.old', errorFile);
  record('visible progress, user cancellation during actual streaming and renamed-file failure with safe retry');

  for (const dimensions of [{ width: 320, height: 700 }, { width: 851, height: 393 }, { width: 393, height: 420 }]) { await phone.setViewportSize(dimensions); await geometry(phone); }
  await phone.setViewportSize({ width: 393, height: 851 }); await closePanel(phone); await nav(phone); await phone.locator('.session-link[data-thread-id="second"]').click(); await ready(phone); await openFiles(phone); await expect(phone.locator('.artifact-detail')).toHaveCount(0);
  await closePanel(phone); await nav(phone); await phone.getByRole('button', { name: '独立项目', exact: true }).click(); await ready(phone);
  await filePanel(phone); await expect(phone.locator('.artifact-name')).toHaveText('独立.txt');
  await expect(phone.locator('.artifact-detail')).toHaveCount(0); await closePanel(phone);
  record('320px, landscape and keyboard-height layout; project/thread switching discards previous grants, previews and cards');

  const shellContext = await browser.newContext({ ignoreHTTPSErrors: true, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36 OraculumAndroid/1', viewport: { width: 393, height: 851 } });
  shellPhone = await shellContext.newPage(); shellPhone.on('pageerror', error => errors.push(error.message)); await shellPhone.goto(proxy.origin + '/console/'); await pair(shellPhone, '原生动作契约'); await openFiles(shellPhone);
  await shellPhone.getByRole('button', { name: '下载 观测数据.xlsx', exact: true }).click();
  for (const [label, mode] of [['保存到设备', 'save'], ['分享', 'share'], ['外部打开', 'open']]) expect(await shellPhone.getByRole('link', { name: label, exact: true }).getAttribute('href')).toMatch(new RegExp('^oraculum://artifact/' + mode + '/[0-9a-f-]{36}$'));
  await capture(shellPhone, 'android-native-actions-contract');
  expect(await shellPhone.evaluate(() => window.oraculumAndroidBack?.())).toBe(true); await expect(shellPhone.locator('.inspector')).toHaveCount(0);
  record('Android shell UI has gesture links containing only a scoped output ID; Back returns to conversation; SAF/provider JVM+compile QA is separate, no Android device used');
  await nav(phone); await phone.getByRole('button', { name: '成果演示', exact: true }).click(); await ready(phone);
  await nav(phone); await phone.locator('.session-link[data-thread-id="results"]').click(); await ready(phone); await openFiles(phone);
  let delivered = 0; phone.on('download', () => delivered++); slow = true;
  await phone.getByRole('button', { name: '下载 较大成果.txt', exact: true }).click();
  await expect.poll(async () => Number(await phone!.getByRole('progressbar', { name: '文件传输进度' }).getAttribute('value'))).toBeGreaterThan(0);
  trust.revoke(trust.list().find(device => device.label === '成果验收手机')!.id);
  await expect(phone.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible({ timeout: 15000 });
  expect(delivered).toBe(0);
  record('device revocation interrupts an actual HTTPS response before any file is offered for saving');
  expect(calls.filter(method => method === 'turn/start')).toHaveLength(0); expect(errors).toEqual([]);
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  for (const [name, page] of [['electron', desktop], ['phone', phone], ['shell', shellPhone]] as const) if (page && !page.isClosed()) await page.screenshot({ path: join(output, `failure-${name}.png`) }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); await app?.close(); await server.close(); await proxy.close(); trust.close();
  await writeFile(join(output, 'result.json'), JSON.stringify({ output, simulatedNative: true, realHttpDownloads: true, realElectron: true, nativeSaveDialogsMocked: true, androidDevice: false, checks, screenshots, errors, failure }, null, 2));
  await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ output, checks, screenshots, errors, failure }));
}
