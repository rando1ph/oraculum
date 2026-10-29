import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildAgents, orderedAgents } from './agent-tree';
import { TurnProcess } from './process';
import { useSession, type ItemView } from './store';
import type { AgentSummary } from '../../../packages/shared/subagents';
import type { ThreadItem } from '../../../packages/shared/protocol';

const view = (item: any): ItemView => ({ turnId: 'turn', item: item as ThreadItem, complete: true, source: 'native' });
const call = (id: string, tool: string, sender = 'root', receiver = 'child', status = 'running', message: string | null = null) => view({ id, type: 'collabAgentToolCall', tool, status: 'completed', senderThreadId: sender, receiverThreadIds: [receiver], agentsStates: { [receiver]: { status, message } }, prompt: 'Check project' });
const summary = (patch: Partial<AgentSummary> = {}): AgentSummary => ({ id: 'child', parentThreadId: 'root', nickname: 'Ada', role: 'reviewer', status: 'running', turnId: 'child-turn', startedAt: 100, progress: 'Native progress', result: null, generation: 'bridge-one', revision: 1, ...patch });

it('uses native spawn/metadata relations, stable identities and explicit missing-state fallbacks', () => {
  const views = [call('spawn', 'spawnAgent'), call('nested', 'spawnAgent', 'child', 'nested', 'completed', 'Nested result'),
    view({ type: 'subAgentActivity', id: 'path', kind: 'interacted', agentThreadId: 'child', agentPath: '/agents/check' }), call('unknown', 'wait', 'root', 'other', 'pendingInit')];
  const nodes = buildAgents(views, 'root', { child: summary() });
  expect(nodes.find(node => node.id === 'child')).toMatchObject({ name: 'Ada', role: 'reviewer', parentId: 'root', progress: 'Native progress' });
  expect(nodes.find(node => node.id === 'nested')).toMatchObject({ parentId: 'child', status: 'completed', result: 'Nested result' });
  expect(nodes.find(node => node.id === 'other')!.parentId).toBeNull();
  expect(orderedAgents(nodes, 'root').map(({ node, depth }) => [node.id, depth])).toEqual([['child', 0], ['nested', 1], ['other', 0]]);
  expect(buildAgents([view({ type: 'enteredReviewMode', id: 'review' }), view({ type: 'contextCompaction', id: 'compact' })], 'root')).toEqual([]);
});

it('deduplicates agents and retains terminal state across late wait/activity; explicit followup can start a new run', () => {
  const views = [call('spawn', 'spawnAgent'), call('wait-final', 'wait', 'root', 'child', 'completed', 'Done'), call('late-wait', 'wait'),
    view({ type: 'subAgentActivity', id: 'late-start', kind: 'started', agentThreadId: 'child', agentPath: '' })];
  expect(buildAgents(views, 'root')).toMatchObject([{ id: 'child', status: 'completed', result: 'Done' }]);
  expect(buildAgents([...views, call('followup', 'followupTask')], 'root')).toMatchObject([{ id: 'child', status: 'running', result: null }]);
});

it('handles missing metadata, empty results, and corrupt/cyclic ancestry without recursion or fabricated headings', () => {
  expect(buildAgents([], 'root')).toEqual([]);
  const nodes = buildAgents([call('a', 'spawnAgent', 'nested', 'child'), call('b', 'spawnAgent', 'child', 'nested')], 'root');
  expect(orderedAgents(nodes, 'root')).toHaveLength(2); expect(nodes.some(node => node.parentId === null)).toBe(true);
  const missing = buildAgents([view({ type: 'subAgentActivity', id: 'only', kind: 'interacted', agentThreadId: 'id', agentPath: '' })], 'root')[0];
  expect(missing).toMatchObject({ name: '子代理 id', status: 'unknown', parentId: null, result: null });
});

it('aggregates native collaboration in the existing process and keeps failures visible after a successful parent finishes', () => {
  const markup = renderToStaticMarkup(<TurnProcess id="turn" threadId="root" turn={{ id: 'turn', status: 'completed', items: [], error: null } as any}
    views={[call('spawn', 'spawnAgent'), call('failed', 'wait', 'root', 'child', 'errored', 'Read failed')]}
    pending={false} connected={false} showDiff={() => {}} showDetails={() => {}} showAgent={() => {}} onToggle={() => {}}/>);
  expect(markup).toContain('subagent-tree'); expect(markup).toContain('data-agent-state="errored"'); expect(markup).toContain('Read failed');
  expect(markup).toContain('上次可见状态'); expect(markup).not.toContain('class="process-records" hidden=""');
});

it('isolates projections by selected thread and discards stale snapshots and late duplicate collaboration states', () => {
  const state = useSession; state.getState().reset();
  state.getState().snapshot({ thread: { id: 'root', turns: [] } as any, pending: [] });
  state.getState().subagent(summary(), ['other']); expect(state.getState().agents).toEqual({});
  state.getState().subagent(summary({ status: 'completed', result: 'Done', revision: 5 }), ['root']);
  state.getState().snapshot({ thread: { id: 'root', turns: [] } as any, pending: [], agents: [summary({ revision: 2 })] });
  expect(state.getState().agents.child.status).toBe('completed');
  const final = call('item', 'wait', 'root', 'child', 'completed', 'Done').item;
  const late = call('item', 'wait').item;
  state.getState().event({ method: 'item/completed', params: { threadId: 'root', turnId: 'turn', item: final, completedAtMs: 100000 } });
  state.getState().event({ method: 'item/completed', params: { threadId: 'root', turnId: 'turn', item: late, completedAtMs: 100001 } });
  expect(buildAgents(Object.values(state.getState().items), 'root')[0].status).toBe('completed');
  state.getState().snapshot({ thread: { id: 'other', turns: [] } as any, pending: [] });
  expect(state.getState().agents).toEqual({}); state.getState().reset();
});
