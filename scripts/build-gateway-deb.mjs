// Candidate assembly only. This script never installs the package or touches
// systemd, production configuration, or an existing application's state.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertCleanGatewaySource, hash, inventoryRuntime, root } from './build-gateway-runtime.mjs';

process.umask(0o022);
const source = assertCleanGatewaySource();
const selected = JSON.parse(await readFile(join(root, 'packaging/gateway/metadata.json'), 'utf8'));
assert.equal(selected.component, 'gateway'); assert.equal(selected.packageName, 'oraculum-gateway');
assert.equal(selected.architecture, 'amd64'); assert.match(selected.version, /^\d+\.\d+\.\d+$/);
const runtime = join(root, 'dist/gateway-runtime');
const metadata = JSON.parse(await readFile(join(runtime, 'build.json'), 'utf8'));
for (const [key, value] of Object.entries({ ...selected, ...source })) assert.deepEqual(metadata[key], value, `Stale Gateway runtime ${key}; rebuild the committed source`);
assert.deepEqual(await inventoryRuntime(runtime), metadata.files, 'Gateway runtime files no longer match the recorded bundle');
const output = join(root, 'dist/gateway', source.sourceGit);
await mkdir(join(root, 'dist'), { recursive: true });
try { await lstat(output); assert.fail(`Candidate already exists: ${output}; preserve existing artifacts`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const stage = await mkdtemp(join(root, 'dist/gateway-stage-'));
try {
  const installation = join(stage, 'usr/lib/oraculum-gateway');
  await mkdir(installation, { recursive: true });
  await cp(runtime, installation, { recursive: true });
  await mkdir(join(stage, 'usr/bin'), { recursive: true });
  await symlink('../lib/oraculum-gateway/bin/oraculum', join(stage, 'usr/bin/oraculum'));
  await mkdir(join(stage, 'usr/lib/systemd/user'), { recursive: true });
  await cp(join(root, 'packaging/gateway/oraculum-gateway.service'), join(stage, 'usr/lib/systemd/user/oraculum-gateway.service'));
  await mkdir(join(stage, 'DEBIAN'));
  await cp(join(root, 'packaging/gateway/preinst'), join(stage, 'DEBIAN/preinst'));
  await chmod(join(stage, 'DEBIAN/preinst'), 0o755);
  const size = execFileSync('du', ['-sk', join(stage, 'usr')], { encoding: 'utf8' }).split(/\s/)[0];
  await writeFile(join(stage, 'DEBIAN/control'), `Package: oraculum-gateway\nVersion: ${selected.version}\nSection: utils\nPriority: optional\nArchitecture: amd64\nMaintainer: Oraculum\nInstalled-Size: ${size}\nDepends: libc6 (>= 2.31), libgcc-s1, libstdc++6 (>= 8), util-linux\nHomepage: https://github.com/rando1ph/oraculum\nDescription: Independent Gateway for the official Codex App Server\n Self-contained Node 24, authenticated HTTP/WSS, host files and oraculum CLI.\n No client UI or themes. Codex CLI is supplied by the user. Configuration and\n state are initialized separately. Installing never enables or starts services.\n`);
  async function permissions(path) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return;
    await chmod(path, stat.isDirectory() ? 0o755 : stat.mode & 0o755);
    if (stat.isDirectory()) for (const name of await readdir(path)) await permissions(join(path, name));
  }
  await permissions(stage);
  assert.deepEqual(assertCleanGatewaySource(), source);
  const candidate = join(stage, 'candidate'); await mkdir(candidate);
  const artifactName = `oraculum-gateway_${selected.version}_amd64.deb`;
  const artifact = join(candidate, artifactName);
  // The candidate must be outside the payload tree being archived.
  const payload = join(stage, 'payload'); await mkdir(payload);
  await rename(join(stage, 'usr'), join(payload, 'usr'));
  await rename(join(stage, 'DEBIAN'), join(payload, 'DEBIAN'));
  execFileSync('dpkg-deb', ['--build', '--root-owner-group', '-Zxz', payload, artifact], { stdio: 'inherit' });
  const bytes = await readFile(artifact);
  const manifest = { format: 1, ...selected, ...source, sourceRepository: 'https://github.com/rando1ph/oraculum',
    licenseManifestSha256: metadata.licenseManifestSha256, nodeVersion: metadata.nodeVersion,
    artifacts: [{ name: artifactName, architecture: selected.architecture, size: bytes.length, sha256: hash(bytes) }] };
  await writeFile(join(candidate, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  assert.deepEqual(assertCleanGatewaySource(), source);
  await mkdir(join(root, 'dist/gateway'), { recursive: true });
  // Refuse races with another build; rename alone can replace an empty dir.
  try { await lstat(output); assert.fail(`Candidate already exists: ${output}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rename(candidate, output);
  console.log(`Gateway candidate: ${join(output, artifactName)}`);
} finally { await rm(stage, { recursive: true, force: true }); }
