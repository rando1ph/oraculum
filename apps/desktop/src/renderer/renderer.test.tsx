import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Interaction } from '../../../../packages/gateway-protocol/src/index';
import type { WorkspaceState } from '../contracts/workspace';
import { Markdown, conversationItems, nativeText } from './Native';
import { approvalDecisions, approvalLimitation, InteractionCard } from './Interactions';
import { WorkspaceInspector } from './Inspector';
import { canAnswerInteraction, canControlTurn, canSendFirstTurn, canWrite, canWriteScope, draftKey, hasPendingOperation, useWorkspace } from './store';
import { Composer, ThreadActions, confirmationScope } from './App';

function workspace(patch: Partial<WorkspaceState> = {}): WorkspaceState {
  return { connection: { status: 'connected', endpoint: 'http://127.0.0.1:7777/', installationId: 'install', deviceId: 'device', epoch: 'epoch', secureStorage: true },
    projectId: 'project', threadId: 'thread', thread: { id: 'thread', projectId: 'project', status: 'idle', archived: false, parentThreadId: null, title: 'Example' },
    projects: [], roots: [], streamItems: [], interactions: [], synchronization: 'current',
    attachments: [], draftId: 'draft', operations: [], busy: false, ...patch };
}
function interaction(patch: Partial<Interaction> = {}): Interaction {
  return { interactionId: 'interaction', epoch: 'epoch', generation: 1, projectId: 'project', threadId: 'thread', turnId: 'turn', kind: 'command', status: 'pending', request: { command: 'pwd' }, ...patch };
}
function activeWorkspace(patch: Partial<WorkspaceState> = {}): WorkspaceState {
  return workspace({ synchronization: 'synchronizing', activeTurnId: 'turn', capabilities: {
    capabilities: ['turn.interrupt', 'turn.steer', 'interactions'].map(name => ({ name, supported: true, availability: 'available', verified: true, maturity: 'default-surface', epoch: 'epoch', observedVersion: null, reasonCode: null })),
    codex: { connectionState: 'connected', version: null }, epoch: 'epoch', gatewayVersion: 'test', installationId: 'install',
    protocol: { major: 2, minor: 1, minClientMinor: 0 },
    limits: { attachmentBatchBytes: 1, attachmentBatchCount: 1, attachmentFileBytes: 1, eventReplayCount: 1, historyPageItems: 1, requestBytes: 1 },
  }, ...patch });
}
function lifecycleWorkspace(patch: Partial<WorkspaceState> = {}): WorkspaceState {
  const state = activeWorkspace({ synchronization: 'current', activeTurnId: undefined, ...patch });
  state.capabilities!.capabilities.push(...['turn.start', 'attachments', 'thread.name.set', 'thread.resume', 'thread.fork', 'thread.compact', 'thread.archive', 'thread.unarchive', 'thread.delete', 'thread.revert'].map(name => ({
    name, supported: true, availability: 'available' as const, verified: true, maturity: 'default-surface' as const, epoch: 'epoch', observedVersion: null, reasonCode: null,
  })));
  return state;
}
afterEach(() => { vi.unstubAllGlobals(); useWorkspace.setState({ workspace: null, pending: false, error: '', drafts: {} }); });

describe('Desktop renderer safe projections', () => {
  it('renders GFM without HTML, external images, link navigation or executable URLs', () => {
    const html = renderToStaticMarkup(<Markdown text={'# Hello\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n![tracking](https://example.invalid/pixel.png)\n\n[link](https://example.invalid/)\n\n[script](javascript:alert(1))'} />);
    expect(html).toContain('<table>');
    expect(html).not.toMatch(/<script|<img|href=|src=|javascript:/);
    expect(html).toContain('tracking');
    expect(html).toContain('link');
  });
  it('overlays stream items once per native turn/item identity', () => {
    const state = workspace({ history: { epoch: 'epoch', historyRevision: 'revision', complete: true, truncated: false, source: 'native-pagination', nextCursor: null,
      items: [{ id: 'first', status: 'completed', items: [{ id: 'same', type: 'agentMessage', text: 'first' }] }, { id: 'second', status: 'inProgress', items: [{ id: 'same', type: 'agentMessage', text: 'old' }] }] },
      streamItems: [{ turnId: 'second', item: { id: 'same', type: 'agentMessage', data: { text: 'updated' } } }] });
    const items = conversationItems(state);
    expect(items).toHaveLength(2);
    expect(nativeText(items[0].item)).toBe('first');
    expect(nativeText(items[1].item)).toBe('updated');
    expect(nativeText({ id: 'reasoning', type: 'reasoning', data: { content: ['thinking'] } })).toBe('thinking');
  });
  it('invalidates implicit-scope confirmations when identity, epoch or selection changes', () => {
    const state = workspace(), scope = confirmationScope(state);
    expect(confirmationScope({ ...state, threadId: 'another' })).not.toBe(scope);
    expect(confirmationScope({ ...state, projectId: 'another' })).not.toBe(scope);
    expect(confirmationScope({ ...state, connection: { ...state.connection, epoch: 'another' } })).not.toBe(scope);
    expect(confirmationScope({ ...state, connection: { ...state.connection, deviceId: 'another' } })).not.toBe(scope);
    expect(confirmationScope({ ...state, notice: 'native stream update' })).toBe(scope);
  });
  it('keeps offline and stale projections read-only while allowing an explicit first-turn permit only for send', () => {
    expect(canWrite(workspace())).toBe(true);
    expect(canWrite(workspace({ synchronization: 'stale' }))).toBe(false);
    expect(canSendFirstTurn(workspace({ synchronization: 'stale' }))).toBe(false);
    expect(canSendFirstTurn(workspace({ synchronization: 'stale', firstTurnReady: true }))).toBe(true);
    expect(canWrite(workspace({ synchronization: 'stale', firstTurnReady: true }))).toBe(false);
    const offline = workspace(); offline.connection.status = 'offline'; offline.firstTurnReady = true;
    expect(canSendFirstTurn(offline)).toBe(false);
  });
  it('does not expand a different-thread unknown operation to unrelated thread writes', () => {
    const state = workspace({ operations: [{ operationId: 'operation', kind: 'turn.start', status: 'unknown', createdAt: 0, projectId: 'project', threadId: 'other' }] });
    expect(hasPendingOperation(state)).toBe(false);
    expect(canWrite(state)).toBe(true);
    expect(canWriteScope(state, 'project')).toBe(false);
    expect(canWriteScope({ ...state, projectId: 'other-project' }, 'project')).toBe(true);
    expect(canWriteScope(state, 'identity')).toBe(false);
  });
  it('scopes drafts to endpoint, identity, project and thread while preserving text across attachment draft rotation', () => {
    const state = workspace(), key = draftKey(state);
    useWorkspace.getState().setDraft(key, { text: 'keep me' });
    expect(draftKey({ ...state, draftId: 'new-upload-batch' })).toBe(key);
    expect(draftKey({ ...state, threadId: 'other' })).not.toBe(key);
    expect(draftKey({ ...state, connection: { ...state.connection, deviceId: 'other' } })).not.toBe(key);
    expect(useWorkspace.getState().drafts[key].text).toBe('keep me');
  });
  it('does not replace a newer event with a stale IPC action result or dispatch duplicate concurrent intents', async () => {
    let finish!: (state: WorkspaceState) => void;
    const invoke = vi.fn(() => new Promise<WorkspaceState>(resolve => { finish = resolve; }));
    vi.stubGlobal('window', { oraculumDesktop: { workspaceAction: invoke } });
    const first = useWorkspace.getState().act({ type: 'refresh' });
    await useWorkspace.getState().act({ type: 'refresh' });
    const fresh = workspace({ notice: 'newer-event' });
    useWorkspace.getState().receive(fresh);
    finish(workspace({ notice: 'stale-result' })); await first;
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(useWorkspace.getState().workspace?.notice).toBe('newer-event');
  });
});

describe('verified thread lifecycle controls', () => {
  it('requires verified unarchived state for sends, preserving only an explicit fresh-thread permit', () => {
    const state = workspace();
    expect(canSendFirstTurn(state)).toBe(true);
    for (const archived of [true, undefined]) {
      state.thread = { ...state.thread!, archived };
      expect(canSendFirstTurn(state)).toBe(false);
    }
    state.firstTurnReady = true;
    expect(canSendFirstTurn(state)).toBe(true);
    state.synchronization = 'stale';
    expect(canSendFirstTurn(state)).toBe(true);
    state.thread!.archived = true;
    expect(canSendFirstTurn(state)).toBe(false);
    state.thread!.archived = false;
    state.connection.status = 'offline';
    expect(canSendFirstTurn(state)).toBe(false);
  });
  it('blocks steering archived or unknown threads while retaining the observed-Turn Stop exception', () => {
    const state = activeWorkspace();
    for (const archived of [true, undefined]) {
      state.thread = { ...state.thread!, archived };
      expect(canControlTurn(state, 'steer')).toBe(false);
      expect(canControlTurn(state, 'interrupt')).toBe(true);
    }
    state.firstTurnReady = true;
    expect(canControlTurn(state, 'steer')).toBe(false);
    state.thread!.archived = false;
    expect(canControlTurn(state, 'steer')).toBe(true);
  });
  it.each([true, undefined])('disables sending, uploading and removing attachments when archived is %s', archived => {
    const state = lifecycleWorkspace(); state.thread = { ...state.thread!, archived };
    state.attachments = [{ id: 'attachment', projectId: 'project', threadId: 'thread', draftId: 'draft', kind: 'document',
      mime: 'text/plain', name: 'draft.txt', size: 5, state: 'ready', expiresAt: null }];
    useWorkspace.getState().setDraft(draftKey(state), { text: 'message' });
    const html = renderToStaticMarkup(<Composer state={state} pending={false} act={async () => undefined} />);
    for (const label of ['发送消息', '选择并上传本机附件', '移除附件 draft.txt']) {
      const button = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
      expect(button).toBeDefined(); expect(button).toContain('disabled');
    }
  });
  it('shows an explicit unavailable archive control for unknown state without disabling unrelated actions', () => {
    const state = lifecycleWorkspace(); state.thread = { ...state.thread!, archived: undefined };
    const html = renderToStaticMarkup(<ThreadActions state={state} disabled={false} pending={false} act={async () => undefined} confirm={() => {}} />);
    expect(html.match(/<button[^>]*>归档状态未确认<\/button>/)?.[0]).toContain('disabled');
    expect(html).toContain('归档状态尚未核实，请刷新会话列表后再归档或取消归档。');
    for (const label of ['保存名称', '创建会话分支', '压缩上下文', '删除会话']) {
      const button = html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0];
      expect(button).toBeDefined(); expect(button).not.toContain('disabled');
    }
  });
  it.each([false, true])('blocks child-thread lifecycle operations but keeps independent operations available (archived=%s)', archived => {
    const state = lifecycleWorkspace(); state.thread = { ...state.thread!, archived, parentThreadId: 'parent' };
    const html = renderToStaticMarkup(<ThreadActions state={state} disabled={false} pending={false} act={async () => undefined} confirm={() => {}} />);
    for (const label of [archived ? '取消归档' : '归档会话', '删除会话']) {
      const button = html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0];
      expect(button).toBeDefined(); expect(button).toContain('disabled');
    }
    for (const label of ['保存名称', '创建会话分支', '压缩上下文']) {
      const button = html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0];
      expect(button).toBeDefined(); expect(button).not.toContain('disabled');
    }
    expect(html.match(/<select[^>]*id="revert-target"[^>]*>/)?.[0]).not.toContain('disabled');
    expect(html).toContain('此会话属于子代理，Gateway 不允许单独归档、取消归档或删除。');
  });
  it.each([false, true])('offers the correct lifecycle action for a known root thread (archived=%s)', archived => {
    const state = lifecycleWorkspace(); state.thread = { ...state.thread!, archived };
    const html = renderToStaticMarkup(<ThreadActions state={state} disabled={false} pending={false} act={async () => undefined} confirm={() => {}} />);
    const label = archived ? '取消归档' : '归档会话';
    const button = html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0];
    expect(button).toBeDefined(); expect(button).not.toContain('disabled');
  });
});

describe('Native approval display safety', () => {
  it('keeps Stop available during an active synchronizing Turn', () => {
    const html = renderToStaticMarkup(<Composer state={activeWorkspace()} pending={false} act={async () => undefined} />);
    const stop = html.match(/<button[^>]*>停止<\/button>/)?.[0];
    expect(stop).toBeDefined(); expect(stop).not.toContain('disabled');
  });
  it('allows steering an observed active Turn but keeps new sends and lifecycle writes locked', () => {
    const state = activeWorkspace();
    expect(canControlTurn(state, 'steer')).toBe(true);
    expect(canSendFirstTurn(state)).toBe(false); expect(canWrite(state)).toBe(false);
    expect(canControlTurn({ ...state, synchronization: 'stale' }, 'steer')).toBe(false);
    expect(canControlTurn({ ...state, activeTurnId: undefined }, 'interrupt')).toBe(false);
    expect(canControlTurn({ ...state, busy: true }, 'interrupt')).toBe(false);
    expect(canControlTurn(state, 'interrupt', true)).toBe(false);
    expect(canControlTurn({ ...state, connection: { ...state.connection, status: 'offline' } }, 'interrupt')).toBe(false);
  });
  it('lets Stop bypass unrelated unknown writes but never retries an unresolved Stop', () => {
    const state = activeWorkspace({ operations: [{ operationId: 'write', kind: 'turn.start', status: 'unknown', createdAt: 0, projectId: 'project', threadId: 'thread' }] });
    expect(canControlTurn(state, 'interrupt')).toBe(true);
    expect(canControlTurn(state, 'steer')).toBe(false);
    state.operations[0].kind = 'turn.interrupt';
    expect(canControlTurn(state, 'interrupt')).toBe(false);
    state.operations[0].threadId = 'other-thread';
    expect(canControlTurn(state, 'interrupt')).toBe(true);
  });
  it('allows current pending command/input/elicitation facts during synchronization without unlocking stale facts', () => {
    for (const kind of ['command', 'input', 'elicitation']) {
      const current = interaction({ kind });
      const state = activeWorkspace({ interactions: [current] });
      expect(canAnswerInteraction(state, current)).toBe(true);
      expect(canAnswerInteraction(state, { ...current, generation: 2 })).toBe(false);
      expect(canAnswerInteraction({ ...state, interactions: [] }, current)).toBe(false);
      expect(canAnswerInteraction({ ...state, synchronization: 'stale' }, current)).toBe(false);
      expect(canAnswerInteraction({ ...state, connection: { ...state.connection, status: 'offline' } }, current)).toBe(false);
      expect(canAnswerInteraction(state, current, true)).toBe(false);
    }
    const current = interaction(), state = activeWorkspace({ interactions: [current], commandScopes: { interaction: { relativeCwd: '.' } } });
    const html = renderToStaticMarkup(<InteractionCard interaction={current} state={state} disabled={false} act={async () => undefined} />);
    expect(html).not.toContain('disabled=""');
  });
  it('independently locks stale interaction projections even when the caller is not busy', () => {
    const current = interaction();
    const html = renderToStaticMarkup(<InteractionCard interaction={current} state={workspace({ interactions: [current], synchronization: 'stale' })} disabled={false} act={async () => undefined} />);
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(3);
  });
  it('intersects plain native decisions and never invents acceptance for structured grants', () => {
    expect(approvalDecisions(interaction({ request: { availableDecisions: [{ acceptWithExecpolicyAmendment: {} }, 'decline'] } }))).toEqual(['decline']);
    expect(approvalDecisions(interaction({ request: { availableDecisions: [] } }))).toEqual([]);
    expect(approvalDecisions(interaction())).toEqual(['accept', 'decline', 'cancel']);
  });
  it('requires reviewable command evidence and refuses unbound file-change acceptance', () => {
    expect(approvalLimitation(interaction(), '.')).toBeUndefined();
    expect(approvalLimitation(interaction())).toBeTruthy();
    expect(approvalLimitation(interaction({ request: {} }))).toBeTruthy();
    expect(approvalLimitation(interaction({ request: { command: 'pwd', kind: 'writeStdin' } }))).toBeTruthy();
    expect(approvalLimitation(interaction({ kind: 'fileChange', request: { diff: '+ unbound' } }))).toBeTruthy();
  });
  it('refuses command acceptance without an exact main-process cwd scope marker', () => {
    const current = interaction(), state = activeWorkspace({ interactions: [current] });
    const candidates: WorkspaceState['commandScopes'][] = [undefined, {}, { another: { relativeCwd: '.' } },
      Object.create({ interaction: { relativeCwd: '.' } }), { interaction: { relativeCwd: '..' } } as unknown as WorkspaceState['commandScopes']];
    for (const scopes of candidates) {
      state.commandScopes = scopes;
      const html = renderToStaticMarkup(<InteractionCard interaction={current} state={state} disabled={false} act={async () => undefined} />);
      expect(html.match(/<button[^>]*>允许本次<\/button>/)?.[0]).toContain('disabled');
      expect(html.match(/<button[^>]*>拒绝<\/button>/)?.[0]).not.toContain('disabled');
    }
  });
  it('shows the verified command cwd as current project root and keeps network-only approvals independent', () => {
    const current = interaction(), state = activeWorkspace({ interactions: [current], commandScopes: { interaction: { relativeCwd: '.' } } });
    const html = renderToStaticMarkup(<InteractionCard interaction={current} state={state} disabled={false} act={async () => undefined} />);
    expect(html).toContain('执行目录 · 当前项目根目录');
    expect(html.match(/<button[^>]*>允许本次<\/button>/)?.[0]).not.toContain('disabled');
    const network = interaction({ request: { networkApprovalContext: { host: 'example.invalid', protocol: 'https' } } });
    const networkHtml = renderToStaticMarkup(<InteractionCard interaction={network} state={activeWorkspace({ interactions: [network] })} disabled={false} act={async () => undefined} />);
    expect(networkHtml).toContain('example.invalid');
    expect(networkHtml.match(/<button[^>]*>允许本次<\/button>/)?.[0]).not.toContain('disabled');
    network.request.command = 'pwd';
    const withCommand = renderToStaticMarkup(<InteractionCard interaction={network} state={activeWorkspace({ interactions: [network] })} disabled={false} act={async () => undefined} />);
    expect(withCommand.match(/<button[^>]*>允许本次<\/button>/)?.[0]).toContain('disabled');
  });
  it('renders complete bound file evidence and enables only the native offered acceptance', () => {
    const current = interaction({ kind: 'fileChange', request: { threadId: 'thread', turnId: 'turn', itemId: 'item', grantRoot: null } });
    const state = activeWorkspace({ interactions: [current], fileChangeContexts: { interaction: {
      interactionId: 'interaction', generation: 1, epoch: 'epoch', projectId: 'project', threadId: 'thread', turnId: 'turn', itemId: 'item', digest: 'a'.repeat(64),
      changes: [{ path: 'src/example.ts', kind: 'update', movePath: null, diff: '-old\n+<script>escaped</script>' }],
    } } });
    const html = renderToStaticMarkup(<InteractionCard interaction={current} state={state} disabled={false} act={async () => undefined} />);
    expect(html).toContain('src/example.ts'); expect(html).toContain('+&lt;script&gt;escaped&lt;/script&gt;');
    expect(html.match(/<button[^>]*>允许本次<\/button>/)?.[0]).not.toContain('disabled');
    current.request.availableDecisions = ['decline'];
    expect(renderToStaticMarkup(<InteractionCard interaction={current} state={state} disabled={false} act={async () => undefined} />)).not.toMatch(/<button[^>]*>允许本次<\/button>/);
  });
  it('never uses ordinary Inspector Diff or a mismatched proof to unlock file acceptance', () => {
    const current = interaction({ kind: 'fileChange', request: { threadId: 'thread', turnId: 'turn', itemId: 'item', grantRoot: null } });
    const state = activeWorkspace({ interactions: [current], diff: '+ complete-looking but unbound', fileChangeContexts: { interaction: {
      interactionId: 'interaction', generation: 1, epoch: 'epoch', projectId: 'project', threadId: 'thread', turnId: 'another-turn', itemId: 'item', digest: 'a'.repeat(64),
      changes: [{ path: 'src/example.ts', kind: 'update', movePath: null, diff: '-old\n+new' }],
    } } });
    const html = renderToStaticMarkup(<InteractionCard interaction={current} state={state} disabled={false} act={async () => undefined} />);
    expect(html.match(/<button[^>]*>允许本次<\/button>/)?.[0]).toContain('disabled');
    expect(html.match(/<button[^>]*>拒绝<\/button>/)?.[0]).not.toContain('disabled');
  });
  it('disables old epoch and unknown interaction cards', () => {
    const html = renderToStaticMarkup(<InteractionCard interaction={interaction({ epoch: 'old', status: 'unknown' })} state={workspace()} disabled={false} act={async () => undefined} />);
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(3);
  });
  it('keeps a remounted pending interaction locked behind its unresolved response journal', () => {
    const state = workspace({ operations: [{ operationId: 'response', kind: 'interaction.respond', status: 'unknown', createdAt: 0, projectId: 'project', threadId: 'thread' }] });
    const html = renderToStaticMarkup(<InteractionCard interaction={interaction()} state={state} disabled={false} act={async () => undefined} />);
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(3);
    expect(html).toContain('本会话有原生回应等待核实');
  });
  it('keeps Inspector file previews on bounded raster data URLs and escapes text', () => {
    const base = workspace({ preview: { name: 'x', mime: 'image/svg+xml', image: 'data:image/svg+xml;base64,PHN2Zz4=', limited: false } });
    expect(renderToStaticMarkup(<WorkspaceInspector state={base} panel="files" disabled={false} act={async () => undefined} />)).not.toContain('<img');
    base.preview = { name: 'x', mime: 'text/plain', text: '<script>alert(1)</script>', limited: false };
    const html = renderToStaticMarkup(<WorkspaceInspector state={base} panel="files" disabled={false} act={async () => undefined} />);
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
  });
});
