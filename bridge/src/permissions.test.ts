import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEvent, NativeSessionSettings, PermissionMode, Snapshot, Thread, Turn } from '../../packages/shared/protocol';
import type { ThreadResumeResponse } from '../../.local/codex-protocol/v2/ThreadResumeResponse';
import { BridgeService } from './service';
import { NativeRpcError } from './codex';
import { ReceiptStore } from './receipts';
import { createServer } from './server';
import { TrustStore } from './trust-store';

const cwd = '/controlled-workspace';
const threadId = 'permission-thread';
const context = { deviceId: 'desktop-device' };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });

const inherited: NativeSessionSettings = {
  approvalPolicy: 'untrusted', sandbox: { type: 'readOnly', networkAccess: true }, approvalsReviewer: 'guardian_subagent',
};
const fullAccess: NativeSessionSettings = {
  approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' }, approvalsReviewer: 'guardian_subagent',
};
const readOnly: NativeSessionSettings = {
  approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'guardian_subagent',
};

function storage() {
  const directory = mkdtempSync(join(tmpdir(), 'oraculum-permissions-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const trust = new TrustStore(directory);
  cleanups.push(() => trust.close());
  return { trust, receipts: new ReceiptStore(trust.db) };
}

function fixture(receipts?: ReceiptStore) {
  const thread: Thread = {
    id: threadId, sessionId: threadId, forkedFromId: null, parentThreadId: null,
    preview: '', ephemeral: false, section: null, sectionEnteredAt: null, projectId: null,
    historyMode: 'paginated', modelProvider: 'openai', model: 'native-model', reasoningEffort: null,
    createdAt: 0, updatedAt: 0, recencyAt: null, status: { type: 'idle' }, path: null, cwd,
    cliVersion: 'test', originator: null, source: 'appServer', threadSource: null,
    agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [],
  };
  const turn: Turn = {
    id: 'native-turn', status: 'inProgress', items: [], itemsView: 'full', error: null,
    startedAt: null, completedAt: null, durationMs: null,
  };
  let effective = inherited;
  const settingsReply = (): ThreadResumeResponse => ({
    thread, model: 'native-model', modelProvider: 'openai', serviceTier: null,
    disabledPluginIds: [], cwd, instructionSources: [], ...effective, reasoningEffort: null,
    collaborationMode: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null,
  });
  const start = vi.fn(async (): Promise<unknown> => ({ turn }));
  const resume = vi.fn(async (): Promise<unknown> => settingsReply());
  const codex = Object.assign(new EventEmitter(), {
    request: vi.fn(async (method: string, _params: object): Promise<unknown> => {
      if (method === 'thread/start') return settingsReply();
      if (method === 'thread/read') return { thread };
      if (method === 'thread/resume') return resume();
      if (method === 'turn/start') return start();
      if (method === 'thread/turns/list') return { data: [], nextCursor: null };
      throw new Error(`Unexpected native method: ${method}`);
    }),
    send: vi.fn(),
  });
  const service = new BridgeService({
    on: codex.on.bind(codex), send: codex.send,
    request: async <T>(method: string, params: object): Promise<T> => await codex.request(method, params) as T,
  }, cwd, receipts);
  const events: BridgeEvent[] = [];
  service.on('event', event => events.push(event));
  const send = (permissionMode?: unknown, operationId = randomUUID()) => service.dispatch('turn/start', {
    threadId, text: 'permission test', operationId, ...(permissionMode === undefined ? {} : { permissionMode }),
  }, context);
  const snapshot = () => service.dispatch('bridge/subscribe', { threadId }) as Promise<Snapshot>;
  const loadExisting = async () => { service.threads.add(threadId); return snapshot(); };
  const complete = () => codex.emit('message', {
    method: 'turn/completed', params: { threadId, turn: { ...turn, status: 'completed' } },
  });
  return { service, codex, events, start, resume, thread, turn, settingsReply, send, snapshot, loadExisting, complete,
    setSettings: (settings: NativeSessionSettings) => { effective = settings; } };
}

describe('native permission presets at the Bridge boundary', () => {
  it.each([undefined, 'inherit'])('omits permission overrides for %s and ignores renderer policy/config injection', async permissionMode => {
    const f = fixture();
    const injected = {
      permissionMode, approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' }, config: { sandbox_mode: 'danger-full-access' },
    };
    await f.service.dispatch('thread/start', { ...injected, cwd: '/private', model: 'selected-model' });
    expect(f.codex.request).toHaveBeenCalledExactlyOnceWith('thread/start', { cwd, model: 'selected-model' });
    expect((await f.snapshot()).settings).toEqual(inherited);
    f.codex.request.mockClear();
    await f.service.dispatch('turn/start', { ...injected, threadId, text: 'hello', model: 'selected-model', effort: 'high' });
    expect(f.codex.request.mock.calls).toEqual([
      ['turn/start', { threadId, input: [{ type: 'text', text: 'hello', text_elements: [] }], model: 'selected-model', effort: 'high' }],
      ['thread/resume', { threadId, excludeTurns: true }],
    ]);
    await vi.waitFor(() => expect(f.events.at(-1)).toEqual({ type: 'settingsChanged', threadId, settings: inherited }));
  });

  const presets: { mode: PermissionMode; start: object; turn: object }[] = [
    { mode: 'read-only', start: { approvalPolicy: 'on-request', sandbox: 'read-only' },
      turn: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } } },
    { mode: 'auto', start: { approvalPolicy: 'on-request', sandbox: 'workspace-write', config: { sandbox_workspace_write: {
      writable_roots: [], network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false,
    } } }, turn: { approvalPolicy: 'on-request', sandboxPolicy: {
      type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    } } },
    { mode: 'full-access', start: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
      turn: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } },
  ];
  it.each(presets)('forwards the official $mode preset for new and existing threads without changing the reviewer', async preset => {
    const f = fixture();
    await f.service.dispatch('thread/start', { permissionMode: preset.mode, approvalsReviewer: 'user' });
    expect(f.codex.request).toHaveBeenCalledExactlyOnceWith('thread/start', { cwd, ...preset.start });
    f.codex.request.mockClear();
    await f.send(preset.mode);
    expect(f.codex.request.mock.calls).toEqual([
      ['turn/start', { threadId, input: [{ type: 'text', text: 'permission test', text_elements: [] }], ...preset.turn }],
      ['thread/resume', { threadId, excludeTurns: true }],
    ]);
    // The native reply is authoritative, even if a native requirement keeps
    // a different approval/sandbox policy than the explicitly requested preset.
    await vi.waitFor(() => expect(f.events.at(-1)).toEqual({ type: 'settingsChanged', threadId, settings: inherited }));
  });

  it.each([null, '', 'Full Access', 'danger-full-access', true, { sandbox: 'danger-full-access' }])('rejects invalid permission mode %j before a native request or receipt reservation', async mode => {
    const { receipts } = storage();
    const f = fixture(receipts);
    await expect(f.service.dispatch('thread/start', { permissionMode: mode })).rejects.toThrow('permission mode');
    expect(f.codex.request).not.toHaveBeenCalled();
    await f.loadExisting();
    f.codex.request.mockClear();
    await expect(f.send(mode)).rejects.toThrow('permission mode');
    expect(f.codex.request).not.toHaveBeenCalled();
    expect(receipts.list(cwd, threadId)).toEqual([]);
  });

  it('inherits current sticky native settings after switching and refreshes them on reconnect', async () => {
    const f = fixture();
    await f.loadExisting();
    f.setSettings(fullAccess);
    await f.send('full-access');
    await vi.waitFor(() => expect(f.events.at(-1)).toEqual({ type: 'settingsChanged', threadId, settings: fullAccess }));
    f.complete();
    f.codex.request.mockClear();
    await f.send('inherit');
    expect(f.codex.request.mock.calls[0]).toEqual(['turn/start', {
      threadId, input: [{ type: 'text', text: 'permission test', text_elements: [] }],
    }]);
    await vi.waitFor(() => expect(f.events.at(-1)).toEqual({ type: 'settingsChanged', threadId, settings: fullAccess }));
    f.complete();
    // Simulate another native client changing the loaded thread between visits.
    f.setSettings(readOnly);
    f.codex.request.mockClear();
    expect((await f.snapshot()).settings).toEqual(readOnly);
    expect(f.codex.request.mock.calls[0]).toEqual(['thread/resume', { threadId, excludeTurns: true }]);
    expect(f.events.at(-1)).toEqual({ type: 'settingsChanged', threadId, settings: readOnly });
    const restarted = fixture();
    restarted.setSettings(readOnly);
    expect((await restarted.loadExisting()).settings).toEqual(readOnly);
    expect(restarted.codex.request).toHaveBeenCalledWith('thread/resume', { threadId, cwd, excludeTurns: true });
  });

  it('uses native full resume only for the confirmed legacy list_turns capability error', async () => {
    const f = fixture();
    const legacyError = new NativeRpcError('list_turns is not supported for JSONL threads', -32601);
    f.resume.mockRejectedValueOnce(legacyError);
    expect((await f.loadExisting()).settings).toEqual(inherited);
    expect(f.codex.request.mock.calls.filter(([method]) => method === 'thread/resume')).toEqual([
      ['thread/resume', { threadId, cwd, excludeTurns: true }],
      ['thread/resume', { threadId, cwd }],
    ]);
    f.codex.request.mockClear();
    f.setSettings(readOnly);
    f.resume.mockRejectedValueOnce(legacyError);
    await f.send('read-only');
    await vi.waitFor(() => expect(f.events.at(-1)).toEqual({ type: 'settingsChanged', threadId, settings: readOnly }));
    expect(f.codex.request.mock.calls.filter(([method]) => method === 'thread/resume')).toEqual([
      ['thread/resume', { threadId, excludeTurns: true }],
      ['thread/resume', { threadId }],
    ]);
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Error('list_turns is not supported for JSONL threads'),
    new NativeRpcError('list_turns is not supported for JSONL threads', -32602),
    new NativeRpcError('thread/resume is not supported', -32601),
  ])('does not retry native resume for a different error: %s', async error => {
    const f = fixture();
    f.resume.mockRejectedValueOnce(error);
    await expect(f.loadExisting()).rejects.toBe(error);
    expect(f.resume).toHaveBeenCalledTimes(1);
    expect(f.codex.request.mock.calls.filter(([method]) => method === 'thread/resume')).toEqual([
      ['thread/resume', { threadId, cwd, excludeTurns: true }],
    ]);
  });
});

describe('permission verification keeps native send and approval safety', () => {
  it('returns the accepted turn ACK while settings readback remains pending and permissions stay unknown', async () => {
    const { receipts } = storage();
    const f = fixture(receipts);
    await f.loadExisting();
    let release!: (value: unknown) => void;
    f.resume.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    let ack: unknown;
    const pending = f.send('full-access').then(result => { ack = result; });
    try {
      await vi.waitFor(() => expect(ack).toEqual({ turn: f.turn }));
      expect(f.resume).toHaveBeenCalledTimes(2);
      expect(receipts.list(cwd, threadId)[0]).toMatchObject({ status: 'accepted', turnId: f.turn.id });
      expect(f.events.at(-1)).toEqual({ type: 'settingsChanged', threadId, settings: undefined });
    } finally { release({ ...f.settingsReply(), ...readOnly }); }
    await pending;
    await vi.waitFor(() => expect(f.events.at(-1)).toEqual({ type: 'settingsChanged', threadId, settings: readOnly }));
  });

  it('does not republish an older query after a new mode is pending but before its turn ACK', async () => {
    const f = fixture();
    await f.loadExisting();
    let releaseQuery!: (value: unknown) => void;
    f.resume.mockImplementationOnce(() => new Promise(resolve => { releaseQuery = resolve; }));
    const olderSnapshot = f.snapshot();
    await vi.waitFor(() => expect(f.resume).toHaveBeenCalledTimes(2));
    let releaseTurn!: (value: unknown) => void;
    f.start.mockImplementationOnce(() => new Promise(resolve => { releaseTurn = resolve; }));
    const pendingTurn = f.send('full-access');
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
    releaseQuery(f.settingsReply());
    expect((await olderSnapshot).settings).toBeUndefined();
    expect(f.events.at(-1)).toEqual({ type: 'settingsChanged', threadId, settings: undefined });
    f.setSettings(fullAccess);
    releaseTurn({ turn: f.turn });
    await pendingTurn;
    await vi.waitFor(() => expect(f.events.at(-1)).toEqual({ type: 'settingsChanged', threadId, settings: fullAccess }));
  });

  it('does not clear newly confirmed permissions when an older query fails later', async () => {
    const f = fixture();
    await f.loadExisting();
    let rejectQuery!: (reason: Error) => void;
    f.resume.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectQuery = reject; }));
    const olderSnapshot = f.snapshot();
    await vi.waitFor(() => expect(f.resume).toHaveBeenCalledTimes(2));
    f.setSettings(fullAccess);
    await f.send('full-access');
    await vi.waitFor(() => expect(f.events.at(-1)).toEqual({ type: 'settingsChanged', threadId, settings: fullAccess }));
    const events = [...f.events];
    rejectQuery(new Error('late settings timeout'));
    expect((await olderSnapshot).settings).toEqual(fullAccess);
    expect(f.events).toEqual(events);
  });

  it.each([new Error('settings read timeout'), new NativeRpcError('read rejected', -32602)])('preserves the accepted receipt when settings readback fails: %s', async error => {
    const { receipts } = storage();
    const f = fixture(receipts);
    await f.loadExisting();
    f.resume.mockRejectedValueOnce(error);
    const operationId = randomUUID();
    await expect(f.send('full-access', operationId)).resolves.toEqual({ turn: f.turn });
    expect(receipts.list(cwd, threadId)).toEqual([expect.objectContaining({ operationId, status: 'accepted', turnId: f.turn.id })]);
    expect(f.events).toContainEqual({ type: 'settingsChanged', threadId, settings: undefined });
    await vi.waitFor(() => expect(f.events.at(-1)).toMatchObject({ type: 'notice', threadId, message: expect.stringContaining('不要重复发送') }));
    await expect(f.send('read-only')).rejects.toThrow('unknown');
    expect(f.start).toHaveBeenCalledTimes(1);
    f.setSettings(readOnly);
    expect((await f.snapshot()).settings).toEqual(readOnly);
    expect(f.start).toHaveBeenCalledTimes(1);
    f.complete();
    await expect(f.send('inherit', operationId)).rejects.toThrow('already recorded');
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it.each([{ cwd: '/private' }, { id: 'another-thread' }])('rejects mismatched thread settings %j without misclassifying an accepted send', async mismatch => {
    const { receipts } = storage();
    const f = fixture(receipts);
    await f.loadExisting();
    f.resume.mockResolvedValueOnce({ ...f.settingsReply(), ...fullAccess, thread: { ...f.thread, ...mismatch } });
    await expect(f.send('full-access')).resolves.toEqual({ turn: f.turn });
    expect(receipts.list(cwd, threadId)[0].status).toBe('accepted');
    await vi.waitFor(() => expect(f.events.at(-1)).toMatchObject({ type: 'notice', threadId }));
    expect(f.events).not.toContainEqual({ type: 'settingsChanged', threadId, settings: fullAccess });
    expect(f.events.at(-2)).toEqual({ type: 'settingsChanged', threadId, settings: undefined });
  });

  it('keeps an ambiguous native turn timeout unknown and blocks replay even after settings are readable', async () => {
    const { receipts } = storage();
    const f = fixture(receipts);
    await f.loadExisting();
    f.start.mockRejectedValueOnce(new Error('turn ACK timeout'));
    const operationId = randomUUID();
    await expect(f.send('full-access', operationId)).rejects.toThrow('turn ACK timeout');
    expect(receipts.list(cwd, threadId)[0]).toMatchObject({ operationId, status: 'unknown', turnId: null });
    f.setSettings(fullAccess);
    const state = await f.snapshot();
    expect(state.settings).toEqual(fullAccess);
    expect(state.sendBlocked).toBe(true);
    await expect(f.send('read-only')).rejects.toThrow('unknown');
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it('allows only a new operation after explicit native rejection and reads back the next accepted mode', async () => {
    const { receipts } = storage();
    const f = fixture(receipts);
    await f.loadExisting();
    f.start.mockRejectedValueOnce(new NativeRpcError('permission requirements disallow this mode', -32602));
    const operationId = randomUUID();
    await expect(f.send('full-access', operationId)).rejects.toThrow('permission requirements');
    expect(receipts.list(cwd, threadId)[0]).toMatchObject({ operationId, status: 'rejected' });
    await expect(f.send('read-only', operationId)).rejects.toThrow('already recorded');
    f.setSettings(readOnly);
    await f.send('read-only');
    expect(f.start).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(f.events.at(-1)).toEqual({ type: 'settingsChanged', threadId, settings: readOnly }));
  });

  it('keeps native approval tokens and one-shot responses when a permission override is active', async () => {
    const f = fixture();
    await f.loadExisting();
    await f.send('auto');
    f.codex.emit('message', { id: 'approval', method: 'item/commandExecution/requestApproval',
      params: { threadId, turnId: f.turn.id, itemId: 'command' } });
    const bridgeToken = f.service.pending.get('approval')!.bridgeToken;
    await expect(f.service.dispatch('bridge/approve', { threadId, requestId: 'approval', bridgeToken: 'stale', decision: 'accept' })).rejects.toThrow('expired');
    await f.service.dispatch('bridge/approve', { threadId, requestId: 'approval', bridgeToken, decision: 'decline' });
    expect(f.codex.send).toHaveBeenCalledExactlyOnceWith({ id: 'approval', result: { decision: 'decline' } });
    await expect(f.service.dispatch('bridge/approve', { threadId, requestId: 'approval', bridgeToken, decision: 'accept' })).rejects.toThrow('no longer');
    await expect(f.service.dispatch('turn/start', { threadId: 'private-thread', text: 'no', permissionMode: 'full-access' })).rejects.toThrow('outside');
    expect(f.start).toHaveBeenCalledTimes(1);
  });
});

function socketMessage(socket: WebSocket, matches: (message: Record<string, unknown>) => boolean) {
  return new Promise<Record<string, unknown>>(resolve => {
    const listener = (bytes: WebSocket.RawData) => {
      const message = JSON.parse(String(bytes)) as Record<string, unknown>;
      if (matches(message)) { socket.off('message', listener); resolve(message); }
    };
    socket.on('message', listener);
  });
}

it('broadcasts authoritative effective settings to both trusted devices after one device changes mode', async () => {
  const { trust, receipts } = storage();
  const f = fixture(receipts);
  await f.loadExisting();
  const app = await createServer(f.service, 17869, '/missing-static-root', { trust });
  cleanups.push(() => app.close());
  await app.ready();
  const headers = { host: '127.0.0.1:17869', origin: 'http://127.0.0.1:17869' };
  const sockets: WebSocket[] = [];
  try {
    for (const name of ['desktop', 'phone']) {
      const session = trust.pair(trust.createPairing().code, name, headers.origin);
      sockets.push(await app.injectWS('/ws', { headers: { ...headers, cookie: `oraculum_local=${session.token}` } }));
    }
    f.setSettings(readOnly);
    const updates = sockets.map(socket => socketMessage(socket, message => message.type === 'settingsChanged' && !!message.settings));
    const response = socketMessage(sockets[0], message => message.id === 'change-permissions');
    sockets[0].send(JSON.stringify({ id: 'change-permissions', method: 'turn/start', params: {
      threadId, text: 'once', permissionMode: 'read-only', operationId: randomUUID(),
    } }));
    expect(await response).toMatchObject({ result: { turn: { id: f.turn.id } } });
    expect(await Promise.all(updates)).toEqual([
      { type: 'settingsChanged', threadId, settings: readOnly },
      { type: 'settingsChanged', threadId, settings: readOnly },
    ]);
    expect(f.start).toHaveBeenCalledTimes(1);
  } finally { for (const socket of sockets) socket.terminate(); }
});
