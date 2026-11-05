// Inspect and extract the Desktop DEB only. Never install or touch user services.
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const release = JSON.parse(await readFile(join(project, 'release.json'), 'utf8'));
const version = release.components.desktop.version;
const artifact = resolve(process.argv[2] || join(project, `dist/desktop/out/make/deb/x64/oraculum_${version}_amd64.deb`));
const expectedGit = process.argv[3];
if (expectedGit) assert.match(expectedGit, /^[a-f0-9]{40}$/, 'Expected source commit must be a full Git SHA');
assert.ok(process.argv.length <= 4, 'Usage: verify-deb.mjs [DEB [EXPECTED_GIT]]');
const scratch = await mkdtemp(join(tmpdir(), 'oraculum-desktop-deb-'));
const extracted = join(scratch, 'package'), control = join(scratch, 'control');
const evidenceDirectory = join(project, '.local/evidence/stage-b');
await mkdir(evidenceDirectory, { recursive: true });
const evidence = join(evidenceDirectory, `${basename(artifact)}.json`);
const report = { artifact, date: new Date().toISOString(), installed: false, component: 'desktop', osSandboxVerified: false, checks: [] };
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pass = name => { report.checks.push(name); console.log(`PASS ${name}`); };
try {
  const digest = createHash('sha256'); for await (const chunk of createReadStream(artifact)) digest.update(chunk);
  report.sha256 = digest.digest('hex');
  for (const [key, field] of [['package', 'Package'], ['version', 'Version'], ['architecture', 'Architecture'], ['depends', 'Depends']]) report[key] = run('dpkg-deb', ['--field', artifact, field]).trim();
  assert.equal(report.package, 'oraculum'); assert.equal(report.version, version); assert.equal(report.architecture, 'amd64');
  assert.match(report.depends, /(?:^|,\s*)libc6 \(>= 2\.31\)(?:,|$)/);
  assert.match(report.depends, /(?:^|,\s*)fonts-noto-cjk(?:,|$)/);
  assert.doesNotMatch(report.depends, /(?:^|[, ])(?:nodejs|pnpm|oraculum-bridge)(?:[, (]|$)/, 'Desktop must install independently and explain a missing Bridge in its UI');
  const entries = run('dpkg-deb', ['--contents', artifact]).trim().split('\n').map(line => {
    const match = /^(\S+)\s+(\S+)\s+\d+\s+\S+\s+\S+\s+(.+)$/.exec(line);
    assert.ok(match, 'Unexpected dpkg listing');
    const [name, link] = match[3].split(' -> ');
    assert.ok(name.startsWith('./') && !name.split('/').includes('..'));
    assert.equal(match[2], 'root/root'); assert.doesNotMatch(name, /[\x00-\x1f\x7f]/);
    return { mode: match[1], name: name.slice(2).replace(/\/$/, ''), link };
  });
  for (const entry of entries) {
    const { name, link, mode } = entry;
    assert.ok(name === '' || name === 'usr' || name.startsWith('usr/'), `Package writes outside /usr: ${name}`);
    if (!link) assert.ok(mode[5] !== 'w' && mode[8] !== 'w', `Writable package entry: ${name}`);
    if (/[sS]/.test(mode)) assert.equal(name, 'usr/lib/oraculum/chrome-sandbox');
    if (link && isAbsolute(link)) assert.ok(name === 'usr/bin/oraculum' && link === '/usr/lib/oraculum/oraculum');
    assert.doesNotMatch(name, /(?:^|\/)(?:runtime|node_modules|\.git|\.local|\.cache|\.gradle|\.env(?:\.[^/]*)?|\.npmrc)(?:\/|$)/);
    assert.doesNotMatch(name, /(?:^|\/)(?:bridge|systemd)(?:\/|$)|\/node\/bin\/node$/);
    assert.doesNotMatch(name, /\.(?:jks|keystore|sqlite(?:-[a-z]+)?|pem|key|hprof|log)$/i);
    assert.doesNotMatch(name, /(?:^|\/)(?:runtime\.json|auth\.json|config\.toml|pairing\.txt|id_rsa|id_ed25519)$/);
  }
  assert.equal(entries.find(entry => entry.name === 'usr/lib/oraculum/chrome-sandbox')?.mode, '-rwsr-xr-x');
  pass('Independent Desktop identity/dependencies, root ownership, safe archive paths and sandbox helper; no Bridge/Node/state payload');
  run('dpkg-deb', ['--extract', artifact, extracted]); run('dpkg-deb', ['--control', artifact, control]);
  const installation = join(extracted, 'usr/lib/oraculum'), resources = join(installation, 'resources/desktop');
  for (const name of ['oraculum', 'chrome-sandbox', 'LICENSES.chromium.html', 'resources/app/package.json', 'resources/app/main.cjs', 'resources/app/paths.cjs',
    'resources/app/runtime.cjs', 'resources/app/runtime-config.cjs', 'resources/app/artifacts.cjs', 'resources/app/notifications.cjs',
    'resources/desktop/apps/desktop/splash.html', 'resources/desktop/apps/desktop/splash.css', 'resources/desktop/apps/desktop/splash.js',
    'resources/desktop/build.json', 'resources/desktop/licenses/electron-LICENSE', 'resources/desktop/licenses/THEME-ASSETS.md']) {
    assert.ok((await lstat(join(installation, name))).isFile(), `Missing resource ${name}`);
  }
  const appManifest = JSON.parse(await readFile(join(installation, 'resources/app/package.json'), 'utf8'));
  assert.equal(appManifest.version, version); assert.equal(appManifest.main, 'main.cjs');
  assert.equal(appManifest.devDependencies, undefined); assert.equal(appManifest.config, undefined);
  const metadata = JSON.parse(await readFile(join(resources, 'build.json'), 'utf8'));
  assert.equal(metadata.component, 'desktop'); assert.equal(metadata.version, version); assert.equal(metadata.protocolVersion, 1);
  assert.match(metadata.git, /^[a-f0-9]{40}$/); assert.equal(typeof metadata.sourceDirty, 'boolean');
  if (expectedGit) { assert.equal(metadata.git, expectedGit); assert.equal(metadata.sourceDirty, false); }
  report.build = metadata;
  const launcher = join(extracted, 'usr/bin/oraculum'); assert.ok((await lstat(launcher)).isSymbolicLink());
  const target = await readlink(launcher);
  assert.equal(isAbsolute(target) ? resolve(extracted, '.' + target) : resolve(dirname(launcher), target), join(installation, 'oraculum'));
  const desktop = await readFile(join(extracted, 'usr/share/applications/oraculum.desktop'), 'utf8');
  assert.match(desktop, /^Name=神谕$/m); assert.match(desktop, /^Exec=.*(?:\/|\b)oraculum(?:\s|$)/m); assert.match(desktop, /^Icon=oraculum$/m);
  assert.ok(entries.some(entry => /^(?:usr\/share\/icons\/.*|usr\/share\/pixmaps)\/oraculum\.png$/.test(entry.name)));
  for (const name of ['02_Brand_OracleEye_App_Icon.png', '03_Brand_OracleEye_Simplified_Icon.png']) {
    assert.equal(hash(await readFile(join(resources, 'design/reference', name))), hash(await readFile(join(project, 'design/reference', name))));
  }
  assert.match(await readFile(join(resources, 'licenses/electron-LICENSE'), 'utf8'), /Electron contributors/);
  assert.doesNotMatch(run('ldd', [join(installation, 'oraculum')]), /not found/);
  pass('Complete standalone desktop splash/icons/notification/profile resources, source identity and Electron/Chromium licenses/libraries');
  for (const { name, link } of entries) {
    if (link) {
      const target = isAbsolute(link) ? resolve(extracted, '.' + link) : resolve(dirname(join(extracted, name)), link);
      const offset = relative(extracted, target); assert.ok(offset && offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset));
      await access(target);
      if (!isAbsolute(link)) { const actual = relative(extracted, await realpath(join(extracted, name))); assert.ok(actual !== '..' && !actual.startsWith('..' + sep) && !isAbsolute(actual)); }
    }
    if (name.startsWith('usr/lib/oraculum/resources/') && /\.(?:cjs|mjs|js|html|css)$/.test(name)) {
      const text = await readFile(join(extracted, name), 'utf8');
      assert.ok(!text.includes('--no-sandbox')); assert.ok(!text.includes(project.replace(/\/$/, '')));
      assert.doesNotMatch(text, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
    }
  }
  for (const name of await readdir(control)) if (['preinst', 'postinst', 'prerm', 'postrm'].includes(name)) {
    assert.doesNotMatch(await readFile(join(control, name), 'utf8'), /\b(?:systemctl|loginctl|ssh|curl|wget|useradd|groupadd)\b/);
  }
  pass('Contained links, no embedded developer path/secrets/sandbox bypass, no installer service/network actions');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
  console.error(`FAIL ${report.error}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
  await writeFile(evidence, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, evidence, sha256: report.sha256, installed: false, osSandboxVerified: false }));
}
