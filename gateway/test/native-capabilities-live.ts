/** Opt-in native acceptance: pnpm exec tsx gateway/test/native-capabilities-live.ts.
 * Uses fresh private Gateway state, a random loopback port and fixture-created
 * Codex sessions. Existing Gateway services, pairing and native config are untouched.
 * The report contains bounded outcomes only, never credentials or raw native data.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { CodexAdapter, record, type NativeNotification } from '../src/codex';
import { initGatewayConfig } from '../src/config';
import { GatewayService } from '../src/service';
import { createGatewayServer } from '../src/server';
import { GatewayStore, randomCredential } from '../src/store';

type Json = Record<string, any>; // Heterogeneous protocol envelopes in this opt-in fixture only.
type Check = { name: string; status: 'passed' | 'limited' | 'failed'; elapsedMs: number; [key: string]: unknown };
const object = (value: unknown): Json => { assert.ok(record(value), 'Expected a protocol object'); return value; };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const safeCode = (value: unknown) => record(value) && typeof value.code === 'string' && /^[A-Z_]{1,64}$/.test(value.code) ? value.code : 'PROBE_ASSERTION';
async function until<T>(read: () => T | Promise<T>, label: string, timeoutMs = 120_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const result = await read(); if (result) return result as NonNullable<T>; await pause(100); }
  throw new Error(label);
}
async function freePort() {
  const server = createNetServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}

const output = await mkdtemp(join(tmpdir(), 'oraculum-native-capabilities-'));
const projectPath = join(output, 'project'); await mkdir(projectPath, { mode: 0o700 });
await writeFile(join(projectPath, 'README.md'), '# Isolated native capability acceptance\n', { mode: 0o600 });
const configPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
async function configHash() {
  try { return createHash('sha256').update(await readFile(configPath)).digest('hex'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
const beforeConfig = await configHash(), port = await freePort();
const config = initGatewayConfig({ configPath: join(output, 'gateway-config', 'config.json'), stateDir: join(output, 'state'),
  allowedRoots: [{ id: 'native-fixture', path: output }], port, basePath: '/native-acceptance/' });
const store = new GatewayStore(config.stateDir, { create: true });
const codex = new CodexAdapter({ cwd: projectPath, executable: config.codexCommand });
let service: GatewayService | undefined, server: Awaited<ReturnType<typeof createGatewayServer>> | undefined;
let socket: WebSocket | undefined, accessToken = '', epoch = '', projectId = '', threadId = '';
const createdThreads = new Set<string>(), nativeTurns = new Set<string>(), completed = new Map<string, Json>();
const compactionCompleted = new Set<string>(), streamedText = new Map<string, string>();
const nativeNameUpdates = new Map<string, number>();
const streamCounts = new Map<string, number>();
const report: Json = { result: 'running', startedAt: new Date().toISOString(), checks: [] as Check[],
  limitations: [] as string[], cleanup: {}, transport: 'fresh loopback HTTP/WebSocket fixture; not public HTTPS/WSS or Android acceptance',
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
codex.on('notification', (event: NativeNotification) => {
  const p = event.params;
  const id = typeof p.threadId === 'string' ? p.threadId : record(p.thread) && typeof p.thread.id === 'string' ? p.thread.id : undefined;
  if (!id || !createdThreads.has(id)) return;
  if (event.method === 'thread/name/updated') nativeNameUpdates.set(id, (nativeNameUpdates.get(id) ?? 0) + 1);
  if (event.method === 'turn/completed' && record(p.turn) && typeof p.turn.id === 'string') completed.set(p.turn.id, p.turn);
  if (event.method === 'item/completed' && record(p.item) && p.item.type === 'contextCompaction') compactionCompleted.add(id);
  if (event.method === 'item/agentMessage/delta' && typeof p.delta === 'string' && typeof p.turnId === 'string')
    streamedText.set(p.turnId, ((streamedText.get(p.turnId) ?? '') + p.delta).slice(0, 65536));
});

async function api(method: string, path: string, body?: unknown) {
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const response = await new Promise<{ status: number; data: Json }>((resolve, reject) => {
    const request = httpRequest({ hostname: config.host, port, path: config.basePath + 'api/v2' + path, method,
      headers: { 'x-oraculum-protocol': '2', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...(bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.length) } : {}) } }, reply => {
      const chunks: Buffer[] = []; reply.on('data', chunk => chunks.push(Buffer.from(chunk))); reply.once('error', reject);
      reply.once('end', () => { try { resolve({ status: reply.statusCode!, data: object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }); } catch (error) { reject(error); } });
    });
    request.once('error', reject); request.setTimeout(90_000, () => request.destroy(new Error('Fixture HTTP deadline'))); request.end(bytes);
  });
  return response;
}
const base = () => ({ operationId: randomUUID(), projectId, expectedEpoch: epoch });
async function mutate(path: string, extra: Json = {}, method = 'POST') {
  const response = await api(method, `/threads/${threadId}${path}`, { ...base(), ...extra });
  assert.ok([200, 202].includes(response.status), 'Fixture native mutation HTTP refusal');
  const receipt = object(response.data.operation);
  if (receipt.status !== 'accepted') throw Object.assign(new Error('Native mutation not accepted'), { code: receipt.errorCode ?? 'DELIVERY_UNKNOWN', receiptStatus: receipt.status });
  return receipt;
}
async function run(name: string, work: () => Promise<Json | undefined>, optional = false) {
  const start = Date.now();
  try { const detail = await work(); const check: Check = { name, status: 'passed', elapsedMs: Date.now() - start, ...detail }; report.checks.push(check); console.log(JSON.stringify(check)); }
  catch (error) {
    const check: Check = { name, status: optional ? 'limited' : 'failed', elapsedMs: Date.now() - start, code: safeCode(error) };
    report.checks.push(check); console.log(JSON.stringify(check));
    if (!optional) throw error;
    report.limitations.push(name + ': ' + check.code);
  }
}
async function terminal(turnId: string) {
  return until(() => completed.get(turnId), 'Fixture native turn deadline');
}
async function startTurn(text: string, extra: Json = {}) {
  const receipt = await mutate('/turns', { input: [{ type: 'text', text }], permissionPreset: 'read-only', ...extra });
  assert.equal(typeof receipt.nativeTurnId, 'string'); nativeTurns.add(receipt.nativeTurnId); return receipt.nativeTurnId as string;
}

try {
  report.codexVersion = execFileSync(config.codexCommand, ['--version'], { encoding: 'utf8' }).trim();
  await codex.start(); service = new GatewayService(store, config, codex, { codexVersion: report.codexVersion });
  server = await createGatewayServer(service, config); await server.listen({ host: config.host, port });
  const credentials = { installationId: store.installationId, deviceId: randomUUID(), deviceCredential: randomCredential(), code: store.createPairing().code, label: 'Native acceptance fixture' };
  const paired = await api('POST', '/auth/pair', credentials); assert.equal(paired.status, 200); accessToken = paired.data.accessToken;
  const caps = await api('GET', '/capabilities'); assert.equal(caps.status, 200); epoch = caps.data.data.epoch;
  const registration = await api('POST', '/projects', { operationId: randomUUID(), rootId: 'native-fixture', path: 'project' });
  assert.equal(registration.data.operation?.status, 'accepted'); projectId = store.listProjects()[0]!.id;
  const defaultsResponse = await api('GET', `/projects/${projectId}/native-defaults`);
  await run('effective native defaults', async () => {
    assert.equal(defaultsResponse.status, 200);
    const defaults = object(defaultsResponse.data.data); assert.equal(defaults.source, 'native-config');
    assert.ok(!JSON.stringify(defaults).includes(configPath));
    return { configuredModelPresent: typeof defaults.model === 'string', configuredEffortPresent: typeof defaults.effort === 'string', provenanceFields: Object.keys(defaults.origins).length };
  });
  for (const [path, name] of [['/account/rate-limits', 'account quota read'], ['/account/usage', 'account activity read']] as const) await run(name, async () => {
    const response = await api('GET', path);
    if (response.status !== 200) throw Object.assign(new Error('Native account read unavailable'), { code: response.data.error?.code });
    const value = object(response.data.data); assert.equal(typeof value.readAt, 'number');
    assert.ok(!Object.hasOwn(value, 'accountId'));
    return { source: value.source, limited: value.limited };
  }, true);
  await run('extensions discovery', async () => {
    const response = await api('GET', `/projects/${projectId}/extensions`); assert.equal(response.status, 200);
    const sections = object(response.data.data).sections as Json[];
    const details = sections.map(section => ({ kind: section.kind, status: section.status, count: section.entries.length, limited: section.limited, reasonCode: section.reasonCode }));
    const mcp = sections.find(section => section.kind === 'mcp');
    if (mcp?.status !== 'available') report.limitations.push('MCP remained unavailable: ' + mcp?.reasonCode);
    return { sections: details };
  });
  socket = new WebSocket(`ws://127.0.0.1:${port}${config.basePath}api/v2/events`, { headers: { 'x-oraculum-protocol': '2', authorization: `Bearer ${accessToken}` } });
  let connected = false;
  socket.on('message', bytes => { const frame = object(JSON.parse(bytes.toString())); if (frame.type === 'connection') connected = true;
    if (typeof frame.kind === 'string') streamCounts.set(frame.kind, (streamCounts.get(frame.kind) ?? 0) + 1); });
  await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); });
  socket.send(JSON.stringify({ type: 'resume', epoch, afterSeq: 0 })); await until(() => connected, 'Fixture WebSocket handshake', 10_000);
  await run('native default inheritance', async () => {
    const started = await api('POST', `/projects/${projectId}/threads`, { operationId: randomUUID(), expectedEpoch: epoch });
    assert.equal(started.data.operation?.status, 'accepted'); threadId = started.data.operation.nativeThreadId; createdThreads.add(threadId);
    const view = await api('GET', `/projects/${projectId}/threads/${threadId}`); assert.equal(view.status, 200);
    const defaults = defaultsResponse.data.data, actual = object(view.data.data);
    if (typeof defaults.model === 'string') assert.equal(actual.model, defaults.model);
    report.automaticNaming = { beforeNamed: typeof actual.title === 'string' && actual.title.length > 0, beforePreviewPresent: typeof actual.preview === 'string' && actual.preview.length > 0 };
    return { actualModelReadback: typeof actual.model === 'string', actualEffortReadback: typeof actual.reasoningEffort === 'string', permissionReadback: !!actual.permissionReadback };
  });
  await run('ultra explicit inference and streaming', async () => {
    const models = await api('GET', '/models'); assert.equal(models.status, 200);
    const list = object(models.data.data).data as Json[];
    const candidates = list.filter(model => model.supportedReasoningEfforts.some((effort: Json) => effort.reasoningEffort === 'ultra'));
    const selected = candidates.find(model => model.isDefault) ?? candidates[0]; assert.ok(selected, 'No native advertised ultra model');
    const turnId = await startTurn('Reply exactly ORACULUM_NATIVE_ULTRA_OK. Do not use tools, network, files, skills, MCP, apps or subagents.', { model: selected.model, effort: 'ultra' });
    const turn = await terminal(turnId); assert.equal(turn.status, 'completed');
    assert.ok((streamedText.get(turnId) ?? '').includes('ORACULUM_NATIVE_ULTRA_OK'));
    await pause(2000);
    const after = await api('GET', `/projects/${projectId}/threads/${threadId}`); assert.equal(after.status, 200);
    report.automaticNaming = { ...report.automaticNaming, afterNamed: typeof after.data.data.title === 'string' && after.data.data.title.length > 0,
      afterPreviewPresent: typeof after.data.data.preview === 'string' && after.data.data.preview.length > 0, nativeNameUpdateCount: nativeNameUpdates.get(threadId) ?? 0 };
    return { modelSupportsUltra: true, nativeStatus: turn.status, streamed: true };
  });
  await run('native explicit rename', async () => {
    await mutate('/name', { name: 'Native capability acceptance fixture' });
    const renamed = await api('GET', `/projects/${projectId}/threads/${threadId}`); assert.equal(renamed.data.data.title, 'Native capability acceptance fixture');
    return { nativeTitleMatches: true };
  });
  await run('native archive, archived listing, unarchive and resume', async () => {
    await mutate('/archive');
    const archived = await api('GET', `/projects/${projectId}/threads?archived=true`); assert.equal(archived.status, 200);
    assert.ok(archived.data.data.threads.some((thread: Json) => thread.id === threadId));
    await mutate('/unarchive'); await mutate('/resume');
    return { archivedListContainsFixture: true };
  });
  await run('same-turn steer and interrupt', async () => {
    const turnId = await startTurn('Write integers 1 through 30000 one per line. Do not use any tools, network, files, MCP, skills, apps or subagents. This fixture will steer and stop immediately.', { effort: 'low' });
    const steered = await mutate(`/turns/${turnId}/steer`, { input: [{ type: 'text', text: 'Continue writing the requested integers. Do not use tools.' }] });
    assert.equal(steered.nativeTurnId, turnId);
    await mutate(`/turns/${turnId}/interrupt`);
    const turn = await terminal(turnId); assert.equal(turn.status, 'interrupted');
    return { sameTurn: true, nativeStatus: turn.status };
  });
  await run('native manual compaction acknowledgement and completion', async () => {
    const before = completed.size; await mutate('/compact');
    await until(() => compactionCompleted.has(threadId), 'No completed native contextCompaction item');
    await until(() => completed.size > before, 'No terminal native compaction turn');
    return { triggerAcknowledged: true, nativeCompactionItemCompleted: true };
  });
  let forkId = '';
  await run('native fork', async () => {
    const fork = await mutate('/fork'); forkId = fork.nativeThreadId; assert.notEqual(forkId, threadId); createdThreads.add(forkId);
    const read = await api('GET', `/projects/${projectId}/threads/${forkId}`); assert.equal(read.status, 200);
    return { nativeNewThread: true };
  });
  await run('native persistent history revert', async () => {
    const original = threadId; threadId = forkId;
    try {
      const firstTurn = [...nativeTurns][0]; assert.ok(firstTurn);
      await mutate('/revert', { beforeTurnId: firstTurn });
      assert.equal(await readFile(join(projectPath, 'README.md'), 'utf8'), '# Isolated native capability acceptance\n');
      return { originalFilesUntouched: true };
    } finally { threadId = original; }
  }, true);
  await run('confirmed deletion of fixture sessions', async () => {
    const original = threadId;
    for (const target of [forkId, original].filter(Boolean)) {
      threadId = target; await mutate('', { confirm: true }, 'DELETE'); createdThreads.delete(target);
    }
    threadId = original;
    return { deletedOnlyFixtureThreads: true };
  });
  await service.settled();
  await until(() => (streamCounts.get('native.state') ?? 0) > 0 && (streamCounts.get('history.invalidated') ?? 0) > 0, 'Fixture state invalidation events missing', 10_000);
  report.websocket = { connected, eventCounts: Object.fromEntries(streamCounts) };
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.failure = { code: safeCode(error) }; process.exitCode = 1;
} finally {
  socket?.terminate();
  try { await server?.close(); } catch { report.cleanup.serverClosed = false; }
  try { await service?.close(); await codex.close(); report.cleanup.nativeClosed = true; } catch { report.cleanup.nativeClosed = false; }
  store.close();
  report.cleanup.configUnchanged = beforeConfig === await configHash();
  report.cleanup.remainingFixtureThreadIds = [...createdThreads];
  if (!report.cleanup.configUnchanged) { report.result = 'failed'; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  const path = join(output, 'report.json'); await writeFile(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ result: report.result, evidence: path, checks: report.checks.length, configUnchanged: report.cleanup.configUnchanged, remainingFixtureThreads: createdThreads.size }));
}
