import { expect, it } from 'vitest';
import { componentRelease, releaseManifest, validateBuildIdentity } from './release-components.mjs';

const release = { version: '0.1.2', androidVersionCode: 4, components: { bridge: { version: '0.2.0' }, desktop: { version: '0.2.0' } } };
const sourceGit = 'a'.repeat(40);
const build = { component: 'bridge', packageName: 'oraculum-bridge', architecture: 'amd64', version: '0.2.0', git: sourceGit,
  sourceDirty: false, protocolVersion: 1, stateSchemaVersion: 1, schemaMin: 0, schemaMax: 1 };

it('allows independent component versions without changing the historical Android identity', () => {
  const changed = structuredClone(release);
  changed.components.bridge.version = '0.2.1';
  expect(componentRelease(changed, 'bridge').tag).toBe('bridge-v0.2.1');
  expect(componentRelease(changed, 'desktop').tag).toBe('desktop-v0.2.0');
  expect([changed.version, changed.androidVersionCode]).toEqual(['0.1.2', 4]);
});

it.each(['android', '__proto__', undefined])('rejects unsupported component %s', component => {
  expect(() => componentRelease(release, component)).toThrow('Select component');
});

it.each(['../0.2.0', '0.2.0;echo unsafe', '01.2.0', '0.2.0-rc.1', '0.2'])('rejects unsafe or ambiguous Debian release version %s', version => {
  expect(() => componentRelease({ components: { bridge: { version } } }, 'bridge')).toThrow('stable major.minor.patch');
});

it.each([
  ['component', 'desktop'], ['packageName', 'oraculum'], ['architecture', 'arm64'], ['version', '0.1.2'],
  ['git', 'b'.repeat(40)], ['sourceDirty', true], ['sourceDirty', undefined], ['protocolVersion', 2],
  ['stateSchemaVersion', 2], ['schemaMin', 1], ['schemaMax', 2],
])('rejects incompatible or unverified %s build metadata', (key, value) => {
  expect(() => validateBuildIdentity({ ...build, [key]: value }, componentRelease(release, 'bridge'), sourceGit)).toThrow();
});

it('produces component-specific manifests without coupling Desktop to Bridge state schema', () => {
  const artifact = { name: 'oraculum-bridge_0.2.0_amd64.deb', architecture: 'amd64', sha256: 'b'.repeat(64), size: 123 };
  const bridge = releaseManifest(componentRelease(release, 'bridge'), sourceGit, artifact);
  expect(bridge).toMatchObject({ format: 1, component: 'bridge', tag: 'bridge-v0.2.0', sourceRepository: 'rando1ph/oraculum', sourceGit, protocolVersion: 1, stateSchemaVersion: 1, artifacts: [artifact] });
  const desktop = releaseManifest(componentRelease(release, 'desktop'), sourceGit, { ...artifact, name: 'oraculum_0.2.0_amd64.deb' });
  expect(desktop.tag).toBe('desktop-v0.2.0');
  expect(desktop).not.toHaveProperty('stateSchemaVersion');
});
