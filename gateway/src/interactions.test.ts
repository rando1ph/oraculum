import { describe, expect, it, vi } from 'vitest';
import { Interactions, type Interaction } from './interactions';
import type { NativeRequest } from './codex';

const command = (id: string | number = 'native-1'): NativeRequest => ({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 't', turnId: 'turn', itemId: 'item', command: 'echo test', cwd: '/project' } });
function setup() {
  const peer = { respondRequest: vi.fn().mockResolvedValue(undefined), rejectRequest: vi.fn().mockResolvedValue(undefined) };
  return { peer, interactions: new Interactions(peer, { epoch: 'epoch-1' }) };
}
const context = { deviceId: 'device-1', projectId: 'p', threadId: 't' };
const approve = (interaction: Interaction) => ({ interactionId: interaction.interactionId, epoch: interaction.epoch, generation: interaction.generation, response: { type: 'approval' as const, decision: 'accept' as const } });
describe('current-generation native interactions', () => {
  it('atomically submits at most one native answer when two devices race', async () => {
    const { peer, interactions } = setup();
    const interaction = (await interactions.receive(command(), 'p'))!;
    const results = await Promise.allSettled([interactions.respond(approve(interaction), context), interactions.respond(approve(interaction), { ...context, deviceId: 'device-2' })]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(peer.respondRequest).toHaveBeenCalledExactlyOnceWith('native-1', { decision: 'accept' });
    expect(interactions.get(interaction.interactionId)?.status).toBe('submitted');
    interactions.resolve('native-1', 't'); expect(interactions.list('p')).toEqual([]);
  });
  it('rejects wrong project, expired epoch, stale generation and repeated answers without native calls', async () => {
    const { peer, interactions } = setup(), interaction = (await interactions.receive(command(), 'p'))!;
    await expect(interactions.respond(approve(interaction), { ...context, projectId: 'other' })).rejects.toMatchObject({ code: 'INTERACTION_FORBIDDEN' });
    await expect(interactions.respond({ ...approve(interaction), epoch: 'old' }, context)).rejects.toMatchObject({ code: 'INTERACTION_STALE' });
    await expect(interactions.respond({ ...approve(interaction), generation: 999 }, context)).rejects.toMatchObject({ code: 'INTERACTION_STALE' });
    interactions.clear();
    await expect(interactions.respond(approve(interaction), context)).rejects.toMatchObject({ code: 'INTERACTION_STALE' });
    expect(peer.respondRequest).not.toHaveBeenCalled();
  });
  it('keeps unknown delivery terminal for resubmission, and honors native resolution during write', async () => {
    const { peer, interactions } = setup(), interaction = (await interactions.receive(command(), 'p'))!;
    peer.respondRequest.mockRejectedValueOnce(new Error('input disconnected'));
    await expect(interactions.respond(approve(interaction), context)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(interactions.get(interaction.interactionId)?.status).toBe('unknown');
    await expect(interactions.respond(approve(interaction), context)).rejects.toMatchObject({ code: 'INTERACTION_ALREADY_RESOLVED' });
    expect(peer.respondRequest).toHaveBeenCalledTimes(1);
  });
  it('uses native RPC identity, not item ID, and distinguishes numeric from string IDs', async () => {
    const { interactions } = setup();
    const a = (await interactions.receive(command(1), 'p'))!, b = (await interactions.receive(command('1'), 'p'))!;
    expect(a.interactionId).not.toBe(b.interactionId); expect(interactions.list('p')).toHaveLength(2);
    interactions.resolve(1, 'wrong'); expect(interactions.list('p')).toHaveLength(2);
    interactions.resolve(1, 't'); expect(interactions.list('p')).toHaveLength(1);
  });
  it('fails closed for unknown types, unauthorized projects and new permission shapes', async () => {
    const { peer, interactions } = setup();
    expect(await interactions.receive({ ...command(), method: 'arbitrary/command' }, 'p')).toBeNull();
    expect(await interactions.receive(command(), null)).toBeNull();
    expect(await interactions.receive({ ...command(), method: 'item/permissions/requestApproval', params: { ...command().params, permissions: { fileSystem: { entries: [{ path: '/etc' }] } } } }, 'p')).toBeNull();
    expect(peer.rejectRequest).toHaveBeenCalledTimes(3); expect(peer.respondRequest).not.toHaveBeenCalled();
  });
  it('uses only the decisions advertised by the native request, including cancel-only rejection',async()=>{
    const {peer,interactions}=setup(), native=command();
    native.params.availableDecisions=['accept',{acceptWithExecpolicyAmendment:{execpolicy_amendment:['printf','fixture']}},'cancel'];
    const interaction=(await interactions.receive(native,'p'))!;
    await expect(interactions.respond({...approve(interaction),response:{type:'approval',decision:'decline'}},context)).rejects.toMatchObject({code:'INTERACTION_RESPONSE_INVALID'});
    expect(peer.respondRequest).not.toHaveBeenCalled();
    await interactions.respond({...approve(interaction),response:{type:'approval',decision:'cancel'}},context);
    expect(peer.respondRequest).toHaveBeenCalledExactlyOnceWith('native-1',{decision:'cancel'});
  });
  it('grants only the exact validated permission request for one turn', async () => {
    const { peer, interactions } = setup();
    const permissions = { network: { enabled: true }, fileSystem: { read: ['/project/input'], write: null } };
    const interaction = (await interactions.receive({ ...command(), method: 'item/permissions/requestApproval', params: { ...command().params, permissions } }, 'p'))!;
    await expect(interactions.respond({ ...approve(interaction), response: { type: 'approval', decision: 'accept', permissions: { fileSystem: { write: ['/'] } } } as never }, context)).rejects.toMatchObject({ code: 'INTERACTION_RESPONSE_INVALID' });
    await interactions.respond(approve(interaction), context);
    expect(peer.respondRequest).toHaveBeenCalledExactlyOnceWith('native-1', { permissions, scope: 'turn' });
  });
  it('accepts only native input question IDs and allowed choices', async () => {
    const { peer, interactions } = setup();
    const interaction = (await interactions.receive({ ...command(), method: 'item/tool/requestUserInput', params: { ...command().params, isBlocking: true,
      questions: [{ id: '__proto__', header: 'Pick', question: 'Choose', isOther: false, options: [{ label: 'A', description: 'Choice A' }] }] } }, 'p'))!;
    const input = (answers: Record<string, string[]>) => ({ ...approve(interaction), response: { type: 'input' as const, answers } });
    await expect(interactions.respond(input({ unknown: ['A'] }), context)).rejects.toMatchObject({ code: 'INTERACTION_RESPONSE_INVALID' });
    await expect(interactions.respond(input({ ['__proto__']: ['B'] }), context)).rejects.toMatchObject({ code: 'INTERACTION_RESPONSE_INVALID' });
    await interactions.respond(input({ ['__proto__']: ['A'] }), context);
    expect(peer.respondRequest.mock.calls[0][1].answers['__proto__']).toEqual({ answers: ['A'] });
    expect(Object.getPrototypeOf(peer.respondRequest.mock.calls[0][1].answers)).toBe(null);
  });
  it('validates elicitation form constraints and never accepts URL credentials', async () => {
    const { peer, interactions } = setup();
    const base = { threadId: 't', turnId: null, serverName: 'test', message: 'Test' };
    expect(await interactions.receive({ id: 1, method: 'mcpServer/elicitation/request', params: { ...base, mode: 'url', url: 'https://user:pass@example.com', elicitationId: 'x' } }, 'p')).toBeNull();
    const interaction = (await interactions.receive({ id: 2, method: 'mcpServer/elicitation/request', params: { ...base, mode: 'form', requestedSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 3 } }, required: ['count'] } } }, 'p'))!;
    const answer = (count: number) => ({ ...approve(interaction), response: { type: 'elicitation' as const, action: 'accept' as const, content: { count } } });
    await expect(interactions.respond(answer(9), context)).rejects.toMatchObject({ code: 'INTERACTION_RESPONSE_INVALID' });
    await interactions.respond(answer(2), context);
    expect(peer.respondRequest).toHaveBeenCalledExactlyOnceWith(2, { action: 'accept', content: { count: 2 }, _meta: null });
  });
});
