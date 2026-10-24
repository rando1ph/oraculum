import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Approval, ThreadItem, Turn } from '../../../packages/shared/protocol';
import { elapsedTime, formatElapsed, groupTurns, hasTurnApproval, isProcessItem, needsAttention, processCounts, TurnProcess } from './process';
import type { ItemView } from './store';

const message = (id: string, phase: string | null = null) => ({ type: 'agentMessage', id, phase, text: id }) as ThreadItem;
const view = (item: ThreadItem, turnId = 'turn'): ItemView => ({ item, turnId, source: 'native', complete: true });
const turn = (patch: Partial<Turn> = {}) => ({ id: 'turn', status: 'completed', startedAt: 100, completedAt: 170, durationMs: 70000, error: null, items: [], itemsView: 'full', ...patch }) as Turn;

it('only hides native commentary, preserving final and unclassified model messages', () => {
  expect(isProcessItem(message('progress', 'commentary'))).toBe(true);
  for (const phase of ['final_answer', null, 'partial_answer', undefined]) expect(isProcessItem({ ...message('answer'), phase } as ThreadItem)).toBe(false);
});
it('uses native timing without treating absent values as zero or deriving time from thread dates', () => {
  expect(elapsedTime(turn(), 999999)).toBe(70000);
  expect(elapsedTime(turn({ durationMs: null }), 999999)).toBe(70000);
  expect(elapsedTime(turn({ status: 'inProgress', completedAt: null, durationMs: null }), 105000)).toBe(5000);
  expect(elapsedTime(turn({ startedAt: null, completedAt: null, durationMs: null }), 999999)).toBeUndefined();
  expect(elapsedTime(turn({ durationMs: null, completedAt: 99 }), 999999)).toBeUndefined();
  expect(elapsedTime(turn({ durationMs: 0 }), 999999)).toBe(0);
  expect(formatElapsed(70000)).toBe('1 分 10 秒');
  expect(formatElapsed(3601000)).toBe('1 小时 1 秒');
});
it('counts real calls and unique file/agent identities instead of events or delta updates', () => {
  const views = [
    view({ type: 'commandExecution', id: 'c' } as ThreadItem),
    ...['f1', 'f2'].map(id => view({ type: 'fileChange', id, changes: [{ path: '/a' }, { path: '/b' }] } as ThreadItem)),
    view({ type: 'mcpToolCall', id: 'm' } as ThreadItem),
    view({ type: 'collabAgentToolCall', id: 'a', receiverThreadIds: ['child'] } as ThreadItem),
    view({ type: 'subAgentActivity', id: 'b', agentThreadId: 'child' } as ThreadItem),
  ];
  expect(processCounts(views)).toBe('1 条命令 · 2 个文件 · 1 次工具调用 · 1 个子代理');
});
it('keeps turn and native item ordering without sorting by item type', () => {
  const views = [view(message('old'), 'old'), view(message('new'), 'new'), view(message('progress', 'commentary'), 'new')];
  const groups = groupTurns(views, { old: turn({ id: 'old' }), new: turn({ id: 'new' }), empty: turn({ id: 'empty', status: 'inProgress' }) });
  expect(groups.map(g => g.id)).toEqual(['old', 'new', 'empty']);
  expect(groups[1].views.map(v => v.item.id)).toEqual(['new', 'progress']);
  expect(groupTurns([view(message('new'), 'new')], { empty: turn({ id: 'empty' }), new: turn({ id: 'new' }) }).map(g => g.id)).toEqual(['empty', 'new']);
});
it('does not expand unrelated completed turns when a child thread needs approval', () => {
  const pending = [{ params: { threadId: 'child', turnId: 'child-turn' }, displayThreadIds: ['parent'] }] as Approval[];
  expect(hasTurnApproval(pending, 'parent', 'old-turn', 'active-turn')).toBe(false);
  expect(hasTurnApproval(pending, 'parent', 'active-turn', 'active-turn')).toBe(true);
  expect(hasTurnApproval(pending, 'unrelated', 'active-turn', 'active-turn')).toBe(false);
  expect(hasTurnApproval(pending, 'child', 'child-turn', 'child-turn')).toBe(true);
});
it('does not conceal failed tools, rejected patches, or interrupted subagents', () => {
  expect(needsAttention({ type: 'commandExecution', exitCode: 1, status: 'completed' } as ThreadItem)).toBe(true);
  expect(needsAttention({ type: 'fileChange', status: 'declined' } as ThreadItem)).toBe(true);
  expect(needsAttention({ type: 'mcpToolCall', status: 'completed', error: { message: 'error' } } as ThreadItem)).toBe(true);
  expect(needsAttention({ type: 'dynamicToolCall', success: false } as ThreadItem)).toBe(true);
  expect(needsAttention({ type: 'collabAgentToolCall', status: 'completed', agentsStates: { child: { status: 'interrupted', message: null } } } as unknown as ThreadItem)).toBe(true);
  expect(needsAttention(message('answer'))).toBe(false);
});
it('folds successful commentary but always renders final cards; failed and pending turns stay open', () => {
  const props = { id: 'turn', views: [view(message('progress', 'commentary')), view(message('final', 'final_answer')), view(message('unknown'))], pending: false, connected: true, showDiff: () => {}, showDetails: () => {}, onToggle: () => {} };
  const completed = renderToStaticMarkup(<TurnProcess {...props} turn={turn()}/>);
  expect(completed).toContain('aria-expanded="false"');
  expect(completed).toContain('class="process-records" hidden="" data-turn-id="turn" data-item-id="progress"');
  expect(completed).toContain('<div data-turn-id="turn" data-item-id="final">');
  expect(completed).toContain('<div data-turn-id="turn" data-item-id="unknown">');
  for (const extra of [{ pending: true }, { turn: turn({ status: 'failed', error: { message: 'error' } as Turn['error'] }) }, { turn: turn({ status: 'interrupted' }) }]) {
    const output = renderToStaticMarkup(<TurnProcess {...props} turn={turn()} {...extra}/>);
    expect(output).not.toContain('class="process-records" hidden=""');
    expect(output).not.toContain('aria-expanded="false"');
  }
});
