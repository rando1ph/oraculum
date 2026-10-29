import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { Thread, Turn } from '../../packages/shared/protocol';
import { BridgeService } from './service';
import { AgentSummaries } from './subagents';

const thread = (id: string, parentThreadId: string | null = null, patch: any = {}) => ({ id, cwd: '/fixture', preview: '', parentThreadId, source: 'appServer', status: { type: 'idle' }, turns: [], ...patch }) as Thread;
const turn = (id: string, status: Turn['status'], startedAt: number | null = 100, items: any[] = []) => ({ id, status, items, startedAt, completedAt: null, durationMs: null, error: null, itemsView: 'full' }) as Turn;
const call = (id: string, sender = 'parent', receiver = 'child') => ({ type: 'collabAgentToolCall', id, senderThreadId: sender, receiverThreadIds: [receiver], agentsStates: { [receiver]: { status: 'running', message: null } }, tool: 'spawnAgent', status: 'completed', prompt: 'Read only', model: null, reasoningEffort: null });

async function fixture(items = [call('spawn')]) {
  const bus = new EventEmitter(), records = new Map<string, Thread>([
    ['parent', thread('parent', null, { turns: [turn('parent-turn', 'completed', 100, items)] })],
    ['child', thread('child', 'parent', { agentNickname: 'Ada', agentRole: 'reviewer', path: '/private/rollout', turns: [turn('child-turn', 'completed', 102, [{ type: 'agentMessage', id: 'final', phase: 'final_answer', text: 'Verified child result' }])] })],
    ['nested', thread('nested', 'child', { agentNickname: 'Lin', turns: [turn('nested-turn', 'completed', 103)] })],
  ]);
  const request = vi.fn(async (method: string, params: any): Promise<any> => {
    const record = records.get(params.threadId);
    if (method === 'thread/start') return { thread: records.get('parent'), approvalPolicy: 'on-request', sandbox: { type: 'readOnly' }, approvalsReviewer: 'user' };
    if (method === 'thread/read') return { thread: record };
    if (method === 'thread/turns/list') return { data: record!.turns, nextCursor: null };
    if (method === 'thread/items/list') return { data: record!.turns.find(turn => turn.id === params.turnId)!.items.map(item => ({ turnId: params.turnId, item })), nextCursor: null };
    throw new Error('Unexpected native operation');
  });
  const send = vi.fn(), service = new BridgeService({ request, send, on: bus.on.bind(bus) }, '/fixture');
  const events: any[] = []; service.on('event', event => events.push(event));
  await service.dispatch('thread/start', {}); await service.dispatch('bridge/subscribe', { threadId: 'parent' }); request.mockClear();
  return { service, request, send, bus, records, events, read: (agentId = 'child', extra: any = {}, context?: any) => service.dispatch('bridge/agent', { threadId: 'parent', cwd: '/fixture', agentId, ...extra }, context) as Promise<any> };
}

it('uses stable native parent/cwd proof and existing history APIs for a read-only historical child', async () => {
  const f = await fixture(), result = await f.read();
  expect(result).toMatchObject({ status: 'ready', agent: { id: 'child', parentThreadId: 'parent', nickname: 'Ada', role: 'reviewer', status: 'completed', result: 'Verified child result' } });
  expect(result.turns[0].items[0].text).toBe('Verified child result');
  expect(JSON.stringify(result)).not.toMatch(/private|rollout|modelProvider|approvalPolicy/);
  expect(f.request.mock.calls.map(call => call[0])).toEqual(['thread/read', 'thread/turns/list', 'thread/items/list']);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.events).toContainEqual(expect.objectContaining({ type: 'subagentChanged', displayThreadIds: ['parent'] }));
  expect((await f.service.dispatch('bridge/subscribe', { threadId: 'parent' }) as any).agents).toHaveLength(1);
});

it('validates the whole nested chain before adding ownership and follows native history cursors', async () => {
  const f = await fixture([call('child'), call('nested', 'child', 'nested')]);
  const result = await f.read('nested', { cursor: 'older-native-cursor' });
  expect(result.status).toBe('ready'); expect(result.agent.parentThreadId).toBe('child');
  expect(f.request.mock.calls.filter(call => call[0] === 'thread/read').map(call => call[1].threadId)).toEqual(['nested', 'child']);
  expect(f.request).toHaveBeenCalledWith('thread/turns/list', expect.objectContaining({ cursor: 'older-native-cursor' }));
  expect(f.service.threads.has('nested')).toBe(true); expect(f.service.threads.has('child')).toBe(true);
  expect(f.events.at(-1)).toMatchObject({ type: 'subagentChanged', displayThreadIds: ['child', 'parent'] });
});

it('accepts native participant references delivered in a full Turn when individual item events were missed', async () => {
  const f = await fixture([]);
  f.bus.emit('message', { method: 'turn/completed', params: { threadId: 'parent', turn: turn('replayed', 'completed', 120, [call('missed-item')]) } });
  expect(await f.read()).toMatchObject({ status: 'ready', agent: { id: 'child' } });
});

it('does not read arbitrary IDs, reassign scopes or promote IDs merely sent by the renderer', async () => {
  const f = await fixture();
  await expect(f.read('private')).rejects.toThrow('已授权');
  await expect(f.read('child', { cwd: '/private' })).rejects.toThrow('项目');
  await expect(f.read('child', { threadId: 'unowned' })).rejects.toThrow('父会话');
  expect(f.request).not.toHaveBeenCalled(); expect(f.service.threads.has('private')).toBe(false);
});

it.each(['project', 'parent', 'cycle', 'review', 'compact', 'missing-parent'])('rejects unsafe or internal native child metadata: %s', async kind => {
  const f = await fixture();
  const record = f.records.get('child')!;
  if (kind === 'project') record.cwd = '/private';
  if (kind === 'parent') record.parentThreadId = 'private-parent';
  if (kind === 'cycle') record.parentThreadId = 'child';
  if (kind === 'review' || kind === 'compact') record.source = { subAgent: kind };
  if (kind === 'missing-parent') record.parentThreadId = undefined as any;
  expect(await f.read()).toMatchObject({ status: 'unavailable' });
  expect(f.service.threads.has('child')).toBe(false);
  expect(f.request.mock.calls.map(call => call[0])).toEqual(['thread/read']);
  expect(JSON.stringify(f.events)).not.toContain('/private');
});

it('refuses a failed ancestry proof before reading history and sanitizes upstream failures', async () => {
  const f = await fixture([call('child'), call('nested', 'child', 'nested')]);
  f.records.get('child')!.cwd = '/private';
  expect(await f.read('nested')).toMatchObject({ status: 'unavailable' });
  expect(f.service.threads.has('nested')).toBe(false); expect(f.service.threads.has('child')).toBe(false);
  f.request.mockRejectedValue(new Error('private token and endpoint'));
  const result = await f.read(); expect(result.status).toBe('unavailable'); expect(JSON.stringify(result)).not.toContain('private');
});

it('rechecks device authorization after asynchronous native metadata reads', async () => {
  const f = await fixture(); let authorized = true;
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (method, params) => { const value = await original(method, params); authorized = false; return value; });
  await expect(f.read('child', {}, { deviceId: 'test', isAuthorized: () => authorized })).rejects.toThrow('设备授权已撤销');
  expect(f.service.threads.has('child')).toBe(false);
});

it('discards an in-flight transcript when a verified child is deleted during its history read', async () => {
  const f = await fixture();
  f.bus.emit('message', { method: 'thread/started', params: { thread: f.records.get('child') } });
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (method, params) => {
    const result = await original(method, params);
    if (method === 'thread/turns/list') f.bus.emit('message', { method: 'thread/deleted', params: { threadId: 'child' } });
    return result;
  });
  expect(await f.read()).toMatchObject({ status: 'unavailable' });
});

it('publishes only owned live descendants and excludes internal review/compact from the display projection', async () => {
  const f = await fixture();
  const start = (value: Thread) => f.bus.emit('message', { method: 'thread/started', params: { thread: value } });
  start(thread('private', 'parent', { cwd: '/private' })); start(thread('unowned', 'other'));
  start(thread('review', 'parent', { source: { subAgent: 'review' } })); start(thread('compact', 'parent', { source: { subAgent: 'compact' } }));
  expect(f.events.filter(event => event.type === 'subagentChanged')).toHaveLength(0);
  start(f.records.get('child')!); start(f.records.get('nested')!);
  f.bus.emit('message', { method: 'turn/started', params: { threadId: 'nested', turn: turn('nested-live', 'inProgress', 200) } });
  expect(f.events.at(-2)).toMatchObject({ type: 'subagentChanged', agent: { id: 'nested', status: 'running' }, displayThreadIds: ['child', 'parent'] });
  // Existing P0 routing still owns the only request and response path.
  f.bus.emit('message', { id: 5, method: 'item/tool/requestUserInput', params: { threadId: 'nested', turnId: 'nested-live', itemId: 'ask', isBlocking: true, autoResolutionMs: null, questions: [] } });
  expect(f.service.pending.size).toBe(1);
  expect(f.events.at(-1)).toMatchObject({ type: 'approval', request: { displayThreadIds: ['child', 'parent'] } });
});

it('never regresses a terminal projection on duplicate/late events or an older read; admits a timestamped new turn', () => {
  const values = new AgentSummaries(); values.register(thread('child', 'parent'), 'parent');
  const emit = (method: string, turnValue: Turn) => values.observe('child', { method, params: { turn: turnValue } });
  emit('turn/started', turn('one', 'inProgress', 100));
  values.observe('child', { method: 'item/completed', params: { turnId: 'one', item: { type: 'agentMessage', phase: 'commentary', text: 'Checking docs' } } });
  emit('turn/completed', turn('one', 'completed', 100, [{ type: 'agentMessage', phase: 'final_answer', text: 'Done' }]));
  const revision = values.values.get('child')!.revision;
  emit('turn/started', turn('one', 'inProgress', 100)); emit('turn/started', turn('old', 'inProgress', 99));
  emit('turn/started', turn('no-time', 'inProgress', null)); emit('turn/completed', turn('one', 'interrupted', 100));
  expect(values.values.get('child')).toMatchObject({ status: 'completed', result: 'Done', revision });
  emit('turn/started', turn('two', 'inProgress', 200));
  values.hydrate(thread('child', 'parent', { turns: [turn('one', 'completed', 100)] }), revision);
  expect(values.values.get('child')).toMatchObject({ status: 'running', turnId: 'two', result: null });
  emit('turn/completed', turn('one', 'completed', 100));
  expect(values.values.get('child')!.turnId).toBe('two');
  emit('turn/completed', turn('two', 'failed', 200)); expect(values.values.get('child')!.status).toBe('errored');
});
