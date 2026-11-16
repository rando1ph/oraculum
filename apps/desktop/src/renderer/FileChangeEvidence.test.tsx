import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Interaction } from '../../../../packages/gateway-protocol/src/index';
import type { FileChangeContext, WorkspaceState } from '../contracts/workspace';
import { FileChangeEvidence, validFileChangeContext } from './FileChangeEvidence';

function fixture() {
  const interaction: Interaction = { interactionId: 'approval', generation: 1, epoch: 'epoch', projectId: 'project', threadId: 'thread', turnId: 'turn',
    kind: 'fileChange', status: 'pending', request: { threadId: 'thread', turnId: 'turn', itemId: 'item', availableDecisions: ['accept', 'decline'] } };
  const context: FileChangeContext = { interactionId: 'approval', generation: 1, epoch: 'epoch', projectId: 'project', threadId: 'thread', turnId: 'turn', itemId: 'item',
    digest: 'a'.repeat(64), changes: [{ path: 'src/test.ts', kind: 'update', movePath: null, diff: '@@ -1 +1 @@\n-before\n+after' }] };
  const state: WorkspaceState = { connection: { status: 'connected', endpoint: 'http://127.0.0.1:7777/', epoch: 'epoch', secureStorage: true },
    projectId: 'project', threadId: 'thread', projects: [], roots: [], streamItems: [], interactions: [interaction], fileChangeContexts: { approval: context },
    synchronization: 'synchronizing', activeTurnId: 'turn', attachments: [], draftId: 'draft', operations: [], busy: false };
  return { state, context, interaction };
}

describe('file approval evidence binding', () => {
  it('accepts exact pending proof during an active Turn and a settled snapshot', () => {
    const { state, context, interaction } = fixture();
    expect(validFileChangeContext(state, interaction)).toBe(context);
    state.synchronization = 'current';
    expect(validFileChangeContext(state, interaction)).toBe(context);
    interaction.request.grantRoot = null;
    expect(validFileChangeContext(state, interaction)).toBe(context);
  });
  it.each(['interactionId', 'epoch', 'projectId', 'threadId', 'turnId', 'itemId'] as const)('rejects a different context %s', field => {
    const { state, context, interaction } = fixture(); context[field] = 'other';
    expect(validFileChangeContext(state, interaction)).toBeUndefined();
  });
  it('rejects a different generation, missing/invalid digest and unknown proof fields', () => {
    for (const patch of [{ generation: 2 }, { digest: '' }, { digest: 'a'.repeat(63) }, { digest: 'z'.repeat(64) }, { extra: true }]) {
      const { state, context, interaction } = fixture(); Object.assign(context, patch);
      expect(validFileChangeContext(state, interaction)).toBeUndefined();
    }
  });
  it('rejects stale, disconnected and differently selected workspaces', () => {
    for (const patch of [{ synchronization: 'stale' as const }, { projectId: 'other' }, { threadId: 'other' }]) {
      const { state, interaction } = fixture(); Object.assign(state, patch);
      expect(validFileChangeContext(state, interaction)).toBeUndefined();
    }
    for (const status of ['idle', 'connecting', 'pairing', 'offline', 'revoked', 'error'] as const) {
      const { state, interaction } = fixture(); state.connection.status = status;
      expect(validFileChangeContext(state, interaction)).toBeUndefined();
    }
    const { state, interaction } = fixture(); state.connection.epoch = 'other';
    expect(validFileChangeContext(state, interaction)).toBeUndefined();
  });
  it('requires the exact live pending interaction, not a cached prop or ordinary Diff', () => {
    for (const status of ['submitted', 'unknown', 'resolved'] as const) {
      const { state, interaction } = fixture(); interaction.status = status;
      expect(validFileChangeContext(state, interaction)).toBeUndefined();
    }
    const { state, interaction } = fixture();
    state.interactions = [];
    expect(validFileChangeContext(state, interaction)).toBeUndefined();
    state.interactions = [{ ...interaction, generation: 2 }];
    expect(validFileChangeContext(state, interaction)).toBeUndefined();
    state.interactions = [interaction]; state.fileChangeContexts = undefined; state.diff = '+ unrelated patch';
    expect(validFileChangeContext(state, interaction)).toBeUndefined();
    state.fileChangeContexts = Object.create({ approval: fixture().context }) as Record<string, FileChangeContext>;
    expect(validFileChangeContext(state, interaction)).toBeUndefined();
  });
  it('rejects unbound request identity, broader grants and incomplete evidence', () => {
    for (const patch of [{ threadId: 'other' }, { turnId: 'other' }, { itemId: 'other' }, { grantRoot: '' }, { grantRoot: 'project' }, { truncated: true }, { detailsAvailable: true }]) {
      const { state, interaction } = fixture(); Object.assign(interaction.request, patch);
      expect(validFileChangeContext(state, interaction)).toBeUndefined();
    }
    const { state, interaction } = fixture(); interaction.kind = 'command';
    expect(validFileChangeContext(state, interaction)).toBeUndefined();
  });
});

describe('file approval complete display bounds', () => {
  it('accepts at most 20 distinct files', () => {
    const { state, context, interaction } = fixture();
    context.changes = Array.from({ length: 20 }, (_, index) => ({ path: `file-${index}.ts`, kind: 'add', movePath: null, diff: '+safe' }));
    expect(validFileChangeContext(state, interaction)).toBe(context);
    context.changes.push({ path: 'extra.ts', kind: 'delete', movePath: null, diff: '-old' });
    expect(validFileChangeContext(state, interaction)).toBeUndefined();
    context.changes = [];
    expect(validFileChangeContext(state, interaction)).toBeUndefined();
  });
  it.each(['\n', '\r\n', '\r', '\u2028', '\u2029'])('bounds all patch line separators (%j)', separator => {
    const { state, context, interaction } = fixture();
    context.changes[0].diff = Array.from({ length: 256 }, () => '+line').join(separator);
    expect(validFileChangeContext(state, interaction)).toBe(context);
    context.changes.push({ path: 'second.ts', kind: 'add', movePath: null, diff: '+one more' });
    expect(validFileChangeContext(state, interaction)).toBeUndefined();
  });
  it('counts UTF-8 bytes over the complete displayed proof rather than JS characters', () => {
    const { state, context, interaction } = fixture();
    context.changes[0].diff = '+';
    const remaining = 16 * 1024 - new TextEncoder().encode(JSON.stringify(context)).byteLength;
    context.changes[0].diff += 'x'.repeat(remaining);
    expect(validFileChangeContext(state, interaction)).toBe(context);
    context.changes[0].diff += 'x';
    expect(validFileChangeContext(state, interaction)).toBeUndefined();
    context.changes[0].diff = '+'.concat('界'.repeat(6000));
    expect(context.changes[0].diff.length).toBeLessThan(16 * 1024);
    expect(validFileChangeContext(state, interaction)).toBeUndefined();
  });
  it.each(['/etc/passwd', '../outside', 'src/../outside', 'src//file', 'C:\\file', 'src\\file', 'https://host/file', 'src/%2e%2e/file', 'src/ x', 'src/x ', 'src/\u202efile', 'src/e\u0301.ts', '[主机路径]/file'])('rejects unsafe path %j', path => {
    const { state, context, interaction } = fixture(); context.changes[0].path = path;
    expect(validFileChangeContext(state, interaction)).toBeUndefined();
  });
  it('rejects changed/redacted/hidden patches and ambiguous move destinations', () => {
    for (const diff of ['', '   ', '+[主机路径]/file', '+[内容过深]', '+\0hidden', '+\u0085hidden', '+\u202ehidden']) {
      const { state, context, interaction } = fixture(); context.changes[0].diff = diff;
      expect(validFileChangeContext(state, interaction)).toBeUndefined();
    }
    for (const patch of [{ kind: 'unknown' }, { kind: 'add', movePath: 'after.ts' }, { movePath: '/outside' }, { movePath: 'src/test.ts' }, { movePath: '[内容过深]' }, { truncated: true }]) {
      const { state, context, interaction } = fixture(); Object.assign(context.changes[0], patch);
      expect(validFileChangeContext(state, interaction)).toBeUndefined();
    }
    const { state, context, interaction } = fixture();
    context.changes[0].movePath = 'after.ts';
    context.changes.push({ path: 'second.ts', kind: 'update', movePath: 'after.ts', diff: '+second' });
    expect(validFileChangeContext(state, interaction)).toBeUndefined();
    context.changes[1] = { path: 'src/test.ts', kind: 'delete', movePath: null, diff: '-same' };
    expect(validFileChangeContext(state, interaction)).toBeUndefined();
  });
  it('renders every file, move destination and last patch line as escaped text using the 10px Diff class', () => {
    const { context } = fixture();
    context.changes = [
      { path: 'src/<img>.ts', kind: 'update', movePath: 'src/after.ts', diff: '@@ -1 +1 @@\n-previous\n+<script>alert(1)\n+last-line' },
      { path: 'new.ts', kind: 'add', movePath: null, diff: '+new' },
      { path: 'old.ts', kind: 'delete', movePath: null, diff: '-old' },
    ];
    const html = renderToStaticMarkup(<FileChangeEvidence context={context} />);
    expect(html).toContain('src/&lt;img&gt;.ts'); expect(html).toContain('src/after.ts');
    expect(html).toContain('新增'); expect(html).toContain('删除'); expect(html).toContain('修改');
    expect(html).toContain('&lt;script&gt;alert(1)'); expect(html).toContain('+last-line');
    expect(html.match(/class="diff-code"/g)).toHaveLength(3);
    expect(html).not.toMatch(/<script|<img|<details|<button|href=|src=/);
  });
});
