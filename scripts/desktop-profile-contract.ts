// Real Electron / Chromium storage and real authenticated Bridge; simulated Codex only.
// All profiles, HOME/XDG directories and trust data are disposable fixtures.
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as reservePort } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../bridge/src/server';
import type { BridgeService } from '../bridge/src/service';
import { TrustStore } from '../bridge/src/trust-store';

const main = resolve('apps/desktop/main.cjs');
const require = createRequire(main);
const executablePath: string = require('electron');
// Opt in only for hosts whose sandbox cannot run in the automation environment.
// Product flags and BrowserWindow security settings are never changed.
const sandbox = process.env.ORACULUM_PROFILE_TEST_NO_SANDBOX !== '1';
const dir = await mkdtemp(join(tmpdir(), 'oraculum-profile-contract-'));
const home = join(dir, 'home'), config = join(dir, 'xdg'), profile = join(dir, 'new-parent/profile');
await mkdir(home, { mode: 0o700 }); await mkdir(config, { mode: 0o700 });
const trust = new TrustStore(join(dir, 'bridge'));
const reservation = reservePort();
await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = (reservation.address() as import('node:net').AddressInfo).port;
await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
const origin = `http://127.0.0.1:${port}`;
const calls: string[] = [];
const service = Object.assign(new EventEmitter(), { dispatch: async (method: string) => {
  calls.push(method);
  if (method === 'bridge/config') return { cwd: dir, model: null, effort: null, provider: null, approvalPolicy: null,
    sandbox: null, approvalsReviewer: null, webSearch: null };
  if (method === 'bridge/projects') return { root: dir, projects: [{ name: 'fixture', cwd: dir }] };
  if (method === 'model/list' || method === 'thread/list') return { data: [], nextCursor: null };
  throw new Error('Unexpected simulated request');
} });
const server = await createServer(service as unknown as BridgeService, port, resolve('apps/web/dist'), { trust });
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE; delete env.ORACULUM_DESKTOP_ICON;
Object.assign(env, { HOME: home, XDG_CONFIG_HOME: config, ORACULUM_RESOURCE_DIR: resolve('.'), ORACULUM_URL: origin });
delete env.ORACULUM_USER_DATA_DIR;
let app: ElectronApplication | undefined;
const errors: string[] = [];
let stage = 'setup';
async function launch(selected: string) {
  app = await electron.launch({ executablePath, args: [main], env: { ...env, ORACULUM_USER_DATA_DIR: selected },
    chromiumSandbox: sandbox, timeout: 15000 });
  const page = await app.firstWindow({ timeout: 15000 });
  page.on('pageerror', error => errors.push(error.name));
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(selected);
  const settings = await app.evaluate(({ BrowserWindow }) => {
    // Electron exposes this diagnostic at runtime but omits it from public types.
    const contents = BrowserWindow.getAllWindows()[0].webContents as unknown as {
      getLastWebPreferences(): { sandbox: boolean; contextIsolation: boolean; nodeIntegration: boolean;
        webSecurity: boolean; webviewTag: boolean };
    };
    const p = contents.getLastWebPreferences();
    return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration,
      webSecurity: p.webSecurity, webviewTag: p.webviewTag };
  });
  expect(settings).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false });
  expect((await lstat(selected)).mode & 0o777).toBe(0o700);
  return page;
}
async function close() {
  if (app) { await app.close(); app = undefined; }
}
async function pair(page: Page) {
  await expect(page.getByRole('heading', { name: '信任此设备', exact: true })).toBeVisible();
  await page.getByLabel('设备名称', { exact: true }).fill('Disposable Electron profile');
  await page.getByLabel('配对码', { exact: true }).fill(trust.createPairing().code);
  await page.getByRole('button', { name: '配对并连接', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
}
async function persisted(page: Page) {
  await expect(page.locator('.app-shell')).toBeVisible(); // No second pairing.
  await expect(page.locator('.app-shell')).toHaveClass(/nav-collapsed/);
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('oraculum.layout.v1')) ?? '{}').navigation).toBe(false);
}
// Failure cases use real Electron and real main.cjs; catch only startup errors to
// avoid Electron's blocking error dialog. Nothing in app/path validation is mocked.
const wrapper = join(dir, 'failure-entry.cjs');
await writeFile(wrapper, `const {app}=require('electron'); try {require(${JSON.stringify(main)}); console.log('UNEXPECTED_START'); app.exit(2);} catch(error) {console.log('PROFILE_REJECTED:'+error.message); app.exit(0);}`);
async function rejected(overrides: Record<string, string>, expected: RegExp) {
  stage = `refusal: ${expected.source}`;
  const child = spawn(executablePath, [...(sandbox ? [] : ['--no-sandbox']), wrapper], {
    env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data.toString(); });
  child.stderr.resume(); // Avoid Chromium diagnostics/paths in exported evidence.
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('exit', resolve);
    });
    expect(code).toBe(0); expect(output).toMatch(/^PROFILE_REJECTED:/m); expect(output).toMatch(expected);
  } finally { clearTimeout(timer); }
}
try {
  await server.listen({ host: '127.0.0.1', port });
  stage = 'first start';
  await expect(lstat(profile)).rejects.toMatchObject({ code: 'ENOENT' });
  const page = await launch(profile);
  await pair(page);
  await page.locator('.desktop-nav-toggle').click();
  await expect(page.locator('.app-shell')).toHaveClass(/nav-collapsed/);
  await close();
  console.log('PASS fresh explicit profile: real UI, private directory, pairing and layout saved');

  stage = 'restart';
  await persisted(await launch(profile));
  expect(trust.list()).toHaveLength(1);
  await close();
  console.log('PASS restart: same profile, layout and authenticated device preserved');

  stage = 'old profile';
  const legacy = join(home, '.config/oraculum-phase0b');
  const other = join(config, 'oraculum-phase0b');
  // Pre-existing legacy profile seeded through real Chromium, not copied from user data.
  await mkdir(legacy, { recursive: true, mode: 0o700 });
  await mkdir(other, { mode: 0o700 });
  const oldPage = await launch(legacy); await pair(oldPage);
  await oldPage.locator('.desktop-nav-toggle').click(); await close();
  const sentinel = join(legacy, 'fixture-user-data'); await writeFile(sentinel, 'preserve existing data');
  const identity = await lstat(legacy);
  await persisted(await launch(legacy)); await close();
  expect(trust.list()).toHaveLength(2);
  expect((await lstat(legacy)).ino).toBe(identity.ino);
  expect(await readFile(sentinel, 'utf8')).toBe('preserve existing data');
  console.log('PASS explicitly reused old profile: same inode, cookie, layout and sentinel');

  stage = 'failure protections';
  // Snapshot every file byte, type, permission and inode in the old profile.
  async function snapshot(directory: string): Promise<unknown[]> {
    const result: unknown[] = [];
    for (const name of (await readdir(directory)).sort()) {
      const file = join(directory, name), entry = await lstat(file);
      result.push([name, entry.mode, entry.ino, entry.isDirectory() ? await snapshot(file) : await readFile(file, 'base64')]);
    }
    return result;
  }
  const before = await snapshot(legacy);
  await rejected({}, /Legacy Desktop profile/);
  const empty = join(dir, 'empty-home'); await mkdir(empty, { mode: 0o700 });
  await rejected({ HOME: empty, XDG_CONFIG_HOME: empty }, /No existing Desktop profile/);
  const conflict = join(dir, 'file-conflict'); await writeFile(conflict, 'preserved file');
  await rejected({ ORACULUM_USER_DATA_DIR: join(conflict, 'child') }, /non-directory/);
  const link = join(dir, 'profile-link'); await symlink(legacy, link);
  await rejected({ ORACULUM_USER_DATA_DIR: link }, /symlink/);
  await chmod(legacy, 0o500);
  try { await rejected({ ORACULUM_USER_DATA_DIR: legacy }, /not writable/); }
  finally { await chmod(legacy, identity.mode & 0o777); }
  await chmod(other, 0o755);
  await rejected({ ORACULUM_USER_DATA_DIR: other }, /private permissions/);
  const missing = join(dir, 'must-stay-absent');
  await rejected({ ORACULUM_USER_DATA_DIR: missing, ORACULUM_DESKTOP_ICON: join(dir, 'missing.png') }, /icon/);
  stage = 'old profile snapshot';
  expect(await snapshot(legacy)).toEqual(before);
  stage = 'unrelated paths';
  expect(await readFile(conflict, 'utf8')).toBe('preserved file');
  // Electron itself may initialize XDG cache/config; Oraculum must not select a profile.
  await expect(lstat(join(empty, 'oraculum'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(join(config, 'oraculum'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(errors).toEqual([]);
  expect(calls.every(method => ['bridge/config', 'bridge/projects', 'model/list', 'thread/list'].includes(method))).toBe(true);
  console.log('PASS 7 real-process refusal cases: legacy ambiguity, no selection, file conflict, symlink, read-only, public mode, missing icon; old data byte-identical');
  console.log(`PASS Electron ${require('electron/package.json').version}; OS sandbox ${sandbox ? 'enabled' : 'NOT tested (explicit automation opt-in)'}; no model calls or real user data`);
} catch {
  console.error(`FAIL desktop profile contract at ${stage}; assertion details withheld to protect fixture cookies`);
  process.exitCode = 1;
} finally {
  await close(); await server.close(); trust.close();
  await rm(dir, { recursive: true, force: true });
}
