import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GatewayStore, randomCredential } from './store';
import { GatewayService } from './service';
import { createGatewayServer } from './server';
import { CodexError, type CodexAdapter, type JsonObject, type NativeThread, type NativeTurn } from './codex';
import type { GatewayConfig } from './config';
import { validateContract } from '../../packages/gateway-protocol/src/index';
import type { EventEnvelope } from '../../packages/gateway-protocol/generated/types';

// Synthetic native facts, intentionally distinct from the model catalog's
// recommended default. No real Codex process, account or user session is used.
class NativeFixture extends EventEmitter {
  alive = true;
  threads = new Map<string, NativeThread>();
  inventoryExcluded = new Set<string>();
  inventoryCalls: { archived?: boolean; cursor?: string | null }[] = [];
  calls: { method: string; args: unknown[] }[] = [];
  failure?: { method: string; error: CodexError };
  async call(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
    if (this.failure?.method === method) throw this.failure.error;
  }
  nativeResult(thread: NativeThread) {
    return { thread: structuredClone(thread), model: 'effective', reasoningEffort: 'ultra', approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } };
  }
  async listModels() {
    return { data: [
      { id: 'catalog-default', model: 'catalog-default', displayName: 'Catalog recommendation', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
      { id: 'effective', model: 'effective', displayName: 'Effective model', isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }, { reasoningEffort: 'future-effort' }] },
    ], nextCursor: null };
  }
  async startThread(input: { cwd: string }) {
    await this.call('thread.start', input);
    const thread: NativeThread = { id: randomUUID(), cwd: input.cwd, preview: '', parentThreadId: null, source: 'appServer', ephemeral: false, status: { type: 'idle' }, turns: [] };
    this.threads.set(thread.id, thread);
    return this.nativeResult(thread);
  }
  async readThread(threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new CodexError('NATIVE_REJECTED', 'Unknown fixture thread', 'rejected');
    return { thread: structuredClone(thread) };
  }
  async resumeThread(threadId: string) {
    await this.call('thread.resume', threadId);
    return this.nativeResult(this.threads.get(threadId)!);
  }
  async listLifecycleThreads(input: { archived?: boolean; cursor?: string | null }): Promise<{ data: NativeThread[]; nextCursor: string | null }> {
    this.inventoryCalls.push(input);
    return { data: [...this.threads.values()].filter(thread => !this.inventoryExcluded.has(thread.id) && !!thread.archived === !!input.archived).map(thread => structuredClone(thread)), nextCursor: null };
  }
  async listThreads(input: { cwd: string; archived?: boolean }) {
    return { data: [...this.threads.values()].filter(thread => !this.inventoryExcluded.has(thread.id) && thread.cwd === input.cwd && !!thread.archived === !!input.archived).map(thread => structuredClone(thread)), nextCursor: null };
  }
  async setThreadName(threadId: string, name: string) { await this.call('thread.name', threadId, name); this.threads.get(threadId)!.name = name; return {}; }
  async archiveThread(threadId: string) { await this.call('thread.archive', threadId); this.threads.get(threadId)!.archived = true; return {}; }
  async unarchiveThread(threadId: string) { await this.call('thread.unarchive', threadId); this.threads.get(threadId)!.archived = false; return this.nativeResult(this.threads.get(threadId)!); }
  async deleteThread(threadId: string) { await this.call('thread.delete', threadId); this.threads.delete(threadId); return {}; }
  async forkThread(threadId: string, lastTurnId?: string) {
    await this.call('thread.fork', threadId, lastTurnId);
    const thread = structuredClone(this.threads.get(threadId)!);
    thread.id = randomUUID(); thread.parentThreadId = threadId;
    this.threads.set(thread.id, thread);
    return this.nativeResult(thread);
  }
  async revertThread(threadId: string, beforeTurnId: string) {
    await this.call('thread.revert', threadId, beforeTurnId);
    return { thread: structuredClone(this.threads.get(threadId)!) };
  }
  async compactThread(threadId: string) { await this.call('thread.compact', threadId); return {}; }
  async startTurn(input: { threadId: string }) {
    await this.call('turn.start', input);
    const thread = this.threads.get(input.threadId)!;
    const turn: NativeTurn = { id: randomUUID(), status: 'inProgress', items: [] };
    thread.status = { type: 'active', activeFlags: [] }; thread.turns.push(turn);
    this.emit('notification', { method: 'turn/started', params: { threadId: thread.id, turn: structuredClone(turn) } });
    return { turn };
  }
  async steerTurn(input: { threadId: string; expectedTurnId: string }) {
    await this.call('turn.steer', input);
    return { turnId: input.expectedTurnId };
  }
  async readConfig(cwd: string) {
    await this.call('config.read', cwd);
    return { config: { model: 'effective', model_reasoning_effort: 'ultra', approval_policy: 'never', sandbox_mode: 'danger-full-access', api_key: 'PRIVATE-CONFIG' },
      origins: { model: { name: { type: 'user', file: '/private/config.toml' }, version: 'private-version' } }, layers: [{ secret: 'PRIVATE-LAYER' }] };
  }
  async readAccountRateLimits() {
    await this.call('account.rateLimits');
    return { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1900000000 } }, accountId: 'PRIVATE-ACCOUNT', rateLimitUpsell: { secret: 'PRIVATE-UPSELL' } };
  }
  async readAccountUsage() {
    await this.call('account.usage');
    return { summary: { lifetimeTokens: 123 }, dailyUsageBuckets: [{ startDate: '2026-11-14', tokens: 10 }], accountId: 'PRIVATE-ACCOUNT' };
  }
  async close() { this.alive = false; }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oraculum-native-contract-'));
  const projectsPath = join(root, 'projects');
  for (const name of ['first', 'second']) mkdirSync(join(projectsPath, name), { recursive: true, mode: 0o700 });
  const store = new GatewayStore(join(root, 'state'), { create: true });
  const config: GatewayConfig = { configVersion: 2, stateDir: store.stateDir, host: '127.0.0.1', port: 18791, basePath: '/', externalOrigin: null, allowedRoots: [{ id: 'fixture', path: projectsPath }], codexCommand: 'unused-fixture' };
  const codex = new NativeFixture();
  const service = new GatewayService(store, config, codex as unknown as CodexAdapter);
  const app = await createGatewayServer(service, config);
  cleanups.push(async () => { await app.close(); await service.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const credentials = { installationId: store.installationId, deviceId: randomUUID(), deviceCredential: randomCredential(), code: store.createPairing().code, label: 'Native contract fixture' };
  const device = service.auth.pair(credentials);
  const request = async (path: string, body?: unknown, method?: 'POST' | 'DELETE' | 'GET', authenticated = true) => {
    const response = await app.inject({ method: method ?? (body === undefined ? 'GET' : 'POST'), url: '/api/v2' + path,
      headers: { host: '127.0.0.1:18791', 'x-oraculum-protocol': '2', ...(authenticated ? { authorization: `Bearer ${device.accessToken}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      payload: body === undefined ? undefined : JSON.stringify(body) });
    // Protocol envelopes intentionally contain heterogeneous native projections.
    return { status: response.statusCode, text: response.body, json: response.json() as Record<string, any> };
  };
  const register = async (name: string) => {
    const result = await request('/projects', { operationId: randomUUID(), rootId: 'fixture', path: name });
    expect(result.json.operation.status, result.text).toBe('accepted');
    return store.listProjects().find(project => project.canonicalPath === join(projectsPath, name))!.id;
  };
  const projectId = await register('first'), otherProjectId = await register('second');
  const base = (project = projectId) => ({ operationId: randomUUID(), projectId: project, expectedEpoch: service.epoch });
  const start = async () => {
    const result = await request(`/projects/${projectId}/threads`, { operationId: randomUUID(), expectedEpoch: service.epoch });
    expect(result.json.operation.status, result.text).toBe('accepted');
    return result.json.operation.nativeThreadId as string;
  };
  return { store, codex, service, request, projectId, otherProjectId, base, start, device };
}

describe('Gateway native capability HTTP contracts', () => {
  it('dispatches rename, archive, restoration and confirmed deletion with durable receipts', async () => {
    const f = await fixture(), threadId = await f.start();
    const operations = [
      { suffix: '/name', method: 'POST' as const, body: { name: 'A native title' }, native: 'thread.name' },
      { suffix: '/archive', method: 'POST' as const, body: {}, native: 'thread.archive' },
      { suffix: '/unarchive', method: 'POST' as const, body: {}, native: 'thread.unarchive' },
      { suffix: '', method: 'DELETE' as const, body: { confirm: true }, native: 'thread.delete' },
    ];
    for (const item of operations) {
      const body = { ...f.base(), ...item.body };
      const result = await f.request(`/threads/${threadId}${item.suffix}`, body, item.method);
      expect(result.status, result.text).toBe(200);
      expect(result.json.operation).toMatchObject({ operationId: body.operationId, status: 'accepted', nativeThreadId: threadId });
      expect(f.codex.calls.filter(call => call.method === item.native)).toHaveLength(1);
      const receipt = await f.request(`/operations/${body.operationId}`);
      expect(receipt.json.data.status).toBe('accepted');
    }
  });

  it('shows archived threads only in the archived native list, then restores and deletes them', async () => {
    const f = await fixture(), threadId = await f.start();
    const archive = await f.request(`/threads/${threadId}/archive`, f.base());
    expect(archive.json.operation.status, archive.text).toBe('accepted');
    expect((await f.request(`/projects/${f.projectId}/threads`)).json.data.threads).toEqual([]);
    const archived = await f.request(`/projects/${f.projectId}/threads?archived=true`);
    expect(archived.json.data.threads.map((thread: { id: string }) => thread.id)).toEqual([threadId]);
    const restored = await f.request(`/threads/${threadId}/unarchive`, f.base());
    expect(restored.json.operation.status, restored.text).toBe('accepted');
    expect((await f.request(`/projects/${f.projectId}/threads`)).json.data.threads.map((thread: { id: string }) => thread.id)).toEqual([threadId]);
    expect((await f.request(`/projects/${f.projectId}/threads?archived=true`)).json.data.threads).toEqual([]);
    const deleted = await f.request(`/threads/${threadId}`, { ...f.base(), confirm: true }, 'DELETE');
    expect(deleted.json.operation.status, deleted.text).toBe('accepted');
    expect((await f.request(`/projects/${f.projectId}/threads`)).json.data.threads).toEqual([]);
    const capabilities = await f.request('/capabilities');
    for (const name of ['thread.archive', 'thread.delete']) {
      expect(capabilities.json.data.capabilities.find((item: { name: string }) => item.name === name))
        .toMatchObject({ supported: true, availability: 'available', verified: true });
    }
  });

  it.each([undefined, false, 'true'])('requires explicit boolean true to permanently delete (confirm=%s)', async confirm => {
    const f = await fixture(), threadId = await f.start();
    const result = await f.request(`/threads/${threadId}`, { ...f.base(), ...(confirm === undefined ? {} : { confirm }) }, 'DELETE');
    expect(result.status, result.text).toBe(400); expect(result.json.error.code).toBe('INVALID_REQUEST');
    expect(f.codex.calls.filter(call => call.method === 'thread.delete')).toHaveLength(0);
  });

  it.each(['same-project-active', 'other-project-active', 'other-project-archived'])('refuses cascade when a native child depends on the target: %s', async state => {
    const f = await fixture(), threadId = await f.start(), root = f.codex.threads.get(threadId)!;
    const child: NativeThread = { ...structuredClone(root), id: randomUUID(), parentThreadId: threadId,
      cwd: state.startsWith('same') ? root.cwd : '/synthetic-unregistered-project', archived: state.endsWith('archived') };
    f.codex.threads.set(child.id, child);
    for (const [suffix, method] of [['/archive', 'POST'], ['', 'DELETE']] as const) {
      const result = await f.request(`/threads/${threadId}${suffix}`, { ...f.base(), ...(method === 'DELETE' ? { confirm: true } : {}) }, method);
      expect(result.status, result.text).toBe(200);
      expect(result.json.operation).toMatchObject({ status: 'rejected', errorCode: 'THREAD_HAS_DEPENDENCIES' });
    }
    expect(f.codex.calls.filter(call => ['thread.archive', 'thread.delete'].includes(call.method))).toHaveLength(0);
    if (state.endsWith('archived')) expect(f.codex.inventoryCalls.some(call => call.archived === true)).toBe(true);
  });

  it.each(['active', 'systemError'])('refuses archive and deletion while native status is %s', async status => {
    const f = await fixture(), threadId = await f.start();
    f.codex.threads.get(threadId)!.status = { type: status, ...(status === 'active' ? { activeFlags: [] } : {}) };
    for (const [suffix, method] of [['/archive', 'POST'], ['', 'DELETE']] as const) {
      const result = await f.request(`/threads/${threadId}${suffix}`, { ...f.base(), ...(method === 'DELETE' ? { confirm: true } : {}) }, method);
      if (status === 'active') expect(result.status, result.text).toBe(409);
      else {
        expect(result.status, result.text).toBe(200);
        expect(result.json.operation).toMatchObject({ status: 'rejected', errorCode: 'THREAD_LIFECYCLE_UNAVAILABLE' });
      }
    }
    expect(f.codex.calls.filter(call => ['thread.archive', 'thread.delete'].includes(call.method))).toHaveLength(0);
  });

  it('permits confirmed deletion of a fresh empty thread omitted from native persisted inventory', async () => {
    const f = await fixture(), threadId = await f.start();
    f.codex.inventoryExcluded.add(threadId);
    const result = await f.request(`/threads/${threadId}`, { ...f.base(), confirm: true }, 'DELETE');
    expect(result.json.operation.status, result.text).toBe('accepted');
    expect(f.codex.calls.filter(call => call.method === 'thread.delete')).toHaveLength(1);
  });

  it('refuses mutation when native inventory pagination repeats a cursor', async () => {
    const f = await fixture(), threadId = await f.start();
    f.codex.listLifecycleThreads = async input => {
      f.codex.inventoryCalls.push(input);
      return { data: [], nextCursor: 'repeating-native-cursor' };
    };
    const result = await f.request(`/threads/${threadId}/archive`, f.base());
    expect(result.status, result.text).toBe(200);
    expect(result.json.operation).toMatchObject({ status: 'rejected', errorCode: 'LIFECYCLE_INVENTORY_INCOMPLETE' });
    expect(f.codex.inventoryCalls).toHaveLength(2);
    expect(f.codex.calls.filter(call => call.method === 'thread.archive')).toHaveLength(0);
  });

  it('checks native status again after inventory before mutation', async () => {
    const f = await fixture(), threadId = await f.start();
    const read = f.codex.readThread.bind(f.codex); let reads = 0;
    f.codex.readThread = async id => {
      if (++reads === 2) f.codex.threads.get(id)!.status = { type: 'active', activeFlags: [] };
      return read(id);
    };
    const result = await f.request(`/threads/${threadId}/archive`, f.base());
    expect(result.status, result.text).toBe(200);
    expect(result.json.operation).toMatchObject({ status: 'rejected', errorCode: 'THREAD_LIFECYCLE_UNAVAILABLE' });
    expect(reads).toBe(2);
    expect(f.codex.calls.filter(call => call.method === 'thread.archive')).toHaveLength(0);
  });

  it('processes native turn-start notifications arriving during the final lifecycle read', async () => {
    const f = await fixture(), threadId = await f.start();
    const read = f.codex.readThread.bind(f.codex); let reads = 0;
    f.codex.readThread = async id => {
      if (++reads === 2) f.codex.emit('notification', { method: 'turn/started', params: { threadId: id, turn: { id: randomUUID(), status: 'inProgress', items: [] } } });
      return read(id);
    };
    const result = await f.request(`/threads/${threadId}/archive`, f.base());
    expect(result.status, result.text).toBe(200);
    expect(result.json.operation).toMatchObject({ status: 'rejected', errorCode: 'THREAD_LIFECYCLE_CHANGED' });
    expect(f.codex.calls.filter(call => call.method === 'thread.archive')).toHaveLength(0);
  });

  it('refuses lifecycle mutation when an active status notification races a stale idle final read', async () => {
    const f = await fixture(), threadId = await f.start();
    const read = f.codex.readThread.bind(f.codex); let reads = 0;
    f.codex.readThread = async id => {
      // The final read snapshot still says idle. The native event arriving
      // during that read must invalidate the earlier lifecycle preflight.
      if (++reads === 2) f.codex.emit('notification', { method: 'thread/status/changed', params: { threadId: id, status: { type: 'active', activeFlags: ['waitingOnUserInput'] } } });
      return read(id);
    };
    const result = await f.request(`/threads/${threadId}/archive`, f.base());
    expect(result.status, result.text).toBe(200);
    expect(result.json.operation.status).toBe('rejected');
    expect(f.codex.calls.filter(call => call.method === 'thread.archive')).toHaveLength(0);
  });

  it.each(['archive', 'delete'])('never replays an unknown native %s after timeout or disappearance from inventory', async action => {
    const f = await fixture(), threadId = await f.start();
    if (action === 'archive') f.codex.archiveThread = async id => {
      await f.codex.call('thread.archive', id); f.codex.threads.get(id)!.archived = true;
      throw new CodexError('NATIVE_TIMEOUT', 'Synthetic lost native response', 'unknown');
    };
    else f.codex.deleteThread = async id => {
      await f.codex.call('thread.delete', id); f.codex.threads.delete(id);
      throw new CodexError('NATIVE_TIMEOUT', 'Synthetic lost native response', 'unknown');
    };
    const method = action === 'archive' ? 'POST' as const : 'DELETE' as const;
    const path = `/threads/${threadId}` + (action === 'archive' ? '/archive' : '');
    const original = { ...f.base(), ...(action === 'delete' ? { confirm: true } : {}) };
    const unknown = await f.request(path, original, method);
    expect(unknown.status, unknown.text).toBe(202); expect(unknown.json.operation.status).toBe('unknown');
    f.codex.inventoryExcluded.add(threadId);
    await f.request(`/projects/${f.projectId}/threads`);
    await f.request(`/projects/${f.projectId}/threads?archived=true`);
    const again = await f.request(path, { ...f.base(), ...(action === 'delete' ? { confirm: true } : {}) }, method);
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(f.codex.calls.filter(call => call.method === `thread.${action}`)).toHaveLength(1);
    expect((await f.request(`/operations/${original.operationId}`)).json.data.status).toBe('unknown');
  });

  it('forks and reverts by explicit native turn IDs without hidden resume or replay', async () => {
    const f = await fixture(), threadId = await f.start(), turnId = randomUUID();
    const fork = await f.request(`/threads/${threadId}/fork`, { ...f.base(), lastTurnId: turnId });
    expect(fork.status, fork.text).toBe(200); expect(fork.json.operation.status).toBe('accepted');
    expect(fork.json.operation.nativeThreadId).not.toBe(threadId);
    expect(f.codex.calls.find(call => call.method === 'thread.fork')?.args).toEqual([threadId, turnId]);
    const revert = await f.request(`/threads/${threadId}/revert`, { ...f.base(), beforeTurnId: turnId });
    expect(revert.status, revert.text).toBe(200); expect(revert.json.operation.status).toBe('accepted');
    expect(f.codex.calls.find(call => call.method === 'thread.revert')?.args).toEqual([threadId, turnId]);
    expect(f.codex.calls.filter(call => call.method === 'thread.resume')).toHaveLength(0);
  });

  it('acknowledges compaction as native acceptance without claiming history completion', async () => {
    const f = await fixture(), threadId = await f.start();
    const result = await f.request(`/threads/${threadId}/compact`, f.base());
    expect(result.status, result.text).toBe(200); expect(result.json.operation).toMatchObject({ status: 'accepted', nativeThreadId: threadId });
    expect(result.json.operation.nativeTurnId).toBeUndefined();
    expect(f.codex.calls.filter(call => call.method === 'thread.compact')).toHaveLength(1);
  });

  it.each(['/name', '/archive', '/unarchive', '/fork', '/revert', '/compact', ''])('authorizes project and epoch before native mutation %s', async suffix => {
    const f = await fixture(), threadId = await f.start();
    const extra = suffix === '/name' ? { name: 'Safe title' } : suffix === '/revert' ? { beforeTurnId: randomUUID() } : suffix === '' ? { confirm: true } : {};
    const method = suffix === '' ? 'DELETE' as const : 'POST' as const;
    const before = f.codex.calls.length;
    const wrongProject = await f.request(`/threads/${threadId}${suffix}`, { ...f.base(f.otherProjectId), ...extra }, method);
    expect(wrongProject.status, wrongProject.text).toBe(403);
    const stale = await f.request(`/threads/${threadId}${suffix}`, { ...f.base(), ...extra, expectedEpoch: randomUUID() }, method);
    expect(stale.status, stale.text).toBe(409);
    expect(stale.json.error.code).toBe('STALE_EPOCH');
    expect(f.codex.calls).toHaveLength(before);
  });

  it('rejects duplicate operation IDs before re-dispatching and preserves unknown write barriers', async () => {
    const f = await fixture(), threadId = await f.start(), body = { ...f.base(), name: 'Original name' };
    const result = await f.request(`/threads/${threadId}/name`, body);
    expect(result.json.operation.status, result.text).toBe('accepted');
    const repeated = await f.request(`/threads/${threadId}/name`, body);
    expect(repeated.status).toBe(409); expect(repeated.json.error.code).toBe('OPERATION_ALREADY_RECORDED');
    expect(f.codex.calls.filter(call => call.method === 'thread.name')).toHaveLength(1);
    f.codex.failure = { method: 'thread.name', error: new CodexError('NATIVE_TIMEOUT', 'Synthetic lost response', 'unknown') };
    const renameBody = { ...f.base(), name: 'Unconfirmed rename' }, unknown = await f.request(`/threads/${threadId}/name`, renameBody);
    expect(unknown.status, unknown.text).toBe(202); expect(unknown.json.operation.status).toBe('unknown');
    const blocked = await f.request(`/threads/${threadId}/name`, { ...f.base(), name: 'Blocked until reconciled' });
    expect(blocked.status, blocked.text).toBe(409); expect(blocked.json.error.code).toBe('OPERATION_UNKNOWN');
    expect(f.codex.calls.filter(call => call.method === 'thread.name')).toHaveLength(2);
    expect((await f.request(`/operations/${renameBody.operationId}`)).json.data.status).toBe('unknown');
  });

  it('invalidates both observed device views while keeping operation receipts device-owned', async () => {
    const f = await fixture(), threadId = await f.start();
    const other = f.service.auth.pair({ installationId: f.store.installationId, deviceId: randomUUID(), deviceCredential: randomCredential(), code: f.store.createPairing().code, label: 'Second synthetic device' });
    const firstEvents: EventEnvelope[] = [], secondEvents: EventEnvelope[] = [];
    f.service.observe(f.device.deviceId); f.service.observe(other.deviceId);
    const first = f.service.feeds.subscribe(f.device.deviceId, event => firstEvents.push(event));
    const second = f.service.feeds.subscribe(other.deviceId, event => secondEvents.push(event));
    try {
      const result = await f.request(`/threads/${threadId}/name`, { ...f.base(), name: 'Shared native title' });
      expect(result.json.operation.status, result.text).toBe('accepted');
      for (const events of [firstEvents, secondEvents]) {
        expect(events.some(event => event.kind === 'history.invalidated' && event.scope.threadId === threadId)).toBe(true);
      }
      expect(firstEvents.some(event => event.kind === 'operation.changed')).toBe(true);
      expect(secondEvents.some(event => event.kind === 'operation.changed')).toBe(false);
    } finally { first(); second(); }
  });

  it('forwards native title updates and reads the updated authoritative title', async () => {
    const f = await fixture(), threadId = await f.start();
    const events: EventEnvelope[] = [];
    f.service.observe(f.device.deviceId);
    const unsubscribe = f.service.feeds.subscribe(f.device.deviceId, event => events.push(event));
    try {
      f.codex.threads.get(threadId)!.name = 'Title assigned by native Codex';
      f.codex.emit('notification', { method: 'thread/name/updated', params: { threadId, threadName: 'Title assigned by native Codex' } });
      await f.service.settled();
      expect(events.some(event => event.kind === 'native.state' && event.scope.threadId === threadId &&
        (event.payload as Record<string, unknown>).method === 'thread/name/updated')).toBe(true);
      const result = await f.request(`/projects/${f.projectId}/threads/${threadId}`);
      expect(result.json.data.title).toBe('Title assigned by native Codex');
      expect(f.codex.calls.filter(call => call.method === 'thread.name')).toHaveLength(0);
    } finally { unsubscribe(); }
  });

  it('reports automatic title generation unavailable when native Codex exposes no stable trigger', async () => {
    const f = await fixture();
    const capabilities = await f.request('/capabilities');
    expect(capabilities.json.data.capabilities.find((item: { name: string }) => item.name === 'thread.name.auto'))
      .toMatchObject({ supported: false, verified: false, reasonCode: 'NATIVE_AUTO_TITLE_UNAVAILABLE' });
  });

  it('retains unknown outcome if a native fork response crosses its authorized project', async () => {
    const f = await fixture(), threadId = await f.start();
    f.codex.forkThread = async (id, lastTurnId) => {
      await f.codex.call('thread.fork', id, lastTurnId);
      const thread = structuredClone(f.codex.threads.get(id)!);
      thread.id = randomUUID(); thread.cwd = '/synthetic-other-project';
      return f.codex.nativeResult(thread);
    };
    const result = await f.request(`/threads/${threadId}/fork`, f.base());
    expect(result.status, result.text).toBe(202);
    expect(result.json.operation).toMatchObject({ status: 'unknown', errorCode: 'NATIVE_PROTOCOL' });
    expect(f.codex.calls.filter(call => call.method === 'thread.fork')).toHaveLength(1);
  });

  it('retains explicit native unsupported rejections and never auto-resumes or substitutes rollback', async () => {
    const f = await fixture(), threadId = await f.start();
    f.codex.failure = { method: 'thread.revert', error: new CodexError('NATIVE_UNSUPPORTED', 'Unsupported native store', 'rejected') };
    const result = await f.request(`/threads/${threadId}/revert`, { ...f.base(), beforeTurnId: randomUUID() });
    expect(result.json.operation, result.text).toMatchObject({ status: 'rejected', errorCode: 'NATIVE_UNSUPPORTED' });
    expect(f.codex.calls.filter(call => call.method === 'thread.revert')).toHaveLength(1);
    expect(f.codex.calls.filter(call => call.method === 'thread.resume')).toHaveLength(0);
  });

  it('steers only the observed active turn and binds user-message delivery to its operation ID', async () => {
    const f = await fixture(), threadId = await f.start();
    const turn = await f.request(`/threads/${threadId}/turns`, { ...f.base(), input: [{ type: 'text', text: 'First input' }] });
    expect(turn.json.operation.status, turn.text).toBe('accepted');
    await f.service.settled();
    const turnId = turn.json.operation.nativeTurnId as string;
    const body = { ...f.base(), input: [{ type: 'text', text: 'Change direction' }] };
    const result = await f.request(`/threads/${threadId}/turns/${turnId}/steer`, body);
    expect(result.status, result.text).toBe(200); expect(result.json.operation).toMatchObject({ status: 'accepted', nativeTurnId: turnId });
    expect(f.codex.calls.find(call => call.method === 'turn.steer')?.args).toEqual([{ threadId, expectedTurnId: turnId, input: body.input, clientUserMessageId: body.operationId }]);
    const stale = await f.request(`/threads/${threadId}/turns/${randomUUID()}/steer`, { ...f.base(), input: body.input });
    expect(stale.status).toBe(409); expect(f.codex.calls.filter(call => call.method === 'turn.steer')).toHaveLength(1);
  });

  it.each(['/archive', '/compact', '/revert', ''])('rejects unsafe mutations during active work: %s', async suffix => {
    const f = await fixture(), threadId = await f.start();
    const turn = await f.request(`/threads/${threadId}/turns`, { ...f.base(), input: [{ type: 'text', text: 'Active fixture turn' }] });
    expect(turn.json.operation.status, turn.text).toBe('accepted');
    await f.service.settled();
    const before = f.codex.calls.length;
    const result = await f.request(`/threads/${threadId}${suffix}`, { ...f.base(), ...(suffix === '/revert' ? { beforeTurnId: randomUUID() } : suffix === '' ? { confirm: true } : {}) }, suffix === '' ? 'DELETE' : 'POST');
    expect(result.status, result.text).toBe(409); expect(f.codex.calls).toHaveLength(before);
  });

  it('accepts ultra and future effort names only for the effective selected model', async () => {
    const f = await fixture(), threadId = await f.start();
    for (const effort of ['ultra', 'future-effort']) {
      const result = await f.request(`/threads/${threadId}/turns`, { ...f.base(), model: 'effective', effort, input: [{ type: 'text', text: 'Effort fixture' }] });
      expect(result.status, result.text).toBe(200); expect(result.json.operation.status).toBe('accepted');
    }
    const before = f.codex.calls.filter(call => call.method === 'turn.start').length;
    const unsupported = await f.request(`/threads/${threadId}/turns`, { ...f.base(), model: 'catalog-default', effort: 'ultra', input: [{ type: 'text', text: 'Unsupported effort' }] });
    expect(unsupported.status, unsupported.text).toBe(400); expect(unsupported.json.error.code).toBe('INVALID_REQUEST');
    const unknown = await f.request(`/threads/${threadId}/turns`, { ...f.base(), model: 'effective', effort: 'unadvertised', input: [{ type: 'text', text: 'Unknown effort' }] });
    expect(unknown.status, unknown.text).toBe(400);
    expect(f.codex.calls.filter(call => call.method === 'turn.start')).toHaveLength(before);
  });

  it('prefers fresh native model and effort over an earlier start response after another client changes settings', async () => {
    const f = await fixture(), threadId = await f.start();
    const initial = await f.request(`/projects/${f.projectId}/threads/${threadId}`);
    expect(initial.json.data).toMatchObject({ model: 'effective', reasoningEffort: 'ultra' });
    const thread = f.codex.threads.get(threadId)!;
    thread.model = 'catalog-default'; thread.reasoningEffort = 'low';
    const fresh = await f.request(`/projects/${f.projectId}/threads/${threadId}`);
    expect(fresh.json.data).toMatchObject({ model: 'catalog-default', reasoningEffort: 'low' });
    const rejected = await f.request(`/threads/${threadId}/turns`, { ...f.base(), effort: 'ultra', input: [{ type: 'text', text: 'Do not validate against stale model' }] });
    expect(rejected.status, rejected.text).toBe(400); expect(rejected.json.error.code).toBe('INVALID_REQUEST');
    expect(f.codex.calls.filter(call => call.method === 'turn.start')).toHaveLength(0);
    expect(f.codex.calls.filter(call => call.method === 'config.read')).toHaveLength(0);
  });

  it('preserves explicit unknown model and effort and requires an explicit model instead of directory defaults', async () => {
    const f = await fixture(), threadId = await f.start();
    const thread = f.codex.threads.get(threadId)!;
    thread.model = null; thread.reasoningEffort = null;
    const fresh = await f.request(`/projects/${f.projectId}/threads/${threadId}`);
    expect(fresh.json.data.model).toBeNull(); expect(fresh.json.data.reasoningEffort).toBeNull();
    const rejected = await f.request(`/threads/${threadId}/turns`, { ...f.base(), effort: 'ultra', input: [{ type: 'text', text: 'Unknown current model' }] });
    expect(rejected.status, rejected.text).toBe(409); expect(rejected.json.error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(f.codex.calls.filter(call => call.method === 'turn.start')).toHaveLength(0);
    expect(f.codex.calls.filter(call => call.method === 'config.read')).toHaveLength(0);
    const explicit = await f.request(`/threads/${threadId}/turns`, { ...f.base(), model: 'effective', effort: 'ultra', input: [{ type: 'text', text: 'Explicit selected model' }] });
    expect(explicit.json.operation.status, explicit.text).toBe('accepted');
  });

  it('preserves older-peer native settings across metadata rename for effort-only requests', async () => {
    const f = await fixture(), threadId = await f.start();
    expect(f.codex.threads.get(threadId)!.model).toBeUndefined();
    const renamed = await f.request(`/threads/${threadId}/name`, { ...f.base(), name: 'Metadata only' });
    expect(renamed.json.operation.status, renamed.text).toBe('accepted');
    const view = await f.request(`/projects/${f.projectId}/threads/${threadId}`);
    expect(view.json.data).toMatchObject({ model: 'effective', reasoningEffort: 'ultra', title: 'Metadata only' });
    const result = await f.request(`/threads/${threadId}/turns`, { ...f.base(), effort: 'ultra', input: [{ type: 'text', text: 'Use observed old-peer model' }] });
    expect(result.json.operation.status, result.text).toBe('accepted');
    expect(f.codex.calls.filter(call => call.method === 'config.read')).toHaveLength(0);
  });

  it.each([true, false])('clears older-peer settings after unsupported native state events (scoped=%s)', async scoped => {
    const f = await fixture(), threadId = await f.start();
    f.codex.emit('notification', { method: 'gateway/unsupportedNativeEvent', params: scoped ? { threadId } : {} });
    await f.service.settled();
    const view = await f.request(`/projects/${f.projectId}/threads/${threadId}`);
    expect(view.json.data.model).toBeUndefined(); expect(view.json.data.reasoningEffort).toBeUndefined();
    const rejected = await f.request(`/threads/${threadId}/turns`, { ...f.base(), effort: 'ultra', input: [{ type: 'text', text: 'Unknown after invalidation' }] });
    expect(rejected.status, rejected.text).toBe(409); expect(rejected.json.error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(f.codex.calls.filter(call => call.method === 'turn.start')).toHaveLength(0);
    expect(f.codex.calls.filter(call => call.method === 'config.read')).toHaveLength(0);
    const resumed = await f.request(`/threads/${threadId}/resume`, f.base());
    expect(resumed.json.operation.status, resumed.text).toBe('accepted');
    const result = await f.request(`/threads/${threadId}/turns`, { ...f.base(), effort: 'ultra', input: [{ type: 'text', text: 'Resume restored native facts' }] });
    expect(result.json.operation.status, result.text).toBe('accepted');
  });

  it('clears older-peer settings when a native turn starts without current model readback', async () => {
    const f = await fixture(), threadId = await f.start();
    const turn: NativeTurn = { id: randomUUID(), status: 'inProgress', items: [] };
    const thread = f.codex.threads.get(threadId)!;
    thread.status = { type: 'active', activeFlags: [] }; thread.turns.push(turn);
    f.codex.emit('notification', { method: 'turn/started', params: { threadId, turn } });
    await f.service.settled();
    const view = await f.request(`/projects/${f.projectId}/threads/${threadId}`);
    expect(view.json.data.model).toBeUndefined(); expect(view.json.data.reasoningEffort).toBeUndefined();
    const rejected = await f.request(`/threads/${threadId}/turns`, { ...f.base(), effort: 'ultra', input: [{ type: 'text', text: 'Do not infer live model' }] });
    expect(rejected.status, rejected.text).toBe(409); expect(rejected.json.error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(f.codex.calls.filter(call => call.method === 'turn.start')).toHaveLength(0);
    expect(f.codex.calls.filter(call => call.method === 'config.read')).toHaveLength(0);
  });

  it('omits model, effort and permissions unless the client explicitly overrides them', async () => {
    const f = await fixture(), threadId = await f.start();
    const result = await f.request(`/threads/${threadId}/turns`, { ...f.base(), input: [{ type: 'text', text: 'Inherit native config' }] });
    expect(result.json.operation.status, result.text).toBe('accepted');
    const args = f.codex.calls.find(call => call.method === 'turn.start')!.args[0] as JsonObject;
    expect(args.model).toBeUndefined(); expect(args.effort).toBeUndefined(); expect(args.permissionPreset).toBeUndefined();
    const startArgs = f.codex.calls.find(call => call.method === 'thread.start')!.args[0] as JsonObject;
    expect(startArgs.model).toBeUndefined(); expect(startArgs.permissionPreset).toBeUndefined();
  });

  it('authenticates and redacts native defaults and account snapshots', async () => {
    const f = await fixture();
    const paths = [`/projects/${f.projectId}/native-defaults`, '/account/rate-limits', '/account/usage'];
    for (const path of paths) {
      const denied = await f.request(path, undefined, 'GET', false); expect(denied.status).toBe(401);
      const result = await f.request(path);
      expect(result.status, result.text).toBe(200);
      expect(result.json.data.readAt).toEqual(expect.any(Number));
      expect(result.text).not.toContain('PRIVATE'); expect(result.text).not.toContain('/private/');
    }
    const defaults = await f.request(paths[0]);
    expect(defaults.json.data).toMatchObject({ source: 'native-config', model: 'effective', effort: 'ultra', approvalPolicy: 'never', sandboxMode: 'danger-full-access' });
    expect(validateContract('NativeDefaults', defaults.json.data)).toBe(true);
    const missing = await f.request(`/projects/${randomUUID()}/native-defaults`);
    expect(missing.status).toBe(409);
  });
});
