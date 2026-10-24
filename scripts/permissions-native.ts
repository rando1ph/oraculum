// Opt-in real installed Codex protocol test. No inference, login, or real project
// data: the provider is deliberately unreachable loopback and turns are stopped.
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Codex, NativeRpcError } from '../bridge/src/codex';
import { BridgeService } from '../bridge/src/service';
import { ReceiptStore } from '../bridge/src/receipts';
import { ThreadPermissionStore } from '../bridge/src/thread-permissions';
import type { BridgeEvent, NativeSessionSettings, PermissionMode, Snapshot } from '../packages/shared/protocol';
import type { ThreadStartResponse } from '../.local/codex-protocol/v2/ThreadStartResponse';
import type { TurnStartResponse } from '../.local/codex-protocol/v2/TurnStartResponse';

const originalHome = process.env.CODEX_HOME;
const configPath = join(originalHome || join(homedir(), '.codex'), 'config.toml');
const hash = async () => createHash('sha256').update(await readFile(configPath).catch(() => Buffer.alloc(0))).digest('hex');
const baseline = await hash();
const root = await mkdtemp(join(tmpdir(), 'oraculum-permissions-native-'));
const isolatedCodexHome = join(root, 'codex-home'), cwd = join(root, 'project');
await mkdir(isolatedCodexHome); await mkdir(cwd);
await writeFile(join(isolatedCodexHome, 'config.toml'), `model = "gpt-5.4"
model_provider = "permission_probe"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
[sandbox_workspace_write]
network_access = true
writable_roots = [${JSON.stringify(root)}]
exclude_tmpdir_env_var = true
exclude_slash_tmp = true
[model_providers.permission_probe]
name = "Local permission protocol probe (no inference)"
base_url = "http://127.0.0.1:1/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
`, { mode: 0o600 });
process.env.CODEX_HOME = isolatedCodexHome;
const db = new DatabaseSync(':memory:');
const receipts = new ReceiptStore(db);
const permissionChoices = new ThreadPermissionStore(db);
const evidence: Record<string, unknown> = { date: new Date().toISOString(), realAppServer: true, inference: false,
  isolation: 'temporary CODEX_HOME/project, in-memory receipts, offline loopback provider', checks: [] };
const checks = evidence.checks as unknown[];
const restartCases: { threadId: string; mode: PermissionMode; sandboxType: string; approvalPolicy: string }[] = [];
let codex: Codex | undefined;
try {
  codex = new Codex(cwd);
  evidence.version = codex.version;
  const service = new BridgeService(codex, cwd, receipts, undefined, permissionChoices);
  const settings = new Map<string, NativeSessionSettings>();
  const completed = new Set<string>();
  const startedTurns = new Set<string>();
  service.on('event', (event: BridgeEvent) => {
    if (event.type === 'settingsChanged') {
      if (event.settings) settings.set(event.threadId, event.settings); else settings.delete(event.threadId);
    }
    if (event.type === 'event' && event.event.method === 'turn/completed') completed.add(event.event.params.turn.id);
    if (event.type === 'event' && event.event.method === 'turn/started') startedTurns.add(event.event.params.turn.id);
    if (event.type === 'approval') throw new Error('No tools or approval requests expected in this protocol-only probe');
  });
  await codex.initialize();
  const presets: [PermissionMode, string, string][] = [
    ['read-only', 'on-request', 'readOnly'], ['auto', 'on-request', 'workspaceWrite'], ['full-access', 'never', 'dangerFullAccess'],
  ];
  // Start replies confirm actual native resolution, including Auto normalization.
  for (const [index, [permissionMode, approvalPolicy, sandboxType]] of [...presets, presets[1]].entries()) {
    const result = await service.dispatch('thread/start', index === 3 ? {} : { permissionMode }) as ThreadStartResponse;
    assert.equal(result.approvalPolicy, approvalPolicy); assert.equal(result.sandbox.type, sandboxType);
    if (permissionMode === 'auto' && index !== 3) assert.deepEqual(result.sandbox, { type: 'workspaceWrite', writableRoots: [],
      networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
    checks.push({ stage: 'new-thread', permissionMode, actual: settings.get(result.thread.id) });
    // Persist a real native rollout for each preset, with zero inference: the
    // only provider is unreachable loopback and every turn is interrupted.
    const turn = await service.dispatch('turn/start', { threadId: result.thread.id,
      text: 'Offline permission persistence probe. Do not use tools.', permissionMode, operationId: randomUUID() },
      { deviceId: 'isolated-permission-test' }) as TurnStartResponse;
    for (let attempt = 0; attempt < 100 && permissionChoices.get(cwd, result.thread.id) !== permissionMode; attempt++) await delay(25);
    assert.equal(permissionChoices.get(cwd, result.thread.id), permissionMode);
    for (let attempt = 0; attempt < 100 && !startedTurns.has(turn.turn.id) && !completed.has(turn.turn.id); attempt++) await delay(25);
    assert.ok(startedTurns.has(turn.turn.id) || completed.has(turn.turn.id));
    if (!completed.has(turn.turn.id)) await service.dispatch('turn/interrupt', { threadId: result.thread.id, turnId: turn.turn.id }).catch(error => {
      if (!(error instanceof NativeRpcError) || !/no active turn to interrupt/.test(error.message)) throw error;
    });
    for (let attempt = 0; attempt < 100 && !completed.has(turn.turn.id); attempt++) await delay(25);
    assert.ok(completed.has(turn.turn.id));
    checks.push({ stage: index === 3 ? 'auto-after-inherited-custom-roots' : 'preset-before-restart', permissionMode, actual: settings.get(result.thread.id) });
    restartCases.push({ threadId: result.thread.id, mode: permissionMode, sandboxType, approvalPolicy });
  }
  const inherited = await service.dispatch('thread/start', {}) as ThreadStartResponse;
  assert.equal(inherited.sandbox.type, 'workspaceWrite');
  assert.equal(inherited.sandbox.type === 'workspaceWrite' && inherited.sandbox.networkAccess, true);
  const threadId = inherited.thread.id;
  checks.push({ stage: 'inherit-project', actual: settings.get(threadId) });
  const sequence = [...presets, ['inherit', 'never', 'dangerFullAccess'], presets[0]] as typeof presets;
  for (const [permissionMode, approvalPolicy, sandboxType] of sequence) {
    const operationId = randomUUID();
    const result = await service.dispatch('turn/start', { threadId, text: 'Permission transport probe. Do not use tools.', permissionMode, operationId },
      { deviceId: 'isolated-permission-test' }) as TurnStartResponse;
    for (let attempt = 0; attempt < 100 && settings.get(threadId)?.sandbox.type !== sandboxType; attempt++) await delay(50);
    assert.equal(settings.get(threadId)?.approvalPolicy, approvalPolicy);
    assert.equal(settings.get(threadId)?.sandbox.type, sandboxType);
    if (!completed.has(result.turn.id)) await service.dispatch('turn/interrupt', { threadId, turnId: result.turn.id }).catch(error => {
      if (!(error instanceof NativeRpcError) || !/no active turn to interrupt/.test(error.message)) throw error;
    });
    for (let attempt = 0; attempt < 100 && !completed.has(result.turn.id); attempt++) await delay(50);
    assert.ok(completed.has(result.turn.id), 'Native terminal event required before next independent turn');
    const snapshot = await service.dispatch('bridge/subscribe', { threadId }) as Snapshot;
    assert.equal(snapshot.settings?.sandbox.type, sandboxType);
    assert.equal(snapshot.sendBlocked, false);
    assert.ok(['interrupted', 'failed'].includes(receipts.list(cwd, threadId)[0].status));
    checks.push({ stage: 'existing-thread', permissionMode, actual: snapshot.settings, terminal: receipts.list(cwd, threadId)[0].status });
  }
  // Restart only our own isolated App Server and Bridge; trust native resolution.
  await codex.close(); codex = new Codex(cwd); await codex.initialize();
  const restored = new BridgeService(codex, cwd, receipts, undefined, permissionChoices);
  await restored.dispatch('thread/list', {});
  for (const test of restartCases) {
    const resumed = await restored.dispatch('bridge/subscribe', { threadId: test.threadId }) as Snapshot;
    assert.equal(resumed.settings?.sandbox.type, test.sandboxType);
    assert.equal(resumed.settings?.approvalPolicy, test.approvalPolicy);
    assert.equal(resumed.sendBlocked, false);
    checks.push({ stage: 'preset-after-bridge-and-native-restart', permissionMode: test.mode, actual: resumed.settings });
  }
  const snapshot = await restored.dispatch('bridge/subscribe', { threadId }) as Snapshot;
  const native = await codex.request<ThreadStartResponse>('thread/resume', { threadId });
  assert.deepEqual(snapshot.settings, { approvalPolicy: native.approvalPolicy, sandbox: native.sandbox, approvalsReviewer: native.approvalsReviewer, model: native.model, effort: native.reasoningEffort });
  assert.equal(snapshot.settings?.sandbox.type, 'readOnly', 'Explicit thread choice must survive Bridge/AppServer restart');
  checks.push({ stage: 'bridge-and-native-restart', actual: snapshot.settings });
  assert.equal(await hash(), baseline, 'Real global config must remain byte-identical');
  evidence.globalConfigUnchanged = true;
  const directory = resolve('.local/evidence/phase4d3-patch'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'native-permissions.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await codex?.close(); db.close();
  if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome;
  await rm(root, { recursive: true, force: true });
}
