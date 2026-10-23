import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { TrustStore } from './trust-store';
import { createServer } from './server';
import type { BridgeService } from './service';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; });
function store(now?: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'oraculum-trust-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const trust = new TrustStore(dir, now);
  cleanups.push(() => trust.close());
  return { trust, dir };
}
describe('private, persistent and revocable device trust', () => {
  it('stores digests only, consumes a pairing code once and binds sessions to the origin', () => {
    const { trust, dir } = store();
    const { code } = trust.createPairing();
    const { token, device } = trust.pair(code, 'Android test', 'https://oraculum.example');
    expect(trust.authenticate(token, 'https://oraculum.example')?.id).toBe(device.id);
    expect(trust.authenticate(token, 'http://127.0.0.1:17860')).toBeUndefined();
    expect(() => trust.pair(code, 'Replay', 'https://oraculum.example')).toThrow('Invalid');
    const bytes = readFileSync(join(dir, 'trust.sqlite'));
    expect(bytes.includes(Buffer.from(code))).toBe(false);
    expect(bytes.includes(Buffer.from(token))).toBe(false);
    expect(statSync(join(dir, 'trust.sqlite')).mode & 0o777).toBe(0o600);
    expect(trust.revoke(device.id)).toBe(true);
    expect(trust.authenticate(token, 'https://oraculum.example')).toBeUndefined();
  });
  it('expires pairing codes but keeps trusted devices beyond a day and a year', () => {
    let now = 1000;
    const { trust } = store(() => now);
    const first = trust.createPairing();
    now += 300001;
    expect(() => trust.pair(first.code, 'Old', 'https://oraculum.example')).toThrow();
    const next = trust.createPairing();
    expect(() => trust.pair(next.code, '\n', 'https://oraculum.example')).toThrow();
    const { token } = trust.pair(next.code, 'Valid', 'https://oraculum.example');
    now += 86400001;
    expect(trust.authenticate(token, 'https://oraculum.example')?.expiresAt).toBeNull();
    now += 2 * 365 * 86400000;
    expect(trust.authenticate(token, 'https://oraculum.example')?.expiresAt).toBeNull();
  });
  it('upgrades only still-valid legacy devices atomically and preserves other tables across restarts', () => {
    const { dir, tokens } = legacyStore();
    let now = 1000;
    const trust = new TrustStore(dir, () => now);
    expect(trust.authenticate(tokens.active, 'https://oraculum.example')?.expiresAt).toBeNull();
    for (const token of [tokens.expired, tokens.revoked]) expect(trust.authenticate(token, 'https://oraculum.example')).toBeUndefined();
    expect(trust.db.prepare('SELECT operation_id FROM send_receipts').get()).toEqual({ operation_id: 'existing-receipt' });
    expect(trust.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    trust.close();
    // A backward host-clock correction must not revive expired legacy grants.
    const earlierClock = new TrustStore(dir, () => 999);
    try {
      expect(earlierClock.authenticate(tokens.active, 'https://oraculum.example')?.expiresAt).toBeNull();
      for (const token of [tokens.expired, tokens.revoked]) expect(earlierClock.authenticate(token, 'https://oraculum.example')).toBeUndefined();
    } finally { earlierClock.close(); }
    now += 2 * 365 * 86400000;
    const restarted = new TrustStore(dir, () => now);
    cleanups.push(() => restarted.close());
    expect(restarted.authenticate(tokens.active, 'https://oraculum.example')?.expiresAt).toBeNull();
    for (const token of [tokens.expired, tokens.revoked]) expect(restarted.authenticate(token, 'https://oraculum.example')).toBeUndefined();
    expect(restarted.list().find(device => device.id === 'expired')?.expiresAt).toBe(1000);
    expect(restarted.list().find(device => device.id === 'revoked')?.revoked).toBe(1);
    expect(restarted.db.prepare('SELECT operation_id FROM send_receipts').get()).toEqual({ operation_id: 'existing-receipt' });
  });
  it('rolls back a failed legacy schema upgrade without changing devices or unrelated state', () => {
    const { dir } = legacyStore(true);
    expect(() => new TrustStore(dir, () => 1000)).toThrow();
    const db = new DatabaseSync(join(dir, 'trust.sqlite'));
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
      expect(db.prepare('SELECT expires_at FROM devices WHERE id=?').get('active')).toEqual({ expires_at: 1001 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM devices').get()).toEqual({ count: 3 });
      expect(db.prepare('SELECT operation_id FROM send_receipts').get()).toEqual({ operation_id: 'existing-receipt' });
      expect(db.prepare('SELECT value FROM devices_long_trust').get()).toEqual({ value: 'keep' });
    } finally { db.close(); }
  });
  it('rejects a newer database schema without modifying its records', () => {
    const { dir } = legacyStore();
    const db = new DatabaseSync(join(dir, 'trust.sqlite'));
    db.exec('PRAGMA user_version=2');
    db.close();
    expect(() => new TrustStore(dir, () => 1000)).toThrow('newer');
    const unchanged = new DatabaseSync(join(dir, 'trust.sqlite'));
    try {
      expect(unchanged.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
      expect(unchanged.prepare('SELECT expires_at FROM devices WHERE id=?').get('active')).toEqual({ expires_at: 1001 });
    } finally { unchanged.close(); }
  });
  it('keeps device revocation independent and rejects missing or malformed tokens', () => {
    const { trust } = store();
    const first = trust.pair(trust.createPairing().code, 'first', 'https://oraculum.example');
    const second = trust.pair(trust.createPairing().code, 'second', 'https://oraculum.example');
    trust.revoke(first.device.id);
    expect(trust.authenticate(first.token, 'https://oraculum.example')).toBeUndefined();
    expect(trust.authenticate(second.token, 'https://oraculum.example')?.id).toBe(second.device.id);
    for (const token of [undefined, '', 'invalid', 'x'.repeat(43)]) expect(trust.authenticate(token, 'https://oraculum.example')).toBeUndefined();
  });
  it('retains trust and revocation across independent database connections', () => {
    const { trust, dir } = store();
    const { token, device } = trust.pair(trust.createPairing().code, 'phone', 'https://oraculum.example');
    const second = new TrustStore(dir);
    try {
      expect(second.authenticate(token, 'https://oraculum.example')?.id).toBe(device.id);
      second.revoke(device.id);
      expect(trust.authenticate(token, 'https://oraculum.example')).toBeUndefined();
    } finally { second.close(); }
  });
  it('refuses a symlink database without changing its target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oraculum-link-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const target = join(dir, 'existing');
    writeFileSync(target, 'untouched', { mode: 0o600 });
    symlinkSync(target, join(dir, 'trust.sqlite'));
    expect(() => new TrustStore(dir)).toThrow('private');
    expect(readFileSync(target, 'utf8')).toBe('untouched');
  });
});

function legacyStore(conflict = false) {
  const dir = mkdtempSync(join(tmpdir(), 'oraculum-legacy-trust-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'trust.sqlite');
  writeFileSync(path, '', { mode: 0o600 });
  const db = new DatabaseSync(path);
  const tokens = { active: 'a'.repeat(43), expired: 'b'.repeat(43), revoked: 'c'.repeat(43) };
  try {
    db.exec(`CREATE TABLE pairing (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE devices (id TEXT PRIMARY KEY, label TEXT NOT NULL, digest TEXT UNIQUE NOT NULL,
        origin TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE send_receipts (operation_id TEXT PRIMARY KEY);
      INSERT INTO send_receipts VALUES ('existing-receipt');`);
    for (const [id, token] of Object.entries(tokens)) {
      db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?, ?, ?)').run(id, id, createHash('sha256').update(token).digest('hex'),
        'https://oraculum.example', id === 'expired' ? 1000 : 1001, id === 'revoked' ? 1 : 0);
    }
    if (conflict) db.exec("CREATE TABLE devices_long_trust (value TEXT); INSERT INTO devices_long_trust VALUES ('keep')");
  } finally { db.close(); }
  return { dir, tokens };
}

async function fixture(remoteBasePath = '/', now?: () => number) {
  const { trust } = store(now);
  const service = Object.assign(new EventEmitter(), { dispatch: vi.fn(async () => ({ safe: true })) });
  const app = await createServer(service as unknown as BridgeService, 17864, '/missing', { trust, remoteOrigin: 'https://oraculum.example', remoteBasePath });
  cleanups.push(() => app.close());
  await app.ready();
  const headers = { host: '127.0.0.1:17864', origin: 'http://127.0.0.1:17864' };
  async function pair(remote = false) {
    const h = remote ? { host: 'oraculum.example', origin: 'https://oraculum.example', 'x-forwarded-proto': 'https' } : headers;
    const reply = await app.inject({ method: 'POST', url: (remote ? remoteBasePath : '/') + 'auth/pair', headers: h, payload: { code: trust.createPairing().code, label: 'Test device' } });
    expect(reply.statusCode).toBe(200);
    const fullCookie = [reply.headers['set-cookie']].flat()[0]!;
    return { cookie: fullCookie.split(';')[0], fullCookie, device: reply.json().device, headers: h };
  }
  return { app, trust, service, headers, pair };
}
describe('HTTP and WebSocket authentication boundary', () => {
  it('renews year-long cookies after a day while missing, revoked and foreign credentials remain rejected', async () => {
    let now = 1000;
    const { app, pair, trust } = await fixture('/console/', () => now);
    const session = await pair(true);
    expect(session.fullCookie).toContain('Max-Age=31536000; Secure');
    now += 86400001;
    const headers = { ...session.headers, cookie: session.cookie };
    const renewed = await app.inject({ url: '/console/auth/session', headers });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.headers['set-cookie']).toEqual(expect.arrayContaining([
      `${session.cookie}; HttpOnly; SameSite=Strict; Path=/console/; Max-Age=31536000; Secure`,
    ]));
    const socket = await app.injectWS('/console/ws', { headers });
    socket.close();
    for (const h of [session.headers, { ...headers, origin: 'https://foreign.invalid' }, { ...headers, cookie: `${session.cookie}; ${session.cookie}` }]) {
      const denied = await app.inject({ url: '/console/auth/session', headers: h });
      expect([401, 403]).toContain(denied.statusCode);
      expect(denied.headers['set-cookie']).toBeUndefined();
    }
    trust.revoke(session.device.id);
    const denied = await app.inject({ url: '/console/auth/session', headers });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['set-cookie']).toBeUndefined();
  });
  it('closes real upgrade sockets rejected before authentication so proxies cannot pool unusable connections', async () => {
    const { app, service } = await fixture('/console/');
    app.server.on('connection', socket => { cleanups.push(() => { socket.destroy(); }); });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    for (const [path, extra, status] of [
      ['/console/ws', 'Origin: https://foreign.invalid\r\nX-Forwarded-Proto: https\r\n', 403],
      ['/console/ws', 'Origin: https://oraculum.example\r\n', 403],
      ['/console/../ws', 'X-Forwarded-Proto: https\r\n', 400],
      ['/ws', 'X-Forwarded-Proto: https\r\n', 404],
    ] as const) {
      const response = await new Promise<string>((resolve, reject) => {
        const socket = createConnection(Number(new URL(address).port), '127.0.0.1');
        let received = '';
        socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Rejected upgrade left an unusable connection open')); });
        socket.on('error', reject);
        socket.on('data', bytes => { received += bytes.toString(); });
        socket.on('close', () => resolve(received));
        socket.on('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: oraculum.example\r\n${extra}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`));
      });
      expect(response).toMatch(new RegExp(`^HTTP/1.1 ${status} `));
    }
    expect(service.dispatch).not.toHaveBeenCalled();
    expect(service.listenerCount('event')).toBe(0);
  });
  it('fails closed if no trust store was configured', async () => {
    const service = new EventEmitter() as BridgeService;
    await expect(createServer(service, 17864, '/missing')).rejects.toThrow('trust is required');
    await expect(createServer(service, 17864, '/missing', { testOnlyUnauthenticated: true, remoteOrigin: 'https://oraculum.example' })).rejects.toThrow('requires trust');
  });
  it('rejects anonymous sockets before any native dispatch or event subscription', async () => {
    const { app, service, headers } = await fixture();
    expect((await app.inject({ url: '/auth/session', headers })).statusCode).toBe(401);
    await expect(app.injectWS('/ws', { headers })).rejects.toThrow('401');
    expect(service.dispatch).not.toHaveBeenCalled();
    expect(service.listenerCount('event')).toBe(0);
  });
  it('requires exact Host, Origin and TLS forwarding claims; remote cookies are Secure and HttpOnly', async () => {
    const { app, headers, pair } = await fixture();
    for (const h of [
      { ...headers, host: 'evil.test' }, { ...headers, origin: 'https://evil.test' },
      { host: 'oraculum.example', origin: 'https://oraculum.example' },
      { host: 'oraculum.example', origin: 'https://oraculum.example', 'x-forwarded-proto': 'http' },
      { ...headers, 'sec-fetch-site': 'cross-site' },
    ]) expect((await app.inject({ url: '/health', headers: h })).statusCode).toBe(403);
    const session = await pair(true);
    expect(session.fullCookie).toContain('__Secure-oraculum_session=');
    expect(session.fullCookie).toContain('Secure');
    expect(session.fullCookie).toContain('HttpOnly; SameSite=Strict; Path=/');
    expect((await app.inject({ url: '/auth/session', headers: { ...session.headers, cookie: session.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/auth/session', headers: { ...headers, cookie: session.cookie.replace('__Secure-oraculum_session=', 'oraculum_local=') } })).statusCode).toBe(401);
  });
  it('rejects missing Origin and repeated cookies, limits pairing guesses and never exposes model information', async () => {
    const { app, headers, pair, trust } = await fixture();
    const session = await pair();
    expect((await app.inject({ url: '/auth/session', headers: { ...headers, cookie: `${session.cookie}; ${session.cookie}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/auth/pair', headers: { host: headers.host }, payload: { code: trust.createPairing().code, label: 'no Origin' } })).statusCode).toBe(403);
    for (let n = 0; n < 5; n++) {
      expect((await app.inject({ method: 'POST', url: '/auth/pair', headers, payload: { code: 'invalid', label: 'guess' } })).statusCode).toBe(401);
    }
    expect((await app.inject({ method: 'POST', url: '/auth/pair', headers, payload: {} })).statusCode).toBe(429);
  });
  it('revocation blocks events and side effects on an already-open socket and across reconnects', async () => {
    const { app, headers, pair, service, trust } = await fixture();
    const session = await pair();
    const h = { ...headers, cookie: session.cookie };
    const socket = await app.injectWS('/ws', { headers: h });
    const reply = once(socket, 'message');
    socket.send(JSON.stringify({ id: 'first', method: 'model/list', params: {} }));
    expect(JSON.parse(String((await reply)[0])).result).toEqual({ safe: true });
    trust.revoke(session.device.id);
    const leaked: unknown[] = [];
    socket.on('message', m => leaked.push(m));
    const closed = once(socket, 'close');
    service.emit('event', { type: 'notice', message: 'must not leak' });
    await closed;
    expect(leaked).toEqual([]);
    expect(service.dispatch).toHaveBeenCalledTimes(1);
    await expect(app.injectWS('/ws', { headers: h })).rejects.toThrow('401');
  });
  it('keeps local root while remote APIs, sockets and cookies use the configured subpath', async () => {
    const { app, headers, pair, service } = await fixture('/team/console/');
    const local = await pair();
    const remote = await pair(true);
    const h = { ...remote.headers, cookie: remote.cookie };
    expect(remote.fullCookie).toContain('Path=/team/console/;');
    expect((await app.inject({ url: '/auth/session', headers: { ...headers, cookie: local.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/team/console/auth/session', headers: h })).statusCode).toBe(200);
    for (const path of ['/auth/session', '/health', '/team/console-other/health']) {
      expect((await app.inject({ url: path, headers: h })).statusCode).toBe(404);
    }
    expect((await app.inject({ url: '/team/console/auth/session', headers })).statusCode).toBe(404);
    const socket = await app.injectWS('/team/console/ws', { headers: h });
    const response = once(socket, 'message');
    socket.send(JSON.stringify({ id: 'scoped', method: 'bridge/subscribe', params: {} }));
    expect(JSON.parse(String((await response)[0])).result).toEqual({ safe: true });
    expect(service.dispatch).toHaveBeenCalledTimes(1);
    const closed = once(socket, 'close');
    const logout = await app.inject({ method: 'POST', url: '/team/console/auth/logout', headers: h });
    expect(logout.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringContaining('Path=/team/console/; Max-Age=0; Secure'),
      expect.stringContaining('__Host-oraculum=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'),
      expect.stringContaining('__Secure-oraculum_session=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'),
      expect.stringContaining('__Secure-oraculum_session=; Secure; HttpOnly; SameSite=Strict; Path=/team/; Max-Age=0'),
    ]));
    await closed;
    await expect(app.injectWS('/team/console/ws', { headers: h })).rejects.toThrow('401');
  });
  it('rejects credential mixups, ambiguous paths, missing Origin and remote root WS bypass', async () => {
    const { app, pair } = await fixture('/console/');
    const local = await pair(); const remote = await pair(true);
    for (const cookie of [local.cookie, local.cookie.replace('oraculum_local=', '__Secure-oraculum_session='),
      'dsh_ma_session=untrusted; __Host-dsh_ma_session=untrusted', `${remote.cookie}; ${remote.cookie}`]) {
      expect((await app.inject({ url: '/console/auth/session', headers: { ...remote.headers, cookie } })).statusCode).toBe(401);
    }
    // Use a raw path: inject() and browsers canonicalize dot segments before
    // sending; those clients cannot test rejection of the original wire bytes.
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as import('node:net').AddressInfo).port;
    for (const path of ['/console/%2e%2e/auth/session', '/console/a/../health', '/console//health', '/console/%252fhealth']) {
      const status = await new Promise<number | undefined>((yes, no) => {
        const req = httpRequest({ hostname: '127.0.0.1', port, path, headers: remote.headers }, reply => {
          reply.resume(); reply.on('end', () => yes(reply.statusCode));
        });
        req.on('error', no); req.end();
      });
      expect(status, path).toBe(400);
    }
    const { origin: _, ...withoutOrigin } = remote.headers;
    await expect(app.injectWS('/console/ws', { headers: { ...withoutOrigin, cookie: remote.cookie } })).rejects.toThrow('403');
    await expect(app.injectWS('/ws', { headers: { ...remote.headers, cookie: remote.cookie } })).rejects.toThrow('404');
    expect((await app.inject({ url: '/console', headers: remote.headers })).headers.location).toBe('/console/');
  });
  it('detaches authorization timers and subscribers before the trust database is closed', async () => {
    const { app, trust, pair, service } = await fixture('/console/');
    const session = await pair(true);
    const socket = await app.injectWS('/console/ws', { headers: { ...session.headers, cookie: session.cookie } });
    expect(service.listenerCount('event')).toBe(1);
    const authenticate = vi.spyOn(trust, 'authenticate');
    await app.close();
    expect(service.listenerCount('event')).toBe(0);
    authenticate.mockClear();
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(authenticate).not.toHaveBeenCalled();
    socket.terminate();
  });
  it('requires a new pairing when the remote Base Path changes', async () => {
    const { trust, service, pair } = await fixture();
    const session = await pair(true);
    const app = await createServer(service as unknown as BridgeService, 17864, '/missing', {
      trust, remoteOrigin: 'https://oraculum.example', remoteBasePath: '/moved/',
    });
    cleanups.push(() => app.close());
    const headers = { ...session.headers, cookie: session.cookie };
    expect((await app.inject({ url: '/moved/auth/session', headers })).statusCode).toBe(401);
    const reply = await app.inject({ method: 'POST', url: '/moved/auth/pair', headers,
      payload: { code: trust.createPairing().code, label: 'Moved device' } });
    expect(reply.statusCode).toBe(200);
    expect(reply.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringContaining('Path=/moved/;'),
      '__Secure-oraculum_session=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    ]));
  });
});
