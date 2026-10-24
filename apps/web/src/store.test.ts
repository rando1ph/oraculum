import { beforeEach, expect, it } from 'vitest';
import { itemKey, useSession } from './store';
import type { Thread, ThreadItem, Turn, ServerNotification, Approval } from '../../../packages/shared/protocol';
const emit = (method: string, params: object) => useSession.getState().event({ method, params } as ServerNotification);
const item = { type: 'agentMessage', id: 'i', text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
const turn = (id: string, items: ThreadItem[] = [], status: Turn['status'] = 'completed'): Turn => ({
  id, items, status, itemsView: 'full', error: null, startedAt: null, completedAt: null, durationMs: null,
});
const snapshot = (turns: Turn[]) => ({ thread: { id: 't', turns } as Thread, pending: [] });
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

it('streams native reasoning sections without inventing items or treating raw content as a summary', () => {
  const reasoning: ThreadItem = { type: 'reasoning', id: 'reason', summary: [], content: [] };
  emit('item/reasoning/summaryTextDelta', { threadId: 't', turnId: 'u', itemId: 'missing', summaryIndex: 0, delta: 'not observed' });
  expect(Object.values(useSession.getState().items)).toEqual([]);
  emit('item/started', { threadId: 't', turnId: 'u', item: reasoning });
  emit('item/reasoning/summaryPartAdded', { threadId: 't', turnId: 'u', itemId: 'reason', summaryIndex: 0 });
  emit('item/reasoning/summaryTextDelta', { threadId: 't', turnId: 'u', itemId: 'reason', summaryIndex: 0, delta: 'Inspect ' });
  emit('item/reasoning/summaryPartAdded', { threadId: 't', turnId: 'u', itemId: 'reason', summaryIndex: 0 });
  emit('item/reasoning/summaryTextDelta', { threadId: 't', turnId: 'u', itemId: 'reason', summaryIndex: 0, delta: 'files' });
  emit('item/reasoning/summaryTextDelta', { threadId: 't', turnId: 'u', itemId: 'reason', summaryIndex: 1, delta: 'Run checks' });
  emit('item/reasoning/textDelta', { threadId: 't', turnId: 'u', itemId: 'reason', contentIndex: 0, delta: 'native content' });
  expect(useSession.getState().items[itemKey('u', 'reason')].item).toMatchObject({ summary: ['Inspect files', 'Run checks'], content: ['native content'] });
  emit('item/completed', { threadId: 't', turnId: 'u', item: { ...reasoning, summary: ['Authoritative summary'] } });
  emit('item/reasoning/summaryTextDelta', { threadId: 't', turnId: 'u', itemId: 'reason', summaryIndex: 0, delta: 'late' });
  expect(useSession.getState().items[itemKey('u', 'reason')].item).toMatchObject({ summary: ['Authoritative summary'] });
});

it('keeps streamed plan text authoritative at completion and scopes plan updates to their turn and arrival anchor', () => {
  emit('turn/started', { threadId: 't', turn: turn('u', [], 'inProgress') });
  emit('item/started', { threadId: 't', turnId: 'u', item: { type: 'plan', id: 'plan', text: '' } });
  emit('item/plan/delta', { threadId: 't', turnId: 'u', itemId: 'plan', delta: 'Draft' });
  expect(useSession.getState().items[itemKey('u', 'plan')].item).toMatchObject({ text: 'Draft' });
  emit('item/completed', { threadId: 't', turnId: 'u', item: { type: 'plan', id: 'plan', text: 'Final plan' } });
  emit('item/plan/delta', { threadId: 't', turnId: 'u', itemId: 'plan', delta: 'late' });
  emit('turn/plan/updated', { threadId: 't', turnId: 'u', explanation: 'Verify', plan: [{ step: 'Checks', status: 'inProgress' }] });
  expect(useSession.getState().plans.u).toBe('Verify\ninProgress · Checks');
  expect(useSession.getState().planAfter.u).toBe('plan');
  expect(useSession.getState().items[itemKey('u', 'plan')].item).toMatchObject({ text: 'Final plan' });
  emit('turn/started', { threadId: 't', turn: turn('v', [], 'inProgress') });
  expect(useSession.getState().plan).toBe('');
  emit('turn/plan/updated', { threadId: 't', turnId: 'v', explanation: null, plan: [{ step: 'Second', status: 'pending' }] });
  expect(useSession.getState().plans).toEqual({ u: 'Verify\ninProgress · Checks', v: 'pending · Second' });
  expect(useSession.getState().planAfter.v).toBeUndefined();
});

it('retains actual MCP progress through completion and snapshots without replaying buffered progress', () => {
  const mcp: Extract<ThreadItem, { type: 'mcpToolCall' }> = { type: 'mcpToolCall', id: 'mcp', server: 'test', tool: 'read', status: 'inProgress', arguments: {}, appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null };
  emit('item/started', { threadId: 't', turnId: 'u', item: mcp });
  const progress: ServerNotification = { method: 'item/mcpToolCall/progress', params: { threadId: 't', turnId: 'u', itemId: 'mcp', message: 'Reading page 1' } };
  useSession.getState().event(progress);
  useSession.getState().event(progress, true);
  const completed: typeof mcp = { ...mcp, status: 'completed', result: { content: [{ type: 'text', text: 'done' }], structuredContent: null, _meta: null } };
  emit('item/completed', { threadId: 't', turnId: 'u', item: completed });
  useSession.getState().event(progress);
  useSession.getState().snapshot(snapshot([turn('u', [completed])]));
  expect(useSession.getState().items[itemKey('u', 'mcp')]).toMatchObject({ progress: ['Reading page 1'], item: { status: 'completed', result: completed.result } });
});

it('replaces file patches from native patch updates and rejects late changes after completion', () => {
  const file: ThreadItem = { type: 'fileChange', id: 'file', status: 'inProgress', changes: [] };
  const changes = [{ path: '/tmp/native.txt', kind: { type: 'add' }, diff: '+hello' }];
  emit('item/started', { threadId: 't', turnId: 'u', item: file });
  emit('item/fileChange/patchUpdated', { threadId: 't', turnId: 'u', itemId: 'file', changes });
  expect(useSession.getState().items[itemKey('u', 'file')].item).toMatchObject({ changes });
  emit('item/completed', { threadId: 't', turnId: 'u', item: { ...file, changes, status: 'completed' } });
  emit('item/fileChange/patchUpdated', { threadId: 't', turnId: 'u', itemId: 'file', changes: [] });
  expect(useSession.getState().items[itemKey('u', 'file')].item).toMatchObject({ changes, status: 'completed' });
});

it('uses native snapshot order while retaining observed-only items beside surviving native anchors', () => {
  const message = (id: string) => ({ ...item, type: 'agentMessage' as const, id });
  for (const id of ['a', 'live-only', 'c']) emit('item/completed', { threadId: 't', turnId: 'u', item: message(id) });
  useSession.getState().snapshot(snapshot([turn('u', ['a', 'b', 'c'].map(message))]));
  expect(Object.values(useSession.getState().items).map(view => view.item.id)).toEqual(['a', 'b', 'live-only', 'c']);
  expect(useSession.getState().items[itemKey('u', 'live-only')].source).toBe('live');
  useSession.getState().older(snapshot([turn('older', [message('older')])]));
  expect(Object.values(useSession.getState().items).map(view => view.item.id)).toEqual(['older', 'a', 'b', 'live-only', 'c']);
  expect(Object.keys(useSession.getState().turns)).toEqual(['older', 'u']);
  useSession.getState().snapshot(snapshot([turn('u', ['a', 'b', 'c'].map(message))]));
  expect(Object.values(useSession.getState().items).map(view => view.item.id)).toEqual(['older', 'a', 'b', 'live-only', 'c']);
});

it('preserves known native timing through sparse completion, snapshots and stale starts', () => {
  emit('turn/started', { threadId: 't', turn: { ...turn('u', [], 'inProgress'), startedAt: 100 } });
  emit('turn/completed', { threadId: 't', turn: { ...turn('u'), completedAt: 170, durationMs: 69_550 } });
  useSession.getState().snapshot(snapshot([turn('u')]));
  expect(useSession.getState().turns.u).toMatchObject({ startedAt: 100, completedAt: 170, durationMs: 69_550, status: 'completed' });
  emit('turn/started', { threadId: 't', turn: turn('v', [], 'inProgress') });
  emit('turn/started', { threadId: 't', turn: turn('u', [], 'inProgress') });
  expect(useSession.getState().activeTurn).toBe('v');
  expect(useSession.getState().lastTurnId).toBe('v');
  expect(useSession.getState().turns.u.status).toBe('completed');
});

it('does not let queued starts or deltas erase a native snapshot and does not append after terminal turns', () => {
  const current = { ...item, type: 'agentMessage' as const, text: 'native accumulated text' };
  useSession.getState().snapshot(snapshot([turn('u', [current], 'inProgress')]));
  useSession.getState().event({ method: 'item/started', params: { threadId: 't', turnId: 'u', item: { ...current, text: '' }, startedAtMs: 100_000 } }, true);
  useSession.getState().event({ method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'u', itemId: 'i', delta: 'duplicate' } }, true);
  expect(useSession.getState().items[itemKey('u', 'i')].item).toMatchObject({ text: 'native accumulated text' });
  emit('turn/completed', { threadId: 't', turn: turn('u') });
  emit('item/agentMessage/delta', { threadId: 't', turnId: 'u', itemId: 'i', delta: 'late' });
  expect(useSession.getState().items[itemKey('u', 'i')].item).toMatchObject({ text: 'native accumulated text' });
});

it('accepts real items carried only by a Turn and preserves authoritative completed items and empty-payload records', () => {
  const confirmed: ThreadItem = { ...item, type: 'agentMessage', id: 'confirmed', phase: 'commentary', text: 'Authoritative progress' };
  const final: ThreadItem = { ...item, type: 'agentMessage', id: 'final', phase: 'final_answer', text: 'Turn-only final answer' };
  const command = { type: 'commandExecution', id: 'command', command: 'pwd', cwd: '/tmp', status: 'completed', aggregatedOutput: '/tmp', exitCode: 0, durationMs: 12 } as ThreadItem;
  emit('turn/started', { threadId: 't', turn: turn('u', [], 'inProgress') });
  emit('item/completed', { threadId: 't', turnId: 'u', item: confirmed });
  emit('item/started', { threadId: 't', turnId: 'u', item: { ...final, text: '' } });
  emit('turn/completed', { threadId: 't', turn: turn('u', [{ ...confirmed, text: 'stale text' }, command, final]) });
  expect(Object.values(useSession.getState().items).map(view => view.item.id)).toEqual(['confirmed', 'command', 'final']);
  expect(useSession.getState().items[itemKey('u', 'confirmed')].item).toEqual(confirmed);
  expect(useSession.getState().items[itemKey('u', 'final')]).toMatchObject({ item: final, complete: true });
  expect(useSession.getState().items[itemKey('u', 'command')]).toMatchObject({ item: command, complete: true });
  emit('turn/completed', { threadId: 't', turn: turn('u') });
  expect(Object.values(useSession.getState().items).map(view => view.item.id)).toEqual(['confirmed', 'command', 'final']);
});

it('merges overlapping older pages in native order without replacing newer observed item data', () => {
  const message = (id: string, text = id): ThreadItem => ({ ...item, type: 'agentMessage', id, text });
  useSession.getState().snapshot(snapshot([turn('new', [message('new')])]));
  emit('item/completed', { threadId: 't', turnId: 'new', item: message('new', 'Confirmed newest content') });
  useSession.getState().older(snapshot([turn('old', [message('old')]), turn('new', [message('new', 'older page content')])]));
  expect(Object.keys(useSession.getState().turns)).toEqual(['old', 'new']);
  expect(Object.values(useSession.getState().items).map(view => view.item.id)).toEqual(['old', 'new']);
  expect(useSession.getState().items[itemKey('new', 'new')].item).toMatchObject({ text: 'Confirmed newest content' });
});

it('does not fabricate completion timing when native completion and later history omit it', () => {
  emit('turn/started', { threadId: 't', turn: { ...turn('u', [], 'inProgress'), startedAt: 100 } });
  emit('turn/completed', { threadId: 't', turn: turn('u') });
  useSession.getState().snapshot(snapshot([turn('u')]));
  expect(useSession.getState().turns.u).toMatchObject({ startedAt: 100, completedAt: null, durationMs: null, status: 'completed' });
});

it('does not promote a retained old in-progress turn to current when absent from a fresh native page', () => {
  useSession.getState().snapshot(snapshot([turn('old', [], 'inProgress')]));
  useSession.getState().snapshot(snapshot([turn('new')]));
  expect(useSession.getState().activeTurn).toBeUndefined();
  expect(useSession.getState().lastTurnId).toBe('new');
});
