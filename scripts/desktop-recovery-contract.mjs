// Real extracted Desktop, disposable HOME/profile/config and loopback fixtures.
// No DEB install, service action, production state or sandbox fallback.
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [input, flag, helperInput] = process.argv.slice(2);
assert.ok(input && flag === '--sandbox-helper' && helperInput && process.argv.length === 5,
  'Usage: desktop-recovery-contract.mjs DESKTOP_DEB --sandbox-helper ROOT_OWNED_IDENTICAL_HELPER');
const artifact = resolve(input), helper = resolve(helperInput);
const scratch = await mkdtemp(join(tmpdir(), 'oraculum-desktop-recovery-'));
const evidenceRoot = resolve('.local/evidence/stage-b'); await mkdir(evidenceRoot, { recursive: true });
const output = await mkdtemp(join(evidenceRoot, 'desktop-recovery-'));
const report = { artifact, installed: false, serviceActions: false, realReleaseElectron: true, simulatedBridge: true,
  chromiumSandboxRequested: true, osSandboxVerified: 'See separate package-sandbox-check evidence', checks: [] };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let app, compatible = true;
const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  if (request.url === '/health') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ protocol: compatible ? 1 : 2, mode: 'authenticated' }));
  } else {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><title>Fixture title</title><body style="background:#000;color:#fff"><h1>Independent Bridge ready</h1></body></html>');
  }
});
const listen = port => new Promise(accept => server.listen(port, '127.0.0.1', accept));
const stopServer = async () => { server.closeAllConnections(); await new Promise(accept => server.close(accept)); };
try {
  report.sha256 = sha256(await readFile(artifact));
  execFileSync('dpkg-deb', ['--extract', artifact, scratch], { timeout: 120_000 });
  const installation = join(scratch, 'usr/lib/oraculum');
  report.build = JSON.parse(await readFile(join(installation, 'resources/desktop/build.json'), 'utf8'));
  await assert.rejects(access(join(installation, 'resources/runtime')));
  const installedHelper = await lstat(helper);
  assert.ok(installedHelper.isFile() && !installedHelper.isSymbolicLink());
  assert.equal(installedHelper.uid, 0); assert.equal(installedHelper.gid, 0); assert.equal(installedHelper.mode & 0o7777, 0o4755);
  const packagedHelper = join(installation, 'chrome-sandbox');
  report.helperSha256 = sha256(await readFile(packagedHelper));
  assert.equal(sha256(await readFile(helper)), report.helperSha256);
  await rm(packagedHelper); await symlink(helper, packagedHelper);
  const home = join(scratch, 'home'), profile = join(home, 'inherited-desktop-profile'), config = join(home, 'selected-runtime.json');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const sentinel = join(profile, 'inherited-profile-sentinel'); await writeFile(sentinel, 'existing private profile', { mode: 0o600 });
  const profileInode = (await lstat(profile)).ino;
  await listen(0); const port = server.address().port;
  const state = join(home, 'never-initialized-bridge-state');
  const configText = JSON.stringify({ ORACULUM_PORT: String(port), ORACULUM_STATE_DIR: state, ORACULUM_USER_DATA_DIR: profile });
  await writeFile(config, configText, { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith('ORACULUM_') && !['CODEX_HOME', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(key)));
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'), XDG_CACHE_HOME: join(home, 'cache'), ORACULUM_CONFIG_FILE: config, ORACULUM_MANAGE_SERVICE: '0' });
  // A never-navigated hidden main window has no CDP frame tree. Let the actual
  // shell reach the compatible fixture before attaching, then use its native
  // recovery command for incompatible/offline states. No package bytes change.
  app = await electron.launch({ executablePath: join(installation, 'oraculum'), args: [], chromiumSandbox: true, env, cwd: scratch, timeout: 20_000 });
  await expect.poll(() => app.windows().some(page => page.url() === `http://127.0.0.1:${port}/`), { timeout: 15_000 }).toBe(true);
  const initialRequests = requests.filter(path => path === '/' || path.startsWith('/?')).length;
  compatible = false;
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('restore-default-theme').click());
  const recovery = async reason => {
    await expect.poll(() => app.windows().some(page => page.url().includes(`reason=${reason}`)), { timeout: 15_000 }).toBe(true);
    return app.windows().find(page => page.url().includes(`reason=${reason}`));
  };
  let splash = await recovery('bridge-incompatible');
  await expect(splash.locator('.recovery-detail')).toContainText('协议或认证模式不兼容');
  await expect(splash.locator('.recovery-detail')).toContainText('runtime.json');
  await expect.poll(() => splash.locator('img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  assert.ok(splash.url().includes('/resources/desktop/apps/desktop/splash.html'));
  assert.equal(requests.filter(path => path === '/' || path.startsWith('/?')).length, initialRequests, 'Incompatible Bridge Web UI must not be reloaded');
  await splash.screenshot({ path: join(output, 'incompatible-bridge.png') });
  report.checks.push('Packaged splash/icon load without Bridge runtime; incompatible protocol gives repair guidance and refuses Web UI');
  await stopServer();
  await splash.getByRole('link', { name: '重新连接' }).click();
  splash = await recovery('bridge-unavailable');
  await expect(splash.locator('.recovery-detail')).toContainText('安装独立 Bridge DEB');
  await expect(splash.getByRole('link', { name: '退出', exact: true })).toBeVisible();
  await splash.screenshot({ path: join(output, 'missing-bridge.png') });
  report.checks.push('Unavailable Bridge retains splash with installation guidance, retry and quit');
  compatible = true; await listen(port);
  await splash.getByRole('link', { name: '重新连接' }).click();
  await expect.poll(() => app.windows().some(page => page.url() === `http://127.0.0.1:${port}/`), { timeout: 15_000 }).toBe(true);
  const page = app.windows().find(page => page.url() === `http://127.0.0.1:${port}/`);
  await expect(page.getByRole('heading', { name: 'Independent Bridge ready' })).toBeVisible();
  await expect.poll(() => app.windows().length).toBe(1);
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  const desktop = await app.evaluate(({ app, BrowserWindow }) => ({ profile: app.getPath('userData'), title: BrowserWindow.getAllWindows()[0].getTitle(),
    sandbox: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox }));
  assert.equal(desktop.profile, profile); assert.equal(desktop.title, '神谕'); assert.equal(desktop.sandbox, true);
  assert.equal((await lstat(profile)).ino, profileInode); assert.equal(await readFile(sentinel, 'utf8'), 'existing private profile');
  assert.equal(await readFile(config, 'utf8'), configText); await assert.rejects(access(state));
  const args = (await readFile(`/proc/${app.process().pid}/cmdline`, 'utf8')).split('\0');
  assert.ok(!args.includes('--no-sandbox') && !args.includes('--disable-setuid-sandbox'));
  await page.screenshot({ path: join(output, 'retry-ready.png') });
  report.checks.push('Retry hands off immediately; selected external runtime.json and existing profile inherited without Bridge state initialization');
  report.requests = requests; report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error); process.exitCode = 1; console.error(error);
} finally {
  await app?.close(); await stopServer(); await rm(scratch, { recursive: true, force: true });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, output, checks: report.checks }));
}
