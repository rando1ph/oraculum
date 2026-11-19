/**
 * P4.3 persistence/interaction acceptance in the actual sandboxed Electron app.
 * Run after build:desktop, with no concurrent build or desktop acceptance run:
 * ELECTRON_OVERRIDE_DIST_PATH="$PWD/.local/desktop-p41/electron-runtime" \
 * CHROME_DEVEL_SANDBOX=/opt/google/chrome/chrome-sandbox \
 * pnpm exec tsx scripts/desktop-p43-fixtures.ts --output=.local/desktop-p43-fixtures
 *
 * --baseline measures the same synthetic workload against an earlier bundle.
 * This script never starts or contacts a Gateway. All history is generated here.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { build } from 'esbuild';
import type { DesktopBridge } from '../apps/desktop/src/contracts/desktop';
import type { WorkspaceAction, WorkspaceState } from '../apps/desktop/src/contracts/workspace';
import { IPC } from '../apps/desktop/src/main/ipc-channels';

type DesktopWindow = Window & { oraculumDesktop: DesktopBridge };
type StorageWindow = Window & { p43StorageModule: typeof import('../apps/desktop/src/renderer/persistence/local-data') };
type DiagnosticGlobal = typeof globalThis & { p43Diagnostics: { tcpAttempts: number; actions: string[] } };
const root = resolve(import.meta.dirname, '..');
const bundle = join(root, 'apps/desktop/dist');
const require = createRequire(join(root, 'apps/desktop/package.json'));
const executablePath = require('electron') as string;
const args = process.argv.slice(2);
const output = resolve(args.find(value => value.startsWith('--output='))?.slice(9) || join(root, '.local/desktop-p43-fixtures'));
const baseline = args.includes('--baseline');
const restartDiagnostic = args.includes('--restart-diagnostic');
const entry = 'oraculum-app://bundle/index.html';
const identity = { endpoint: 'http://127.0.0.1:1/', installationId: '11111111-1111-4111-8111-111111111111', deviceId: '33333333-3333-4333-8333-333333333333' };
const projectId = '44444444-4444-4444-8444-444444444444';
const epoch = '22222222-2222-4222-8222-222222222222';
const threadId = 'p43-fixture-thread';
const capabilities = ['thread.start', 'turn.start', 'turn.interrupt', 'turn.steer', 'thread.resume', 'thread.name.set', 'thread.archive', 'thread.unarchive', 'thread.delete', 'thread.fork', 'thread.compact', 'thread.revert', 'attachments', 'history', 'projects', 'interactions'];
const fixture: WorkspaceState = {
  connection: { ...identity, epoch, status: 'connected', secureStorage: true },
  capabilities: { gatewayVersion: 'fixture-only', installationId: identity.installationId, epoch,
    protocol: { major: 2, minor: 1, minClientMinor: 0 }, codex: { connectionState: 'connected', version: 'fixture-only' },
    limits: { attachmentFileBytes: 20_000_000, attachmentBatchBytes: 50_000_000, attachmentBatchCount: 6, eventReplayCount: 1000, historyPageItems: 20, requestBytes: 1_000_000 },
    capabilities: capabilities.map(name => ({ name, supported: true, availability: 'available', verified: true, maturity: 'gateway', epoch, observedVersion: 'fixture-only', reasonCode: null })) },
  projects: [{ id: projectId, name: 'P4.3 本地体验 Fixture', rootId: 'fixture-root', available: true }], roots: [{ id: 'fixture-root', label: 'Fixture' }],
  projectId, threadId, thread: { id: threadId, projectId, title: '持久化与离线阅读（模拟数据）', status: 'idle', model: 'fixture-model', archived: false, parentThreadId: null },
  threads: { source: 'fixture-only', truncated: false, nextCursor: null, threads: [{ id: threadId, projectId, title: '持久化与离线阅读（模拟数据）', status: 'idle', archived: false, parentThreadId: null }] },
  history: { epoch, historyRevision: 'fixture-revision-1', source: 'native-pagination', nextCursor: null, complete: true, truncated: false,
    items: [{ id: 'fixture-turn', status: 'completed', items: [
      { id: 'fixture-user', type: 'userMessage', content: [{ type: 'text', text: '断线之后，继续阅读和整理想法。' }] },
      { id: 'fixture-assistant', type: 'agentMessage', text: '## Fixture：可靠的本地体验\n\n本页只验证界面，**没有连接 Gateway**。\n\n历史是可重建的阅读副本。草稿按身份和会话保存，重新连接不会自动发送。\n\n| 本地资料 | 恢复方式 |\n| --- | --- |\n| 历史 | 上次可见的只读内容 |\n| 草稿 | 恢复编辑，等待主动发送 |\n| 未知操作 | 查询原 operationId |' },
    ] }] },
  streamItems: [], interactions: [], synchronization: 'current', attachments: [], draftId: 'fixture-upload-draft', operations: [], busy: false,
  notice: '本地界面 fixture · 未连接 Gateway · 全部内容均为模拟数据',
  diff: 'diff --git a/fixture.ts b/fixture.ts\n--- a/fixture.ts\n+++ b/fixture.ts\n@@ -1 +1 @@\n-retryWrite();\n+queryOriginalReceipt();',
  plan: { turnId: 'fixture-turn', plan: [{ step: '保存本地草稿', status: 'completed' }, { step: '核对原操作', status: 'completed' }] },
};
// A non-sensitive main-supplied identity marker; a fixture never grants real
// authority because the original unconfigured controller remains installed.
Object.assign(fixture, { localScope: identity });

function longFixture(): WorkspaceState {
  const items = Array.from({ length: 1000 }, (_, index) => ({
    id: `long-turn-${index}`, status: 'completed', items: [{ id: `long-item-${index}`,
      ...(index % 3 === 1
        ? { type: 'commandExecution', command: `printf fixture-${index}`, status: 'completed', aggregatedOutput: `fixture output ${index}\n`.repeat(100) }
        : { type: index % 3 === 0 ? 'userMessage' : 'agentMessage', text: `消息 ${index} · 本地长历史样本。\n\n${'只读历史与原生执行权限分离。'.repeat(30)}` }),
    }],
  }));
  return { ...fixture, history: { ...fixture.history!, items, historyRevision: 'fixture-long-revision' },
    thread: { ...fixture.thread!, title: '1000 条长历史性能样本（模拟数据）' } };
}

assert.equal(process.env.XDG_SESSION_TYPE, 'wayland', 'Run in the real GNOME/Wayland session, not Xvfb.');
assert.ok(process.env.WAYLAND_DISPLAY, 'WAYLAND_DISPLAY is required.');
await mkdir(output, { recursive: true, mode: 0o700 });
const temporary = await mkdtemp(join(tmpdir(), 'oraculum-desktop-p43-fixtures-'));
const config = join(temporary, 'config');
await mkdir(config, { mode: 0o700 });
const profile = join(config, 'oraculum-desktop-v2/development-p43-fixtures');
const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ORACULUM_URL', 'ORACULUM_PORT', 'ORACULUM_USER_DATA_DIR', 'ORACULUM_RESOURCE_DIR', 'ORACULUM_DESKTOP_ICON']) delete env[key];
Object.assign(env, { XDG_CONFIG_HOME: config, ORACULUM_DESKTOP_PROFILE: 'p43-fixtures' });
const passed: string[] = [], pageErrors: string[] = [], externalRequests: string[] = [];
const nativeCloseEvents: { method: string; prevented: boolean }[] = [];
let closeMethod = '';
const screenshots: { file: string; sha256: string; width: number; height: number; theme: string }[] = [];
const measurements: Record<string, unknown> = {};
const manifestHash = createHash('sha256').update(await readFile(join(bundle, 'renderer-manifest.json'))).digest('hex');
const source = JSON.parse(await readFile(join(bundle, 'build-info.json'), 'utf8')) as unknown;
let app: ElectronApplication | undefined;
let runtime: unknown, stage = 'initialization', totalNetworkAttempts = 0;

async function check(name: string, run: () => Promise<void>) { stage = name; await run(); passed.push(name); console.log(`PASS ${name}`); }
async function launch(): Promise<Page> {
  app = await electron.launch({ executablePath, args: ['--ozone-platform=wayland', '--force-renderer-accessibility', bundle], env, chromiumSandbox: true, timeout: 30_000 });
  app.on('console', message => {
    const text = message.text();
    if (text.startsWith('P43_NATIVE_CLOSE_DIAGNOSTIC ')) nativeCloseEvents.push({ method: closeMethod, ...JSON.parse(text.slice(28)) });
  });
  app.context().on('request', request => { if (!request.url().startsWith('oraculum-app://bundle/')) externalRequests.push(new URL(request.url()).protocol); });
  const page = await app.firstWindow({ timeout: 20_000 });
  page.on('pageerror', error => pageErrors.push(error.name));
  await expect(page.locator('.app-shell')).toBeVisible();
  assert.equal(page.url(), entry);
  await app.evaluate(({ ipcMain, BrowserWindow }, channel) => {
    BrowserWindow.getAllWindows()[0].on('close', event => console.log(`P43_NATIVE_CLOSE_DIAGNOSTIC ${JSON.stringify({ prevented: event.defaultPrevented })}`));
    const diagnostics = { tcpAttempts: 0, actions: [] as string[] };
    (globalThis as DiagnosticGlobal).p43Diagnostics = diagnostics;
    const network = process.getBuiltinModule('node:net') as typeof import('node:net');
    (network.Socket.prototype as unknown as { connect: (...args: unknown[]) => unknown }).connect = function () { diagnostics.tcpAttempts++; throw new Error('FIXTURE_NETWORK_FORBIDDEN'); };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> })._invokeHandlers;
    const original = handlers.get(channel); if (!original) throw new Error('Expected product IPC handler is unavailable.');
    handlers.set(channel, (event, ...args) => { diagnostics.actions.push((args[0] as WorkspaceAction)?.type ?? 'invalid'); return original(event, ...args); });
  }, IPC.workspaceAction);
  return page;
}
async function closeWindow(page: Page, native = true): Promise<void> {
  const current = app!;
  totalNetworkAttempts += await current.evaluate(() => (globalThis as DiagnosticGlobal).p43Diagnostics.tcpAttempts);
  const processHandle = current.process(), exited = current.waitForEvent('close', { timeout: 15_000 });
  const observedBefore = nativeCloseEvents.length;
  closeMethod = native ? 'BrowserWindow.close' : 'CDP page.close';
  if (native) await current.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  else await page.close();
  await exited;
  if (native) assert.ok(nativeCloseEvents.slice(observedBefore).some(event => event.prevented), 'Native close must enter the product persistence handshake.');
  assert.notEqual(processHandle.exitCode, null, 'Closing the last window must exit the client.');
  app = undefined;
  measurements.nativeCloseEvents = nativeCloseEvents;
}
async function crashOwnedClient(): Promise<void> {
  const current = app!;
  totalNetworkAttempts += await current.evaluate(() => (globalThis as DiagnosticGlobal).p43Diagnostics.tcpAttempts);
  const processHandle = current.process(), exited = current.waitForEvent('close', { timeout: 15_000 });
  assert.ok(processHandle.kill('SIGKILL'), 'Only this harness-owned Electron process may be terminated.');
  await exited; assert.notEqual(processHandle.signalCode, null); app = undefined;
}
async function publish(state: WorkspaceState): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send(value.channel, value.state), { channel: IPC.workspaceChanged, state });
}
async function paints(page: Page): Promise<void> {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
}
async function capture(page: Page, file: string): Promise<void> {
  await paints(page);
  for (let attempt = 0; attempt < 10; attempt++) {
    const visual = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme!, width: innerWidth, height: innerHeight,
      samples: Array.from(document.querySelectorAll('.navigation,.conversation,.inspector')).flatMap(element => {
        const bounds = element.getBoundingClientRect(), color = getComputedStyle(element).backgroundColor.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
        return bounds.width && bounds.height && color ? [{ x: bounds.left + 5, y: bounds.bottom - 5, color: [Number(color[1]), Number(color[2]), Number(color[3]), 255] }] : [];
      }) }));
    const bitmap = await app!.evaluate(async ({ BrowserWindow }, visual) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
      const png = image.toPNG(), bytes = image.toBitmap(), width = png.readUInt32BE(16), height = png.readUInt32BE(20);
      const correct = visual.samples.every(sample => {
        const x = Math.min(width - 1, Math.floor(sample.x * width / visual.width)), y = Math.min(height - 1, Math.floor(sample.y * height / visual.height));
        const offset = (y * width + x) * 4, actual = [bytes[offset + 2], bytes[offset + 1], bytes[offset], bytes[offset + 3]];
        return sample.color.every((value, channel) => Math.abs(actual[channel] - value) <= 1);
      });
      return { correct, png: png.toString('base64'), width, height };
    }, visual);
    if (bitmap.correct) {
      const bytes = Buffer.from(bitmap.png, 'base64'); await writeFile(join(output, file), bytes);
      screenshots.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), width: bitmap.width, height: bitmap.height, theme: visual.theme }); return;
    }
    await page.waitForTimeout(60);
  }
  throw new Error('Compositor frame did not match the current theme.');
}
async function measureHistory(page: Page): Promise<void> {
  const state = longFixture();
  const cdp = await app!.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const beforeMetrics = await cdp.send('Performance.getMetrics');
  const start = Date.now();
  await publish(state);
  await expect(page.locator('[data-item-id="long-item-999"]')).toBeAttached({ timeout: 30_000 });
  await paints(page);
  const renderMs = Date.now() - start;
  const dom = await cdp.send('Memory.getDOMCounters');
  const metrics = await cdp.send('Performance.getMetrics');
  const scroll = await page.evaluate(async () => {
    const viewport = document.querySelector('.conversation-scroll') as HTMLElement;
    const frameTimes: number[] = [];
    let previous = performance.now();
    for (let index = 0; index < 60; index++) {
      viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) * (index / 59);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const now = performance.now(); frameTimes.push(now - previous); previous = now;
    }
    const sorted = [...frameTimes].sort((a, b) => a - b);
    return { frames: frameTimes.length, p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)], maxMs: Math.max(...frameTimes),
      mountedMessages: document.querySelectorAll('article.message').length, elements: document.querySelectorAll('*').length, scrollHeight: viewport.scrollHeight };
  });
  const storage = await page.evaluate(() => navigator.storage.estimate());
  const afterScrollMetrics = await cdp.send('Performance.getMetrics');
  const heap = Object.fromEntries(metrics.metrics.filter(value => ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes'].includes(value.name)).map(value => [value.name, value.value]));
  const heapAfterScroll = Object.fromEntries(afterScrollMetrics.metrics.filter(value => ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes'].includes(value.name)).map(value => [value.name, value.value]));
  const durations = Object.fromEntries(['LayoutDuration', 'RecalcStyleDuration'].map(name => [name, {
    renderMs: 1000 * ((metrics.metrics.find(value => value.name === name)?.value ?? 0) - (beforeMetrics.metrics.find(value => value.name === name)?.value ?? 0)),
    scrollMs: 1000 * ((afterScrollMetrics.metrics.find(value => value.name === name)?.value ?? 0) - (metrics.metrics.find(value => value.name === name)?.value ?? 0)),
  }]));
  measurements.longHistory = { datasetMessages: 1000, serializedBytes: Buffer.byteLength(JSON.stringify(state)), renderMs, dom, heap, heapAfterScroll, durations, scroll, storage,
    sampling: 'heap and DOM are sampled after initial render; heapAfterScroll after 60 scripted scroll frames. No forced GC; these are not steady-state RSS measurements.' };
  if (!baseline) assert.ok(scroll.mountedMessages <= 80, `Expected bounded mounted messages, got ${scroll.mountedMessages}.`);
  await cdp.detach();
}

async function storageFaults(page: Page): Promise<void> {
  // Test-only CDP injection executes the exact source module against Chromium's
  // real IndexedDB. It creates separate synthetic databases, not a product API.
  const compiled = await build({ stdin: { contents: "import * as storage from './apps/desktop/src/renderer/persistence/local-data.ts'; globalThis.p43StorageModule = storage;", resolveDir: root, sourcefile: 'p43-storage-harness.ts', loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'chrome152', platform: 'browser' });
  measurements.storageFaultModule = { sources: await Promise.all(['local-data.ts', 'types.ts'].map(async file => ({ file: `apps/desktop/src/renderer/persistence/${file}`, sha256: createHash('sha256').update(await readFile(join(root, 'apps/desktop/src/renderer/persistence', file))).digest('hex') }))),
    compiledSha256: createHash('sha256').update(compiled.outputFiles[0].text).digest('hex'), note: 'Test-only module built from these exact sources; GUI bundle identity is recorded separately.' };
  await page.evaluate(compiled.outputFiles[0].text);
  // tsx preserves local function names with this helper when serializing the
  // test callback. It is test plumbing, not a preload or application capability.
  await page.evaluate('globalThis.__name = value => value;');
  const checks = await page.evaluate(async ({ fixture, identity, projectId, threadId }) => {
    const { ClientStorage, LocalStorageError, scopeKey, LOCAL_STORES, cacheHistory } = (window as unknown as StorageWindow).p43StorageModule;
    const checks: string[] = [], names: string[] = [];
    const scope = { ...identity, projectId, threadId };
    const content = { text: '真实 IndexedDB 中的模拟草稿', model: '', effort: '', permissionPreset: '' as const };
    const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
    const errorCode = async (work: () => Promise<unknown>, code: string) => {
      try { await work(); throw new Error(`Expected ${code}.`); } catch (error) { assert(error instanceof LocalStorageError && error.code === code, `Expected ${code}, got ${error instanceof Error ? error.message : String(error)}.`); }
    };
    const freshName = () => { const name = `p43-storage-fixture-${crypto.randomUUID()}`; names.push(name); return name; };
    const open = (name: string, version?: number, upgrade?: (db: IDBDatabase) => void) => new Promise<IDBDatabase>((resolve, reject) => {
      const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
      request.onupgradeneeded = () => upgrade?.(request.result);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const raw = async (name: string, store: string, key: string, change?: (value: any) => any) => {
      const database = await open(name);
      try {
        return await new Promise<any>((resolve, reject) => {
          const tx = database.transaction(store, change ? 'readwrite' : 'readonly'); let value: any;
          const request = tx.objectStore(store).get(key);
          request.onsuccess = () => { value = request.result; if (change) { value = change(value); tx.objectStore(store).put(value, key); } };
          tx.oncomplete = () => resolve(value); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error);
        });
      } finally { database.close(); }
    };
    const name = freshName(); let storage = new ClientStorage({ name });
    try {
      const initial = await storage.saveDraft(scope, content, 0);
      storage.close(); storage = new ClientStorage({ name });
      assert(JSON.stringify(await storage.readDraft(scope)) === JSON.stringify(initial), 'Committed draft must survive a connection reopen.');
      const database = await open(name);
      assert(database.version === 1 && LOCAL_STORES.every(store => database.objectStoreNames.contains(store)), 'Initial schema must be complete.'); database.close();
      checks.push('strict committed IndexedDB draft survives reopen and complete additive schema');
      for (const alternate of [{ ...scope, endpoint: `${identity.endpoint}another-base/` }, { ...scope, installationId: 'different-installation' }, { ...scope, deviceId: 'different-device' }, { ...scope, projectId: 'different-project' }, { ...scope, threadId: 'different-thread' }])
        assert(await storage.readDraft(alternate) === undefined, 'Scope boundary mixed local data.');
      checks.push('endpoint Base Path installation device project and thread isolation');
      const concurrent = await Promise.allSettled([storage.saveDraft(scope, { ...content, text: 'editor A' }, initial.revision), storage.saveDraft(scope, { ...content, text: 'editor B' }, initial.revision)]);
      assert(concurrent.filter(value => value.status === 'fulfilled').length === 1, 'CAS must allow only one matching revision.');
      assert(concurrent.some(value => value.status === 'rejected' && value.reason instanceof LocalStorageError && value.reason.code === 'conflict'), 'Competing editor must receive conflict.');
      checks.push('concurrent draft compare-and-swap preserves one winning edit');
      let draft = (await storage.readDraft(scope))!;
      draft = await storage.beginSubmission(scope, draft.revision);
      await errorCode(() => storage.beginSubmission(scope, draft.revision), 'pending');
      const operationId = '66666666-6666-4666-8666-666666666666';
      const receipt = { clientDraftId: draft.clientDraftId, draftRevision: draft.revision, operationId, status: 'unknown' as const };
      await storage.settleSubmission(scope, receipt);
      storage.close(); storage = new ClientStorage({ name });
      const pending = (await storage.readDraft(scope))!;
      assert(pending.text === draft.text && pending.submission?.status === 'pending' && pending.submission.operationId === operationId, 'Unknown receipt must preserve submitted text and ID across reopen.');
      await errorCode(() => storage.settleSubmission(scope, { ...receipt, operationId: '77777777-7777-4777-8777-777777777777', status: 'accepted' }), 'conflict');
      checks.push('unknown receipt preserves pending draft and rejects another operation ID');
      const newer = await storage.saveDraft(scope, { ...content, text: '在等待原回执期间继续编辑的新版' }, pending.revision);
      const settled = await storage.settleSubmission(scope, { ...receipt, status: 'accepted' });
      assert(settled.text === newer.text && settled.revision === newer.revision && settled.submission?.status === 'accepted', 'Late accepted receipt must not clear newer text.');
      const submission = await storage.beginSubmission(scope, settled.revision);
      const accepted = await storage.settleSubmission(scope, { clientDraftId: submission.clientDraftId, draftRevision: submission.revision, operationId: '88888888-8888-4888-8888-888888888888', status: 'accepted' });
      assert(accepted.text === '' && accepted.revision > submission.revision, 'Matching accepted receipt clears only the submitted revision.');
      checks.push('accepted receipt clears matching revision and preserves concurrent newer edits');
      const retryDraft = await storage.saveDraft(scope, { ...content, text: '已明确拒绝的草稿' }, accepted.revision);
      await storage.beginSubmission(scope, retryDraft.revision);
      const rejected = await storage.settleSubmission(scope, { clientDraftId: retryDraft.clientDraftId, draftRevision: retryDraft.revision, operationId: '99999999-9999-4999-8999-999999999999', status: 'rejected' });
      assert(rejected.text === retryDraft.text && rejected.revision > retryDraft.revision && rejected.submission?.status === 'rejected', 'Definitive rejection must preserve text and advance revision.');
      const retried = await storage.beginSubmission(scope, rejected.revision);
      assert(retried.submission?.revision === rejected.revision, 'User retry must submit the new revision.');
      const released = await storage.releaseSubmission(scope, { clientDraftId: retried.clientDraftId, draftRevision: retried.revision });
      assert(released.text === retried.text && released.revision > retried.revision && released.submission === undefined, 'Explicit no-dispatch proof must release only the exact pending revision.');
      checks.push('definitive rejection and not-dispatched proof preserve text for explicit revised retry');
      const preserved = await storage.saveDraft(scope, content, released.revision);
      await storage.saveHistory(scope, cacheHistory(fixture));
      await storage.saveReading(scope, { itemKey: 'fixture-anchor', offset: 12, atBottom: false, updatedAt: 1 });
      await storage.saveNavigation(identity, { savedAt: 1, projects: fixture.projects, threadsByProject: { [projectId]: fixture.threads! }, projectId, threadId });
      await storage.savePreferences({ navigationWidth: 264, inspectorWidth: 344, navigationVisible: false });
      const another = { ...scope, deviceId: 'another-device' };
      await storage.saveHistory(another, cacheHistory(fixture));
      await storage.clearHistory(identity);
      assert(await storage.readHistory(scope) === undefined && await storage.readReading(scope) === undefined && !!await storage.readNavigation(identity), 'Explicit cache clear must remove history and reading, retaining navigation for offline drafts.');
      assert(JSON.stringify(await storage.readDraft(scope)) === JSON.stringify(preserved), 'Cache clear must retain draft exactly.');
      assert((await storage.readPreferences())?.navigationVisible === false && !!await storage.readHistory(another), 'Cache clear must retain layout and other identities.');
      checks.push('clear history preserves drafts navigation layout and other identity namespaces');
      const evictionName = freshName(), eviction = new ClientStorage({ name: evictionName });
      try {
        const oldest = { ...scope, threadId: 'oldest-cache-thread' };
        await eviction.saveDraft(oldest, content, 0);
        await eviction.saveReading(oldest, { itemKey: 'oldest-item', offset: -12, atBottom: false, updatedAt: 1 });
        await eviction.saveHistory(oldest, { ...cacheHistory(fixture), thread: { ...fixture.thread!, id: oldest.threadId } });
        for (let index = 0; index < 33; index++) {
          const next = { ...scope, threadId: `lru-thread-${index}` };
          await eviction.saveHistory(next, { ...cacheHistory(fixture), thread: { ...fixture.thread!, id: next.threadId } });
        }
        assert(await eviction.readHistory(oldest) === undefined, 'Bounded history LRU must evict the oldest display history.');
        assert((await eviction.readDraft(oldest))?.text === content.text && (await eviction.readReading(oldest))?.itemKey === 'oldest-item', 'History eviction must preserve durable draft and reading bookmark.');
        const newest = { ...scope, threadId: 'lru-thread-32' }; assert(!!await eviction.readHistory(newest), 'Newest display history must survive.');
      } finally { eviction.close(); }
      checks.push('bounded history LRU evicts display data while preserving drafts and bookmarks');
      const beforeQuota = await storage.readDraft(scope);
      const originalPut = IDBObjectStore.prototype.put;
      try {
        IDBObjectStore.prototype.put = function () { throw new DOMException('Synthetic quota fault', 'QuotaExceededError'); };
        await errorCode(() => storage.saveDraft(scope, { ...content, text: 'must not commit' }, preserved.revision), 'quota');
      } finally { IDBObjectStore.prototype.put = originalPut; }
      assert(JSON.stringify(await storage.readDraft(scope)) === JSON.stringify(beforeQuota), 'Aborted quota transaction must leave original bytes readable.');
      checks.push('quota failure aborts transaction without clearing last committed draft');
      const key = scopeKey(scope);
      await raw(name, 'drafts', key, value => ({ ...value, checksum: value.checksum ^ 1 }));
      const corruptBefore = await raw(name, 'drafts', key);
      await errorCode(() => storage.readDraft(scope), 'corrupt');
      assert(JSON.stringify(await raw(name, 'drafts', key)) === JSON.stringify(corruptBefore), 'Corrupt record must remain untouched for recovery.');
      checks.push('corrupt checksum reports failure and retains the original record');
      const futureName = freshName();
      const future = await open(futureName, 2, db => db.createObjectStore('future'));
      await new Promise<void>((resolve, reject) => { const tx = future.transaction('future', 'readwrite'); tx.objectStore('future').put('future data', 'marker'); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); future.close();
      const older = new ClientStorage({ name: futureName });
      try { await errorCode(() => older.readDraft(scope), 'version'); } finally { older.close(); }
      assert(await raw(futureName, 'future', 'marker') === 'future data', 'Unknown newer schema must not be reset.');
      checks.push('future schema safely fails without downgrading or deleting data');
      const incompleteName = freshName(); const incomplete = await open(incompleteName, 1, db => db.createObjectStore('drafts')); incomplete.close();
      const broken = new ClientStorage({ name: incompleteName });
      try { await errorCode(() => broken.readDraft(scope), 'corrupt'); } finally { broken.close(); }
      const retained = await open(incompleteName); assert(retained.objectStoreNames.length === 1 && retained.version === 1, 'Incomplete schema must remain intact.'); retained.close();
      checks.push('incomplete schema fails without destructive automatic repair');
      const cancelledName = freshName(), cancelled = new ClientStorage({ name: cancelledName });
      const staleRead = cancelled.readDraft(scope);
      cancelled.close();
      await errorCode(() => staleRead, 'unavailable');
      const afterClose = await cancelled.saveDraft(scope, content, 0);
      assert((await cancelled.readDraft(scope))?.clientDraftId === afterClose.clientDraftId, 'Late opening callback must not replace the new connection generation.'); cancelled.close();
      checks.push('close during pending open rejects old work and safely opens a new generation');
      const blockedName = freshName(); const blocker = await open(blockedName, 1, db => LOCAL_STORES.forEach(store => db.createObjectStore(store)));
      await new Promise<void>((resolve, reject) => { const tx = blocker.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put('blocked upgrade sentinel', 'sentinel'); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
      const factory = { open: () => indexedDB.open(blockedName, 2) } as unknown as IDBFactory;
      const blocked = new ClientStorage({ name: blockedName, factory, openTimeoutMs: 500 });
      try { await errorCode(() => blocked.readDraft(scope), 'blocked'); } finally { blocker.close(); blocked.close(); }
      const afterBlocked = await open(blockedName); assert(afterBlocked.version === 1, 'Late blocked upgrade must abort instead of changing the version after reporting failure.'); afterBlocked.close();
      assert(await raw(blockedName, 'drafts', 'sentinel') === 'blocked upgrade sentinel', 'Late blocked upgrade must preserve original records.');
      checks.push('real blocked upgrade aborts late migration and preserves original version and records');
      return checks;
    } finally {
      storage.close();
      for (const name of names) await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('Owned fixture database still open.')); });
    }
  }, { fixture, identity, projectId, threadId });
  passed.push(...checks.map(name => `IndexedDB: ${name}`));
}

async function localRows(page: Page, store: string): Promise<any[]> {
  return page.evaluate(async store => {
    const databases = await indexedDB.databases();
    if (!databases.some(value => value.name === 'oraculum-desktop-v2-local')) return [];
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('oraculum-desktop-v2-local'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { return await new Promise<any[]>((resolve, reject) => { const tx = db.transaction(store), request = tx.objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
    finally { db.close(); }
  }, store);
}
function disconnected(): WorkspaceState {
  return { connection: { ...fixture.connection, status: 'offline' }, localScope: identity, projects: [], roots: [], streamItems: [], interactions: [], synchronization: 'stale', attachments: [], draftId: '', operations: [], busy: false };
}
async function firstVisible(page: Page): Promise<{ key: string; offset: number }> {
  return page.evaluate(() => {
    const viewport = document.querySelector('.conversation-scroll')!.getBoundingClientRect();
    const node = Array.from(document.querySelectorAll<HTMLElement>('[data-conversation-key]')).find(node => node.getBoundingClientRect().bottom > viewport.top + 1);
    if (!node) throw new Error('No visible conversation row.');
    return { key: node.dataset.conversationKey!, offset: node.getBoundingClientRect().top - viewport.top };
  });
}

acceptance: try {
  let page = await launch();
  await check('real GNOME Wayland sandbox and isolated fixture Profile', async () => {
    const facts = await app!.evaluate(({ app, BrowserWindow, safeStorage }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      const p = (wc as unknown as { getLastWebPreferences(): Record<string, unknown> }).getLastWebPreferences();
      return { rendererPid: wc.getOSProcessId(), profile: app.getPath('userData'), argv: process.argv,
        versions: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
        storage: { available: safeStorage.isEncryptionAvailable(), backend: safeStorage.getSelectedStorageBackend() },
        preferences: { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, webSecurity: p.webSecurity, webviewTag: p.webviewTag } };
    });
    assert.equal(facts.profile, profile); assert.equal((await stat(profile)).mode & 0o777, 0o700);
    assert.deepEqual(facts.preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false });
    assert.ok(!facts.argv.some(value => /no-sandbox|disable-web-security|disable-setuid-sandbox/.test(value)));
    const status = await readFile(`/proc/${facts.rendererPid}/status`, 'utf8');
    const sandbox = { seccomp: status.match(/^Seccomp:\s+(\d+)$/m)?.[1], noNewPrivileges: status.match(/^NoNewPrivs:\s+(\d+)$/m)?.[1] };
    assert.deepEqual(sandbox, { seccomp: '2', noNewPrivileges: '1' });
    runtime = { versions: facts.versions, preferences: facts.preferences, sandbox, secureStorage: facts.storage, helperOverrideUsed: Boolean(env.CHROME_DEVEL_SANDBOX) };
  });
  if (args.includes('--close-probe')) {
    await closeWindow(page, false); page = await launch(); await closeWindow(page);
    await writeFile(join(output, 'close-probe.json'), JSON.stringify({ source, manifestHash, nativeCloseEvents }, null, 2) + '\n');
    console.log('DESKTOP_P43_CLOSE_PROBE_OK'); break acceptance;
  }
  await check('actual 1000-message render scroll DOM and memory measurement', () => measureHistory(page));
  await capture(page, baseline ? 'baseline-long-history.png' : 'fixture-long-history.png');

  if (!baseline) {
    await check('reading old messages stays anchored across live append and history prepend', async () => {
      const long = longFixture();
      await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 60_000; });
      await expect(page.getByRole('button', { name: '回到最新消息', exact: true })).toBeVisible();
      const latestBounds = await page.getByRole('button', { name: '回到最新消息', exact: true }).boundingBox();
      assert.ok(latestBounds && latestBounds.height >= 32, 'The sticky return-to-latest button must retain its full click target height.');
      await paints(page);
      const before = await firstVisible(page);
      const appended: WorkspaceState = { ...long, streamItems: [{ turnId: 'stream-turn', item: { id: 'stream-item', type: 'agentMessage', text: '新增流式内容不会抢走阅读位置。' } }] };
      await publish(appended); await paints(page);
      const after = await firstVisible(page);
      assert.equal(after.key, before.key); assert.ok(Math.abs(after.offset - before.offset) < 3, `Live append shifted anchor by ${after.offset - before.offset}px.`);
      const earlier = Array.from({ length: 20 }, (_, index) => ({ id: `earlier-turn-${index}`, status: 'completed', items: [{ id: `earlier-item-${index}`, type: 'agentMessage', text: `更早的历史消息 ${index}` }] }));
      await publish({ ...appended, history: { ...long.history!, items: [...earlier, ...long.history!.items] } }); await paints(page);
      const prepended = await firstVisible(page);
      assert.equal(prepended.key, before.key); assert.ok(Math.abs(prepended.offset - before.offset) < 3, `Prepend shifted anchor by ${prepended.offset - before.offset}px.`);
      measurements.anchor = { original: before, afterLiveAppend: after, afterHistoryPrepend: prepended };
      assert.ok(await page.locator('article.message').count() <= 81);
      await expect.poll(async () => (await localRows(page, 'reading')).some(row => row.value.itemKey === before.key && row.value.atBottom === false)).toBe(true);
    });
    await check('switching between long conversations restores each independent native bookmark', async () => {
      const a = longFixture(), b = { ...longFixture(), threadId: 'bookmark-thread-b', thread: { ...fixture.thread!, id: 'bookmark-thread-b', title: '第二段长历史（模拟数据）' } };
      await publish(a); await paints(page);
      const beforeA = await firstVisible(page);
      await publish(b);
      await expect(page.locator('.conversation-inner')).toHaveAttribute('data-conversation-scope', /bookmark-thread-b/);
      await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 24_000; });
      await expect(page.getByRole('button', { name: '回到最新消息', exact: true })).toBeVisible(); await paints(page);
      const beforeB = await firstVisible(page);
      await expect.poll(async () => (await localRows(page, 'reading')).some(row => row.key.includes('bookmark-thread-b') && row.value.itemKey === beforeB.key)).toBe(true);
      await publish(a);
      await expect.poll(async () => (await firstVisible(page)).key).toBe(beforeA.key); await paints(page);
      const afterA = await firstVisible(page); assert.ok(Math.abs(afterA.offset - beforeA.offset) < 4);
      await publish(b);
      await expect.poll(async () => (await firstVisible(page)).key).toBe(beforeB.key); await paints(page);
      const afterB = await firstVisible(page); assert.ok(Math.abs(afterB.offset - beforeB.offset) < 4);
      measurements.switchBookmarks = { a: { before: beforeA, after: afterA }, b: { before: beforeB, after: afterB } };
      await publish(a); await expect.poll(async () => (await firstVisible(page)).key).toBe(beforeA.key);
      await expect(page.locator('.conversation-inner')).toHaveAttribute('data-conversation-scope', new RegExp(`${threadId.replaceAll('-', '\\-')}"\\]$`));
    });
    await check('normal close and new Electron process restore offline history draft and reading position', async () => {
      const text = 'P4.3 离线草稿 · 重启后继续整理，不自动发送。';
      await page.getByRole('textbox', { name: '消息草稿', exact: true }).fill(text);
      await expect.poll(async () => (await localRows(page, 'drafts')).some(row => row.value.text === text)).toBe(true);
      await expect.poll(async () => (await localRows(page, 'history')).some(row => row.value.history?.items.length >= 1000)).toBe(true);
      const before = await firstVisible(page);
      const beforeClose = { visibleScope: JSON.parse((await page.locator('.conversation-inner').getAttribute('data-conversation-scope'))!).slice(3),
        navigation: (await localRows(page, 'navigation')).map(row => ({ projectId: row.value.projectId, threadId: row.value.threadId })),
        drafts: (await localRows(page, 'drafts')).map(row => ({ scope: JSON.parse(row.key).slice(3), knownText: row.value.text === text, revision: row.value.revision })) };
      measurements.restartDiagnostic = { beforeClose };
      await closeWindow(page);
      const started = Date.now(); page = await launch();
      measurements.restartDiagnostic = { beforeClose, afterCloseBeforeHydration: {
        navigation: (await localRows(page, 'navigation')).map(row => ({ projectId: row.value.projectId, threadId: row.value.threadId })),
        drafts: (await localRows(page, 'drafts')).map(row => ({ scope: JSON.parse(row.key).slice(3), knownText: row.value.text === text, revision: row.value.revision })) } };
      await publish(disconnected());
      await expect(page.getByRole('textbox', { name: '消息草稿', exact: true })).toHaveValue(text);
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: '新建会话', exact: false })).toBeDisabled();
      await expect(page.locator('.conversation-window')).toHaveAttribute('data-message-count', /10[0-9][0-9]/);
      await paints(page);
      const after = await firstVisible(page);
      assert.equal(after.key, before.key); assert.ok(Math.abs(after.offset - before.offset) < 4, `Restart shifted bookmark by ${after.offset - before.offset}px.`);
      measurements.offlineRestart = { elapsedMs: Date.now() - started, before, after };
      assert.deepEqual(await app!.evaluate(() => (globalThis as DiagnosticGlobal).p43Diagnostics.actions), [], 'Offline hydration must never dispatch a Gateway action.');
      await capture(page, 'fixture-offline-restart.png');
    });
    if (restartDiagnostic) {
      await writeFile(join(output, 'restart-diagnostic.json'), JSON.stringify({ status: 'passed', source, manifestHash, checks: passed, performance: measurements }, null, 2) + '\n');
      console.log('DESKTOP_P43_RESTART_DIAGNOSTIC_OK'); break acceptance;
    }
    await check('forced client process termination preserves acknowledged local draft without sending', async () => {
      const text = 'P4.3 强退前已提交的本机草稿';
      await page.getByRole('textbox', { name: '消息草稿', exact: true }).fill(text);
      await expect.poll(async () => (await localRows(page, 'drafts')).some(row => row.value.text === text)).toBe(true);
      await crashOwnedClient(); page = await launch(); await publish(disconnected());
      await expect(page.getByRole('textbox', { name: '消息草稿', exact: true })).toHaveValue(text);
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
      assert.deepEqual(await app!.evaluate(() => (globalThis as DiagnosticGlobal).p43Diagnostics.actions), []);
    });
    await check('offline navigation and scope changes preserve separate drafts without IPC writes', async () => {
      await publish(fixture);
      await expect(page.getByRole('textbox', { name: '消息草稿', exact: true })).toBeVisible();
      await page.getByRole('textbox', { name: '消息草稿', exact: true }).fill('第一会话草稿');
      await expect.poll(async () => (await localRows(page, 'drafts')).some(row => row.value.text === '第一会话草稿')).toBe(true);
      const second = { ...fixture, threadId: 'second-fixture-thread', thread: { ...fixture.thread!, id: 'second-fixture-thread', title: '第二会话（模拟数据）' },
        threads: { ...fixture.threads!, threads: [...fixture.threads!.threads, { ...fixture.thread!, id: 'second-fixture-thread', title: '第二会话（模拟数据）' }] } };
      await publish(second);
      await expect(page.getByRole('textbox', { name: '消息草稿', exact: true })).toHaveValue('');
      await page.getByRole('textbox', { name: '消息草稿', exact: true }).fill('第二会话草稿');
      await expect.poll(async () => (await localRows(page, 'drafts')).some(row => row.value.text === '第二会话草稿')).toBe(true);
      await expect.poll(async () => (await localRows(page, 'navigation')).some(row => row.value.threadsByProject[projectId]?.threads.length === 2)).toBe(true);
      await publish({ ...second, connection: { ...fixture.connection, status: 'offline' }, synchronization: 'stale' });
      const actionsBefore = await app!.evaluate(() => (globalThis as DiagnosticGlobal).p43Diagnostics.actions.length);
      await page.getByRole('button', { name: /持久化与离线阅读（模拟数据）/ }).click();
      await expect(page.getByRole('textbox', { name: '消息草稿', exact: true })).toHaveValue('第一会话草稿');
      await page.getByRole('button', { name: /第二会话（模拟数据）/ }).click();
      await expect(page.getByRole('textbox', { name: '消息草稿', exact: true })).toHaveValue('第二会话草稿');
      assert.equal(await app!.evaluate(() => (globalThis as DiagnosticGlobal).p43Diagnostics.actions.length), actionsBefore);
      for (const other of [{ ...identity, endpoint: `${identity.endpoint}different/` }, { ...identity, installationId: 'new-installation' }, { ...identity, deviceId: 'new-device' }]) {
        await publish({ ...disconnected(), connection: { ...disconnected().connection, ...other }, localScope: other });
        await expect(page.locator('article.message')).toHaveCount(0);
        await expect(page.getByRole('textbox', { name: '消息草稿', exact: true })).toHaveCount(0);
      }
      await publish(disconnected());
      await expect(page.getByRole('textbox', { name: '消息草稿', exact: true })).toHaveValue('第二会话草稿');
      await publish({ ...disconnected(), connection: { ...disconnected().connection, status: 'revoked' }, localScope: undefined });
      await expect(page.locator('article.message')).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: '消息草稿', exact: true })).toHaveCount(0);
      assert.equal((await localRows(page, 'drafts')).filter(row => ['第一会话草稿', '第二会话草稿'].includes(row.value.text)).length, 2);
    });
    await check('quota fault preserves editor and committed draft, blocks send, and explicit retry saves', async () => {
      await publish(fixture);
      const draft = page.getByRole('textbox', { name: '消息草稿', exact: true });
      await expect(draft).toHaveValue('第一会话草稿');
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
      await page.evaluate(() => {
        const state = window as unknown as { p43OriginalPut?: typeof IDBObjectStore.prototype.put };
        state.p43OriginalPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args: Parameters<typeof IDBObjectStore.prototype.put>) {
          if (this.name === 'drafts') throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
          return state.p43OriginalPut!.apply(this, args);
        };
      });
      await draft.fill('空间不足期间仍保留的当前编辑');
      await expect(page.locator('.local-storage-notice')).toContainText('空间不足');
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
      await expect(draft).toHaveValue('空间不足期间仍保留的当前编辑');
      assert.ok((await localRows(page, 'drafts')).some(row => row.value.text === '第一会话草稿'));
      await capture(page, 'fixture-storage-failure.png');
      await page.evaluate(() => { const state = window as unknown as { p43OriginalPut: typeof IDBObjectStore.prototype.put }; IDBObjectStore.prototype.put = state.p43OriginalPut; });
      await page.getByRole('button', { name: '重试保存', exact: true }).click();
      await expect.poll(async () => (await localRows(page, 'drafts')).some(row => row.value.text === '空间不足期间仍保留的当前编辑')).toBe(true);
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
    });
    await check('Chinese composition Enter and keyCode 229 never dispatch send', async () => {
      const draft = page.getByRole('textbox', { name: '消息草稿', exact: true });
      await draft.fill('中文候选确认不会发送');
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
      const before = await app!.evaluate(() => (globalThis as DiagnosticGlobal).p43Diagnostics.actions.length);
      await draft.dispatchEvent('compositionstart', { data: '中文' });
      await draft.press('Control+Enter');
      await draft.evaluate(element => {
        element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', ctrlKey: true, keyCode: 229, isComposing: false }));
        element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
        element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', ctrlKey: true }));
      });
      await paints(page);
      assert.equal(await app!.evaluate(() => (globalThis as DiagnosticGlobal).p43Diagnostics.actions.length), before);
      await expect(draft).toHaveValue('中文候选确认不会发送');
    });
    await check('unknown operation locks send while keeping the stored draft readable', async () => {
      await publish({ ...fixture, operations: [{ operationId: '66666666-6666-4666-8666-666666666666', projectId, threadId, kind: 'turn.start', status: 'unknown', createdAt: 1 }] });
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
      await expect(page.locator('.operation-banner')).toContainText('等待核实');
      await expect(page.getByRole('textbox', { name: '消息草稿', exact: true })).toHaveValue('中文候选确认不会发送');
      await publish({ ...fixture, synchronization: 'stale' });
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
      await publish(fixture);
    });
    await check('long tool output is lazy bounded expandable and readable offline without native requests', async () => {
      const output = 'synthetic tool output line\n'.repeat(10_000);
      await publish({ ...fixture, connection: { ...fixture.connection, status: 'offline' }, synchronization: 'stale', history: { ...fixture.history!, historyRevision: 'tool-output-revision', items: [
        { id: 'long-tool-turn', status: 'completed', items: [{ id: 'long-tool-item', type: 'commandExecution', command: 'fixture output only', aggregatedOutput: output, status: 'completed', detailsAvailable: true }] },
      ] } });
      const article = page.locator('[data-item-id="long-tool-item"]'); await expect(article).toBeVisible();
      await expect(article.locator('.native-output')).toHaveCount(0);
      const actions = await app!.evaluate(() => (globalThis as DiagnosticGlobal).p43Diagnostics.actions.length);
      await article.locator('.native-item > summary').click();
      await expect.poll(async () => (await article.locator('.native-output').textContent())?.length).toBe(16_000);
      await article.getByRole('button', { name: /继续显示内容/ }).click();
      await expect.poll(async () => (await article.locator('.native-output').textContent())?.length).toBe(32_000);
      await article.getByRole('button', { name: '收起长内容', exact: true }).click();
      await expect.poll(async () => (await article.locator('.native-output').textContent())?.length).toBe(16_000);
      await expect(article.getByRole('button', { name: '载入详情', exact: true })).toBeDisabled();
      assert.equal(await app!.evaluate(() => (globalThis as DiagnosticGlobal).p43Diagnostics.actions.length), actions);
      await publish(fixture);
    });
    await check('three themes preserve full Outline OLED black and approved Diff size', async () => {
      const manifest = JSON.parse(await readFile(join(bundle, 'renderer-manifest.json'), 'utf8')) as { files: Record<string, unknown> };
      const outline = await readFile(join(root, 'design/brand/oracle-eye-user/oraculum_oracle_eye_outline.svg'));
      let found = false;
      for (const name of Object.keys(manifest.files).filter(name => name.endsWith('.svg'))) if ((await readFile(join(bundle, 'renderer', name))).equals(outline)) found = true;
      assert.ok(found, 'Original Outline bytes must be packaged.');
      await page.getByRole('tab', { name: '变更', exact: true }).click();
      assert.equal(await page.locator('.diff-line').first().evaluate(element => getComputedStyle(element).fontSize), '10px');
      for (const [theme, label] of [['light', 'Light'], ['dark', 'Dark'], ['oled', 'OLED Dark']] as const) {
        await page.getByRole('button', { name: label, exact: true }).click(); await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await capture(page, `fixture-${theme}.png`);
        if (theme === 'oled') assert.ok((await page.locator('.navigation,.conversation,.inspector').evaluateAll(elements => elements.map(element => getComputedStyle(element).backgroundColor))).every(color => color === 'rgb(0, 0, 0)'));
      }
    });
    await check('panel shortcuts separators menus and narrow modal focus are usable', async () => {
      await page.keyboard.press('Control+b'); await expect(page.locator('.navigation')).toBeHidden();
      await page.keyboard.press('Control+k'); await expect(page.getByRole('textbox', { name: '搜索会话', exact: true })).toBeFocused();
      const separator = page.getByRole('separator').first(); await separator.focus();
      const before = await separator.getAttribute('aria-valuenow'); await page.keyboard.press('ArrowRight');
      await expect.poll(() => separator.getAttribute('aria-valuenow')).not.toBe(before);
      await page.locator('.thread-actions > summary').click(); await expect(page.locator('.thread-actions')).toHaveAttribute('open', '');
      await page.locator('.thread-actions input').first().focus(); await page.keyboard.press('Escape');
      await expect(page.locator('.thread-actions > summary')).toBeFocused(); await expect(page.locator('.thread-actions')).not.toHaveAttribute('open', '');
      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 700));
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.keyboard.press('Control+i');
      const modal = page.getByRole('dialog', { name: 'Inspector', exact: true }); await expect(modal).toBeVisible();
      const actions = await app!.evaluate(() => (globalThis as DiagnosticGlobal).p43Diagnostics.actions.length);
      await page.keyboard.press('Control+n');
      assert.equal(await app!.evaluate(() => (globalThis as DiagnosticGlobal).p43Diagnostics.actions.length), actions, 'Modal shortcuts must not create a thread behind Inspector.');
      for (let index = 0; index < 12; index++) {
        await page.keyboard.press('Tab');
        assert.equal(await modal.evaluate(element => element.contains(document.activeElement)), true, 'Tab focus escaped the modal.');
      }
      await capture(page, 'fixture-narrow-inspector.png');
      await page.keyboard.press('Escape'); await expect(modal).toHaveCount(0);
      await expect(page.getByRole('button', { name: '展开 Inspector', exact: true })).toBeFocused();
      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 960));
    });
    await check('programmatic native appearance menu resets layout while keeping conversation and drafts', async () => {
      const text = await page.getByRole('textbox', { name: '消息草稿', exact: true }).inputValue();
      await page.keyboard.press('Control+b'); await expect(page.locator('.navigation')).toBeHidden();
      // CDP keyboard dispatch bypasses Electron before-input-event on this host
      // (also documented by the P4.1 harness). Invoke the actual native handler;
      // physical Ctrl+Shift+0 belongs to the separate Computer Use acceptance.
      await app!.evaluate(({ BrowserWindow, Menu }) => {
        const win = BrowserWindow.getAllWindows()[0];
        const item = Menu.getApplicationMenu()?.getMenuItemById('restore-default-appearance');
        if (!item?.enabled) throw new Error('Native appearance recovery menu is unavailable.');
        item.click(item, win, {});
      });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light'); await expect(page.locator('.navigation')).toBeVisible();
      await expect(page.getByRole('separator', { name: '调整导航宽度', exact: true })).toHaveAttribute('aria-valuenow', '256');
      await expect(page.getByRole('separator', { name: '调整 Inspector 宽度', exact: true })).toHaveAttribute('aria-valuenow', '344');
      await expect(page.getByRole('textbox', { name: '消息草稿', exact: true })).toHaveValue(text);
      await expect(page.locator('.conversation-inner')).toContainText('没有连接 Gateway');
    });
    await check('offline clear-history confirmation retains the drafts and navigation needed to edit them', async () => {
      const before = await localRows(page, 'drafts');
      await closeWindow(page); page = await launch(); await publish(disconnected());
      await expect(page.getByRole('textbox', { name: '消息草稿', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '连接与外观', exact: false }).click();
      await page.getByRole('button', { name: '清除本地历史', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '清除这台电脑保存的历史？', exact: true }); await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: '确认操作', exact: true }).click();
      await expect.poll(async () => (await localRows(page, 'history')).length).toBe(0);
      assert.deepEqual(await localRows(page, 'drafts'), before);
      assert.ok((await localRows(page, 'navigation')).length > 0);
      await page.getByRole('button', { name: '返回工作台', exact: true }).click();
      await expect(page.getByRole('textbox', { name: '消息草稿', exact: true })).toHaveValue('中文候选确认不会发送');
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
      await expect(page.locator('article.message')).toHaveCount(0);
      assert.deepEqual(await app!.evaluate(() => (globalThis as DiagnosticGlobal).p43Diagnostics.actions), []);
    });
    await check('real IndexedDB faults and recovery preserve data invariants', () => storageFaults(page));
  }

  await check('zero Gateway traffic and unchanged built resources', async () => {
    assert.equal(await app!.evaluate(() => (globalThis as DiagnosticGlobal).p43Diagnostics.tcpAttempts), 0);
    assert.deepEqual(externalRequests, []); assert.deepEqual(pageErrors, []);
    assert.equal(createHash('sha256').update(await readFile(join(bundle, 'renderer-manifest.json'))).digest('hex'), manifestHash, 'Do not rebuild concurrently with this harness.');
    await closeWindow(page);
    assert.equal(totalNetworkAttempts, 0);
  });
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'passed', phase: baseline ? 'P4.2 performance baseline' : 'P4.3 fixtures', source, manifestHash,
    evidence: 'Actual sandboxed Electron on GNOME/Wayland with generated fixtures; no Gateway connection', runtime, checks: passed, performance: measurements, screenshots,
    mainTcpAttemptsAfterLaunch: totalNetworkAttempts, ordinaryRendererExternalRequestsAfterLaunch: externalRequests.length,
    limitations: ['All histories and identities are generated test data, not native Codex execution.', 'Fixtures enter through the real main/preload event; credentials and Gateway handshake are not simulated as successes.',
      'Network guard attaches after launch; the Profile starts empty and product policy also blocks renderer networking.', 'Playwright debugger loopback endpoints are automation plumbing, not a test Gateway.',
      'Scripted composition events exercise IME guards; physical input method acceptance requires the separate Computer Use check.',
      'Native appearance recovery invokes the real menu handler programmatically; CDP bypasses Electron before-input-event, so physical Ctrl+Shift+0 is a separate check.',
      'No TLS/public network, production service changes, DEB or release work.'] }, null, 2) + '\n');
  console.log(`DESKTOP_P43_${baseline ? 'BASELINE' : 'FIXTURES'}_OK ${passed.length} checks`);
} catch (error) {
  if (app) { const page = app.windows()[0]; if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => undefined); }
  await writeFile(join(output, 'failure.json'), JSON.stringify({ stage, passed, source, manifestHash, performance: measurements, error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n');
  throw error;
} finally {
  if (app) await app.close().catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}
