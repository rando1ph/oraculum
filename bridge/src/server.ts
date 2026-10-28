import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { basePath, httpsOrigin } from '../../packages/shared/entry';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { BridgeService } from './service';
import type { BridgeEvent, WireMessage } from '../../packages/shared/protocol';
import type { TrustStore } from './trust-store';
import type { Themes } from './themes';
import type { Readable } from 'node:stream';
import { attachmentLimits } from '../../packages/shared/attachments';

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
  // Browser persistence is bounded; valid HTTP session checks renew the cookie.
  // Server-side device trust remains independently revocable without an expiry.
  const cookieLifetimeSeconds = 365 * 24 * 60 * 60;
  const sessionCookie = (source: string, token: string, seconds = cookieLifetimeSeconds) =>
    `${cookieName(source)}=${token}; HttpOnly; SameSite=Strict; Path=${entryBase(source)}; Max-Age=${seconds}${source === origin ? '' : '; Secure'}`;
  // Moving from / (or a parent path) must not leave two same-named cookies
  // attached to every request. Only this application's obsolete scopes expire.
  const ancestors = remoteBase.slice(0, -1).split('/').slice(0, -1)
    .map((_, index, parts) => parts.slice(0, index + 1).join('/') + '/');
  const cookies = (source: string, token: string, seconds = cookieLifetimeSeconds) => source === origin
    ? sessionCookie(source, token, seconds)
    : [sessionCookie(source, token, seconds), '__Host-oraculum=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
      ...ancestors.map(path => `${cookieName(source)}=; Secure; HttpOnly; SameSite=Strict; Path=${path}; Max-Age=0`)];
  let closing = false;
  const connections = new Set<() => void>();
  let cleaning: Promise<void> | undefined;
  const cleanupTimer = service.attachments ? setInterval(() => {
    if (!cleaning) cleaning = service.attachments!.cleanup().catch(() => {}).finally(() => { cleaning = undefined; });
  }, 60000) : undefined;
  cleanupTimer?.unref();
  app.addHook('preClose', async () => {
    closing = true;
    if (cleanupTimer) clearInterval(cleanupTimer);
    for (const cleanup of connections) cleanup();
    await cleaning;
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
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    reply.header('X-Content-Type-Options', 'nosniff');
    // Only explicitly cacheable successful resources may override the default.
    // Errors and responses issuing credentials must never enter a cache.
    if (reply.statusCode >= 400 || reply.hasHeader('Set-Cookie') || !reply.hasHeader('Cache-Control')) {
      reply.header('Cache-Control', 'no-store');
    }
  });
  const themeResponse = (request: FastifyRequest, reply: FastifyReply, body: string | Buffer) => {
    // Called only after device authentication and complete package validation.
    // Hash the actual representation: bundle CSS differs between entry paths.
    const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
    reply.header('Cache-Control', 'private, no-cache').header('Vary', 'Cookie, Origin').header('ETag', etag);
    const candidates = request.headers['if-none-match']?.split(',').map(value => value.trim().replace(/^W\//, ''));
    if (candidates?.some(value => value === '*' || value === etag)) return reply.code(304).send();
    return reply.send(body);
  };
  let failures = 0;
  let windowStart = Date.now();
  for (const base of new Set(['/', ...(remote ? [remoteBase] : [])])) {
    const config = { appBase: base };
    app.get(base + 'health', { config }, async (_request, reply) => {
      if (closing || ('alive' in service.codex && service.codex.alive === false)) {
        return reply.code(503).send({ error: 'Codex App Server unavailable' });
      }
      return { protocol: 1, mode: trust ? 'authenticated' : 'local-test' };
    });
    app.get(base + 'auth/session', { config }, async (request, reply) => {
      if (!trust) return { authenticated: true, mode: 'local-test' };
      const source = requestOrigin(request.headers);
      const token = tokenFrom(request.headers, source);
      const device = trust.authenticate(token, scope(source));
      if (!device) return reply.code(401).send({ error: 'Pair this device' });
      reply.header('Set-Cookie', cookies(source, token!));
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
    // Encapsulated raw stream parser: ordinary JSON and WS stay at 64 KiB.
    await app.register(async uploads => {
      uploads.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
      const auth = async (request: FastifyRequest, reply: FastifyReply) => {
        const source = requestOrigin(request.headers);
        if (request.headers.origin !== source || request.headers['x-oraculum-upload'] !== '1') return reply.code(403).header('Connection', 'close').send({ error: 'Origin and upload CSRF header required' });
        if (!service.attachments) return reply.code(503).send({ error: '附件上传不可用。' });
        if (trust && !trust.authenticate(tokenFrom(request.headers, source), scope(source))) return reply.code(401).header('Connection', 'close').send({ error: 'Device authentication required' });
      };
      const context = (request: FastifyRequest) => {
        const source = requestOrigin(request.headers), token = tokenFrom(request.headers, source);
        return { deviceId: trust?.authenticate(token, scope(source))?.id ?? 'local-test',
          isAuthorized: () => !closing && (!trust || !!trust.authenticate(token, scope(source))) };
      };
      const metadata = (request: FastifyRequest) => {
        const value = request.headers['x-oraculum-file'];
        if (typeof value !== 'string' || value.length > 8192) throw new Error('附件元数据无效。');
        const parsed: unknown = JSON.parse(decodeURIComponent(value));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('附件元数据无效。');
        return parsed as Record<string, unknown>;
      };
      uploads.post(base + 'attachments', { config, onRequest: auth, bodyLimit: attachmentLimits.fileBytes }, async (request, reply) => {
        const stream = request.body as Readable;
        const cleanup = () => stream?.destroy(new Error('Bridge stopping'));
        connections.add(cleanup);
        try {
          const meta = metadata(request);
          if (request.headers['content-type'] !== 'application/octet-stream' || !stream || typeof stream[Symbol.asyncIterator] !== 'function' ||
            request.headers['content-length'] !== undefined && Number(request.headers['content-length']) !== meta.size) throw new Error('附件大小或传输格式无效。');
          return await service.uploadAttachment(meta, stream, context(request));
        } catch (error) {
          return reply.code(400).header('Connection', 'close').send({ error: error instanceof Error && !('code' in error) ? error.message : '附件上传失败。' });
        } finally { connections.delete(cleanup); }
      });
      uploads.post(base + 'attachments/remove', { config, onRequest: auth }, async (request, reply) => {
        try { return await service.removeAttachment(request.body as Record<string, unknown>, context(request)); }
        catch (error) { return reply.code(400).send({ error: error instanceof Error && !('code' in error) ? error.message : '附件移除失败。' }); }
      });
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
      try {
        const bundle = await options.themes.bundle(request.params.id, base);
        return themeResponse(request, reply.type('application/json'), JSON.stringify(bundle));
      }
      catch (error) { return reply.code(400).send({ error: options.themes.message(error) }); }
    });
    const themeAsset = async (request: FastifyRequest<{ Params: { id: string; '*': string } }>, reply: FastifyReply) => {
      if (!options.themes) return reply.code(404).send({ error: '主题不存在' });
      try {
        const asset = await options.themes.asset(request.params.id, 'assets/' + request.params['*']);
        return themeResponse(request, reply.type(asset.type), asset.bytes);
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
        try { response = { id: request.id, result: await service.dispatch(request.method!, request.params!, deviceId ? { deviceId, isAuthorized: authorized } : undefined) }; }
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
      // This build uses Vite's default assets/name-[hash:8].ext output. Keep
      // unversioned public files outside that reserved naming pattern.
      // Content hashes change the URL whenever a built asset changes.
      // HTML and unversioned files are always fetched; in particular, do not
      // allow a same-second Last-Modified comparison to keep an old entry page.
      const fingerprinted = /^assets\/[\w.-]+-[\w-]{8}\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|webp|avif|gif|ico|svg)$/.test(path);
      reply.header('Cache-Control', fingerprinted ? 'public, max-age=31536000, immutable' : 'no-store');
      if (!fingerprinted) {
        // @fastify/send can treat If-Modified-Since as fresh even without a
        // Last-Modified response header. Unversioned files need a full read.
        delete request.headers['if-modified-since'];
        delete request.headers['if-none-match'];
      }
      // No SPA fallback: missing API/resources must not return an HTML success.
      return reply.sendFile(path || 'index.html', { cacheControl: false, etag: fingerprinted, lastModified: fingerprinted });
    };
    app.get('/', serve);
    app.get('/*', serve);
  }
  return app;
}
