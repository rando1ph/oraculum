// Opt-in real Harness audit: existing login/config, one read-only model turn.
// pnpm exec tsx scripts/native-capabilities-live.ts
// Uses two authenticated WS devices and an isolated Bridge, then restarts it.
// Native Codex history persists; private evidence and test trust stay in .local.
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer as probeServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Codex } from '../bridge/src/codex';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
import { TrustStore } from '../bridge/src/trust-store';
import { ReceiptStore } from '../bridge/src/receipts';
import { ProjectDirectories } from '../bridge/src/projects';
import type { Approval, BridgeEvent, LocalConfig, Snapshot, ThreadItem, WireMessage } from '../packages/shared/protocol';
import type { ThreadStartResponse } from '../.local/codex-protocol/v2/ThreadStartResponse';
import type { TurnStartResponse } from '../.local/codex-protocol/v2/TurnStartResponse';

const cwd = await realpath(process.cwd());
const port = Number(process.env.ORACULUM_AUDIT_PORT ?? 17873);
assert(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Invalid audit port');
const origin = `http://127.0.0.1:${port}`;
const evidenceDir = join(cwd, '.local/evidence/native-capabilities');
const stateDir = join(evidenceDir, 'state');

async function serve() {
  const trust = new TrustStore(stateDir);
  const projects = new ProjectDirectories(dirname(cwd), cwd, trust.db);
  await projects.register(cwd);
  const codex = new Codex(cwd);
  const service = new BridgeService(codex, cwd, new ReceiptStore(trust.db), projects);
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server?.close();
    await codex.close();
    trust.close();
  };
  try {
    await codex.initialize();
    server = await createServer(service, port, join(cwd, 'apps/web/dist'), { trust });
    await server.listen({ host: '127.0.0.1', port });
    process.once('SIGTERM', () => void close());
    process.once('SIGINT', () => void close());
  } catch (error) { await close(); throw error; }
}

async function until(predicate: () => boolean | Promise<boolean>, label: string, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

class Device {
  socket?: WebSocket;
  events: BridgeEvent[] = [];
  private waiting = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  constructor(readonly cookie: string) {}
  async connect() {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { origin, headers: { cookie: this.cookie } });
    this.socket = socket;
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString()) as WireMessage & BridgeEvent;
      if (typeof message.id === 'string' && this.waiting.has(message.id)) {
        const request = this.waiting.get(message.id)!;
        this.waiting.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      } else if (message.type) this.events.push(message);
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      for (const request of this.waiting.values()) request.reject(new Error('Audit device disconnected'));
      this.waiting.clear();
    });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  }
  rpc<T>(method: string, params: object): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 65_000);
      this.waiting.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value as T); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
  }
  async close() {
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>(resolve => this.socket!.once('close', () => resolve()));
    this.socket.close();
    await closed;
  }
}

function summarize(item: ThreadItem) {
  const base = { id: item.id, type: item.type };
  if (item.type === 'mcpToolCall') return { ...base, server: item.server, tool: item.tool,
    status: item.status, resultReceived: item.result !== null, hasError: item.error !== null,
    pluginId: item.pluginId, appContext: item.appContext, readOnlyHint: item.readOnlyHint,
    contentTypes: item.result?.content.map(part => part && typeof part === 'object' && !Array.isArray(part) ? part.type : null) };
  if (item.type === 'commandExecution') return { ...base, status: item.status, exitCode: item.exitCode,
    ordinarySkillRead: item.command.includes('scientific-critical-thinking/SKILL.md') };
  if (item.type === 'collabAgentToolCall') return { ...base, tool: item.tool, status: item.status,
    receiverThreadIds: item.receiverThreadIds,
    agents: Object.entries(item.agentsStates).map(([id, state]) => ({ id, status: state?.status, answered42: state?.message?.trim() === '42' })) };
  if (item.type === 'subAgentActivity') return { ...base, kind: item.kind, agentThreadId: item.agentThreadId };
  return base;
}

async function audit() {
  await new Promise<void>((resolve, reject) => {
    const probe = probeServer(); probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
  });
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const configPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
  const configHash = async () => createHash('sha256').update(await readFile(configPath)).digest('hex');
  const initialConfigHash = await configHash();
  const evidence: Record<string, unknown> = { date: new Date().toISOString(), cwd, codexHome: dirname(configPath),
    codex: '0.160.0', experimentalApi: false, authenticatedDevices: 2, modelTurns: 0,
    configurationOverrides: [], transport: 'Two authenticated loopback WebSocket clients; no GUI or Android claim' };
  let child: ChildProcess | undefined;
  let trust: TrustStore | undefined;
  const devices: Device[] = [];
  const deviceIds: string[] = [];
  let step = 'start isolated Bridge';
  const start = async () => {
    child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--serve'], {
      cwd, stdio: 'ignore', env: process.env,
    });
    await until(async () => {
      if (child?.exitCode !== null) throw new Error('Audit Bridge exited');
      try { return (await fetch(origin + '/health')).status === 200; } catch { return false; }
    }, 'Bridge readiness');
  };
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const processToStop = child;
    const exited = new Promise<void>(resolve => processToStop.once('exit', () => resolve()));
    processToStop.kill('SIGTERM');
    const timer = setTimeout(() => processToStop.kill('SIGKILL'), 10_000);
    try { await exited; } finally { clearTimeout(timer); }
    child = undefined;
  };
  const pair = async (label: string) => {
    const response = await fetch(origin + '/auth/pair', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ label, code: trust!.createPairing().code }) });
    assert.equal(response.status, 200);
    deviceIds.push((await response.json() as { device: { id: string } }).device.id);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert(cookie, 'Pairing cookie missing');
    const device = new Device(cookie); devices.push(device); await device.connect(); return device;
  };
  try {
    await start();
    trust = new TrustStore(stateDir);
    assert.equal((await fetch(origin + '/auth/session')).status, 401, 'Anonymous session must fail');
    const first = await pair('Native audit device A');
    const second = await pair('Native audit device B');
    evidence.config = await first.rpc<LocalConfig>('bridge/config', { cwd });
    step = 'native configured capability turn';
    const thread = await first.rpc<ThreadStartResponse>('thread/start', { cwd });
    const threadId = thread.thread.id;
    evidence.thread = { id: threadId, model: thread.model, effort: thread.reasoningEffort,
      approvalPolicy: thread.approvalPolicy, sandbox: thread.sandbox, approvalsReviewer: thread.approvalsReviewer };
    await second.rpc('bridge/subscribe', { threadId });
    const operationId = randomUUID();
    const text = `This is a bounded read-only Oraculum P0 capability audit. Do not implement anything, edit any files/config, install anything, create goals, or write to external services. Use existing configured capabilities without enabling features. Run each check once, with no retries.
1. Use the DIRECT configured MCP server named notion, tool notion-fetch (not codex_apps notion.fetch), to read these authorized pages: https://app.notion.com/p/3ff5421e690b81bdae14c0675f0b3acf and https://app.notion.com/p/4015421e690b8196ad13e068d5bfa34a. Report only titles and Task status.
2. Explicitly invoke the installed ordinary scientific-critical-thinking skill: read its SKILL.md and apply it to the toy claim 'Two potted plants grew more after fertilizer, therefore fertilizer always works.' Give one limitation, without research.
3. Use connected GitHub App/plugin read-only get_repo to fetch public repository metadata for rando1ph/oraculum. No issues/commits/actions. Report only name and success.
4. Use native web search once for official OpenAI Codex App Server documentation, then open one official documentation result. No shell network.
5. If native subagent tools are available, spawn exactly ONE child with task 'Do not use tools or read files. Return the value of 6*7.' Wait for its reply. Close it if a close tool exists. Do not change model or effort. Otherwise report unavailable.
Finish with a terse evidence-based checklist. If a tool fails or access is missing, report that without retries. Do not merely claim completion without invoking each available tool.`;
    const result = await first.rpc<TurnStartResponse>('turn/start', { threadId, text, operationId });
    evidence.modelTurns = 1;
    evidence.turnId = result.turn.id;
    evidence.operationId = operationId;
    const answered = new Set<string | number>();
    const interactions: { method: string; action: string }[] = [];
    await until(async () => {
      for (const event of first.events) if (event.type === 'approval' && !answered.has(event.request.id)) {
        const request: Approval = event.request;
        answered.add(request.id);
        // No automatic access grants. Existing read-only tools normally need none.
        const reply = request.method === 'mcpServer/elicitation/request' ? { result: { action: 'decline' } }
          : request.method === 'item/tool/requestUserInput' ? { result: { answers: {} } } : { decision: 'decline' };
        await first.rpc('bridge/approve', { threadId, requestId: request.id, bridgeToken: request.bridgeToken, ...reply });
        interactions.push({ method: request.method, action: 'declined / no input supplied' });
      }
      return first.events.some(event => event.type === 'event' && event.event.method === 'turn/completed' && event.event.params.turn.id === result.turn.id);
    }, 'bounded native turn', 300_000);
    const items = first.events.flatMap(event => event.type === 'event' && event.event.method === 'item/completed' ? [event.event.params.item] : []);
    const completedIds = (device: Device) => device.events.flatMap(event => event.type === 'event' && event.event.method === 'item/completed' ? [event.event.params.item.id] : []).sort();
    await until(() => JSON.stringify(completedIds(first)) === JSON.stringify(completedIds(second)), 'both devices observe native items');
    const checks = {
      directNotion: items.some(i => i.type === 'mcpToolCall' && i.server === 'notion' && /fetch/.test(i.tool) && i.status === 'completed' && i.result !== null && i.error === null),
      ordinarySkill: items.some(i => i.type === 'commandExecution' && i.exitCode === 0 && i.command.includes('scientific-critical-thinking/SKILL.md')),
      githubApp: items.some(i => i.type === 'mcpToolCall' && i.server === 'codex_apps' && /github.*get_repo/.test(i.tool) && i.status === 'completed' && i.result !== null && i.error === null),
      webSearch: items.some(i => i.type === 'webSearch'),
      subagent: items.some(i => i.type === 'subAgentActivity' && i.kind === 'completed' &&
        items.some(start => start.type === 'subAgentActivity' && start.kind === 'started' && start.agentThreadId === i.agentThreadId)) ||
        items.some(i => i.type === 'collabAgentToolCall' && i.status === 'completed' && Object.values(i.agentsStates).some(s => s?.status === 'completed' && s.message?.trim() === '42')),
    };
    evidence.items = items.map(summarize);
    evidence.checks = checks;
    evidence.interactions = interactions;
    evidence.bothDevicesObservedSameItems = true;
    const verifySnapshot = (snapshot: Snapshot) => {
      assert(snapshot.thread.turns.some(t => t.id === result.turn.id && t.status === 'completed'), 'Native completed turn missing');
      assert.equal(snapshot.receipts?.filter(r => r.operationId === operationId && r.status === 'completed' && r.turnId === result.turn.id).length, 1);
      assert.equal(snapshot.sendBlocked, false);
      assert.equal(snapshot.pending.length, 0);
      assert.deepEqual(snapshot.settings, { approvalPolicy: thread.approvalPolicy, sandbox: thread.sandbox, approvalsReviewer: thread.approvalsReviewer });
      return { turnIds: snapshot.thread.turns.map(t => t.id), itemIds: snapshot.thread.turns.flatMap(t => t.items.map(i => i.id)).sort(), history: snapshot.history };
    };
    step = 'two-device reconnect';
    const snapshots = await Promise.all(devices.map(d => d.rpc<Snapshot>('bridge/subscribe', { threadId })));
    const before = snapshots.map(verifySnapshot);
    assert.deepEqual(before[0], before[1]);
    for (const device of devices) { await device.close(); await device.connect(); }
    for (const device of devices) assert.deepEqual(verifySnapshot(await device.rpc('bridge/subscribe', { threadId })), before[0]);
    evidence.reconnectRestored = true;
    step = 'Bridge and App Server restart';
    for (const device of devices) await device.close();
    await stop(); await start();
    for (const device of devices) {
      await device.connect();
      const listed = await device.rpc<{ data: { id: string }[] }>('thread/list', { cwd });
      assert(listed.data.some(t => t.id === threadId), 'Audit thread missing from native list');
      assert.deepEqual(verifySnapshot(await device.rpc('bridge/subscribe', { threadId })), before[0]);
      await assert.rejects(device.rpc('turn/start', { threadId, text: 'Must not run', operationId }), /Operation already recorded/);
    }
    evidence.restartRestored = true;
    evidence.duplicateOperationRejected = true;
    evidence.configUnchanged = await configHash() === initialConfigHash;
    assert.equal(evidence.configUnchanged, true);
    evidence.result = Object.values(checks).every(Boolean) ? 'passed' : 'completed with capability limitations';
    console.log(JSON.stringify({ result: evidence.result, checks, reconnectRestored: true, restartRestored: true, configUnchanged: true }));
  } catch (error) {
    evidence.result = 'failed'; evidence.step = step;
    // Never persist arbitrary upstream error bodies, cookies, prompts or tool output.
    evidence.failure = error instanceof Error ? error.name : 'Error';
    console.error(`Native capability audit failed at ${step}; inspect sanitized evidence.`);
    process.exitCode = 1;
  } finally {
    for (const device of devices) await device.close();
    await stop();
    for (const id of deviceIds) trust?.revoke(id);
    trust?.close();
    evidence.configUnchanged = await configHash() === initialConfigHash;
    await writeFile(join(evidenceDir, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  }
}

if (process.argv.includes('--serve')) await serve();
else await audit();
