import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fixtures from '../../../../packages/gateway-protocol/fixtures/valid.json';
import type { Attachment, Capabilities, Interaction } from '../../../../packages/gateway-protocol/src/index';
import type { Snapshot, WorkspaceState } from '../contracts/workspace';
import type { GatewayTransport, TransportIdentity } from './gateway-transport';
import { JOURNAL_FILE, OperationJournal, type JournalScope } from './journal';
import { DesktopWorkspace } from './workspace';

const installationId = '11111111-1111-4111-8111-111111111111';
const epoch = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const otherProject = '44444444-4444-4444-8444-444444444444';
const deviceId = '55555555-5555-4555-8555-555555555555';
const otherDevice = '66666666-6666-4666-8666-666666666666';
const interactionId = '77777777-7777-4777-8777-777777777777';
const endpoint = 'http://127.0.0.1:41234/fixture/';
const threadId = 'fixture-thread';
const temporary: string[] = [];
const workspaces: DesktopWorkspace[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.dispose();
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const fixtureValue = <T>(name: string): T => structuredClone(fixtures.find(item => item.contract === name)!.value) as T;
type Call = { method: string; path: string; body?: Record<string, unknown>; identity: TransportIdentity | null };
const gatewayError = (code: string) => Object.assign(new Error(code), { code });
function pendingApproval(currentEpoch = epoch): Interaction {
  return { interactionId, projectId, threadId, turnId: 'turn-1', epoch: currentEpoch, generation: 1, kind: 'command', status: 'pending',
    request: { threadId, turnId: 'turn-1', itemId: 'command-1', command: 'pwd', cwd: '/private/fixture/project', availableDecisions: ['accept', 'decline'] } };
}
function fixture(existingDirectory?: string) {
  const directory = existingDirectory ?? mkdtempSync(join(tmpdir(), 'oraculum-workspace-fixture-'));
  if (!existingDirectory) temporary.push(directory);
  const journal = new OperationJournal(directory);
  const calls: Call[] = [];
  const published: WorkspaceState[] = [];
  const events: { message(value: unknown): void; closed(): void; active: boolean; resume: unknown }[] = [];
  let connected = false, currentEpoch = epoch, currentDevice = deviceId, currentInstallation = installationId;
  let currentEndpoint = endpoint;
  let override: ((call: Call) => unknown | Promise<unknown> | undefined) | undefined;
  let beforeGuard: ((call: Omit<Call, 'identity'>) => void | Promise<void>) | undefined;
  let snapshotPatch: ((snapshot: Snapshot) => Snapshot) | undefined;
  const uploaded = new Map<string, Attachment>();
  let sequence = 0;
  const currentIdentity = (): TransportIdentity => ({ endpoint: currentEndpoint, installationId: currentInstallation, deviceId: currentDevice });
  const envelope = (data: unknown) => ({ requestId: 'fixture-request', installationId: currentInstallation, epoch: currentEpoch, data });
  const operation = (id: string, status: 'accepted' | 'rejected' | 'unknown' = 'accepted') => ({ requestId: 'fixture-request', installationId: currentInstallation,
    epoch: currentEpoch, operation: { operationId: id, status, delivery: status === 'rejected' ? 'notSent' : 'sent' } });
  const snapshot = (selectedThread = threadId): Snapshot => {
    const base: Snapshot = { epoch: currentEpoch, thread: { id: selectedThread, projectId, status: 'idle' },
      history: { epoch: currentEpoch, historyRevision: 'revision-1', source: 'native-pagination', items: [], nextCursor: null, complete: true, truncated: false },
      operations: [], interactions: [], observedStartSeq: sequence, observedEndSeq: sequence, synchronization: 'current' };
    return snapshotPatch ? snapshotPatch(base) : base;
  };
  const transport = {
    get identity() { return connected ? currentIdentity() : null; },
    async connect(input: string) {
      connected = true; currentEndpoint = input;
      const capabilities = fixtureValue<Capabilities>('Capabilities');
      capabilities.installationId = currentInstallation; capabilities.epoch = currentEpoch;
      capabilities.capabilities = ['projects', 'thread.start', 'thread.resume', 'thread.name.set', 'thread.archive', 'thread.unarchive', 'thread.fork', 'thread.delete', 'turn.start', 'turn.interrupt', 'turn.steer', 'interactions', 'files', 'attachments'].map(name => ({
        name, supported: true, availability: 'available', maturity: 'gateway', verified: true, reasonCode: null, observedVersion: null, epoch: currentEpoch,
      }));
      capabilities.limits = { requestBytes: 128 * 1024, historyPageItems: 20, attachmentFileBytes: 20 * 1024 * 1024,
        attachmentBatchBytes: 40 * 1024 * 1024, attachmentBatchCount: 6, eventReplayCount: 1000 };
      return { endpoint: currentEndpoint, installationId: currentInstallation, deviceId: currentDevice, epoch: currentEpoch, paired: true, capabilities, session: null };
    },
    disconnect() { connected = false; },
    async openEvents(resume: unknown, message: (value: unknown) => void, closed: () => void) {
      const listener = { message, closed, active: true, resume }; events.push(listener);
      message({ type: 'connection', installationId: currentInstallation, epoch: currentEpoch, headSeq: sequence, resetRequired: sequence > 0 });
      return () => { listener.active = false; };
    },
    async request(method: string, path: string, body?: Record<string, unknown>, beforeDispatch?: () => void) {
      if (beforeDispatch && beforeGuard) await beforeGuard({ method, path, body });
      beforeDispatch?.();
      const call = { method, path, body, identity: connected ? currentIdentity() : null }; calls.push(call);
      const custom = override?.(call); if (custom !== undefined) return await custom;
      if (!connected) throw gatewayError('CONNECTION_NOT_READY');
      if (path === '/projects') return envelope({ projects: [{ id: projectId, name: 'Fixture Project', rootId: 'fixture-root', canonicalPath: '/private/fixture/project', available: true }], roots: [{ id: 'fixture-root', label: 'Fixture Root' }] });
      if (path === '/models') return envelope({ data: [], nextCursor: null });
      if (path.includes('/native-defaults')) return envelope(fixtureValue('NativeDefaults'));
      if (/\/projects\/[^/]+\/threads\?/.test(path)) return envelope({ threads: new URLSearchParams(path.split('?')[1]).get('archived') === 'true' ? []
        : [{ id: threadId, projectId, status: 'idle' }, { id: 'other-thread', projectId, status: 'idle' }], nextCursor: null, source: 'native-pagination', truncated: false });
      if (/\/projects\/[^/]+\/threads\/[^/]+$/.test(path)) return envelope({ id: path.split('/').at(-1), projectId, status: 'idle' });
      if (path.endsWith('/snapshot')) return envelope(snapshot(path.split('/')[2]));
      if (path.startsWith('/operations/')) {
        const operationId = path.split('/')[2], attachment = uploaded.get(operationId);
        if (attachment) return envelope({ operationId, status: 'accepted', delivery: 'sent', attachment });
        throw gatewayError('OPERATION_NOT_FOUND');
      }
      if (body?.operationId) return operation(body.operationId as string);
      throw new Error('Unexpected fixture request ' + path);
    },
    async requestBytes(method: string, path: string, options: { body?: Buffer; headers?: Record<string, string>; beforeDispatch?: () => void } = {}) {
      const metadata = JSON.parse(Buffer.from(options.headers!['X-Oraculum-Upload'], 'base64url').toString('utf8'));
      const result = await transport.request(method, path, metadata, options.beforeDispatch);
      if (path.endsWith('/attachments')) {
        uploaded.set(metadata.operationId, { id: '88888888-8888-4888-8888-888888888888', projectId: metadata.projectId, threadId: metadata.threadId,
          draftId: metadata.draftId, name: metadata.name, mime: metadata.mime, size: metadata.size,
          digest: createHash('sha256').update(options.body!).digest('hex'), state: 'ready', kind: 'document', expiresAt: Date.now() + 600_000, operationId: null });
      }
      return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify(result)) };
    },
  };
  const dialogs = { chooseUpload: vi.fn<() => Promise<string | undefined>>(async () => undefined), chooseDownload: vi.fn<() => Promise<string | undefined>>(async () => undefined) };
  const workspace = new DesktopWorkspace(transport as unknown as GatewayTransport, journal, dialogs, state => published.push(state), true);
  workspaces.push(workspace);
  return { directory, journal, workspace, transport, calls, published, events, dialogs, envelope, operation, snapshot, uploaded,
    identity: currentIdentity, scope: (): JournalScope => ({ ...currentIdentity(), epoch: currentEpoch, projectId, threadId }),
    override(fn: typeof override) { override = fn; }, patchSnapshot(fn: typeof snapshotPatch) { snapshotPatch = fn; },
    beforeGuard(fn: typeof beforeGuard) { beforeGuard = fn; },
    device(value: string) { currentDevice = value; }, epoch(value: string) { currentEpoch = value; },
    emit(kind: string, payload: unknown, eventScope: object = { projectId, threadId }, patch: object = {}) {
      events.at(-1)!.message({ installationId: currentInstallation, epoch: currentEpoch, seq: ++sequence, kind, impact: 'state', scope: eventScope, payload, ...patch });
    },
    writes: () => calls.filter(call => call.body?.operationId),
    async upload(text = 'private fixture attachment text') {
      const localFile = join(directory, 'fixture-upload.txt');
      writeFileSync(localFile, text, { mode: 0o600 }); dialogs.chooseUpload.mockResolvedValueOnce(localFile);
      return await workspace.action({ type: 'upload' });
    },
    async connect(select = true) {
      await workspace.action({ type: 'connect', endpoint });
      expect(workspace.state().connection.status).toBe('connected');
      if (select) {
        await workspace.action({ type: 'selectProject', projectId });
        await workspace.action({ type: 'selectThread', threadId });
        expect(workspace.state()).toMatchObject({ projectId, threadId, synchronization: 'current' });
      }
    },
  };
}

describe('Desktop controller reliable writes with offline fixtures', () => {
  it('durably prepares the main-only journal before dispatch and exposes accepted as delivery, not completed execution', async () => {
    const f = fixture(); await f.connect();
    f.override(call => {
      if (!call.body?.operationId) return;
      const disk = JSON.parse(readFileSync(join(f.directory, JOURNAL_FILE), 'utf8'));
      expect(disk.entries.find((entry: { operationId: string }) => entry.operationId === call.body!.operationId).state).toBe('prepared');
      expect(JSON.stringify(disk)).not.toContain('a private message');
      return f.operation(call.body.operationId as string);
    });
    const state = await f.workspace.action({ type: 'send', text: 'a private message' });
    expect(f.writes()).toHaveLength(1);
    expect(state.operations[0].status).toBe('accepted');
    expect(state.notice).toBe('GATEWAY_ACCEPTED');
    expect(state.operations.some(entry => String(entry.status) === 'completed')).toBe(false);
  });

  it('lost ACK, 404, refresh, reconnect and process restart never resend or replace the original ID', async () => {
    const f = fixture(); await f.connect();
    f.override(call => { if (call.body?.operationId) throw gatewayError('CONNECTION_FAILED'); });
    await f.workspace.action({ type: 'send', text: 'send once' });
    const operationId = f.writes()[0].body!.operationId;
    expect(f.journal.pending(f.identity())[0]).toMatchObject({ operationId, state: 'unknown' });
    await f.workspace.action({ type: 'refresh' });
    await f.workspace.action({ type: 'reconnect' });
    await f.workspace.action({ type: 'send', text: 'explicit retry still blocked' });
    expect(f.writes()).toHaveLength(1);
    expect(f.calls.filter(call => call.path.startsWith('/operations/')).every(call => call.path.endsWith(String(operationId)))).toBe(true);
    f.workspace.dispose();
    const restarted = fixture(f.directory); await restarted.connect();
    await restarted.workspace.action({ type: 'send', text: 'blocked after crash' });
    expect(restarted.writes()).toHaveLength(0);
    expect(restarted.journal.pending(restarted.identity())[0].operationId).toBe(operationId);
  });

  it('a journal prepare failure dispatches nothing and remains a readable failed-closed workspace', async () => {
    const f = fixture(); await f.connect();
    const original = f.journal.prepare.bind(f.journal);
    vi.spyOn(f.journal, 'prepare').mockImplementationOnce((scope, kind, intent) => {
      chmodSync(f.directory, 0o755);
      return original(scope, kind, intent);
    });
    try {
      const state = await f.workspace.action({ type: 'send', text: 'must not reach Gateway' });
      expect(f.writes()).toHaveLength(0);
      expect(state.notice ?? state.connection.errorCode).toMatch(/JOURNAL/);
      expect(f.workspace.state().busy).toBe(false);
    } finally { chmodSync(f.directory, 0o700); }
  });

  it('keeps pending identity A separate from identity B and does not query A receipts using B', async () => {
    const f = fixture(); await f.connect();
    const ownerA = f.identity(), entryA = f.journal.prepare(f.scope(), 'turn.start', { text: 'pending A' });
    f.device(otherDevice);
    const callsBefore = f.calls.length;
    await f.workspace.action({ type: 'connect', endpoint });
    await f.workspace.action({ type: 'selectProject', projectId });
    await f.workspace.action({ type: 'selectThread', threadId });
    expect(f.calls.slice(callsBefore).some(call => call.path.includes(entryA.operationId))).toBe(false);
    await f.workspace.action({ type: 'send', text: 'explicit B action' });
    expect(f.writes()).toHaveLength(1);
    expect(f.writes()[0].identity!.deviceId).toBe(otherDevice);
    expect(f.journal.pending(ownerA)[0].operationId).toBe(entryA.operationId);
    expect(f.workspace.state().operations.some(row => row.operationId === entryA.operationId)).toBe(false);
  });

  it('rejects a late ACK after connection generation disposal and never queries through a disconnected identity', async () => {
    const f = fixture(); await f.connect(); const identity = f.identity();
    let resolve!: (value: unknown) => void;
    f.override(call => call.body?.operationId ? new Promise(done => { resolve = done; }) : undefined);
    const pending = f.workspace.action({ type: 'send', text: 'one pending write' });
    await Promise.resolve();
    const operationId = f.writes()[0].body!.operationId as string;
    f.workspace.dispose();
    resolve(f.operation(operationId));
    await pending;
    expect(f.journal.pending(identity)[0]).toMatchObject({ operationId, state: 'unknown' });
    expect(f.writes()).toHaveLength(1);
    expect(f.calls.filter(call => call.path.startsWith('/operations/') && !call.identity)).toEqual([]);
  });

  it('uses current response epoch to reconcile an original-epoch row without another write', async () => {
    const f = fixture(); await f.connect();
    const entry = f.journal.prepare(f.scope(), 'turn.start', { text: 'old epoch' });
    f.epoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    f.override(call => call.path.startsWith('/operations/') ? f.envelope({ operationId: entry.operationId, status: 'accepted', delivery: 'sent' }) : undefined);
    await f.workspace.action({ type: 'reconnect' });
    expect(f.journal.list(f.identity())[0]).toMatchObject({ operationId: entry.operationId, epoch, state: 'accepted' });
    expect(f.writes()).toEqual([]);
  });

  it('does not settle the wrong operation ID returned in an ACK', async () => {
    const f = fixture(); await f.connect();
    f.override(call => call.body?.operationId ? f.operation('88888888-8888-4888-8888-888888888888') : undefined);
    await f.workspace.action({ type: 'send', text: 'one write' });
    expect(f.journal.pending(f.identity())).toHaveLength(1);
    expect(f.journal.pending(f.identity())[0].state).toBe('unknown');
    expect(f.writes()).toHaveLength(1);
  });

  it('rejects mismatched scope receipt events and ignores another device operation ID', async () => {
    const f = fixture(); await f.connect();
    const entry = f.journal.prepare(f.scope(), 'turn.start', { text: 'pending' });
    const receipt = { operationId: entry.operationId, status: 'accepted' };
    f.emit('operation.changed', receipt, { projectId: otherProject, threadId });
    expect(f.journal.pending(f.identity())[0].operationId).toBe(entry.operationId);
    f.emit('operation.changed', { operationId: '88888888-8888-4888-8888-888888888888', status: 'accepted' });
    expect(f.journal.pending(f.identity())[0].operationId).toBe(entry.operationId);
    f.emit('operation.changed', receipt);
    expect(f.journal.pending(f.identity())).toEqual([]);
    expect(f.writes()).toEqual([]);
  });

  it('invalid or cross-thread snapshot receipts cannot settle pending journal entries', async () => {
    const f = fixture(); await f.connect();
    const own = f.journal.prepare(f.scope(), 'turn.start', { text: 'current thread' });
    const other = f.journal.prepare({ ...f.scope(), threadId: 'other-thread' }, 'turn.start', { text: 'other thread' });
    f.patchSnapshot(snapshot => ({ ...snapshot, thread: { ...snapshot.thread, id: 'wrong-thread' }, operations: [{ operationId: own.operationId, status: 'accepted' }] }));
    await f.workspace.action({ type: 'refresh' });
    expect(f.journal.pending(f.identity()).map(row => row.operationId)).toContain(own.operationId);
    f.patchSnapshot(snapshot => ({ ...snapshot, operations: [{ operationId: other.operationId, status: 'accepted' }] }));
    await f.workspace.action({ type: 'refresh' });
    expect(f.journal.pending(f.identity()).map(row => row.operationId)).toContain(other.operationId);
  });

  it('a terminal receipt observed before lost ACK cannot be demoted by query 404', async () => {
    const f = fixture(); await f.connect();
    f.override(call => {
      if (!call.body?.operationId) return;
      f.emit('operation.changed', { operationId: call.body.operationId, status: 'accepted' });
      throw gatewayError('CONNECTION_FAILED');
    });
    await f.workspace.action({ type: 'send', text: 'ACK lost but event accepted' });
    expect(f.journal.pending(f.identity())).toEqual([]);
    expect(f.journal.list(f.identity())[0].state).toBe('accepted');
    expect(f.writes()).toHaveLength(1);
  });
});

describe('Desktop controller action and synchronization boundaries', () => {
  it('keeps the device event sequence across selecting another thread', async () => {
    const f = fixture(); await f.connect();
    f.emit('fixture.information', {}, {}, { impact: 'informational' });
    await f.workspace.action({ type: 'selectThread', threadId: 'other-thread' });
    f.emit('fixture.information', {}, {}, { impact: 'informational' });
    expect(f.workspace.state()).toMatchObject({ connection: { status: 'connected' }, threadId: 'other-thread', synchronization: 'current' });
    expect(f.events).toHaveLength(1);
  });

  it('ignores retired event listeners after a reconnect and endpoint generation change', async () => {
    const f = fixture(); await f.connect();
    const retired = f.events[0];
    await f.workspace.action({ type: 'reconnect' });
    const before = f.workspace.state();
    retired.message({ installationId, epoch, seq: 100, kind: 'native.state', impact: 'state', scope: { projectId, threadId }, payload: { method: 'turn/started', data: { threadId, turn: { id: 'stale-turn', status: 'inProgress' } }, truncated: false } });
    retired.closed();
    expect(f.workspace.state()).toEqual(before);
  });

  it('rejects stale approval generations without making a write', async () => {
    const f = fixture(); f.patchSnapshot(snapshot => ({ ...snapshot, interactions: [pendingApproval()] })); await f.connect();
    const state = await f.workspace.action({ type: 'answer', interactionId, generation: 2, epoch, response: { type: 'approval', decision: 'accept' } });
    expect(state.notice).toBe('INTERACTION_STALE');
    expect(f.writes()).toEqual([]);
  });

  it('offline send, approval, interrupt, steer and upload are all inert, including native file dialog', async () => {
    const f = fixture(); f.patchSnapshot(snapshot => ({ ...snapshot, interactions: [pendingApproval()] })); await f.connect();
    await f.workspace.action({ type: 'disconnect' });
    const count = f.calls.length;
    for (const action of [{ type: 'send', text: 'offline text' }, { type: 'interrupt' }, { type: 'steer', text: 'offline instruction' }, { type: 'upload' },
      { type: 'answer', interactionId, generation: 1, epoch, response: { type: 'approval', decision: 'accept' } }]) {
      const state = await f.workspace.action(action);
      expect(state.notice).toBe('CONNECTION_NOT_READY');
    }
    expect(f.calls).toHaveLength(count);
    expect(f.dialogs.chooseUpload).not.toHaveBeenCalled();
    expect(f.writes()).toEqual([]);
  });
});

describe('Desktop attachment recovery from durable operation metadata', () => {
  it('keeps attachments held after lost turn ACK, stale ready receipts, and process restart', async () => {
    const f = fixture(); await f.connect();
    expect((await f.upload()).attachments[0].state).toBe('ready');
    const upload = f.journal.list(f.identity()).find(row => row.kind === 'attachment.upload')!;
    const attachment = structuredClone(f.uploaded.get(upload.operationId)!);
    f.override(call => { if (call.path.endsWith('/turns') && call.body?.operationId) throw gatewayError('CONNECTION_FAILED'); });
    const sent = await f.workspace.action({ type: 'send', text: 'send attachment once' });
    expect(sent.attachments[0]).toMatchObject({ id: attachment.id, state: 'held' });
    const claim = f.journal.pending(f.identity()).find(row => row.kind === 'turn.start')!;
    expect(claim.attachmentIds).toEqual([attachment.id]);
    expect(claim.draftId).toBe(attachment.draftId);
    expect((await f.workspace.action({ type: 'refresh' })).attachments[0].state).toBe('held');
    f.workspace.dispose();
    const restored = fixture(f.directory); restored.uploaded.set(upload.operationId, attachment); await restored.connect();
    expect(restored.workspace.state().attachments[0]).toMatchObject({ id: attachment.id, state: 'held' });
    await restored.workspace.action({ type: 'send', text: 'blocked recovered attachment' });
    expect(restored.writes()).toEqual([]);
    expect(restored.journal.pending(restored.identity())[0].operationId).toBe(claim.operationId);
  });

  it('accepted turn claims prevent stale upload-ready responses from making the attachment reusable', async () => {
    const f = fixture(); await f.connect(); await f.upload();
    const attachmentId = f.workspace.state().attachments[0].id;
    await f.workspace.action({ type: 'send', text: 'accepted attachment turn' });
    const refreshed = await f.workspace.action({ type: 'refresh' });
    expect(refreshed.attachments.find(item => item.id === attachmentId)?.state).not.toBe('ready');
    const before = f.writes().length;
    await f.workspace.action({ type: 'send', text: 'must not reuse accepted attachment' });
    expect(f.writes()).toHaveLength(before);
  });

  it('lost upload ACK plus receipt 404 retains safe metadata and its original ID across restart', async () => {
    const f = fixture(); await f.connect();
    f.override(call => { if (call.path.endsWith('/attachments')) throw gatewayError('CONNECTION_FAILED'); });
    await f.upload('private content survives only in the explicit source file');
    const pending = f.journal.pending(f.identity())[0];
    expect(pending).toMatchObject({ kind: 'attachment.upload', state: 'unknown', attachment: { name: 'fixture-upload.txt', mime: 'text/plain' } });
    expect(readFileSync(join(f.directory, JOURNAL_FILE), 'utf8')).not.toContain('private content survives');
    expect(readFileSync(join(f.directory, JOURNAL_FILE), 'utf8')).not.toContain(f.directory);
    f.workspace.dispose();
    const restored = fixture(f.directory); await restored.connect();
    expect(restored.journal.pending(restored.identity())[0]).toMatchObject({ operationId: pending.operationId, attachment: pending.attachment, state: 'unknown' });
    expect(restored.workspace.state().attachments).toEqual([]);
    expect(restored.writes()).toEqual([]);
    expect(restored.calls.filter(call => call.path.startsWith('/operations/')).every(call => call.path.endsWith(pending.operationId))).toBe(true);
  });

  it.each([{ digest: '0'.repeat(64) }, { draftId: otherDevice }, { projectId: otherProject }, { name: 'substituted.txt' }, { size: 999 }])('rejects upload receipt metadata mismatch %j', async patch => {
    const f = fixture(); await f.connect();
    f.override(call => {
      if (!call.path.startsWith('/operations/')) return;
      const operationId = call.path.split('/')[2], original = f.uploaded.get(operationId);
      return original ? f.envelope({ operationId, status: 'accepted', delivery: 'sent', attachment: { ...original, ...patch } }) : undefined;
    });
    const state = await f.upload();
    expect(state.notice).toBe('ATTACHMENT_INTEGRITY_FAILED');
    expect(state.attachments).toEqual([]);
    expect(f.journal.list(f.identity())[0].attachment!.digest).not.toBe('0'.repeat(64));
  });

  it('a pre-dispatch rejection restores only the original server-ready attachment state', async () => {
    const f = fixture(); await f.connect(); await f.upload();
    f.beforeGuard(call => {
      if (call.path.endsWith('/turns')) f.emit('native.state', { method: 'turn/started', data: { threadId, turn: { id: 'concurrent-turn', status: 'inProgress' } }, truncated: false }, { projectId, threadId, turnId: 'concurrent-turn' });
    });
    const result = await f.workspace.action({ type: 'send', text: 'raced another active turn' });
    expect(f.writes().filter(call => call.path.endsWith('/turns'))).toEqual([]);
    expect(result.attachments[0].state).toBe('ready');
    expect(f.journal.list(f.identity()).find(row => row.kind === 'turn.start')).toMatchObject({ state: 'rejected', receipt: { delivery: 'notSent' } });
  });

  it.each(['rejected', 'unknown'] as const)('an upload receipt with status %s cannot expose a ready attachment', async status => {
    const f = fixture(); await f.connect();
    f.override(call => { if (call.path.endsWith('/attachments')) throw gatewayError('CONNECTION_FAILED'); });
    await f.upload();
    const upload = f.journal.pending(f.identity())[0];
    const attachment = { id: '88888888-8888-4888-8888-888888888888', projectId, threadId, ...upload.attachment!, state: 'ready', kind: 'document', expiresAt: Date.now() + 600_000, operationId: null };
    f.override(call => call.path === `/operations/${upload.operationId}`
      ? f.envelope({ operationId: upload.operationId, status, delivery: status === 'rejected' ? 'notSent' : 'unknown', attachment }) : undefined);
    const state = await f.workspace.action({ type: 'refresh' });
    expect(state.attachments.some(item => item.id === attachment.id && item.state === 'ready')).toBe(false);
    const before = f.writes().length;
    await f.workspace.action({ type: 'send', text: 'unaccepted upload must remain unusable' });
    // A rejected upload can allow an independent text-only operation, but it must not send this attachment.
    expect(f.writes().slice(before).some(call => (call.body?.attachmentIds as string[] | undefined)?.includes(attachment.id))).toBe(false);
  });

  it('an accepted remove receipt recovered after lost ACK removes the attachment without replaying DELETE', async () => {
    const f = fixture(); await f.connect(); await f.upload();
    const attachment = f.workspace.state().attachments[0];
    let removeId = '';
    f.override(call => {
      if (call.method === 'DELETE' && call.path === `/attachments/${attachment.id}`) {
        removeId = call.body!.operationId as string;
        for (const [id, saved] of f.uploaded) if (saved.id === attachment.id) f.uploaded.set(id, { ...saved, state: 'expired' });
        throw gatewayError('CONNECTION_FAILED');
      }
      if (removeId && call.path === `/operations/${removeId}`) return f.envelope({ operationId: removeId, status: 'accepted', delivery: 'sent' });
    });
    const removed = await f.workspace.action({ type: 'removeAttachment', attachmentId: attachment.id });
    expect(removed.attachments).toEqual([]);
    expect(removed.operations.find(row => row.operationId === removeId)?.status).toBe('accepted');
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
    await f.workspace.action({ type: 'send', text: 'text after successful recovered removal' });
    expect(f.writes().at(-1)!.body).not.toHaveProperty('attachmentIds');
  });
});

describe('Desktop final dispatch and first-turn guards', () => {
  it('blocks dispatch if the durable journal fails during the authentication wait', async () => {
    const f = fixture(); await f.connect();
    f.beforeGuard(() => { chmodSync(f.directory, 0o755); });
    try {
      const state = await f.workspace.action({ type: 'send', text: 'journal changed after preparation' });
      expect(f.writes()).toEqual([]);
      expect(state.notice).toMatch(/JOURNAL/);
      expect(JSON.parse(readFileSync(join(f.directory, JOURNAL_FILE), 'utf8')).entries[0].state).toBe('prepared');
    } finally { chmodSync(f.directory, 0o700); }
  });

  it('checks identity immediately before dispatch and records notSent on a changed identity', async () => {
    const f = fixture(); await f.connect(); const originalIdentity = f.identity();
    f.beforeGuard(() => { f.device(otherDevice); });
    await f.workspace.action({ type: 'send', text: 'identity must remain bound' });
    expect(f.writes()).toEqual([]);
    expect(f.journal.list(originalIdentity)[0]).toMatchObject({ state: 'rejected', receipt: { delivery: 'notSent', errorCode: 'SCOPE_CHANGED' } });
  });

  it('checks current approval again after the authentication wait', async () => {
    const f = fixture(); f.patchSnapshot(snapshot => ({ ...snapshot, interactions: [pendingApproval()] })); await f.connect();
    f.beforeGuard(() => { f.emit('interaction.resolved', { ...pendingApproval(), status: 'resolved' }, { projectId, threadId, turnId: 'turn-1' }); });
    await f.workspace.action({ type: 'answer', interactionId, epoch, generation: 1, response: { type: 'approval', decision: 'accept' } });
    expect(f.writes()).toEqual([]);
    expect(f.journal.list(f.identity())[0]).toMatchObject({ state: 'rejected', receipt: { delivery: 'notSent', errorCode: 'INTERACTION_STALE' } });
  });

  it('applies the dispatch guard to binary uploads after native selection', async () => {
    const f = fixture(); await f.connect(); const owner = f.identity();
    f.beforeGuard(() => { f.events.at(-1)!.closed(); });
    await f.upload();
    expect(f.dialogs.chooseUpload).toHaveBeenCalledTimes(1);
    expect(f.writes()).toEqual([]);
    expect(f.journal.list(owner)[0]).toMatchObject({ kind: 'attachment.upload', state: 'rejected', receipt: { delivery: 'notSent' } });
  });

  it('allows exactly one explicit first turn for a freshly confirmed empty new thread', async () => {
    const f = fixture(); await f.connect();
    f.override(call => {
      if (call.path === `/projects/${projectId}/threads` && call.body?.operationId) return { ...f.operation(call.body.operationId as string), operation: { ...f.operation(call.body.operationId as string).operation, nativeThreadId: 'new-thread' } };
      if (call.path === '/threads/new-thread/snapshot') throw gatewayError('NATIVE_HISTORY_NOT_MATERIALIZED');
    });
    const created = await f.workspace.action({ type: 'startThread' });
    expect(created).toMatchObject({ threadId: 'new-thread', firstTurnReady: true, synchronization: 'stale' });
    await f.workspace.action({ type: 'send', text: 'first explicit turn' });
    expect(f.writes().filter(call => call.path === '/threads/new-thread/turns')).toHaveLength(1);
    expect(f.workspace.state().firstTurnReady).toBe(false);
    await f.workspace.action({ type: 'send', text: 'second requires current snapshot' });
    expect(f.writes().filter(call => call.path === '/threads/new-thread/turns')).toHaveLength(1);
  });

  it('malformed stream data revokes the new-thread first-turn exception', async () => {
    const f = fixture(); await f.connect();
    f.override(call => {
      if (call.path === `/projects/${projectId}/threads` && call.body?.operationId) return { ...f.operation(call.body.operationId as string), operation: { ...f.operation(call.body.operationId as string).operation, nativeThreadId: 'new-thread' } };
      if (call.path === '/threads/new-thread/snapshot') throw gatewayError('NATIVE_HISTORY_NOT_MATERIALIZED');
    });
    expect((await f.workspace.action({ type: 'startThread' })).firstTurnReady).toBe(true);
    f.events.at(-1)!.message({ malformed: true });
    expect(f.workspace.state().firstTurnReady).toBe(false);
    await f.workspace.action({ type: 'send', text: 'must wait after corrupt stream' });
    expect(f.writes().filter(call => call.path.endsWith('/turns'))).toEqual([]);
  });

  it('a stream reset while new-thread metadata is in flight cannot re-enable first-turn readiness', async () => {
    const f = fixture(); await f.connect();
    let threadReads = 0, resolve!: (response: unknown) => void;
    f.override(call => {
      if (call.path === `/projects/${projectId}/threads` && call.body?.operationId) return { ...f.operation(call.body.operationId as string), operation: { ...f.operation(call.body.operationId as string).operation, nativeThreadId: 'new-thread' } };
      if (call.path === '/threads/new-thread/snapshot') throw gatewayError('NATIVE_HISTORY_NOT_MATERIALIZED');
      if (call.path === `/projects/${projectId}/threads/new-thread` && ++threadReads === 2) return new Promise(done => { resolve = done; });
    });
    const creating = f.workspace.action({ type: 'startThread' });
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    f.events.at(-1)!.message({ type: 'connection', installationId, epoch, headSeq: 8, resetRequired: true });
    resolve(f.envelope({ id: 'new-thread', projectId, status: 'idle' }));
    const state = await creating;
    expect(state.firstTurnReady).toBe(false);
    await f.workspace.action({ type: 'send', text: 'cannot undo stream reset with idle metadata' });
    expect(f.writes().filter(call => call.path.endsWith('/turns'))).toEqual([]);
  });

  it.each(['NATIVE_REQUEST_FAILED', 'HISTORY_UNAVAILABLE'])('does not grant first-turn permission after generic %s', async errorCode => {
    const f = fixture(); await f.connect();
    f.override(call => {
      if (call.path === `/projects/${projectId}/threads` && call.body?.operationId) return { ...f.operation(call.body.operationId as string), operation: { ...f.operation(call.body.operationId as string).operation, nativeThreadId: 'new-thread' } };
      if (call.path === '/threads/new-thread/snapshot') throw gatewayError(errorCode);
    });
    const state = await f.workspace.action({ type: 'startThread' });
    expect(state.firstTurnReady).toBe(false);
    expect(state.notice).toBe(errorCode);
    expect(f.calls.filter(call => call.path === `/projects/${projectId}/threads/new-thread`)).toHaveLength(1);
    await f.workspace.action({ type: 'send', text: 'generic history failure cannot unlock sending' });
    expect(f.writes().filter(call => call.path.endsWith('/turns'))).toEqual([]);
  });

  it('a snapshot completed after another selection cannot replace its thread or settle its receipt', async () => {
    const f = fixture(); await f.connect();
    const original = f.journal.prepare(f.scope(), 'turn.start', { text: 'keep pending' });
    const oldSnapshot = { ...f.snapshot(), operations: [{ operationId: original.operationId, status: 'accepted' }] };
    let resolve!: (response: unknown) => void;
    f.override(call => call.path === `/threads/${threadId}/snapshot` ? new Promise(done => { resolve = done; }) : undefined);
    const refresh = (f.workspace as unknown as { refreshSnapshot(): Promise<void> }).refreshSnapshot();
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    await f.workspace.action({ type: 'selectThread', threadId: 'other-thread' });
    resolve(f.envelope(oldSnapshot)); await refresh;
    expect(f.workspace.state().threadId).toBe('other-thread');
    expect(f.journal.pending(f.identity())[0].operationId).toBe(original.operationId);
  });
});

describe('Desktop selected Snapshot thread-list updates', () => {
  const page = (threads: { id: string; projectId: string; status: string; title?: string }[]) => ({ threads, nextCursor: null, source: 'native', truncated: false });
  const listCall = (call: Call) => call.path.startsWith(`/projects/${projectId}/threads?`);
  const refreshSnapshot = (f: ReturnType<typeof fixture>) => (f.workspace as unknown as { refreshSnapshot(): Promise<void> }).refreshSnapshot();

  it('makes a newly materialized thread visible after its first completed turn without manual refresh', async () => {
    const f = fixture(); await f.connect();
    let materialized = false;
    f.override(call => {
      if (listCall(call)) return f.envelope(page(materialized ? [{ id: 'new-thread', projectId, status: 'idle', title: 'First turn complete' }] : []));
      if (call.path === `/projects/${projectId}/threads` && call.body?.operationId) return { ...f.operation(call.body.operationId as string), operation: { ...f.operation(call.body.operationId as string).operation, nativeThreadId: 'new-thread' } };
      if (call.path === '/threads/new-thread/snapshot' && !materialized) throw gatewayError('NATIVE_HISTORY_NOT_MATERIALIZED');
      if (call.path === '/threads/new-thread/turns' && call.body?.operationId) materialized = true;
    });
    await f.workspace.action({ type: 'startThread' });
    expect(f.workspace.state().threads!.threads).toEqual([]);
    vi.useFakeTimers();
    await f.workspace.action({ type: 'send', text: 'materialize the native thread' });
    const readsBefore = f.calls.filter(listCall).length;
    await vi.advanceTimersByTimeAsync(100);
    expect(f.workspace.state().threads!.threads).toEqual([{ id: 'new-thread', projectId, status: 'idle', archived: false }]);
    expect(f.calls.filter(listCall)).toHaveLength(readsBefore);
    await refreshSnapshot(f);
    expect(f.calls.filter(listCall)).toHaveLength(readsBefore);
  });

  it('uses list-confirmed membership for insertion and then updates Snapshot metadata without duplicate reads', async () => {
    const f = fixture(); await f.connect();
    f.override(call => listCall(call) ? f.envelope(page([{ id: 'new-thread', projectId, status: 'idle', title: 'Selected new thread' }])) : undefined);
    f.patchSnapshot(snapshot => ({ ...snapshot, thread: { ...snapshot.thread, archived: false, title: 'Selected new thread' } }));
    const reads = f.calls.filter(listCall).length;
    await f.workspace.action({ type: 'selectThread', threadId: 'new-thread' });
    expect(f.workspace.state().threads!.threads[0]).toMatchObject({ id: 'new-thread', archived: false, title: 'Selected new thread' });
    f.patchSnapshot(snapshot => ({ ...snapshot, thread: { ...snapshot.thread, archived: false, title: 'Updated native title', preview: 'Latest preview' } }));
    await refreshSnapshot(f);
    expect(f.workspace.state().threads!.threads.filter(thread => thread.id === 'new-thread')).toHaveLength(1);
    expect(f.workspace.state().threads!.threads[0]).toMatchObject({ title: 'Updated native title', preview: 'Latest preview' });
    expect(f.calls.filter(listCall)).toHaveLength(reads + 1);
  });

  it('does not insert an absent selected thread into native search results but updates existing result metadata', async () => {
    const f = fixture(); await f.connect();
    await f.workspace.action({ type: 'threads', search: 'native search' });
    f.patchSnapshot(snapshot => ({ ...snapshot, thread: { ...snapshot.thread, archived: false, title: 'Current metadata' } }));
    const reads = f.calls.filter(listCall).length;
    await f.workspace.action({ type: 'selectThread', threadId: 'new-thread' });
    expect(f.workspace.state().threads!.threads.some(thread => thread.id === 'new-thread')).toBe(false);
    await f.workspace.action({ type: 'selectThread', threadId });
    expect(f.workspace.state().threads!.threads.find(thread => thread.id === threadId)?.title).toBe('Current metadata');
    expect(f.calls.filter(listCall)).toHaveLength(reads + 2);
  });

  it('honors archive query provenance despite omitted or contradictory Snapshot metadata', async () => {
    const f = fixture(); await f.connect();
    let archived = true;
    f.override(call => listCall(call) ? f.envelope(page(new URLSearchParams(call.path.split('?')[1]).get('archived') === String(archived)
      ? [{ id: 'new-thread', projectId, status: 'idle' }] : [])) : undefined);
    await f.workspace.action({ type: 'threads', archived: true });
    f.patchSnapshot(snapshot => ({ ...snapshot, thread: { ...snapshot.thread, archived: false } }));
    const reads = f.calls.filter(listCall).length;
    await f.workspace.action({ type: 'selectThread', threadId: 'new-thread' });
    expect(f.workspace.state().thread?.archived).toBe(true);
    f.patchSnapshot(undefined); await refreshSnapshot(f);
    expect(f.workspace.state().thread?.archived).toBe(true);
    expect(f.calls.filter(listCall)).toHaveLength(reads);
    archived = false;
    f.emit('native.state', { method: 'thread/unarchived', data: { threadId: 'new-thread' }, truncated: false }, { projectId, threadId: 'new-thread' });
    expect(f.workspace.state().thread?.archived).toBeUndefined();
    await refreshSnapshot(f);
    expect(f.workspace.state().thread?.archived).toBe(false);
    expect(f.workspace.state().threads!.threads).toEqual([]);
  });

  it('does not poll the list again for the same missing thread and accepted history revision', async () => {
    const f = fixture(); await f.connect();
    f.override(call => listCall(call) ? f.envelope(page([])) : undefined);
    await f.workspace.action({ type: 'threads' });
    f.emit('native.state', { method: 'thread/closed', data: { threadId }, truncated: false });
    const reads = f.calls.filter(listCall).length;
    await refreshSnapshot(f); await refreshSnapshot(f); await refreshSnapshot(f);
    expect(f.calls.filter(listCall)).toHaveLength(reads + 2);
    expect(f.workspace.state().threads!.threads).toEqual([]);
  });

  it('keeps loaded older pages and their cursor while confirming the missing selected thread', async () => {
    const f = fixture(); await f.connect();
    let confirm = false;
    f.override(call => {
      if (!listCall(call)) return;
      if (confirm) return f.envelope({ ...page([{ id: threadId, projectId, status: 'idle', title: 'Materialized' }]), nextCursor: 'first-page-cursor' });
      const cursor = new URLSearchParams(call.path.split('?')[1]).get('cursor');
      return f.envelope({ ...page([{ id: cursor ? 'older-listed-thread' : 'recent-listed-thread', projectId, status: 'idle' }]),
        nextCursor: cursor ? 'older-page-cursor' : 'first-page-cursor', truncated: true });
    });
    await f.workspace.action({ type: 'threads' });
    await f.workspace.action({ type: 'threads', more: true });
    confirm = true; f.emit('native.state', { method: 'thread/closed', data: { threadId }, truncated: false }); await refreshSnapshot(f);
    expect(f.workspace.state().threads).toMatchObject({ nextCursor: 'older-page-cursor', truncated: true });
    expect(f.workspace.state().threads!.threads.map(thread => thread.id)).toEqual([threadId, 'recent-listed-thread', 'older-listed-thread']);
  });

  it('does not overwrite a newer same-filter user refresh with a late automatic list response', async () => {
    const f = fixture(); await f.connect();
    f.override(call => listCall(call) ? f.envelope(page([])) : undefined);
    await f.workspace.action({ type: 'threads' });
    f.emit('native.state', { method: 'thread/closed', data: { threadId }, truncated: false });
    let resolve!: (value: unknown) => void, automatic = true;
    f.override(call => {
      if (!listCall(call)) return;
      if (automatic) { automatic = false; return new Promise(done => { resolve = done; }); }
      return f.envelope(page([{ id: 'newer-list-result', projectId, status: 'idle' }]));
    });
    const pending = refreshSnapshot(f);
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    await f.workspace.action({ type: 'threads' });
    resolve(f.envelope(page([{ id: threadId, projectId, status: 'idle', title: 'Late result' }])));
    await pending;
    expect(f.workspace.state().threads!.threads.map(thread => thread.id)).toEqual(['newer-list-result']);
  });

  it.each(['search', 'archive', 'selection'] as const)('discards an in-flight automatic list result after %s changes', async change => {
    const f = fixture(); await f.connect();
    f.override(call => listCall(call) ? f.envelope(page([])) : undefined);
    await f.workspace.action({ type: 'threads' });
    f.emit('native.state', { method: 'thread/closed', data: { threadId }, truncated: false });
    let resolve!: (value: unknown) => void;
    f.override(call => {
      if (!listCall(call)) return;
      const query = new URLSearchParams(call.path.split('?')[1]);
      if (query.get('search') === 'new-filter' || query.get('archived') === 'true') return f.envelope(page([{ id: 'filtered-result', projectId, status: 'idle' }]));
      return new Promise(done => { resolve = done; });
    });
    const pending = refreshSnapshot(f);
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    if (change === 'search') await f.workspace.action({ type: 'threads', search: 'new-filter' });
    if (change === 'archive') await f.workspace.action({ type: 'threads', archived: true });
    if (change === 'selection') await f.workspace.action({ type: 'selectThread', threadId: 'other-thread' });
    resolve(f.envelope(page([{ id: threadId, projectId, status: 'idle', title: 'Late original result' }])));
    await pending;
    expect(f.workspace.state().threads!.threads.some(thread => thread.title === 'Late original result')).toBe(false);
    if (change === 'selection') expect(f.workspace.state().threadId).toBe('other-thread');
    else expect(f.workspace.state().threads!.threads[0].id).toBe('filtered-result');
  });
});

describe('Desktop authoritative archive membership', () => {
  const list = (threads: unknown[]) => ({ threads, nextCursor: null, source: 'native', truncated: false });
  const refresh = (f: ReturnType<typeof fixture>) => (f.workspace as unknown as { refreshSnapshot(): Promise<void> }).refreshSnapshot();

  it('queries the opposite view for an archived selection, blocks sending, and supports explicit unarchive/archive', async () => {
    const f = fixture(); await f.connect(); let archived = true;
    f.override(call => {
      if (call.path.endsWith('/unarchive') && call.body?.operationId) archived = false;
      if (call.path.endsWith('/archive') && call.body?.operationId) archived = true;
      if (call.path.startsWith(`/projects/${projectId}/threads?`)) return f.envelope(list(new URLSearchParams(call.path.split('?')[1]).get('archived') === String(archived)
        ? [{ id: threadId, projectId, status: 'idle' }] : []));
    });
    f.emit('native.state', { method: 'thread/archived', data: { threadId }, truncated: false });
    expect(f.workspace.state().thread?.archived).toBeUndefined();
    await refresh(f);
    expect(f.workspace.state().thread?.archived).toBe(true);
    expect(f.workspace.state().threads!.threads.some(thread => thread.id === threadId)).toBe(false);
    expect((await f.workspace.action({ type: 'send', text: 'archived cannot send' })).notice).toBe('THREAD_ARCHIVED');
    expect(f.writes()).toEqual([]);
    expect((await f.workspace.action({ type: 'threadMutation', action: 'unarchive' })).thread?.archived).toBe(false);
    expect(f.writes()).toHaveLength(1);
    await f.workspace.action({ type: 'threadMutation', action: 'archive' });
    await f.workspace.action({ type: 'threads', archived: true });
    const selected = await f.workspace.action({ type: 'selectThread', threadId });
    expect(selected.thread?.archived).toBe(true);
    expect(selected.threads!.threads[0].archived).toBe(true);
    expect(f.writes()).toHaveLength(2);
  });

  it('preserves verified membership through ordinary history, turn and item activity so steer remains usable', async () => {
    const f = fixture(); await f.connect();
    f.emit('history.invalidated', { reasonCode: 'NATIVE_COMPACTION' });
    expect(f.workspace.state().thread?.archived).toBe(false);
    await refresh(f);
    f.emit('native.state', { method: 'turn/started', data: { threadId, turn: { id: 'active-turn', status: 'inProgress' } }, truncated: false }, { projectId, threadId, turnId: 'active-turn' });
    expect(f.workspace.state().thread?.archived).toBe(false);
    await f.workspace.action({ type: 'steer', text: 'explicit supplement' });
    expect(f.writes()).toHaveLength(1);
    expect(f.writes()[0].path).toContain('/active-turn/steer');
  });

  it('never treats omitted or standalone Snapshot archive flags as verified unarchived membership', async () => {
    const f = fixture(); await f.connect();
    f.patchSnapshot(snapshot => ({ ...snapshot, thread: { ...snapshot.thread, archived: false } }));
    await f.workspace.action({ type: 'selectThread', threadId: 'unlisted-thread' });
    expect(f.workspace.state().thread?.archived).toBeUndefined();
    for (const action of [{ type: 'send', text: 'not verified' }, { type: 'upload' }, { type: 'threadMutation', action: 'archive' }, { type: 'threadMutation', action: 'unarchive' }]) {
      expect((await f.workspace.action(action)).notice).toBe('THREAD_ARCHIVE_STATE_UNKNOWN');
    }
    expect(f.writes()).toEqual([]); expect(f.dialogs.chooseUpload).not.toHaveBeenCalled();
  });

  it('rechecks archive uncertainty after authentication wait and never dispatches the prepared send', async () => {
    const f = fixture(); await f.connect();
    f.beforeGuard(() => { f.emit('native.state', { method: 'thread/archived', data: { threadId }, truncated: false }); });
    await f.workspace.action({ type: 'send', text: 'raced archive' });
    expect(f.writes()).toEqual([]);
    expect(f.journal.list(f.identity())[0]).toMatchObject({ state: 'rejected', receipt: { delivery: 'notSent' } });
    expect(f.workspace.state().thread?.archived).toBeUndefined();
  });

  it.each(['device', 'epoch'] as const)('does not reuse membership across disconnect and %s changes', async change => {
    const f = fixture(); await f.connect();
    await f.workspace.action({ type: 'disconnect' });
    expect(f.workspace.state().thread?.archived).toBeUndefined();
    if (change === 'device') f.device(otherDevice); else f.epoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    f.override(call => call.path.startsWith(`/projects/${projectId}/threads?`) ? f.envelope(list([])) : undefined);
    await f.workspace.action({ type: 'reconnect' });
    expect(f.workspace.state().thread?.archived).toBeUndefined();
    expect((await f.workspace.action({ type: 'send', text: 'old membership must not authorize' })).notice).toBe('THREAD_ARCHIVE_STATE_UNKNOWN');
    expect(f.writes()).toEqual([]);
  });

  it('rejects a list response that raced an archive event instead of restoring its stale membership', async () => {
    const f = fixture(); await f.connect();
    let resolve!: (value: unknown) => void;
    f.override(call => call.path.startsWith(`/projects/${projectId}/threads?`) ? new Promise(done => { resolve = done; }) : undefined);
    const pending = f.workspace.action({ type: 'threads' });
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    f.emit('native.state', { method: 'thread/archived', data: { threadId }, truncated: false });
    resolve(f.envelope(list([{ id: threadId, projectId, status: 'idle' }]))); await pending;
    expect(f.workspace.state().thread?.archived).toBeUndefined();
    expect(f.writes()).toEqual([]);
  });

  it('does not invalidate newly verified membership when an old lifecycle event is replayed twice', async () => {
    const f = fixture(); await f.connect();
    const payload = { method: 'thread/archived', data: { threadId }, truncated: false };
    f.emit('native.state', payload);
    await f.workspace.action({ type: 'refresh' });
    expect(f.workspace.state().thread?.archived).toBe(false);
    f.events.at(-1)!.message({ installationId, epoch, seq: 1, kind: 'native.state', impact: 'state', scope: { projectId, threadId }, payload });
    expect(f.workspace.state().thread?.archived).toBe(false);
    expect(f.workspace.state().synchronization).toBe('current');
  });
});

describe('Desktop file-change approval proof integration', () => {
  const nativeFileChange = (diff = '--- /private/fixture/project/src/change.txt\n+++ /private/fixture/project/src/change.txt\n@@ -1 +1 @@\n-old\n+new\n') => ({
    id: 'file-change-item', type: 'fileChange', status: 'inProgress',
    changes: [{ path: '/private/fixture/project/src/change.txt', kind: { type: 'update', move_path: null }, diff }],
  });
  const approval = (): Interaction => ({ interactionId, projectId, threadId, turnId: 'change-turn', epoch, generation: 1,
    kind: 'fileChange', status: 'pending', request: { threadId, turnId: 'change-turn', itemId: 'file-change-item', availableDecisions: ['accept', 'decline'] } });
  const proofSnapshot = (snapshot: Snapshot, diff?: string): Snapshot => ({ ...snapshot,
    thread: { ...snapshot.thread, status: 'active' }, synchronization: 'synchronizing', interactions: [approval()],
    history: { ...snapshot.history, complete: false, truncated: false,
      items: [{ id: 'change-turn', status: 'inProgress', items: [nativeFileChange(diff)] }] },
  });
  async function readyFixture() {
    const f = fixture(); await f.connect(); f.patchSnapshot(snapshot => proofSnapshot(snapshot));
    await f.workspace.action({ type: 'refresh' });
    return f;
  }
  const accept = (contextDigest: string) => ({ type: 'answer', interactionId, epoch, generation: 1, contextDigest,
    response: { type: 'approval', decision: 'accept' } });

  it('publishes complete relative proof and sends the exact native approval without digest or canonical paths', async () => {
    const f = await readyFixture();
    const context = f.workspace.state().fileChangeContexts![interactionId];
    expect(context).toMatchObject({ interactionId, generation: 1, epoch, projectId, threadId, turnId: 'change-turn', itemId: 'file-change-item' });
    expect(context.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(context.changes).toEqual([{ path: 'src/change.txt', kind: 'update', movePath: null,
      diff: '--- ./src/change.txt\n+++ ./src/change.txt\n@@ -1 +1 @@\n-old\n+new\n' }]);
    const accepted = await f.workspace.action(accept(context.digest));
    expect(f.writes()).toHaveLength(1);
    expect(f.writes()[0]).toMatchObject({ method: 'POST', path: `/interactions/${interactionId}/response`, body: { projectId, epoch, generation: 1, response: { type: 'approval', decision: 'accept' } } });
    expect(f.writes()[0].body).not.toHaveProperty('contextDigest');
    expect(accepted.operations[0].status).toBe('accepted');
    for (const state of f.published) {
      expect(JSON.stringify(state)).not.toContain('/private/fixture/project');
      expect(JSON.stringify(state)).not.toContain('canonicalPath');
    }
    expect(readFileSync(join(f.directory, JOURNAL_FILE), 'utf8')).not.toContain('/private/fixture/project');
    expect(readFileSync(join(f.directory, JOURNAL_FILE), 'utf8')).not.toContain('+new');
  });

  it('rejects missing and wrong displayed digests before creating an operation', async () => {
    const f = await readyFixture();
    const missing = accept('0'.repeat(64)) as Record<string, unknown>; delete missing.contextDigest;
    expect((await f.workspace.action(missing)).notice).toBe('FILE_CHANGE_ACCEPT_UNAVAILABLE');
    expect((await f.workspace.action(accept('0'.repeat(64)))).notice).toBe('FILE_CHANGE_ACCEPT_UNAVAILABLE');
    expect(f.writes()).toEqual([]);
    expect(f.journal.list(f.identity())).toEqual([]);
  });

  it('rejects an old displayed digest when a new accepted snapshot contains a changed patch', async () => {
    const f = await readyFixture();
    const old = f.workspace.state().fileChangeContexts![interactionId].digest;
    f.patchSnapshot(snapshot => proofSnapshot(snapshot, '+different patch\n'));
    await f.workspace.action({ type: 'refresh' });
    expect(f.workspace.state().fileChangeContexts![interactionId].digest).not.toBe(old);
    expect((await f.workspace.action(accept(old))).notice).toBe('FILE_CHANGE_ACCEPT_UNAVAILABLE');
    expect(f.writes()).toEqual([]);
  });

  it('invalidates proof during authentication wait and records local notSent instead of accepting', async () => {
    const f = await readyFixture();
    const digest = f.workspace.state().fileChangeContexts![interactionId].digest;
    f.beforeGuard(() => { f.emit('native.state', { method: 'turn/diff/updated', data: { threadId, turnId: 'change-turn', diff: 'updated native diff' }, truncated: false }, { projectId, threadId, turnId: 'change-turn' }); });
    await f.workspace.action(accept(digest));
    expect(f.writes()).toEqual([]);
    expect(f.journal.list(f.identity())[0]).toMatchObject({ kind: 'interaction.respond', state: 'rejected', receipt: { delivery: 'notSent', errorCode: 'FILE_CHANGE_ACCEPT_UNAVAILABLE' } });
    expect(f.workspace.state().fileChangeContexts).toEqual({});
  });

  it('a failed snapshot refresh withdraws old proof and cannot retain accept authority', async () => {
    const f = await readyFixture();
    const old = f.workspace.state().fileChangeContexts![interactionId].digest;
    f.override(call => { if (call.path.endsWith('/snapshot')) throw gatewayError('NATIVE_UNAVAILABLE'); });
    await f.workspace.action({ type: 'refresh' });
    expect(f.workspace.state().fileChangeContexts).toEqual({});
    expect((await f.workspace.action(accept(old))).notice).toBe('FILE_CHANGE_ACCEPT_UNAVAILABLE');
    expect(f.writes()).toEqual([]);
  });

  it('out-of-project file context never publishes proof but still permits explicit decline', async () => {
    const f = fixture(); await f.connect();
    f.patchSnapshot(snapshot => {
      const value = proofSnapshot(snapshot);
      const item = ((value.history.items[0] as { items: ReturnType<typeof nativeFileChange>[] }).items[0]);
      item.changes[0].path = '/private/unrelated-project/outside.txt';
      return value;
    });
    await f.workspace.action({ type: 'refresh' });
    expect(f.workspace.state().fileChangeContexts).toEqual({});
    expect((await f.workspace.action(accept('0'.repeat(64)))).notice).toBe('FILE_CHANGE_ACCEPT_UNAVAILABLE');
    await f.workspace.action({ type: 'answer', interactionId, epoch, generation: 1, response: { type: 'approval', decision: 'decline' } });
    expect(f.writes()).toHaveLength(1);
    expect(f.writes()[0].body!.response).toEqual({ type: 'approval', decision: 'decline' });
  });
});

describe('Desktop command approval canonical working-directory boundary', () => {
  const answer = (decision: 'accept' | 'decline' = 'accept') => ({ type: 'answer', interactionId, epoch, generation: 1,
    response: { type: 'approval', decision } });
  const withCwd = (cwd: string | undefined): Interaction => {
    const approval = pendingApproval();
    if (cwd === undefined) delete approval.request.cwd;
    else approval.request.cwd = cwd;
    return approval;
  };

  it('publishes only a project-relative marker and accepts a command at the exact canonical project cwd', async () => {
    const f = fixture(); f.patchSnapshot(snapshot => ({ ...snapshot, interactions: [pendingApproval()] })); await f.connect();
    const view = f.workspace.state();
    expect(view.commandScopes?.[interactionId]).toEqual({ relativeCwd: '.' });
    expect(view.interactions[0].request).not.toHaveProperty('cwd');
    expect(JSON.stringify(view)).not.toContain('/private/fixture/project');
    const state = await f.workspace.action(answer());
    expect(f.writes()).toHaveLength(1);
    expect(f.writes()[0]).toMatchObject({ path: `/interactions/${interactionId}/response`, body: { response: { type: 'approval', decision: 'accept' } } });
    expect(state.operations[0].status).toBe('accepted');
    expect(f.writes()[0].body).not.toHaveProperty('cwd');
  });

  it.each([undefined, '/private/another-project', '/private/fixture/project/subdirectory',
    '/private/fixture/project/', '/private/fixture/project/../project', '.', ''])('refuses unverified command cwd %# before journaling or dispatch', async cwd => {
    const f = fixture(); f.patchSnapshot(snapshot => ({ ...snapshot, interactions: [withCwd(cwd)] })); await f.connect();
    expect(f.workspace.state().commandScopes?.[interactionId]).toBeUndefined();
    const state = await f.workspace.action(answer());
    expect(state.notice).toBe('COMMAND_CWD_UNVERIFIED');
    expect(f.writes()).toEqual([]); expect(f.journal.list(f.identity())).toEqual([]);
  });

  it('rechecks command cwd after the authentication wait and records notSent when the live request changes', async () => {
    const f = fixture(); f.patchSnapshot(snapshot => ({ ...snapshot, interactions: [pendingApproval()] })); await f.connect();
    expect(f.workspace.state().commandScopes?.[interactionId]).toEqual({ relativeCwd: '.' });
    f.beforeGuard(() => { f.emit('interaction.opened', withCwd('/private/another-project'), { projectId, threadId, turnId: 'turn-1' }); });
    const state = await f.workspace.action(answer());
    expect(state.notice).toBe('COMMAND_CWD_UNVERIFIED'); expect(f.writes()).toEqual([]);
    expect(f.journal.list(f.identity())[0]).toMatchObject({ kind: 'interaction.respond', state: 'rejected',
      receipt: { delivery: 'notSent', errorCode: 'COMMAND_CWD_UNVERIFIED' } });
    expect(state.commandScopes?.[interactionId]).toBeUndefined();
  });

  it('still allows explicit decline when the command working directory is outside the selected project', async () => {
    const f = fixture(); f.patchSnapshot(snapshot => ({ ...snapshot, interactions: [withCwd('/private/another-project')] })); await f.connect();
    await f.workspace.action(answer('decline'));
    expect(f.writes()).toHaveLength(1);
    expect(f.writes()[0].body!.response).toEqual({ type: 'approval', decision: 'decline' });
  });
});
