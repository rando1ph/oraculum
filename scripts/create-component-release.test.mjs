import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createComponentRelease, parseArguments } from './create-component-release.mjs';

const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(component = 'bridge', metadataOverrides = {}, controlOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'oraculum-release-test-'));
  directories.push(root);
  await mkdir(join(root, 'docs'));
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'release.json'), JSON.stringify({ version: '0.1.2', androidVersionCode: 4, components: { bridge: { version: '0.2.0' }, desktop: { version: '0.2.0' } } }));
  await writeFile(join(root, '.gitignore'), 'dist/\n');
  await writeFile(join(root, 'docs/CHANGELOG_BRIDGE.md'), '# Bridge 0.2.0\n');
  await writeFile(join(root, 'docs/CHANGELOG_DESKTOP.md'), '# Desktop 0.2.0\n');
  await writeFile(join(root, 'scripts/bridge-update.py'), '# self-contained updater fixture\n');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '--initial-branch=main', '--quiet']);
  git(['add', '.']);
  git(['-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'test: prepare release fixture']);
  const sourceGit = git(['rev-parse', 'HEAD']);
  const packageName = component === 'bridge' ? 'oraculum-bridge' : 'oraculum';
  const stage = join(root, 'dist/stage');
  const metadataPath = component === 'bridge' ? 'usr/lib/oraculum-bridge' : 'usr/lib/oraculum/resources/desktop';
  await mkdir(join(stage, 'DEBIAN'), { recursive: true });
  await mkdir(join(stage, metadataPath), { recursive: true });
  const metadata = { component, packageName, architecture: 'amd64', version: '0.2.0', git: sourceGit, sourceDirty: false, protocolVersion: 1,
    ...(component === 'bridge' ? { stateSchemaVersion: 1, schemaMin: 0, schemaMax: 1 } : {}), ...metadataOverrides };
  await writeFile(join(stage, metadataPath, 'build.json'), JSON.stringify(metadata));
  const control = { Package: packageName, Version: '0.2.0', Architecture: 'amd64', Maintainer: 'Fixture <fixture@example.invalid>', Description: 'Disposable release validation fixture', ...controlOverrides };
  await writeFile(join(stage, 'DEBIAN/control'), Object.entries(control).map(([key, value]) => `${key}: ${value}\n`).join(''));
  const deb = join(root, 'dist/input.deb');
  execFileSync('dpkg-deb', ['--build', '--root-owner-group', stage, deb], { stdio: 'pipe' });
  return { root, deb, output: join(root, 'dist/candidate'), component, sourceGit };
}

it.each(['bridge', 'desktop'])('assembles and repeatably verifies a clean %s-only candidate using real dpkg metadata', async component => {
  const input = await fixture(component);
  const result = await createComponentRelease(input);
  const expectedDeb = component === 'bridge' ? 'oraculum-bridge_0.2.0_amd64.deb' : 'oraculum_0.2.0_amd64.deb';
  expect(result.files).toEqual(['RELEASE_NOTES.md', 'SHA256SUMS', ...(component === 'bridge' ? ['bridge-release.json', 'bridge-update.py'] : ['desktop-release.json']), expectedDeb].sort());
  expect(result.manifest.sourceGit).toBe(input.sourceGit);
  expect(result.manifest.artifacts[0].sha256).toBe(hash(await readFile(input.deb)));
  expect(execFileSync('sha256sum', ['--check', 'SHA256SUMS'], { cwd: result.directory, encoding: 'utf8' })).not.toContain('FAILED');
  expect(await createComponentRelease(input)).toEqual(result);
});

it('refuses dirty sources and preserves an existing candidate', async () => {
  const input = await fixture();
  await createComponentRelease(input);
  const previous = await readFile(join(input.output, 'SHA256SUMS'), 'utf8');
  await writeFile(join(input.root, 'uncommitted.txt'), 'pending source');
  await expect(createComponentRelease(input)).rejects.toThrow('clean committed source');
  expect(await readFile(join(input.output, 'SHA256SUMS'), 'utf8')).toBe(previous);
});

it.each([
  [{ sourceDirty: true }, {}, 'clean committed source'],
  [{ git: 'b'.repeat(40) }, {}, 'selected source commit'],
  [{ protocolVersion: 2 }, {}, 'protocol version'],
  [{}, { Version: '0.1.2' }, 'DEB Version mismatch'],
  [{}, { Package: 'other-package' }, 'DEB Package mismatch'],
])('rejects invalid DEB provenance/identity before creating output', async (metadata, control, message) => {
  const input = await fixture('bridge', metadata, control);
  await expect(createComponentRelease(input)).rejects.toThrow(message);
  expect(await readdir(join(input.root, 'dist'))).not.toContain('candidate');
});

it('does not replace a modified candidate or leave partial staging output', async () => {
  const input = await fixture();
  await createComponentRelease(input);
  await writeFile(join(input.output, 'bridge-release.json'), 'different candidate');
  await expect(createComponentRelease(input)).rejects.toThrow('different content');
  expect(await readFile(join(input.output, 'bridge-release.json'), 'utf8')).toBe('different candidate');
  expect((await readdir(join(input.root, 'dist'))).some(name => name.startsWith('.component-release-'))).toBe(false);
});

it.each([
  ['--publish'], ['--draft'], ['--component'], ['--component', 'bridge', '--component', 'desktop'], ['--output', '--deb'],
])('rejects unknown, publishing, duplicate or missing CLI arguments %j', args => {
  expect(() => parseArguments(args)).toThrow();
});
