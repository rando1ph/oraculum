// Launch the actual extracted release executable with the OS sandbox requested.
// There is deliberately no --no-sandbox fallback, no chown, and no host changes.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
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
const scratch = await mkdtemp(join(tmpdir(), 'oraculum-deb-sandbox-'));
const extracted = join(scratch, 'package'), fixtureHome = join(scratch, 'home');
const output = join(project, '.local/evidence/phase4b/deb'); await mkdir(output, { recursive: true });
const evidence = join(output, `${basename(artifact)}.sandbox.json`);
const report = { artifact, date: new Date().toISOString(), installed: false, realBridge: false,
  realCodex: false, serviceActions: false, noSandboxOverride: false, osSandboxVerified: false };
let browser, child;
let processOutput = '';
const server = createServer((request, response) => {
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
  const namespace = spawnSync('unshare', ['--user', '--map-root-user', 'true'], { encoding: 'utf8', timeout: 5_000 });
  report.disposableUserNamespaceProbe = { status: namespace.status, error: namespace.error?.message, stderr: namespace.stderr?.trim() };
  await mkdir(fixtureHome, { mode: 0o700 });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  const port = server.address().port;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith('ORACULUM_') && !['CODEX_HOME', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(key)));
  Object.assign(env, { HOME: fixtureHome, XDG_CONFIG_HOME: join(fixtureHome, 'config'), XDG_DATA_HOME: join(fixtureHome, 'data'),
    XDG_STATE_HOME: join(fixtureHome, 'state'), XDG_CACHE_HOME: join(fixtureHome, 'cache'),
    ORACULUM_USER_DATA_DIR: join(fixtureHome, 'profile'), ORACULUM_MANAGE_SERVICE: '0', ORACULUM_URL: `http://127.0.0.1:${port}` });
  // Spawn the production executable directly. This also captures a fatal
  // sandbox abort before any DevTools endpoint exists (Electron.launch can
  // lose this evidence in an early debugger-promise rejection).
  child = spawn(join(extracted, 'usr/lib/oraculum/oraculum'), ['--remote-debugging-port=0'],
    { env, cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', error => { processOutput += error.message; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { processOutput = (processOutput + data).slice(-12_000); });
  const deadline = Date.now() + 15_000;
  while (!/DevTools listening on (ws:\/\/\S+)/.test(processOutput) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise(accept => setTimeout(accept, 100));
  const endpoint = /DevTools listening on (ws:\/\/\S+)/.exec(processOutput)?.[1];
  assert.ok(endpoint, `Production executable exited before its DevTools endpoint: ${processOutput}`);
  browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
  let page;
  while (!page && Date.now() < deadline) {
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith(`http://127.0.0.1:${port}`));
    if (!page) await new Promise(accept => setTimeout(accept, 100));
  }
  assert.ok(page, 'Production GUI did not reach the isolated Bridge fixture');
  await expect(page.getByRole('heading', { name: 'Isolated package sandbox fixture' })).toBeVisible();
  const mainArgs = (await readFile(`/proc/${child.pid}/cmdline`, 'utf8')).split('\0');
  assert.ok(!mainArgs.some(value => value === '--no-sandbox' || value === '--disable-setuid-sandbox'));
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send('SystemInfo.getProcessInfo');
  const renderers = processInfo.filter(process => process.type === 'renderer');
  assert.ok(renderers.length, 'No live renderer to inspect');
  report.kernel = [];
  for (const renderer of renderers) {
    const status = await readFile(`/proc/${renderer.id}/status`, 'utf8');
    const fields = Object.fromEntries(['NoNewPrivs', 'Seccomp', 'CapEff'].map(name => [name, new RegExp(`^${name}:\\s*(\\S+)`, 'm').exec(status)?.[1]]));
    const namespaces = {};
    for (const name of ['pid', 'user', 'net']) namespaces[name] = {
      main: await readlink(`/proc/${child.pid}/ns/${name}`), renderer: await readlink(`/proc/${renderer.id}/ns/${name}`),
    };
    report.kernel.push({ pid: renderer.id, ...fields, namespaces });
    assert.equal(fields.NoNewPrivs, '1'); assert.equal(fields.Seccomp, '2'); assert.match(fields.CapEff, /^0+$/);
    assert.ok(Object.values(namespaces).some(value => value.main !== value.renderer), 'Renderer must be in a sandbox namespace distinct from the browser');
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
  if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  report.processOutput = processOutput;
  if (child) report.exit = { code: child.exitCode, signal: child.signalCode };
  server.closeAllConnections(); await new Promise(accept => server.close(accept));
  await rm(scratch, { recursive: true, force: true });
  await writeFile(evidence, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, evidence, osSandboxVerified: report.osSandboxVerified, installed: false }));
}
