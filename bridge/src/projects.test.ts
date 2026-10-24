import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectDirectories } from './projects';
import { BridgeService } from './service';
import { ReceiptStore } from './receipts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), 'oraculum-projects-'));
  cleanup.push(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'managed');
  const first = join(root, 'alpha');
  const second = join(root, 'beta');
  const outside = join(temp, 'private');
  await Promise.all([first, second, outside].map(path => mkdir(path, { recursive: true })));
  const codex = Object.assign(new EventEmitter(), {
    request: vi.fn(async (_method: string, _params: Record<string, unknown>): Promise<any> => ({})),
    send: vi.fn(),
  });
  const db = new DatabaseSync(':memory:');
  cleanup.push(() => db.close());
  const projects = new ProjectDirectories(root, first, db);
  await projects.register(first); await projects.register(second);
  const receipts = new ReceiptStore(db);
  const service = new BridgeService({
    on: codex.on.bind(codex), send: codex.send,
    request: async <T>(method: string, params: object): Promise<T> => await codex.request(method, params as Record<string, unknown>) as T,
  }, first, receipts, projects);
  return { root, first, second, outside, projects, codex, service, receipts };
}

describe('managed project directory boundary', () => {
  it('lists real directories, resolves internal aliases and omits escaping symlinks and files', async () => {
    const { root, first, second, outside, projects } = await fixture();
    await symlink(first, join(root, 'alias'));
    await symlink(outside, join(root, 'escape'));
    await writeFile(join(root, 'not-a-directory'), 'private');
    expect(await projects.list()).toEqual({ root, projects: [{ cwd: first, name: 'alpha', available: true }, { cwd: second, name: 'beta', available: true }] });
    expect(await projects.register(join(root, 'alias'))).toEqual({ cwd: first, name: 'alpha' });
    await expect(projects.resolve(join(root, 'escape'))).rejects.toThrow('escapes');
    await expect(projects.resolve(join(root, 'not-a-directory'))).rejects.toThrow('directory');
    await expect(projects.resolve(outside)).rejects.toThrow('outside');
    await expect(projects.resolve(root)).rejects.toThrow('outside');
    await expect(projects.resolve(join(root, '..', 'private'))).rejects.toThrow('outside');
    await expect(projects.resolve(root + '-sibling')).rejects.toThrow('outside');
    await expect(projects.resolve('../private')).rejects.toThrow('absolute');
  });

  it('routes native configuration and lists by selected project without mixing fresh sessions', async () => {
    const { first, second, outside, codex, service } = await fixture();
    codex.request.mockImplementation(async (method, params) => {
      if (method === 'thread/start') return { thread: { id: params.cwd === first ? 'alpha-new' : 'beta-new', cwd: params.cwd } };
      if (method === 'thread/list') return { data: [{ id: 'beta-old', cwd: second }, { id: 'private', cwd: outside }], nextCursor: 'opaque' };
      return { config: { model: 'native', model_reasoning_effort: 'high', model_provider: 'openai' } };
    });
    await service.dispatch('thread/start', {});
    await service.dispatch('thread/start', { cwd: second, approvalPolicy: 'never', sandbox: 'danger-full-access' });
    expect(codex.request).toHaveBeenCalledWith('thread/start', {
      cwd: second,
    });
    const page = await service.dispatch('thread/list', { cwd: second });
    expect(page).toEqual({ data: [{ id: 'beta-new', cwd: second }, { id: 'beta-old', cwd: second }], nextCursor: 'opaque' });
    expect(service.threads.has('private')).toBe(false);
    expect(await service.dispatch('bridge/config', { cwd: second })).toMatchObject({ cwd: second, model: 'native' });
    expect(codex.request).toHaveBeenCalledWith('config/read', { cwd: second, includeLayers: false });
    codex.request.mockClear();
    await expect(service.dispatch('thread/start', { cwd: outside })).rejects.toThrow('outside');
    await expect(service.dispatch('thread/list', { cwd: outside })).rejects.toThrow('outside');
    await expect(service.dispatch('bridge/config', { cwd: outside })).rejects.toThrow('outside');
    expect(codex.request).not.toHaveBeenCalled();
  });

  it('resumes listed native sessions in their own project and keeps send receipts there', async () => {
    const { first, second, codex, service, receipts } = await fixture();
    const thread = { id: 'beta-session', cwd: second, status: { type: 'idle' }, turns: [] };
    const turn = { id: 'native-turn', status: 'inProgress', items: [] };
    codex.request.mockImplementation(async method => {
      if (method === 'thread/list') return { data: [thread], nextCursor: null };
      if (method === 'thread/read' || method === 'thread/resume') return { thread };
      if (method === 'thread/turns/list') return { data: [], nextCursor: null };
      if (method === 'turn/start') return { turn };
      return {};
    });
    await service.dispatch('thread/list', { cwd: second });
    await service.dispatch('bridge/subscribe', { threadId: thread.id, cwd: first });
    expect(codex.request).toHaveBeenCalledWith('thread/resume', {
      threadId: thread.id, cwd: second, excludeTurns: true,
    });
    const operationId = '10000000-0000-4000-8000-000000000001';
    await service.dispatch('turn/start', { threadId: thread.id, text: 'native prompt', cwd: first, operationId }, { deviceId: 'paired-device' });
    expect(receipts.list(first, thread.id)).toEqual([]);
    expect(receipts.list(second, thread.id)).toMatchObject([{ operationId, status: 'accepted', turnId: turn.id }]);
    codex.emit('message', { method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, status: 'completed' } } });
    expect(receipts.list(second, thread.id)).toMatchObject([{ operationId, status: 'completed' }]);
    expect(receipts.blocked(second, thread.id)).toBe(false);
  });

  it('rechecks native cwd and changed filesystem paths before resuming or continuing', async () => {
    const { first, second, outside, codex, service } = await fixture();
    codex.request.mockImplementation(async method => method === 'thread/list'
      ? { data: [{ id: 'beta-session', cwd: second }], nextCursor: null }
      : { thread: { id: 'beta-session', cwd: first } });
    await service.dispatch('thread/list', { cwd: second });
    await expect(service.dispatch('bridge/subscribe', { threadId: 'beta-session' })).rejects.toThrow('outside');
    expect(codex.request.mock.calls.map(([method]) => method)).not.toContain('thread/resume');
    await rename(second, second + '-original');
    await symlink(outside, second);
    codex.request.mockClear();
    await expect(service.dispatch('turn/start', { threadId: 'beta-session', text: 'must not run' })).rejects.toThrow('escapes');
    expect(codex.request).not.toHaveBeenCalled();
    codex.emit('message', { method: 'turn/started', params: { threadId: 'beta-session', turn: { id: 'active', status: 'inProgress' } } });
    await service.dispatch('turn/interrupt', { threadId: 'beta-session', turnId: 'active' });
    expect(codex.request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'beta-session', turnId: 'active' });
    codex.emit('message', { id: 'pending', method: 'item/fileChange/requestApproval', params: { threadId: 'beta-session', turnId: 'active' } });
    const bridgeToken = service.pending.get('pending')!.bridgeToken;
    await expect(service.dispatch('bridge/approve', { threadId: 'beta-session', requestId: 'pending', bridgeToken, decision: 'accept' })).rejects.toThrow('escapes');
    await service.dispatch('bridge/approve', { threadId: 'beta-session', requestId: 'pending', bridgeToken, decision: 'decline' });
    expect(codex.send).toHaveBeenCalledWith({ id: 'pending', result: { decision: 'decline' } });
  });
});

it('revokes directory operations while keeping observed Stop and Decline available', async () => {
  const { second, projects, service, codex } = await fixture();
  codex.request.mockResolvedValue({ thread: { id: 'removed-project', cwd: second } });
  await service.dispatch('thread/start', { cwd: second });
  codex.emit('message', { method: 'turn/started', params: { threadId: 'removed-project', turn: { id: 'active', status: 'inProgress' } } });
  codex.emit('message', { id: 'pending', method: 'item/commandExecution/requestApproval', params: { threadId: 'removed-project', turnId: 'active' } });
  const bridgeToken = service.pending.get('pending')!.bridgeToken;
  await projects.unregister(second);
  codex.request.mockClear();
  for (const method of ['thread/list', 'thread/start', 'bridge/config', 'bridge/subscribe', 'bridge/history', 'turn/start', 'thread/archive', 'thread/unarchive', 'thread/delete']) {
    await expect(service.dispatch(method, { cwd: second, threadId: 'removed-project', text: 'blocked', confirm: true })).rejects.toThrow('registered');
  }
  await expect(service.dispatch('bridge/approve', { threadId: 'removed-project', requestId: 'pending', bridgeToken, decision: 'accept' })).rejects.toThrow('registered');
  expect(codex.request).not.toHaveBeenCalled();
  await service.dispatch('turn/interrupt', { threadId: 'removed-project', turnId: 'active' });
  await service.dispatch('bridge/approve', { threadId: 'removed-project', requestId: 'pending', bridgeToken, decision: 'decline' });
  expect(codex.send).toHaveBeenCalledWith({ id: 'pending', result: { decision: 'decline' } });
});

it('rejects a native resume response that changes project', async () => {
  const { second, outside, codex, service } = await fixture();
  const thread = { id: 'resume-mismatch', cwd: second, status: { type: 'idle' }, turns: [] };
  codex.request.mockImplementation(async method => method === 'thread/list' ? { data: [thread], nextCursor: null }
    : { thread: { ...thread, cwd: method === 'thread/resume' ? outside : second } });
  await service.dispatch('thread/list', { cwd: second });
  await expect(service.dispatch('bridge/subscribe', { threadId: thread.id })).rejects.toThrow('outside');
  await expect(service.dispatch('turn/start', { threadId: thread.id, text: 'blocked' })).rejects.toThrow('resume');
});
