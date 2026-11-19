import { describe, expect, it } from 'vitest';
import type { Interaction, InteractionAnswer, Snapshot } from '../../../../packages/gateway-protocol/src/index';
import type { WorkspaceAction } from '../contracts/workspace';
import { parseWorkspaceAction, validateInteractionAnswer } from './workspace-actions';
import { FileChangeContexts } from './file-change-context';

const ID = '00000000-0000-4000-8000-000000000001';
const EPOCH = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
const valid: WorkspaceAction[] = [
  { type: 'connect', endpoint: 'http://127.0.0.1:8790/' },
  { type: 'pair', code: 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567', label: 'Desktop' },
  ...(['disconnect', 'reconnect', 'refresh', 'reconcile', 'logout', 'resumeThread', 'historyMore', 'interrupt', 'upload'] as const).map(type => ({ type })),
  { type: 'directories', rootId: 'projects', path: '', cursor: 'cursor' },
  { type: 'registerProject', rootId: 'projects', path: 'Desktop Test' },
  { type: 'unregisterProject', projectId: ID, confirm: true }, { type: 'selectProject', projectId: ID },
  { type: 'threads', search: 'test', archived: false, more: true }, { type: 'selectThread', threadId: 'thread:opaque' },
  { type: 'startThread', model: 'codex', effort: 'ultra', permissionPreset: 'read-only' },
  { type: 'send', text: 'Hello\nworld', permissionPreset: 'auto' }, { type: 'steer', text: 'Continue' },
  { type: 'send', text: 'Durable draft', clientDraftId: ID, draftRevision: 1 },
  { type: 'steer', text: 'Durable steer', clientDraftId: ID, draftRevision: 2 },
  { type: 'checkDraft', clientDraftId: ID, draftRevision: 3 },
  { type: 'historyMore', cursor: 'cache-cursor', historyRevision: 'opaque-revision' },
  { type: 'threadMutation', action: 'name', name: 'A thread' },
  ...(['archive', 'unarchive', 'fork', 'compact'] as const).map(action => ({ type: 'threadMutation' as const, action })),
  { type: 'threadMutation', action: 'delete', confirm: true }, { type: 'threadMutation', action: 'revert', beforeTurnId: 'turn-1' },
  { type: 'answer', interactionId: ID, epoch: EPOCH, generation: 1, response: { type: 'approval', decision: 'decline' } },
  { type: 'details', turnId: 'turn-1', itemId: 'item-1', cursor: 'cursor' }, { type: 'files', path: '', more: false },
  { type: 'previewFile', path: 'docs/说明.md' }, { type: 'downloadFile', path: 'results/report.pdf' },
  { type: 'removeAttachment', attachmentId: ID }, { type: 'inspector', section: 'usage' }, { type: 'inspector', section: 'extensions' },
];

describe('Desktop closed workspace actions', () => {
  it.each(valid)('accepts the defined $type action', action => {
    const parsed = parseWorkspaceAction(action);
    expect(parsed).toEqual(action);
    expect(parsed).not.toBe(action);
  });
  it.each(valid)('rejects extra keys on $type', action => {
    expect(() => parseWorkspaceAction({ ...action, url: 'file:///private' })).toThrow();
  });
  it.each([null, [], true, 'send', {}, { type: 'fetch', url: 'https://example.invalid/' },
    { type: 'send' }, { type: 'send', text: 1 }, { type: 'send', text: '' },
    { type: 'send', text: 'x', clientDraftId: ID }, { type: 'steer', text: 'x', draftRevision: 1 },
    { type: 'send', text: 'x', clientDraftId: ID, draftRevision: 0 },
    { type: 'checkDraft', clientDraftId: ID, draftRevision: Number.MAX_SAFE_INTEGER + 1 },
    { type: 'checkDraft', clientDraftId: '../scope', draftRevision: 1 },
    { type: 'historyMore', cursor: 'cursor' }, { type: 'historyMore', historyRevision: 'revision' },
    { type: 'historyMore', cursor: 'cursor', historyRevision: 'revision\n' },
    { type: 'threads', archived: 'true' }, { type: 'files', more: 1 }, { type: 'files', path: null },
    { type: 'threads', search: 'x'.repeat(257) }, { type: 'startThread', permissionPreset: 'dangerous' },
    { type: 'startThread', permissionPreset: ['full-access'] }, { type: 'threadMutation', action: ['archive'] },
    { type: 'threadMutation', action: [['delete']] },
    { type: 'startThread', effort: 'Ultra' }, { type: 'startThread', model: '' },
    { type: 'unregisterProject', projectId: ID, confirm: false },
    { type: 'threadMutation', action: 'delete', confirm: false }, { type: 'threadMutation', action: 'delete' },
    { type: 'threadMutation', action: 'revert', numTurns: 1 }, { type: 'threadMutation', action: 'revert' },
    { type: 'threadMutation', action: 'archive', confirm: true }, { type: 'threadMutation', action: 'name', name: '  ' },
    { type: 'threadMutation', action: 'name', name: 'one\ntwo' }, { type: 'threadMutation', action: 'unknown' },
    { type: 'inspector', section: 'settings' }, { type: 'pair', code: 'invalid', label: 'Desktop' },
    { type: 'pair', code: 'A'.repeat(32), label: ' ' }, { type: 'pair', code: 'A'.repeat(32), label: 'one\ntwo' },
    { type: 'connect', endpoint: 'http://example.invalid/' }, { type: 'connect', endpoint: 'https://user:pass@example.invalid/' },
  ])('rejects malformed/cross-variant input %#', action => expect(() => parseWorkspaceAction(action)).toThrow());
  it.each(['../file', '/etc/passwd', 'a/../file', './file', 'a//file', 'a/', 'C:\\file', 'https://example.invalid/a',
    'a\\file', 'a/%2e%2e/file', 'a/%252e/file', 'a\u0000file', '.hidden', 'a/ file', 'a/'.repeat(13) + 'file', 'a'.repeat(181), 'e\u0301.txt'])('rejects ambiguous or unsafe relative path %s', path => {
    for (const type of ['files', 'previewFile', 'downloadFile'] as const) expect(() => parseWorkspaceAction({ type, path })).toThrow();
  });
  it.each(['not-a-uuid', ID.toUpperCase().replace('00000000', 'ABCDEFAB'), '00000000-0000-1000-8000-000000000001', '../scope'])('requires canonical UUID for local scope IDs: %s', id => {
    expect(() => parseWorkspaceAction({ type: 'selectProject', projectId: id })).toThrow();
    expect(() => parseWorkspaceAction({ type: 'removeAttachment', attachmentId: id })).toThrow();
  });
  it.each(['../turn', 'turn/next', 'turn?query', 'turn#hash', 'turn%2fnext', 'turn\\next', 'turn\u0000', 'x'.repeat(257)])('rejects unsafe opaque route ID %s', threadId => {
    expect(() => parseWorkspaceAction({ type: 'selectThread', threadId })).toThrow();
  });
  it('bounds UTF-8 bytes, tree depth and node count without invoking accessors', () => {
    expect(() => parseWorkspaceAction({ type: 'send', text: '界'.repeat(42_000) })).toThrow();
    let nested: unknown = {};
    for (let n = 0; n < 14; n++) nested = { nested };
    expect(() => parseWorkspaceAction({ type: 'answer', interactionId: ID, epoch: EPOCH, generation: 1,
      response: { type: 'elicitation', action: 'accept', content: nested } })).toThrow();
    expect(() => parseWorkspaceAction({ type: 'answer', interactionId: ID, epoch: EPOCH, generation: 1,
      response: { type: 'input', answers: { q: Array(4096).fill('') } } })).toThrow();
    let read = false;
    const getter = Object.defineProperty({ type: 'send' }, 'text', { enumerable: true, get() { read = true; return 'x'; } });
    expect(() => parseWorkspaceAction(getter)).toThrow(); expect(read).toBe(false);
  });
  it('rejects cyclic, sparse, non-JSON and prototype-bearing values', () => {
    const cyclic: Record<string, unknown> = { type: 'send' }; cyclic.text = cyclic;
    for (const bad of [cyclic, new Date(), Object.create({ type: 'refresh' }), { type: 'send', text: undefined },
      { type: 'answer', response: { type: 'input', answers: { q: new Array(2) } } },
      { type: 'threads', more: BigInt(1) }, { type: 'threads', more: Infinity }, { type: 'threads', more: () => true }]) {
      expect(() => parseWorkspaceAction(bad)).toThrow();
    }
  });
  it('detaches nested response data and does not strip unknown union fields', () => {
    const action = { type: 'answer', interactionId: ID, epoch: EPOCH, generation: 1, response: { type: 'input', answers: { q: ['yes'] } } };
    const parsed = parseWorkspaceAction(action);
    action.response.answers.q[0] = 'changed';
    expect(parsed).toMatchObject({ response: { answers: { q: ['yes'] } } });
    expect(() => parseWorkspaceAction({ ...action, response: { type: 'approval', decision: 'accept', answers: {} } })).toThrow();
    expect(() => parseWorkspaceAction({ ...action, generation: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });
});

function interaction(kind = 'command', request: Record<string, unknown> = {}): Interaction {
  return { interactionId: ID, epoch: EPOCH, generation: 1, projectId: OTHER, threadId: 'thread-1', turnId: 'turn-1',
    status: 'pending', kind, request: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'echo test', ...request } };
}
function answer(response: InteractionAnswer): Extract<WorkspaceAction, { type: 'answer' }> {
  return { type: 'answer', interactionId: ID, epoch: EPOCH, generation: 1, response };
}
const accept = answer({ type: 'approval', decision: 'accept' });

describe('Desktop native interaction answers', () => {
  it('accepts a complete displayed command and permitted simple decision', () => {
    expect(validateInteractionAnswer(interaction('command', { availableDecisions: ['accept', 'decline'] }), accept)).toEqual(accept.response);
  });
  it.each([{ status: 'submitted' }, { status: 'unknown' }, { status: 'resolved' }, { generation: 2 },
    { epoch: OTHER }, { interactionId: OTHER }])('rejects stale interaction context %#', mutation => {
    expect(() => validateInteractionAnswer({ ...interaction(), ...mutation } as Interaction, accept)).toThrow('INTERACTION_STALE');
  });
  it.each([{ kind: 'writeStdin' }, { kind: 'humanCommand' }, { command: '' }, { command: '  ' },
    { truncated: true }, { detailsAvailable: true }, { availableDecisions: ['decline'] },
    { availableDecisions: [{ acceptWithExecpolicyAmendment: {} }] }, { availableDecisions: 'accept' },
    { networkApprovalContext: { host: 'example.invalid', protocol: 'https', hidden: true } },
    { networkApprovalContext: { host: 'bad host', protocol: 'https' } },
    { networkApprovalContext: { host: 'example.invalid', protocol: 'ftp' } },
    { networkApprovalContext: { host: 'example.invalid', protocol: ['https'] } },
  ])('rejects undisplayed/unsupported command approval %#', request => {
    expect(() => validateInteractionAnswer(interaction('command', request), accept)).toThrow();
  });
  it('accepts explicit supported network context without inventing a command', () => {
    expect(validateInteractionAnswer(interaction('command', { command: null,
      networkApprovalContext: { host: 'example.invalid', protocol: 'https' } }), accept)).toEqual(accept.response);
  });
  it('keeps file-change positive approval unavailable while allowing decline', () => {
    expect(() => validateInteractionAnswer(interaction('fileChange'), accept)).toThrow('FILE_CHANGE_ACCEPT_UNAVAILABLE');
    const decline = answer({ type: 'approval', decision: 'decline' });
    expect(validateInteractionAnswer(interaction('fileChange'), decline)).toEqual(decline.response);
  });
  it('allows file-change accept only with its exact live snapshot proof and displayed digest', () => {
    const current = interaction('fileChange'), store = new FileChangeContexts();
    const snapshot: Snapshot = { epoch: EPOCH, thread: { id: 'thread-1', projectId: OTHER, status: 'active' },
      history: { epoch: EPOCH, historyRevision: 'revision', source: 'native-pagination', complete: false, truncated: false, nextCursor: null,
        items: [{ id: 'turn-1', status: 'inProgress', items: [{ id: 'item-1', type: 'fileChange', status: 'inProgress',
          changes: [{ path: '/project/a.txt', kind: { type: 'add' }, diff: '+hello\n' }] }] }] },
      interactions: [current], operations: [], observedStartSeq: 1, observedEndSeq: 1, synchronization: 'synchronizing' };
    store.snapshot(snapshot, '/project');
    const proof = store.forInteraction(current)!;
    const action = { ...accept, contextDigest: proof.digest };
    expect(parseWorkspaceAction(action)).toEqual(action);
    expect(validateInteractionAnswer(current, action, proof)).toEqual(accept.response);
    expect(() => validateInteractionAnswer(current, accept, proof)).toThrow('FILE_CHANGE_ACCEPT_UNAVAILABLE');
    expect(() => validateInteractionAnswer(current, { ...action, contextDigest: 'f'.repeat(64) }, proof)).toThrow('FILE_CHANGE_ACCEPT_UNAVAILABLE');
    expect(() => validateInteractionAnswer(current, action, { ...proof })).toThrow('FILE_CHANGE_ACCEPT_UNAVAILABLE');
    expect(() => parseWorkspaceAction({ ...action, contextDigest: '../digest' })).toThrow();
    store.clear();
    expect(() => validateInteractionAnswer(current, action, proof)).toThrow('FILE_CHANGE_ACCEPT_UNAVAILABLE');
  });
  it('allows only the original supported permission shape', () => {
    expect(validateInteractionAnswer(interaction('permissions', { permissions: { network: { enabled: true }, fileSystem: { write: ['/tmp/test'] } } }), accept)).toEqual(accept.response);
    for (const permissions of [{ filesystem: {} }, { network: { enabled: true, host: '*' } }, { fileSystem: { write: ['relative'] } },
      { fileSystem: { write: [{ glob: '/tmp/**' }] } }, { fileSystem: { write: ['/tmp/test\u0000'] } }]) {
      expect(() => validateInteractionAnswer(interaction('permissions', { permissions }), accept)).toThrow();
    }
  });
  it('validates native question IDs and exact choices while permitting partial answers', () => {
    const current = interaction('input', { isBlocking: true, questions: [{ id: 'q', header: 'Choice', question: 'Pick', options: [{ label: 'One', description: 'First' }] }] });
    expect(validateInteractionAnswer(current, answer({ type: 'input', answers: { q: ['One'] } }))).toEqual({ type: 'input', answers: { q: ['One'] } });
    expect(validateInteractionAnswer(current, answer({ type: 'input', answers: {} }))).toEqual({ type: 'input', answers: {} });
    const invalidAnswers: Record<string, string[]>[] = [{ unknown: ['One'] }, { q: ['Other'] }, { q: Array(21).fill('One') }, { q: ['x'.repeat(16_001)] }];
    for (const answers of invalidAnswers) {
      expect(() => validateInteractionAnswer(current, answer({ type: 'input', answers }))).toThrow();
    }
    current.request.questions = [{ id: 'q', header: '', question: '', isOther: true, options: [{ label: 'One', description: '' }] }];
    expect(validateInteractionAnswer(current, answer({ type: 'input', answers: { q: ['Other'] } }))).toMatchObject({ answers: { q: ['Other'] } });
  });
  it('preserves native prototype-like question IDs without prototype mutation', () => {
    const answers = JSON.parse('{"__proto__":["safe"]}') as Record<string, string[]>;
    const current = interaction('input', { isBlocking: true, questions: [{ id: '__proto__', header: '', question: '' }] });
    const result = validateInteractionAnswer(current, answer({ type: 'input', answers }));
    expect(Object.hasOwn(result.answers!, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result.answers!)).toBe(Object.prototype);
    expect(result.answers!['__proto__']).toEqual(['safe']);
  });
  it('uses the exact supported form schema without coercion or weaker fallbacks', () => {
    const current = interaction('elicitation', { mode: 'form', requestedSchema: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 3 } }, required: ['n'] } });
    expect(validateInteractionAnswer(current, answer({ type: 'elicitation', action: 'accept', content: { n: 2 } }))).toMatchObject({ content: { n: 2 } });
    for (const content of [{ n: '2' }, { n: 4 }, {}, { n: 2, extra: true }]) expect(() => validateInteractionAnswer(current, answer({ type: 'elicitation', action: 'accept', content }))).toThrow();
    current.request.requestedSchema = { type: 'object', properties: { x: { type: 'string', pattern: 'x' } } };
    expect(() => validateInteractionAnswer(current, answer({ type: 'elicitation', action: 'accept', content: { x: 'x' } }))).toThrow();
    current.request.requestedSchema = null;
    expect(validateInteractionAnswer(current, answer({ type: 'elicitation', action: 'accept' }))).toMatchObject({ action: 'accept' });
    current.request.mode = ['form'];
    expect(() => validateInteractionAnswer(current, answer({ type: 'elicitation', action: 'accept' }))).toThrow();
  });
  it('checks URL-mode safety and never treats submitted content as URL authority', () => {
    const current = interaction('elicitation', { mode: 'url', url: 'https://example.invalid/approval' });
    const response = answer({ type: 'elicitation', action: 'accept' });
    expect(validateInteractionAnswer(current, response)).toEqual(response.response);
    expect(() => validateInteractionAnswer(current, answer({ type: 'elicitation', action: 'accept', content: {} }))).toThrow();
    for (const url of ['file:///tmp/x', 'https://user:secret@example.invalid/', 'javascript:alert(1)']) {
      expect(() => validateInteractionAnswer({ ...current, request: { ...current.request, url } }, response)).toThrow();
    }
  });
  it('rejects unknown interaction kinds, crossed scope and response kinds', () => {
    expect(() => validateInteractionAnswer(interaction('future'), accept)).toThrow();
    expect(() => validateInteractionAnswer(interaction('command', { threadId: 'another' }), accept)).toThrow();
    expect(() => validateInteractionAnswer(interaction('command', { turnId: 'another' }), accept)).toThrow();
    expect(() => validateInteractionAnswer(interaction(), answer({ type: 'input', answers: {} }))).toThrow();
  });
});
