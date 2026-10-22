// Installed-binary protocol check using an explicitly synthetic, local MCP.
// No model call, account credentials, global config or external tool operation.
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Codex } from '../bridge/src/codex';
import { BridgeService } from '../bridge/src/service';
import type { Approval, BridgeEvent, Snapshot } from '../packages/shared/protocol';
import type { ThreadStartResponse } from '../.local/codex-protocol/v2/ThreadStartResponse';
import type { McpServerToolCallResponse } from '../.local/codex-protocol/v2/McpServerToolCallResponse';

const previous = process.env.CODEX_HOME;
const fixture = await mkdtemp(join(tmpdir(), 'oraculum-native-elicitation-'));
const serverPath = join(fixture, 'elicitation.mjs');
let codex: Codex | undefined;
try {
  process.env.CODEX_HOME = fixture;
  await writeFile(serverPath, `import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
let pending;
createInterface({input:process.stdin}).on('line', line => {
  const request=JSON.parse(line); let result={};
  if(request.method==='initialize') result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'oraculum-test-fixture',version:'1'}};
  else if(request.method==='tools/list') result={tools:[{name:'ask',description:'Synthetic protocol test; no side effects',inputSchema:{type:'object',properties:{kind:{type:'string'}}},annotations:{readOnlyHint:true}}]};
  else if(request.method==='tools/call') {
    pending=request.id;
    const kind=request.params.arguments.kind;
    const params=kind==='url'
      ? {mode:'url',message:'Synthetic URL confirmation',url:'https://example.invalid/oraculum-test',elicitationId:'fixture-url'}
      : kind==='app' ? {mode:'form',message:'Synthetic one-shot tool consent',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'mcp_tool_call'}}
      : {mode:'form',message:'Synthetic structured input',requestedSchema:{type:'object',properties:{choice:{type:'string',enum:['read','stop']}},required:['choice']}};
    send({id:'fixture-request',method:'elicitation/create',params}); return;
  } else if(request.id==='fixture-request' && !request.method) { send({id:pending,result:{content:[{type:'text',text:JSON.stringify(request.result ?? request.error)}]}}); return; }
  else if(request.method==='resources/list') result={resources:[]};
  else if(request.method==='resources/templates/list') result={resourceTemplates:[]};
  else if(request.id===undefined) return;
  send({id:request.id,result});
});
`, { mode: 0o600 });
  await writeFile(join(fixture, 'config.toml'), `sandbox_mode = "read-only"
approval_policy = "on-request"
[mcp_servers.protocol_fixture]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(serverPath)}]
`, { mode: 0o600 });
  codex = new Codex(fixture);
  const service = new BridgeService(codex, fixture);
  await codex.initialize();
  const { thread } = await service.dispatch('thread/start', {}) as ThreadStartResponse;
  const inventory = await codex.request<any>('mcpServerStatus/list', { threadId: thread.id, serverName: 'protocol_fixture' });
  assert.equal(inventory.data[0]?.name, 'protocol_fixture');
  const results: object[] = [];
  for (const [kind, action] of [['form', 'accept'], ['form', 'decline'], ['url', 'cancel'], ['url', 'accept'], ['app', 'accept']] as const) {
    let timer: NodeJS.Timeout;
    let onEvent: (event: BridgeEvent) => void;
    const prompt = new Promise<Approval>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`No native ${kind} elicitation received`)), 15_000);
      onEvent = event => { if (event.type === 'approval') { clearTimeout(timer); resolve(event.request); } };
      service.on('event', onEvent);
    }).finally(() => { clearTimeout(timer); service.off('event', onEvent); });
    const call = codex.request<McpServerToolCallResponse>('mcpServer/tool/call', { threadId: thread.id, server: 'protocol_fixture', tool: 'ask', arguments: { kind } });
    // A rejection is observed even if no prompt arrives, so no unhandled promise remains.
    void call.catch(() => {});
    const request = await prompt;
    assert.equal(request.method, 'mcpServer/elicitation/request');
    assert.equal(request.params.threadId, thread.id);
    const snapshot = await service.dispatch('bridge/subscribe', { threadId: thread.id }) as Snapshot;
    assert.equal(snapshot.pending[0]?.bridgeToken, request.bridgeToken);
    if (kind === 'form' && action === 'accept') await assert.rejects(service.dispatch('bridge/approve', {
      threadId: thread.id, requestId: request.id, bridgeToken: request.bridgeToken,
      result: { action: 'accept', content: { choice: 'write' } },
    }), /schema/);
    const content = kind === 'form' && action === 'accept' ? { choice: 'read' } : kind === 'app' ? {} : null;
    await service.dispatch('bridge/approve', { threadId: thread.id, requestId: request.id,
      bridgeToken: request.bridgeToken, result: { action, content } });
    const response = await call;
    const text = response.content.find(item => item && typeof item === 'object' && !Array.isArray(item) && item.type === 'text') as { text: string };
    const returned = JSON.parse(text.text);
    assert.equal(returned.action, action);
    if (content) assert.deepEqual(returned.content, content);
    assert.equal(service.pending.size, 0);
    await assert.rejects(service.dispatch('bridge/approve', { threadId: thread.id, requestId: request.id,
      bridgeToken: request.bridgeToken, result: { action: 'accept', content } }), /no longer/);
    results.push({ kind, action, nativeMode: (request.params as { mode?: string }).mode, turnId: request.params.turnId, pendingRestored: true, nativeRoundTrip: true, duplicateRejected: true });
  }
  console.log(JSON.stringify({ codex: '0.160.0', experimentalApi: false, syntheticMcp: true, modelCalls: 0, results }, null, 2));
} finally {
  await codex?.close();
  if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  await rm(fixture, { recursive: true, force: true });
}
