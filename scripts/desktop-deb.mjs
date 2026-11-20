import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const desktop = join(root, 'apps/desktop');
const settings = await readJson(join(desktop, 'package.json'));
const component = 'oraculum-desktop';
const version = settings.version;
const debVersion = version.replace('-', '~');
const architecture = 'amd64';
const tag = `desktop-v${version}`;
const electronVersion = settings.devDependencies.electron;
const archiveName = `electron-v${electronVersion}-linux-x64.zip`;
// GitHub normalizes tildes in asset names. Keep the Debian version in the control file.
const name = `${component}_${version}_${architecture}.deb`;
const runtimePath = `usr/lib/${component}`;
const docPath = `usr/share/doc/${component}`;
const menuPath = `usr/share/applications/${component}.desktop`;
const iconPath = `usr/share/icons/hicolor/256x256/apps/${component}.png`;
const cliPath = `usr/bin/${component}`;
const cliTarget = `../lib/${component}/${component}`;
const assets = [name, 'desktop-release.json', 'RELEASE_NOTES.md'];
const licenses = ['LICENSE', 'NOTICE', 'THIRD_PARTY.md'];
const runtimeFiles = [
  component, 'chrome-sandbox', 'chrome_crashpad_handler', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
  'icudtl.dat', 'libffmpeg.so', 'libvk_swiftshader.so', 'libvulkan.so.1', 'resources.pak',
  'snapshot_blob.bin', 'v8_context_snapshot.bin', 'version', 'vk_swiftshader_icd.json',
];
const executableModes = new Map([
  [`${runtimePath}/${component}`, 0o755],
  [`${runtimePath}/chrome_crashpad_handler`, 0o755],
  // dpkg-deb sets root ownership when archiving the upstream Chromium helper.
  [`${runtimePath}/chrome-sandbox`, 0o4755],
]);
const appFiles = ['main/index.cjs', 'preload/index.cjs', 'icon.png', 'package.json', 'renderer-manifest.json', 'build-info.json'];
const dependencies = [
  'libc6 (>= 2.39)', 'libasound2t64', 'libatk-bridge2.0-0t64', 'libatk1.0-0t64', 'libatspi2.0-0t64',
  'libcairo2', 'libcups2t64', 'libdbus-1-3', 'libexpat1', 'libgbm1', 'libgcc-s1', 'libglib2.0-0t64',
  'libgtk-3-0t64', 'libnspr4', 'libnss3', 'libpango-1.0-0', 'libsecret-1-0', 'libudev1',
  'libx11-6', 'libxcb1', 'libxcomposite1', 'libxdamage1', 'libxext6', 'libxfixes3', 'libxkbcommon0', 'libxrandr2',
].join(', ');

function run(program, args, options = {}) {
  return execFileSync(program, args, { cwd: root, encoding: 'utf8', ...options })?.trimEnd();
}

function cleanRevision() {
  assert.equal(run('git', ['status', '--porcelain', '--untracked-files=all']), '', 'Desktop DEB requires a clean, committed source tree');
  return run('git', ['rev-parse', 'HEAD']);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function digest(path, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function files(base, directory = base) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(base, file));
    else if (entry.isFile()) result.push(relative(base, file));
    else assert.equal(relative(base, file), cliPath, 'Unexpected non-regular package entry');
  }
  return result.sort();
}

async function normalizePermissions(base, directory = base) {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await normalizePermissions(base, path);
    else if (entry.isFile()) await chmod(path, executableModes.get(relative(base, path)) ?? 0o644);
  }
}

async function writeChecksums(candidate) {
  const lines = [];
  for (const file of assets) lines.push(`${await digest(join(candidate, file))}  ${file}`);
  await writeFile(join(candidate, 'SHA256SUMS'), lines.join('\n') + '\n');
}

async function build(target) {
  assert.equal(process.platform + '/' + process.arch, 'linux/x64');
  assert.match(version, /^\d+\.\d+\.\d+-beta\.\d+$/);
  const sourceGit = cleanRevision();
  const output = target ? resolve(target) : join(root, 'dist/desktop', sourceGit);
  // Reserve the destination exclusively. Publish its contents only after verification.
  if (!target) await mkdir(join(root, 'dist/desktop'), { recursive: true });
  await mkdir(output);
  let stage;
  let complete = false;
  try {
    stage = await mkdtemp(join(output, '.stage-'));
    const payload = join(stage, 'payload');
    const candidate = join(stage, 'candidate');
    const runtime = join(payload, runtimePath);
    const docs = join(payload, docPath);
    const app = join(runtime, 'resources/app');
    const dist = join(desktop, 'dist');
    const archive = process.env.ORACULUM_ELECTRON_ZIP ? resolve(process.env.ORACULUM_ELECTRON_ZIP) : join(stage, archiveName);
    const checksums = await readJson(join(desktop, 'node_modules/electron/checksums.json'));
    const electronSha256 = checksums[archiveName];
    assert.match(electronSha256, /^[0-9a-f]{64}$/);
    if (!process.env.ORACULUM_ELECTRON_ZIP) {
      run('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '2', '--output', archive,
        `https://github.com/electron/electron/releases/download/v${electronVersion}/${archiveName}`]);
    }
    assert.equal(await digest(archive), electronSha256, 'Electron archive checksum does not match the pinned npm package');
    run('pnpm', ['--filter', '@oraculum/desktop', 'run', 'build', '--release'], { stdio: 'inherit' });
    const info = await readJson(join(dist, 'build-info.json'));
    assert.equal(info.sourceRevision, sourceGit);
    assert.equal(info.sourceDirty, false);
    await mkdir(runtime, { recursive: true });
    run('unzip', ['-q', archive, '-x', 'resources/default_app.asar', '-d', runtime]);
    await rename(join(runtime, 'electron'), join(runtime, component));
    await mkdir(app, { recursive: true });
    await cp(join(dist, 'renderer'), join(app, 'renderer'), { recursive: true });
    for (const file of appFiles) {
      await mkdir(dirname(join(app, file)), { recursive: true });
      await cp(join(dist, file), join(app, file));
    }
    await mkdir(docs, { recursive: true });
    for (const file of licenses) await cp(join(root, file), join(docs, file));
    await rename(join(runtime, 'LICENSE'), join(docs, 'LICENSE.electron'));
    await rename(join(runtime, 'LICENSES.chromium.html'), join(docs, 'LICENSES.chromium.html'));
    await cp(join(dist, 'third-party'), join(docs, 'third-party'), { recursive: true });
    await cp(join(docs, 'LICENSE'), join(docs, 'copyright'));
    await mkdir(dirname(join(payload, menuPath)), { recursive: true });
    await cp(join(root, 'packaging/desktop', `${component}.desktop`), join(payload, menuPath));
    await mkdir(dirname(join(payload, iconPath)), { recursive: true });
    await cp(join(dist, 'icon.png'), join(payload, iconPath));
    await mkdir(join(payload, 'usr/bin'), { recursive: true });
    await symlink(cliTarget, join(payload, cliPath));

    await mkdir(join(payload, 'DEBIAN'));
    const md5sums = [];
    for (const file of await files(payload)) md5sums.push(`${await digest(join(payload, file), 'md5')}  ${file}`);
    await writeFile(join(payload, 'DEBIAN/md5sums'), md5sums.join('\n') + '\n');
    const installedSize = run('du', ['-sk', join(payload, 'usr')]).split(/\s/)[0];
    await writeFile(join(payload, 'DEBIAN/control'), `Package: ${component}
Version: ${debVersion}
Architecture: ${architecture}
Section: devel
Priority: optional
Maintainer: Oraculum project <rando1ph@users.noreply.github.com>
Installed-Size: ${installedSize}
Depends: ${dependencies}
Recommends: gnome-keyring
Homepage: https://github.com/rando1ph/oraculum
Description: Oraculum Desktop client for the official Codex App Server
 Independent Electron client for Oraculum Gateway, with local drafts and
 offline reading of previously loaded conversations.
`);
    await normalizePermissions(payload);
    await mkdir(candidate);
    const artifact = join(candidate, name);
    run('dpkg-deb', ['--build', '--root-owner-group', '-Zxz', payload, artifact], {
      stdio: 'inherit',
      env: { ...process.env, SOURCE_DATE_EPOCH: run('git', ['show', '-s', '--format=%ct', sourceGit]) },
    });
    const manifest = {
      format: 1, component, version, debVersion, architecture, tag, sourceGit,
      sourceRepository: 'https://github.com/rando1ph/oraculum', license: settings.license,
      electron: { version: electronVersion, archive: archiveName, sha256: electronSha256 },
      runtime: { ubuntu: '24.04 LTS', command: `/${cliPath}`,
        sandbox: 'Chromium sandbox with bundled root:root 4755 chrome-sandbox helper',
        gatewayProtocol: '2.1', credentialBackend: 'gnome_libsecret', profile: 'oraculum-desktop-v2/production' },
      artifact: { name, bytes: (await lstat(artifact)).size, sha256: await digest(artifact) },
    };
    await writeFile(join(candidate, 'desktop-release.json'), JSON.stringify(manifest, null, 2) + '\n');
    const notes = await readFile(join(root, 'packaging/desktop/RELEASE_NOTES.md'), 'utf8');
    await writeFile(join(candidate, 'RELEASE_NOTES.md'), notes.replaceAll('@SOURCE_GIT@', sourceGit));
    await writeChecksums(candidate);
    assert.equal(cleanRevision(), sourceGit);
    await verify(candidate);
    for (const file of [...assets, 'SHA256SUMS']) await rename(join(candidate, file), join(output, file));
    complete = true;
    console.log(`Release assets: ${output}`);
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    if (!complete) await rm(output, { recursive: true, force: true });
  }
}

async function verify(candidate) {
  const artifact = join(candidate, name);
  const checksumLines = [];
  for (const file of assets) checksumLines.push(`${await digest(join(candidate, file))}  ${file}`);
  assert.equal(await readFile(join(candidate, 'SHA256SUMS'), 'utf8'), checksumLines.join('\n') + '\n');
  const manifest = await readJson(join(candidate, 'desktop-release.json'));
  assert.deepEqual(
    [manifest.component, manifest.version, manifest.debVersion, manifest.architecture, manifest.tag, manifest.license, manifest.electron.version],
    [component, version, debVersion, architecture, tag, settings.license, electronVersion],
  );
  assert.match(manifest.sourceGit, /^[0-9a-f]{40}$/);
  assert.deepEqual(manifest.artifact, { name, bytes: (await lstat(artifact)).size, sha256: await digest(artifact) });
  assert.ok((await readFile(join(candidate, 'RELEASE_NOTES.md'), 'utf8')).includes(manifest.sourceGit));
  for (const [field, value] of Object.entries({ Package: component, Version: debVersion, Architecture: architecture, Depends: dependencies })) {
    assert.equal(run('dpkg-deb', ['--field', artifact, field]), value);
  }

  const unpacked = await mkdtemp(join(tmpdir(), 'oraculum-deb-'));
  try {
    const listing = run('dpkg-deb', ['--contents', artifact]).split('\n');
    const expectedModes = new Map([
      [`./${runtimePath}/chrome-sandbox`, '-rwsr-xr-x'],
      [`./${runtimePath}/${component}`, '-rwxr-xr-x'],
      [`./${runtimePath}/chrome_crashpad_handler`, '-rwxr-xr-x'],
      [`./${cliPath} -> ${cliTarget}`, 'lrwxrwxrwx'],
    ]);
    for (const line of listing) {
      const match = line.match(/^(\S+)\s+root\/root\s+\d+\s+\S+\s+\S+\s+(\.\/.*)$/);
      assert.ok(match, `Unexpected file owner or archive listing: ${line}`);
      const [, mode, member] = match;
      assert.equal(mode, expectedModes.get(member) ?? (member.endsWith('/') ? 'drwxr-xr-x' : '-rw-r--r--'), member);
      expectedModes.delete(member);
    }
    assert.equal(expectedModes.size, 0, 'Missing runtime, sandbox or entry point');
    run('dpkg-deb', ['-R', artifact, unpacked]);
    assert.deepEqual((await readdir(join(unpacked, 'DEBIAN'))).sort(), ['control', 'md5sums'], 'Unexpected maintainer scripts');
    const app = join(unpacked, runtimePath, 'resources/app');
    const info = await readJson(join(app, 'build-info.json'));
    assert.equal(info.sourceRevision, manifest.sourceGit);
    assert.equal(info.sourceDirty, false);
    assert.equal(info.dependencies.electron, electronVersion);
    const identity = await readJson(join(app, 'package.json'));
    assert.deepEqual([identity.name, identity.version, identity.main, identity.license], [component, version, 'main/index.cjs', settings.license]);
    assert.equal((await readFile(join(unpacked, runtimePath, 'version'), 'utf8')).trim(), electronVersion);
    assert.match(run('readelf', ['-h', join(unpacked, runtimePath, component)]), /Advanced Micro Devices X86-64/);
    const renderer = await readJson(join(app, 'renderer-manifest.json'));
    assert.ok(renderer.files['index.html']);
    for (const [file, { size, sha256 }] of Object.entries(renderer.files)) {
      assert.match(file, /^[\w-]+(?:\/[\w-]+)*\.\w+$/);
      const path = join(app, 'renderer', file);
      assert.equal((await lstat(path)).size, size);
      assert.equal(await digest(path), sha256);
    }
    const docs = join(unpacked, docPath);
    const bundled = await readJson(join(docs, 'third-party/packages.json'));
    assert.ok(bundled.some(pkg => pkg.name === 'react') && bundled.some(pkg => pkg.name === 'ws'));
    const locales = await readdir(join(unpacked, runtimePath, 'locales'));
    assert.ok(locales.includes('zh-CN.pak') && locales.includes('en-US.pak'));
    assert.ok(locales.every(file => /^[\w-]+\.pak$/.test(file)));
    const expected = [
      menuPath, iconPath,
      ...runtimeFiles.map(file => `${runtimePath}/${file}`),
      ...locales.map(file => `${runtimePath}/locales/${file}`),
      ...[...appFiles, ...Object.keys(renderer.files).map(file => `renderer/${file}`)].map(file => `${runtimePath}/resources/app/${file}`),
      ...[...licenses, 'copyright', 'LICENSE.electron', 'LICENSES.chromium.html', 'third-party/packages.json'].map(file => `${docPath}/${file}`),
      ...bundled.flatMap(pkg => pkg.notices.map(file => `${docPath}/third-party/${file}`)),
    ].sort();
    assert.deepEqual(await files(unpacked), [...expected, 'DEBIAN/control', 'DEBIAN/md5sums'].sort());
    await access(join(unpacked, cliPath));
    assert.equal(await digest(join(unpacked, iconPath)), await digest(join(app, 'icon.png')));
    run('desktop-file-validate', [join(unpacked, menuPath)]);
    const lines = [];
    for (const file of expected) lines.push(`${await digest(join(unpacked, file), 'md5')}  ${file}`);
    assert.equal(await readFile(join(unpacked, 'DEBIAN/md5sums'), 'utf8'), lines.join('\n') + '\n');
    console.log(`Verified ${component} ${debVersion} ${architecture} from ${manifest.sourceGit}`);
  } finally {
    await rm(unpacked, { recursive: true, force: true });
  }
}

process.umask(0o022);
const [action, target, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0);
if (action === 'build') await build(target);
else if (action === 'verify' && target) await verify(resolve(target));
else throw new Error('Usage: desktop-deb.mjs build [new-output-directory] | verify <release-directory>');
