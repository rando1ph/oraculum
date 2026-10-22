import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { basePath, httpsOrigin } from '../../packages/shared/entry';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import type { BridgeService } from './service';
import type { BridgeEvent, WireMessage } from '../../packages/shared/protocol';
import type { TrustStore } from './trust-store';
import type { Themes } from './themes';

export async function createServer(service: BridgeService, port: number, webRoot: string,
  options: { trust?: TrustStore; themes?: Themes; remoteOrigin?: string; remoteBasePath?: string; testOnlyUnauthenticated?: boolean } = {}) {
  if (!options.trust && !options.testOnlyUnauthenticated) throw new Error('Device trust is required; unauthenticated mode is only for explicit loopback test fixtures');
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const { trust } = options;
  const remote = options.remoteOrigin ? new URL(httpsOrigin(options.remoteOrigin)) : undefined;
  const remoteBase = basePath(options.remoteBasePath);
  if (remote && (!trust || remote.hostname === '127.0.0.1' || remote.hostname === 'localhost')) {
    throw new Error('Remote access requires trust and an exact HTTPS origin');
  }
  if (!remote && remoteBase !== '/') throw new Error('Remote Base Path requires a remote origin');
  const requestOrigin = (headers: Record<string, unknown>) => headers.host === host ? origin : remote?.origin ?? '';
  const entryBase = (source: string) => source === origin ? '/' : remoteBase;
  // A changed subpath requires pairing again, even on the same host.
  const scope = (source: string) => entryBase(source) === '/' ? source : source + entryBase(source);
  const cookieName = (source: string) => source === origin ? 'oraculum_local' : '__Secure-oraculum_session';
  const tokenFrom = (headers: Record<string, unknown>, source: string) => {
    if (typeof headers.cookie !== 'string') return undefined;
    const values = headers.cookie.split(';').map(v => v.trim()).filter(v => v.startsWith(`${cookieName(source)}=`));
    return values.length === 1 ? values[0].slice(cookieName(source).length + 1) : undefined;
  };
  const sessionCookie = (source: string, token: string, seconds = 86400) =>
    `${cookieName(source)}=${token}; HttpOnly; SameSite=Strict; Path=${entryBase(source)}; Max-Age=${seconds}${source === origin ? '' : '; Secure'}`;
  // Moving from / (or a parent path) must not leave two same-named cookies
  // attached to every request. Only this application's obsolete scopes expire.
  const ancestors = remoteBase.slice(0, -1).split('/').slice(0, -1)
    .map((_, index, parts) => parts.slice(0, index + 1).join('/') + '/');
  const cookies = (source: string, token: string, seconds = 86400) => source === origin
    ? sessionCookie(source, token, seconds)
    : [sessionCookie(source, token, seconds), '__Host-oraculum=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
      ...ancestors.map(path => `${cookieName(source)}=; Secure; HttpOnly; SameSite=Strict; Path=${path}; Max-Age=0`)];
  let closing = false;
  const connections = new Set<() => void>();
  app.addHook('preClose', async () => {
    closing = true;
    for (const cleanup of connections) cleanup();
  });
  // Mark upgraded requests before any rejecting hook. The plugin's onResponse
  // must close rejected upgrade sockets; they cannot serve pooled HTTP traffic.
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
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
    const path = (request.raw.url ?? '').split('?')[0];
    if (!/^\/[A-Za-z0-9._~/-]*$/.test(path) || path.includes('//') ||
        path.split('/').some(part => part === '.' || part === '..')) {
      return reply.code(400).send({ error: 'Non-canonical path' });
    }
    const base = entryBase(source);
    if (base !== '/' && path === base.slice(0, -1)) return reply.code(308).header('Location', base).send();
    const routeBase = (request.routeOptions.config as { appBase?: string }).appBase;
    if (!path.startsWith(base) || (routeBase !== undefined && routeBase !== base)) {
      return reply.code(404).send({ error: 'Outside configured application path' });
    }
  });
  app.addHook('onSend', async (_request, reply) => {
    // CodeMirror inserts stylesheet rules and inline geometry; script policy stays strict.
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-store');
  });
  let failures = 0;
  let windowStart = Date.now();
  for (const base of new Set(['/', ...(remote ? [remoteBase] : [])])) {
    const config = { appBase: base };
    app.get(base + 'health', { config }, async () => ({ protocol: 1, mode: trust ? 'authenticated' : 'local-test' }));
    app.get(base + 'auth/session', { config }, async (request, reply) => {
      if (!trust) return { authenticated: true, mode: 'local-test' };
      const source = requestOrigin(request.headers);
      const device = trust.authenticate(tokenFrom(request.headers, source), scope(source));
      if (!device) return reply.code(401).send({ error: 'Pair this device' });
      return { authenticated: true, device };
    });
    app.post(base + 'auth/pair', { config }, async (request, reply) => {
      const source = requestOrigin(request.headers);
      if (!trust || request.headers.origin !== source) return reply.code(403).send({ error: 'Pairing unavailable' });
      if (Date.now() - windowStart > 60_000) { failures = 0; windowStart = Date.now(); }
      if (failures >= 5) return reply.code(429).send({ error: 'Too many attempts; wait one minute' });
      const body = request.body as { code?: unknown; label?: unknown } | null;
      try {
        const { token, device } = trust.pair(body?.code, body?.label, scope(source));
        reply.header('Set-Cookie', cookies(source, token));
        return { authenticated: true, device };
      } catch {
        failures++;
        return reply.code(401).send({ error: 'Invalid or expired pairing code' });
      }
    });
    app.post(base + 'auth/logout', { config }, async (request, reply) => {
      const source = requestOrigin(request.headers);
      if (request.headers.origin !== source) return reply.code(403).send({ error: 'Origin required' });
      const device = trust?.authenticate(tokenFrom(request.headers, source), scope(source));
      if (device) trust!.revoke(device.id);
      reply.header('Set-Cookie', cookies(source, '', 0));
      return { loggedOut: true };
    });
    // Theme endpoints share the exact device trust and entry scope of the WS.
    // Installation takes a candidate directory name, never an arbitrary path.
    const themeAuth = async (request: FastifyRequest, reply: FastifyReply) => {
      const source = requestOrigin(request.headers);
      if (trust && !trust.authenticate(tokenFrom(request.headers, source), scope(source))) return reply.code(401).send({ error: 'Device authentication required' });
      if (request.method !== 'GET' && request.headers.origin !== source) return reply.code(403).send({ error: 'Origin required' });
    };
    const themeRoute = { config, preValidation: themeAuth };
    app.get(base + 'themes', themeRoute, async (_request, reply) => {
      try { return options.themes ? await options.themes.catalog() : { installed: [], sources: [] }; }
      catch (error) { return reply.code(400).send({ error: options.themes!.message(error) }); }
    });
    app.post(base + 'themes/install', themeRoute, async (request, reply) => {
      if (!options.themes) return reply.code(503).send({ error: '主题存储未配置' });
      try { return await options.themes.install((request.body as { directory?: unknown } | null)?.directory); }
      catch (error) { return reply.code(400).send({ error: options.themes.message(error) }); }
    });
    app.get<{ Params: { id: string } }>(base + 'themes/:id/bundle', themeRoute, async (request, reply) => {
      if (!options.themes) return reply.code(404).send({ error: '主题不存在' });
      try { return await options.themes.bundle(request.params.id, base); }
      catch (error) { return reply.code(400).send({ error: options.themes.message(error) }); }
    });
    const themeAsset = async (request: FastifyRequest<{ Params: { id: string; '*': string } }>, reply: FastifyReply) => {
      if (!options.themes) return reply.code(404).send({ error: '主题不存在' });
      try {
        const asset = await options.themes.asset(request.params.id, 'assets/' + request.params['*']);
        return reply.type(asset.type).send(asset.bytes);
      } catch (error) { return reply.code(400).send({ error: options.themes.message(error) }); }
    };
    app.get<{ Params: { id: string; '*': string } }>(base + 'themes/:id/assets/*', themeRoute, themeAsset);
    app.get(base + 'ws', {
      config,
      websocket: true,
      preValidation: async (request, reply) => {
        const source = requestOrigin(request.headers);
        if (request.headers.origin !== source) return reply.code(403).send({ error: 'Origin required' });
        if (trust && !trust.authenticate(tokenFrom(request.headers, source), scope(source))) {
          return reply.code(401).send({ error: 'Device authentication required' });
        }
      },
    }, (socket, request) => {
      const source = requestOrigin(request.headers);
      const token = tokenFrom(request.headers, source);
      const deviceId = trust?.authenticate(token, scope(source))?.id;
      const authorized = () => !closing && (!trust || !!trust.authenticate(token, scope(source)));
      const forward = (event: BridgeEvent) => {
        if (!authorized()) { socket.close(1008, 'Device trust expired or revoked'); return; }
        if (socket.readyState === 1) socket.send(JSON.stringify(event));
      };
      service.on('event', forward);
      const timer = trust ? setInterval(() => { if (!authorized()) socket.close(1008, 'Device trust expired or revoked'); }, 1000) : undefined;
      const cleanup = () => {
        service.off('event', forward);
        if (timer) clearInterval(timer);
        connections.delete(cleanup);
      };
      connections.add(cleanup);
      socket.on('close', cleanup);
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
  }
  if (existsSync(webRoot)) {
    await app.register(staticFiles, { root: webRoot, serve: false });
    const serve = async (request: FastifyRequest, reply: FastifyReply) => {
      const base = entryBase(requestOrigin(request.headers));
      const path = request.raw.url!.split('?')[0].slice(base.length);
      // No SPA fallback: missing API/resources must not return an HTML success.
      return reply.sendFile(path || 'index.html');
    };
    app.get('/', serve);
    app.get('/*', serve);
  }
  return app;
}
