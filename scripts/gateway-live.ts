/** Opt-in real official Codex acceptance; no installed service, old Gateway state or existing native thread is used. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { connect, createServer as createNetServer, type AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import WebSocket from 'ws';
import { GatewayStore, randomCredential } from '../gateway/src/store';
import { initGatewayConfig } from '../gateway/src/config';
import { CodexAdapter, CodexError, record } from '../gateway/src/codex';
import { GatewayService } from '../gateway/src/service';
import { createGatewayServer } from '../gateway/src/server';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const json = (value: unknown): Record<string, any> => { assert.ok(record(value), 'Expected an object'); return value; };
const safeError = (error: unknown) => ({ name: error instanceof Error ? error.name : 'Error', code: record(error) && typeof error.code === 'string' ? error.code : null, message: error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'Acceptance step failed; raw native/provider errors are deliberately omitted' });
async function until<T>(check: () => T | Promise<T>, message: string, timeout = 180_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result as NonNullable<T>; await sleep(100); }
  throw new Error(message);
}
async function freePort() {
  const server = createNetServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}

// Per-run certificate trust, held only by this fixture client. System trust and proxy configuration are untouched.
async function tlsFixture(root: string, upstreamPort: number) {
  const directory = join(root, 'tls'); await mkdir(directory, { mode: 0o700 });
  const keyPath = join(directory, 'key.pem'), certPath = join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=oraculum-live-fixture', '-addext', 'subjectAltName=IP:127.0.0.2', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
  const ca = await readFile(certPath), sockets = new Set<Duplex>();
  const server = createHttpsServer({ key: await readFile(keyPath), cert: ca }, (req, res) => {
    const upstream = httpRequest({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, reply => {
      reply.on('error', () => res.destroy()); res.writeHead(reply.statusCode!, reply.headers); reply.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.once('close', () => upstream.destroy()); req.once('aborted', () => upstream.destroy()); req.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, client, head) => {
    const upstream = connect(upstreamPort, '127.0.0.1', () => {
      const headers = { ...req.headers, 'x-forwarded-proto': 'https' };
      upstream.write(`GET ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy()); client.on('close', () => upstream.destroy());
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.2', resolve); });
  return { origin: `https://127.0.0.2:${(server.address() as AddressInfo).port}`, ca,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

const output = await mkdtemp(join(tmpdir(), 'oraculum-gateway-live-'));
const projectPath = join(output, 'project'); await mkdir(projectPath, { mode: 0o700 });
await writeFile(join(projectPath, 'README.md'), '# Gateway acceptance fixture\n', { mode: 0o600 });
await symlink('/etc/passwd', join(projectPath, 'escape.txt'));
const configPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
const configHash = async () => { try { return createHash('sha256').update(await readFile(configPath)).digest('hex'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } };
const beforeConfig = await configHash(), port = await freePort(), tls = await tlsFixture(output, port);
const config = initGatewayConfig({ configPath: join(output, 'config', 'config.json'), stateDir: join(output, 'state'), allowedRoots: [{ id: 'fixture', path: output }], port, basePath: '/acceptance/', externalOrigin: tls.origin });
let store = new GatewayStore(config.stateDir, { create: true });
let adapter: CodexAdapter | undefined, service: GatewayService | undefined, server: Awaited<ReturnType<typeof createGatewayServer>> | undefined;
const sockets = new Set<WebSocket>();
const evidence: Record<string, any> = { result: 'running', startedAt: new Date().toISOString(), output, gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), checks: [], limitations: [], cleanupErrors: [], nativeThreads: [], nativeTurns: [], transport: 'isolated TLS reverse proxy; HTTPS/WSS verify a per-run CA; credentials remain in memory' };
let stage = 'initialize', epoch = '', projectId = '', threadId = '';
const devices = [0, 1].map(index => ({ deviceId: randomUUID(), deviceCredential: randomCredential(), accessToken: '', label: `Gateway real fixture ${index + 1}` }));
async function request(method: string, path: string, input?: unknown, device = devices[0], expected: number | readonly number[] = 200, headers: Record<string, string> = {}) {
  const body = input === undefined ? undefined : Buffer.isBuffer(input) ? input : Buffer.from(JSON.stringify(input));
  const result = await new Promise<{ status: number; bytes: Buffer }>((resolve, reject) => {
    const req = httpsRequest(new URL(config.basePath + path, tls.origin), { ca: tls.ca, method, headers: { 'x-oraculum-protocol': '2', ...(body ? { 'content-type': Buffer.isBuffer(input) ? 'application/octet-stream' : 'application/json', 'content-length': String(body.length) } : {}), ...(device.accessToken ? { authorization: `Bearer ${device.accessToken}` } : {}), ...headers } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(Buffer.from(chunk))); res.once('error', reject); res.once('end', () => resolve({ status: res.statusCode!, bytes: Buffer.concat(chunks) }));
    });
    req.setTimeout(75_000, () => req.destroy(new Error('HTTP timeout'))); req.once('error', reject); req.end(body);
  });
  let errorCode='';try{const v=JSON.parse(result.bytes.toString('utf8'));if(typeof v?.error?.code==='string'&&/^[A-Z_]+$/.test(v.error.code))errorCode=v.error.code;}catch{}
  assert.ok((Array.isArray(expected) ? expected : [expected]).includes(result.status), `${stage}: HTTP ${method} ${path.split('?')[0]} status ${result.status} ${errorCode}`);
  if (path.endsWith('/content')) return result.bytes;
  return json(JSON.parse(result.bytes.toString('utf8')));
}
const api = (method: string, path: string, input?: unknown, device = devices[0], expected: number | readonly number[] = 200, headers: Record<string, string> = {}) => request(method, 'api/v2' + path, input, device, expected, headers);
function resource(value: unknown) { return json(json(value).data); }
async function openEvents(device = devices[0], afterSeq = 0, knownEpoch = epoch) {
  const frames: Record<string, any>[] = [];
  const socket = new WebSocket(new URL(config.basePath + 'api/v2/events', tls.origin).toString().replace(/^https:/, 'wss:'), { ca: tls.ca, headers: { 'x-oraculum-protocol': '2', authorization: `Bearer ${device.accessToken}` } });
  sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  socket.on('message', value => { frames.push(json(JSON.parse(value.toString()))); });
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'resume', epoch: knownEpoch, afterSeq }));
  await until(() => frames.some(frame => frame.type === 'connection'), 'WSS connection frame missing', 15_000);
  return { socket, frames, close: async () => { if (socket.readyState === WebSocket.CLOSED) return; const done = new Promise<void>(resolve => socket.once('close', () => resolve())); socket.close(); await done; } };
}
async function boot() {
  adapter = new CodexAdapter({ cwd: projectPath, executable: config.codexCommand });
  await adapter.start();
  const note=(method:string,error:unknown)=>{if(error instanceof CodexError){evidence.nativeReadErrors??=[];if(evidence.nativeReadErrors.length<50)evidence.nativeReadErrors.push({method,code:error.code,nativeCode:error.nativeCode,message:error.message});}throw error;};
  const read=adapter.readThread.bind(adapter),turns=adapter.listTurns.bind(adapter),items=adapter.listItems.bind(adapter);
  adapter.readThread=(...args)=>read(...args).catch(error=>note('thread/read',error));
  adapter.listTurns=(...args)=>turns(...args).catch(error=>note('thread/turns/list',error));
  adapter.listItems=(...args)=>items(...args).catch(error=>note('thread/items/list',error));
  service = new GatewayService(store, config, adapter, { codexVersion: evidence.codexVersion });
  server = await createGatewayServer(service, config); await server.listen({ host: config.host, port });
}
async function shutdown() {
  for (const socket of sockets) socket.terminate(); sockets.clear();
  await server?.close(); server = undefined; await adapter?.close(); adapter = undefined;
}
const receipt = (value: unknown) => json(json(value).operation);
const startTurn = async (text: string, extra: Record<string, unknown> = {}) => {
  const operationId = randomUUID();
  const response = await api('POST', `/threads/${threadId}/turns`, { operationId, projectId, expectedEpoch: epoch, input: [{ type: 'text', text }], permissionPreset: 'read-only', ...extra });
  const operation = receipt(response); assert.equal(operation.status, 'accepted', 'Native turn was not accepted');
  assert.equal(typeof operation.nativeTurnId, 'string', 'Native turn ID missing');
  evidence.nativeTurns.push({ operationId, turnId: operation.nativeTurnId }); return operation;
};
async function snapshot() {
  // A read-only recovery client may re-read a stale/native-unavailable projection;
  // never apply this policy to a Turn, resume, approval or other mutation.
  for(let attempt=0;attempt<3;attempt++){
    const response=json(await api('POST',`/threads/${threadId}/snapshot`,{projectId},devices[0],[200,409,503]));
    if(record(response.data))return resource(response);
    const code=response.error?.code;
    assert.ok(attempt<2&&['HISTORY_STALE','NATIVE_UNSUPPORTED','NATIVE_PAGINATION_UNSUPPORTED'].includes(code),'Snapshot failed outside the bounded read recovery policy');
    evidence.snapshotReadRetries??=[];evidence.snapshotReadRetries.push({code,attempt:attempt+1});await sleep(100);
  }
  throw new Error('Snapshot read recovery exhausted');
}
async function finished(turnId: string) {
  return until(async () => { const value = await snapshot(); const history = json(value.history); const turn = history.items.find((item: any) => item.id === turnId); return turn && turn.status !== 'inProgress' ? { snapshot: value, turn } : null; }, 'Native turn did not reach a terminal history state');
}

try {
  evidence.codexVersion = execFileSync(config.codexCommand, ['--version'], { encoding: 'utf8' }).trim();
  await boot();
  const health = await request('GET', 'health'); assert.equal(json(health).installationId, store.installationId, 'Wrong installation identity');
  for (const device of devices) {
    const code = store.createPairing().code;
    await api('POST', '/auth/pair', { installationId: store.installationId, deviceId: device.deviceId, deviceCredential: device.deviceCredential, label: device.label, code }, device);
    // Discard pair ACK credentials deliberately, recovering with the client identity generated before pairing.
    const token = json(await api('POST', '/auth/token', { installationId: store.installationId, deviceId: device.deviceId, deviceCredential: device.deviceCredential }, device));
    device.accessToken = token.accessToken;
  }
  const capabilities = resource(await api('GET', '/capabilities')); epoch = capabilities.epoch;
  evidence.checks.push('Fresh SQLite/config; two HTTPS pairs; lost pair response recovered by credential exchange');
  stage = 'project and thread';
  const registered = await api('POST', '/projects', { operationId: randomUUID(), rootId: 'fixture', path: 'project' });
  assert.equal(receipt(registered).status, 'accepted', 'Project registration rejected');
  projectId = resource(await api('GET', '/projects')).projects.find((project: any) => project.canonicalPath === projectPath).id;
  const started = receipt(await api('POST', `/projects/${projectId}/threads`, { operationId: randomUUID(), expectedEpoch: epoch, permissionPreset: 'read-only' }));
  assert.equal(started.status, 'accepted', 'Native thread was not accepted'); threadId = started.nativeThreadId; evidence.nativeThreads.push(threadId);
  const feed = await openEvents();
  stage = 'native text and stream';
  const marker = 'ORACULUM_GATEWAY_V2_LIVE_OK';
  const sent = await startTurn(`This is an isolated transport acceptance test. Reply with exactly ${marker}. Do not use tools, read files, access network, or create subagents.`);
  const complete = await finished(sent.nativeTurnId);
  const items = complete.turn.items as Record<string, any>[];
  assert.ok(items.some(item => item.type === 'agentMessage' && String(item.text ?? json(item.data ?? {}).text ?? '').includes(marker)), 'Native history does not contain expected final text');
  assert.ok(feed.frames.some(frame => frame.kind === 'item.delta' && frame.scope?.threadId === threadId), 'No native streaming delta reached WSS');
  evidence.textTurn = { status: complete.turn.status, snapshotSynchronization: complete.snapshot.synchronization, streamDeltaCount: feed.frames.filter(frame => frame.kind === 'item.delta').length };
  assert.equal(complete.turn.status, 'completed', 'Text turn did not complete');
  const nativeMessage=items.find(item=>item.type==='agentMessage')!;
  const detail=resource(await api('POST',`/threads/${threadId}/history/details`,{projectId,turnId:sent.nativeTurnId,itemId:nativeMessage.id}));
  const detailBytes=Buffer.from(detail.chunk,'base64');assert.equal(detail.complete,true,'Short native item details should fit a single chunk');
  assert.equal(createHash('sha256').update(detailBytes).digest('hex'),detail.sha256,'Native item detail digest differs');
  assert.ok(String(JSON.parse(detailBytes.toString('utf8')).text).includes(marker),'Native item detail content differs');
  const duplicate = await api('POST', `/threads/${threadId}/turns`, { operationId: sent.operationId, projectId, expectedEpoch: epoch, input: [{ type: 'text', text: 'MUST NOT BE DISPATCHED' }] }, devices[0], 409);
  assert.equal(json(duplicate).error.code, 'OPERATION_ALREADY_RECORDED', 'Duplicate write was not refused');
  await api('GET', `/operations/${sent.operationId}`, undefined, devices[1], 404);
  evidence.checks.push('Real official thread/turn; streamed delta; canonical native history converged; duplicate operation blocked and receipt isolated');

  stage = 'event replay';
  const eventFrames = feed.frames.filter(frame => typeof frame.seq === 'number'), last = eventFrames.at(-1)!;
  assert.ok(last, 'No replayable events'); await feed.close();
  const replay = await openEvents(devices[0], Math.max(0, last.seq - 1));
  await until(() => replay.frames.some(frame => frame.seq === last.seq), 'WSS replay did not return retained event', 15_000);
  assert.ok(replay.frames.every(frame => frame.seq === undefined || frame.seq > last.seq - 1), 'Replay included older events'); await replay.close();
  evidence.checks.push('WSS reconnection replays retained cursor without older deltas');

  stage = 'native interrupt';
  const interruptFeed = await openEvents();
  const interruptible = await startTurn('For this isolated interrupt acceptance test, write the integers 1 through 20000, one per line. Do not use any tools. The client will interrupt immediately.');
  const stop = receipt(await api('POST', `/threads/${threadId}/turns/${interruptible.nativeTurnId}/interrupt`, { operationId: randomUUID(), projectId, expectedEpoch: epoch }));
  assert.equal(stop.status, 'accepted', 'Interrupt was not accepted');
  const interrupted = await finished(interruptible.nativeTurnId); assert.equal(interrupted.turn.status, 'interrupted', 'Native did not report interrupted'); await interruptFeed.close();
  evidence.checks.push('Real native turn interrupt accepted and native terminal history reports interrupted');

  stage = 'native approval';
  const approvalFeed = await openEvents();
  const approvalTurn = await startTurn('This is a native approval test in a disposable project. Request exactly one shell approval with sandbox_permissions=require_escalated for the harmless command `printf ORACULUM_GATEWAY_NATIVE_DECLINE`, justification="Gateway native approval acceptance". Do not read or write any file, use MCP/skills/apps/web/subagents, or run any other command. The user will decline. After decline, never retry or bypass; reply APPROVAL_DECLINED.');
  const pending = await until(async () => {
    const value = await snapshot(); const interaction = (value.interactions as Record<string, any>[]).find(item => item.status === 'pending');
    if (interaction) return interaction;
    const turn = json(value.history).items.find((item: any) => item.id === approvalTurn.nativeTurnId);
    if (turn && turn.status !== 'inProgress') throw new Error('Native approval test completed without a request'); return null;
  }, 'Real native approval request not observed');
  assert.ok(['command', 'permissions', 'fileChange'].includes(pending.kind), 'Unexpected native interaction kind');
  const available=pending.request?.availableDecisions;
  const negativeDecision:Array<'decline'|'cancel'>=['decline','cancel'];
  const decision=negativeDecision.find(value=>!Array.isArray(available)||available.includes(value));
  assert.ok(decision,'Native request has no supported negative decision; never synthesize acceptance');
  const answer = receipt(await api('POST', `/interactions/${pending.interactionId}/response`, { operationId: randomUUID(), projectId, epoch, generation: pending.generation, response: { type: 'approval', decision } }, devices[1], [200,202]));
  evidence.approvalAttempt={kind:pending.kind,availableDecisions:pending.request?.availableDecisions,status:answer.status,errorCode:answer.errorCode};
  assert.ok(['accepted','unknown'].includes(answer.status), 'Native approval response must be accepted only after native resolution, otherwise unknown');
  await until(async()=>resource(await api('GET',`/operations/${answer.operationId}`,undefined,devices[1])).status==='accepted','Native resolved event did not reconcile the response receipt',15000);
  const declined = await finished(approvalTurn.nativeTurnId); assert.ok(['completed','interrupted'].includes(declined.turn.status), 'Approval turn did not reach a terminal native state after the negative response');
  evidence.approval = { kind: pending.kind, decision, status: declined.turn.status }; await approvalFeed.close();
  evidence.checks.push('Real native approval received on HTTPS snapshot/WSS and answered negatively with a native-advertised decision by the second paired device');

  stage = 'host files';
  const files = resource(await api('POST', `/projects/${projectId}/files/query`, { path: '' }));
  assert.ok(files.entries.some((entry: any) => entry.name === 'README.md'), 'Authorized host file missing');
  const selected = resource(await api('POST', `/projects/${projectId}/files/select`, { path: 'README.md', threadId }));
  const bytes = await api('GET', `/files/${selected.fileId}/content`); assert.ok(Buffer.isBuffer(bytes) && bytes.toString('utf8') === '# Gateway acceptance fixture\n', 'File content differs');
  await api('GET', `/files/${selected.fileId}/content`, undefined, devices[1], 409);
  for (const path of ['../README.md', 'escape.txt', '.codex/auth.json']) await api('POST', `/projects/${projectId}/files/select`, { path }, devices[0], 409);
  evidence.checks.push('Authenticated host file list/select/download; cross-device grant, traversal, symlink and sensitive path refused');

  stage = 'real attachment';
  const document=Buffer.from('ORACULUM_UPLOADED_DOCUMENT_OK\n'),draftId=randomUUID(),uploadOperation=randomUUID();
  const uploadMeta={operationId:uploadOperation,projectId,threadId,draftId,name:'transport-fixture.txt',mime:'text/plain',size:document.length};
  const uploaded=receipt(await api('POST',`/threads/${threadId}/attachments`,document,devices[0],200,{'x-oraculum-upload':Buffer.from(JSON.stringify(uploadMeta)).toString('base64url')}));
  assert.equal(uploaded.status,'accepted','Attachment upload rejected');
  const uploadReceipt=resource(await api('GET',`/operations/${uploadOperation}`));
  assert.ok(uploadReceipt.attachment?.id,'Lost upload ACK recovery did not provide attachment ID');
  const attachmentTurn=await startTurn('Read only the uploaded transport-fixture.txt attachment referenced in this message using native file tools. Reply with its one-line content exactly. Do not read any other files, write files, use network, MCP, skills, apps or subagents.',{draftId,attachmentIds:[uploadReceipt.attachment.id]});
  const attachmentComplete=await finished(attachmentTurn.nativeTurnId);
  assert.equal(attachmentComplete.turn.status,'completed','Native attachment turn failed');
  assert.ok(attachmentComplete.turn.items.some((item:any)=>item.type==='agentMessage'&&String(item.text??'').includes('ORACULUM_UPLOADED_DOCUMENT_OK')),'Native document reference did not produce the uploaded content');
  evidence.checks.push('Real authenticated document upload; upload receipt recovers attachment ID; one-time Turn claim; native read-only file tool reads dedicated uploaded document');

  stage = 'restart and read-only recovery';
  const originalEpoch = epoch, installationId = store.installationId;
  await shutdown(); store.close(); store = new GatewayStore(config.stateDir); await boot();
  for (const device of devices) {
    const token = json(await api('POST', '/auth/token', { installationId, deviceId: device.deviceId, deviceCredential: device.deviceCredential }, device)); device.accessToken = token.accessToken;
  }
  epoch = resource(await api('GET', '/capabilities')).epoch;
  assert.notEqual(epoch, originalEpoch, 'Gateway restart did not rotate epoch'); assert.equal(store.installationId, installationId, 'Installation changed on restart');
  const restored = resource(await api('GET', `/operations/${sent.operationId}`)); assert.equal(restored.status, 'accepted', 'Receipt not durable');
  const reset = await openEvents(devices[0], last.seq, originalEpoch); assert.ok(reset.frames.some(frame => frame.type === 'connection' && frame.resetRequired), 'Old epoch did not require reset'); await reset.close();
  const resumed = receipt(await api('POST', `/threads/${threadId}/resume`, { operationId: randomUUID(), projectId, expectedEpoch: epoch })); assert.equal(resumed.status, 'accepted', 'Native thread did not resume');
  const restoredHistory = await snapshot(); assert.ok(json(restoredHistory.history).items.some((turn: any) => turn.id === sent.nativeTurnId), 'History not available after restart');
  evidence.checks.push('Gateway/App Server restart keeps installation/trust/receipts; rotates epoch, resets events, explicitly resumes the dedicated native thread');

  stage = 'revocation';
  const revokedFeed = await openEvents(devices[1]); store.revokeDevice(devices[1].deviceId);
  await until(() => revokedFeed.socket.readyState === WebSocket.CLOSED, 'Revocation did not close WSS', 5000);
  await api('GET', '/projects', undefined, devices[1], [401,403]);
  evidence.checks.push('Revoking device in SQLite invalidates HTTP access and WSS within the polling budget');
  evidence.result = 'passed';
} catch (error) { evidence.result = 'failed'; evidence.failedStage = stage; evidence.error = safeError(error); process.exitCode = 1; }
finally {
  const cleanup = async (name: string, action: () => unknown | Promise<unknown>) => { try { await action(); } catch { evidence.cleanupErrors.push(name); process.exitCode = 1; evidence.result = 'failed'; } };
  await cleanup('isolated Gateway/App Server', shutdown);
  await cleanup('fresh store', () => store.close()); await cleanup('test TLS proxy', () => tls.close());
  evidence.codexConfigUnchanged = beforeConfig === await configHash(); if (!evidence.codexConfigUnchanged) { evidence.result = 'failed'; process.exitCode = 1; }
  evidence.finishedAt = new Date().toISOString();
  evidence.limitations.push('Dedicated native acceptance threads are retained in official Codex history; no existing thread, global configuration, installed service or production proxy is modified.');
  await writeFile(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(evidence, null, 2));
}
