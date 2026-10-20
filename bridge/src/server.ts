import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import type { BridgeService } from './service';
import type { BridgeEvent, WireMessage } from '../../packages/shared/protocol';

export async function createServer(service: BridgeService, port: number, webRoot: string) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.host !== host ||
      (request.headers.origin && request.headers.origin !== origin) ||
      request.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send({ error: 'Local same-origin access only' });
    }
  });
  app.addHook('onSend', async (_request, reply) => {
    // CodeMirror inserts stylesheet rules and inline geometry; script policy stays strict.
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-store');
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  app.get('/health', async () => ({ protocol: 1, mode: 'local', codex: '0.160.0' }));
  app.get('/ws', {
    websocket: true,
    preValidation: async (request, reply) => {
      if (request.headers.origin !== origin) return reply.code(403).send({ error: 'Origin required' });
    },
  }, socket => {
    const forward = (event: BridgeEvent) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(event));
    };
    service.on('event', forward);
    socket.on('close', () => service.off('event', forward));
    socket.on('error', () => {}); // Closing a GUI must not stop the App Server.
    const seen = new Set<string>();
    socket.on('message', async bytes => {
      let request: WireMessage;
      try {
        request = JSON.parse(bytes.toString()) as WireMessage;
        if (!request || typeof request.id !== 'string' || !request.method ||
          !request.params || typeof request.params !== 'object' || Array.isArray(request.params)) throw new Error('Invalid request');
      } catch { socket.close(1008, 'Invalid request'); return; }
      if (seen.has(String(request.id)) || seen.size >= 500) { socket.close(1008, 'Duplicate ID or request limit'); return; }
      seen.add(String(request.id));
      let response: WireMessage;
      try { response = { id: request.id, result: await service.dispatch(request.method!, request.params!) }; }
      catch (error) { response = { id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : 'Request failed' } }; }
      if (socket.readyState === 1) socket.send(JSON.stringify(response));
    });
  });
  if (existsSync(webRoot)) await app.register(staticFiles, { root: webRoot });
  return app;
}
