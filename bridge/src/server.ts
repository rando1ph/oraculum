import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import type { BridgeService } from './service';
import type { BridgeEvent, WireMessage } from '../../packages/shared/protocol';
import type { TrustStore } from './trust-store';

export async function createServer(service: BridgeService, port: number, webRoot: string,
  options: { trust?: TrustStore; remoteOrigin?: string; testOnlyUnauthenticated?: boolean } = {}) {
  if (!options.trust && !options.testOnlyUnauthenticated) throw new Error('Device trust is required; unauthenticated mode is only for explicit loopback test fixtures');
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const { trust } = options;
  const remote = options.remoteOrigin ? new URL(options.remoteOrigin) : undefined;
  if (remote && (!trust || remote.protocol !== 'https:' || remote.username || remote.password ||
      remote.pathname !== '/' || remote.search || remote.hash || remote.hostname === '127.0.0.1' || remote.hostname === 'localhost')) {
    throw new Error('Remote access requires trust and an exact HTTPS origin');
  }
  const requestOrigin = (headers: Record<string, unknown>) => headers.host === host ? origin : remote?.origin ?? '';
  const cookieName = (source: string) => source === origin ? 'oraculum_local' : '__Host-oraculum';
  const tokenFrom = (headers: Record<string, unknown>, source: string) => {
    if (typeof headers.cookie !== 'string') return undefined;
    const values = headers.cookie.split(';').map(v => v.trim()).filter(v => v.startsWith(`${cookieName(source)}=`));
    return values.length === 1 ? values[0].slice(cookieName(source).length + 1) : undefined;
  };
  const sessionCookie = (source: string, token: string, seconds = 86400) =>
    `${cookieName(source)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${source === origin ? '' : '; Secure'}`;
  app.addHook('onRequest', async (request, reply) => {
    const source = requestOrigin(request.headers);
    const isRemote = !!remote && request.headers.host === remote.host;
    // Forwarding headers are never sufficient to select a trusted Host. The
    // reverse proxy must overwrite X-Forwarded-Proto, and only loopback listens.
    if ((request.headers.host !== host && !isRemote) ||
      (isRemote && request.headers['x-forwarded-proto'] !== 'https') ||
      (request.headers.origin && request.headers.origin !== source) ||
      request.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send({ error: 'Untrusted Host, Origin or transport' });
    }
  });
  app.addHook('onSend', async (_request, reply) => {
    // CodeMirror inserts stylesheet rules and inline geometry; script policy stays strict.
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-store');
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  app.get('/health', async () => ({ protocol: 1, mode: trust ? 'authenticated' : 'local-test' }));
  app.get('/auth/session', async (request, reply) => {
    if (!trust) return { authenticated: true, mode: 'local-test' };
    const source = requestOrigin(request.headers);
    const device = trust.authenticate(tokenFrom(request.headers, source), source);
    if (!device) return reply.code(401).send({ error: 'Pair this device' });
    return { authenticated: true, device };
  });
  let failures = 0;
  let windowStart = Date.now();
  app.post('/auth/pair', async (request, reply) => {
    const source = requestOrigin(request.headers);
    if (!trust || request.headers.origin !== source) return reply.code(403).send({ error: 'Pairing unavailable' });
    if (Date.now() - windowStart > 60_000) { failures = 0; windowStart = Date.now(); }
    if (failures >= 5) return reply.code(429).send({ error: 'Too many attempts; wait one minute' });
    const body = request.body as { code?: unknown; label?: unknown } | null;
    try {
      const { token, device } = trust.pair(body?.code, body?.label, source);
      reply.header('Set-Cookie', sessionCookie(source, token));
      return { authenticated: true, device };
    } catch {
      failures++;
      return reply.code(401).send({ error: 'Invalid or expired pairing code' });
    }
  });
  app.post('/auth/logout', async (request, reply) => {
    const source = requestOrigin(request.headers);
    if (request.headers.origin !== source) return reply.code(403).send({ error: 'Origin required' });
    const device = trust?.authenticate(tokenFrom(request.headers, source), source);
    if (device) trust!.revoke(device.id);
    reply.header('Set-Cookie', sessionCookie(source, '', 0));
    return { loggedOut: true };
  });
  app.get('/ws', {
    websocket: true,
    preValidation: async (request, reply) => {
      const source = requestOrigin(request.headers);
      if (request.headers.origin !== source) return reply.code(403).send({ error: 'Origin required' });
      if (trust && !trust.authenticate(tokenFrom(request.headers, source), source)) {
        return reply.code(401).send({ error: 'Device authentication required' });
      }
    },
  }, (socket, request) => {
    const source = requestOrigin(request.headers);
    const token = tokenFrom(request.headers, source);
    const deviceId = trust?.authenticate(token, source)?.id;
    const authorized = () => !trust || !!trust.authenticate(token, source);
    const forward = (event: BridgeEvent) => {
      if (!authorized()) { socket.close(1008, 'Device trust expired or revoked'); return; }
      if (socket.readyState === 1) socket.send(JSON.stringify(event));
    };
    service.on('event', forward);
    const timer = trust ? setInterval(() => { if (!authorized()) socket.close(1008, 'Device trust expired or revoked'); }, 1000) : undefined;
    socket.on('close', () => { service.off('event', forward); if (timer) clearInterval(timer); });
    socket.on('error', () => {}); // Closing a GUI must not stop the App Server.
    const seen = new Set<string>();
    socket.on('message', async bytes => {
      if (!authorized()) { socket.close(1008, 'Device trust expired or revoked'); return; }
      let request: WireMessage;
      try {
        request = JSON.parse(bytes.toString()) as WireMessage;
        if (!request || typeof request.id !== 'string' || !request.method ||
          !request.params || typeof request.params !== 'object' || Array.isArray(request.params)) throw new Error('Invalid request');
      } catch { socket.close(1008, 'Invalid request'); return; }
      if (seen.has(String(request.id)) || seen.size >= 500) { socket.close(1008, 'Duplicate ID or request limit'); return; }
      seen.add(String(request.id));
      let response: WireMessage;
      try { response = { id: request.id, result: await service.dispatch(request.method!, request.params!, deviceId ? { deviceId } : undefined) }; }
      catch (error) { response = { id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : 'Request failed' } }; }
      if (authorized() && socket.readyState === 1) socket.send(JSON.stringify(response));
    });
  });
  if (existsSync(webRoot)) await app.register(staticFiles, { root: webRoot });
  return app;
}
