import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { GatewayStore, randomCredential } from './store';
import { GatewayAuth } from './auth';
import { initGatewayConfig, loadGatewayConfig, validateGatewayConfig } from './config';
import { runCli } from './cli';
import { acquireGatewayLock } from './process-lock';

const roots: string[] = []; const stores: GatewayStore[] = [];
const directory = () => { const root = mkdtempSync(join(tmpdir(), 'oraculum-gateway-state-')); roots.push(root); return root; };
const storeAt = (root = directory(), options: { create?: boolean; now?: () => number } = { create: true }) => { const store = new GatewayStore(root, options); stores.push(store); return store; };
const identity = (store: GatewayStore) => ({ installationId: store.installationId, deviceId: randomUUID(), deviceCredential: randomCredential() });
const paired = (store: GatewayStore) => { const device = identity(store); store.pair({ ...device, ...store.createPairing(), label: '测试设备' }); return device; };
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function child(script: string, input: unknown): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const process = spawn(globalThis.process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: resolve('.'), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let error = '';
    process.stdout.on('data', chunk => { output += chunk.toString(); });
    process.stderr.on('data', chunk => { error += chunk.toString(); });
    process.once('error', reject);
    process.once('exit', code => code === 0 ? resolveOutput(output.trim()) : reject(new Error(`Child failed (${code}): ${error}`)));
    process.stdin.end(JSON.stringify(input));
  });
}

describe('new private Gateway state', () => {
  it('creates only the minimal new schema and preserves installation identity', () => {
    const root = directory(); const first = storeAt(root); const id = first.installationId;
    expect(lstatSync(join(root, 'gateway.sqlite')).mode & 0o777).toBe(0o600);
    expect(first.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    expect(first.db.prepare('PRAGMA synchronous').get()?.synchronous).toBe(2);
    expect(first.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => row.name)).toEqual(['attachments', 'devices', 'gateway_meta', 'operations', 'pairing_codes', 'projects']);
    first.close();
    expect(storeAt(root, {}).installationId).toBe(id);
  });

  it('does not implicitly initialize a missing store', () => {
    const root = directory(); expect(() => new GatewayStore(root)).toThrow();
    expect(existsSync(join(root, 'gateway.sqlite'))).toBe(false);
  });

  it('refuses legacy state and never imports its devices', () => {
    const root = directory(); writeFileSync(join(root, 'trust.sqlite'), 'legacy-do-not-touch', { mode: 0o600 });
    expect(() => new GatewayStore(root, { create: true })).toThrow(/independent/);
    expect(readFileSync(join(root, 'trust.sqlite'), 'utf8')).toBe('legacy-do-not-touch');
    expect(existsSync(join(root, 'gateway.sqlite'))).toBe(false);
  });

  it.each(['symlink-leaf', 'symlink-parent', 'public-directory', 'hardlink-db', 'public-db', 'sidecar-symlink'])('rejects unsafe state path: %s', kind => {
    const root = directory(); const state = join(root, 'state'); mkdirSync(state, { mode: 0o700 });
    if (kind === 'symlink-leaf') { symlinkSync(state, join(root, 'link')); expect(() => new GatewayStore(join(root, 'link'), { create: true })).toThrow(); }
    if (kind === 'symlink-parent') { symlinkSync(root, join(root, 'link')); expect(() => new GatewayStore(join(root, 'link/state'), { create: true })).toThrow(); }
    if (kind === 'public-directory') { chmodSync(state, 0o755); expect(() => new GatewayStore(state, { create: true })).toThrow(); }
    if (kind === 'hardlink-db') { const store = storeAt(state); store.close(); linkSync(join(state, 'gateway.sqlite'), join(root, 'copy')); expect(() => new GatewayStore(state)).toThrow(); }
    if (kind === 'public-db') { const store = storeAt(state); store.close(); chmodSync(join(state, 'gateway.sqlite'), 0o644); expect(() => new GatewayStore(state)).toThrow(); }
    if (kind === 'sidecar-symlink') { const store = storeAt(state); store.close(); symlinkSync(join(root, 'missing'), join(state, 'gateway.sqlite-journal')); expect(() => new GatewayStore(state)).toThrow(); }
  });

  it.each(['version', 'table', 'trigger', 'view'])('refuses unknown schema %s without changing its schema', kind => {
    const root = directory(); const store = storeAt(root); store.close();
    const db = new DatabaseSync(join(root, 'gateway.sqlite'));
    if (kind === 'version') db.exec('PRAGMA user_version=999');
    if (kind === 'table') db.exec('CREATE TABLE legacy_messages(body TEXT)');
    if (kind === 'trigger') db.exec('CREATE TRIGGER hidden AFTER INSERT ON devices BEGIN UPDATE devices SET revoked_at=1; END');
    if (kind === 'view') db.exec('CREATE VIEW hidden AS SELECT * FROM devices');
    const original = db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(); db.close();
    expect(() => new GatewayStore(root, { create: true })).toThrow(/schema/);
    const check = new DatabaseSync(join(root, 'gateway.sqlite'));
    expect(check.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all()).toEqual(original); check.close();
  });

  it('enforces table constraints and does not store credentials or pairing secrets', () => {
    const store = storeAt(); const device = identity(store); const pair = store.createPairing();
    store.pair({ ...device, code: pair.code, label: 'safe' });
    const dump = JSON.stringify(store.db.prepare('SELECT * FROM devices').all());
    expect(dump).not.toContain(device.deviceCredential);
    expect(store.db.prepare('SELECT * FROM pairing_codes').all()).toEqual([]);
    expect(() => store.db.prepare("INSERT INTO gateway_meta VALUES(2,'not-a-uuid',0)").run()).toThrow();
    expect(() => store.db.prepare("INSERT INTO projects(id,canonical_path,root_id,dev,ino,created_at) VALUES(?, '/', 'test', '-1','2',0)").run(randomUUID())).toThrow();
    expect(() => store.db.prepare("INSERT INTO operations(operation_id,device_id,kind,status,created_at,updated_at) VALUES(?,?, 'turn.start','accepted',0,0)").run(randomUUID(), randomUUID())).toThrow();
  });

  it('fails safely when another short transaction owns the SQLite writer', () => {
    const root = directory(); const store = storeAt(root); const other = storeAt(root, {});
    other.db.exec('BEGIN IMMEDIATE');
    expect(() => store.createPairing()).toThrow(/locked/);
    other.db.exec('ROLLBACK');
    expect(store.db.prepare('SELECT * FROM pairing_codes').all()).toEqual([]);
  });

  it('rolls back composed operations and refuses asynchronous transactions', () => {
    const store = storeAt();
    expect(() => store.transaction(() => { store.createPairing(); throw new Error('injected'); })).toThrow('injected');
    expect(store.db.prepare('SELECT * FROM pairing_codes').all()).toEqual([]);
    expect(() => store.transaction(() => Promise.resolve('not allowed'))).toThrow(/synchronous/);
  });
});

describe('pairing and short access', () => {
  it('recovers a lost pair ACK and concurrent token ACKs using pre-generated identity', () => {
    const store = storeAt(); const auth = new GatewayAuth(store); const pending = identity(store);
    auth.pair({ ...pending, code: store.createPairing().code, label: '手机' }); // ACK deliberately discarded.
    const first = auth.token(pending); const second = auth.token(pending);
    expect(auth.authenticate(first.accessToken).id).toBe(pending.deviceId);
    expect(auth.authenticate(second.accessToken).id).toBe(pending.deviceId);
    expect(store.listDevices()).toHaveLength(1);
    expect(() => auth.pair({ ...pending, code: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA', label: 'retry' })).toThrow();
  });

  it('atomically consumes a single pairing code across separate processes', async () => {
    const root = directory(); const store = storeAt(root); const code = store.createPairing().code;
    const script = `import {readFileSync} from 'node:fs'; import {GatewayStore} from './gateway/src/store.ts'; const input=JSON.parse(readFileSync(0,'utf8')); const store=new GatewayStore(input.root); try { store.pair(input.pair); console.log('paired'); } catch(error) { console.log(error.code); } finally {store.close();}`;
    const results = await Promise.all([child(script, { root, pair: { ...identity(store), code, label: 'one' } }), child(script, { root, pair: { ...identity(store), code, label: 'two' } })]);
    expect(results.sort()).toEqual(['UNAUTHENTICATED', 'paired']);
    expect(store.listDevices()).toHaveLength(1);
  });

  it('rolls pairing code consumption back when identity conflicts', () => {
    const store = storeAt(); const old = paired(store); const code = store.createPairing().code;
    expect(() => store.pair({ ...old, code, label: 'duplicate' })).toThrow(/already in use/);
    const next = identity(store); store.pair({ ...next, code, label: 'new' });
    expect(store.listDevices()).toHaveLength(2);
  });

  it('expires codes/access, persists trust and renews after Gateway restart', () => {
    let now = 1_000; const root = directory(); const store = storeAt(root, { create: true, now: () => now });
    const expired = store.createPairing(); now += 5 * 60_000;
    expect(() => store.pair({ ...identity(store), code: expired.code, label: 'expired' })).toThrow(/expired/);
    const device = paired(store); const auth = new GatewayAuth(store, { now: () => now, accessTtlMs: 100 });
    const token = auth.token(device); now += 100;
    expect(() => auth.authenticate(token.accessToken)).toThrow(/expired/);
    const renewed = auth.token(device); expect(auth.authenticate(renewed.accessToken).id).toBe(device.deviceId);
    const restarted = new GatewayAuth(store, { now: () => now });
    expect(() => restarted.authenticate(renewed.accessToken)).toThrow();
    expect(restarted.authenticate(restarted.token(device).accessToken).id).toBe(device.deviceId);
  });

  it('observes revocation from another store before using a cached access grant', () => {
    const root = directory(); const store = storeAt(root); const pending = paired(store); const auth = new GatewayAuth(store); const token = auth.token(pending);
    storeAt(root, {}).revokeDevice(pending.deviceId);
    expect(() => auth.authenticate(token.accessToken)).toThrow(/revoked/);
    expect(() => auth.token(pending)).toThrow(/revoked/);
  });

  it('rejects installation mismatches, malformed credentials and unknown request fields', () => {
    const store = storeAt(); const pending = paired(store); const auth = new GatewayAuth(store);
    expect(() => auth.token({ ...pending, installationId: randomUUID() })).toThrow();
    expect(() => auth.token({ ...pending, deviceCredential: 'short' })).toThrow();
    expect(() => auth.token({ ...pending, origin: 'unexpected' })).toThrow();
    expect(() => auth.authenticate(pending.deviceCredential)).toThrow();
  });

  it('limits failures across spoofed peers and bounds still-valid access grants', () => {
    const store = storeAt(); const device = paired(store); let now = 1000; const auth = new GatewayAuth(store, { now: () => now, maxAccessPerDevice: 2 });
    for (let i = 0; i < 5; i++) expect(() => auth.token({ ...device, deviceCredential: randomCredential() }, `peer-${i}`)).toThrow(/credential/);
    expect(() => auth.token(device, 'new-peer')).toThrow(/rate limit/);
    now += 60_001;
    const one = auth.token(device); const two = auth.token(device);
    expect(() => auth.token(device)).toThrow(/Active access token limit/);
    expect(auth.authenticate(one.accessToken).id).toBe(device.deviceId);
    expect(auth.authenticate(two.accessToken).id).toBe(device.deviceId);
  });
});

describe('operation tombstones and workspace barriers', () => {
  it('reserves before dispatch, keeps unknown after reopen, and blocks duplicate IDs without disclosing another device', () => {
    const root = directory(); const store = storeAt(root); const first = paired(store); const second = paired(store);
    const project = store.insertProject({ canonicalPath: root, rootId: 'test', dev: '1', ino: '2' });
    const operationId = randomUUID(); store.reserveOperation({ operationId, deviceId: first.deviceId, projectId: project.id, kind: 'thread.start' });
    expect(store.hasUnknownOperation(project.id, 'other-thread')).toBe(true);
    expect(() => store.reserveOperation({ operationId, deviceId: second.deviceId, projectId: project.id, kind: 'different' })).toThrow(/already been recorded/);
    expect(store.getOperation(operationId, second.deviceId)).toBeUndefined();
    store.close(); const reopened = storeAt(root, {});
    expect(reopened.getOperation(operationId, first.deviceId)?.status).toBe('unknown');
    reopened.finishOperation(operationId, 'accepted', { nativeThreadId: 'native-thread-not-uuid' });
    expect(reopened.hasUnknownOperation(project.id, 'other-thread')).toBe(false);
    expect(() => reopened.reserveOperation({ operationId, deviceId: first.deviceId, kind: 'thread.start' })).toThrow();
  });

  it('limits a thread barrier to that thread and retains registered-project tombstones', () => {
    const store = storeAt(); const device = paired(store); const project = store.insertProject({ canonicalPath: '/isolated/test', rootId: 'test', dev: '1', ino: '2' });
    store.reserveOperation({ operationId: randomUUID(), deviceId: device.deviceId, projectId: project.id, threadId: 'a', kind: 'turn.start' });
    expect(store.hasUnknownOperation(project.id, 'a')).toBe(true); expect(store.hasUnknownOperation(project.id, 'b')).toBe(false); expect(store.hasUnknownOperation(project.id)).toBe(true);
    store.unregisterProject(project.id);
    const replacement = store.insertProject({ canonicalPath: '/isolated/test', rootId: 'test', dev: '1', ino: '3' });
    expect(replacement.id).not.toBe(project.id); expect(store.getProject(project.id)?.ino).toBe('2');
  });
});

describe('configuration, CLI and process lock', () => {
  it('initializes explicitly, uses private config, and prints no pairing secret', () => {
    const root = directory(); const configPath = join(root, 'config/config.json'); const stateDir = join(root, 'state'); const output: string[] = [];
    runCli(['init', '--config', configPath, '--state-dir', stateDir, '--root', `test=${root}`, '--port', '18899'], message => output.push(message));
    expect(lstatSync(configPath).mode & 0o777).toBe(0o600);
    runCli(['status', '--config', configPath], message => output.push(message));
    expect(JSON.parse(output[1]!).serviceState).toBe('not-probed');
    runCli(['pair', '--config', configPath], message => output.push(message));
    const pairPath = JSON.parse(output[2]!).pairingFile; const secret = readFileSync(pairPath, 'utf8').trim();
    expect(lstatSync(pairPath).mode & 0o777).toBe(0o600); expect(output.join('')).not.toContain(secret);
    const configBefore = readFileSync(configPath, 'utf8');
    expect(() => runCli(['init', '--config', configPath, '--state-dir', stateDir])).toThrow();
    expect(readFileSync(configPath, 'utf8')).toBe(configBefore);
  });

  it('rejects public/hardlinked config, non-loopback listening, unsafe roots and unknown settings', () => {
    const root = directory(); const configPath = join(root, 'config.json'); const config = initGatewayConfig({ configPath, stateDir: join(root, 'state') });
    expect(() => validateGatewayConfig({ ...config, host: '0.0.0.0' })).toThrow();
    expect(() => validateGatewayConfig({ ...config, externalOrigin: 'http://example.com' })).toThrow();
    expect(() => validateGatewayConfig({ ...config, basePath: '/a/../' })).toThrow();
    expect(() => validateGatewayConfig({ ...config, allowedRoots: [{ id: 'all', path: '/' }] })).toThrow();
    expect(() => validateGatewayConfig({ ...config, migrateLegacy: true })).toThrow();
    chmodSync(configPath, 0o644); expect(() => loadGatewayConfig(configPath)).toThrow(); chmodSync(configPath, 0o600);
    linkSync(configPath, join(root, 'copy')); expect(() => loadGatewayConfig(configPath)).toThrow();
  });

  it('allows CLI stores while the Gateway lock excludes another process and releases on close', async () => {
    const root = directory(); const store = storeAt(root); const release = acquireGatewayLock(root);
    try {
      expect(storeAt(root, {}).installationId).toBe(store.installationId);
      const script = `import {readFileSync} from 'node:fs'; import {acquireGatewayLock} from './gateway/src/process-lock.ts'; const {root}=JSON.parse(readFileSync(0,'utf8')); try {const release=acquireGatewayLock(root); console.log('locked'); release();} catch(error){console.log(error.code);}`;
      expect(await child(script, { root })).toBe('GATEWAY_ALREADY_RUNNING');
      release(); expect(await child(script, { root })).toBe('locked');
    } finally { release(); }
  });

  it('recovers the process lock after an owner is killed without unlinking its inode', async () => {
    const root = directory(); storeAt(root);
    const script = `import {readFileSync} from 'node:fs'; import {acquireGatewayLock} from './gateway/src/process-lock.ts'; acquireGatewayLock(readFileSync(0,'utf8')); console.log('ready'); setInterval(()=>{},1000);`;
    const process = spawn(globalThis.process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'ignore'] });
    process.stdin.end(root);
    await new Promise<void>((ready, reject) => { process.stdout.once('data', () => ready()); process.once('error', reject); process.once('exit', () => reject(new Error('lock child exited early'))); });
    const inode = lstatSync(join(root, 'gateway.lock')).ino;
    expect(() => acquireGatewayLock(root)).toThrow(/Another Gateway/);
    const dead = new Promise<void>(done => process.once('exit', () => done())); process.kill('SIGKILL'); await dead;
    const release = acquireGatewayLock(root); release();
    expect(lstatSync(join(root, 'gateway.lock')).ino).toBe(inode);
  });
});
