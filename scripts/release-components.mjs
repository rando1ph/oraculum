import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const sourceRepository = 'rando1ph/oraculum';
export const components = Object.freeze({
  bridge: Object.freeze({ packageName: 'oraculum-bridge', metadata: 'usr/lib/oraculum-bridge/build.json', changelog: 'docs/CHANGELOG_BRIDGE.md' }),
  desktop: Object.freeze({ packageName: 'oraculum', metadata: 'usr/lib/oraculum/resources/desktop/build.json', changelog: 'docs/CHANGELOG_DESKTOP.md' }),
});

export function componentRelease(release, component) {
  assert.ok(Object.hasOwn(components, component), 'Select component bridge or desktop');
  const version = release.components?.[component]?.version;
  assert.match(version ?? '', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Component version must be a stable major.minor.patch version');
  const selected = components[component];
  const artifact = `${selected.packageName}_${version}_amd64.deb`;
  const debPath = join(component === 'bridge' ? 'dist/bridge' : 'dist/desktop/out/make/deb/x64', artifact);
  return { component, version, tag: `${component}-v${version}`, ...selected, debPath };
}

export function assertCleanSource(root = projectRoot) {
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(status, '', 'Release candidates require a clean committed source tree');
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(), 'main', 'Release candidates must be prepared on main');
  const git = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.match(git, /^[a-f0-9]{40}$/, 'Source commit must be a full Git SHA');
  return git;
}

export function validateBuildIdentity(metadata, selected, sourceGit) {
  assert.equal(metadata.component, selected.component, 'DEB component mismatch');
  assert.equal(metadata.packageName, selected.packageName, 'DEB build package identity mismatch');
  assert.equal(metadata.architecture, 'amd64', 'DEB build architecture mismatch');
  assert.equal(metadata.version, selected.version, 'DEB build version mismatch');
  assert.equal(metadata.git, sourceGit, 'DEB build must match the selected source commit');
  assert.equal(metadata.sourceDirty, false, 'DEB must have been built from a clean committed source tree');
  assert.equal(metadata.protocolVersion, 1, 'Unsupported Bridge protocol version');
  if (selected.component === 'bridge') {
    assert.equal(metadata.stateSchemaVersion, 1, 'Unsupported Bridge state schema');
    assert.equal(metadata.schemaMin, 0, 'Unsupported minimum Bridge state schema');
    assert.equal(metadata.schemaMax, 1, 'Unsupported maximum Bridge state schema');
  }
}

export async function inspectComponentDeb(deb, selected, sourceGit) {
  const file = resolve(deb);
  const stat = await lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'DEB must be a regular file');
  for (const [field, expected] of [['Package', selected.packageName], ['Version', selected.version], ['Architecture', 'amd64']]) {
    assert.equal(execFileSync('dpkg-deb', ['--field', file, field], { encoding: 'utf8' }).trim(), expected, `DEB ${field} mismatch`);
  }
  // Extraction is only to a disposable directory; no package installation or
  // maintainer script execution occurs during release preparation.
  const extraction = await mkdtemp(join(tmpdir(), 'oraculum-release-inspect-'));
  let build;
  try {
    execFileSync('dpkg-deb', ['--extract', file, extraction], { stdio: 'pipe' });
    const metadata = join(extraction, selected.metadata);
    assert.ok(!relative(extraction, await realpath(metadata)).startsWith('..'), 'Embedded build identity must remain inside the DEB');
    assert.ok((await lstat(metadata)).isFile(), 'Embedded build identity must be a regular file');
    build = JSON.parse(await readFile(metadata, 'utf8'));
    validateBuildIdentity(build, selected, sourceGit);
  } finally { await rm(extraction, { recursive: true, force: true }); }
  const sha256 = createHash('sha256').update(await readFile(file)).digest('hex');
  return { file, build, artifact: { name: `${selected.packageName}_${selected.version}_amd64.deb`, architecture: 'amd64', sha256, size: stat.size } };
}

export function releaseManifest(selected, sourceGit, artifact) {
  return {
    format: 1, component: selected.component, version: selected.version, tag: selected.tag,
    sourceRepository, sourceGit, protocolVersion: 1,
    ...(selected.component === 'bridge' ? { stateSchemaVersion: 1 } : {}),
    artifacts: [artifact],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, component, ...extra] = process.argv.slice(2);
    assert.equal(extra.length, 0, 'Usage: node scripts/release-components.mjs check-source | info|deb-path bridge|desktop');
    if (command === 'check-source') {
      assert.equal(component, undefined, 'check-source accepts no arguments');
      console.log(assertCleanSource());
    } else {
      assert.ok(['info', 'deb-path'].includes(command), 'Usage: node scripts/release-components.mjs check-source | info|deb-path bridge|desktop');
      const selected = componentRelease(JSON.parse(await readFile(join(projectRoot, 'release.json'), 'utf8')), component);
      console.log(command === 'deb-path' ? selected.debPath : JSON.stringify(selected, null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
