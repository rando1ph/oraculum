// Functional contracts with real release Electron/Web/themes. The Bridge uses
// controlled native fixtures; standalone compiled Bridge is verified separately.
// Never install, change host ownership, disable sandboxing or start a user unit.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [input, flag, helperInput] = process.argv.slice(2);
assert.ok(input && flag === '--sandbox-helper' && helperInput && process.argv.length === 5,
  'Usage: package-ui-contract.mjs DEB --sandbox-helper ROOT_OWNED_IDENTICAL_HELPER');
const artifact = resolve(input), helper = resolve(helperInput);
const scratch = await mkdtemp(join(tmpdir(), 'oraculum-release-ui-'));
await mkdir(resolve('.local/evidence/r1-b8'), { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/r1-b8/package-ui-'));
const report = { artifact, installed: false, realReleaseElectron: true, realReleaseWeb: true,
  realReleaseThemes: true, simulatedNative: true, compiledBridge: false, physicalAndroid: false,
  chromiumSandboxRequested: true, osSandboxKernelEvidence: 'Run package-sandbox-check.mjs separately', suites: [] };
try {
  report.sha256 = createHash('sha256').update(await readFile(artifact)).digest('hex');
  execFileSync('dpkg-deb', ['--extract', artifact, scratch], { timeout: 120_000 });
  const installation = join(scratch, 'usr/lib/oraculum');
  await mkdir(join(installation, 'test-home'), { mode: 0o700 });
  report.build = JSON.parse(await readFile(join(installation, 'resources/runtime/build.json'), 'utf8'));
  const packagedHelper = join(installation, 'chrome-sandbox'), stat = await lstat(helper);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.uid, 0); assert.equal(stat.gid, 0); assert.equal(stat.mode & 0o7777, 0o4755);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  report.helperSha256 = hash(await readFile(packagedHelper));
  assert.equal(hash(await readFile(helper)), report.helperSha256, 'Installed helper differs from this DEB');
  await rm(packagedHelper); await symlink(helper, packagedHelper);
  // These three contracts use real device pairing; the packaged shell correctly
  // refuses the unauthenticated local-test mode used by some source-only suites.
  for (const suite of ['attachments', 'artifacts', 'extensions']) {
    const started = Date.now(), log = join(output, suite + '.log');
    const child = spawn('pnpm', [`test:${suite}:ui`], { env: { ...process.env,
      ORACULUM_TEST_DESKTOP_DIR: installation, ORACULUM_MANAGE_SERVICE: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const stream = createWriteStream(log); child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
    const [code, signal] = await once(child, 'close'); stream.end(); await once(stream, 'finish');
    report.suites.push({ suite, code, signal, seconds: (Date.now() - started) / 1000, log });
    assert.equal(code, 0, `Packaged ${suite} contract failed; see ${log}`);
    console.log('PASS packaged Electron/Web/themes: ' + suite);
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error); process.exitCode = 1;
  console.error(report.error);
} finally {
  await rm(scratch, { recursive: true, force: true });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, output }));
}
