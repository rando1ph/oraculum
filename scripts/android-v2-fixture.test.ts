import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { createAndroidFixtureProxy } from './android-v2-fixture';

describe('Android test-only loopback transport controls', () => {
  let directory: string, proxy: Awaited<ReturnType<typeof createAndroidFixtureProxy>>;
  let other: Awaited<ReturnType<typeof createAndroidFixtureProxy>>;
  let writes = 0;
  const upstream = createServer((req, res) => {
    if (req.method === 'POST') writes++;
    req.resume();
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ forwarded: req.headers['x-forwarded-proto'] })); });
  });
  const ws = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (req, socket, head) => ws.handleUpgrade(req, socket, head, client => {
    client.on('message', data => client.send(data));
  }));
  const get = (origin: string, ca?: Buffer, method = 'GET', path = '/') => new Promise<string>((yes, no) => {
    const req = request(new URL(path, origin), { ca, method, agent: false }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', value => body += value);
      response.once('error', no); response.once('end', () => yes(body));
    });
    req.setTimeout(3000, () => req.destroy(new Error('Test timeout'))); req.once('error', no); req.end();
  });
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'oraculum-android-proxy-test-'));
    await new Promise<void>(yes => upstream.listen(0, '127.0.0.1', yes));
    const port = (upstream.address() as AddressInfo).port;
    proxy = await createAndroidFixtureProxy(directory, port);
    other = await createAndroidFixtureProxy(directory, port, 'other');
  }, 15_000);
  afterAll(async () => {
    for (const client of ws.clients) client.terminate();
    await proxy?.close(); await other?.close();
    await new Promise<void>(yes => ws.close(() => yes()));
    await new Promise<void>(yes => upstream.close(() => yes()));
    await rm(directory, { recursive: true, force: true });
  });
  it('validates a per-run certificate and rejects absent or unrelated trust', async () => {
    expect(JSON.parse(await get(proxy.origin, proxy.cert))).toEqual({ forwarded: 'https' });
    await expect(get(proxy.origin)).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    await expect(get(other.origin, proxy.cert)).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    expect((await stat(join(directory, 'tls', 'key.pem'))).mode & 0o777).toBe(0o600);
  });
  it('forwards WSS, closes existing streams offline, and restores transport', async () => {
    const socket = new WebSocket(proxy.origin.replace('https:', 'wss:') + '/events', { ca: proxy.cert });
    await new Promise<void>((yes, no) => { socket.once('open', yes); socket.once('error', no); });
    const received = new Promise<string>(yes => socket.once('message', data => yes(data.toString())));
    socket.send('fixture-echo'); expect(await received).toBe('fixture-echo');
    const closed = new Promise<void>(yes => socket.once('close', () => yes()));
    proxy.setOnline(false); await closed;
    await expect(get(proxy.origin, proxy.cert)).rejects.toThrow();
    proxy.setOnline(true);
    expect(JSON.parse(await get(proxy.origin, proxy.cert))).toEqual({ forwarded: 'https' });
  });
  it('drops only the selected write acknowledgement after one upstream request', async () => {
    const path = '/android-poc/api/v2/threads/fixture-thread/turns';
    proxy.dropNextTurnAck(); const before = writes;
    await expect(get(proxy.origin, proxy.cert, 'POST', path)).rejects.toThrow();
    expect(writes - before).toBe(1); expect(proxy.status().droppedTurnAcks).toBe(1);
    expect(proxy.status().online).toBe(true);
    expect(JSON.parse(await get(proxy.origin, proxy.cert))).toEqual({ forwarded: 'https' });
  });
  it('drops a real write response and disconnects until explicit recovery', async () => {
    const socket = new WebSocket(proxy.origin.replace('https:', 'wss:') + '/events', { ca: proxy.cert });
    await new Promise<void>((yes, no) => { socket.once('open', yes); socket.once('error', no); });
    const closed = new Promise<void>(yes => socket.once('close', () => yes()));
    const path = '/android-poc/api/v2/threads/fixture-thread/turns';
    proxy.dropNextWriteResponse(path); const before = writes;
    await expect(get(proxy.origin, proxy.cert, 'POST', path)).rejects.toThrow();
    await closed;
    expect(writes - before).toBe(1); expect(proxy.status().droppedWrites).toBe(1);
    expect(proxy.status().online).toBe(false);
    await expect(get(proxy.origin, proxy.cert)).rejects.toThrow();
    proxy.setOnline(true);
    expect(JSON.parse(await get(proxy.origin, proxy.cert))).toEqual({ forwarded: 'https' });
  });
  it('corrupts only one selected file response without changing its integrity metadata', async () => {
    proxy.faultNextDownload('digest');
    expect(JSON.parse(await get(proxy.origin, proxy.cert))).toEqual({ forwarded: 'https' });
    const path = '/android-phase3/api/v2/files/fixture-grant/content';
    const original = await get(proxy.origin, proxy.cert, 'GET', path);
    expect(original[0]).not.toBe('{');
    expect(proxy.status().faultedDownloads).toBe(1);
    expect(JSON.parse(await get(proxy.origin, proxy.cert, 'GET', path))).toEqual({ forwarded: 'https' });
  });
  it('interrupts one file response while preserving the next download', async () => {
    proxy.faultNextDownload('truncate');
    const path = '/android-phase3/api/v2/files/fixture-grant/content';
    await expect(get(proxy.origin, proxy.cert, 'GET', path)).rejects.toThrow();
    expect(proxy.status().faultedDownloads).toBe(2);
    expect(JSON.parse(await get(proxy.origin, proxy.cert, 'GET', path))).toEqual({ forwarded: 'https' });
  });
});
