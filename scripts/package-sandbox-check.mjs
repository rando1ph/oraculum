// Launch the actual extracted release executable with the OS sandbox requested.
// There is deliberately no --no-sandbox fallback, no chown, and no host changes.
import assert from 'node:assert/strict';
import { _electron as electron, chromium, expect } from '@playwright/test';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const release = JSON.parse(await readFile(join(project, 'release.json'), 'utf8'));
const artifact = resolve(process.argv[2] || join(project, `dist/desktop/out/make/deb/x64/oraculum_${release.version}_amd64.deb`));
// Optional read-only reuse of an already installed, byte-identical root helper.
// Only a symlink in our disposable extraction changes; the host file is untouched.
const helperPath = process.argv[3] === '--sandbox-helper' && process.argv[4] ? resolve(process.argv[4]) : undefined;
assert.ok(process.argv.length <= 3 || helperPath && process.argv.length === 5,
  'Usage: package-sandbox-check.mjs [DEB [--sandbox-helper ROOT_OWNED_IDENTICAL_HELPER]]');
const scratch = await mkdtemp(join(tmpdir(), 'oraculum-deb-sandbox-'));
const extracted = join(scratch, 'package'), fixtureHome = join(scratch, 'home');
const output = join(project, '.local/evidence/phase4b/deb'); await mkdir(output, { recursive: true });
const evidence = join(output, `${basename(artifact)}.sandbox.json`);
const report = { artifact, date: new Date().toISOString(), installed: false, realBridge: false,
  realCodex: false, serviceActions: false, noSandboxOverride: false, osSandboxVerified: false };
let browser, electronApp, child;
let processOutput = '';
const fixtureRequests = [];
const server = createServer((request, response) => {
  fixtureRequests.push(request.url);
  if (request.url === '/health') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ protocol: 1, mode: 'authenticated' })); }
  else { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><html><title>Oraculum · 神谕</title><body style="background:#000;color:#fff"><h1>Isolated package sandbox fixture</h1></body></html>'); }
});
try {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(artifact)) hash.update(chunk); report.sha256 = hash.digest('hex');
  for (const setting of ['kernel/unprivileged_userns_clone', 'kernel/apparmor_restrict_unprivileged_userns', 'user/max_user_namespaces']) {
    try { report[setting] = (await readFile(`/proc/sys/${setting}`, 'utf8')).trim(); } catch { report[setting] = 'unavailable'; }
  }
  execFileSync('dpkg-deb', ['--extract', artifact, extracted], { timeout: 120_000 });
  const helper = await lstat(join(extracted, 'usr/lib/oraculum/chrome-sandbox'));
  report.extractedSandboxHelper = { uid: helper.uid, gid: helper.gid, mode: (helper.mode & 0o7777).toString(8) };
  if (helperPath) {
    const installed = await lstat(helperPath);
    assert.ok(installed.isFile() && !installed.isSymbolicLink());
    assert.equal(installed.uid, 0); assert.equal(installed.gid, 0); assert.equal(installed.mode & 0o7777, 0o4755);
    const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
    const helperSha256 = sha256(await readFile(join(extracted, 'usr/lib/oraculum/chrome-sandbox')));
    assert.equal(sha256(await readFile(helperPath)), helperSha256, 'Existing sandbox helper must match the DEB exactly');
    await rm(join(extracted, 'usr/lib/oraculum/chrome-sandbox'));
    await symlink(helperPath, join(extracted, 'usr/lib/oraculum/chrome-sandbox'));
    report.reusedSandboxHelper = { path: helperPath, sha256: helperSha256, hostModified: false };
  }
  const namespace = spawnSync('unshare', ['--user', '--map-root-user', 'true'], { encoding: 'utf8', timeout: 5_000 });
  report.disposableUserNamespaceProbe = { status: namespace.status, error: namespace.error?.message, stderr: namespace.stderr?.trim() };
  await mkdir(fixtureHome, { mode: 0o700 });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  const port = server.address().port;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith('ORACULUM_') && !['CODEX_HOME', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(key)));
  Object.assign(env, { HOME: fixtureHome, XDG_CONFIG_HOME: join(fixtureHome, 'config'), XDG_DATA_HOME: join(fixtureHome, 'data'),
    XDG_STATE_HOME: join(fixtureHome, 'state'), XDG_CACHE_HOME: join(fixtureHome, 'cache'),
    ORACULUM_USER_DATA_DIR: join(fixtureHome, 'profile'), ORACULUM_MANAGE_SERVICE: '0', ORACULUM_URL: `http://127.0.0.1:${port}` });
  let page, renderers;
  if (helperPath) {
    // Electron's own Playwright transport tracks packaged BrowserWindows.
    // Chromium CDP alone can expose no pages for an otherwise running Electron.
    electronApp = await electron.launch({ executablePath: join(extracted, 'usr/lib/oraculum/oraculum'),
      args: [], chromiumSandbox: true, env, cwd: scratch, timeout: 20_000 });
    child = electronApp.process();
    await expect.poll(() => electronApp.windows().some(candidate => candidate.url().startsWith(`http://127.0.0.1:${port}`)), { timeout: 15_000 }).toBe(true);
    page = electronApp.windows().find(candidate => candidate.url().startsWith(`http://127.0.0.1:${port}`));
    renderers = await electronApp.evaluate(({ app }) => app.getAppMetrics().filter(value => value.type === 'Tab').map(value => ({ id: value.pid })));
  } else {
    // Direct spawn preserves fatal helper errors before a DevTools endpoint exists.
    child = spawn(join(extracted, 'usr/lib/oraculum/oraculum'), ['--remote-debugging-port=0'],
      { env, cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', error => { processOutput += error.message; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { processOutput = (processOutput + data).slice(-12_000); });
    const deadline = Date.now() + 30_000;
    while (!/DevTools listening on (ws:\/\/\S+)/.test(processOutput) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise(accept => setTimeout(accept, 100));
    const endpoint = /DevTools listening on (ws:\/\/\S+)/.exec(processOutput)?.[1];
    assert.ok(endpoint, `Production executable exited before its DevTools endpoint: ${processOutput}`);
    browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
    while (!page && Date.now() < deadline) {
      page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith(`http://127.0.0.1:${port}`));
      if (!page) await new Promise(accept => setTimeout(accept, 100));
    }
    report.observedPages = browser.contexts().flatMap(context => context.pages()).map(candidate => candidate.url());
    const session = await browser.newBrowserCDPSession();
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    renderers = processInfo.filter(process => process.type === 'renderer');
  }
  report.fixtureRequests = fixtureRequests;
  assert.ok(page, 'Production GUI did not reach the isolated Bridge fixture');
  await expect(page.getByRole('heading', { name: 'Isolated package sandbox fixture' })).toBeVisible();
  const mainArgs = (await readFile(`/proc/${child.pid}/cmdline`, 'utf8')).split('\0');
  assert.ok(!mainArgs.some(value => value === '--no-sandbox' || value === '--disable-setuid-sandbox'));
  assert.ok(renderers.length, 'No live renderer to inspect');
  const mainStatus = await readFile(`/proc/${child.pid}/status`, 'utf8');
  const pidChain = status => /^NSpid:\s*(.+)$/m.exec(status)?.[1].trim().split(/\s+/) ?? [];
  const mainNSpid = pidChain(mainStatus);
  report.kernel = [];
  for (const renderer of renderers) {
    const status = await readFile(`/proc/${renderer.id}/status`, 'utf8');
    const fields = Object.fromEntries(['NoNewPrivs', 'Seccomp', 'CapEff'].map(name => [name, new RegExp(`^${name}:\\s*(\\S+)`, 'm').exec(status)?.[1]]));
    const namespaces = {};
    for (const name of ['pid', 'user', 'net']) {
      try { namespaces[name] = { main: await readlink(`/proc/${child.pid}/ns/${name}`), renderer: await readlink(`/proc/${renderer.id}/ns/${name}`) }; }
      catch (error) { if (error.code !== 'EACCES') throw error; namespaces[name] = { inspection: 'denied-by-kernel' }; }
    }
    // SUID sandbox processes may be non-dumpable, denying namespace readlinks.
    // NSpid is kernel evidence of nesting and remains readable without ptrace.
    const rendererNSpid = pidChain(status);
    report.kernel.push({ pid: renderer.id, ...fields, namespaces, mainNSpid, rendererNSpid });
    assert.equal(fields.NoNewPrivs, '1'); assert.equal(fields.Seccomp, '2'); assert.match(fields.CapEff, /^0+$/);
    assert.ok(Object.values(namespaces).some(value => value.main && value.main !== value.renderer) || mainNSpid.length > 0 && rendererNSpid.length > mainNSpid.length,
      'Renderer must have positive kernel evidence of a namespace distinct from the browser');
  }
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  report.osSandboxVerified = true; report.status = 'passed';
  await page.screenshot({ path: join(output, `${basename(artifact)}.sandbox.png`) });
  console.log('PASS actual extracted Electron: sandbox requested, renderer seccomp/no-new-privileges/zero capabilities and namespace separation verified');
} catch (error) {
  report.status = 'blocked'; report.error = (error instanceof Error ? error.message : String(error)).slice(0, 12_000);
  process.exitCode = 2;
  console.error('BLOCKED: release OS sandbox could not be established and verified on this host; no fallback or host change attempted.');
} finally {
  await browser?.close();
  await electronApp?.close();
  if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  report.processOutput = processOutput;
  if (child) report.exit = { code: child.exitCode, signal: child.signalCode };
  server.closeAllConnections(); await new Promise(accept => server.close(accept));
  await rm(scratch, { recursive: true, force: true });
  await writeFile(evidence, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, evidence, osSandboxVerified: report.osSandboxVerified, installed: false }));
}
