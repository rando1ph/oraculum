// Candidate inspection plus real dpkg in a disposable root protected by a
// read-only host mount. No host package/service/configuration is installed.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer as createPortProbe } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hash, inventoryRuntime, root, untrackedDesignInput } from './build-gateway-runtime.mjs';

const [input, expectedGit] = process.argv.slice(2);
assert.ok(input && process.argv.length <= 4, 'Usage: node scripts/verify-gateway-deb.mjs DEB [EXPECTED_GIT]');
if (expectedGit) assert.match(expectedGit, /^[a-f0-9]{40}$/);
const artifact = resolve(input);
const scratch = await mkdtemp(join(tmpdir(), 'oraculum-gateway-package-'));
const outputParent = join(root, '.local/evidence/phase1/gateway-package');
await mkdir(outputParent, { recursive: true });
const evidence = await mkdtemp(join(outputParent, 'verification-'));
const report = { date: new Date().toISOString(), artifact: basename(artifact), checks: [],
  isolation: { hostPackagesChanged: false, hostServicesChanged: false, productionStateRead: false,
    realDpkg: true, temporaryRoot: true, hostFilesystemReadOnly: true, realCodex: false, serviceStarted: false } };
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024, ...options });
const pass = name => { report.checks.push(name); console.log('PASS ' + name); };
const sandbox = (command, args, options = {}) => run('bwrap', ['--die-with-parent', '--unshare-user', '--uid', String(options.uid ?? 0), '--gid', String(options.gid ?? 0),
  '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--ro-bind', '/', '/', '--perms', '0755', '--tmpfs', '/tmp', '--bind', scratch, scratch,
  '--proc', '/proc', '--dev', '/dev', '--', command, ...args], options.env ? { env: options.env } : {});
const dpkg = (directory, args) => sandbox('/usr/bin/dpkg', [`--root=${directory}`, `--log=${join(scratch, 'dpkg.log')}`, '--force-script-chrootless', '--no-triggers', ...args]);
const query = (directory, args) => run('dpkg-query', [`--admindir=${join(directory, 'var/lib/dpkg')}`, ...args]);
const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

async function fixturePackage(name, version, cliText) {
  const directory = join(scratch, `fixture-${name}`); await mkdir(join(directory, 'DEBIAN'), { recursive: true });
  await writeFile(join(directory, 'DEBIAN/control'), `Package: ${name}\nVersion: ${version}\nArchitecture: amd64\nMaintainer: Disposable fixture\nDescription: Package ownership verification fixture only\n`);
  if (cliText) {
    await mkdir(join(directory, 'usr/bin'), { recursive: true });
    await writeFile(join(directory, 'usr/bin/oraculum'), cliText, { mode: 0o755 });
  }
  const file = join(scratch, `${name}-fixture.deb`);
  run('dpkg-deb', ['--root-owner-group', '--build', directory, file]);
  return file;
}

try {
  assert.ok((await lstat(artifact)).isFile(), 'Candidate must be a regular file');
  report.sha256 = hash(await readFile(artifact));
  const manifest = JSON.parse(await readFile(join(dirname(artifact), 'manifest.json'), 'utf8'));
  assert.equal(manifest.component, 'gateway'); assert.equal(manifest.packageName, 'oraculum-gateway');
  assert.equal(manifest.candidate, true); assert.equal(manifest.sourceDirty, false);
  assert.match(manifest.sourceGit, /^[a-f0-9]{40}$/);
  if (expectedGit) assert.equal(manifest.sourceGit, expectedGit);
  const described = manifest.artifacts.find(entry => entry.name === basename(artifact));
  assert.ok(described); assert.equal(described.sha256, report.sha256); assert.equal(described.size, (await lstat(artifact)).size);
  for (const [field, expected] of [['Package', 'oraculum-gateway'], ['Version', manifest.version], ['Architecture', 'amd64']]) {
    assert.equal(run('dpkg-deb', ['--field', artifact, field]).trim(), expected);
  }
  const depends = run('dpkg-deb', ['--field', artifact, 'Depends']).trim();
  assert.equal(depends, 'libc6 (>= 2.31), libgcc-s1, libstdc++6 (>= 8), util-linux');
  const listing = run('dpkg-deb', ['--contents', artifact]);
  const entries = listing.trim().split('\n').map(line => {
    const matched = /^(\S+)\s+(\S+)\s+\d+\s+\S+\s+\S+\s+(.+)$/.exec(line);
    assert.ok(matched, 'Unexpected archive listing format');
    const [name, link] = matched[3].split(' -> ');
    assert.ok(name.startsWith('./') && !name.split('/').includes('..'));
    assert.equal(matched[2], 'root/root');
    assert.ok(!/[\x00-\x1f\x7f]/.test(name));
    assert.ok(!/[sS]/.test(matched[1]), 'Setuid/setgid payload is forbidden');
    if (!link) assert.ok(matched[1][5] !== 'w' && matched[1][8] !== 'w', 'Group/world writable payload is forbidden');
    return { path: name.slice(2).replace(/\/$/, ''), link };
  });
  for (const entry of entries) {
    assert.ok(!entry.path || entry.path === 'usr' || entry.path.startsWith('usr/'), 'Candidate may write only /usr program files');
    assert.doesNotMatch(entry.path, /(?:^|\/)(?:apps|themes|stitch_oraculum_android_workspace|node_modules|\.git|\.local|\.cache|\.env|src|test-results|playwright-report)(?:\/|$)/);
    assert.doesNotMatch(entry.path, /\.(?:html|css|tsx?|map|sqlite(?:-[a-z]+)?|jks|keystore|pem|key|log)$/i);
    assert.doesNotMatch(entry.path, /(?:^|\/)(?:runtime\.json|auth\.json|config\.toml|pairing\.txt|id_rsa|id_ed25519)$/);
    if (entry.link) {
      assert.ok(!isAbsolute(entry.link));
      const offset = relative('usr', resolve('/', dirname(entry.path), entry.link).slice(1));
      assert.ok(offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset));
    }
  }
  const extracted = join(scratch, 'extracted'), control = join(scratch, 'control');
  run('dpkg-deb', ['--extract', artifact, extracted]); run('dpkg-deb', ['--control', artifact, control]);
  const runtime = join(extracted, 'usr/lib/oraculum-gateway');
  const build = JSON.parse(await readFile(join(runtime, 'build.json'), 'utf8'));
  for (const key of ['component', 'version', 'packageName', 'architecture', 'sourceGit', 'sourceDirty', 'candidate', 'protocol', 'stateSchema', 'licenseManifestSha256']) assert.deepEqual(build[key], manifest[key], `Embedded identity mismatch: ${key}`);
  assert.deepEqual(build.excludedUntrackedInputs, [untrackedDesignInput]);
  assert.deepEqual(await inventoryRuntime(runtime), build.files);
  report.sourceGit = build.sourceGit; report.version = build.version; report.nodeVersion = build.nodeVersion;
  const launcher = join(extracted, 'usr/bin/oraculum');
  assert.equal(await readlink(launcher), '../lib/oraculum-gateway/bin/oraculum');
  assert.deepEqual((await readdir(control)).sort(), ['control', 'preinst']);
  assert.equal(await readFile(join(control, 'preinst'), 'utf8'), await readFile(join(root, 'packaging/gateway/preinst'), 'utf8'));
  const unit = await readFile(join(extracted, 'usr/lib/systemd/user/oraculum-gateway.service'), 'utf8');
  assert.match(unit, /^ExecStart=\/usr\/lib\/oraculum-gateway\/bin\/oraculum-gateway$/m);
  assert.equal(entries.filter(entry => entry.path.startsWith('usr/lib/systemd/user/')).length, 1);
  assert.doesNotMatch(await readFile(join(control, 'preinst'), 'utf8'), /\b(?:systemctl|loginctl|ssh|curl|wget|apt|useradd|groupadd|rm|mv|cp)\b/);
  for (const name of ['gateway/main.mjs', 'gateway/cli.mjs', 'bin/oraculum', 'bin/oraculum-gateway']) {
    const text = await readFile(join(runtime, name), 'utf8');
    assert.ok(!text.includes(root.replace(/\/$/, '')), `Build-host repository path embedded: ${name}`);
    assert.doesNotMatch(text, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
  }
  assert.equal(run(join(runtime, 'node/bin/node'), ['--version']).trim(), 'v' + build.nodeVersion);
  pass('Clean committed candidate identity, artifact and payload hashes, private Node, safe /usr ownership, CLI and inert user unit');

  const noticesBytes = await readFile(join(runtime, 'licenses/manifest.json'));
  assert.equal(hash(noticesBytes), build.licenseManifestSha256);
  const licenses = JSON.parse(noticesBytes); assert.equal(licenses.format, 1);
  assert.equal(licenses.packages.length, build.bundledDependencyCount);
  const identities = new Set();
  for (const pkg of licenses.packages) {
    const identity = `${pkg.name}@${pkg.version}`;
    assert.ok(!identities.has(identity)); identities.add(identity);
    assert.ok(pkg.license && pkg.notices.length);
    for (const notice of pkg.notices) {
      assert.ok(!isAbsolute(notice.path) && !notice.path.split('/').includes('..'));
      assert.equal(hash(await readFile(join(runtime, 'licenses', notice.path))), notice.sha256);
    }
  }
  assert.ok((await readFile(join(runtime, 'node/LICENSE'))).length > 1_000);
  report.licensedDependencies = licenses.packages.length;
  pass('Actual bundled dependency license inventory and notices; no UI, themes, development tools or user state in payload');

  // Satisfy Depends with empty packages in the disposable database, avoiding
  // --force-depends and all overwrite/removal overrides. Runtime libraries are
  // checked by executing the private Node against the read-only host below.
  const dependencies = await Promise.all([fixturePackage('libc6', '99.0'), fixturePackage('libgcc-s1', '99.0'), fixturePackage('libstdc++6', '99.0'), fixturePackage('util-linux', '99.0')]);
  const fresh = join(scratch, 'fresh'); await mkdir(fresh);
  const retained = join(fresh, 'home/test-user'); await mkdir(join(retained, '.codex'), { recursive: true });
  await mkdir(join(retained, '.local/share/oraculum'), { recursive: true });
  const sentinels = [join(retained, '.codex/config.toml'), join(retained, '.local/share/oraculum/trust.sqlite')];
  for (const sentinel of sentinels) await writeFile(sentinel, 'synthetic preserved state\n', { mode: 0o600 });
  const before = await Promise.all(sentinels.map(async file => hash(await readFile(file))));
  dpkg(fresh, ['--install', ...dependencies]); dpkg(fresh, ['--install', artifact]);
  assert.equal(query(fresh, ['--show', '--showformat=${Version}', 'oraculum-gateway']).trim(), manifest.version);
  assert.ok(query(fresh, ['--listfiles', 'oraculum-gateway']).includes('/usr/bin/oraculum'));
  assert.deepEqual(await Promise.all(sentinels.map(async file => hash(await readFile(file)))), before);
  assert.ok(!(await exists(join(fresh, 'etc/systemd'))) && !(await exists(join(fresh, 'home/test-user/.config/systemd'))));
  dpkg(fresh, ['--install', artifact]);
  assert.deepEqual(await Promise.all(sentinels.map(async file => hash(await readFile(file)))), before);
  pass('Real dpkg fresh install and same-package reinstall in disposable root preserve synthetic old state and do not enable services');

  const oldPackage = await fixturePackage('oraculum', '0.1.2', '#!/bin/sh\nprintf legacy-desktop\n');
  const conflict = join(scratch, 'legacy-conflict'); await mkdir(conflict);
  dpkg(conflict, ['--install', ...dependencies, oldPackage]);
  const previous = await readFile(join(conflict, 'usr/bin/oraculum'));
  let conflictError;
  try { dpkg(conflict, ['--install', artifact]); } catch (error) { conflictError = String(error.stdout ?? '') + String(error.stderr ?? ''); }
  assert.match(conflictError ?? '', /owned by another package/);
  assert.deepEqual(await readFile(join(conflict, 'usr/bin/oraculum')), previous);
  assert.equal(query(conflict, ['--show', '--showformat=${Version}', 'oraculum']).trim(), '0.1.2');
  assert.ok(!(await exists(join(conflict, 'usr/lib/oraculum-gateway'))));
  pass('Legacy Desktop /usr/bin/oraculum ownership blocks candidate before payload unpack; existing package and bytes preserved');

  const unmanaged = join(scratch, 'unmanaged-conflict'); await mkdir(join(unmanaged, 'usr/bin'), { recursive: true });
  dpkg(unmanaged, ['--install', ...dependencies]);
  await writeFile(join(unmanaged, 'usr/bin/oraculum'), 'unmanaged preserved');
  let unmanagedError;
  try { dpkg(unmanaged, ['--install', artifact]); } catch (error) { unmanagedError = String(error.stdout ?? '') + String(error.stderr ?? ''); }
  assert.match(unmanagedError ?? '', /unmanaged/);
  assert.equal(await readFile(join(unmanaged, 'usr/bin/oraculum'), 'utf8'), 'unmanaged preserved');
  pass('Unmanaged CLI conflict is refused without overwrite, uninstall, or data migration');

  // Run the extracted private runtime from an unrelated cwd and isolated HOME.
  // The CLI initializes only its new namespace; no actual Codex process runs.
  const home = join(scratch, 'cli-home'); await mkdir(home, { mode: 0o700 });
  const cliEnv = { PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'),
    XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache') };
  const cli = args => sandbox(launcher, args, { uid: process.getuid(), gid: process.getgid(), env: cliEnv });
  report.cliInit = JSON.parse(cli(['init']));
  report.cliStatus = JSON.parse(cli(['status']));
  // Keep only public state/status evidence, never pairing codes or credentials.
  assert.ok(report.cliInit && report.cliStatus);
  assert.equal(report.cliInit.installationId, report.cliStatus.installationId);
  assert.equal(report.cliStatus.devices, 0); assert.equal(report.cliStatus.registeredProjects, 0);
  const pairing = JSON.parse(cli(['pair']));
  assert.ok(pairing.pairingFile.startsWith(home + sep));
  assert.equal((await lstat(pairing.pairingFile)).mode & 0o777, 0o600);
  assert.ok((await readFile(pairing.pairingFile, 'utf8')).trim().length >= 16);
  assert.deepEqual(JSON.parse(cli(['devices', 'list'])), []);
  const privateFiles = [];
  async function checkPrivate(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name), stat = await lstat(file);
      assert.ok(!stat.isSymbolicLink()); assert.equal(stat.mode & 0o077, 0, 'CLI configuration/state must be private');
      if (entry.isDirectory()) await checkPrivate(file); else privateFiles.push(relative(home, file));
    }
  }
  await checkPrivate(home);
  assert.ok(privateFiles.some(name => name.endsWith('/gateway.sqlite')));
  assert.ok(!privateFiles.some(name => name.endsWith('/trust.sqlite')));
  report.privateFiles = privateFiles;
  pass('Packaged CLI initializes fresh private Gateway config/SQLite and reports status using only its bundled Node and JavaScript');

  // Exercise the bundled daemon itself with a finite stdio fixture, in a
  // temporary config/port. This does not install/start a systemd service or run a model.
  const portProbe=createPortProbe();portProbe.listen(0,'127.0.0.1');await once(portProbe,'listening');
  const testPort=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
  const peer=join(scratch,'native-fixture.mjs');
  await writeFile(peer,`#!${join(runtime,'node/bin/node')}\nimport {createInterface} from 'node:readline';\nif(process.argv.includes('--version')){console.log('codex-fixture 0.0.0');process.exit(0); }\ncreateInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result=m.method==='initialize'?{userAgent:'codex-package-fixture'}:m.method==='model/list'?{data:[{id:'fixture',model:'fixture',displayName:'Fixture',supportedReasoningEfforts:[]}],nextCursor:null}:{};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');}).on('close',()=>process.exit(0));\n`,{mode:0o700});
  const configFile=join(home,'.config/oraculum-gateway/config.json');const daemonConfig=JSON.parse(await readFile(configFile,'utf8'));
  daemonConfig.port=testPort;daemonConfig.codexCommand=peer;await writeFile(configFile,JSON.stringify(daemonConfig)+'\n',{mode:0o600});
  const daemon=spawn(join(runtime,'bin/oraculum-gateway'),['--config',configFile],{cwd:scratch,env:{...cliEnv,ORACULUM_GATEWAY_CONFIG:configFile},stdio:['ignore','pipe','pipe']});
  const daemonExit=once(daemon,'exit');let stdout='',stderr='';daemon.stdout.on('data',part=>{stdout=(stdout+part.toString()).slice(-8192);});daemon.stderr.on('data',part=>{stderr=(stderr+part.toString()).slice(-8192);});
  try{
    await new Promise((resolve,reject)=>{const deadline=Date.now()+15000;const timer=setInterval(()=>{if(stdout.includes('Gateway is listening')){clearInterval(timer);resolve();}else if(daemon.exitCode!==null||Date.now()>deadline){clearInterval(timer);reject(new Error('Bundled Gateway did not become ready: '+stderr));}},25);});
    const request=async(path,body,token)=>{const res=await fetch(`http://127.0.0.1:${testPort}${path}`,{method:body?'POST':'GET',headers:{'x-oraculum-protocol':'2',...(body?{'content-type':'application/json'}:{}),...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});assert.equal(res.status,200);return res.json();};
    const health=await request('/health');assert.equal(health.installationId,report.cliInit.installationId);
    const device={deviceId:randomUUID(),deviceCredential:randomBytes(32).toString('base64url'),installationId:health.installationId};
    const code=(await readFile(pairing.pairingFile,'utf8')).trim();const access=await request('/api/v2/auth/pair',{...device,code,label:'Isolated bundled Gateway fixture'});
    const catalog=await request('/api/v2/models',undefined,access.accessToken);assert.equal(catalog.data.data[0].model,'fixture');
    const capabilities=await request('/api/v2/capabilities',undefined,access.accessToken);assert.equal(capabilities.data.protocol.major,2);
    report.isolation.temporaryGatewayProcess=true;
    pass('Bundled Gateway main starts from unrelated cwd, pairs a fresh device and serves authenticated HTTP with a simulated native peer');
  }finally{daemon.kill('SIGTERM');const kill=setTimeout(()=>daemon.kill('SIGKILL'),15000);kill.unref();const [code,signal]=await daemonExit;clearTimeout(kill);assert.equal(code,0);assert.equal(signal,null);}

  dpkg(fresh, ['--remove', 'oraculum-gateway']);
  assert.deepEqual(await Promise.all(sentinels.map(async file => hash(await readFile(file)))), before);
  assert.ok(!(await exists(join(fresh, 'usr/bin/oraculum'))));
  pass('Removing candidate in disposable root removes program files and preserves synthetic Codex/legacy state');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack ?? String(error); console.error(report.error); process.exitCode = 1;
} finally {
  if (await exists(join(scratch, 'dpkg.log'))) await writeFile(join(evidence, 'dpkg.log'), await readFile(join(scratch, 'dpkg.log')));
  await rm(scratch, { recursive: true, force: true });
  report.disposableRootRemoved = true;
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, evidence }));
}
