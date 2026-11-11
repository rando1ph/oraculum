/**
 * Opt-in Android PoC fixture backed by the real official Codex App Server.
 * Run: pnpm exec tsx scripts/android-v2-fixture.ts
 * stdout contains safe JSON metadata; pairing codes stay in CLI-created 0600 files.
 * Send newline-delimited JSON on stdin: {"command":"status"}, {"command":"pair"},
 * {"command":"devices"}, {"command":"revoke","deviceId":"..."},
 * {"command":"restartGateway"}, {"command":"offline"}, {"command":"online"},
 * {"command":"cut"}, {"command":"expireAccess"}, {"command":"dropNextTurnAck"},
 * {"command":"dropNextWriteResponse","path":"/android-poc/api/v2/threads/ID/turns"},
 * {"command":"stop"}. EOF / SIGINT / SIGTERM also stop the fixture.
 *
 * Use adb reverse tcp:<port> tcp:<port> and trust certPath only in the Debug app.
 * No OS trust, installed service, old application data, or Codex config is changed.
 * Dedicated native test threads remain in official Codex history for inspection.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, createServer as createNetServer, type AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Duplex } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { GatewayAuth } from '../gateway/src/auth';
import { runCli } from '../gateway/src/cli';
import { CodexAdapter, record } from '../gateway/src/codex';
import { loadGatewayConfig, validateGatewayConfig } from '../gateway/src/config';
import { createGatewayServer } from '../gateway/src/server';
import { GatewayService } from '../gateway/src/service';
import { GatewayStore, UUID_PATTERN } from '../gateway/src/store';

async function freePort() {
  const server = createNetServer();
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(yes => server.close(() => yes()));
  return port;
}

/** A loopback-only test proxy. TLS validation is performed normally by clients. */
export async function createAndroidFixtureProxy(root: string, upstreamPort: number, name = 'tls') {
  const directory = join(root, name);
  await mkdir(directory, { mode: 0o700 });
  const keyPath = join(directory, 'key.pem'), certPath = join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', '/CN=oraculum-android-fixture', '-addext', 'subjectAltName=IP:127.0.0.1,IP:10.0.2.2',
    '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
  await chmod(keyPath, 0o600); await chmod(certPath, 0o600);
  const cert = await readFile(certPath), sockets = new Set<Duplex>(), secureSockets = new Set<Duplex>();
  let online = true, dropNextTurnAck = false, droppedTurnAcks = 0;
  let droppedWrites = 0, pendingWriteDrop: string | undefined;
  const server = createHttpsServer({ key: await readFile(keyPath), cert }, (req, res) => {
    if (!online) { req.socket.destroy(); return; }
    const writeDrop = req.method === 'POST' && pendingWriteDrop !== undefined && req.url === pendingWriteDrop;
    const drop = writeDrop || (dropNextTurnAck && req.method === 'POST' && /\/api\/v2\/threads\/[^/]+\/turns$/.test(req.url ?? ''));
    if (drop) dropNextTurnAck = false;
    if (writeDrop) {
      pendingWriteDrop = undefined;
      // Disconnect WSS before dispatch so no operation receipt can resolve the
      // client's unknown state before the selected HTTP acknowledgement is lost.
      // Keep exactly this TLS socket alive until the real upstream responds.
      online = false;
      for (const socket of secureSockets) if (socket !== req.socket) socket.destroy();
    }
    const upstream = httpRequest({ hostname: '127.0.0.1', port: upstreamPort, path: req.url,
      method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, reply => {
      if (drop) {
        // The real Gateway has received the write. Only its HTTP acknowledgement
        // is discarded; native events / receipt queries remain authoritative.
        reply.resume(); reply.once('end', () => {
          if (writeDrop) {
            droppedWrites++; online = false;
            for (const socket of sockets) socket.destroy();
          } else { droppedTurnAcks++; res.destroy(); }
        });
      } else {
        reply.on('error', () => res.destroy()); res.writeHead(reply.statusCode!, reply.headers); reply.pipe(res);
      }
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.once('close', () => upstream.destroy()); req.once('aborted', () => upstream.destroy()); req.pipe(upstream);
  });
  server.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    if (!online) socket.destroy();
  });
  server.on('secureConnection', socket => {
    secureSockets.add(socket); socket.once('close', () => secureSockets.delete(socket));
    if (!online) socket.destroy();
  });
  server.on('upgrade', (req, client, head) => {
    if (!online) { client.destroy(); return; }
    const upstream = connect(upstreamPort, '127.0.0.1', () => {
      const headers = { ...req.headers, 'x-forwarded-proto': 'https' };
      upstream.write(`GET ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy()); upstream.on('close', () => client.destroy());
    client.on('error', () => upstream.destroy()); client.on('close', () => upstream.destroy());
  });
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const port = (server.address() as AddressInfo).port;
  const cut = () => { for (const socket of sockets) socket.destroy(); };
  return {
    origin: `https://127.0.0.1:${port}`, port, certPath, cert,
    cut, setOnline(value: boolean) { online = value; if (!online) cut(); },
    dropNextTurnAck() { dropNextTurnAck = true; },
    dropNextWriteResponse(path: string) { pendingWriteDrop = path; },
    status: () => ({ online, dropNextTurnAck, droppedTurnAcks, pendingWriteDrop, droppedWrites }),
    async close() { cut(); await new Promise<void>(yes => server.close(() => yes())); },
  };
}

export async function runAndroidFixture() {
  if (process.argv.length > 2) throw new Error('This opt-in fixture takes no command-line arguments');
  process.umask(0o077);
  const root = await mkdtemp(join(tmpdir(), 'oraculum-android-v2-'));
  const projectPath = join(root, 'project'), configPath = join(root, 'config', 'config.json');
  await mkdir(projectPath, { mode: 0o700 });
  await writeFile(join(projectPath, 'README.md'), '# Oraculum Android PoC isolated acceptance project\n', { mode: 0o600 });
  const nativeConfigPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
  const configHash = async () => {
    try { return createHash('sha256').update(await readFile(nativeConfigPath)).digest('hex'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const beforeConfig = await configHash(), upstreamPort = await freePort();
  const evidence: Record<string, unknown> = {
    startedAt: new Date().toISOString(), codexConfigBeforeSha256: beforeConfig,
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(),
    controls: [], result: 'running',
    limitations: ['Dedicated native threads remain in official Codex history.',
      'expireAccess advances only the injected GatewayAuth test clock; it is a controlled expiry test.',
      'Response-drop controls discard real Gateway responses; they do not simulate native execution.',
      'This loopback fixture does not exercise public proxies, physical devices, or production deployment.'],
  };
  const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  const cli = (args: string[]) => {
    const messages: string[] = [];
    runCli([...args, '--config', configPath], message => messages.push(message));
    return messages[0]!;
  };
  let proxy: Awaited<ReturnType<typeof createAndroidFixtureProxy>> | undefined;
  let wrongTls: Awaited<ReturnType<typeof createAndroidFixtureProxy>> | undefined;
  let store: GatewayStore | undefined, adapter: CodexAdapter | undefined, service: GatewayService | undefined;
  let app: Awaited<ReturnType<typeof createGatewayServer>> | undefined;
  let clockOffset = 0, stopping = false;
  const input = createInterface({ input: process.stdin, terminal: false });
  const onSignal = () => { stopping = true; input.close(); process.stdin.pause(); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  const shutdownGateway = async () => {
    proxy?.cut(); wrongTls?.cut();
    const oldApp = app, oldService = service, oldAdapter = adapter, oldStore = store;
    app = undefined; service = undefined; adapter = undefined; store = undefined;
    try { await oldApp?.close(); }
    finally { try { if (oldService) await oldService.close(); else await oldAdapter?.close(); } finally { oldStore?.close(); } }
  };
  try {
    proxy = await createAndroidFixtureProxy(root, upstreamPort);
    wrongTls = await createAndroidFixtureProxy(root, upstreamPort, 'untrusted-tls');
    // Exercise the same CLI initialization / pairing implementation as the user.
    cli(['init', '--state-dir', join(root, 'state'), '--root', `acceptance=${root}`, '--port', String(upstreamPort)]);
    const config = validateGatewayConfig({ ...loadGatewayConfig(configPath), externalOrigin: proxy.origin, basePath: '/android-poc/' });
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    const codexVersion = execFileSync(config.codexCommand, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    evidence.codexVersion = codexVersion;
    const boot = async () => {
      store = new GatewayStore(config.stateDir);
      adapter = new CodexAdapter({ cwd: projectPath, executable: config.codexCommand });
      await adapter.start();
      service = new GatewayService(store, config, adapter, { codexVersion,
        auth: new GatewayAuth(store, { now: () => Date.now() + clockOffset }) });
      app = await createGatewayServer(service, config);
      await app.listen({ host: config.host, port: config.port });
    };
    await boot();
    const paired = JSON.parse(cli(['pair'])) as { pairingFile: string; expiresAt: number };
    const metadata = {
      root, endpoint: proxy.origin + config.basePath, port: proxy.port, certPath: proxy.certPath,
      wrongTlsEndpoint: wrongTls.origin + config.basePath, wrongTlsPort: wrongTls.port,
      configPath, projectPath, allowedRoot: root, rootId: 'acceptance', projectRelativePath: 'project', installationId: store!.installationId,
      epoch: service!.epoch, pairingFile: paired.pairingFile, pairingExpiresAt: paired.expiresAt,
      adbReverse: `adb reverse tcp:${proxy.port} tcp:${proxy.port}`,
      transport: 'Loopback HTTPS/WSS with per-run certificate validation; no system trust changes',
    };
    const metadataPath = join(root, 'metadata.json');
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
    emit({ event: 'ready', metadataPath, ...metadata });
    const status = async () => {
      const operations = store!.db.prepare('SELECT operation_id AS operationId,kind,status,native_thread_id AS nativeThreadId,native_turn_id AS nativeTurnId FROM operations ORDER BY created_at').all();
      const threadIds = [...new Set(operations.map(op => op.nativeThreadId).filter((id): id is string => typeof id === 'string'))];
      const nativeThreads: unknown[] = [];
      for (const threadId of threadIds) {
        try {
          const { thread } = await adapter!.readThread(threadId, true, 5000);
          if (thread.cwd !== projectPath) throw new Error('Outside dedicated project');
          nativeThreads.push({ threadId, status: thread.status.type, turnCount: thread.turns.length,
            turns: thread.turns.map(turn => ({ turnId: turn.id, status: turn.status,
              itemCounts: turn.items.reduce<Record<string, number>>((counts, item) => { counts[item.type] = (counts[item.type] ?? 0) + 1; return counts; }, {}) })) });
        } catch { nativeThreads.push({ threadId, unavailable: true }); }
      }
      return { ...proxy!.status(), installationId: store!.installationId, epoch: service!.epoch,
        codexAlive: adapter!.alive, devices: store!.listDevices(), projects: store!.listProjects().map(p => ({ id: p.id, available: p.unregisteredAt === null })),
        operations, operationCounts: store!.db.prepare('SELECT kind,status,COUNT(*) AS count FROM operations GROUP BY kind,status').all(),
        nativeThreads, codexConfigUnchanged: beforeConfig === await configHash() };
    };
    for await (const line of input) {
      if (stopping) break;
      try {
        if (line.length > 4096) throw new Error('Invalid control');
        const value: unknown = JSON.parse(line);
        if (!record(value) || typeof value.command !== 'string' || Object.keys(value).some(key => !['command', 'deviceId', 'path'].includes(key))) throw new Error('Invalid control');
        const command = value.command;
        let result: unknown;
        if (command === 'status') {
          result = await status();
        } else if (command === 'pair') {
          const nextPair = JSON.parse(cli(['pair'])) as { pairingFile: string; expiresAt: number };
          metadata.pairingFile = nextPair.pairingFile; metadata.pairingExpiresAt = nextPair.expiresAt;
          await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
          result = nextPair;
        }
        else if (command === 'devices') result = JSON.parse(cli(['devices', 'list']));
        else if (command === 'revoke') {
          if (typeof value.deviceId !== 'string' || !UUID_PATTERN.test(value.deviceId)) throw new Error('Invalid device ID');
          cli(['devices', 'revoke', value.deviceId]); result = { revoked: true, deviceId: value.deviceId };
        } else if (command === 'restartGateway') {
          const previousEpoch = service!.epoch;
          await shutdownGateway(); await boot();
          metadata.epoch = service!.epoch;
          await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
          result = { installationId: store!.installationId, previousEpoch, epoch: service!.epoch };
        } else if (command === 'offline' || command === 'online') {
          proxy.setOnline(command === 'online'); result = proxy.status();
        } else if (command === 'cut') { proxy.cut(); result = { interrupted: true }; }
        else if (command === 'expireAccess') { clockOffset += 11 * 60_000; result = { expired: true, method: 'injected GatewayAuth clock' }; }
        else if (command === 'dropNextTurnAck') { proxy.dropNextTurnAck(); result = proxy.status(); }
        else if (command === 'dropNextWriteResponse') {
          if (typeof value.path !== 'string' || !/^\/android-poc\/api\/v2\/(threads\/[A-Za-z0-9-]+\/turns|projects\/[A-Za-z0-9-]+\/threads)$/.test(value.path)) throw new Error('Unsupported write path');
          proxy.dropNextWriteResponse(value.path); result = proxy.status();
        }
        else if (command === 'stop') { stopping = true; emit({ event: 'control', command, result: { stopping: true } }); break; }
        else throw new Error('Unsupported control');
        (evidence.controls as unknown[]).push({ command, at: new Date().toISOString() });
        emit({ event: 'control', command, result });
      } catch (error) {
        // Never echo controller input, native errors, HTTP bodies, or credentials.
        emit({ event: 'controlError', code: record(error) && typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'CONTROL_FAILED' });
      }
    }
    evidence.finalStatus = await status();
    evidence.result = 'stopped';
  } catch (error) {
    evidence.result = 'failed';
    evidence.errorCode = record(error) && typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'FIXTURE_FAILED';
    process.exitCode = 1;
  } finally {
    stopping = true; input.close(); process.stdin.pause();
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    const cleanupErrors: string[] = [];
    for (const [name, cleanup] of [['gateway', shutdownGateway], ['tls', () => proxy?.close()], ['untrustedTls', () => wrongTls?.close()]] as const) {
      try { await cleanup(); } catch { cleanupErrors.push(name); }
    }
    evidence.codexConfigAfterSha256 = await configHash();
    evidence.codexConfigUnchanged = beforeConfig === evidence.codexConfigAfterSha256;
    evidence.finishedAt = new Date().toISOString(); evidence.cleanupErrors = cleanupErrors;
    if (cleanupErrors.length || !evidence.codexConfigUnchanged) { evidence.result = 'failed'; process.exitCode = 1; }
    const reportPath = join(root, 'fixture-report.json');
    await writeFile(reportPath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    emit({ event: 'stopped', result: evidence.result, reportPath, codexConfigUnchanged: evidence.codexConfigUnchanged, cleanupErrors });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runAndroidFixture().catch(() => { process.stderr.write('Android fixture could not initialize safely.\n'); process.exitCode = 1; });
}
