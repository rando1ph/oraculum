/**
 * P4.2 actual Electron safety/UI fixtures. Run AFTER pnpm build:desktop, without
 * a concurrent build or native desktop acceptance run. No Gateway is started
 * or contacted. The real main/preload remain installed; synthetic display DTOs
 * enter only through the normal workspace-changed IPC event. Business actions
 * continue to reach the real unconfigured controller and its validation.
 *
 * On the documented Ubuntu host, invoke with the P4.1 runtime/helper environment:
 * ELECTRON_OVERRIDE_DIST_PATH="$PWD/.local/desktop-p41/electron-runtime" \
 * CHROME_DEVEL_SANDBOX=/opt/google/chrome/chrome-sandbox \
 * pnpm exec tsx scripts/desktop-p42-fixtures.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import type { DesktopBridge } from '../apps/desktop/src/contracts/desktop';
import type { FileChangeContext, WorkspaceAction, WorkspaceState } from '../apps/desktop/src/contracts/workspace';
import { IPC } from '../apps/desktop/src/main/ipc-channels';

type DesktopWindow = Window & { oraculumDesktop: DesktopBridge; p42InlineExecuted?: boolean };
type ActionObservation = { action: WorkspaceAction; completed: boolean; result?: { status: string; endpoint: string; operationCount: number; notice?: string }; error?: string };
type Diagnostics = { tcpAttempts: number; navigationDenied?: boolean; downloadDenied?: boolean; actions?: ActionObservation[] };
type DiagnosticGlobal = typeof globalThis & { p42FixtureDiagnostics?: Diagnostics };
const root = resolve(import.meta.dirname, '..');
const bundle = join(root, 'apps/desktop/dist');
const require = createRequire(join(root, 'apps/desktop/package.json'));
const executablePath = require('electron') as string;
const outputArg = process.argv.slice(2).find(arg => arg.startsWith('--output='));
const output = resolve(outputArg?.slice('--output='.length) || join(root, '.local/desktop-p42-fixtures'));
const entry = 'oraculum-app://bundle/index.html';
const projectId = '44444444-4444-4444-8444-444444444444';
const epoch = '22222222-2222-4222-8222-222222222222';
const threadId = 'fixture-thread';
const turnId = 'fixture-turn';
// Valid 32 × 32 PNG from the dedicated P4.2 test project, embedded so this
// fixture never depends on or directly opens a host project file at runtime.
const imagePreviewUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGNwq/CmKWIYtWDUglELRi0YtWDUglELRi0YtWDUglELhooFALC1JD3dU4SoAAAAAElFTkSuQmCC';
const capabilityNames = ['thread.start', 'turn.start', 'turn.interrupt', 'turn.steer', 'thread.resume', 'thread.name.set', 'thread.archive', 'thread.unarchive', 'thread.delete', 'thread.fork', 'thread.compact', 'thread.revert', 'attachments', 'history', 'projects', 'interactions'];
const fixture: WorkspaceState = {
  connection: { status: 'connected', endpoint: 'http://127.0.0.1:1/', installationId: '11111111-1111-4111-8111-111111111111', deviceId: '33333333-3333-4333-8333-333333333333', epoch, secureStorage: true },
  capabilities: { gatewayVersion: 'fixture-only', installationId: '11111111-1111-4111-8111-111111111111', epoch,
    protocol: { major: 2, minor: 1, minClientMinor: 0 }, codex: { connectionState: 'connected', version: 'fixture-only' },
    limits: { attachmentFileBytes: 20_000_000, attachmentBatchBytes: 50_000_000, attachmentBatchCount: 6, eventReplayCount: 1000, historyPageItems: 20, requestBytes: 1_000_000 },
    capabilities: capabilityNames.map(name => ({ name, supported: true, availability: 'available', verified: true, maturity: 'gateway', epoch, observedVersion: 'fixture-only', reasonCode: null })) },
  projects: [{ id: projectId, name: 'P4.2 本地界面 Fixture', rootId: 'fixture-root', available: true }], roots: [{ id: 'fixture-root', label: 'Fixture' }],
  projectId, threadId, thread: { id: threadId, projectId, title: '安全边界演示（模拟数据）', status: 'idle', model: 'fixture-model', archived: false, parentThreadId: null },
  threads: { source: 'fixture-only', truncated: false, nextCursor: null, threads: [{ id: threadId, projectId, title: '安全边界演示（模拟数据）', status: 'idle', archived: false, parentThreadId: null }] },
  history: { epoch, historyRevision: 'fixture-revision', source: 'native-pagination', nextCursor: null, complete: true, truncated: false,
    items: [{ id: turnId, status: 'completed', items: [
      { id: 'fixture-user', type: 'userMessage', content: [{ type: 'text', text: '请说明未知操作为何只查询原结果。' }] },
      { id: 'fixture-assistant', type: 'agentMessage', text: '## Fixture：可信恢复\n\n本页只验证界面，**没有连接 Gateway**。\n\n| 情况 | 行为 |\n| --- | --- |\n| ACK 丢失 | 查询原操作 |\n| 404 | 保留未知状态 |\n\n```ts\nconst replayWrites = false;\n```\n\n![不自动加载的远程图片](https://example.invalid/fixture-image.png)\n<script>window.p42InlineExecuted = true</script>' },
    ] }] },
  streamItems: [], interactions: [], synchronization: 'current', attachments: [], draftId: 'fixture-draft', operations: [], busy: false,
  notice: '本地界面 fixture · 未连接 Gateway · 全部内容均为模拟数据',
  diff: 'diff --git a/fixture.ts b/fixture.ts\n--- a/fixture.ts\n+++ b/fixture.ts\n@@ -1 +1 @@\n-retryWrite();\n+queryOriginalReceipt();',
  plan: { turnId, plan: [{ step: '读取原回执', status: 'completed' }, { step: '核对原生状态', status: 'completed' }] },
  tokenUsage: { turnId, total: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 40, outputTokens: 20 }, modelContextWindow: 200000 },
  accountUsage: { source: 'native-account-usage', readAt: 1, limited: true, dailyUsageBuckets: null,
    summary: { lifetimeTokens: 100, peakDailyTokens: 100, currentStreakDays: 1, longestStreakDays: 1, longestRunningTurnSec: null } },
  extensions: { projectId, sections: [{ kind: 'plugins', entries: [], limited: true, status: 'unavailable', reasonCode: 'STABILITY_UNVERIFIED' }] },
  files: { projectId, path: '', entries: [], nextCursor: null, limited: false },
};

assert.equal(process.env.XDG_SESSION_TYPE, 'wayland', 'Run in the real GNOME Wayland session, not Xvfb.');
assert.ok(process.env.WAYLAND_DISPLAY, 'WAYLAND_DISPLAY is required.');
await mkdir(output, { recursive: true, mode: 0o700 });
const temporary = await mkdtemp(join(tmpdir(), 'oraculum-desktop-p42-fixtures-'));
const config = join(temporary, 'config');
await mkdir(config, { mode: 0o700 });
const profile = join(config, 'oraculum-desktop-v2/development-p42-fixtures');
const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ORACULUM_URL', 'ORACULUM_PORT', 'ORACULUM_USER_DATA_DIR', 'ORACULUM_RESOURCE_DIR', 'ORACULUM_DESKTOP_ICON']) delete env[key];
Object.assign(env, { XDG_CONFIG_HOME: config, ORACULUM_DESKTOP_PROFILE: 'p42-fixtures' });
const passed: string[] = [], pageErrors: string[] = [], ordinaryExternalRequests: string[] = [];
const screenshots: { file: string; sha256: string; width: number; height: number; theme: string }[] = [];
let app: ElectronApplication | undefined;
let negativeChecks = false, stage = 'initialization';
let runtime: unknown;
let actionObservations: ActionObservation[] = [];
const manifestBytes = await readFile(join(bundle, 'renderer-manifest.json'));
const manifestHash = createHash('sha256').update(manifestBytes).digest('hex');
async function check(name: string, work: () => Promise<void>) { stage = name; await work(); passed.push(name); console.log(`PASS ${name}`); }
async function publish(state: WorkspaceState) {
  await app!.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send(value.channel, value.state), { channel: IPC.workspaceChanged, state });
}
async function observeRejectedAction(index: number, expected: WorkspaceAction): Promise<void> {
  await expect.poll(() => app!.evaluate(() => (globalThis as DiagnosticGlobal).p42FixtureDiagnostics!.actions?.filter(item => item.completed).length ?? 0)).toBe(index + 1);
  const observation = await app!.evaluate((_, position) => (globalThis as DiagnosticGlobal).p42FixtureDiagnostics!.actions![position], index);
  if (expected.type === 'steer' && observation.action.type === 'steer') {
    const { clientDraftId, draftRevision, ...intent } = observation.action;
    assert.match(clientDraftId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(Number.isSafeInteger(draftRevision) && draftRevision! > 0, 'P4.3 submits the persisted local draft revision.');
    assert.deepEqual(intent, expected, 'The actual renderer intent must carry the displayed scope/digest.');
  } else assert.deepEqual(observation.action, expected, 'The actual renderer intent must carry the displayed scope/digest.');
  assert.equal(observation.error, undefined);
  assert.deepEqual(observation.result, { status: 'idle', endpoint: '', operationCount: 0, notice: 'CONNECTION_NOT_READY' },
    'The real unconfigured controller must reject fixture actions, never report native business success.');
}
async function capture(page: Page, file: string) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const visual = await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return { theme: document.documentElement.dataset.theme!, width: innerWidth, height: innerHeight,
        samples: Array.from(document.querySelectorAll('.navigation,.conversation,.inspector')).flatMap(element => {
          const bounds = element.getBoundingClientRect(), color = getComputedStyle(element).backgroundColor.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
          return bounds.width && bounds.height && color ? [{ x: bounds.left + 5, y: bounds.bottom - 5, color: [Number(color[1]), Number(color[2]), Number(color[3]), 255] }] : [];
        }) };
    });
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
    await page.waitForTimeout(50);
  }
  throw new Error('Compositor bitmap did not match the currently selected theme.');
}

try {
  await check('unchanged independent bundle and original Outline', async () => {
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as { files: Record<string, { size: number; sha256: string }> };
    const source = await readFile(join(root, 'design/brand/oracle-eye-user/oraculum_oracle_eye_outline.svg'));
    let outline = false;
    for (const [name, metadata] of Object.entries(manifest.files)) {
      assert.ok(!name.includes('..') && !name.startsWith('/'));
      const bytes = await readFile(join(bundle, 'renderer', name));
      assert.equal(bytes.length, metadata.size); assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256);
      if (name.endsWith('.svg') && bytes.equals(source)) outline = true;
    }
    assert.ok(outline);
    const originalExecutable = join(dirname(require.resolve('electron')), 'dist/electron');
    const [original, running] = await Promise.all([readFile(originalExecutable), readFile(executablePath)]);
    assert.equal(createHash('sha256').update(original).digest('hex'), createHash('sha256').update(running).digest('hex'));
    if (env.CHROME_DEVEL_SANDBOX) { const helper = await stat(env.CHROME_DEVEL_SANDBOX); assert.equal(helper.uid, 0); assert.equal(helper.mode & 0o7777, 0o4755); }
  });
  app = await electron.launch({ executablePath, args: ['--ozone-platform=wayland', '--force-renderer-accessibility', bundle], env, chromiumSandbox: true, timeout: 30000 });
  app.context().on('request', request => { if (!negativeChecks && !request.url().startsWith('oraculum-app://bundle/') && request.url() !== imagePreviewUri) ordinaryExternalRequests.push(new URL(request.url()).protocol); });
  const page = await app.firstWindow({ timeout: 20000 });
  page.on('pageerror', error => pageErrors.push(error.name));
  await expect(page.locator('.app-shell')).toBeVisible();
  assert.equal(page.url(), entry);
  await app.evaluate(() => {
    const diagnostics = { tcpAttempts: 0 };
    (globalThis as DiagnosticGlobal).p42FixtureDiagnostics = diagnostics;
    // Guard the unconfigured main against accidental test traffic. This is a
    // test-only Node boundary, not a replacement for renderer CSP/session policy.
    const network = process.getBuiltinModule('node:net') as typeof import('node:net');
    const socket = network.Socket.prototype as unknown as { connect: (...args: unknown[]) => unknown };
    socket.connect = function () { diagnostics.tcpAttempts++; throw new Error('FIXTURE_NETWORK_FORBIDDEN'); };
  });
  await check('actual sandbox, isolated Profile, secure-storage backend and finite preload API', async () => {
    const facts = await app!.evaluate(({ app, BrowserWindow, safeStorage }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      const preferences = (wc as unknown as { getLastWebPreferences(): Record<string, unknown> }).getLastWebPreferences();
      return { pid: wc.getOSProcessId(), profile: app.getPath('userData'), argv: process.argv,
        versions: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
        storage: { available: safeStorage.isEncryptionAvailable(), backend: safeStorage.getSelectedStorageBackend() },
        preferences: { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration,
          nodeIntegrationInSubFrames: preferences.nodeIntegrationInSubFrames, webSecurity: preferences.webSecurity, webviewTag: preferences.webviewTag } };
    });
    assert.equal(facts.profile, profile); assert.equal((await stat(profile)).mode & 0o777, 0o700);
    assert.deepEqual(facts.preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true, webviewTag: false });
    assert.ok(!facts.argv.some(argument => /no-sandbox|disable-web-security|disable-setuid-sandbox/.test(argument)));
    const status = await readFile(`/proc/${facts.pid}/status`, 'utf8');
    const sandbox = { seccomp: status.match(/^Seccomp:\s+(\d+)$/m)?.[1], noNewPrivileges: status.match(/^NoNewPrivs:\s+(\d+)$/m)?.[1] };
    assert.deepEqual(sandbox, { seccomp: '2', noNewPrivileges: '1' });
    assert.equal(facts.storage.available, true); assert.equal(facts.storage.backend, 'gnome_libsecret');
    const exposed = await page.evaluate(async () => {
      const api = (window as unknown as DesktopWindow).oraculumDesktop;
      const native = window as unknown as { require?: unknown; process?: unknown };
      return { methods: Object.keys(api).sort(), frozen: Object.isFrozen(api), node: typeof native.require, process: typeof native.process,
        workspace: await api.getWorkspace() };
    });
    assert.deepEqual(exposed.methods, ['getState', 'getWorkspace', 'onStateChanged', 'onWorkspaceChanged', 'onBeforeClose', 'resetAppearance', 'setPreferences', 'workspaceAction'].sort());
    assert.equal(exposed.frozen, true); assert.equal(exposed.node, 'undefined'); assert.equal(exposed.process, 'undefined');
    assert.equal(exposed.workspace.connection.status, 'idle'); assert.equal(exposed.workspace.connection.endpoint, '');
    assert.equal(exposed.workspace.connection.secureStorage, true);
    runtime = { versions: facts.versions, preferences: facts.preferences, sandbox, secureStorage: facts.storage, helperOverrideUsed: Boolean(env.CHROME_DEVEL_SANDBOX) };
  });
  await check('real business IPC rejects open RPC, malformed actions and unsafe endpoints without network', async () => {
    const rejected = await page.evaluate(async () => {
      const api = (window as unknown as DesktopWindow).oraculumDesktop;
      const bad: unknown[] = [null, [], 'send', { type: 'rpc', method: 'turn/start', url: 'https://example.invalid/' },
        { type: 'send', text: 'fixture', headers: { Authorization: 'fixture' } }, { type: 'send', text: 'x'.repeat(100001) },
        { type: 'connect', endpoint: 'http://192.0.2.1:7777/' }, { type: 'connect', endpoint: 'file:///tmp/fixture' },
        { type: 'connect', endpoint: 'https://example.invalid/', method: 'GET' },
        { type: 'threadMutation', action: 'delete', confirm: false }, { type: 'downloadFile', path: '../outside' }];
      return Promise.all(bad.map(async value => { try { await api.workspaceAction(value as WorkspaceAction); return false; } catch { return true; } }));
    });
    assert.ok(rejected.every(Boolean));
    assert.equal(await app!.evaluate(() => (globalThis as DiagnosticGlobal).p42FixtureDiagnostics!.tcpAttempts), 0);
  });
  await check('registered IPC rejects synthetic foreign, detached and same-origin forged frames', async () => {
    const result = await app!.evaluate(async ({ ipcMain, BrowserWindow }, channel) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> })._invokeHandlers;
      const handler = handlers.get(channel); if (!handler) throw new Error('Expected product IPC handler is unavailable.');
      const clonedFrame = { url: contents.mainFrame.url, detached: false, isDestroyed: contents.mainFrame.isDestroyed.bind(contents.mainFrame) };
      const sources = [{ sender: contents, senderFrame: null }, { sender: contents, senderFrame: clonedFrame },
        { sender: {}, senderFrame: contents.mainFrame }, { sender: contents, senderFrame: { ...clonedFrame, detached: true } }];
      return Promise.all(sources.map(async source => { try { await handler(source); return false; } catch (error) { return error instanceof Error && error.message.includes('IPC_NOT_AUTHORIZED'); } }));
    }, IPC.getWorkspace);
    assert.ok(result.every(Boolean));
    assert.equal((await page.evaluate(() => (window as unknown as DesktopWindow).oraculumDesktop.getWorkspace())).connection.status, 'idle');
  });
  // Observe only controlled fixture business intents, forwarding the original
  // real handler/event unchanged. No action result or native state is mocked.
  await app.evaluate(({ ipcMain }, channel) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> })._invokeHandlers;
    const original = handlers.get(channel); if (!original) throw new Error('Expected product IPC handler is unavailable.');
    const diagnostics = (globalThis as DiagnosticGlobal).p42FixtureDiagnostics!;
    diagnostics.actions = [];
    handlers.set(channel, async (event, ...args) => {
      const action = args[0] as WorkspaceAction;
      if (!action || !['answer', 'interrupt', 'steer'].includes(action.type)) return original(event, ...args);
      const observation: ActionObservation = { action: JSON.parse(JSON.stringify(action)) as WorkspaceAction, completed: false };
      diagnostics.actions!.push(observation);
      try {
        const result = await original(event, ...args) as WorkspaceState;
        observation.result = { status: result.connection.status, endpoint: result.connection.endpoint, operationCount: result.operations.length,
          ...(result.notice ? { notice: result.notice } : {}) };
        return result;
      } catch (error) { observation.error = error instanceof Error ? error.name : 'unknown'; throw error; }
      finally { observation.completed = true; }
    });
  }, IPC.workspaceAction);
  await check('actual renderer displays explicit fixtures, GFM and unchanged three-theme Diff', async () => {
    await publish(fixture);
    await expect(page.locator('.conversation-inner')).toContainText('没有连接 Gateway');
    await expect(page.locator('.markdown table')).toHaveCount(1);
    await expect(page.locator('.diff-line').first()).toBeVisible();
    assert.equal(await page.locator('.diff-line').first().evaluate(element => getComputedStyle(element).fontSize), '10px');
    assert.equal(await page.evaluate(() => (window as unknown as DesktopWindow).p42InlineExecuted === true), false);
    assert.equal(await page.locator('img[src^="https:"]').count(), 0);
    for (const [theme, label] of [['light', 'Light'], ['dark', 'Dark'], ['oled', 'OLED Dark']] as const) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await capture(page, `01-fixture-${theme}.png`);
      if (theme === 'oled') assert.ok((await page.locator('.navigation,.conversation,.inspector').evaluateAll(elements => elements.map(element => getComputedStyle(element).backgroundColor))).every(color => color === 'rgb(0, 0, 0)'));
    }
    assert.equal(new Set(screenshots.map(item => item.sha256)).size, 3);
  });
  await check('actual Files preview decodes a valid PNG through the product CSP', async () => {
    await publish({ ...fixture, preview: { name: 'fixture-preview.png', mime: 'image/png', image: imagePreviewUri, limited: false } });
    await page.getByRole('tab', { name: '文件', exact: true }).click();
    const preview = page.getByRole('img', { name: 'fixture-preview.png', exact: true });
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.evaluate(element => {
      const image = element as HTMLImageElement;
      return { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight };
    })).toEqual({ complete: true, width: 32, height: 32 });
    await capture(page, '07-fixture-decoded-image-preview.png');
    await publish(fixture);
    await page.getByRole('tab', { name: '变更', exact: true }).click();
  });
  await check('unknown and offline fixture states block writes while preserving the draft', async () => {
    const draft = page.getByRole('textbox', { name: '消息草稿', exact: true });
    await draft.fill('fixture 未发送草稿');
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
    await publish({ ...fixture, operations: [{ operationId: '66666666-6666-4666-8666-666666666666', kind: 'turn.start', projectId, threadId, status: 'unknown', createdAt: 1 }] });
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    await expect(page.locator('.operation-banner')).toContainText('等待核实');
    await publish({ ...fixture, connection: { ...fixture.connection, status: 'offline' }, synchronization: 'stale' });
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    await expect(draft).toHaveValue('fixture 未发送草稿');
    await expect(page.locator('.conversation-inner')).toContainText('可信恢复');
    await capture(page, '02-fixture-offline.png');
  });
  await check('active synchronizing Turn exposes Stop and Steer while preserving stale and unknown gates', async () => {
    const active: WorkspaceState = { ...fixture, thread: { ...fixture.thread!, status: 'active' }, activeTurnId: turnId, synchronization: 'synchronizing' };
    await publish(active);
    await page.getByRole('textbox', { name: '消息草稿', exact: true }).fill('fixture 插话内容');
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '插话', exact: true })).toBeEnabled();
    await publish({ ...active, operations: [{ operationId: '66666666-6666-4666-8666-666666666666', kind: 'turn.start', projectId, threadId, status: 'unknown', createdAt: 1 }] });
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '插话', exact: true })).toBeDisabled();
    await publish({ ...active, operations: [{ operationId: '66666666-6666-4666-8666-666666666666', kind: 'turn.interrupt', projectId, threadId, status: 'unknown', createdAt: 1 }] });
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeDisabled();
    await publish({ ...active, synchronization: 'stale' });
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '插话', exact: true })).toBeDisabled();
    await publish(active);
    await capture(page, '05-fixture-active-controls.png');
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await observeRejectedAction(0, { type: 'interrupt' });
    await publish(active);
    await page.getByRole('textbox', { name: '消息草稿', exact: true }).fill('fixture 插话内容');
    await page.getByRole('button', { name: '插话', exact: true }).click();
    await observeRejectedAction(1, { type: 'steer', text: 'fixture 插话内容' });
  });
  await check('stale approvals cannot be accepted and missing patch evidence stays restricted', async () => {
    const approval = { interactionId: '55555555-5555-4555-8555-555555555555', epoch, generation: 1, kind: 'command', status: 'pending' as const,
      projectId, threadId, turnId, request: { threadId, turnId, itemId: 'fixture-command', command: 'printf fixture' } };
    const scoped: WorkspaceState = { ...fixture, activeTurnId: turnId, synchronization: 'synchronizing', interactions: [approval],
      commandScopes: { [approval.interactionId]: { relativeCwd: '.' } } };
    await publish({ ...scoped, commandScopes: undefined });
    await expect(page.getByRole('button', { name: '允许本次', exact: true })).toBeDisabled();
    await expect(page.locator('.interaction-card')).toContainText('尚未确认此命令在当前项目根目录执行');
    await publish(scoped);
    await expect(page.getByRole('button', { name: '允许本次', exact: true })).toBeEnabled();
    await expect(page.locator('.interaction-card')).toContainText('执行目录 · 当前项目根目录');
    await page.getByRole('button', { name: '允许本次', exact: true }).click();
    await observeRejectedAction(2, { type: 'answer', interactionId: approval.interactionId, generation: 1, epoch,
      response: { type: 'approval', decision: 'accept' } });
    await publish({ ...scoped, interactions: [{ ...approval, epoch: '77777777-7777-4777-8777-777777777777' }] });
    await expect(page.getByRole('button', { name: '允许本次', exact: true })).toBeDisabled();
    await publish({ ...scoped, interactions: [{ ...approval, status: 'unknown' }] });
    await expect(page.getByRole('button', { name: '允许本次', exact: true })).toBeDisabled();
    await publish({ ...fixture, interactions: [{ ...approval, kind: 'fileChange' }] });
    await expect(page.getByRole('button', { name: '允许本次', exact: true })).toBeDisabled();
    await expect(page.locator('.interaction-card')).toContainText('仅可拒绝或取消');
    await capture(page, '03-fixture-restricted-approval.png');
    await publish(fixture);
  });
  await check('bounded complete file approval evidence submits its displayed digest to the rejecting real controller', async () => {
    const approval = { interactionId: '88888888-8888-4888-8888-888888888888', epoch, generation: 2, kind: 'fileChange', status: 'pending' as const,
      projectId, threadId, turnId, request: { threadId, turnId, itemId: 'fixture-file-change', grantRoot: null } };
    const changes: FileChangeContext['changes'] = [
      { path: 'src/fixture.ts', kind: 'update', movePath: null, diff: '@@ -1 +1 @@\n-oldFixture();\n+newFixture();' },
      { path: 'docs/old-fixture.md', kind: 'update', movePath: 'docs/new-fixture.md', diff: '@@ -1 +1 @@\n-old fixture\n+<script>escaped fixture text</script>' },
    ];
    const context: FileChangeContext = { interactionId: approval.interactionId, generation: approval.generation, epoch, projectId, threadId, turnId,
      itemId: approval.request.itemId, digest: createHash('sha256').update(JSON.stringify(changes)).digest('hex'), changes };
    const state: WorkspaceState = { ...fixture, activeTurnId: turnId, synchronization: 'synchronizing', interactions: [approval], fileChangeContexts: { [approval.interactionId]: context } };
    await publish(state);
    await expect(page.locator('.file-change-evidence')).toBeVisible();
    await expect(page.locator('.file-change-proof')).toHaveCount(2);
    await expect(page.locator('.file-change-evidence')).toContainText('src/fixture.ts');
    await expect(page.locator('.file-change-evidence')).toContainText('docs/old-fixture.md → docs/new-fixture.md');
    await expect(page.locator('.file-change-evidence')).toContainText('<script>escaped fixture text</script>');
    await expect(page.locator('.file-change-evidence .diff-line')).toHaveCount(6);
    assert.equal(await page.locator('.file-change-evidence .diff-line').first().evaluate(element => getComputedStyle(element).fontSize), '10px');
    assert.equal(await page.locator('.file-change-evidence script').count(), 0);
    await expect(page.getByRole('button', { name: '允许本次', exact: true })).toBeEnabled();
    await capture(page, '06-fixture-complete-file-approval.png');
    await publish({ ...state, fileChangeContexts: { [approval.interactionId]: { ...context, itemId: 'another-item' } } });
    await expect(page.getByRole('button', { name: '允许本次', exact: true })).toBeDisabled();
    await publish({ ...state, fileChangeContexts: { [approval.interactionId]: { ...context, changes: [{ ...changes[0], diff: '+line\n'.repeat(257) }] } } });
    await expect(page.getByRole('button', { name: '允许本次', exact: true })).toBeDisabled();
    await publish({ ...state, synchronization: 'stale' });
    await expect(page.getByRole('button', { name: '允许本次', exact: true })).toBeDisabled();
    await publish(state);
    await page.getByRole('button', { name: '允许本次', exact: true }).click();
    await observeRejectedAction(3, { type: 'answer', interactionId: approval.interactionId, generation: 2, epoch,
      response: { type: 'approval', decision: 'accept' }, contextDigest: context.digest });
    await publish(fixture);
  });
  await check('archive provenance and child-thread lifecycle limitations remain explicit', async () => {
    await publish({ ...fixture, thread: { ...fixture.thread!, archived: true }, firstTurnReady: true });
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '选择并上传本机附件', exact: true })).toBeDisabled();
    await publish({ ...fixture, thread: { ...fixture.thread!, archived: undefined } });
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    await page.locator('.thread-actions > summary').click();
    await expect(page.getByRole('button', { name: '归档状态未确认', exact: true })).toBeDisabled();
    await expect(page.locator('.thread-action-menu')).toContainText('归档状态尚未核实');
    await publish({ ...fixture, thread: { ...fixture.thread!, parentThreadId: 'fixture-parent' } });
    await expect(page.getByRole('button', { name: '归档会话', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '删除会话', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '创建会话分支', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '压缩上下文', exact: true })).toBeEnabled();
    await page.getByLabel('回退到指定 Turn 之前', { exact: true }).selectOption(turnId);
    await expect(page.getByRole('button', { name: '确认回退范围', exact: true })).toBeEnabled();
    await expect(page.locator('.thread-action-menu')).toContainText('此会话属于子代理');
    await publish({ ...fixture, thread: { ...fixture.thread!, archived: true, parentThreadId: 'fixture-parent' } });
    await expect(page.getByRole('button', { name: '取消归档', exact: true })).toBeDisabled();
    await page.locator('.thread-actions > summary').click();
    await publish(fixture);
  });
  await check('narrow layout and Inspector keyboard focus remain usable', async () => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 700));
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('.inspector')).toHaveCount(0);
    await page.getByRole('button', { name: '展开 Inspector', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Inspector', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.inspector')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '展开 Inspector', exact: true })).toBeFocused();
    await capture(page, '04-fixture-narrow.png');
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 960));
  });
  await check('real CSP blocks fetch, WebSocket, inline script and iframe requests', async () => {
    negativeChecks = true;
    const result = await page.evaluate(async () => {
      const violations: { directive: string; uri: string }[] = [];
      const observer = new AbortController();
      document.addEventListener('securitypolicyviolation', event => violations.push({ directive: event.effectiveDirective, uri: event.blockedURI }), { signal: observer.signal });
      const script = document.createElement('script'); script.textContent = 'window.p42InlineExecuted=true'; document.body.append(script);
      const fetchBlocked = await fetch('https://example.invalid/p42-probe').then(() => false, () => true);
      const socketBlocked = await new Promise<boolean>(resolve => {
        const timeout = setTimeout(() => resolve(false), 2000);
        try { const socket = new WebSocket('wss://example.invalid/p42-probe'); socket.onerror = () => { clearTimeout(timeout); socket.close(); resolve(true); }; socket.onopen = () => { clearTimeout(timeout); socket.close(); resolve(false); }; }
        catch { clearTimeout(timeout); resolve(true); }
      });
      const frame = document.createElement('iframe'); frame.src = 'https://example.invalid/p42-frame'; document.body.append(frame);
      await new Promise<void>(resolve => setTimeout(resolve, 100));
      frame.remove(); script.remove(); observer.abort();
      return { fetchBlocked, socketBlocked, inlineBlocked: !(window as unknown as DesktopWindow).p42InlineExecuted, violations };
    });
    assert.equal(result.fetchBlocked, true); assert.equal(result.socketBlocked, true); assert.equal(result.inlineBlocked, true);
    for (const directive of ['connect-src', 'script-src-elem', 'frame-src']) assert.ok(result.violations.some(item => item.directive === directive), directive);
  });
  await check('actual popup, permissions and renderer navigation are denied', async () => {
    const count = app!.windows().length;
    const result = await page.evaluate(async () => ({ opened: window.open('https://example.invalid/p42-popup') !== null,
      notification: await Notification.requestPermission(), location: (await navigator.permissions.query({ name: 'geolocation' })).state }));
    assert.deepEqual(result, { opened: false, notification: 'denied', location: 'denied' }); assert.equal(app!.windows().length, count);
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.once('will-frame-navigate', event => {
      (globalThis as DiagnosticGlobal).p42FixtureDiagnostics!.navigationDenied = event.defaultPrevented;
    }));
    await page.evaluate(() => { const link = document.createElement('a'); link.id = 'p42-navigation'; link.href = 'https://example.invalid/p42-navigation'; link.textContent = 'fixture navigation probe'; document.querySelector('main')!.prepend(link); });
    await page.locator('#p42-navigation').click({ noWaitAfter: true });
    await expect.poll(() => app!.evaluate(() => (globalThis as DiagnosticGlobal).p42FixtureDiagnostics!.navigationDenied)).toBe(true);
    assert.equal(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL()), entry);
    // Restore only the trusted entry after a prevented navigation confuses the CDP driver.
    await app!.evaluate(({ BrowserWindow }, entry) => BrowserWindow.getAllWindows()[0].webContents.loadURL(entry), entry);
    await expect(page.locator('.app-shell')).toBeVisible();
    negativeChecks = false;
  });
  await check('actual renderer download is cancelled before a file is saved', async () => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', event => {
      (globalThis as DiagnosticGlobal).p42FixtureDiagnostics!.downloadDenied = event.defaultPrevented;
    }));
    await page.evaluate(() => {
      const source = getComputedStyle(document.querySelector('.oracle-eye')!).maskImage.match(/url\(["']?(.*?)["']?\)/)?.[1];
      if (!source) throw new Error('No bundled Outline resource.');
      const link = document.createElement('a'); link.id = 'p42-download'; link.href = source; link.download = 'p42-fixture.svg'; link.textContent = 'fixture download probe'; document.querySelector('main')!.prepend(link);
    });
    await page.locator('#p42-download').click({ noWaitAfter: true });
    await expect.poll(() => app!.evaluate(() => (globalThis as DiagnosticGlobal).p42FixtureDiagnostics!.downloadDenied)).toBe(true);
  });
  await check('zero fixture transport calls, unchanged bundle and no resident test client', async () => {
    const realState = await page.evaluate(() => (window as unknown as DesktopWindow).oraculumDesktop.getWorkspace());
    assert.equal(realState.connection.endpoint, ''); assert.equal(realState.connection.status, 'idle'); assert.deepEqual(realState.operations, []);
    assert.equal(await app!.evaluate(() => (globalThis as DiagnosticGlobal).p42FixtureDiagnostics!.tcpAttempts), 0);
    actionObservations = await app!.evaluate(() => (globalThis as DiagnosticGlobal).p42FixtureDiagnostics!.actions ?? []);
    assert.equal(actionObservations.length, 4);
    assert.ok(actionObservations.every(item => item.completed && !item.error && item.result?.status === 'idle'
      && item.result.endpoint === '' && item.result.operationCount === 0 && item.result.notice === 'CONNECTION_NOT_READY'));
    assert.deepEqual(ordinaryExternalRequests, []); assert.deepEqual(pageErrors, []);
    assert.equal(createHash('sha256').update(await readFile(join(bundle, 'renderer-manifest.json'))).digest('hex'), manifestHash, 'Do not rebuild concurrently with this script.');
    const processHandle = app!.process(), closed = app!.waitForEvent('close', { timeout: 15000 });
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await closed; assert.notEqual(processHandle.exitCode, null); app = undefined;
  });
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'passed', phase: 'P4.2 fixtures', manifestHash,
    evidence: 'Actual sandboxed Electron GNOME/Wayland UI with synthetic display DTOs; no Gateway connection', runtime, checks: passed, screenshots,
    mainTcpAttemptsAfterLaunch: 0, ordinaryRendererExternalRequestsAfterLaunch: 0,
    fixtureActionsForwardedToRealController: actionObservations,
    limitations: ['Business state, approval cards and unknown-operation data are fixtures, not native Codex execution.',
      'Fixture DTOs are sent through the real main-to-preload event; no authentication or HTTP/WS handshake is claimed.',
      'Stop, Steer and approval clicks reach the original real IPC handler; the unconfigured controller rejects them. Enabled fixture UI is not native action success.',
      'The file approval digest is synthetic fixture evidence; its exact IPC submission is checked, not accepted as a native Codex proof.',
      'Foreign-frame IPC rejection invokes the real registered handler with synthetic event identities.',
      'Network guards and request observers attach after Playwright launch; startup isolation also relies on the fresh empty Profile and product policy.',
      'Playwright debugger loopback endpoints are automation plumbing, not a test Gateway.',
      'No HTTPS/TLS, production Gateway, formal package or physical desktop input acceptance was performed.'] }, null, 2) + '\n');
  console.log(`DESKTOP_P42_FIXTURES_OK ${passed.length} checks`);
} catch (error) {
  if (app) { const page = app.windows()[0]; if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => undefined); }
  await writeFile(join(output, 'failure.json'), JSON.stringify({ stage, passed, error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n');
  throw error;
} finally {
  if (app) await app.close().catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}
