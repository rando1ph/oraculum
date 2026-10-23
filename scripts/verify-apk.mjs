// Inspect a built APK without installing it or accessing an Android device/key.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
let unsigned = false, expectedCertificate = process.env.ORACULUM_RELEASE_CERT_SHA256, selected;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--unsigned') unsigned = true;
  else if (args[index] === '--expected-cert') expectedCertificate = args[++index];
  else if (!args[index].startsWith('-') && !selected) selected = args[index];
  else throw new Error('Usage: verify-apk.mjs [APK] [--unsigned | --expected-cert SHA256]');
}
const release = JSON.parse(await readFile(join(project, 'release.json'), 'utf8'));
const artifact = resolve(selected ?? join(project, `apps/android/app/build/outputs/apk/release/app-release${unsigned ? '-unsigned' : ''}.apk`));
const tools = process.env.ORACULUM_TOOLS || join(homedir(), '.local/share/oraculum-tools');
const buildTools = join(tools, 'android-sdk/build-tools/35.0.0');
const env = { ...process.env, JAVA_HOME: join(tools, 'jdk-21'), PATH: `${join(tools, 'jdk-21/bin')}:${process.env.PATH || '/usr/bin:/bin'}` };
delete env.ORACULUM_RELEASE_STORE_PASSWORD; delete env.ORACULUM_RELEASE_KEY_PASSWORD;
const run = (file, params, encoding = 'utf8') => execFileSync(file, params, { env, encoding, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { artifact, date: new Date().toISOString(), kind: unsigned ? 'unsigned-preflight-not-for-installation' : 'signed-release', installed: false,
  androidDeviceVerified: false, checks: [] };
const outputDirectory = join(project, '.local/evidence/phase4b/android');
const evidence = join(outputDirectory, `${basename(artifact)}.json`);
const pass = check => { report.checks.push(check); console.log(`PASS ${check}`); };
try {
  if (!unsigned) assert.match(expectedCertificate?.replaceAll(':', '') ?? '', /^[a-f0-9]{64}$/i, 'Signed Release requires the expected public certificate SHA-256');
  report.sha256 = hash(await readFile(artifact));
  const entries = run('unzip', ['-Z1', artifact]).trim().split('\n');
  assert.ok(entries.includes('assets/oraculum-build.json'), 'Missing embedded source/build identity');
  report.build = JSON.parse(run('unzip', ['-p', artifact, 'assets/oraculum-build.json']));
  assert.equal(report.build.format, 1); assert.match(report.build.sourceGit, /^[a-f0-9]{40}$/);
  assert.equal(typeof report.build.sourceDirty, 'boolean');
  assert.equal(report.build.version, release.version); assert.equal(report.build.versionCode, release.androidVersionCode);
  if (!unsigned) assert.equal(report.build.sourceDirty, false, 'Signed release must be built from a clean source tree');
  report.verificationGit = run('git', ['-C', project, 'rev-parse', 'HEAD']).trim();
  const noticesRoot = 'assets/third-party/';
  const notices = JSON.parse(run('unzip', ['-p', artifact, `${noticesRoot}manifest.json`]));
  const runtime = JSON.parse(run('unzip', ['-p', artifact, `${noticesRoot}runtime-components.json`]));
  assert.equal(notices.format, 1); assert.equal(runtime.format, 1);
  assert.equal(notices.scope, 'releaseRuntimeClasspath'); assert.equal(runtime.scope, notices.scope);
  assert.ok(Array.isArray(notices.packages) && notices.packages.length > 0, 'Empty Android license inventory');
  const coordinates = notices.packages.map(entry => entry.coordinate).sort();
  assert.equal(new Set(coordinates).size, coordinates.length, 'Duplicate license inventory component');
  assert.deepEqual(coordinates, runtime.components, 'Notices must cover every resolved runtime component');
  const noticeFiles = new Set();
  for (const entry of notices.packages) {
    assert.match(entry.coordinate, /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/);
    assert.ok(entry.license && entry.attribution && entry.licenseEvidence.startsWith('https://'));
    assert.ok(Array.isArray(entry.notices) && entry.notices.length > 0, `Missing license for ${entry.coordinate}`);
    for (const notice of entry.notices) {
      assert.match(notice.path, /^[A-Za-z0-9_.-]+$/); assert.match(notice.sha256, /^[a-f0-9]{64}$/);
      assert.ok(notice.source.startsWith('https://'), 'Missing upstream notice provenance');
      const path = `${noticesRoot}${notice.path}`;
      assert.ok(entries.includes(path), `Missing bundled notice ${path}`);
      assert.equal(hash(run('unzip', ['-p', artifact, path], null)), notice.sha256, `Notice hash mismatch ${path}`);
      noticeFiles.add(path);
    }
  }
  report.thirdPartyNotices = { components: coordinates, files: [...noticeFiles].sort() };
  pass('Bundled original third-party license/notice hashes and complete resolved runtime dependency coverage');
  const aaptVersion = spawnSync(join(buildTools, 'aapt2'), ['version'], { env, encoding: 'utf8' });
  assert.equal(aaptVersion.status, 0, 'Unable to read aapt2 version');
  report.tools = { java: run(join(tools, 'jdk-21/bin/java'), ['--version']).split('\n')[0], buildTools: '35.0.0',
    apksigner: run(join(buildTools, 'apksigner'), ['version']).trim(), aapt2: `${aaptVersion.stdout}${aaptVersion.stderr}`.trim() };
  const badging = run(join(buildTools, 'aapt2'), ['dump', 'badging', artifact]);
  const identity = /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m.exec(badging);
  assert.ok(identity, 'Missing APK identity');
  assert.equal(identity[1], 'dev.oraculum.poc'); assert.equal(identity[2], String(release.androidVersionCode)); assert.equal(identity[3], release.version);
  assert.match(badging, /^application-label:'神谕'$/m);
  assert.doesNotMatch(badging, /^application-debuggable$/m);
  assert.match(badging, /^minSdkVersion:'26'$/m); assert.match(badging, /^targetSdkVersion:'35'$/m);
  report.applicationId = identity[1]; report.versionCode = Number(identity[2]); report.versionName = identity[3]; report.label = '神谕';
  const manifest = run(join(buildTools, 'aapt2'), ['dump', 'xmltree', '--file', 'AndroidManifest.xml', artifact]);
  assert.doesNotMatch(manifest, /:debuggable\([^)]*\)=true/);
  for (const flag of ['allowBackup', 'fullBackupContent', 'usesCleartextTraffic']) assert.match(manifest, new RegExp(`:${flag}\\([^)]*\\)=false`));
  assert.match(manifest, /:networkSecurityConfig\([^)]*\)=@/); assert.match(manifest, /:dataExtractionRules\([^)]*\)=@/);
  const resources = run(join(buildTools, 'aapt2'), ['dump', 'resources', artifact]);
  const resourceLines = resources.split('\n');
  const resourceFile = name => {
    const start = resourceLines.findIndex(line => /^\s*resource 0x[a-f0-9]+ /.test(line) && line.trim().split(/\s+/)[2] === name);
    assert.ok(start >= 0, `Missing Android resource ${name}`);
    let end = start + 1;
    while (end < resourceLines.length && !/^\s*(?:resource 0x|type )/.test(resourceLines[end])) end++;
    const files = [...resourceLines.slice(start + 1, end).join('\n').matchAll(/\(file\) (res\/\S+) type=/g)].map(match => match[1]);
    assert.equal(files.length, 1, `Missing or ambiguous packaged resource ${name}`);
    assert.ok(entries.includes(files[0]), `Missing resource payload ${name}`);
    return files[0];
  };
  const network = run(join(buildTools, 'aapt2'), ['dump', 'xmltree', '--file', resourceFile('xml/network_security_config'), artifact]);
  assert.match(network, /cleartextTrafficPermitted=false/);
  const backup = run(join(buildTools, 'aapt2'), ['dump', 'xmltree', '--file', resourceFile('xml/data_extraction_rules'), artifact]);
  assert.match(backup, /E: cloud-backup/);
  const backupSections = backup.split(/E: device-transfer/);
  assert.equal(backupSections.length, 2, 'Missing device-transfer exclusions');
  for (const section of backupSections) {
    for (const domain of ['root', 'file', 'database', 'sharedpref', 'external', 'device_root']) {
      assert.ok(section.includes(`domain="${domain}"`), `Missing backup exclusion ${domain}`);
    }
    assert.equal((section.match(/path="\."/g) ?? []).length, 6, 'Backup domains must be fully excluded');
  }
  pass('Release identity, version, Chinese label, non-debuggable, backup disabled and cleartext denied');
  for (const text of ['ORACULUM', '意志为谕，万象将启。', 'LET THE UNWRITTEN UNFOLD.']) assert.ok(resources.includes(text), 'Missing packaged brand declaration');
  report.brandAssets = [];
  for (const [name, original] of [['oracle_eye', '02_Brand_OracleEye_App_Icon.png'], ['oracle_eye_mark', '03_Brand_OracleEye_Simplified_Icon.png']]) {
    const path = resourceFile(`drawable/${name}`);
    const bytes = run('unzip', ['-p', artifact, path], null);
    assert.equal(hash(bytes), hash(await readFile(join(project, 'design/reference', original))), 'Brand PNG must match its approved original bytes');
    report.brandAssets.push({ path, sha256: hash(bytes) });
  }
  resourceFile('drawable/brand_launch_background');
  assert.ok(!entries.some(entry => /\.(?:jks|keystore|pem|key)$/i.test(entry)), 'Unexpected signing material in APK');
  run(join(buildTools, 'zipalign'), ['-c', '-P', '16', '4', artifact]);
  pass('Bundled native launch/declarations, byte-exact approved Oracle Eye/icon resources and APK alignment');
  const verified = spawnSync(join(buildTools, 'apksigner'), ['verify', '--verbose', '--print-certs', artifact], {
    env, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
  if (verified.error) throw verified.error;
  const verification = `${verified.stdout}\n${verified.stderr}`;
  if (unsigned) {
    assert.notEqual(verified.status, 0, 'Unsigned preflight unexpectedly contains a signature');
    assert.match(verification, /Missing META-INF\/MANIFEST\.MF|No signatures|No APK Signature Scheme/);
    report.signature = { status: 'absent-as-required-for-unsigned-preflight' };
    pass('Explicit unsigned preflight: signature absent; not a release APK or installation deliverable');
  } else {
    assert.equal(verified.status, 0, 'apksigner rejected the signed Release APK');
    assert.doesNotMatch(verification, /^Signer #\d+ certificate DN:.*CN=Android Debug/im, 'Debug certificates cannot qualify as a signed Release');
    const certificates = [...verification.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-f0-9]+)$/gmi)].map(match => match[1].toLowerCase());
    assert.equal(certificates.length, 1, 'Expected exactly one Release signing certificate');
    assert.equal(certificates[0], expectedCertificate.replaceAll(':', '').toLowerCase(), 'Release signing certificate changed');
    assert.match(verification, /Verified using v[23](?:\.\d+)? scheme[^\n]*: true/);
    report.signature = { status: 'verified', certificateSha256: certificates[0],
      schemes: verification.split('\n').filter(line => /^Verified using v\d/.test(line)) };
    pass('apksigner verification and expected long-term Release certificate SHA-256');
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
  console.error(`FAIL ${report.error}`);
} finally {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(evidence, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, kind: report.kind, artifact, sha256: report.sha256, certificateSha256: report.signature?.certificateSha256, evidence }));
}
