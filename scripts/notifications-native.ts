// One bounded official Codex turn, inherited configuration, isolated directory.
// No tools or approval grant; verifies terminal native fact -> redacted feed.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';
import { Codex } from '../bridge/src/codex';
import { BridgeService } from '../bridge/src/service';
import { TrustStore } from '../bridge/src/trust-store';
import { ReceiptStore } from '../bridge/src/receipts';
import { ProjectDirectories } from '../bridge/src/projects';
import type { BridgeEvent } from '../packages/shared/protocol';

await mkdir('.local/evidence/r1-b7', { recursive: true });
const output = await mkdtemp(resolve('.local/evidence/r1-b7/native-'));
const root = join(homedir(), '.cache/oraculum/workspaces'); await mkdir(root, { recursive: true });
const cwd = await mkdtemp(join(root, 'b7-notifications-'));
const config = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
const hash = async () => createHash('sha256').update(await readFile(config)).digest('hex');
const before = await hash();
const trust = new TrustStore(join(output, 'state')), projects = new ProjectDirectories(root, cwd, trust.db); await projects.register(cwd);
const paired = trust.pair(trust.createPairing().code, 'B7 native acceptance', 'http://127.0.0.1:17907');
const context = { deviceId: paired.device.id, isAuthorized: () => !!trust.authenticate(paired.token, 'http://127.0.0.1:17907') };
const codex = new Codex(cwd), service = new BridgeService(codex, cwd, new ReceiptStore(trust.db), projects);
let terminal: { id: string; status: string } | undefined, requests = 0;
service.on('event', (event: BridgeEvent) => {
  if (event.type === 'approval') {
    requests++;
    // Unexpected execution requests are declined, never granted or simulated.
    if (event.request.method !== 'item/tool/requestUserInput') void service.dispatch('bridge/approve', {
      threadId: event.request.params.threadId, requestId: event.request.id, bridgeToken: event.request.bridgeToken, decision: 'decline',
    }, context).catch(() => {});
  }
  if (event.type === 'event' && event.event.method === 'turn/completed') terminal = { id: event.event.params.turn.id, status: event.event.params.turn.status };
});
let failure: string | undefined;
try {
  await codex.initialize();
  const started = await service.dispatch('thread/start', { cwd }) as { thread: { id: string } };
  await service.dispatch('turn/start', { threadId: started.thread.id, operationId: randomUUID(), text: '这是一次通知链路验收。不要调用任何工具、Skills、MCP、Apps 或子代理，不要读取文件。只回复 B7_NATIVE_NOTIFICATION_OK。' }, context);
  await expect.poll(() => terminal?.status, { timeout: 120000 }).toBe('completed');
  const feed = await service.notificationFeed();
  expect(feed.notices).toEqual([expect.objectContaining({ kind: 'completed', threadId: started.thread.id })]);
  expect(JSON.stringify(feed)).not.toContain('B7_NATIVE_NOTIFICATION_OK');
  expect(requests).toBe(0); expect(await hash()).toBe(before);
} catch (error) { failure = String(error); process.exitCode = 1; }
finally {
  await codex.close(); trust.close();
  await writeFile(join(output, 'acceptance.json'), JSON.stringify({ result: failure ? 'failed' : 'passed', failure,
    codexVersion: codex.version, terminal, unexpectedRequests: requests, configUnchanged: await hash() === before,
    scope: 'One official Codex turn with inherited model/effort; no tools; redacted completed feed; no OS screenshot claim' }, null, 2));
  console.log(JSON.stringify({ output, result: failure ? 'failed' : 'passed', failure, terminal }));
}
