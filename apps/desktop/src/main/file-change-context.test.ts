import { describe, expect, it } from 'vitest';
import type { Interaction, Snapshot } from '../../../../packages/gateway-protocol/src/index';
import { FileChangeContexts } from './file-change-context';

const ROOT = '/home/fixture/approved-project';
const EPOCH = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const APPROVAL = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const THREAD = 'thread-1', TURN = 'turn-1', ITEM = 'item-1';
type Native = Record<string, unknown>;
function change(path = `${ROOT}/a.txt`, kind = 'add', diff = '+hello\n', movePath?: string | null): Native {
  return { path, kind: { type: kind, ...(movePath !== undefined ? { move_path: movePath } : {}) }, diff };
}
function item(changes: unknown[] = [change()], patch: Native = {}): Native {
  return { id: ITEM, type: 'fileChange', status: 'inProgress', changes, ...patch };
}
function interaction(patch: Partial<Interaction> = {}, request: Native = {}): Interaction {
  return { interactionId: APPROVAL, projectId: PROJECT, threadId: THREAD, turnId: TURN, epoch: EPOCH, generation: 1,
    kind: 'fileChange', status: 'pending', request: { threadId: THREAD, turnId: TURN, itemId: ITEM, ...request }, ...patch };
}
function snapshot(items: unknown[] = [item()], patch: Partial<Snapshot> = {}): Snapshot {
  return { epoch: EPOCH, thread: { id: THREAD, projectId: PROJECT, status: 'active' },
    history: { epoch: EPOCH, historyRevision: 'revision-1', source: 'native-read-projection', complete: true, truncated: false,
      nextCursor: null, items: [{ id: TURN, status: 'inProgress', items }] },
    interactions: [interaction()], operations: [], observedStartSeq: 5, observedEndSeq: 5, synchronization: 'synchronizing', ...patch };
}
function proof(native: Native = item(), root = ROOT) {
  const store = new FileChangeContexts(); store.snapshot(snapshot([native]), root);
  return store.forInteraction(interaction());
}
function loaded() {
  const store = new FileChangeContexts(); store.snapshot(snapshot(), ROOT);
  const current = interaction(), context = store.forInteraction(current)!;
  expect(context).toBeDefined();
  return { store, current, context };
}

describe('Desktop complete native file-change proof', () => {
  it('preserves every change kind, move and exact visible patch within the project', () => {
    const diff = '@@ -1 +1 @@\n-old\n+new\n';
    const context = proof(item([change(), change(`${ROOT}/b.txt`, 'delete', '-old\n'),
      change(`${ROOT}/c.txt`, 'update', diff, `${ROOT}/d.txt`)]))!;
    expect(context).toMatchObject({ interactionId: APPROVAL, generation: 1, epoch: EPOCH, projectId: PROJECT,
      threadId: THREAD, turnId: TURN, itemId: ITEM,
      changes: [{ path: 'a.txt', kind: 'add', movePath: null, diff: '+hello\n' },
        { path: 'b.txt', kind: 'delete', movePath: null, diff: '-old\n' },
        { path: 'c.txt', kind: 'update', movePath: 'd.txt', diff }] });
    expect(context.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(context)).not.toContain(ROOT);
  });
  it('supports safe relative native paths and null update move paths', () => {
    const context = proof(item([change('docs/a.txt', 'update', '+new\n', null)]))!;
    expect(context.changes).toEqual([{ path: 'docs/a.txt', kind: 'update', movePath: null, diff: '+new\n' }]);
  });
  it('replaces only the known project root in the displayed diff', () => {
    const diff = `--- ${ROOT}/a.txt\n+++ ${ROOT}/a.txt\n@@ -1 +1 @@\n-old\n+new\n`;
    const context = proof(item([change(`${ROOT}/a.txt`, 'update', diff)]))!;
    expect(context.changes[0].diff).toBe('--- ./a.txt\n+++ ./a.txt\n@@ -1 +1 @@\n-old\n+new\n');
    expect(JSON.stringify(context)).not.toContain(ROOT);
  });
  it('allows the active synchronizing snapshot while unrelated events advance its observation window', () => {
    const store = new FileChangeContexts();
    store.snapshot(snapshot([item()], { observedEndSeq: 8 }), ROOT);
    expect(store.forInteraction(interaction())).toBeDefined();
  });
  it('hashes exact original facts even when their relative display is identical', () => {
    const absolute = proof(item([change(`${ROOT}/a.txt`)]))!, relative = proof(item([change('a.txt')]))!;
    expect(absolute.changes).toEqual(relative.changes);
    expect(absolute.digest).not.toBe(relative.digest);
    expect(proof()!.digest).toBe(proof()!.digest);
  });
  it('binds path, kind, move destination and exact diff into the displayed digest', () => {
    const original = proof()!.digest;
    for (const modified of [change(`${ROOT}/b.txt`), change(`${ROOT}/a.txt`, 'delete'),
      change(`${ROOT}/a.txt`, 'update', '+hello\n', `${ROOT}/renamed.txt`), change(`${ROOT}/a.txt`, 'add', '+different\n')]) {
      expect(proof(item([modified]))!.digest).not.toBe(original);
    }
  });
  it.each(['completed', 'failed', 'declined', 'future', null])('rejects non-active item status %s', status => {
    expect(proof(item([change()], { status }))).toBeUndefined();
  });
  it.each(['completed', 'interrupted', 'failed', 'future'])('rejects non-active turn status %s', status => {
    const store = new FileChangeContexts(), data = snapshot();
    (data.history.items[0] as Native).status = status;
    store.snapshot(data, ROOT);
    expect(store.forInteraction(interaction())).toBeUndefined();
  });
  it('rejects an empty change list and terminal or unrelated native item types', () => {
    expect(proof(item([]))).toBeUndefined();
    for (const type of ['agentMessage', 'commandExecution', 'future']) expect(proof(item([change()], { type }))).toBeUndefined();
  });
  it.each([{ truncated: true }, { detailsAvailable: true }, { futureConstraint: true }, { text: 'summary only' }])('rejects abbreviated or expanded item shape %#', patch => {
    expect(proof(item([change()], patch))).toBeUndefined();
  });
  it('rejects missing, malformed and extra change fields', () => {
    const missing = change(); delete missing.diff;
    for (const invalid of [missing, { ...change(), diff: 123 }, { ...change(), futureConstraint: true },
      { ...change(), kind: 'add' }, { ...change(), kind: { type: 'future' } },
      { ...change(), kind: { type: 'update', futureConstraint: true } },
      change(`${ROOT}/a.txt`, 'add', '+x\n', `${ROOT}/other.txt`), change(`${ROOT}/a.txt`, 'delete', '-x\n', null)]) {
      expect(proof(item([invalid]))).toBeUndefined();
    }
  });
  it.each(['', ' ', '\n\r\t'])('rejects an empty or visually blank diff %#', diff => {
    expect(proof(item([change(`${ROOT}/a.txt`, 'update', diff)]))).toBeUndefined();
  });
  it.each(['../escape.txt', 'docs/../../escape.txt', '/etc/passwd', `${ROOT}-other/a.txt`, `${ROOT}/../escape.txt`,
    'a//b.txt', './a.txt', 'a\\b.txt', 'a\u0000.txt', 'a\nb.txt', 'a\u202eevil.txt', 'a\u2066evil.txt', 'a\u200fevil.txt'])('rejects misleading or escaping paths %#', path => {
    expect(proof(item([change(path)]))).toBeUndefined();
    expect(proof(item([change(`${ROOT}/a.txt`, 'update', '+new\n', path)]))).toBeUndefined();
  });
  it.each(['relative/project', `${ROOT}/`, `${ROOT}/../project`, `${ROOT}//nested`, `${ROOT}\n`, `${ROOT}/\u202eevil`])('refuses noncanonical roots %#', root => {
    expect(proof(item(), root)).toBeUndefined();
  });
  it.each(['+hidden\u001b[0m\n', '+hidden\u0000\n', '+hidden\u202e\n', '+hidden\u2066\n', '+hidden\u200f\n',
    '--- /etc/passwd\n+++ a.txt\n', `+${ROOT}-other/a.txt\n`, '+/home/another/private.txt\n',
    '+“/etc/passwd”\n', `--- ${ROOT}/../outside.txt\n`, `--- ${ROOT}//a.txt\n`,
    `--- ${ROOT}/./a.txt\n`])('rejects undisplayable controls or ambiguous absolute paths in diff %#', diff => {
    expect(proof(item([change(`${ROOT}/a.txt`, 'update', diff)]))).toBeUndefined();
  });
  it('invalidates all proof for duplicate native item or turn identities', () => {
    const store = new FileChangeContexts();
    store.snapshot(snapshot([item(), item()]), ROOT);
    expect(store.forInteraction(interaction())).toBeUndefined();
    const duplicateTurn = snapshot();
    duplicateTurn.history.items.push({ id: TURN, status: 'inProgress', items: [item([change(`${ROOT}/b.txt`)], { id: 'other-item' })] });
    store.snapshot(duplicateTurn, ROOT);
    expect(store.forInteraction(interaction())).toBeUndefined();
  });
  it('rejects duplicate normalized change paths', () => {
    expect(proof(item([change(), change()]))).toBeUndefined();
    expect(proof(item([change(`${ROOT}/a.txt`), change('a.txt')]))).toBeUndefined();
  });
  it('enforces file count and UTF-8 proof byte limits without truncating', () => {
    expect(proof(item(Array.from({ length: 20 }, (_, n) => change(`${ROOT}/${n}.txt`))))).toBeDefined();
    expect(proof(item(Array.from({ length: 21 }, (_, n) => change(`${ROOT}/${n}.txt`))))).toBeUndefined();
    for (const diff of ['x'.repeat(16 * 1024), '字'.repeat(6000)]) expect(proof(item([change(`${ROOT}/a.txt`, 'update', diff)]))).toBeUndefined();
  });
  it('enforces total line budget across LF, CR, CRLF and Unicode separators', () => {
    for (const newline of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
      expect(proof(item([change(`${ROOT}/a.txt`, 'update', '+x' + newline.repeat(256))]))).toBeUndefined();
    }
    expect(proof(item([change(`${ROOT}/a.txt`, 'update', '+x' + '\n'.repeat(128)),
      change(`${ROOT}/b.txt`, 'update', '+x' + '\n'.repeat(128))]))).toBeUndefined();
    expect(proof(item([change(`${ROOT}/a.txt`, 'update', '+x' + '\r\n'.repeat(255))]))).toBeDefined();
  });
});

describe('Desktop file-change proof lifetime and binding', () => {
  it('requires explicit untruncated same-epoch history and clears previous proof on invalid snapshots', () => {
    const { store, current, context } = loaded();
    const bad: Snapshot[] = [];
    const missing = snapshot(); delete (missing.history as Native).truncated; bad.push(missing);
    const truncated = snapshot(); truncated.history.truncated = true; bad.push(truncated);
    const epochChanged = snapshot(); epochChanged.history.epoch = OTHER; bad.push(epochChanged);
    for (const data of bad) {
      store.snapshot(snapshot(), ROOT); expect(store.forInteraction(current)).toBeDefined();
      store.snapshot(data, ROOT); expect(store.forInteraction(current)).toBeUndefined();
      expect(() => store.assertCurrent(current, context.digest)).toThrow();
    }
  });
  it.each([{ kind: 'command' }, { status: 'submitted' }, { status: 'unknown' }, { status: 'resolved' }, { epoch: OTHER },
    { projectId: OTHER }, { threadId: 'other-thread' }, { turnId: 'other-turn' }, { generation: 0 }, { generation: -1 },
    { generation: 0.5 }, { generation: Number.MAX_SAFE_INTEGER + 1 }])('refuses crossed or stale interaction scope %#', patch => {
    const { store } = loaded();
    expect(store.forInteraction(interaction(patch as Partial<Interaction>))).toBeUndefined();
  });
  it.each([{ threadId: 'other-thread' }, { turnId: 'other-turn' }, { itemId: 'other-item' },
    { grantRoot: ROOT }, { grantRoot: true }, { grantRoot: '' }])('refuses crossed native request identity or broader grant %#', request => {
    const { store } = loaded();
    expect(store.forInteraction(interaction({}, request))).toBeUndefined();
  });
  it('permits absent or null grantRoot only for the exact bounded patch', () => {
    const { store } = loaded();
    expect(store.forInteraction(interaction({}, { grantRoot: null }))).toBeDefined();
  });
  it('binds the displayed digest to exact approval ID and generation', () => {
    const { store, current, context } = loaded();
    expect(() => store.assertCurrent(current, context.digest)).not.toThrow();
    for (const replaced of [interaction({ interactionId: OTHER }), interaction({ generation: 2 })]) {
      const replacement = store.forInteraction(replaced)!;
      expect(replacement).toBeDefined();
      expect(replacement.digest).not.toBe(context.digest);
      expect(() => store.assertCurrent(replaced, context.digest)).toThrow();
      expect(() => store.assertCurrent(replaced, replacement.digest)).not.toThrow();
    }
    expect(() => store.assertCurrent(current, '0'.repeat(64))).toThrow();
  });
  it('invalidates the old digest on clear, patch replacement and project/epoch changes', () => {
    const { store, current, context } = loaded();
    store.clear(); expect(store.forInteraction(current)).toBeUndefined();
    expect(() => store.assertCurrent(current, context.digest)).toThrow();
    store.snapshot(snapshot([item([change(`${ROOT}/a.txt`, 'update', '+changed\n')])]), ROOT);
    expect(() => store.assertCurrent(current, context.digest)).toThrow();
    const otherProject = snapshot(); otherProject.thread.projectId = OTHER;
    store.snapshot(otherProject, ROOT); expect(store.forInteraction(current)).toBeUndefined();
    const otherEpoch = snapshot(); otherEpoch.epoch = OTHER; otherEpoch.history.epoch = OTHER;
    store.snapshot(otherEpoch, ROOT); expect(store.forInteraction(current)).toBeUndefined();
  });
  it('copies snapshot and returned evidence so mutation cannot silently alter approval authority', () => {
    const store = new FileChangeContexts(), sourceChange = change(), data = snapshot([item([sourceChange])]), current = interaction();
    store.snapshot(data, ROOT);
    const context = store.forInteraction(current)!, digest = context.digest;
    sourceChange.diff = '+mutated native input\n';
    const sourceItem = ((data.history.items[0] as Native).items as Native[])[0];
    sourceItem.status = 'completed';
    expect(store.forInteraction(current)!.digest).toBe(digest);
    expect(store.forInteraction(current)!.changes[0].diff).toBe('+hello\n');
    // A frozen result or a detached mutable result are both safe public APIs.
    try { Object.assign(context.changes[0], { diff: '+mutated returned display\n', path: 'another.txt' }); } catch { /* Frozen proof. */ }
    expect(store.forInteraction(current)!.changes[0]).toEqual({ path: 'a.txt', kind: 'add', movePath: null, diff: '+hello\n' });
    expect(() => store.assertCurrent(current, digest)).not.toThrow();
  });
});
