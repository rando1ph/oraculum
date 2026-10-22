import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TrustStore } from './trust-store';
import { ProjectDirectories } from './projects';
import { BridgeService } from './service';
import { createServer } from './server';

it('keeps browsing and registry behind paired sockets, broadcasts changes and denies HTTP path tricks', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'oraculum-project-http-'));
  const root = join(temp, 'Projects'), cwd = join(root, 'local'), added = join(root, 'existing');
  await mkdir(cwd, { recursive: true }); await mkdir(added);
  const trust = new TrustStore(join(temp, 'state'));
  const projects = new ProjectDirectories(root, cwd, trust.db);
  await projects.register(cwd);
  const native = Object.assign(new EventEmitter(), { request: vi.fn(), send: vi.fn() });
  const service = new BridgeService(native, cwd, undefined, projects);
  const app = await createServer(service, 17864, '/missing', { trust, remoteOrigin: 'https://oraculum.example', remoteBasePath: '/console/' });
  await app.ready();
  const headers = { host: 'oraculum.example', origin: 'https://oraculum.example', 'x-forwarded-proto': 'https' };
  try {
    await expect(app.injectWS('/console/ws', { headers })).rejects.toThrow('401');
    for (const path of ['/console/bridge/browse?path=/etc', '/console/bridge/registerProject?path=/etc', '/console/%2e%2e/etc/passwd', '/console/../ws']) {
      expect((await app.inject({ url: path, headers })).statusCode).toBeGreaterThanOrEqual(400);
    }
    const pair = () => trust.pair(trust.createPairing().code, 'test', 'https://oraculum.example/console/');
    const first = pair(), second = pair();
    const socket = await app.injectWS('/console/ws', { headers: { ...headers, cookie: `__Secure-oraculum_session=${first.token}` } });
    const peer = await app.injectWS('/console/ws', { headers: { ...headers, cookie: `__Secure-oraculum_session=${second.token}` } });
    const request = (method: string, params: object): Promise<any> => new Promise(resolve => {
      const id = randomUUID();
      const listen = (bytes: unknown) => { const value = JSON.parse(String(bytes)); if (value.id === id) { socket.off('message', listen); resolve(value); } };
      socket.on('message', listen); socket.send(JSON.stringify({ id, method, params }));
    });
    expect((await request('bridge/browse', { path: root })).result.directories).toContainEqual({ name: 'existing', cwd: added });
    expect((await request('thread/start', { cwd: added })).error.message).toContain('registered');
    const changed = once(peer, 'message');
    expect((await request('bridge/registerProject', { path: added })).result.cwd).toBe(added);
    expect(JSON.parse(String((await changed)[0]))).toEqual({ type: 'projectsChanged' });
    expect((await request('bridge/projects', {})).result.projects).toContainEqual({ name: 'existing', cwd: added, available: true });
    expect((await request('bridge/registerProject', { path: '/etc' })).error).toBeTruthy();
    await request('bridge/unregisterProject', { cwd: added });
    expect((await request('thread/start', { cwd: added })).error.message).toContain('registered');
    expect(native.request).not.toHaveBeenCalled();
    trust.revoke(first.device.id);
    const closed = once(socket, 'close');
    socket.send(JSON.stringify({ id: randomUUID(), method: 'bridge/registerProject', params: { path: added } }));
    await closed;
    expect((await projects.list()).projects.some(p => p.cwd === added)).toBe(false);
    socket.terminate(); peer.terminate();
  } finally { await app.close(); trust.close(); await rm(temp, { recursive: true, force: true }); }
});
