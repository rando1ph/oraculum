import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeGatewayIO, type GatewayHttpRequest } from './gateway-transport';

// Exercise the real Node adapter with injected node:http(s) constructors. These
// fixtures do not create a listening server or contact any Gateway/network.
const mocks = vi.hoisted(() => ({ http: vi.fn(), https: vi.fn() }));
vi.mock('node:http', () => ({ request: mocks.http }));
vi.mock('node:https', () => ({ request: mocks.https }));
afterEach(() => vi.clearAllMocks());

function requestFixture(secure = true, maxBytes = 1024) {
  const request = Object.assign(new EventEmitter(), { end: vi.fn() });
  const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'application/json' } as Record<string, string>, destroy: vi.fn() });
  let callback: (incoming: typeof response) => void;
  (secure ? mocks.https : mocks.http).mockImplementation((_url, _options, cb) => { callback = cb; return request; });
  const input: GatewayHttpRequest = { url: new URL(secure ? 'https://fixture.example/base/health' : 'http://127.0.0.1:43123/health'), method: 'GET', headers: { 'x-oraculum-protocol': '2' }, signal: new AbortController().signal, maxBytes, timeoutMs: 30_000 };
  return { input, request, response, receive: () => callback!(response) };
}

describe('Node Gateway IO security boundary without sockets', () => {
  it.each([true, false])('uses the selected protocol with explicit TLS checks and bounded headers (HTTPS=%s)', async secure => {
    const f = requestFixture(secure); const pending = nodeGatewayIO.request(f.input); f.receive();
    f.response.emit('data', Buffer.from('{}')); f.response.emit('end');
    expect((await pending).bytes.toString()).toBe('{}');
    expect((secure ? mocks.https : mocks.http).mock.calls[0][1]).toMatchObject({ rejectUnauthorized: true, maxHeaderSize: 32 * 1024, agent: false, signal: f.input.signal });
    expect((secure ? mocks.http : mocks.https)).not.toHaveBeenCalled();
    expect(f.request.end).toHaveBeenCalledWith(undefined);
  });

  it.each(['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID'])('refuses certificate failure %s without weakening verification or echoing details', async code => {
    const f = requestFixture(); const pending = nodeGatewayIO.request(f.input);
    f.request.emit('error', Object.assign(new Error('PRIVATE_HOST_AND_CREDENTIAL'), { code }));
    await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_FAILED', message: 'CONNECTION_FAILED' });
    expect(mocks.https).toHaveBeenCalledOnce(); expect(mocks.http).not.toHaveBeenCalled();
  });

  it('does not follow redirects or carry redirect location into returned headers', async () => {
    const f = requestFixture(); f.response.statusCode = 307; f.response.headers.location = 'https://other.invalid/';
    const pending = nodeGatewayIO.request(f.input); f.receive(); f.response.emit('end');
    expect(await pending).toEqual({ status: 307, headers: { 'content-type': 'application/json' }, bytes: Buffer.alloc(0) });
    expect(mocks.https).toHaveBeenCalledOnce();
  });

  it.each(['declared', 'streamed'])('stops oversized %s response without retaining unlimited bytes', async mode => {
    const f = requestFixture(true, 4);
    if (mode === 'declared') f.response.headers['content-length'] = '5';
    const pending = nodeGatewayIO.request(f.input); f.receive();
    if (mode === 'streamed') { f.response.emit('data', Buffer.from('abc')); f.response.emit('data', Buffer.from('def')); }
    await expect(pending).rejects.toThrow('RESPONSE_TOO_LARGE'); expect(f.response.destroy).toHaveBeenCalledOnce();
  });

  it('refuses incomplete/aborted bodies instead of returning a partial success', async () => {
    const f = requestFixture(); const pending = nodeGatewayIO.request(f.input); f.receive();
    f.response.emit('data', Buffer.from('{')); f.response.emit('aborted');
    await expect(pending).rejects.toThrow('CONNECTION_FAILED');
  });
});
