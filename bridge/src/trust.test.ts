import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
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
describe('private, expiring and revocable device trust', () => {
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
  it('expires pairing codes and sessions; invalid labels do not consume a code', () => {
    let now = 1000;
    const { trust } = store(() => now);
    const first = trust.createPairing();
    now += 300001;
    expect(() => trust.pair(first.code, 'Old', 'https://oraculum.example')).toThrow();
    const next = trust.createPairing();
    expect(() => trust.pair(next.code, '\n', 'https://oraculum.example')).toThrow();
    const { token } = trust.pair(next.code, 'Valid', 'https://oraculum.example');
    now += 86400001;
    expect(trust.authenticate(token, 'https://oraculum.example')).toBeUndefined();
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

async function fixture() {
  const { trust } = store();
  const service = Object.assign(new EventEmitter(), { dispatch: vi.fn(async () => ({ safe: true })) });
  const app = await createServer(service as unknown as BridgeService, 17864, '/missing', { trust, remoteOrigin: 'https://oraculum.example' });
  cleanups.push(() => app.close());
  await app.ready();
  const headers = { host: '127.0.0.1:17864', origin: 'http://127.0.0.1:17864' };
  async function pair(remote = false) {
    const h = remote ? { host: 'oraculum.example', origin: 'https://oraculum.example', 'x-forwarded-proto': 'https' } : headers;
    const reply = await app.inject({ method: 'POST', url: '/auth/pair', headers: h, payload: { code: trust.createPairing().code, label: 'Test device' } });
    expect(reply.statusCode).toBe(200);
    return { cookie: String(reply.headers['set-cookie']).split(';')[0], fullCookie: String(reply.headers['set-cookie']), device: reply.json().device, headers: h };
  }
  return { app, trust, service, headers, pair };
}
describe('HTTP and WebSocket authentication boundary', () => {
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
    expect(session.fullCookie).toContain('__Host-oraculum=');
    expect(session.fullCookie).toContain('Secure');
    expect(session.fullCookie).toContain('HttpOnly; SameSite=Strict; Path=/');
    expect((await app.inject({ url: '/auth/session', headers: { ...session.headers, cookie: session.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/auth/session', headers: { ...headers, cookie: session.cookie.replace('__Host-oraculum=', 'oraculum_local=') } })).statusCode).toBe(401);
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
});
