import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fixtures from '../../../../packages/gateway-protocol/fixtures/valid.json';
import { CredentialStore, type SafeStorageLike } from './credentials';
import { GatewayTransport, type ByteResponse, type GatewayHttpRequest, type GatewayIO, type GatewaySocket, type GatewaySocketOptions } from './gateway-transport';

const installationId = '12345678-1234-4123-8123-123456789abc';
const epoch = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const endpoint = 'http://127.0.0.1:43123/prefix/';
const now = 1_800_000_000_000;
const token = 'B'.repeat(43);
const code = 'A'.repeat(32);
const temporary: string[] = [];
const transports: GatewayTransport[] = [];
afterEach(() => {
  transports.splice(0).forEach(transport => transport.disconnect());
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers(); vi.restoreAllMocks();
});
const response = (value: unknown, status = 200): ByteResponse => ({ status, headers: { 'content-type': 'application/json; charset=utf-8' }, bytes: Buffer.from(JSON.stringify(value)) });
const envelope = (data: unknown) => ({ requestId: 'fixture-1', installationId, epoch, data });
const failure = (status: number, errorCode: string) => response({ ...envelope(null), error: { code: errorCode, message: 'PRIVATE_RESPONSE_DO_NOT_EXPOSE' } }, status);
function fixtureValue(name: string): any { return structuredClone(fixtures.find(fixture => fixture.contract === name)!.value); }
class FixtureSocket extends EventEmitter {
  readyState = 1;
  sent: unknown[] = [];
  terminated = false;
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.terminate(); }
  terminate() { this.terminated = true; this.emit('close'); }
  message(value: unknown, binary = false) { this.emit('message', Buffer.from(JSON.stringify(value)), binary); }
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'oraculum-transport-fixture-')); temporary.push(directory);
  const key = randomBytes(32);
  const storage: SafeStorageLike = {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) {
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString(bytes) {
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
  const credentials = new CredentialStore(directory, storage);
  const calls: GatewayHttpRequest[] = [];
  const sockets: { socket: FixtureSocket; url: URL; options: GatewaySocketOptions }[] = [];
  let pairedDevice: string | undefined; let currentTime = now;
  let override: ((request: GatewayHttpRequest) => ByteResponse | Promise<ByteResponse> | undefined) | undefined;
  const io: GatewayIO = {
    async request(request) {
      calls.push(request);
      const custom = override?.(request); if (custom !== undefined) return await custom;
      const path = request.url.pathname;
      if (path.endsWith('/health')) return response({ status: 'ok', protocolMajor: 2, installationId });
      if (path.endsWith('/auth/pair')) {
        const body = JSON.parse(request.body!.toString());
        const saved = credentials.load(request.url.href.replace('api/v2/auth/pair', ''), installationId);
        expect(saved?.deviceId).toBe(body.deviceId); expect(saved?.deviceCredential).toBe(body.deviceCredential);
        expect(saved?.paired).toBe(false); pairedDevice = body.deviceId;
        return response({ installationId, deviceId: pairedDevice, accessToken: token, expiresAt: currentTime + 600_000 });
      }
      if (path.endsWith('/auth/token')) {
        const body = JSON.parse(request.body!.toString());
        if (body.deviceId !== pairedDevice) return failure(401, 'UNAUTHENTICATED');
        return response({ installationId, deviceId: pairedDevice, accessToken: token, expiresAt: currentTime + 600_000 });
      }
      if (path.endsWith('/capabilities')) {
        return response(envelope({ ...fixtureValue('Capabilities'), epoch, installationId }));
      }
      if (path.endsWith('/auth/session')) return response(envelope({ installationId, deviceId: pairedDevice, label: 'Fixture Desktop', createdAt: now - 1000, expiresAt: currentTime + 600_000 }));
      return response(envelope({ fixture: true }));
    },
    socket(url, options) { const socket = new FixtureSocket(); sockets.push({ socket, url, options }); return socket as unknown as GatewaySocket; },
  };
  const transport = new GatewayTransport({ credentials, io, now: () => currentTime }); transports.push(transport);
  return { directory, storage, credentials, calls, io, sockets, transport,
    override: (fn: typeof override) => { override = fn; }, advance: (ms: number) => { currentTime += ms; },
    setPaired: (device: string) => { pairedDevice = device; },
    async pair() { await transport.connect(endpoint); return transport.pair(code, 'Fixture Desktop'); },
  };
}

describe('main-only Gateway transport with offline injected IO', () => {
  it('normalizes the base path, persists identity before pairing, completes handshake, and exposes only safe metadata', async () => {
    const f = fixture();
    expect(await f.transport.connect(endpoint.slice(0, -1))).toMatchObject({ endpoint, paired: false, deviceId: null, epoch: null });
    const connected = await f.transport.pair(code, 'Fixture Desktop');
    expect(connected).toMatchObject({ endpoint, installationId, paired: true, epoch });
    expect(f.transport.identity).toEqual({ endpoint, installationId, deviceId: connected.deviceId });
    expect(JSON.stringify(connected)).not.toContain(token);
    const secret = f.credentials.load(endpoint, installationId)!.deviceCredential;
    for (const filename of readdirSync(f.directory)) {
      const bytes = readFileSync(join(f.directory, filename));
      expect(bytes.includes(Buffer.from(secret))).toBe(false); expect(bytes.includes(Buffer.from(token))).toBe(false); expect(bytes.includes(Buffer.from(code))).toBe(false);
    }
    const result = await f.transport.request('GET', '/projects');
    expect(result).toEqual(envelope({ fixture: true }));
    expect(f.calls.at(-1)?.url.href).toBe(endpoint + 'api/v2/projects');
    for (const request of f.calls) {
      expect(request.headers['x-oraculum-protocol']).toBe('2');
      expect(request.url.href).not.toContain(secret); expect(request.url.href).not.toContain(token);
      if (!/\/(health|auth\/pair)$/.test(request.url.pathname)) expect(request.headers.authorization).toBe(`Bearer ${token}`);
    }
    connected.session!.deviceId = 'renderer-modification';
    expect(f.transport.connection!.session!.deviceId).not.toBe('renderer-modification');
  });

  it('preserves a pending identity after lost pair ACK, recovers using only token exchange after restart', async () => {
    const f = fixture(); await f.transport.connect(endpoint);
    f.override(request => {
      if (!request.url.pathname.endsWith('/auth/pair')) return undefined;
      const body = JSON.parse(request.body!.toString()); f.setPaired(body.deviceId);
      expect(f.credentials.load(endpoint, installationId)!.deviceCredential).toBe(body.deviceCredential);
      throw new Error('PRIVATE_SOCKET_FAILURE');
    });
    await expect(f.transport.pair(code, 'Fixture Desktop')).rejects.toThrow('CONNECTION_FAILED');
    const saved = f.credentials.load(endpoint, installationId)!; expect(saved.paired).toBe(false);
    f.override(undefined); f.transport.disconnect();
    const restored = new GatewayTransport({ credentials: new CredentialStore(f.directory, f.storage), io: f.io, now: () => now }); transports.push(restored);
    expect(await restored.connect(endpoint)).toMatchObject({ deviceId: saved.deviceId, paired: true });
    expect(f.calls.filter(call => call.url.pathname.endsWith('/auth/pair'))).toHaveLength(1);
    expect(f.calls.filter(call => call.url.pathname.endsWith('/auth/token'))).toHaveLength(1);
  });

  it('retains unpaired identity when the first request never reached Gateway', async () => {
    const f = fixture(); const saved = f.credentials.create(endpoint, installationId);
    expect(await f.transport.connect(endpoint)).toMatchObject({ paired: false, deviceId: saved.deviceId });
    expect(f.credentials.load(endpoint, installationId)).toEqual(saved);
    expect(f.calls.some(call => call.url.pathname.endsWith('/auth/pair'))).toBe(false);
  });

  it.each([401, 503])('never retries a write after HTTP %s and strips server messages', async status => {
    const f = fixture(); await f.pair();
    f.override(request => request.url.pathname.endsWith('/turns') ? failure(status, status === 401 ? 'UNAUTHENTICATED' : 'NATIVE_UNAVAILABLE') : undefined);
    await expect(f.transport.request('POST', '/threads/thread-1/turns', { operationId: randomUUID() })).rejects.toMatchObject({ code: status === 401 ? 'UNAUTHENTICATED' : 'NATIVE_UNAVAILABLE', status });
    expect(f.calls.filter(call => call.url.pathname.endsWith('/turns'))).toHaveLength(1);
    expect(f.calls.filter(call => call.url.pathname.endsWith('/auth/token'))).toHaveLength(0);
  });

  it('coalesces proactive token renewal before requests without persisting access tokens', async () => {
    const f = fixture(); await f.pair(); f.advance(590_000);
    await Promise.all([f.transport.request('GET', '/projects'), f.transport.request('GET', '/models')]);
    expect(f.calls.filter(call => call.url.pathname.endsWith('/auth/token'))).toHaveLength(1);
    expect(f.calls.filter(call => /\/(projects|models)$/.test(call.url.pathname))).toHaveLength(2);
  });

  it.each(['json', 'upload'])('runs the final %s dispatch guard after awaited token renewal and sends no write on refusal', async kind => {
    const f = fixture(); await f.pair(); f.advance(590_000);
    let complete: ((value: ByteResponse) => void) | undefined;
    f.override(request => request.url.pathname.endsWith('/auth/token') ? new Promise<ByteResponse>(resolve => { complete = resolve; }) : undefined);
    let permitted = true; const guard = vi.fn(() => { if (!permitted) throw new Error('SCOPE_CHANGED'); });
    const bytes = Buffer.from('guard fixture');
    const metadata = { ...fixtureValue('AttachmentUploadMetadata'), threadId: 'thread-1', size: bytes.length };
    const pending = kind === 'json'
      ? f.transport.request('POST', '/threads/thread-1/turns', { operationId: randomUUID() }, guard)
      : f.transport.requestBytes('POST', '/threads/thread-1/attachments', { body: bytes, headers: { 'x-oraculum-upload': Buffer.from(JSON.stringify(metadata)).toString('base64url') }, beforeDispatch: guard });
    const rejected = expect(pending).rejects.toThrow('SCOPE_CHANGED');
    expect(guard).not.toHaveBeenCalled(); permitted = false;
    complete!(response({ installationId, deviceId: f.transport.identity!.deviceId, accessToken: token, expiresAt: now + 1_190_000 }));
    await rejected; expect(guard).toHaveBeenCalledOnce();
    expect(f.calls.some(call => /\/(turns|attachments)$/.test(call.url.pathname))).toBe(false);
  });

  it('rejects changed installation before sending credentials or silently changing devices', async () => {
    const f = fixture(); await f.pair(); const previous = f.credentials.load(endpoint, installationId);
    const count = f.calls.length;
    f.override(request => request.url.pathname.endsWith('/health') ? response({ status: 'ok', protocolMajor: 2, installationId: randomUUID() }) : undefined);
    await expect(f.transport.connect(endpoint)).rejects.toThrow('CREDENTIAL_BINDING_MISMATCH');
    expect(f.calls.slice(count)).toHaveLength(1); expect(f.credentials.load(endpoint, installationId)).toEqual(previous);
  });

  it('rejects incorrect auth device and incompatible capability protocol', async () => {
    const f = fixture(); await f.transport.connect(endpoint);
    f.override(request => request.url.pathname.endsWith('/auth/pair') ? response({ installationId, deviceId: randomUUID(), accessToken: token, expiresAt: now + 600_000 }) : undefined);
    await expect(f.transport.pair(code, 'Fixture Desktop')).rejects.toThrow('AUTH_RESPONSE_INVALID');
    expect(f.transport.connection!.paired).toBe(false);
    f.override(request => request.url.pathname.endsWith('/capabilities') ? response(envelope({ ...fixtureValue('Capabilities'), epoch, protocol: { major: 2, minor: 99, minClientMinor: 99 } })) : undefined);
    await expect(f.transport.pair(code, 'Fixture Desktop')).rejects.toThrow('PROTOCOL_INCOMPATIBLE');
    await expect(f.transport.request('GET', '/projects')).rejects.toThrow('HANDSHAKE_REQUIRED');
  });

  it.each([302, 307, 308])('refuses HTTP redirect %s and never sends a second request', async status => {
    const f = fixture();
    f.override(() => ({ status, bytes: Buffer.alloc(0), headers: { location: 'https://untrusted.invalid/' } }));
    await expect(f.transport.connect(endpoint)).rejects.toMatchObject({ code: 'REDIRECT_REJECTED' });
    expect(f.calls).toHaveLength(1);
  });

  it('bounds response bodies and rejects invalid JSON/content types/error codes without exposing bytes', async () => {
    const f = fixture(); await f.pair();
    f.override(() => response({ secret: 'x'.repeat(16 * 1024 * 1024) }));
    await expect(f.transport.request('GET', '/projects')).rejects.toThrow('RESPONSE_TOO_LARGE');
    f.override(() => ({ status: 200, bytes: Buffer.from('PRIVATE_BODY'), headers: { 'content-type': 'text/html' } }));
    await expect(f.transport.request('GET', '/projects')).rejects.toThrow('RESPONSE_INVALID');
    f.override(() => failure(400, 'PRIVATE_CREDENTIAL_PAYLOAD'));
    await expect(f.transport.request('GET', '/projects')).rejects.toMatchObject({ code: 'GATEWAY_REJECTED', message: 'GATEWAY_REJECTED' });
  });

  it('cancels in-flight IO on disconnect and ignores a late result', async () => {
    const f = fixture(); let resolve: ((value: ByteResponse) => void) | undefined;
    f.override(() => new Promise<ByteResponse>(done => { resolve = done; }));
    const promise = f.transport.connect(endpoint); const rejected = expect(promise).rejects.toThrow('CONNECTION_CANCELLED');
    f.transport.disconnect(); await rejected;
    expect(f.calls[0].signal.aborted).toBe(true);
    resolve!(response({ status: 'ok', protocolMajor: 2, installationId }));
    await Promise.resolve(); expect(f.transport.connection).toBeNull();
  });

  it('enforces an absolute request deadline even if injected IO does not settle', async () => {
    vi.useFakeTimers(); const f = fixture(); f.override(() => new Promise(() => {}));
    const pending = expect(f.transport.connect(endpoint)).rejects.toThrow('REQUEST_TIMEOUT');
    await vi.advanceTimersByTimeAsync(30_000); await pending; expect(f.calls[0].signal.aborted).toBe(true);
  });

  it.each(['/auth/token', '/api/v2/projects', '//evil.invalid', '/projects/../auth/token', '/projects?access_token=secret'])('rejects unsafe or authentication path %s', async path => {
    const f = fixture(); await f.pair(); const count = f.calls.length;
    await expect(f.transport.request('GET', path)).rejects.toThrow('REQUEST_PATH_INVALID'); expect(f.calls).toHaveLength(count);
  });

  it('permits only the explicit POST logout operation and never replays it', async () => {
    const f = fixture(); await f.pair(); const operationId = randomUUID();
    await f.transport.request('POST', '/auth/logout', { operationId });
    const call = f.calls.at(-1)!;
    expect(call.url.pathname).toBe('/prefix/api/v2/auth/logout');
    expect(JSON.parse(call.body!.toString())).toEqual({ operationId });
    await expect(f.transport.request('GET', '/auth/logout')).rejects.toThrow('REQUEST_PATH_INVALID');
    expect(f.calls.filter(request => request.url.pathname.endsWith('/auth/logout'))).toHaveLength(1);
  });

  it('keeps secure WSS headers/options, resumes before events, and hides socket errors', async () => {
    const f = fixture(); await f.transport.connect('https://gateway.example/base/'); await f.transport.pair(code, 'Fixture Desktop');
    const messages: unknown[] = []; const closed = vi.fn();
    const close = await f.transport.openEvents({ epoch, afterSeq: 7 }, message => messages.push(message), closed);
    const ws = f.sockets[0];
    expect(ws.url.href).toBe('wss://gateway.example/base/api/v2/events');
    expect(ws.options).toMatchObject({ rejectUnauthorized: true, followRedirects: false, headers: { authorization: `Bearer ${token}`, 'x-oraculum-protocol': '2' } });
    ws.socket.emit('open'); expect(ws.socket.sent).toEqual([{ type: 'resume', epoch, afterSeq: 7 }]);
    ws.socket.message({ type: 'connection', installationId, epoch, headSeq: 8, resetRequired: false });
    ws.socket.message({ installationId, epoch, seq: 8, kind: 'native.state', scope: {}, payload: {}, impact: 'state' });
    expect(messages).toHaveLength(2);
    ws.socket.emit('error', new Error('PRIVATE_SOCKET_MESSAGE'));
    expect(closed).toHaveBeenCalledOnce(); expect(closed.mock.calls[0][0].message).toBe('EVENTS_CLOSED');
    close(); expect(closed).toHaveBeenCalledOnce();
  });

  it.each(['preconnection', 'wrong-installation', 'binary', 'invalid'])('closes unsafe WS message: %s', async variant => {
    const f = fixture(); await f.pair(); const closed = vi.fn(); const message = vi.fn();
    await f.transport.openEvents({}, message, closed); const socket = f.sockets[0].socket;
    if (variant !== 'preconnection') socket.message({ type: 'connection', installationId, epoch, headSeq: 0, resetRequired: false });
    socket.message({ installationId: variant === 'wrong-installation' ? randomUUID() : installationId, epoch, seq: variant === 'invalid' ? -1 : 1, kind: 'native.state', scope: {}, payload: {} }, variant === 'binary');
    expect(socket.terminated).toBe(true); expect(closed.mock.calls[0][0].code).toBe('EVENT_INVALID');
    expect(message).toHaveBeenCalledTimes(variant === 'preconnection' ? 0 : 1);
  });

  it('closes idle WS and locally cancelled WS without invoking application reconnect', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.pair(); const closed = vi.fn();
    const close = await f.transport.openEvents({}, () => {}, closed);
    close(); expect(f.sockets[0].socket.terminated).toBe(true); expect(closed).not.toHaveBeenCalled();
    await f.transport.openEvents({}, () => {}, closed);
    f.advance(15_001); await vi.advanceTimersByTimeAsync(15_001);
    expect(closed.mock.calls[0][0].code).toBe('EVENTS_TIMEOUT');
  });

  it('uploads only fixed metadata headers and exact bytes; verifies binary download digest', async () => {
    const f = fixture(); await f.pair(); const bytes = Buffer.from('attachment fixture');
    const metadata = { ...fixtureValue('AttachmentUploadMetadata'), threadId: 'thread-1', size: bytes.length };
    const encoded = Buffer.from(JSON.stringify(metadata)).toString('base64url');
    await f.transport.requestBytes('POST', '/threads/thread-1/attachments', { body: bytes, headers: { 'X-Oraculum-Upload': encoded } });
    expect(f.calls.at(-1)).toMatchObject({ method: 'POST', body: bytes, headers: { 'content-length': String(bytes.length), 'content-type': 'application/octet-stream', 'x-oraculum-upload': encoded } });
    const digest = `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
    f.override(() => ({ status: 200, bytes, headers: { 'content-type': 'text/plain', 'content-length': String(bytes.length), 'content-digest': digest, 'content-disposition': "attachment; filename*=UTF-8''fixture.txt" } }));
    const downloaded = await f.transport.requestBytes('GET', '/files/file-1/content');
    expect(downloaded.bytes).toEqual(bytes);
    expect(downloaded.headers['content-disposition']).toBe("attachment; filename*=UTF-8''fixture.txt");
    expect(f.calls.at(-1)!.maxBytes).toBe(64 * 1024 * 1024);
    f.override(() => ({ status: 200, bytes, headers: { 'content-digest': 'sha-256=:wrong:' } }));
    await expect(f.transport.requestBytes('GET', '/files/file-1/content')).rejects.toThrow('FILE_DIGEST_MISMATCH');
    await expect(f.transport.requestBytes('POST', '/threads/thread-1/attachments', { body: bytes, headers: { authorization: 'Bearer injected' } })).rejects.toThrow('INVALID_REQUEST');
    await expect(f.transport.requestBytes('POST', '/threads/thread-other/attachments', { body: bytes, headers: { 'x-oraculum-upload': encoded } })).rejects.toThrow('INVALID_REQUEST');
  });
});
