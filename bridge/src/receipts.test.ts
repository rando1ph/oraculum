import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrustStore } from './trust-store';
import { ReceiptStore } from './receipts';
import { BridgeService } from './service';
import { NativeRpcError } from './codex';
import { createServer } from './server';
import type { Snapshot, Turn } from '../../packages/shared/protocol';
import type WebSocket from 'ws';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanups.reverse()) await f(); cleanups.length = 0; });
const cwd = '/controlled-workspace';
const threadId = 'test-thread';
const context = { deviceId: 'test-device' };
function storage() {
  const dir = mkdtempSync(join(tmpdir(), 'oraculum-receipts-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const trust = new TrustStore(dir);
  cleanups.push(() => trust.close());
  return { trust, dir, receipts: new ReceiptStore(trust.db) };
}
function fixture(receipts: ReceiptStore) {
  const turns: Turn[] = [];
  const thread = { id: threadId, cwd, status: { type: 'idle' }, turns: [] };
  const start = vi.fn(async (): Promise<unknown> => ({ turn: { id: 'native-turn', status: 'inProgress' } }));
  const codex = Object.assign(new EventEmitter(), {
    request: vi.fn(async (method: string): Promise<any> => {
      if (method === 'turn/start') return start();
      if (method === 'thread/start' || method === 'thread/read') return { thread };
      if (method === 'thread/turns/list') return { data: turns, nextCursor: null };
      if (method === 'thread/items/list') return { data: [], nextCursor: null };
      return {};
    }), send: vi.fn(),
  });
  const service = new BridgeService(codex, cwd, receipts);
  service.threads.add(threadId);
  const load = () => service.dispatch('bridge/subscribe', { threadId }) as Promise<Snapshot>;
  const send = (operationId = randomUUID()) => service.dispatch('turn/start', {
    threadId, operationId, text: 'SECRET_PROMPT_MUST_NOT_ENTER_RECEIPTS',
  }, context);
  return { codex, service, start, turns, load, send };
}

it('reserves durably before forwarding, leaves timeout unknown across restart and stores no prompt', async () => {
  const { receipts, trust, dir } = storage();
  const first = fixture(receipts);
  await first.load();
  first.start.mockImplementation(async () => {
    expect(receipts.list(cwd, threadId)[0].status).toBe('unknown');
    throw new Error('ACK lost');
  });
  await expect(first.send()).rejects.toThrow('ACK lost');
  const secondTrust = new TrustStore(dir);
  try {
    const second = fixture(new ReceiptStore(secondTrust.db));
    const snapshot = await second.load();
    expect(snapshot.sendBlocked).toBe(true);
    expect(snapshot.receipts?.[0].status).toBe('unknown');
    second.codex.emit('message', { method: 'turn/completed', params: { threadId, turn: { id: 'unrelated', status: 'completed' } } });
    await expect(second.send()).rejects.toThrow('unknown');
    expect(second.start).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, 'trust.sqlite')).includes(Buffer.from('SECRET_PROMPT_MUST_NOT_ENTER_RECEIPTS'))).toBe(false);
    expect(trust.db.prepare('SELECT count(*) AS n FROM send_receipts').get()).toEqual({ n: 1 });
  } finally { secondTrust.close(); }
});

it.each(['completed', 'failed', 'interrupted'] as const)('resolves only a matching native %s after restart and rejects replay forever', async status => {
  const { receipts } = storage();
  const first = fixture(receipts);
  await first.load();
  const operationId = randomUUID();
  await first.send(operationId);
  const second = fixture(receipts);
  expect((await second.load()).sendBlocked).toBe(true);
  second.turns.push({ id: 'native-turn', status, items: [] } as unknown as Turn);
  const snapshot = await second.load();
  expect(snapshot.sendBlocked).toBe(false);
  expect(snapshot.receipts?.[0]).toMatchObject({ status, turnId: 'native-turn', operationId });
  await expect(second.send(operationId)).rejects.toThrow('already recorded');
  expect(second.start).not.toHaveBeenCalled();
  await second.send();
  expect(second.start).toHaveBeenCalledTimes(1);
});

it('records an explicit native rejection and permits a new manual operation, never the same ID', async () => {
  const { receipts } = storage();
  const f = fixture(receipts);
  await f.load();
  f.start.mockRejectedValueOnce(new NativeRpcError('unsupported model', -32602));
  const id = randomUUID();
  await expect(f.send(id)).rejects.toThrow('unsupported model');
  expect(receipts.list(cwd, threadId)[0].status).toBe('rejected');
  await expect(f.send(id)).rejects.toThrow('already recorded');
  await f.send();
  expect(f.start).toHaveBeenCalledTimes(2);
});

it('fails before side effects if the journal is unavailable or device context is absent', async () => {
  const { receipts } = storage();
  const f = fixture(receipts);
  await f.load();
  await expect(f.service.dispatch('turn/start', { threadId, text: 'hello', operationId: randomUUID() })).rejects.toThrow('device context');
  vi.spyOn(receipts, 'reserve').mockImplementationOnce(() => { throw new Error('disk full'); });
  await expect(f.send()).rejects.toThrow('disk full');
  expect(f.start).not.toHaveBeenCalled();
});

it('serializes reservations across database connections and scopes blocking to the workspace', () => {
  const { receipts, dir } = storage();
  const other = new TrustStore(dir);
  try {
    const second = new ReceiptStore(other.db);
    receipts.reserve(randomUUID(), cwd, threadId, 'phone');
    expect(() => second.reserve(randomUUID(), cwd, threadId, 'desktop')).toThrow('unknown');
    expect(() => second.reserve(randomUUID(), '/another-workspace', threadId, 'desktop')).not.toThrow();
    expect(receipts.list(cwd, threadId)).toHaveLength(1);
  } finally { other.close(); }
});

function reply(socket: WebSocket, id: string) {
  return new Promise<any>(resolve => {
    const listener = (bytes: WebSocket.RawData) => {
      const message = JSON.parse(String(bytes));
      if (message.id === id) { socket.off('message', listener); resolve(message); }
    };
    socket.on('message', listener);
  });
}
it('arbitrates two authenticated sockets: one send, one approval response; stale approval tokens fail after native loss', async () => {
  const { receipts, trust } = storage();
  const f = fixture(receipts);
  await f.load();
  const app = await createServer(f.service, 17864, '/missing', { trust });
  cleanups.push(() => app.close());
  await app.ready();
  const headers = { host: '127.0.0.1:17864', origin: 'http://127.0.0.1:17864' };
  const sockets: WebSocket[] = [];
  for (const label of ['phone', 'desktop']) {
    const session = trust.pair(trust.createPairing().code, label, headers.origin);
    sockets.push(await app.injectWS('/ws', { headers: { ...headers, cookie: `oraculum_local=${session.token}` } }));
  }
  try {
    const requests = sockets.map((socket, index) => {
      const id = `send-${index}`;
      const response = reply(socket, id);
      socket.send(JSON.stringify({ id, method: 'turn/start', params: { threadId, text: 'once', operationId: randomUUID() } }));
      return response;
    });
    const results = await Promise.all(requests);
    expect(results.filter(r => r.result)).toHaveLength(1);
    expect(results.filter(r => r.error)).toHaveLength(1);
    expect(f.start).toHaveBeenCalledTimes(1);
    const approval = { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'native-turn', itemId: 'test-command' } };
    f.codex.emit('message', approval);
    const bridgeToken = f.service.pending.get(7)!.bridgeToken;
    const decisions = sockets.map((socket, index) => {
      const id = `approve-${index}`;
      const response = reply(socket, id);
      socket.send(JSON.stringify({ id, method: 'bridge/approve', params: { threadId, requestId: 7, bridgeToken, decision: index ? 'accept' : 'decline' } }));
      return response;
    });
    const approvals = await Promise.all(decisions);
    expect(approvals.filter(r => r.result)).toHaveLength(1);
    expect(approvals.filter(r => r.error)).toHaveLength(1);
    expect(f.codex.send).toHaveBeenCalledTimes(1);
    f.codex.emit('unavailable', 'native exited');
    f.codex.emit('message', approval); // reused numeric native ID, new bridge token
    await expect(f.service.dispatch('bridge/approve', { threadId, requestId: 7, bridgeToken, decision: 'accept' })).rejects.toThrow('expired');
    expect(f.codex.send).toHaveBeenCalledTimes(1);
  } finally { for (const socket of sockets) socket.terminate(); }
});
