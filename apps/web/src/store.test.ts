import { beforeEach, expect, it } from 'vitest';
import { itemKey, useSession } from './store';
import type { Thread, ServerNotification, Approval } from '../../../packages/shared/protocol';
const emit = (method: string, params: object) => useSession.getState().event({ method, params } as ServerNotification);
const item = { type: 'agentMessage', id: 'i', text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
beforeEach(() => { useSession.getState().reset(); useSession.setState({ thread: { id: 't', turns: [] } as unknown as Thread }); });
it('deduplicates by turn/item and ignores other threads and late deltas after completion', () => {
  emit('item/started', { threadId: 't', turnId: 'u', item });
  emit('item/agentMessage/delta', { threadId: 't', turnId: 'u', itemId: 'i', delta: 'hello' });
  emit('item/completed', { threadId: 't', turnId: 'u', item: { ...item, text: 'hello world' } });
  emit('item/completed', { threadId: 't', turnId: 'u', item: { ...item, text: 'hello world' } });
  emit('item/agentMessage/delta', { threadId: 'other', turnId: 'u', itemId: 'i', delta: 'unrelated' });
  emit('item/agentMessage/delta', { threadId: 't', turnId: 'u', itemId: 'i', delta: 'late' });
  expect(Object.keys(useSession.getState().items)).toEqual([itemKey('u', 'i')]);
  expect(useSession.getState().items[itemKey('u', 'i')].item).toMatchObject({ text: 'hello world' });
  emit('item/started', { threadId: 't', turnId: 'v', item });
  expect(Object.keys(useSession.getState().items)).toHaveLength(2);
});
it('does not clear another active turn on late completion and exposes native failed state', () => {
  emit('turn/started', { threadId: 't', turn: { id: 'new', status: 'inProgress' } });
  emit('turn/completed', { threadId: 't', turn: { id: 'old', status: 'interrupted' } });
  expect(useSession.getState().activeTurn).toBe('new');
  expect(useSession.getState().lastTurnId).toBe('new');
  emit('turn/completed', { threadId: 't', turn: { id: 'new', status: 'failed', error: { message: 'provider error' } } });
  expect(useSession.getState().activeTurn).toBeUndefined();
  expect(useSession.getState().lastTurnId).toBe('new');
  expect(useSession.getState().turns.new).toMatchObject({ status: 'failed', error: { message: 'provider error' } });
});
it('keeps observed-only items labelled live until selection changes', () => {
  emit('item/completed', { threadId: 't', turnId: 'u', item });
  useSession.getState().snapshot({ thread: { id: 't', turns: [] } as unknown as Thread, pending: [] });
  expect(useSession.getState().items[itemKey('u', 'i')].source).toBe('live');
  useSession.getState().snapshot({ thread: { id: 'other', turns: [] } as unknown as Thread, pending: [] });
  expect(useSession.getState().items).toEqual({});
});
it('does not replay overlapping deltas during a snapshot', () => {
  emit('item/started', { threadId: 't', turnId: 'u', item: { ...item, text: 'hello' } });
  useSession.getState().event({ method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'u', itemId: 'i', delta: 'hello' } }, true);
  expect(useSession.getState().items[itemKey('u', 'i')].item).toMatchObject({ text: 'hello' });
});
it('does not unlock an unknown send when an unrelated native turn completes', () => {
  useSession.setState({ sendBlocked: true });
  emit('turn/completed', { threadId: 't', turn: { id: 'unrelated', status: 'completed' } });
  expect(useSession.getState().sendBlocked).toBe(true);
});
it('keeps standalone MCP requests across unrelated turn completion and restores them from snapshots', () => {
  const pending = { id: 8, bridgeToken: 'current', method: 'mcpServer/elicitation/request', params: { threadId: 't', turnId: null, serverName: 'fixture', mode: 'form', _meta: null, message: 'consent', requestedSchema: { type: 'object', properties: {} } } } satisfies Approval;
  useSession.getState().approval(pending);
  emit('turn/completed', { threadId: 't', turn: { id: 'u', status: 'completed' } });
  expect(useSession.getState().pending).toEqual([pending]);
  useSession.getState().snapshot({ thread: { id: 't', turns: [] } as unknown as Thread, pending: [pending] });
  expect(useSession.getState().pending).toEqual([pending]);
  emit('serverRequest/resolved', { threadId: 'other', requestId: 8 });
  expect(useSession.getState().pending).toEqual([pending]);
  emit('serverRequest/resolved', { threadId: 't', requestId: 8 });
  expect(useSession.getState().pending).toEqual([]);
});
it('projects a child request into its Bridge-verified parent without changing native thread identity', () => {
  const request = { id: 'child-request', bridgeToken: 'child-token', displayThreadIds: ['t'], method: 'item/tool/requestUserInput', params: { threadId: 'child', turnId: 'child-turn', itemId: 'input', isBlocking: true, autoResolutionMs: null, questions: [] } } satisfies Approval;
  useSession.getState().approval(request);
  expect(useSession.getState().pending).toEqual([request]);
  useSession.getState().snapshot({ thread: { id: 't', turns: [] } as unknown as Thread, pending: [request] });
  expect(useSession.getState().pending[0].params.threadId).toBe('child');
  useSession.getState().approval({ ...request, id: 'unrelated', displayThreadIds: ['other'] });
  expect(useSession.getState().pending).toHaveLength(1);
});
it('shows a live nested request in any verified ancestor or its own thread', () => {
  const request = { id: 'nested-request', bridgeToken: 'nested-token', displayThreadIds: ['child', 't'], method: 'item/tool/requestUserInput', params: { threadId: 'grandchild', turnId: 'child-turn', itemId: 'input', isBlocking: true, autoResolutionMs: null, questions: [] } } satisfies Approval;
  for (const threadId of ['t', 'child', 'grandchild']) {
    useSession.getState().snapshot({ thread: { id: threadId, turns: [] } as unknown as Thread, pending: [] });
    useSession.getState().approval(request);
    expect(useSession.getState().pending).toEqual([request]);
  }
  useSession.getState().snapshot({ thread: { id: 'unrelated', turns: [] } as unknown as Thread, pending: [] });
  useSession.getState().approval(request);
  expect(useSession.getState().pending).toEqual([]);
});
it('updates effective settings only from the selected native thread and restores them after reconnect', () => {
  const initial = { model: 'model-one', effort: 'low', approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user' } as const;
  const fullAccess = { model: 'model-two', effort: 'high', approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' }, approvalsReviewer: 'user' } as const;
  useSession.getState().snapshot({ thread: { id: 't', turns: [] } as unknown as Thread, pending: [], settings: initial });
  emit('thread/settings/updated', { threadId: 'other', threadSettings: { ...fullAccess, sandboxPolicy: fullAccess.sandbox } });
  expect(useSession.getState().settings).toEqual(initial);
  emit('thread/settings/updated', { threadId: 't', threadSettings: { ...fullAccess, sandboxPolicy: fullAccess.sandbox } });
  expect(useSession.getState().settings).toEqual(fullAccess);
  emit('thread/settings/updated', { threadId: 't', threadSettings: { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: fullAccess.sandbox } });
  expect(useSession.getState().settings).toEqual(fullAccess);
  useSession.getState().reset();
  useSession.getState().snapshot({ thread: { id: 't', turns: [] } as unknown as Thread, pending: [], settings: fullAccess });
  expect(useSession.getState().settings).toEqual(fullAccess);
  useSession.getState().snapshot({ thread: { id: 'new', turns: [] } as unknown as Thread, pending: [] });
  expect(useSession.getState().settings).toBeUndefined();
});
