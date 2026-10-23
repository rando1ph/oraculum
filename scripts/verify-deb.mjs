// Package inspection and disposable extraction only. Never install a DEB or
// register/start a user service; the only child Bridge uses a simulated CLI.
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const release = JSON.parse(await readFile(join(project, 'release.json'), 'utf8'));
const artifact = resolve(process.argv[2] || join(project, `dist/desktop/out/make/deb/x64/oraculum_${release.version}_amd64.deb`));
const scratch = await mkdtemp(join(tmpdir(), 'oraculum-deb-check-'));
const extracted = join(scratch, 'package'), control = join(scratch, 'control');
const evidenceDirectory = join(project, '.local/evidence/phase4b/deb');
await mkdir(evidenceDirectory, { recursive: true });
const evidence = join(evidenceDirectory, `${basename(artifact)}.json`);
const report = { artifact, date: new Date().toISOString(), installed: false, realCodex: false, osSandboxVerified: false, checks: [] };
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
const pass = name => { report.checks.push(name); console.log(`PASS ${name}`); };
let child;
try {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(artifact)) hash.update(chunk);
  report.sha256 = hash.digest('hex');
  report.package = run('dpkg-deb', ['--field', artifact, 'Package']).trim();
  report.version = run('dpkg-deb', ['--field', artifact, 'Version']).trim();
  report.architecture = run('dpkg-deb', ['--field', artifact, 'Architecture']).trim();
  report.depends = run('dpkg-deb', ['--field', artifact, 'Depends']).trim();
  assert.equal(report.package, 'oraculum'); assert.equal(report.version, release.version); assert.equal(report.architecture, 'amd64');
  assert.ok(report.depends.length, 'A desktop package must declare its host GUI library dependencies');
  assert.match(report.depends, /(?:^|,\s*)libc6 \(>= 2\.31\)(?:,|$)/);
  assert.match(report.depends, /(?:^|,\s*)fonts-noto-cjk(?:,|$)/);
  const listing = run('dpkg-deb', ['--contents', artifact]);
  const entries = listing.trim().split('\n').map(line => {
    const match = /^(\S+)\s+(\S+)\s+\d+\s+\S+\s+\S+\s+(.+)$/.exec(line);
    assert.ok(match, 'Unexpected dpkg package listing format');
    const [name, link] = match[3].split(' -> ');
    assert.ok(name.startsWith('./') && !name.split('/').includes('..'), 'Non-canonical package path');
    assert.equal(match[2], 'root/root', `Unexpected archive owner for ${name}`);
    assert.ok(!/[\x00-\x1f\x7f]/.test(name), 'Control character in package path');
    return { mode: match[1], name: name.slice(2).replace(/\/$/, ''), link };
  });
  const writableEntries = [];
  for (const entry of entries) {
    assert.ok(entry.name === '' || entry.name === 'usr' || entry.name.startsWith('usr/'), 'Package writes outside /usr');
    if (entry.link && isAbsolute(entry.link)) {
      assert.ok(entry.name === 'usr/bin/oraculum' && entry.link === '/usr/lib/oraculum/oraculum', `Non-portable absolute package link: ${entry.name} -> ${entry.link}`);
    }
    // Unix symlink permissions are not applied to the target; validate their
    // containment and target below, and enforce file/directory permissions here.
    if (!entry.link && (entry.mode[5] === 'w' || entry.mode[8] === 'w')) writableEntries.push(entry.name || '/');
    if (/[sS]/.test(entry.mode)) assert.equal(entry.name, 'usr/lib/oraculum/chrome-sandbox', 'Unexpected setuid/setgid executable');
  }
  const sandbox = entries.find(entry => entry.name === 'usr/lib/oraculum/chrome-sandbox');
  assert.equal(sandbox?.mode, '-rwsr-xr-x', 'Chromium helper must be root:root 4755 in the archive');
  report.writableEntries = writableEntries;
  pass('Debian identity, declared dependencies, root ownership and sandbox-helper archive permissions');

  run('dpkg-deb', ['--extract', artifact, extracted]);
  run('dpkg-deb', ['--control', artifact, control]);
  const installation = join(extracted, 'usr/lib/oraculum');
  const runtime = join(installation, 'resources/runtime');
  const required = ['oraculum', 'chrome-sandbox', 'LICENSES.chromium.html', 'resources/app/package.json', 'resources/app/main.cjs', 'resources/app/paths.cjs',
    'resources/app/runtime.cjs', 'resources/runtime/node/bin/node', 'resources/runtime/node/LICENSE',
    'resources/runtime/bridge/main.mjs', 'resources/runtime/bridge/trust.mjs', 'resources/runtime/bin/oraculum-bridge',
    'resources/runtime/runtime-config.cjs', 'resources/runtime/launch-bridge.cjs', 'resources/runtime/oraculum-bridge.service',
    'resources/runtime/apps/web/dist/index.html', 'resources/runtime/apps/desktop/splash.html',
    'resources/runtime/apps/desktop/splash.css', 'resources/runtime/apps/desktop/splash.js',
    'resources/runtime/design/reference/02_Brand_OracleEye_App_Icon.png',
    'resources/runtime/design/reference/03_Brand_OracleEye_Simplified_Icon.png', 'resources/runtime/protocol.lock.json',
    'resources/runtime/build.json', 'resources/runtime/themes/minimal-light/theme.css'];
  for (const name of required) assert.ok((await lstat(join(installation, name))).isFile(), `Missing package resource ${name}`);
  const appManifest = JSON.parse(await readFile(join(installation, 'resources/app/package.json'), 'utf8'));
  assert.equal(appManifest.version, release.version); assert.equal(appManifest.main, 'main.cjs');
  assert.equal(appManifest.devDependencies, undefined); assert.equal(appManifest.config, undefined);
  const launcher = join(extracted, 'usr/bin/oraculum');
  assert.ok((await lstat(launcher)).isSymbolicLink(), 'Expected the package-managed /usr/bin entry');
  const launcherTarget = await readlink(launcher);
  const mappedTarget = isAbsolute(launcherTarget) ? resolve(extracted, '.' + launcherTarget) : resolve(dirname(launcher), launcherTarget);
  assert.equal(mappedTarget, join(installation, 'oraculum'));
  const desktop = await readFile(join(extracted, 'usr/share/applications/oraculum.desktop'), 'utf8');
  assert.match(desktop, /^Name=神谕$/m); assert.match(desktop, /^Exec=.*(?:\/|\b)oraculum(?:\s|$)/m);
  assert.match(desktop, /^Icon=oraculum$/m);
  assert.ok(entries.some(entry => /^(?:usr\/share\/icons\/.*|usr\/share\/pixmaps)\/oraculum\.png$/.test(entry.name)), 'Application icon missing');
  const metadata = JSON.parse(await readFile(join(runtime, 'build.json'), 'utf8'));
  assert.match(metadata.git, /^[a-f0-9]{40}$/); assert.match(metadata.nodeVersion, /^24\./);
  report.build = metadata;
  const unit = await readFile(join(runtime, 'oraculum-bridge.service'), 'utf8');
  assert.match(unit, /^ExecStart=\/usr\/lib\/oraculum\/resources\/runtime\/bin\/oraculum-bridge$/m);
  for (const expected of ['UMask=0077', 'Restart=on-failure', 'TimeoutStopSec=15', 'KillMode=control-group']) assert.ok(unit.includes(expected));
  assert.ok(!entries.some(entry => /(?:lib|share)\/systemd\/user\//.test(entry.name)), 'Service must remain an unregistered resource');
  pass('Chinese desktop identity, portable executable link, complete Web/Bridge/Node/brand resources and inert user-unit file');

  const firstPartyText = [];
  for (const entry of entries) {
    const name = entry.name;
    assert.ok(!/(?:^|\/)(?:\.git|\.local|\.cache|\.gradle|\.env(?:\.[^/]*)?|\.npmrc|\.modules\.yaml|\.pnpm-workspace-state-v1\.json)(?:\/|$)/.test(name), `Private/build metadata in package: ${name}`);
    assert.ok(!/\.(?:jks|keystore|sqlite(?:-[a-z]+)?|pem|key|hprof|log)$/i.test(name) && !/(?:^|\/)(?:runtime\.json|auth\.json|config\.toml|pairing\.txt|id_rsa|id_ed25519)$/.test(name), `Sensitive state or credential-shaped file: ${name}`);
    const thirdParty = name.includes('/node_modules/');
    if (thirdParty) {
      assert.ok(!/\/node_modules\/(?:tsx|typescript|vitest|electron|pnpm|@playwright|@electron-forge)(?:\/|$)/.test(name), `Development dependency in package: ${name}`);
    } else if (name.startsWith('usr/lib/oraculum/resources/')) {
      assert.ok(!/\/(?:src|scripts|test-results|playwright-report|\.local)\//.test(name) && !/\.(?:tsx?|map)$/.test(name), `Project development source in package: ${name}`);
      if (/\.(?:cjs|mjs|js|html|css|service)$/.test(name) || name.endsWith('/bin/oraculum-bridge')) firstPartyText.push(name);
    }
    if (entry.link) {
      const target = isAbsolute(entry.link) ? resolve(extracted, '.' + entry.link) : resolve(dirname(join(extracted, name)), entry.link);
      const offset = relative(extracted, target);
      assert.ok(offset && offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset), `Escaping package link: ${name}`);
      await access(target);
      if (!isAbsolute(entry.link)) {
        const actual = relative(extracted, await realpath(join(extracted, name)));
        assert.ok(actual !== '..' && !actual.startsWith('..' + sep) && !isAbsolute(actual), `Escaping resolved package link: ${name}`);
      }
    }
  }
  for (const name of firstPartyText) {
    const text = await readFile(join(extracted, name), 'utf8');
    assert.ok(!text.includes('--no-sandbox'), `Forbidden release sandbox override in ${name}`);
    assert.ok(!text.includes(project.replace(/\/$/, '')), `Build-host repository path embedded in ${name}`);
    assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text), `Private-key-shaped text in ${name}`);
  }
  for (const name of await readdir(control)) if (['preinst', 'postinst', 'prerm', 'postrm'].includes(name)) {
    const text = await readFile(join(control, name), 'utf8');
    assert.ok(!/\b(?:systemctl|loginctl|ssh|curl|wget|useradd|groupadd)\b/.test(text), `Unexpected system/service/network action in ${name}`);
  }
  pass('Package whitelist, self-contained symlinks, no user data/secrets/dev tools or release sandbox override');

  const licenseCandidates = entries.filter(entry => /(?:^|\/)(?:electron[-_])?licen[cs]e(?:\.[^/]+)?$/i.test(entry.name) && !entry.name.includes('/node_modules/'));
  let electronLicense = false;
  for (const entry of licenseCandidates) if ((await readFile(join(extracted, entry.name), 'utf8')).includes('Electron contributors')) electronLicense = true;
  assert.ok(electronLicense, 'Electron MIT license must survive the DEB maker exclusion of root LICENSE');
  const readLicenseManifest = async area => {
    const directory = join(runtime, 'licenses', area);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.format, 1); assert.ok(Array.isArray(manifest.packages) && manifest.packages.length);
    const identities = new Set();
    for (const pkg of manifest.packages) {
      assert.ok(typeof pkg.name === 'string' && typeof pkg.version === 'string' && typeof pkg.license === 'string');
      const identity = `${pkg.name}@${pkg.version}`;
      assert.ok(!identities.has(identity), `Duplicate ${area} notice manifest package: ${identity}`); identities.add(identity);
      assert.ok(Array.isArray(pkg.notices) && pkg.notices.length, `Missing ${area} notices for ${identity}`);
      for (const notice of pkg.notices) {
        assert.ok(typeof notice.path === 'string' && !isAbsolute(notice.path) && !notice.path.split('/').includes('..') && !/[\\\x00-\x1f]/.test(notice.path));
        assert.match(notice.sha256, /^[a-f0-9]{64}$/);
        const path = join(directory, notice.path);
        assert.ok((await lstat(path)).isFile(), `Missing packaged ${area} notice: ${notice.path}`);
        const bytes = await readFile(path); assert.ok(bytes.length);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), notice.sha256, `Changed ${area} license notice: ${notice.path}`);
      }
    }
    return manifest;
  };
  const webLicenses = await readLicenseManifest('web'), bridgeLicenses = await readLicenseManifest('bridge');
  const webManifest = JSON.parse(await readFile(join(project, 'apps/web/package.json'), 'utf8'));
  assert.equal(webLicenses.entry.name, webManifest.name); assert.deepEqual(webLicenses.entry.dependencies, webManifest.dependencies);
  assert.deepEqual(webLicenses.entry.emittedBuildAssets, { tailwindcss: webManifest.devDependencies.tailwindcss, vite: webManifest.devDependencies.vite });
  for (const [name, version] of Object.entries({ ...webLicenses.entry.dependencies, ...webLicenses.entry.emittedBuildAssets })) {
    assert.ok(webLicenses.packages.some(pkg => pkg.name === name && pkg.version === version), `Missing Web entry notice: ${name}@${version}`);
  }
  assert.deepEqual(bridgeLicenses, JSON.parse(await readFile(join(project, 'packaging/licenses/manifest.json'), 'utf8')));
  report.webLicensePackages = webLicenses.packages.length;
  report.bridgeSupplementalLicenses = bridgeLicenses;
  pass(`Hashed Web dependency/emitted-asset notices (${webLicenses.packages.length}) and explicit Bridge supplemental license provenance`);
  const dependencyLicenses = [], missingLicenses = [];
  const virtualStore = join(runtime, 'node_modules/.pnpm');
  for (const entry of await readdir(virtualStore, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const modules = join(virtualStore, entry.name, 'node_modules');
    for (const candidate of await readdir(modules, { withFileTypes: true })) {
      if (!candidate.isDirectory()) continue;
      const packageRoots = candidate.name.startsWith('@')
        ? (await readdir(join(modules, candidate.name), { withFileTypes: true })).filter(item => item.isDirectory()).map(item => join(modules, candidate.name, item.name))
        : [join(modules, candidate.name)];
      for (const packageRoot of packageRoots) {
        const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
        const licenses = (await readdir(packageRoot)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(name));
        const supplement = bridgeLicenses.packages.find(candidate => candidate.name === pkg.name && candidate.version === pkg.version && candidate.license === pkg.license);
        if (!licenses.length && supplement) licenses.push(...supplement.notices.map(notice => `licenses/bridge/${notice.path}`));
        if (!licenses.length) missingLicenses.push(`${pkg.name}@${pkg.version}`);
        dependencyLicenses.push({ name: pkg.name, version: pkg.version, license: pkg.license, files: licenses });
      }
    }
  }
  assert.ok(dependencyLicenses.length > 0);
  assert.match(await readFile(join(runtime, 'themes/hong-kong-rain/theme.css'), 'utf8'), /Bitstream/);
  report.dependencyLicenses = dependencyLicenses;
  report.missingDependencyLicenses = missingLicenses;
  if (missingLicenses.length) console.error(`Missing dependency license notices: ${missingLicenses.join(', ')}`);
  else pass(`Electron, Chromium, Node, theme font and ${dependencyLicenses.length} production dependency license notices`);

  const privateNode = join(runtime, 'node/bin/node');
  assert.equal(run(privateNode, ['--version']).trim(), `v${metadata.nodeVersion}`);
  assert.equal(run(privateNode, ['-e', "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');console.log(d.prepare('SELECT 7 AS n').get().n);d.close()"]).trim(), '7');
  for (const binary of [join(installation, 'oraculum'), privateNode]) {
    const libraries = run('ldd', [binary]); assert.ok(!libraries.includes('not found'), 'Host library dependency unresolved');
  }
  const fixtureHome = join(scratch, 'home'), unrelated = join(scratch, 'unrelated');
  await mkdir(join(fixtureHome, '.local/bin'), { recursive: true }); await mkdir(unrelated);
  const fixture = join(fixtureHome, '.local/bin/codex'), calls = join(scratch, 'native-calls');
  await writeFile(fixture, `#!${privateNode}\nif(process.argv[2]==='--version'){console.log('codex-cli 9.9.9-deb-fixture');process.exit(0)}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
require('node:fs').appendFileSync(process.env.FIXTURE_CALLS,m.method+'\\n');
const result=m.method==='initialize'?{userAgent:'fixture'}:m.method==='config/read'?{config:{model:null,model_provider:null,model_reasoning_effort:null}}:{data:[],nextCursor:null};
console.log(JSON.stringify({id:m.id,result}));});`, { mode: 0o700 });
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(accept => probe.close(accept));
  const env = { HOME: fixtureHome, PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: join(fixtureHome, 'config'),
    XDG_STATE_HOME: join(fixtureHome, 'state'), XDG_DATA_HOME: join(fixtureHome, 'data'),
    ORACULUM_INIT_STATE: '1', ORACULUM_PORT: String(port), FIXTURE_CALLS: calls };
  child = spawn(join(runtime, 'bin/oraculum-bridge'), { cwd: unrelated, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const exited = once(child, 'exit');
  const deadline = Date.now() + 15_000;
  while (!output.includes('codex-cli 9.9.9-deb-fixture') && child.exitCode === null && Date.now() < deadline) await new Promise(accept => setTimeout(accept, 100));
  assert.match(output, /codex-cli 9.9.9-deb-fixture/, 'Extracted runtime did not initialize its disposable fixture');
  const health = await fetch(`http://127.0.0.1:${port}/health`); assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { protocol: 1, mode: 'authenticated' });
  assert.match(await (await fetch(`http://127.0.0.1:${port}/`)).text(), /Oraculum · 神谕/);
  child.kill('SIGTERM'); assert.equal((await exited)[0], 0); child = undefined;
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n'), ['initialize', 'config/read', 'model/list', 'thread/list']);
  pass('Actual extracted private Node/SQLite/libraries and standalone Bridge from unrelated cwd/HOME/XDG; simulated CLI, zero turns');
  assert.deepEqual(writableEntries, [], 'Group/world writable package files or directories');
  pass('No group/world writable package files or directories (symlinks checked by target)');
  assert.deepEqual(missingLicenses, [], 'Published production dependencies must retain their license notices');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error);
  console.error(`FAIL ${report.error}`); process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  await rm(scratch, { recursive: true, force: true });
  await writeFile(evidence, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, evidence, sha256: report.sha256, installed: false, osSandboxVerified: false }));
}
