#!/usr/bin/env node
// A deterministic stdio peer for transport faults. It never runs a model or touches Codex state.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const mode = process.env.ORACULUM_TEST_NATIVE_MODE;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const turn = { id: 'turn-1', status: 'inProgress', items: [], itemsView: 'full' };
const thread = { id: 'thread-1', cwd: process.cwd(), preview: '', turns: [], parentThreadId: null, status: { type: 'idle' } };
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (process.env.ORACULUM_TEST_TRANSCRIPT) appendFileSync(process.env.ORACULUM_TEST_TRANSCRIPT, line + '\n');
  if (!message.method || message.id === undefined) return;
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'codex-test/0.0.0' } });
    if (mode === 'unknown-request') send({ id: 'native-1', method: 'unknown/execute', params: { threadId: 'thread-1' } });
    return;
  }
  if (mode === 'timeout') return;
  if (mode === 'crash') process.exit(42);
  if (mode === 'huge') { process.stdout.write('x'.repeat(5000)); return; }
  if (mode === 'malformed') { process.stdout.write('{bad json}\n'); return; }
  if (mode === 'bad-response') { send({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } }); return; }
  const errors = {
    unsupported: [-32601, 'Method not found'], experimental: [-32602, 'This method requires experimentalApi capability'],
    pagination: [-32600, 'This thread does not support pagination'], paginationFeature: [-32601,'paginated_threads is not supported yet'], itemPaginationFeature: [-32601,'thread/items/list is not supported yet'], invalidCursor: [-32602, 'Invalid pagination cursor'],
    provider: [-32000, 'Provider authorization failed: secret-value'], rejection: [-32602, 'Invalid input'],
  };
  if (errors[mode]) { const [code, messageText] = errors[mode]; send({ id: message.id, error: { code, message: messageText } }); return; }
  if(mode==='unknown-notification'&&message.method==='model/list')send({method:'thread/futureCriticalState',params:{threadId:'thread-1',privateNativePayload:'must-not-forward'}});
  let result;
  switch (message.method) {
    case 'model/list': result = { data: [{ id: 'model-1', model: 'model-1', displayName: 'Model', supportedReasoningEfforts: [{ reasoningEffort: mode === 'future-effort' ? 'future-effort' : 'low' }] }], nextCursor: null }; break;
    case 'thread/list': result = { data: [thread], nextCursor: null }; break;
    case 'thread/start': case 'thread/resume': case 'thread/fork': result = { thread, approvalPolicy: 'on-request', sandbox: { type: 'readOnly' }, approvalsReviewer: 'user' }; break;
    case 'thread/read': case 'thread/unarchive': case 'thread/revert': result = { thread }; break;
    case 'turn/start': result = { turn }; break;
    case 'turn/steer': result = { turnId: 'turn-1' }; break;
    case 'turn/interrupt': result = {}; break;
    case 'thread/turns/list': case 'thread/items/list': result = { data: [], nextCursor: null }; break;
    case 'config/read': result = { config: { model: 'model-1', model_reasoning_effort: 'low', approval_policy: 'on-request', sandbox_mode: 'read-only' }, origins: {} }; break;
    case 'account/rateLimits/read': result = { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1000 }, secondary: null, credits: null, planType: 'plus' } }; break;
    case 'account/usage/read': result = { summary: { lifetimeTokens: 1234 }, dailyUsageBuckets: [{ startDate: '2026-11-14', tokens: 123 }], threadUsage: null }; break;
    case 'mcpServerStatus/list': result = { data: [{ name: 'server', authStatus: 'oAuth', runtimeStatus: 'connected', tools: {}, resources: [], resourceTemplates: [] }], nextCursor: null }; break;
    case 'skills/list': result = { data: [{ cwd: process.cwd(), skills: [], errors: [] }] }; break;
    case 'app/installed': result = { apps: [] }; break;
    default: result = {};
  }
  if (mode === 'delayed-reads' && ['thread/list', 'thread/read'].includes(message.method)) {
    setTimeout(() => send({ id: message.id, result }), 200);
  } else send({ id: message.id, result });
}).on('close', () => process.exit(0));
