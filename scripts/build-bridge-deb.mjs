// Assemble a package from the audited, self-contained Bridge runtime. Installing
// this DEB changes program files only: there are no maintainer scripts, service
// activation, configuration defaults, or state/database paths in its payload.
import { chmod, cp, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
const version = release.components.bridge.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid independent Bridge version');
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This release target is Linux amd64');
process.umask(0o022);
const runtime = join(root, 'dist/runtime');
const build = JSON.parse(await readFile(join(runtime, 'build.json'), 'utf8'));
if (build.component !== 'bridge' || build.version !== version || build.architecture !== 'amd64') {
  throw new Error('Bridge runtime is stale or belongs to another component; run build:runtime first');
}
const output = join(root, 'dist/bridge');
const stage = join(root, 'dist/bridge-deb');
const installation = join(stage, 'usr/lib/oraculum-bridge');
await rm(stage, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(installation, { recursive: true });
await cp(runtime, installation, { recursive: true, verbatimSymlinks: true });
await mkdir(join(stage, 'usr/bin'), { recursive: true });
// Relative links also work during disposable rootfs validation. The shell
// launcher resolves this link before locating its private Node runtime.
await symlink('../lib/oraculum-bridge/bin/oraculum-bridge', join(stage, 'usr/bin/oraculum-bridge'));
await mkdir(join(stage, 'usr/lib/systemd/user'), { recursive: true });
await cp(join(root, 'packaging/oraculum-bridge.service'), join(stage, 'usr/lib/systemd/user/oraculum-bridge.service'));
await mkdir(join(stage, 'DEBIAN'), { recursive: true });
const size = execFileSync('du', ['-sk', join(stage, 'usr')], { encoding: 'utf8' }).split(/\s/)[0];
await writeFile(join(stage, 'DEBIAN/control'), `Package: oraculum-bridge\nVersion: ${version}\nSection: utils\nPriority: optional\nArchitecture: amd64\nMaintainer: Oraculum\nInstalled-Size: ${size}\nDepends: libc6 (>= 2.31), libgcc-s1, libstdc++6 (>= 8)\nHomepage: https://github.com/rando1ph/oraculum\nDescription: Private Bridge for the official Codex Harness\n Self-contained Node 24, Bridge, authenticated Web UI and trusted CSS themes.\n Codex CLI is provided by the user. Configuration and state stay outside this\n package. Installation never registers, enables, starts or restarts a service.\n`);
async function normalizePermissions(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return;
  await chmod(path, stat.isDirectory() ? 0o755 : stat.mode & 0o755);
  if (stat.isDirectory()) for (const name of await readdir(path)) await normalizePermissions(join(path, name));
}
await normalizePermissions(stage);
const artifact = join(output, `oraculum-bridge_${version}_amd64.deb`);
execFileSync('dpkg-deb', ['--build', '--root-owner-group', '-Zxz', stage, artifact], { stdio: 'inherit' });
console.log(`Bridge DEB: ${artifact}`);
