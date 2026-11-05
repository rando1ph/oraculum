// Real dpkg installs use a disposable package database and root in a bubblewrap
// user namespace. The host filesystem is read-only; no host package, service,
// production configuration, database or APK is installed, opened or changed.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';

const [oldInput, bridgeInput, desktopInput, apkInput] = process.argv.slice(2);
assert.ok(oldInput && bridgeInput && desktopInput && process.argv.length <= 6,
  'Usage: node scripts/stage-b-acceptance.mjs OLD_BUNDLED_DEB BRIDGE_DEB DESKTOP_DEB [UNCHANGED_0.1.2_APK]');
const artifacts = { old: resolve(oldInput), bridge: resolve(bridgeInput), desktop: resolve(desktopInput), ...(apkInput ? { apk: resolve(apkInput) } : {}) };
const outputParent = resolve('.local/evidence/stage-b'); await mkdir(outputParent, { recursive: true });
const output = await mkdtemp(join(outputParent, 'packages-'));
const scratch = await mkdtemp(join(tmpdir(), 'oraculum-stage-b-packages-'));
const report = { date: new Date().toISOString(), artifacts: {}, checks: [],
  isolation: { hostPackagesChanged: false, hostServicesChanged: false, productionDataRead: false,
    realDpkg: true, temporaryRoot: true, hostFilesystemReadOnlyDuringInstall: true,
    dependencyResolution: 'GUI/runtime host dependencies forced for package ownership simulation; executable dependencies checked by artifact verifiers',
    apkInstalled: false, apkModified: false, physicalAndroid: false, nativeCodex: 'controlled JSON-RPC fixture; separate native regression required' } };
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024, ...options });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pass = check => { report.checks.push(check); console.log('PASS ' + check); };
let child;

// Node fetch overwrites a supplied Host header. Use the lower-level transport
// when simulating the request a TLS reverse proxy forwards to loopback.
function proxyRequest(url, headers) {
  return new Promise((accept, reject) => {
    const request = httpRequest(url, { headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => accept({ status: response.statusCode, json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.setTimeout(10_000, () => request.destroy(new Error('Proxy contract request timed out')));
    request.on('error', reject); request.end();
  });
}

function sandbox(command, args) {
  return run('bwrap', ['--die-with-parent', '--unshare-user', '--uid', '0', '--gid', '0',
    '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--ro-bind', '/', '/',
    '--bind', scratch, scratch, '--proc', '/proc', '--dev', '/dev', '--', command, ...args]);
}
function dpkg(root, args, allowFailure = false) {
  try {
    const result = sandbox('/usr/bin/dpkg', [`--root=${root}`, `--log=${join(scratch, 'dpkg.log')}`,
      '--force-depends', '--force-script-chrootless', '--no-triggers', ...args]);
    return { status: 0, output: result };
  } catch (error) {
    if (!allowFailure) throw error;
    return { status: error.status, output: String(error.stdout ?? '') + String(error.stderr ?? '') };
  }
}
const owned = (root, name) => run('dpkg-query', [`--admindir=${join(root, 'var/lib/dpkg')}`, '--listfiles', name]).trim().split('\n');
const packageVersion = (root, name) => run('dpkg-query', [`--admindir=${join(root, 'var/lib/dpkg')}`, '--show', '--showformat=${Version}', name]).trim();
async function rootDirectory(name) { const root = join(scratch, name); await mkdir(root); return root; }
async function absent(path) { try { await lstat(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } }
async function dbSnapshot(file) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return { version: database.prepare('PRAGMA user_version').get().user_version,
      integrity: database.prepare('PRAGMA integrity_check').get().integrity_check,
      devices: database.prepare('SELECT id,label,digest,origin,expires_at,revoked FROM devices ORDER BY id').all(),
      projects: database.prepare('SELECT * FROM projects ORDER BY cwd').all(),
      receipts: database.prepare('SELECT * FROM send_receipts ORDER BY operation_id').all() };
  } finally { database.close(); }
}
async function stop() {
  if (!child) return;
  const done = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child?.kill('SIGKILL'), 12_000);
  const result = await done; clearTimeout(timer); child = undefined; assert.equal(result[0], 0, 'Bridge did not stop gracefully');
}
async function probe(runtime, fixture, label) {
  let logs = '';
  child = spawn(join(runtime, 'bin/oraculum-bridge'), { cwd: fixture.unrelated, env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs += bytes; });
  try {
    const deadline = Date.now() + 25_000;
    while (!logs.includes('"url":') && child.exitCode === null && Date.now() < deadline) await new Promise(yes => setTimeout(yes, 100));
    assert.match(logs, /"url":/, 'Packaged Bridge startup failed: ' + logs);
    const local = `http://127.0.0.1:${fixture.port}`;
    const response = await fetch(local + '/health'); assert.equal(response.status, 200);
    const health = await response.json(); assert.equal(health.protocol, 1); assert.equal(health.mode, 'authenticated');
    const html = await (await fetch(local + '/')).text(); assert.match(html, /Oraculum · 神谕/);
    const session = await fetch(local + '/auth/session', { headers: { Cookie: 'oraculum_local=' + fixture.localToken } });
    assert.equal(session.status, 200); assert.equal((await session.json()).device.id, fixture.localDevice);
    // Match the unchanged Android 0.1.2 TaskNotificationService request and feed
    // parser, including HTTPS-origin/base-path cookie scoping behind a proxy.
    const headers = { Host: 'bridge.invalid', Origin: 'https://bridge.invalid', 'X-Forwarded-Proto': 'https',
      Cookie: '__Secure-oraculum_session=' + fixture.remoteToken, 'X-Oraculum-Notifications': '1' };
    const remoteSession = await proxyRequest(local + '/portable/auth/session', headers);
    assert.equal(remoteSession.status, 200); assert.equal((await remoteSession.json()).device.id, fixture.remoteDevice);
    const notification = await proxyRequest(local + '/portable/notifications', headers); assert.equal(notification.status, 200);
    const feed = await notification.json(); assert.ok(feed.validUntil - feed.generatedAt > 0 && feed.validUntil - feed.generatedAt <= 15_000);
    assert.ok(Array.isArray(feed.notices) && feed.notices.length <= 64);
    const ws = new WebSocket(`ws://127.0.0.1:${fixture.port}/ws`, { origin: local, headers: { Cookie: 'oraculum_local=' + fixture.localToken } });
    await once(ws, 'open');
    const rpc = async (method, params) => {
      const id = randomUUID(); const result = new Promise((accept, reject) => {
        const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error('Legacy RPC timeout: ' + method)); }, 10_000);
        const onMessage = bytes => { const item = JSON.parse(String(bytes)); if (item.id === id) { clearTimeout(timer); ws.off('message', onMessage); accept(item); } };
        ws.on('message', onMessage);
      });
      ws.send(JSON.stringify({ id, method, params })); const answer = await result; assert.equal(answer.error, undefined, JSON.stringify(answer)); return answer.result;
    };
    try {
      // Old clients can keep using the protocol-1 RPCs without event cursors or
      // capability negotiation introduced by a newer Web build.
      const projects = await rpc('bridge/projects', {}); assert.ok(projects.projects.some(item => item.cwd === fixture.workspace));
      const config = await rpc('bridge/config', { cwd: fixture.workspace }); assert.equal(config.cwd, fixture.workspace);
    } finally { ws.close(); await once(ws, 'close'); }
    await stop();
    await writeFile(join(output, label + '.log'), logs);
    return { protocol: health.protocol, localPairingInherited: true, sameRemoteOriginPairingInherited: true,
      android012NotificationContract: true, legacyProtocol1Rpc: true, privateNode: true, externalNodeOnPath: false };
  } catch (error) { await writeFile(join(output, label + '.log'), logs); throw error; }
}

try {
  assert.equal(sandbox('/usr/bin/id', ['-u']).trim(), '0');
  for (const [kind, artifact] of Object.entries(artifacts)) {
    const item = { path: artifact, sha256: hash(await readFile(artifact)) };
    if (kind !== 'apk') {
      item.package = run('dpkg-deb', ['--field', artifact, 'Package']).trim();
      item.version = run('dpkg-deb', ['--field', artifact, 'Version']).trim();
      const control = join(scratch, 'control-' + kind); run('dpkg-deb', ['--control', artifact, control]);
      const scripts = (await readdir(control)).filter(name => ['preinst', 'postinst', 'prerm', 'postrm'].includes(name));
      assert.deepEqual(scripts, [], 'Acceptance only executes inert candidate packages; unexpected package scripts: ' + scripts);
    }
    report.artifacts[kind] = item;
  }
  assert.equal(report.artifacts.old.package, 'oraculum'); assert.equal(report.artifacts.old.version, '0.1.2');
  assert.equal(report.artifacts.bridge.package, 'oraculum-bridge'); assert.equal(report.artifacts.desktop.package, 'oraculum');
  pass('candidate packages contain no maintainer hooks; bubblewrap provides namespace root with host filesystem read-only');

  const root = await rootDirectory('legacy-upgrade');
  dpkg(root, ['--install', artifacts.old]);
  const oldRuntime = join(root, 'usr/lib/oraculum/resources/runtime');
  const home = join(root, 'home/tester'), state = join(home, 'preserved-state'), workspace = join(home, 'Projects/controlled');
  const config = join(home, '.config/oraculum/runtime.json'), profile = join(home, 'desktop-profile/Preferences');
  await mkdir(state, { recursive: true, mode: 0o700 }); await chmod(state, 0o700);
  await mkdir(workspace, { recursive: true, mode: 0o700 }); await mkdir(join(home, '.config/oraculum'), { recursive: true });
  await mkdir(join(home, 'desktop-profile'), { mode: 0o700 }); await writeFile(profile, '{"stageB":"preserve-profile"}\n', { mode: 0o600 });
  const theme = join(state, 'theme-sentinel'), attachment = join(workspace, '.oraculum-attachments/retained-sentinel/input.txt');
  await writeFile(theme, 'preserved custom theme sentinel\n', { mode: 0o600 });
  await mkdir(join(workspace, '.oraculum-attachments/retained-sentinel'), { recursive: true, mode: 0o700 });
  await writeFile(attachment, 'preserved attachment sentinel\n', { mode: 0o400 });
  const unrelated = join(scratch, 'unrelated'); await mkdir(unrelated);
  const fixtureBin = join(home, '.local/bin/codex'); await mkdir(join(home, '.local/bin'), { recursive: true });
  const privateNode = join(oldRuntime, 'node/bin/node');
  const nativeCalls = join(scratch, 'native-calls');
  // No tool execution or model turn is possible in this fixture.
  await writeFile(fixtureBin, `#!${privateNode}\nif(process.argv[2]==='--version'){console.log('codex-cli 9.9.9-stage-b-fixture');process.exit(0)}\nrequire('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;require('node:fs').appendFileSync(process.env.FIXTURE_CALLS,m.method+'\\n');const result=m.method==='initialize'?{userAgent:'fixture'}:m.method==='config/read'?{config:{model:null,model_provider:null,model_reasoning_effort:null}}:{data:[],nextCursor:null};console.log(JSON.stringify({id:m.id,result}));});\n`, { mode: 0o700 });
  const portProbe = createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
  const port = portProbe.address().port; await new Promise(yes => portProbe.close(yes));
  const operatingSystemTools = join(scratch, 'os-tools'); await mkdir(operatingSystemTools);
  for (const name of ['readlink', 'dirname']) await symlink('/usr/bin/' + name, join(operatingSystemTools, name));
  await writeFile(config, JSON.stringify({ ORACULUM_STATE_DIR: state, ORACULUM_WORKSPACE: workspace,
    ORACULUM_USER_DATA_DIR: join(home, 'desktop-profile'), ORACULUM_CODEX_BIN: fixtureBin,
    ORACULUM_PORT: String(port), ORACULUM_REMOTE_ORIGIN: 'https://bridge.invalid', ORACULUM_REMOTE_BASE_PATH: '/portable/' }), { mode: 0o600 });
  const env = { HOME: home, PATH: operatingSystemTools, XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'xdg-state'), XDG_CACHE_HOME: join(home, 'cache'),
    ORACULUM_CONFIG_FILE: config, CODEX_HOME: join(home, 'codex'), FIXTURE_CALLS: nativeCalls };
  const localToken = randomBytes(32).toString('base64url'), remoteToken = randomBytes(32).toString('base64url');
  const localDevice = randomUUID(), remoteDevice = randomUUID();
  const databaseFile = join(state, 'trust.sqlite'), database = new DatabaseSync(databaseFile);
  database.exec(`CREATE TABLE pairing (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE devices (id TEXT PRIMARY KEY, label TEXT NOT NULL, digest TEXT UNIQUE NOT NULL, origin TEXT NOT NULL, expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE projects (cwd TEXT PRIMARY KEY, dev TEXT NOT NULL, ino TEXT NOT NULL);
    CREATE TABLE send_receipts (operation_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, thread_id TEXT NOT NULL, device_id TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL, turn_id TEXT);
    PRAGMA user_version=1;`);
  database.prepare('INSERT INTO devices VALUES (?, ?, ?, ?, NULL, 0)').run(localDevice, 'Legacy Desktop', hash(localToken), `http://127.0.0.1:${port}`);
  database.prepare('INSERT INTO devices VALUES (?, ?, ?, ?, NULL, 0)').run(remoteDevice, 'Android 0.1.2 inherited', hash(remoteToken), 'https://bridge.invalid/portable/');
  const info = await stat(workspace, { bigint: true }); database.prepare('INSERT INTO projects VALUES (?, ?, ?)').run(workspace, String(info.dev), String(info.ino));
  for (const [status, turn] of [['completed', 'turn-completed'], ['unknown', null]]) database.prepare('INSERT INTO send_receipts VALUES (?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), workspace, 'thread-' + status, localDevice, Date.now(), status, turn);
  database.close(); await chmod(databaseFile, 0o600);
  const fixture = { home, state, workspace, unrelated, env, port, localToken, remoteToken, localDevice, remoteDevice };
  report.legacyRuntime = await probe(oldRuntime, fixture, 'legacy-runtime');
  const before = await dbSnapshot(databaseFile), sentinels = Object.fromEntries(await Promise.all([config, profile, theme, attachment].map(async file => [file, hash(await readFile(file))])));
  assert.equal(before.version, 1); assert.equal(before.integrity, 'ok');
  pass('old bundled 0.1.2 runtime boots with synthetic existing configuration, trust devices, projects and completed/unknown Receipts');

  dpkg(root, ['--install', artifacts.bridge]);
  const independent = join(root, 'usr/lib/oraculum-bridge');
  assert.ok((await lstat(join(oldRuntime, 'node/bin/node'))).isFile(), 'Bridge install removed old runtime');
  assert.ok((await lstat(join(independent, 'bin/oraculum-bridge'))).isFile());
  assert.ok(owned(root, 'oraculum').includes('/usr/lib/oraculum/resources/runtime/bin/oraculum-bridge'));
  assert.ok(owned(root, 'oraculum-bridge').includes('/usr/lib/oraculum-bridge/bin/oraculum-bridge'));
  const unit = await readFile(join(root, 'usr/lib/systemd/user/oraculum-bridge.service'), 'utf8');
  assert.match(unit, /^ExecStart=\/usr\/lib\/oraculum-bridge\/bin\/oraculum-bridge$/m);
  assert.deepEqual(await dbSnapshot(databaseFile), before);
  pass('Bridge-first install preserves old owned runtime and state, adds independent package-owned path and inert user systemd unit');
  report.bridgeRuntimeBeforeDesktop = await probe(independent, fixture, 'independent-runtime-before-desktop');
  assert.deepEqual(await dbSnapshot(databaseFile), before);

  dpkg(root, ['--install', artifacts.desktop]);
  assert.equal(packageVersion(root, 'oraculum'), report.artifacts.desktop.version);
  assert.equal(packageVersion(root, 'oraculum-bridge'), report.artifacts.bridge.version);
  assert.ok(await absent(oldRuntime), 'Desktop still embeds runtime after upgrade');
  assert.ok((await lstat(join(independent, 'node/bin/node'))).isFile(), 'Desktop upgrade deleted independent Bridge');
  assert.ok((await lstat(join(root, 'usr/lib/oraculum/resources/desktop/apps/desktop/splash.html'))).isFile());
  assert.ok(!owned(root, 'oraculum').some(path => path.includes('/resources/runtime')));
  for (const [file, expected] of Object.entries(sentinels)) assert.equal(hash(await readFile(file)), expected, 'Changed preserved user asset: ' + file);
  assert.deepEqual(await dbSnapshot(databaseFile), before);
  // The simulated native CLI belongs to the user. Move its shebang to the new
  // independent private Node after the old program is removed, as native Codex
  // in a real installation has its own runtime outside the old Desktop package.
  await writeFile(fixtureBin, (await readFile(fixtureBin, 'utf8')).replace(privateNode, join(independent, 'node/bin/node')), { mode: 0o700 });
  report.bridgeRuntimeAfterDesktop = await probe(independent, fixture, 'independent-runtime-after-desktop');
  assert.deepEqual(await dbSnapshot(databaseFile), before);
  pass('Desktop upgrade removes only its bundled runtime; independent Bridge runs with the same configuration, pairings, receipts, profile, themes and attachment bytes');

  // Test-only derivatives exercise independent package upgrades and a failed
  // configuration after files replace the current program. Binary rollback
  // uses the genuine candidate and preserves later receipts.
  const badTree = join(scratch, 'failure-package'); run('dpkg-deb', ['--raw-extract', artifacts.bridge, badTree]);
  const upgradeVersion = report.artifacts.bridge.version + '+stageb1';
  const controlFile = join(badTree, 'DEBIAN/control'); await writeFile(controlFile, (await readFile(controlFile, 'utf8')).replace(/^Version: .*$/m, 'Version: ' + upgradeVersion));
  const upgradeDeb = join(scratch, 'oraculum-bridge-upgrade-fixture.deb'); run('dpkg-deb', ['--root-owner-group', '--build', badTree, upgradeDeb]);
  const desktopExecutable = join(root, 'usr/lib/oraculum/oraculum'), desktopBeforeUpdate = hash(await readFile(desktopExecutable));
  dpkg(root, ['--install', upgradeDeb]); assert.equal(packageVersion(root, 'oraculum-bridge'), upgradeVersion);
  assert.equal(hash(await readFile(desktopExecutable)), desktopBeforeUpdate); assert.deepEqual(await dbSnapshot(databaseFile), before);
  pass('Bridge-only package upgrade leaves Desktop executable and inherited state unchanged (test-only versioned derivative)');
  const injectedVersion = report.artifacts.bridge.version + '+stageb2';
  await writeFile(controlFile, (await readFile(controlFile, 'utf8')).replace(/^Version: .*$/m, 'Version: ' + injectedVersion));
  await writeFile(join(badTree, 'DEBIAN/postinst'), '#!/bin/sh\n# Controlled isolated acceptance fault.\nexit 69\n', { mode: 0o755 });
  const badDeb = join(scratch, 'oraculum-bridge-failure-injection.deb'); run('dpkg-deb', ['--root-owner-group', '--build', badTree, badDeb]);
  const latestReceipt = randomUUID(), latest = new DatabaseSync(databaseFile);
  latest.prepare('INSERT INTO send_receipts VALUES (?, ?, ?, ?, ?, ?, ?)').run(latestReceipt, workspace, 'thread-post-upgrade', localDevice, Date.now(), 'completed', 'turn-post-upgrade'); latest.close();
  const stateBeforeFailure = await dbSnapshot(databaseFile);
  const failed = dpkg(root, ['--install', badDeb], true); assert.notEqual(failed.status, 0); assert.match(failed.output, /69/);
  await writeFile(join(output, 'injected-upgrade-failure.log'), failed.output);
  dpkg(root, ['--install', artifacts.bridge]);
  assert.equal(packageVersion(root, 'oraculum-bridge'), report.artifacts.bridge.version);
  assert.deepEqual(await dbSnapshot(databaseFile), stateBeforeFailure);
  report.rollbackRuntime = await probe(independent, fixture, 'binary-rollback-runtime');
  assert.deepEqual(await dbSnapshot(databaseFile), stateBeforeFailure);
  report.binaryRollback = { successfulTestOnlyUpgrade: upgradeVersion, injectedVersion, failure: 'test-only postinst exit 69', restoredVersion: report.artifacts.bridge.version,
    receiptsBefore: before.receipts.length, receiptsAfter: stateBeforeFailure.receipts.length, postUpgradeReceiptPreserved: true, databaseSnapshotRestored: false };
  pass('Bridge-only failed package configuration rolls back the binary through dpkg while retaining the new post-upgrade Receipt and all existing state');

  const reverse = await rootDirectory('desktop-first');
  dpkg(reverse, ['--install', artifacts.desktop]);
  assert.ok(await absent(join(reverse, 'usr/lib/oraculum-bridge')));
  assert.ok((await lstat(join(reverse, 'usr/lib/oraculum/resources/desktop/apps/desktop/splash.html'))).isFile());
  dpkg(reverse, ['--install', artifacts.bridge]);
  const filesA = new Set(owned(reverse, 'oraculum').filter(path => path !== '/.' && !path.endsWith('/')));
  const filesB = owned(reverse, 'oraculum-bridge').filter(path => path !== '/.' && !path.endsWith('/'));
  const sharedFiles = [];
  for (const path of filesB) if (filesA.has(path)) { const info = await lstat(join(reverse, path)); if (!info.isDirectory()) sharedFiles.push(path); }
  assert.deepEqual(sharedFiles, []);
  dpkg(reverse, ['--remove', 'oraculum']);
  assert.ok((await lstat(join(reverse, 'usr/lib/oraculum-bridge/node/bin/node'))).isFile());
  assert.equal(packageVersion(reverse, 'oraculum-bridge'), report.artifacts.bridge.version);
  pass('fresh Desktop-first then Bridge install has no shared file ownership; removing Desktop leaves the independently owned Bridge intact');

  const calls = await readFile(nativeCalls, 'utf8'); assert.doesNotMatch(calls, /thread\/start|turn\/start|command\/exec/);
  report.nativeFixtureMethods = [...new Set(calls.trim().split('\n'))].sort();
  if (artifacts.apk) {
    const originalHash = report.artifacts.apk.sha256;
    const build = JSON.parse(run('unzip', ['-p', artifacts.apk, 'assets/oraculum-build.json']));
    assert.equal(build.version, '0.1.2'); assert.equal(build.versionCode, 4); assert.equal(build.sourceDirty, false);
    run('git', ['diff', '--exit-code', build.sourceGit, '--', 'apps/android/app/src/main']);
    const entries = run('unzip', ['-Z1', artifacts.apk]).trim().split('\n');
    assert.ok(!entries.some(path => /(?:^|\/)index\.html$|(?:^|\/)assets\/index-.*\.js$/.test(path)), 'APK unexpectedly carries the Web UI');
    assert.equal(hash(await readFile(artifacts.apk)), originalHash);
    report.android012 = { apk: artifacts.apk, sha256: originalHash, build, unchangedNativeSourceSinceBuild: true,
      webUiLoadedFromBridge: true, notificationAndAuthHttpContract: true, existingProtocol1Rpc: true,
      nativeDeviceTest: 'deferred to separately authorized Phase D; no APK build, sign or install' };
    pass('existing Android Release 0.1.2/code 4 APK is unchanged, native source matches its build commit and its hosted-Web/auth/notification protocol remains compatible');
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; console.error(report.error);
} finally {
  if (child) { child.kill('SIGKILL'); await once(child, 'exit').catch(() => {}); child = undefined; }
  await cp(join(scratch, 'dpkg.log'), join(output, 'dpkg.log')).catch(() => {});
  await rm(scratch, { recursive: true, force: true });
  report.disposableRootRemoved = true;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, output, checks: report.checks.length }));
}
