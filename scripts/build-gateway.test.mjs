import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { assertCleanGatewaySource, assertGatewayReleaseMetadata, hash, inventoryRuntime, root, untrackedDesignInput } from './build-gateway-runtime.mjs';

test('Gateway release contract accepts Debian Beta ordering and rejects inconsistent release metadata', () => {
  const beta = { component: 'gateway', packageName: 'oraculum-gateway', architecture: 'amd64',
    version: '2.0.0~beta.1', candidate: false, releaseChannel: 'beta' };
  assertGatewayReleaseMetadata(beta);
  assertGatewayReleaseMetadata({ ...beta, version: '2.0.0', candidate: true, releaseChannel: undefined });
  execFileSync('dpkg', ['--compare-versions', beta.version, 'lt', '2.0.0']);
  for (const change of [{ version: '2.0.0-beta.1' }, { version: '2.0.0~beta.0' },
    { version: '2.0.0\nInjected: value' }, { version: '2.0.0~beta.1\n' }, { candidate: true }, { candidate: 'false' },
    { releaseChannel: undefined }, { releaseChannel: 'stable' }, { architecture: 'arm64' }]) {
    assert.throws(() => assertGatewayReleaseMetadata({ ...beta, ...change }));
  }
});

test('candidate source gate ignores only untracked design originals and rejects tracked or other new source changes', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'gateway-source-test-'));
  const git = args => execFileSync('git', args, { cwd: scratch, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['init', '--initial-branch=main']);
    await writeFile(join(scratch, 'source.ts'), 'export const value = 1;\n');
    git(['add', 'source.ts']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'test: source fixture']);
    const committed = assertCleanGatewaySource(scratch);
    assert.equal(committed.sourceDirty, false);
    await mkdir(join(scratch, untrackedDesignInput), { recursive: true });
    await writeFile(join(scratch, untrackedDesignInput, 'original.html'), '<p>unchanged design input</p>');
    assert.deepEqual(assertCleanGatewaySource(scratch), committed);
    await writeFile(join(scratch, 'not-committed.ts'), 'new source');
    assert.throws(() => assertCleanGatewaySource(scratch), /all source files committed/);
    await rm(join(scratch, 'not-committed.ts'));
    await writeFile(join(scratch, 'source.ts'), 'changed');
    assert.throws(() => assertCleanGatewaySource(scratch), /tracked source changes committed/);
    git(['add', 'source.ts']);
    assert.throws(() => assertCleanGatewaySource(scratch), /tracked source changes committed/);
    git(['restore', '--source=HEAD', '--staged', '--worktree', 'source.ts']);
    git(['add', join(untrackedDesignInput, 'original.html')]);
    assert.throws(() => assertCleanGatewaySource(scratch), /tracked source changes committed/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('payload inventory detects replaced bytes, injected files and forbidden links', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'gateway-payload-test-'));
  try {
    await mkdir(join(scratch, 'bin'));
    await writeFile(join(scratch, 'bin/entry'), 'first');
    await writeFile(join(scratch, 'build.json'), '{}');
    const inventory = await inventoryRuntime(scratch);
    assert.deepEqual(inventory, [{ path: 'bin/entry', size: 5, sha256: hash('first') }]);
    await writeFile(join(scratch, 'bin/entry'), 'second');
    assert.notDeepEqual(await inventoryRuntime(scratch), inventory);
    await writeFile(join(scratch, 'injected'), 'unknown');
    assert.equal((await inventoryRuntime(scratch)).length, 2);
    await symlink('/etc/passwd', join(scratch, 'link'));
    await assert.rejects(inventoryRuntime(scratch), /Unexpected runtime symlink/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('preinst respects disposable dpkg root and refuses legacy or unmanaged CLI without changing files', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'gateway-preinst-test-'));
  try {
    const packageRoot = join(scratch, 'root');
    const admin = join(packageRoot, 'var/lib/dpkg');
    await mkdir(join(admin, 'info'), { recursive: true });
    await mkdir(join(packageRoot, 'usr/bin'), { recursive: true });
    await writeFile(join(admin, 'status'), '');
    const preinst = join(root, 'packaging/gateway/preinst');
    const run = () => spawnSync('/bin/sh', [preinst, 'install'], { env: { PATH: '/usr/bin:/bin', DPKG_ROOT: packageRoot, DPKG_ADMINDIR: admin }, encoding: 'utf8' });
    assert.equal(run().status, 0);
    const cli = join(packageRoot, 'usr/bin/oraculum');
    await writeFile(cli, 'preserve legacy executable');
    let result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /unmanaged/);
    await writeFile(join(admin, 'status'), 'Package: oraculum\nStatus: install ok installed\nArchitecture: amd64\nVersion: 0.1.2\nDescription: legacy fixture\n\n');
    await writeFile(join(admin, 'info/oraculum.list'), '/usr/bin/oraculum\n');
    result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /owned by another package/);
    assert.equal(await readFile(cli, 'utf8'), 'preserve legacy executable');
    await writeFile(join(admin, 'status'), 'Package: oraculum-gateway\nStatus: install ok installed\nArchitecture: amd64\nVersion: 2.0.0\nDescription: gateway fixture\n\n');
    await rm(join(admin, 'info/oraculum.list'));
    await writeFile(join(admin, 'info/oraculum-gateway.list'), '/usr/bin/oraculum\n');
    assert.equal(run().status, 0, 'An existing Gateway may be upgraded');
    assert.equal(await readFile(cli, 'utf8'), 'preserve legacy executable');
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('candidate installers have only a read-only preflight and an inert user unit', async () => {
  const preinst = await readFile(join(root, 'packaging/gateway/preinst'), 'utf8');
  assert.doesNotMatch(preinst, /\b(?:systemctl|loginctl|ssh|curl|wget|apt|useradd|groupadd|rm|mv|cp|chmod|chown)\b/);
  assert.doesNotMatch(preinst, /force-overwrite|force-remove|dpkg\s+--(?:remove|purge)/);
  const unit = await readFile(join(root, 'packaging/gateway/oraculum-gateway.service'), 'utf8');
  assert.match(unit, /^ExecStart=\/usr\/lib\/oraculum-gateway\/bin\/oraculum-gateway$/m);
  // A fresh direct-network installation must not require this private file. Hosts
  // needing a proxy can supply it without editing the packaged unit or JSON schema.
  assert.deepEqual(unit.match(/^EnvironmentFile=.*$/gm), ['EnvironmentFile=-%E/oraculum-gateway/network.env']);
  assert.doesNotMatch(unit, /^Environment=.*(?:https?_proxy|all_proxy|no_proxy)=/im);
  for (const expected of ['UMask=0077', 'Restart=on-failure', 'KillMode=control-group']) assert.ok(unit.includes(expected));
  assert.doesNotMatch(unit, /^Exec(?:StartPre|StartPost|StopPost)=/m);
});
