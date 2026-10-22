import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { BridgeService } from './service';
import type { ProjectDirectories } from './projects';
import type { Approval, BridgeEvent, Snapshot } from '../../packages/shared/protocol';
import { elicitationFields, validElicitationContent } from '../../packages/shared/elicitation';

const schema = { type: 'object', properties: {
  name: { type: 'string', minLength: 2, maxLength: 5 },
  count: { type: 'integer', minimum: 1, maximum: 3 },
  allowed: { type: 'boolean' },
  choice: { type: 'string', oneOf: [{ const: 'one', title: 'First' }, { const: 'two', title: 'Second' }] },
  tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1, maxItems: 2 },
}, required: ['name', 'count', 'allowed', 'choice', 'tags'] };
const goodContent = { name: 'name', count: 2, allowed: false, choice: 'one', tags: ['a'] };
const userInput = { id: 11, method: 'item/tool/requestUserInput', params: {
  threadId: 'thread-1', turnId: 'turn-1', itemId: 'input', isBlocking: true, autoResolutionMs: null,
  questions: [{ id: 'choice', header: 'Choice', question: 'Choose a path', isOther: false, isSecret: false,
    options: [{ label: 'Read', description: 'Read only' }, { label: 'Stop', description: 'Finish' }] }],
} };
const form = { id: 'mcp-form', method: 'mcpServer/elicitation/request', params: {
  threadId: 'thread-1', turnId: 'turn-1', serverName: 'configured-server', mode: 'form', message: 'Confirm details', _meta: null, requestedSchema: schema,
} };
const permission = { id: 'permission', method: 'item/permissions/requestApproval', params: {
  threadId: 'thread-1', turnId: 'turn-1', itemId: 'permissions', cwd: '/project', environmentId: null,
  startedAtMs: 1234, reason: 'Read external reference', permissions: { network: { enabled: true }, fileSystem: { read: ['/reference'], write: null } },
} };

function fixture(projects?: ProjectDirectories) {
  const native = Object.assign(new EventEmitter(), { send: vi.fn(), request: vi.fn(async (_method: string, _params: object): Promise<unknown> => ({})) });
  const service = new BridgeService({ on: native.on.bind(native), send: native.send,
    request: async <T>(method: string, params: object) => await native.request(method, params) as T }, '/project', undefined, projects);
  service.threads.add('thread-1'); service.threads.add('thread-2');
  const events: BridgeEvent[] = [];
  service.on('event', event => events.push(event));
  const answer = (id: string | number, extra: object) => service.dispatch('bridge/approve', {
    threadId: 'thread-1', requestId: id, bridgeToken: service.pending.get(id)?.bridgeToken, ...extra,
  });
  return { native, service, events, answer };
}

describe('native user input and permission responses', () => {
  it('routes the native question ID and permits only offered choices unless Other is allowed', async () => {
    const { native, answer, service } = fixture();
    native.emit('message', userInput);
    await expect(answer(11, { result: { answers: { injected: { answers: ['Read'] } } } })).rejects.toThrow('question');
    await expect(answer(11, { result: { answers: { choice: { answers: ['Write'] } } } })).rejects.toThrow('question');
    expect(service.pending.size).toBe(1);
    await answer(11, { result: { answers: { choice: { answers: ['Read'] } } } });
    expect(native.send).toHaveBeenCalledExactlyOnceWith({ id: 11, result: { answers: { choice: { answers: ['Read'] } } } });
  });
  it('supports secret/free text questions and a native empty-answer skip without fabricating consent', async () => {
    const { native, answer } = fixture();
    const request = structuredClone(userInput);
    request.params.questions[0]!.isOther = true;
    request.params.questions[0]!.isSecret = true;
    native.emit('message', request);
    await answer(11, { result: { answers: { choice: { answers: ['custom input'] } } } });
    native.emit('message', { ...request, id: 12 });
    await answer(12, { result: { answers: {} } });
    expect(native.send).toHaveBeenLastCalledWith({ id: 12, result: { answers: {} } });
  });
  it('derives permissions only from the native request and limits grants to the current turn', async () => {
    const { native, answer } = fixture();
    native.emit('message', permission);
    await answer(permission.id, { decision: 'accept', result: { permissions: { fileSystem: { write: ['/'] } }, scope: 'session' } });
    expect(native.send).toHaveBeenCalledExactlyOnceWith({ id: permission.id, result: { permissions: permission.params.permissions, scope: 'turn' } });
  });
  it.each(['decline', 'cancel'])('grants nothing on permission %s', async decision => {
    const { native, answer } = fixture();
    native.emit('message', permission);
    await answer(permission.id, { decision });
    expect(native.send).toHaveBeenCalledExactlyOnceWith({ id: permission.id, result: { permissions: {}, scope: 'turn' } });
  });
});

describe('MCP form, URL and App tool consent', () => {
  it('validates original form types, constraints and choices before accepting', async () => {
    const { native, answer } = fixture();
    native.emit('message', form);
    for (const content of [{ ...goodContent, count: 1.5 }, { ...goodContent, count: 4 }, { ...goodContent, tags: ['unknown'] },
      { ...goodContent, name: 'x' }, { ...goodContent, extra: true }, { ...goodContent, allowed: 'false' }]) {
      await expect(answer(form.id, { result: { action: 'accept', content } })).rejects.toThrow('schema');
    }
    expect(native.send).not.toHaveBeenCalled();
    await answer(form.id, { result: { action: 'accept', content: goodContent } });
    expect(native.send).toHaveBeenCalledExactlyOnceWith({ id: form.id, result: { action: 'accept', content: goodContent, _meta: null } });
  });
  it.each(['openai/form', 'openaiForm'])('supports %s App tool message-only consent without permanent authorization', async mode => {
    const { native, answer } = fixture();
    native.emit('message', { ...form, params: { ...form.params, mode, requestedSchema: null, _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] } } });
    await expect(answer(form.id, { result: { action: 'accept', content: null, _meta: { persist: 'always' } } })).rejects.toThrow('elicitation');
    await answer(form.id, { result: { action: 'accept', content: null } });
    expect(native.send).toHaveBeenCalledExactlyOnceWith({ id: form.id, result: { action: 'accept', content: null, _meta: null } });
  });
  it('lets unsupported schema requests be explicitly declined and never accepts a weakened form', async () => {
    const { native, answer } = fixture();
    native.emit('message', { ...form, params: { ...form.params, mode: 'openai/form', requestedSchema: {
      type: 'object', properties: { nested: { type: 'object', properties: {} } }, required: ['nested'],
    } } });
    await expect(answer(form.id, { result: { action: 'accept', content: { nested: {} } } })).rejects.toThrow('schema');
    await answer(form.id, { result: { action: 'decline', content: null } });
    expect(native.send).toHaveBeenCalledExactlyOnceWith({ id: form.id, result: { action: 'decline', content: null, _meta: null } });
  });
  it('permits URL confirmation without credentials or arbitrary form content', async () => {
    const { native, answer } = fixture();
    native.emit('message', { ...form, params: { ...form.params, mode: 'url', url: 'https://example.test/authorize', elicitationId: 'oauth', turnId: null } });
    await expect(answer(form.id, { result: { action: 'accept', content: { token: 'renderer-token' } } })).rejects.toThrow('cannot include');
    await answer(form.id, { result: { action: 'accept', content: null } });
    expect(native.send).toHaveBeenCalledExactlyOnceWith({ id: form.id, result: { action: 'accept', content: null, _meta: null } });
  });
  it.each(['javascript:alert(1)', 'https://user:password@example.test'])('does not forward unsafe elicitation URL %s', url => {
    const { native, service } = fixture();
    native.emit('message', { ...form, params: { ...form.params, mode: 'url', url, elicitationId: 'oauth' } });
    expect(service.pending.size).toBe(0);
    expect(native.send).toHaveBeenCalledWith({ id: form.id, error: expect.objectContaining({ code: -32601 }) });
  });
});

describe('native request identity, expiration and recovery', () => {
  it('cannot answer from another thread or resolve another thread request', async () => {
    const { native, service, answer } = fixture();
    native.emit('message', userInput);
    await expect(answer(11, { threadId: 'thread-2', result: { answers: {} } })).rejects.toThrow('no longer');
    native.emit('message', { method: 'serverRequest/resolved', params: { threadId: 'thread-2', requestId: 11 } });
    expect(service.pending.size).toBe(1);
    native.emit('message', { method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 11 } });
    await expect(answer(11, { result: { answers: {} } })).rejects.toThrow('no longer');
    expect(native.send).not.toHaveBeenCalled();
  });
  it('synchronizes an answered request to both clients and rejects concurrent second answers', async () => {
    const { native, service, events, answer } = fixture();
    native.emit('message', form);
    const bridgeToken = service.pending.get(form.id)!.bridgeToken;
    const replies = await Promise.allSettled([
      answer(form.id, { result: { action: 'accept', content: goodContent }, bridgeToken }),
      answer(form.id, { result: { action: 'decline', content: null }, bridgeToken }),
    ]);
    expect(replies.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(native.send).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ type: 'requestAnswered', requestId: form.id, bridgeToken });
  });
  it('retains the token on native retransmission and rejects a reused ID after restart', async () => {
    const { native, service, answer } = fixture();
    native.emit('message', form);
    const bridgeToken = service.pending.get(form.id)!.bridgeToken;
    native.emit('message', form);
    expect(service.pending.get(form.id)!.bridgeToken).toBe(bridgeToken);
    native.emit('unavailable', 'App Server stopped');
    expect(service.pending.size).toBe(0);
    native.emit('message', form);
    await expect(answer(form.id, { bridgeToken, result: { action: 'decline', content: null } })).rejects.toThrow('expired');
  });
  it('expires turn-associated prompts while retaining standalone MCP URL requests', async () => {
    const { native, service, answer } = fixture();
    native.emit('message', userInput);
    native.emit('message', { ...form, params: { ...form.params, turnId: null } });
    native.emit('message', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await expect(answer(11, { result: { answers: {} } })).rejects.toThrow('no longer');
    expect(service.pending.has(form.id)).toBe(true);
  });
  it('restores only the selected thread pending requests in a reconnect snapshot', async () => {
    const { native, service } = fixture();
    native.request.mockImplementation(async method => method === 'thread/turns/list' ? { data: [], nextCursor: null } : {
      thread: { id: 'thread-1', cwd: '/project', status: { type: 'idle' }, turns: [] },
    });
    native.emit('message', userInput);
    native.emit('message', { ...form, params: { ...form.params, threadId: 'thread-2' } });
    const snapshot = await service.dispatch('bridge/subscribe', { threadId: 'thread-1' }) as Snapshot;
    expect(snapshot.pending).toEqual([service.pending.get(11)]);
  });
  it('rechecks the project for affirmative responses but still permits cancellation when it disappears', async () => {
    const resolve = vi.fn(async () => { throw new Error('Project unavailable'); });
    const { native, answer } = fixture({ resolve } as unknown as ProjectDirectories);
    native.emit('message', permission);
    await expect(answer(permission.id, { decision: 'accept' })).rejects.toThrow('unavailable');
    await answer(permission.id, { decision: 'decline' });
    expect(native.send).toHaveBeenCalledExactlyOnceWith({ id: permission.id, result: { permissions: {}, scope: 'turn' } });
  });
  it('does not forward requests from unowned threads or execute unsupported client tools', () => {
    const { native, service } = fixture();
    native.emit('message', { ...form, params: { ...form.params, threadId: 'private' } });
    native.emit('message', { id: 90, method: 'item/tool/call', params: { threadId: 'thread-1' } });
    expect(service.pending.size).toBe(0);
    expect(native.send).toHaveBeenCalledTimes(2);
  });
});

describe('native child request ownership', () => {
  const started = (id: string, parentThreadId: string, cwd = '/project') => ({
    method: 'thread/started', params: { thread: { id, parentThreadId, cwd } },
  });
  it('routes same-project nested child prompts to the root while preserving raw native identity', async () => {
    const { native, service, events, answer } = fixture();
    native.emit('message', started('child', 'thread-1'));
    native.emit('message', started('grandchild', 'child'));
    native.emit('message', { ...form, params: { ...form.params, threadId: 'grandchild' } });
    const request = service.pending.get(form.id)!;
    expect(request.params.threadId).toBe('grandchild');
    expect(request.displayThreadIds).toEqual(['child', 'thread-1']);
    expect(events).toContainEqual({ type: 'approval', request });
    await expect(answer(form.id, { result: { action: 'decline', content: null } })).rejects.toThrow('no longer');
    await answer(form.id, { threadId: 'grandchild', result: { action: 'decline', content: null } });
    expect(native.send).toHaveBeenCalledExactlyOnceWith({ id: form.id, result: { action: 'decline', content: null, _meta: null } });
    await expect(answer(form.id, { threadId: 'grandchild', bridgeToken: request.bridgeToken, result: { action: 'decline', content: null } })).rejects.toThrow('no longer');
  });
  it.each([
    ['unknown-parent', '/project'], ['thread-1', '/different-project'],
  ])('does not authorize a native child of %s with cwd %s', (parent, cwd) => {
    const { native, service } = fixture();
    native.emit('message', started('child', parent, cwd));
    native.emit('message', { ...form, params: { ...form.params, threadId: 'child' } });
    expect(service.threads.has('child')).toBe(false);
    expect(service.pending.size).toBe(0);
    expect(native.send).toHaveBeenCalledWith({ id: form.id, error: expect.objectContaining({ code: -32601 }) });
  });
  it('does not reparent a known child or create a native ancestry cycle', () => {
    const { native, service } = fixture();
    native.emit('message', started('child', 'thread-1'));
    native.emit('message', started('child', 'thread-2'));
    native.emit('message', started('thread-1', 'child'));
    native.emit('message', { ...form, params: { ...form.params, threadId: 'child' } });
    expect(service.pending.get(form.id)?.displayThreadIds).toEqual(['thread-1']);
  });
  it('makes unsupported child interactions visible to verified ancestors without authorizing them', () => {
    const { native, service, events } = fixture();
    native.emit('message', started('child', 'thread-1'));
    native.emit('message', started('grandchild', 'child'));
    native.emit('message', { id: 90, method: 'item/tool/call', params: { threadId: 'grandchild' } });
    expect(service.pending.size).toBe(0);
    expect(events).toContainEqual({ type: 'notice', threadId: 'grandchild', displayThreadIds: ['child', 'thread-1'], message: expect.stringContaining('item/tool/call') });
    expect(native.send).toHaveBeenCalledWith({ id: 90, error: expect.objectContaining({ code: -32601 }) });
  });
  it('includes descendants on ancestor reconnect without leaking another owned root prompts', async () => {
    const { native, service } = fixture();
    native.request.mockImplementation(async (method, params) => method === 'thread/turns/list' ? { data: [], nextCursor: null } : {
      thread: { id: (params as { threadId: string }).threadId, cwd: '/project', status: { type: 'idle' }, turns: [] },
    });
    native.emit('message', started('child', 'thread-1'));
    native.emit('message', started('grandchild', 'child'));
    native.emit('message', started('other-child', 'thread-2'));
    native.emit('message', { ...form, params: { ...form.params, threadId: 'grandchild' } });
    native.emit('message', { ...permission, params: { ...permission.params, threadId: 'other-child' } });
    for (const threadId of ['thread-1', 'child']) {
      const snapshot = await service.dispatch('bridge/subscribe', { threadId }) as Snapshot;
      expect(snapshot.pending.map(request => request.id)).toEqual([form.id]);
      expect(snapshot.pending[0]?.params.threadId).toBe('grandchild');
    }
    const other = await service.dispatch('bridge/subscribe', { threadId: 'thread-2' }) as Snapshot;
    expect(other.pending.map(request => request.id)).toEqual([permission.id]);
  });
  it.each(['resolved', 'completed'])('expires a child prompt on native %s and tells the ancestor UI with its token', async cause => {
    const { native, service, events, answer } = fixture();
    native.emit('message', started('child', 'thread-1'));
    native.emit('message', { ...userInput, params: { ...userInput.params, threadId: 'child' } });
    const request = service.pending.get(userInput.id)!;
    native.emit('message', cause === 'resolved'
      ? { method: 'serverRequest/resolved', params: { threadId: 'child', requestId: userInput.id } }
      : { method: 'turn/completed', params: { threadId: 'child', turn: { id: 'turn-1', status: 'completed' } } });
    expect(events).toContainEqual({ type: 'requestAnswered', requestId: userInput.id, bridgeToken: request.bridgeToken });
    await expect(answer(userInput.id, { threadId: 'child', bridgeToken: request.bridgeToken, result: { answers: {} } })).rejects.toThrow('no longer');
    expect(native.send).not.toHaveBeenCalled();
  });
});

describe('shared primitive elicitation schema', () => {
  it('normalizes enum labels/defaults and rejects constraints the renderer cannot enforce', () => {
    expect(elicitationFields(schema)?.find(field => field.id === 'choice')?.options?.[0]).toEqual({ value: 'one', label: 'First' });
    expect(validElicitationContent(schema, goodContent)).toBe(true);
    expect(elicitationFields({ type: 'object', properties: { field: { type: 'string', pattern: '^admin$' } } })).toBeNull();
    expect(elicitationFields({ type: 'object', properties: {}, required: ['missing'] })).toBeNull();
    expect(elicitationFields({ type: 'object', properties: { field: { type: 'boolean', default: 'true' } } })).toBeNull();
  });
  it('validates string formats and Unicode length without coercing types', () => {
    const one = (format: string) => ({ type: 'object', properties: { value: { type: 'string', format } }, required: ['value'] });
    expect(validElicitationContent(one('date'), { value: '2026-02-30' })).toBe(false);
    expect(validElicitationContent(one('email'), { value: 'valid@example.test' })).toBe(true);
    expect(validElicitationContent(one('uri'), { value: '/relative' })).toBe(false);
    expect(validElicitationContent({ type: 'object', properties: { value: { type: 'string', maxLength: 1 } } }, { value: '😀' })).toBe(true);
  });
});
