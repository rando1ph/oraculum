// Test-only HTTPS reverse proxy. Its one-run self-signed certificate is accepted
// only by the isolated test browser; no OS/Android trust settings are changed.
import { createServer } from 'node:https';
import { request } from 'node:http';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function loopbackTlsFixture(upstreamPort: number) {
  const dir = await mkdtemp(join(tmpdir(), 'oraculum-tls-fixture-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=oraculum-loopback-fixture', '-addext', 'subjectAltName=IP:127.0.0.2',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  const sockets = new Set<import('node:stream').Duplex>();
  const server = createServer({ key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) }, (req, res) => {
    const upstream = request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method,
      headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, reply => {
      res.writeHead(reply.statusCode!, reply.headers); reply.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, client, head) => {
    const upstream = connect(upstreamPort, '127.0.0.1', () => {
      const headers = { ...req.headers, 'x-forwarded-proto': 'https' };
      upstream.write(`GET ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.2', yes); });
  const port = (server.address() as import('node:net').AddressInfo).port;
  return {
    origin: `https://127.0.0.2:${port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(yes => server.close(() => yes()));
      await rm(dir, { recursive: true });
    },
  };
}
