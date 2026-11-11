/** Deterministic process-crash injection. Codex here is explicitly simulated; gateway-live.ts covers the official native server. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewayStore, randomCredential, type OperationInput } from '../gateway/src/store';
import { initGatewayConfig, loadGatewayConfig } from '../gateway/src/config';
import { CodexAdapter, type NativeThreadResult } from '../gateway/src/codex';
import { GatewayService, type Authorized } from '../gateway/src/service';

type Point = 'before-reserve' | 'after-reserve' | 'native-received' | 'native-ack-before-save';
const points: Point[] = ['before-reserve', 'after-reserve', 'native-received', 'native-ack-before-save'];
const kill = () => { process.kill(process.pid, 'SIGKILL'); throw new Error('SIGKILL did not terminate fixture'); };
class SimulatedCodex extends EventEmitter {
  alive = true;
  constructor(readonly root: string, readonly point?: Point) { super(); }
  async startThread(options: { cwd: string }): Promise<NativeThreadResult> {
    // Durable oracle outside SQLite records how many times the simulated native side really receives a write.
    const fd = openSync(join(this.root, 'native-received.txt'), 'a', 0o600);
    try { writeSync(fd, 'thread/start\n'); fsyncSync(fd); } finally { closeSync(fd); }
    if (this.point === 'native-received') kill();
    return { thread: { id: 'fixture-native-thread', cwd: options.cwd, preview: '', turns: [], status: { type: 'idle' } }, approvalPolicy: 'on-request', sandbox: { type: 'readOnly' } };
  }
  async close() { this.alive = false; }
}
const authorized = (store: GatewayStore, deviceId: string): Authorized => ({ deviceId, check() { const device = store.getDevice(deviceId); assert.ok(device && device.revokedAt === null, 'Fixture device must remain authorized'); } });
const calls = async (root: string) => { try { return (await readFile(join(root, 'native-received.txt'), 'utf8')).split('\n').filter(Boolean).length; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; } };

async function child(root: string, point: Point, deviceId: string, projectId: string, operationId: string) {
  assert.ok(points.includes(point), 'Invalid crash point');
  const config = loadGatewayConfig(join(root, 'config', 'config.json')), store = new GatewayStore(config.stateDir);
  const codex = new SimulatedCodex(root, point), service = new GatewayService(store, config, codex as unknown as CodexAdapter);
  const originalReserve = store.reserveOperation.bind(store), originalTransaction = store.transaction.bind(store), originalFinish = store.finishOperation.bind(store);
  let depth = 0, reserved = false;
  store.reserveOperation = (input: OperationInput) => {
    if (point === 'before-reserve' && input.operationId === operationId) kill();
    const result = originalReserve(input); if (input.operationId === operationId) reserved = true; return result;
  };
  store.transaction = <T>(work: () => T): T => {
    depth++;
    try {
      const result = originalTransaction(work);
      // reserveOperation may be nested in the attachment/receipt transaction. Kill only after the OUTER commit.
      if (point === 'after-reserve' && depth === 1 && reserved) kill();
      return result;
    } finally { depth--; }
  };
  store.finishOperation = (...args: Parameters<GatewayStore['finishOperation']>) => {
    if (point === 'native-ack-before-save' && args[0] === operationId && args[1] === 'accepted') kill();
    return originalFinish(...args);
  };
  await service.startThread(authorized(store, deviceId), projectId, { operationId, expectedEpoch: service.epoch, permissionPreset: 'read-only' });
  throw new Error('Fixture missed the requested crash point');
}

async function run() {
  const output = await mkdtemp(join(tmpdir(), 'oraculum-gateway-faults-'));
  const evidence: Record<string, unknown> = { result: 'running', output, nativeMode: 'SIMULATED CodexAdapter, no official Codex process or model invocation', cases: [] };
  try {
    for (const point of points) {
      const root = join(output, point); await mkdir(root, { mode: 0o700 }); await mkdir(join(root, 'project'), { mode: 0o700 });
      const config = initGatewayConfig({ configPath: join(root, 'config', 'config.json'), stateDir: join(root, 'state'), allowedRoots: [{ id: 'fixture', path: root }] });
      let store = new GatewayStore(config.stateDir, { create: true });
      const devices = [randomUUID(), randomUUID()];
      for (const deviceId of devices) store.pair({ installationId: store.installationId, deviceId, deviceCredential: randomCredential(), code: store.createPairing().code, label: 'Process crash fixture' });
      const codex = new SimulatedCodex(root), initial = new GatewayService(store, config, codex as unknown as CodexAdapter);
      const project = await initial.projects.register('fixture', 'project');
      const operationId = randomUUID(); store.close();
      const subprocess = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--child', root, point, devices[0], project.id, operationId], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
      // Do not print child output; a failing future adapter could accidentally include native payloads.
      subprocess.stderr.resume();
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { const timer = setTimeout(() => { subprocess.kill('SIGKILL'); reject(new Error('Crash fixture timed out')); }, 20_000); subprocess.once('error', reject); subprocess.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); }); });
      assert.equal(exit.signal, 'SIGKILL', `${point}: child did not terminate at a crash boundary`);
      store = new GatewayStore(config.stateDir);
      const native = new SimulatedCodex(root), recovered = new GatewayService(store, config, native as unknown as CodexAdapter);
      const owner = authorized(store, devices[0]), other = authorized(store, devices[1]);
      const firstCalls = await calls(root), saved = store.getOperation(operationId, devices[0]);
      const attempt = (actor: Authorized, id = operationId) => recovered.startThread(actor, project.id, { operationId: id, expectedEpoch: recovered.epoch, permissionPreset: 'read-only' });
      if (point === 'before-reserve') {
        assert.equal(saved, undefined, 'Pre-reserve crash must not invent a receipt'); assert.equal(firstCalls, 0, 'Pre-reserve native dispatch');
        // No auto retry exists. This explicit harness command demonstrates only the known pre-send cut.
        const retried = await attempt(owner); assert.equal(retried.status, 'accepted', 'Explicit pre-reserve test retry failed');
      } else {
        assert.equal(saved?.status, 'unknown', `${point}: uncertain delivery must remain unknown after restart`);
        assert.equal(firstCalls, point === 'after-reserve' ? 0 : 1, `${point}: unexpected native delivery count`);
      }
      const expectedCalls = point === 'after-reserve' ? 0 : 1;
      for (const actor of [owner, other]) await assert.rejects(attempt(actor), (error: any) => ['OPERATION_ALREADY_RECORDED', 'OPERATION_UNKNOWN'].includes(error.code), `${point}: duplicate ID must not dispatch`);
      assert.equal(store.getOperation(operationId, devices[1]), undefined, 'Cross-device receipt leaked');
      if (point !== 'before-reserve') {
        for (const actor of [owner, other]) await assert.rejects(attempt(actor, randomUUID()), (error: any) => error.code === 'OPERATION_UNKNOWN', `${point}: workspace barrier must block a different ID before native dispatch`);
      }
      assert.equal(await calls(root), expectedCalls, `${point}: native command was dispatched twice`);
      assert.equal((store.db.prepare('PRAGMA integrity_check').get() as Record<string, string>).integrity_check, 'ok', 'SQLite crash recovery failed');
      const recoveredStatus = store.getOperation(operationId, devices[0])?.status;
      store.close();
      (evidence.cases as unknown[]).push({ point, signal: exit.signal, nativeDeliveriesBeforeRestart: firstCalls, nativeDeliveriesAfterRecoveryChecks: expectedCalls, recoveredStatus, duplicateSameDeviceBlocked: true, duplicateCrossDeviceBlocked: true, receiptOwnerIsolated: true, workspaceBarrier: point === 'before-reserve' ? 'not applicable: accepted explicit test retry' : 'blocked both devices without dispatch', sqliteIntegrity: 'ok' });
    }
    evidence.result = 'passed';
  } catch (error) { evidence.result = 'failed'; evidence.error = error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'Process crash acceptance failed'; process.exitCode = 1; }
  await writeFile(join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(evidence, null, 2));
}
if (process.argv[2] === '--child') await child(process.argv[3], process.argv[4] as Point, process.argv[5], process.argv[6], process.argv[7]);
else await run();
