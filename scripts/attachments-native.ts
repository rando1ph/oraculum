// Opt-in native protocol + sandbox read probe. No production HOME, credentials,
// model inference, installed app, device, network service or research project.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { Codex, NativeRpcError } from '../bridge/src/codex';
import { BridgeService } from '../bridge/src/service';
import { ReceiptStore } from '../bridge/src/receipts';
import { ProjectDirectories } from '../bridge/src/projects';
import { AttachmentStore, inboxName } from '../bridge/src/attachments';
import { attachmentPng } from './fixtures/attachments';
import type { ThreadStartResponse } from '../.local/codex-protocol/v2/ThreadStartResponse';
import type { TurnStartResponse } from '../.local/codex-protocol/v2/TurnStartResponse';
import type { Snapshot } from '../packages/shared/protocol';

const output = await mkdtemp(join(tmpdir(), 'oraculum-b5a-native-'));
const isolatedHome = join(output, 'codex-home'), projectsRoot = join(output, 'Projects'), cwd = join(projectsRoot, 'synthetic');
await mkdir(isolatedHome); await mkdir(cwd, { recursive: true });
await writeFile(join(isolatedHome, 'config.toml'), `model_provider = "attachment_probe"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
[model_providers.attachment_probe]
name = "Offline attachment protocol probe"
base_url = "http://127.0.0.1:1/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
`, { mode: 0o600 });
const previous = process.env.CODEX_HOME;
process.env.CODEX_HOME = isolatedHome;
const db = new DatabaseSync(':memory:');
const projects = new ProjectDirectories(projectsRoot, cwd, db); await projects.register(cwd);
let codex: Codex | undefined;
const checks: string[] = [];
try {
  codex = new Codex(cwd); await codex.initialize();
  const service = new BridgeService(codex, cwd, new ReceiptStore(db), projects, undefined, new AttachmentStore(db));
  const started = await service.dispatch('thread/start', { cwd }) as ThreadStartResponse;
  const scope = { cwd, threadId: started.thread.id, draftId: randomUUID() }, context = { deviceId: 'isolated-probe', isAuthorized: () => true };
  const image = await service.uploadAttachment({ ...scope, name: 'synthetic.png', mime: 'image/png', size: attachmentPng.length }, Readable.from([attachmentPng]), context);
  const data = Buffer.from('ORACULUM_SANDBOX_ATTACHMENT_READ');
  const document = await service.uploadAttachment({ ...scope, name: '合成文档.txt', mime: 'text/plain', size: data.length }, Readable.from([data]), context);
  // Native CLI sandbox, same cwd as the native thread; no model or tool loop.
  const path = join(cwd, inboxName, document.id, 'input.txt');
  const sandboxRead = execFileSync('codex', ['sandbox', '-P', ':workspace', '-C', cwd, '--', 'cat', path], { cwd, encoding: 'utf8', timeout: 30000 });
  assert.equal(sandboxRead, data.toString()); checks.push('actual native workspace-write sandbox reads generated project inbox file');
  const result = await service.dispatch('turn/start', { ...scope, text: 'Isolated offline attachment protocol probe.', attachmentIds: [image.id, document.id], operationId: randomUUID() }, context) as TurnStartResponse;
  checks.push('installed native App Server accepts localImage plus generated document path in one real thread');
  // The offline provider fails without inference. Interrupt the known turn if needed.
  if (result.turn.status === 'inProgress') try { await codex.request('turn/interrupt', { threadId: started.thread.id, turnId: result.turn.id }); }
  catch (error) { if (!(error instanceof NativeRpcError) || error.code !== -32600 || !error.message.includes('no active turn')) throw error; }
  const snapshot = await service.dispatch('bridge/subscribe', { threadId: started.thread.id }) as Snapshot;
  assert.equal(snapshot.thread.cwd, cwd);
  assert(snapshot.attachments?.some(delivery => delivery.files.some(file => file.id === document.id)));
  assert.equal(await readFile(path, 'utf8'), data.toString());
  checks.push('real native history/metadata retains owned attachment delivery without a second send');
  console.log(JSON.stringify({ output, version: codex.version, native: true, inference: false, androidDevice: false, checks }));
} finally {
  await codex?.close(); db.close();
  if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  await mkdir(resolve('.local/evidence/r1-b5a'), { recursive: true });
  await writeFile(resolve('.local/evidence/r1-b5a/native.json'), JSON.stringify({ output, native: true, inference: false, checks }, null, 2));
}
