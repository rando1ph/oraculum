/** Opt-in real Codex fixture for the isolated cache-sync Debug application.
 * Only this script's temporary project/threads may be changed. No installed
 * Gateway, system service, deployment, global configuration or trust is changed.
 * stdout is safe progress; nonce/pairing data remains in 0600 metadata files.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { CodexAdapter, record, type NativeThread } from '../gateway/src/codex';
import { initGatewayConfig } from '../gateway/src/config';
import { GatewayService } from '../gateway/src/service';
import { createGatewayServer } from '../gateway/src/server';
import { GatewayStore } from '../gateway/src/store';
import { createAndroidFixtureProxy } from './android-v2-fixture';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const safeCode = (error: unknown) => record(error) && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'FIXTURE_FAILED';
async function freePort() {
  const socket = createNetServer();
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = (socket.address() as AddressInfo).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return port;
}
async function nativeConfigHash() {
  try { return createHash('sha256').update(await readFile(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'))).digest('hex'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function main() {
  assert.equal(process.argv.length, 2, 'This opt-in fixture accepts no arguments');
  process.umask(0o077);
  const root = await mkdtemp(join(tmpdir(), 'oraculum-cache-sync-device-'));
  const projectPath = join(root, 'project');
  await mkdir(projectPath, { mode: 0o700 });
  await writeFile(join(projectPath, 'README.md'), '# Dedicated Oraculum cache-sync device acceptance project\n', { mode: 0o600 });
  const originalConfig = await nativeConfigHash();
  const upstreamPort = await freePort();
  const proxy = await createAndroidFixtureProxy(root, upstreamPort, 'device-tls');
  const config = await (async () => {
    try {
      return initGatewayConfig({ configPath: join(root, 'config', 'config.json'), stateDir: join(root, 'state'),
        port: upstreamPort, allowedRoots: [{ id: 'cache-sync', path: root }], externalOrigin: proxy.origin, basePath: '/android-cache-sync/' });
    } catch (error) { await proxy.close(); throw error; }
  })();
  let codexVersion: string;
  try { codexVersion = execFileSync(config.codexCommand, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(); }
  catch (error) { await proxy.close(); throw error; }
  const counts = { seedTurns: 0, seedForks: 0, externalMutations: 0, cliWrites: 0, acpWrites: 0, connectionCycles: 0 };
  const report: Record<string, unknown> = { result: 'running', startedAt: new Date().toISOString(), codexVersion,
    sourceGit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), counts,
    isolation: 'temporary loopback HTTPS/WSS, fresh SQLite, dedicated native project; no installed service changes', controls: [], cleanupErrors: [] };
  const adapters = new Set<CodexAdapter>();
  let gateway: GatewayService | undefined;
  let server: Awaited<ReturnType<typeof createGatewayServer>> | undefined;
  let store: GatewayStore | undefined;
  let stopping = false;
  let stopResolve!: () => void;
  const stopped = new Promise<void>(resolve => { stopResolve = resolve; });
  const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  const stop = () => { stopping = true; stopResolve(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const makeAdapter = async () => {
    const adapter = new CodexAdapter({ cwd: projectPath, executable: config.codexCommand, readTimeoutMs: 20_000 });
    adapters.add(adapter);
    adapter.on('request', request => { void adapter.rejectRequest(request.id, 'This fixed fixture never authorizes native tools').catch(() => {}); });
    await adapter.start();
    return adapter;
  };
  const closeAdapter = async (adapter: CodexAdapter) => { await adapter.close(); adapters.delete(adapter); };
  let primaryThreadId = '', secondaryThreadId = '', model = '', effort: string | undefined;
  let archivedThreadId: string | undefined, deletedThreadId: string | undefined, renamedThreadId: string | undefined, newThreadId: string | undefined;
  const forks: string[] = [];
  const cliMarker = 'CACHE_SYNC_CLI_OK', acpMarker = 'CACHE_SYNC_ACP_OK';
  const seedMarkerPrefix = 'CACHE_SYNC_SEED_';
  const owned = new Set<string>();
  const ownedThread = async (adapter: CodexAdapter, id: string) => {
    assert(owned.has(id), 'Only fixture-owned native threads may be changed');
    const result = await adapter.readThread(id);
    assert.equal(result.thread.cwd, projectPath, 'Native thread moved outside the fixture project');
    return result.thread;
  };
  const awaitTurn = async (adapter: CodexAdapter, threadId: string, turnId: string, marker: string) => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && !stopping) {
      const { thread } = await adapter.readThread(threadId, true, 20_000);
      assert.equal(thread.cwd, projectPath);
      const turn = thread.turns.find(turn => turn.id === turnId);
      if (turn && turn.status !== 'inProgress') {
        assert.equal(turn.status, 'completed', 'Fixture native Turn did not complete');
        assert(turn.items.some(item => item.type === 'agentMessage' && String(item.text ?? '').includes(marker)), 'Native response marker missing');
        return turn;
      }
      await pause(400);
    }
    throw new Error('Fixture native Turn completion deadline exceeded');
  };
  const inventory = async (adapter: CodexAdapter) => {
    const threads: NativeThread[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page = await adapter.listThreads({ cwd: projectPath, limit: 100, cursor, archived: false });
      assert(page.data.every(thread => thread.cwd === projectPath));
      threads.push(...page.data);
      cursor = page.nextCursor;
      if (cursor) { assert(!seen.has(cursor), 'Native inventory cursor loop'); seen.add(cursor); }
    } while (cursor && seen.size < 4);
    assert.equal(cursor, null, 'Fixture native catalog exceeded its finite budget');
    return threads;
  };
  try {
    emit({ event: 'preparing', root, phase: 'seeding-native-history' });
    const seed = await makeAdapter();
    const models = await seed.listModels({ limit: 100 });
    const selected = models.data.find(item => item.model === 'gpt-6.1-sol') ?? models.data.find(item => item.isDefault) ?? models.data[0];
    assert(selected, 'A native advertised model is required');
    model = selected.model;
    effort = selected.supportedReasoningEfforts.some(item => item.reasoningEffort === 'low') ? 'low' : selected.supportedReasoningEfforts[0]?.reasoningEffort;
    const primary = await seed.startThread({ cwd: projectPath, model, effort, permissionPreset: 'read-only' });
    primaryThreadId = primary.thread.id; owned.add(primaryThreadId);
    await seed.setThreadName(primaryThreadId, 'Cache sync primary history');
    for (let index = 1; index <= 8; index++) {
      const marker = seedMarkerPrefix + String(index).padStart(2, '0');
      const padding = index === 8 ? '\nIgnore the following test padding; do not repeat it:\n' + 'x'.repeat(18 * 1024) : '';
      const input = `Reply exactly ${marker}. Do not use tools, read files, access network, skills, MCP, apps or subagents.${padding}`;
      const result = await seed.startTurn({ threadId: primaryThreadId, model, effort, permissionPreset: 'read-only', input: [{ type: 'text', text: input }] });
      await awaitTurn(seed, primaryThreadId, result.turn.id, marker);
      counts.seedTurns++;
      emit({ event: 'progress', phase: 'seed-history', completed: index, total: 8 });
    }
    emit({ event: 'progress', phase: 'seeding-native-catalog' });
    for (let index = 0; index < 45; index++) {
      const result = await seed.forkThread(primaryThreadId);
      assert.equal(result.thread.cwd, projectPath);
      forks.push(result.thread.id); owned.add(result.thread.id);
      await seed.setThreadName(result.thread.id, `Cache sync catalog ${String(index + 1).padStart(2, '0')}`);
      counts.seedForks++;
      if ((index + 1) % 10 === 0) emit({ event: 'progress', phase: 'seed-catalog', completed: index + 1, total: 45 });
    }
    secondaryThreadId = forks[0]!;
    const initial = await inventory(seed);
    assert.equal(initial.length, 46, 'Forks must be persisted and present in native pagination');
    await closeAdapter(seed);
    // The Gateway owns a different App Server and never resumes the seed history.
    // A later CLI/ACP writer therefore exercises persisted external history reads.
    const adapter = await makeAdapter();
    store = new GatewayStore(config.stateDir, { create: true });
    gateway = new GatewayService(store, config, adapter, { codexVersion });
    const project = await gateway.projects.register('cache-sync', 'project');
    const pairing = store.createPairing();
    const pairingFile = join(root, 'pairing-code.txt');
    await writeFile(pairingFile, pairing.code + '\n', { mode: 0o600 });
    const controlToken = randomBytes(32).toString('base64url');
    const metadata = { endpoint: proxy.origin + config.basePath, port: proxy.port, certPath: proxy.certPath, root,
      projectPath, rootId: 'cache-sync', projectRelativePath: 'project', projectId: project.id,
      primaryThreadId, secondaryThreadId, controlToken, controlUrl: proxy.origin + config.basePath + '__control',
      seedMarkerPrefix, expectedThreadCount: initial.length, expectedThreadIds: initial.map(thread => thread.id),
      pairingFile, pairingExpiresAt: pairing.expiresAt, cliMarker, acpMarker, model, effort };
    const metadataPath = join(root, 'metadata.json');
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
    const status = async () => {
      const rows = await inventory(adapter);
      const history = await adapter.readThread(primaryThreadId, true, 20_000);
      return { expectedThreadIds: rows.map(thread => thread.id), expectedThreadCount: rows.length,
        primaryTurnCount: history.thread.turns.length, primaryThreadId, secondaryThreadId,
        archivedThreadId, deletedThreadId, renamedThreadId, renamedTitle: 'CACHE_SYNC_EXTERNAL_RENAMED', newThreadId, cliMarker, acpMarker, counts,
        nativeSource: 'official Codex App Server', cliComplete: counts.cliWrites > 0, acpComplete: counts.acpWrites > 0 };
    };
    let externalCompleted = false, cliCompleted = false, acpCompleted = false;
    const externalChanges = async () => {
      assert(!externalCompleted, 'External fixture mutations may run only once; inspect status instead of replaying');
      externalCompleted = true;
      const external = await makeAdapter();
      try {
        for (const id of forks.slice(1, 4)) await ownedThread(external, id);
        archivedThreadId = forks[1]!; await external.archiveThread(archivedThreadId); counts.externalMutations++;
        deletedThreadId = forks[2]!; await external.deleteThread(deletedThreadId); counts.externalMutations++;
        renamedThreadId = forks[3]!; await external.setThreadName(renamedThreadId, 'CACHE_SYNC_EXTERNAL_RENAMED'); counts.externalMutations++;
        await ownedThread(external, primaryThreadId);
        const result = await external.forkThread(primaryThreadId);
        assert.equal(result.thread.cwd, projectPath);
        newThreadId = result.thread.id; owned.add(newThreadId);
        await external.setThreadName(newThreadId, 'CACHE_SYNC_EXTERNAL_NEW'); counts.externalMutations++;
      } finally { await closeAdapter(external); }
      return status();
    };
    const cliUpdate = async () => {
      assert(!cliCompleted, 'CLI write may run only once; never replay an uncertain external write');
      cliCompleted = true;
      await ownedThread(adapter, primaryThreadId);
      const diagnostic: Record<string, unknown> = { startedAt: new Date().toISOString(), phase: 'starting',
        stdoutFile: 'cli-stdout.jsonl', stderrFile: 'cli-stderr.log', stdoutBytes: 0, stderrBytes: 0 };
      const started = Date.now();
      await writeFile(join(root, 'cli-diagnostic.json'), JSON.stringify(diagnostic, null, 2) + '\n', { mode: 0o600 });
      await new Promise<void>((resolve, reject) => {
        const child = spawn(config.codexCommand, ['exec', 'resume', '--skip-git-repo-check', '--model', model,
          '-c', 'model_reasoning_effort="low"', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"',
          '--json', primaryThreadId, '-'], { cwd: projectPath, stdio: ['pipe', 'pipe', 'pipe'] });
        let bytes = 0, stderrBytes = 0, captured = 0, capturedStderr = 0;
        const stdout: Buffer[] = [], stderr: Buffer[] = [];
        const privateLimit = 1024 * 1024;
        let reason: string | undefined;
        const timer = setTimeout(() => { reason = 'FIXTURE_CLI_TIMEOUT'; child.kill('SIGTERM'); }, 180_000);
        diagnostic.pid = child.pid; diagnostic.phase = 'running';
        child.stdout.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (captured < privateLimit) { const part = chunk.subarray(0, privateLimit - captured); stdout.push(part); captured += part.length; }
          if (bytes > 4 * 1024 * 1024) { reason = 'FIXTURE_CLI_OUTPUT_LIMIT'; child.kill('SIGTERM'); }
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderrBytes += chunk.length;
          if (capturedStderr < privateLimit) { const part = chunk.subarray(0, privateLimit - capturedStderr); stderr.push(part); capturedStderr += part.length; }
        });
        child.once('error', error => { reason = 'FIXTURE_CLI_START_FAILED'; diagnostic.spawnErrorCode = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'; });
        // close waits for both stdout/stderr, so a failing process retains its
        // bounded private output. Raw child output is never returned or logged.
        child.once('close', (code, signal) => { void (async () => {
          clearTimeout(timer);
          reason ??= code === 0 ? undefined : 'FIXTURE_CLI_EXIT_FAILED';
          Object.assign(diagnostic, { phase: 'exited', exitCode: code, signal, elapsedMs: Date.now() - started,
            stdoutBytes: bytes, stderrBytes, stdoutTruncated: bytes > captured, stderrTruncated: stderrBytes > capturedStderr,
            reasonCode: reason ?? 'COMPLETED' });
          await writeFile(join(root, 'cli-stdout.jsonl'), Buffer.concat(stdout), { mode: 0o600 });
          await writeFile(join(root, 'cli-stderr.log'), Buffer.concat(stderr), { mode: 0o600 });
          await writeFile(join(root, 'cli-diagnostic.json'), JSON.stringify(diagnostic, null, 2) + '\n', { mode: 0o600 });
          report.cliDiagnostic = { ...diagnostic, pid: undefined };
          if (reason) reject(Object.assign(new Error('CLI fixture completion unconfirmed; inspect private diagnostics, never replay'), { code: reason }));
          else resolve();
        })().catch(reject); });
        child.stdin.end(`Reply exactly ${cliMarker}. Do not use tools, read files, network, skills, MCP, apps or subagents.\n`);
      });
      const { thread } = await adapter.readThread(primaryThreadId, true, 20_000);
      assert(thread.turns.some(turn => turn.items.some(item => item.type === 'agentMessage' && String(item.text ?? '').includes(cliMarker))), 'External CLI marker missing from native stored history');
      counts.cliWrites++;
      return status();
    };
    const acpUpdate = async () => {
      assert(!acpCompleted, 'ACP write may run only once; never replay an uncertain external write');
      acpCompleted = true;
      await ownedThread(adapter, primaryThreadId);
      const child = spawn('codex-acp', [], { cwd: projectPath,
        env: { ...process.env, CODEX_PATH: config.codexCommand, INITIAL_AGENT_MODE: 'read-only', NO_BROWSER: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
      const pending = new Map<number, { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
      let serial = 0, buffer = '', outputBytes = 0;
      const fail = () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('ACP fixture did not confirm completion; do not replay')); } pending.clear(); };
      child.stderr.resume(); child.once('error', fail); child.once('exit', fail);
      child.stdout.on('data', chunk => {
        outputBytes += chunk.length;
        if (outputBytes > 4 * 1024 * 1024) { fail(); child.kill('SIGTERM'); return; }
        buffer += chunk.toString('utf8');
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const response: unknown = JSON.parse(line);
            if (!record(response)) throw new Error();
            if (typeof response.method === 'string' && response.id !== undefined) {
              // Test client advertises no tool facilities and never grants a tool permission.
              const result = response.method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : undefined;
              child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: response.id, ...(result ? { result } : { error: { code: -32601, message: 'No tool facilities in this fixture' } }) }) + '\n');
            } else if (typeof response.id === 'number') {
              const request = pending.get(response.id);
              if (!request) continue;
              pending.delete(response.id); clearTimeout(request.timer);
              if (response.error || !record(response.result)) request.reject(new Error('ACP fixture request failed; do not replay'));
              else request.resolve(response.result);
            }
          } catch { fail(); child.kill('SIGTERM'); }
        }
      });
      const rpc = (method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('ACP fixture exceeded deadline; do not replay')); }, 180_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
      try {
        await rpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'oraculum-cache-sync-acceptance', version: '1' } });
        await rpc('session/load', { sessionId: primaryThreadId, cwd: projectPath, mcpServers: [] });
        await rpc('session/prompt', { sessionId: primaryThreadId, prompt: [{ type: 'text', text: `Reply exactly ${acpMarker}. Do not use tools, read files, network, skills, MCP, apps or subagents.` }] });
      } finally { fail(); child.stdin.end(); child.kill('SIGTERM'); }
      const { thread } = await adapter.readThread(primaryThreadId, true, 20_000);
      assert(thread.turns.some(turn => turn.items.some(item => item.type === 'agentMessage' && String(item.text ?? '').includes(acpMarker))), 'External ACP marker missing from native stored history');
      counts.acpWrites++;
      return status();
    };
    let controlQueue = Promise.resolve();
    const control = async (command: string): Promise<unknown> => {
      const controls = report.controls as unknown[];
      controls.push({ command, at: new Date().toISOString() });
      if (command === 'status') return status();
      if (command === 'pair') {
        const renewed = store!.createPairing();
        await writeFile(pairingFile, renewed.code + '\n', { mode: 0o600 });
        metadata.pairingExpiresAt = renewed.expiresAt;
        await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
        return { pairingFile, pairingExpiresAt: renewed.expiresAt };
      }
      if (command === 'externalChanges') return externalChanges();
      if (command === 'cliUpdate') return cliUpdate();
      if (command === 'acpUpdate') return acpUpdate();
      if (command === 'cycleConnection') {
        counts.connectionCycles++;
        setTimeout(() => { proxy.setOnline(false); setTimeout(() => proxy.setOnline(true), 4000); }, 500);
        return { scheduled: true, offlineAfterMs: 500, offlineForMs: 4000 };
      }
      if (command === 'stop') { setTimeout(stop, 300); return { stopping: true }; }
      throw new Error('Unsupported fixed fixture control');
    };
    server = await createGatewayServer(gateway, config);
    server.post(config.basePath + '__control', async (request, reply) => {
      if (request.headers['x-oraculum-test-control'] !== controlToken) return reply.code(403).send({ error: 'FIXTURE_CONTROL_FORBIDDEN' });
      const body = request.body;
      if (!record(body) || Object.keys(body).join() !== 'command' || typeof body.command !== 'string') return reply.code(400).send({ error: 'FIXTURE_CONTROL_INVALID' });
      // This authenticated test-only control can wait for a fixed native/CLI/ACP
      // operation. Its socket must outlive that operation's 180s deadline; the
      // product Gateway's ordinary 15s connection budget remains unchanged.
      request.raw.socket.setTimeout(195_000);
      let result: unknown;
      const work = controlQueue.then(async () => { result = await control(body.command as string); });
      controlQueue = work.catch(() => {});
      try { await work; return result; }
      catch (error) { (report.controls as unknown[]).push({ command: body.command, errorCode: safeCode(error) }); return reply.code(503).send({ error: safeCode(error), noReplay: true }); }
    });
    await server.listen({ host: config.host, port: config.port });
    emit({ event: 'ready', metadataPath, port: proxy.port, certPath: proxy.certPath, expectedThreadCount: initial.length, counts });
    // Local stdin is also usable for safe status/shutdown; it carries no credentials.
    const input = createInterface({ input: process.stdin, terminal: false });
    input.on('line', line => { void (async () => {
      try { const command = JSON.parse(line).command; assert(['status', 'pair', 'stop'].includes(command)); const result = await control(command); emit({ event: 'control', command, result }); }
      catch { emit({ event: 'control-error', code: 'FIXTURE_CONTROL_INVALID' }); }
    })(); });
    await stopped;
    input.close(); process.stdin.pause();
    await controlQueue;
    report.result = 'passed';
  } catch (error) {
    report.result = 'failed'; report.errorCode = safeCode(error); process.exitCode = 1;
    emit({ event: 'failed', code: safeCode(error), root });
  } finally {
    stopping = true;
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    const cleanupErrors = report.cleanupErrors as string[];
    try { await server?.close(); } catch { cleanupErrors.push('isolated HTTP/WSS'); }
    try { await gateway?.close(); } catch { cleanupErrors.push('isolated Gateway'); }
    for (const adapter of adapters) { try { await adapter.close(); } catch { cleanupErrors.push('dedicated App Server'); } }
    try { store?.close(); } catch { cleanupErrors.push('temporary SQLite'); }
    try { await proxy.close(); } catch { cleanupErrors.push('temporary TLS proxy'); }
    report.codexConfigUnchanged = originalConfig === await nativeConfigHash();
    report.finishedAt = new Date().toISOString();
    if (cleanupErrors.length || !report.codexConfigUnchanged) { report.result = 'failed'; process.exitCode = 1; }
    const reportPath = join(root, 'fixture-report.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    emit({ event: 'stopped', result: report.result, reportPath, codexConfigUnchanged: report.codexConfigUnchanged, cleanupErrors });
  }
}
main().catch(() => { process.stderr.write('Cache-sync device fixture failed safely.\n'); process.exitCode = 1; });
