// Build only the Gateway's explicit entry points and their bundled dependencies.
// No UI, themes, user configuration, Codex data or legacy state is copied.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const untrackedDesignInput = 'upgrade/stitch_oraculum_android_workspace/';
export const nodeRuntime = Object.freeze({ version: '24.21.0', sha256: 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6' });
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (directory, args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' });

export async function inventoryRuntime(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (path === 'build.json') continue;
    assert.ok(!entry.isSymbolicLink(), `Unexpected runtime symlink: ${path}`);
    if (entry.isDirectory()) files.push(...await inventoryRuntime(directory, path));
    else {
      assert.ok(entry.isFile(), `Unexpected runtime file type: ${path}`);
      const bytes = await readFile(join(directory, path));
      files.push({ path, size: bytes.length, sha256: hash(bytes) });
    }
  }
  return files;
}

export function assertCleanGatewaySource(directory = root) {
  assert.equal(git(directory, ['branch', '--show-current']).trim(), 'main', 'Gateway candidates must be built on main');
  assert.equal(git(directory, ['diff', '--name-only', 'HEAD']).trim(), '', 'Gateway candidates require all tracked source changes committed');
  const untracked = git(directory, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const unexpected = untracked.filter(name => !name.startsWith(untrackedDesignInput));
  assert.deepEqual(unexpected, [], 'Gateway candidates require all source files committed; only the unchanged user Stitch design directory is excluded');
  const sourceGit = git(directory, ['rev-parse', 'HEAD']).trim();
  assert.match(sourceGit, /^[a-f0-9]{40}$/);
  return { sourceGit, sourceDirty: false, excludedUntrackedInputs: [untrackedDesignInput] };
}

// Use esbuild's actual input graph, not all workspace dependencies. The latter
// would include browser themes, Electron, test tools and other unrelated code.
export async function collectGatewayLicenses(metafile, destination, directory = root) {
  const identities = new Map();
  for (const input of Object.keys(metafile.inputs).filter(name => name.includes('node_modules/'))) {
    let current = dirname(await realpath(resolve(directory, input)));
    for (;;) {
      try {
        const pkg = JSON.parse(await readFile(join(current, 'package.json'), 'utf8'));
        if (pkg.name && pkg.version) { identities.set(`${pkg.name}@${pkg.version}`, { directory: current, pkg }); break; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.notEqual(dirname(current), current, `Cannot identify bundled dependency: ${input}`);
      current = dirname(current);
    }
  }
  const packages = [];
  const fallbackDirectory = join(directory, 'packaging/licenses');
  const fallback = JSON.parse(await readFile(join(fallbackDirectory, 'manifest.json'), 'utf8'));
  for (const { directory: installed, pkg } of identities.values()) {
    assert.equal(typeof pkg.license, 'string', `Missing license metadata: ${pkg.name}`);
    const notices = [];
    const folder = `${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`;
    await mkdir(join(destination, folder), { recursive: true });
    const files = (await readdir(installed, { withFileTypes: true })).filter(entry => entry.isFile() && /^(?:licen[cs]e|notice|copying|copyright)(?:[._-].*)?$/i.test(entry.name));
    for (const file of files) {
      const bytes = await readFile(join(installed, file.name));
      const path = `${folder}/${file.name}`;
      await writeFile(join(destination, path), bytes);
      notices.push({ path, sha256: hash(bytes) });
    }
    if (!notices.length) {
      const known = fallback.packages.find(entry => entry.name === pkg.name && entry.version === pkg.version && entry.license === pkg.license);
      assert.ok(known, `Bundled dependency has no license notice: ${pkg.name}@${pkg.version}`);
      for (const notice of known.notices) {
        const bytes = await readFile(join(fallbackDirectory, notice.path));
        assert.equal(hash(bytes), notice.sha256, 'Reviewed license notice has changed');
        const path = `${folder}/${notice.path}`;
        await writeFile(join(destination, path), bytes);
        notices.push({ path, sha256: hash(bytes), source: known.source });
      }
    }
    packages.push({ name: pkg.name, version: pkg.version, license: pkg.license, notices });
  }
  packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
  assert.ok(packages.length, 'Gateway bundle must have a license inventory');
  const manifest = { format: 1, scope: 'Dependencies actually included in the Gateway esbuild input graph; Node notices are in node/LICENSE.', packages };
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export async function buildGatewayRuntime() {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  process.umask(0o022);
  const source = assertCleanGatewaySource();
  const metadata = JSON.parse(await readFile(join(root, 'packaging/gateway/metadata.json'), 'utf8'));
  const output = join(root, 'dist/gateway-runtime');
  const cache = join(root, '.local/build-cache');
  await mkdir(cache, { recursive: true });
  const archive = `node-v${nodeRuntime.version}-linux-x64.tar.xz`;
  const download = join(cache, archive);
  try { assert.ok((await lstat(download)).isFile(), 'Node archive must be a regular file'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const temporary = `${download}.gateway-tmp`;
    execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--output', temporary, `https://nodejs.org/dist/v${nodeRuntime.version}/${archive}`], { stdio: 'inherit' });
    assert.equal(hash(await readFile(temporary)), nodeRuntime.sha256, 'Private Node archive checksum mismatch');
    await rename(temporary, download);
  }
  assert.equal(hash(await readFile(download)), nodeRuntime.sha256, 'Private Node archive checksum mismatch');
  await rm(output, { recursive: true, force: true });
  await mkdir(join(output, 'node/bin'), { recursive: true });
  // Extract only the runtime and its notices, never npm, headers or toolchains.
  execFileSync('tar', ['-xJf', download, '--strip-components=1', '-C', join(output, 'node'), `node-v${nodeRuntime.version}-linux-x64/bin/node`, `node-v${nodeRuntime.version}-linux-x64/LICENSE`]);
  const result = await build({ absWorkingDir: root, entryPoints: { main: 'gateway/src/main.ts', cli: 'gateway/src/cli.ts' },
    outdir: join(output, 'gateway'), outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', target: 'node24', format: 'esm',
    sourcemap: false, metafile: true, legalComments: 'none', external: ['bufferutil', 'utf-8-validate'],
    banner: { js: "import { createRequire as __gatewayCreateRequire } from 'node:module'; const require = __gatewayCreateRequire(import.meta.url);" } });
  const licenses = await collectGatewayLicenses(result.metafile, join(output, 'licenses'));
  await mkdir(join(output, 'bin'));
  for (const name of ['oraculum', 'oraculum-gateway']) {
    await cp(join(root, 'packaging/gateway', name), join(output, 'bin', name));
    await chmod(join(output, 'bin', name), 0o755);
  }
  // Catch edits made while the bundle was running, before claiming clean source.
  assert.deepEqual(assertCleanGatewaySource(), source);
  const buildMetadata = { ...metadata, ...source, nodeVersion: nodeRuntime.version, nodeArchiveSha256: nodeRuntime.sha256,
    licenseManifestSha256: hash(await readFile(join(output, 'licenses/manifest.json'))), bundledDependencyCount: licenses.packages.length,
    files: await inventoryRuntime(output) };
  await writeFile(join(output, 'build.json'), JSON.stringify(buildMetadata, null, 2) + '\n');
  console.log(`Gateway runtime: ${output}`);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await buildGatewayRuntime();
