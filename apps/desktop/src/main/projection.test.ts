import { describe, expect, it } from 'vitest';
import { Projection } from './projection';

const installation = '11111111-1111-4111-8111-111111111111';
const epoch = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const project = '44444444-4444-4444-8444-444444444444';
const interactionId = '55555555-5555-4555-8555-555555555555';
const operationId = '66666666-6666-4666-8666-666666666666';
const thread = 'thread-1', turn = 'turn-1', itemId = 'item-1';
const scope = { projectId: project, threadId: thread, turnId: turn, itemId };
const nativeItem = (text = 'baseline') => ({ id: itemId, type: 'agentMessage', text });
const nativeTurn = (id = turn, text = 'baseline', status = 'completed') => ({ id, status, items: [nativeItem(text)] });
const history = (items: unknown[] = [nativeTurn()], revision = 'opaque-r1', cursor: string | null = null) => ({
  epoch, historyRevision: revision, source: 'native-pagination', items, nextCursor: cursor, complete: true, truncated: false,
});
const snapshot = (items: unknown[] = [nativeTurn()], revision = 'opaque-r1') => ({
  epoch, thread: { id: thread, projectId: project, status: 'idle' }, history: history(items, revision),
  interactions: [], operations: [], observedStartSeq: 0, observedEndSeq: 0, synchronization: 'current',
});
const event = (seq: number, kind: string, payload: unknown, eventScope: object = scope) => ({ installationId: installation, epoch, seq, kind, impact: 'state', scope: eventScope, payload });
const itemEvent = (seq: number, kind: 'item.started' | 'item.completed', text: string, complete = true) => event(seq, kind, {
  item: { id: itemId, type: 'agentMessage', data: nativeItem(text), truncated: !complete }, complete,
});
const delta = (seq: number, text: string) => event(seq, 'item.delta', { delta: text, nativeMethod: 'item/agentMessage/delta' });
const interaction = (status = 'pending', generation = 1) => ({ interactionId, projectId: project, threadId: thread, turnId: turn, epoch,
  generation, kind: 'command', status, request: { threadId: thread, turnId: turn, itemId, command: 'pwd' } });
const stateEvent = (seq: number, method: string, data: object, eventScope: object = { projectId: project, threadId: thread, turnId: turn }) => event(seq, 'native.state', {
  method, data: { threadId: thread, ...data }, truncated: false,
}, eventScope);
function setup(): Projection {
  const projection = new Projection(); projection.initialize(installation, epoch, project, thread); return projection;
}
function renderedText(projection: Projection): unknown {
  const view = projection.view();
  return (view.history?.items[0] as { items: { text?: string }[] } | undefined)?.items[0]?.text ?? view.streamItems[0]?.item.text;
}

describe('Desktop Projection event continuity and identity', () => {
  it('ignores duplicates and requests reconnect on gaps without consuming the missing sequence', () => {
    const p = setup();
    p.applyEvent(itemEvent(1, 'item.started', 'a'));
    p.applyEvent(delta(2, 'b'));
    p.applyEvent(delta(2, 'b'));
    expect(renderedText(p)).toBe('ab');
    expect(p.seq).toBe(2);
    expect(p.applyEvent(delta(4, 'wrong'))).toEqual({ resynchronize: true, reconnect: true });
    expect(p.seq).toBe(2);
    expect(p.view().synchronization).toBe('stale');
  });
  it.each([{ installationId: other }, { epoch: other }, { seq: 0 }, { seq: 1.5 }])('rejects wrong identity or sequence %j', patch => {
    const p = setup(); p.applySnapshot(snapshot());
    expect(p.applyEvent({ ...delta(1, 'x'), ...patch })).toEqual({ resynchronize: true, reconnect: true });
    expect(p.seq).toBe(0); expect(renderedText(p)).toBe('baseline');
  });
  it('consumes another authorized scope without changing this selection', () => {
    const p = setup(); p.applySnapshot(snapshot()); const before = p.ticket();
    expect(p.applyEvent(event(1, 'item.completed', { nonsense: true }, { projectId: other, threadId: 'elsewhere' }))).toEqual({ resynchronize: false });
    expect(p.seq).toBe(1); expect(p.ticket()).toEqual(before); expect(p.view().synchronization).toBe('current');
  });
  it('invalidates unknown state, skips unknown informational events, and rejects malformed known payloads', () => {
    const p = setup(); p.applySnapshot(snapshot());
    expect(p.applyEvent({ ...event(1, 'future.status', {}), impact: 'informational' }).resynchronize).toBe(false);
    expect(p.applyEvent(event(2, 'future.mutation', {})).resynchronize).toBe(true);
    expect(p.seq).toBe(2); expect(p.view().synchronization).toBe('stale');
    expect(p.applyEvent(event(3, 'item.delta', { delta: 1 })).resynchronize).toBe(true);
    expect(p.seq).toBe(3);
  });
  it('requires exact item scope and wrapper identities', () => {
    const p = setup();
    expect(p.applyEvent({ ...itemEvent(1, 'item.started', 'bad'), scope: { projectId: project, threadId: thread } }).resynchronize).toBe(true);
    const mismatch = itemEvent(2, 'item.started', 'bad');
    (mismatch.payload as { item: { id: string } }).item.id = 'other-item';
    expect(p.applyEvent(mismatch).resynchronize).toBe(true);
    expect(p.view().streamItems).toHaveLength(0);
  });
  it('keeps normal connection replay at the committed cursor, resetting only to a connection head', () => {
    const p = setup(); p.applyEvent(itemEvent(1, 'item.started', 'a'));
    expect(p.acceptConnection({ type: 'connection', installationId: installation, epoch, headSeq: 5, resetRequired: false })).toEqual({ reset: false, replay: true });
    expect(p.seq).toBe(1);
    expect(p.acceptConnection({ type: 'connection', installationId: installation, epoch, headSeq: 9, resetRequired: true })).toEqual({ reset: true, replay: false });
    expect(p.seq).toBe(9);
    expect(p.applyEvent(event(10, 'future', {}, {})).reconnect).toBeUndefined();
  });
  it('accepts a new epoch only from a matching connection and rejects another installation', () => {
    const p = setup(); p.applySnapshot(snapshot()); const ticket = p.ticket();
    expect(p.acceptConnection({ type: 'connection', installationId: installation, epoch: other, headSeq: 7, resetRequired: true }).reset).toBe(true);
    expect(p.epoch).toBe(other); expect(p.seq).toBe(7); expect(p.applySnapshot(snapshot(), ticket)).toBe(false);
    expect(p.acceptConnection({ type: 'connection', installationId: other, epoch, headSeq: 0, resetRequired: false }).reconnect).toBe(true);
    expect(p.installationId).toBe(installation);
  });
  it('switches scope without resetting the device feed and rejects the old scope read', () => {
    const p = setup(); p.applyEvent(itemEvent(1, 'item.started', 'old')); const ticket = p.ticket();
    p.selectScope(project, 'new-thread');
    expect(p.seq).toBe(1); expect(p.epoch).toBe(epoch); expect(p.view().streamItems).toEqual([]);
    expect(p.applySnapshot(snapshot(), ticket)).toBe(false);
    expect(p.applyEvent({ ...event(2, 'notice', {}, {}), impact: 'informational' }).reconnect).toBeUndefined();
    expect(p.seq).toBe(2);
  });
  it('can label an empty new thread without manufacturing a snapshot or write readiness', () => {
    const p = setup(); expect(p.setThreadMetadata(snapshot().thread)).toBe(true);
    expect(p.view().thread?.id).toBe(thread); expect(p.view().history).toBeUndefined(); expect(p.view().synchronization).toBe('stale');
    expect(p.setThreadMetadata({ ...snapshot().thread, id: 'foreign' })).toBe(false);
  });
});

describe('Desktop Projection snapshot and streaming isolation', () => {
  it('does not append a recovered delta to a native baseline', () => {
    const p = setup(); p.applySnapshot(snapshot([nativeTurn(turn, 'base', 'inProgress')]));
    expect(p.applyEvent(delta(1, 'tail')).resynchronize).toBe(true);
    expect(renderedText(p)).toBe('base'); expect(p.view().streamItems).toHaveLength(0);
  });
  it('streams only from a complete start then replaces it with the completed native fact', () => {
    const p = setup(); p.applyEvent(itemEvent(1, 'item.started', 'a'));
    p.applyEvent(delta(2, 'b')); expect(renderedText(p)).toBe('ab');
    p.applyEvent(itemEvent(3, 'item.completed', 'authoritative'));
    p.applyEvent(delta(4, 'late')); p.applyEvent(itemEvent(5, 'item.started', 'old'));
    expect(renderedText(p)).toBe('authoritative');
  });
  it('keeps a known incomplete start visibly incomplete and refuses append semantics', () => {
    const p = setup(); expect(p.applyEvent(itemEvent(1, 'item.started', 'partial', false)).resynchronize).toBe(true);
    expect(p.applyEvent(delta(2, 'tail')).resynchronize).toBe(true);
    expect(renderedText(p)).toBe('partial'); expect(p.view().streamItems[0]?.item.truncated).toBe(true);
  });
  it('does not use snapshot observation windows as an event watermark', () => {
    const p = setup(); p.applyEvent({ ...event(1, 'notice', {}, {}), impact: 'informational' });
    expect(p.applySnapshot({ ...snapshot(), observedStartSeq: 50, observedEndSeq: 60 })).toBe(true);
    expect(p.seq).toBe(1);
  });
  it('rejects a snapshot racing a relevant event or a changed selection', () => {
    const p = setup(); const ticket = p.ticket(); p.applyEvent(itemEvent(1, 'item.started', 'live'));
    expect(p.applySnapshot(snapshot(), ticket)).toBe(false); expect(renderedText(p)).toBe('live');
    const next = p.ticket(); p.initialize(installation, epoch, project, 'other-thread');
    expect(p.applySnapshot(snapshot(), next)).toBe(false);
  });
  it('overlays matching history identities without rendering a second message', () => {
    const p = setup(); p.applySnapshot(snapshot([nativeTurn(turn, 'old', 'inProgress')]));
    p.applyEvent(itemEvent(1, 'item.completed', 'new'));
    expect(renderedText(p)).toBe('new'); expect(p.view().streamItems).toHaveLength(0);
  });
  it('rejects mismatched delta native type and offset', () => {
    const p = setup(); p.applyEvent(itemEvent(1, 'item.started', 'a'));
    expect(p.applyEvent(event(2, 'item.delta', { delta: 'bad', nativeMethod: 'item/commandExecution/outputDelta' })).resynchronize).toBe(true);
    const q = setup(); q.applyEvent(itemEvent(1, 'item.started', 'a'));
    expect(q.applyEvent(event(2, 'item.delta', { delta: 'bad', offset: 8 })).resynchronize).toBe(true);
    expect(renderedText(q)).toBe('a');
  });
  it('bounds streamed content and retains readable text when invalidated', () => {
    const p = setup(); p.applyEvent(itemEvent(1, 'item.started', 'safe'));
    expect(p.applyEvent(delta(2, 'x'.repeat(256 * 1024))).resynchronize).toBe(true);
    expect(renderedText(p)).toBe('safe'); expect(p.view().synchronization).toBe('stale');
  });
  it('rejects more than the five-turn snapshot contract, duplicated native IDs and foreign native turn scope', () => {
    for (const items of [Array.from({ length: 6 }, (_, index) => nativeTurn(String(index))), [nativeTurn(), nativeTurn()], [{ ...nativeTurn(), threadId: 'foreign' }]]) {
      const p = setup(); expect(p.applySnapshot(snapshot(items))).toBe(false); expect(p.view().history).toBeUndefined();
    }
  });
  it('rejects malformed nested items even when the outer Gateway schema is valid', () => {
    const p = setup(); expect(p.applySnapshot(snapshot([{ id: turn, status: 'completed', items: [{ id: itemId }] }]))).toBe(false);
  });
  it('keeps output DTOs detached from the controller', () => {
    const p = setup(); p.applySnapshot(snapshot()); const view = p.view();
    (view.history!.items[0] as { items: { text: string }[] }).items[0]!.text = 'changed';
    expect(renderedText(p)).toBe('baseline');
  });
});

describe('Desktop Projection history revision and paging', () => {
  it('preserves loaded older pages and their cursor on unchanged revision refresh', () => {
    const p = setup(); p.applySnapshot({ ...snapshot(), history: history([nativeTurn()], 'opaque-r1', 'cursor-1') });
    expect(p.appendHistory(history([nativeTurn('older', 'older')], 'opaque-r1', 'cursor-2'))).toBe(true);
    p.applySnapshot(snapshot([nativeTurn(turn, 'refreshed')]));
    expect(p.view().history?.items.map(value => (value as { id: string }).id)).toEqual(['older', turn]);
    expect(p.view().history?.nextCursor).toBe('cursor-2');
  });
  it('rebuilds on changed revision and never applies stale older pages', () => {
    const p = setup(); p.applySnapshot(snapshot()); p.appendHistory(history([nativeTurn('older')]));
    p.applySnapshot(snapshot([nativeTurn('new')], 'opaque-r2'));
    expect(p.view().history?.items.map(value => (value as { id: string }).id)).toEqual(['new']);
    expect(p.appendHistory(history([nativeTurn('stale')], 'opaque-r1'))).toBe(false);
    expect(p.view().synchronization).toBe('stale');
  });
  it('does not let old pages replace newer overlapping turns and rejects raced pagination', () => {
    const p = setup(); p.applySnapshot(snapshot());
    expect(p.appendHistory(history([nativeTurn(turn, 'obsolete'), nativeTurn('older')]))).toBe(true);
    expect((p.view().history!.items[1] as { items: { text: string }[] }).items[0]!.text).toBe('baseline');
    const ticket = p.ticket(); p.applyEvent(event(1, 'history.invalidated', { reasonCode: 'NATIVE_COMPACTION' }));
    expect(p.appendHistory(history([nativeTurn('late')]), ticket)).toBe(false);
  });
  it('keeps known terminal native items from regressing under an older active snapshot in the same revision', () => {
    const p = setup(); p.applySnapshot(snapshot()); p.applySnapshot(snapshot([nativeTurn(turn, 'old', 'inProgress')]));
    expect(renderedText(p)).toBe('baseline'); expect(p.view().activeTurnId).toBeUndefined();
  });
});

describe('Desktop Projection native state and interactions', () => {
  it('supports turn lifecycle with omitted scope.turnId and clears permission readback', () => {
    const p = setup(); p.applySnapshot({ ...snapshot([]), thread: { ...snapshot().thread,
      permissionReadback: { preset: 'auto', sandboxType: 'workspaceWrite', approvalPolicy: 'on-request', observedAt: 1, source: 'thread.resume' } } });
    const p2 = setup(); p2.applySnapshot(snapshot([]));
    p2.applyEvent(stateEvent(1, 'turn/started', { turn: { id: turn, status: 'inProgress' } }, { projectId: project, threadId: thread }));
    expect(p2.view().activeTurnId).toBe(turn); expect(p2.view().synchronization).toBe('synchronizing');
    p.applyEvent(itemEvent(1, 'item.started', 'later'));
    expect(p.view().thread?.permissionReadback).toBeUndefined();
    p2.applyEvent(stateEvent(2, 'turn/completed', { turn: { id: turn, status: 'completed' } }));
    expect(p2.view().activeTurnId).toBeUndefined(); expect(p2.view().synchronization).toBe('stale');
  });
  it('validates allowed plan/diff/token projections and rejects mismatched native identity', () => {
    const p = setup();
    p.applyEvent(stateEvent(1, 'turn/plan/updated', { turnId: turn, plan: [{ step: 'Test', status: 'inProgress' }] }));
    p.applyEvent(stateEvent(2, 'turn/diff/updated', { turnId: turn, diff: '+line' }));
    p.applyEvent(stateEvent(3, 'thread/tokenUsage/updated', { turnId: turn, tokenUsage: { total: { totalTokens: 10 }, last: { inputTokens: 3 } } }));
    expect(p.view().plan).toMatchObject({ turnId: turn }); expect(p.view().diff).toBe('+line'); expect(p.view().tokenUsage).toMatchObject({ turnId: turn });
    expect(p.applyEvent(stateEvent(4, 'turn/diff/updated', { threadId: 'foreign', turnId: turn, diff: 'wrong' })).resynchronize).toBe(true);
    expect(p.view().diff).toBe('+line');
  });
  it('retains observed Plan, Diff and token usage only for a native Turn present after a new revision', () => {
    const p = setup(); p.applySnapshot(snapshot([nativeTurn(turn, 'active', 'inProgress')]));
    p.applyEvent(stateEvent(1, 'turn/plan/updated', { turnId: turn, plan: [{ step: 'Test', status: 'completed' }] }));
    p.applyEvent(stateEvent(2, 'turn/diff/updated', { turnId: turn, diff: '+line' }));
    p.applyEvent(stateEvent(3, 'thread/tokenUsage/updated', { turnId: turn, tokenUsage: { total: { totalTokens: 10 } } }));
    p.applySnapshot(snapshot([nativeTurn(turn, 'complete')], 'opaque-r2'));
    expect(p.view().plan).toBeDefined(); expect(p.view().diff).toBe('+line'); expect(p.view().tokenUsage).toBeDefined();
    p.applySnapshot(snapshot([nativeTurn('replacement')], 'opaque-r3'));
    expect(p.view().plan).toBeUndefined(); expect(p.view().diff).toBeUndefined(); expect(p.view().tokenUsage).toBeUndefined();
  });
  it.each([
    ['future/arbitrary', {}], ['turn/plan/updated', { turnId: turn, plan: [{ step: 'bad', status: 'mystery' }] }],
    ['thread/tokenUsage/updated', { turnId: turn, tokenUsage: { total: { totalTokens: -1 } } }],
  ])('invalidates unsupported or invalid native state %s', (method, data) => {
    const p = setup(); expect(p.applyEvent(stateEvent(1, method as string, data as object)).resynchronize).toBe(true);
  });
  it('clears actionable interactions on invalidation and never resurrects resolved or submitted generations', () => {
    const p = setup();
    p.applyEvent(event(1, 'interaction.opened', interaction()));
    expect(p.view().interactions).toHaveLength(1);
    p.applyEvent(event(2, 'interaction.resolved', interaction('resolved')));
    expect(p.view().interactions).toHaveLength(0);
    expect(p.applySnapshot({ ...snapshot(), interactions: [interaction()] })).toBe(false);
    expect(p.view().interactions).toHaveLength(0);
    expect(p.applyEvent(event(3, 'interaction.opened', interaction())).resynchronize).toBe(true);
    expect(p.view().interactions).toHaveLength(0);
    const q = setup(); q.applyEvent(event(1, 'interaction.opened', interaction('submitted')));
    q.applySnapshot({ ...snapshot(), interactions: [interaction()] }); expect(q.view().interactions).toHaveLength(0);
  });
  it('does not resurrect a terminal turn observed before its history was available', () => {
    const p = setup();
    p.applyEvent(stateEvent(1, 'turn/completed', { turn: { id: turn, status: 'completed' } }));
    p.applyEvent(stateEvent(2, 'turn/started', { turn: { id: turn, status: 'inProgress' } }));
    p.applyEvent(itemEvent(3, 'item.started', 'late'));
    expect(p.view().activeTurnId).toBeUndefined(); expect(p.view().streamItems).toEqual([]);
  });
  it('refuses stale epoch, generation reuse and inconsistent interaction payload scope', () => {
    for (const payload of [{ ...interaction(), epoch: other }, { ...interaction(), request: { threadId: 'foreign' } }]) {
      const p = setup(); expect(p.applyEvent(event(1, 'interaction.opened', payload)).resynchronize).toBe(true); expect(p.view().interactions).toHaveLength(0);
    }
    const p = setup(); p.applyEvent(event(1, 'interaction.opened', interaction()));
    expect(p.applyEvent(event(2, 'interaction.opened', interaction('pending', 2))).resynchronize).toBe(true);
    expect(p.view().interactions).toHaveLength(0);
  });
  it('passes validated operation receipts to the owner without inferring native completion', () => {
    const p = setup(); const receipt = { operationId, status: 'accepted', nativeTurnId: turn };
    expect(p.applyEvent(event(1, 'operation.changed', receipt))).toEqual({ resynchronize: false, operation: receipt });
    expect(p.view().activeTurnId).toBeUndefined(); expect(p.view().synchronization).toBe('stale');
  });
  it('reports project changes and removes actionable facts on connection loss', () => {
    const p = setup(); p.applySnapshot(snapshot());
    expect(p.applyEvent(event(1, 'project.changed', { project: { id: project, name: 'Test', canonicalPath: '/test', rootId: 'root', available: true } }, { projectId: project })).projectChanged).toBe(true);
    expect(p.applyEvent(event(2, 'connection.changed', { state: 'disconnected' }, {})).resynchronize).toBe(true);
    expect(p.view().synchronization).toBe('stale');
  });
});
