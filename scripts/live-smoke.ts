import { strict as assert } from 'node:assert';
import { writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { Snapshot, WireMessage } from '../packages/shared/protocol';
import type { ThreadStartResponse } from '../.local/codex-protocol/v2/ThreadStartResponse';
import type { ModelListResponse } from '../.local/codex-protocol/v2/ModelListResponse';

const origin = process.env.ORACULUM_URL ?? 'http://127.0.0.1:17860';
const evidence: Record<string, unknown> = { date: new Date().toISOString(), codex: '0.160.0', events: [] };
let socket!: WebSocket;
const waiting = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const notifications: WireMessage[] = [];
async function connect() {
  socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { origin });
  socket.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.id && waiting.has(message.id)) {
      const pending = waiting.get(message.id)!;
      waiting.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    } else {
      notifications.push(message);
    }
  });
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
}
async function rpc<T>(method: string, params: object): Promise<T> {
  const id = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Timeout: ${method}`)); }, 65_000);
    waiting.set(id, { resolve: value => { clearTimeout(timer); resolve(value as T); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function until(predicate: () => boolean, label: string, timeout = 120_000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`Timeout: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
const rawEvents = notifications as Array<{ type: string; event?: { method: string; params: any }; request?: any }>;
try {
  await connect();
  const models = await rpc<ModelListResponse>('model/list', {});
  evidence.models = models.data.map(model => ({ model: model.model, efforts: model.supportedReasoningEfforts.map(e => e.reasoningEffort) }));
  assert(models.data.some(model => model.model === 'gpt-6-luna'));
  const thread = await rpc<ThreadStartResponse>('thread/start', { model: 'gpt-6-luna' });
  evidence.thread = { id: thread.thread.id, model: thread.model, effort: thread.reasoningEffort, approvalPolicy: thread.approvalPolicy, reviewer: thread.approvalsReviewer, sandbox: thread.sandbox.type };
  const threadId = thread.thread.id;
  const result = await rpc<{ turn: { id: string } }>('turn/start', {
    threadId, model: 'gpt-6-luna', effort: 'low',
    text: 'This is a controlled integration test. Do not use MCP, skills, web, subagents or inspect anything outside cwd. Read only fixture.txt in cwd using a shell command. Then request approval for the harmless command `printf ORACULUM_APPROVAL_OK` with sandbox_permissions=require_escalated and justification="Verify Oraculum approval plumbing". If rejected, do not retry. Reply exactly ORACULUM_TURN_OK at the end.',
  });
  evidence.turnId = result.turn.id;
  let answered = false;
  await until(() => {
    const approval = rawEvents.find(e => e.type === 'approval');
    if (approval && !answered) {
      answered = true;
      evidence.approval = { method: approval.request.method, requestId: approval.request.id, itemId: approval.request.params.itemId, decision: 'decline' };
      // Declining cannot grant host privileges; exercising a real server request.
      void rpc('bridge/approve', { threadId, requestId: approval.request.id, bridgeToken: approval.request.bridgeToken, decision: 'decline' }).catch(error => { evidence.approvalError = error.message; });
    }
    return rawEvents.some(e => e.event?.method === 'turn/completed');
  }, 'native turn completion');
  const completion = rawEvents.find(e => e.event?.method === 'turn/completed')!;
  evidence.status = completion.event!.params.turn.status;
  evidence.eventMethods = rawEvents.filter(e => e.event).map(e => e.event!.method);
  evidence.items = rawEvents.filter(e => e.event?.method === 'item/completed').map(e => ({ id: e.event!.params.item.id, type: e.event!.params.item.type, status: e.event!.params.item.status, exitCode: e.event!.params.item.exitCode }));
  assert.equal(evidence.status, 'completed');
  assert(rawEvents.some(e => e.event?.method === 'item/agentMessage/delta'));
  assert(rawEvents.some(e => e.event?.method === 'item/completed' && e.event.params.item.type === 'commandExecution' && e.event.params.item.exitCode === 0));
  socket.close();
  await new Promise(resolve => socket.once('close', resolve));
  await connect();
  const restored = await rpc<Snapshot>('bridge/subscribe', { threadId });
  assert(restored.thread.turns.some(turn => turn.id === result.turn.id && turn.status === 'completed'));
  evidence.reconnect = { threadId: restored.thread.id, turns: restored.thread.turns.length, historyMode: restored.thread.historyMode, pending: restored.pending.length, model: restored.thread.model, effort: restored.thread.reasoningEffort };
  evidence.approvalVerified = answered;
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.failure = error instanceof Error ? error.message : String(error);
  console.error(evidence.failure);
  process.exitCode = 1;
} finally {
  socket!?.close();
  await mkdir('.local/evidence', { recursive: true });
  await writeFile('.local/evidence/live-smoke.json', JSON.stringify(evidence, null, 2) + '\n');
}
