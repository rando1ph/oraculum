import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectWebLicenses } from './collect-web-licenses.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist/runtime');
const cache = join(root, '.local/build-cache');
const nodeVersion = '24.21.0';
const archive = `node-v${nodeVersion}-linux-x64.tar.xz`;
const sha256 = 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6';
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This release target is Linux amd64');
await mkdir(cache, { recursive: true });
const download = join(cache, archive);
try { await readFile(download); } catch {
  execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--output', `${download}.tmp`, `https://nodejs.org/dist/v${nodeVersion}/${archive}`], { stdio: 'inherit' });
  await cp(`${download}.tmp`, download); await rm(`${download}.tmp`);
}
if (createHash('sha256').update(await readFile(download)).digest('hex') !== sha256) throw new Error('Private Node archive checksum mismatch');
await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'node'), { recursive: true });
execFileSync('tar', ['-xJf', download, '--strip-components=1', '-C', join(output, 'node')]);
// Runtime-only: no npm/Corepack, headers or build toolchain shipped with the app.
await rm(join(output, 'node/lib'), { recursive: true, force: true });
await rm(join(output, 'node/include'), { recursive: true, force: true });
await rm(join(output, 'node/share'), { recursive: true, force: true });
for (const entry of await readdir(join(output, 'node/bin'))) if (entry !== 'node') await rm(join(output, 'node/bin', entry));
await build({ entryPoints: { main: 'bridge/src/main.ts', trust: 'bridge/src/trust.ts' }, absWorkingDir: root,
  outdir: join(output, 'bridge'), outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node',
  target: 'node24', format: 'esm', packages: 'external', sourcemap: false });
const deps = join(root, 'dist/bridge-deps');
await rm(deps, { recursive: true, force: true });
execFileSync('pnpm', ['--filter', '@oraculum/bridge', 'deploy', '--prod', '--legacy', deps], { cwd: root, stdio: 'inherit' });
await cp(join(deps, 'node_modules'), join(output, 'node_modules'), { recursive: true, verbatimSymlinks: true });
await rm(deps, { recursive: true });
// pnpm deploy adds a workspace self-reference to its staging root. Our own code
// is compiled above, never imported by package name; omit that dangling alias.
await rm(join(output, 'node_modules/.pnpm/node_modules/@oraculum/bridge'));
for (const file of ['.modules.yaml', '.pnpm-workspace-state-v1.json']) await rm(join(output, 'node_modules', file), { force: true });
for (const item of ['apps/web/dist', 'themes']) await cp(join(root, item), join(output, item), { recursive: true });
await collectWebLicenses(join(output, 'licenses/web'));
await cp(join(root, 'packaging/licenses'), join(output, 'licenses/bridge'), { recursive: true });
await mkdir(join(output, 'apps/desktop'), { recursive: true });
for (const file of ['splash.html', 'splash.css', 'splash.js']) await cp(join(root, 'apps/desktop', file), join(output, 'apps/desktop', file));
await mkdir(join(output, 'design/reference'), { recursive: true });
for (const name of ['01_Brand_OracleEye_Full_Logo.png', '02_Brand_OracleEye_App_Icon.png', '03_Brand_OracleEye_Simplified_Icon.png']) {
  await cp(join(root, 'design/reference', name), join(output, 'design/reference', name));
}
for (const file of ['runtime-config.cjs', 'launch-bridge.cjs', 'oraculum-bridge.service']) await cp(join(root, 'packaging', file), join(output, file));
await mkdir(join(output, 'bin'), { recursive: true });
await cp(join(root, 'packaging/oraculum-bridge'), join(output, 'bin/oraculum-bridge'));
await chmod(join(output, 'bin/oraculum-bridge'), 0o755);
await cp(join(root, 'protocol.lock.json'), join(output, 'protocol.lock.json'));
// Check every symlink: pnpm's production tree must be self-contained.
async function audit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = relative(output, await realpath(file));
      if (target.startsWith('..') || resolve(output, target) === output) throw new Error(`Escaping package link: ${relative(output, file)}`);
    } else if (entry.isDirectory()) await audit(file);
  }
}
await audit(output);
await writeFile(join(output, 'build.json'), JSON.stringify({ nodeVersion, nodeArchiveSha256: sha256,
  git: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() }, null, 2) + '\n');
console.log(`Standalone runtime: ${output}`);
