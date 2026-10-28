import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Thread } from '../../../packages/shared/protocol';
import { SessionActions, sessionActionBlock } from './session-actions';

const thread = { id: 'test-thread-12345678', name: '测试会话', preview: '', status: { type: 'idle' }, ephemeral: false,
  parentThreadId: null, source: 'appServer' } as Thread;
const current = { active: false, pending: false, sendBlocked: false, synced: true };

it('blocks lifecycle actions for live approvals, active turns, unresolved sends and stale snapshots', () => {
  expect(sessionActionBlock(thread, current)).toBe('');
  expect(sessionActionBlock(thread, { ...current, pending: true })).toContain('待处理审批');
  expect(sessionActionBlock(thread, { ...current, active: true })).toContain('正在执行');
  expect(sessionActionBlock(thread, { ...current, sendBlocked: true })).toContain('尚未确认');
  expect(sessionActionBlock(thread, { ...current, synced: false })).toContain('尚未确认');
  expect(sessionActionBlock({ ...thread, status: { type: 'active', activeFlags: ['waitingOnApproval'] } })).toContain('待处理审批');
  expect(sessionActionBlock({ ...thread, status: { type: 'active', activeFlags: [] } })).toContain('正在执行');
});

it('allows unloaded history but rejects ephemeral, child, error and future runtime states', () => {
  expect(sessionActionBlock({ ...thread, status: { type: 'notLoaded' } })).toBe('');
  expect(sessionActionBlock({ ...thread, ephemeral: true })).toContain('临时会话');
  expect(sessionActionBlock({ ...thread, parentThreadId: 'parent' })).toContain('子代理');
  expect(sessionActionBlock({ ...thread, source: { subAgent: 'review' } })).toContain('子代理');
  expect(sessionActionBlock({ ...thread, status: { type: 'systemError' } })).toContain('未知');
  expect(sessionActionBlock({ ...thread, status: { type: 'futureStatus' } } as unknown as Thread)).toContain('未知');
});

it('labels archive as recoverable and deletion as permanent before any confirmation is offered', () => {
  const markup = renderToStaticMarkup(<SessionActions target={{ thread, archived: false }} projectName="测试项目" blocked="" busy={false} onAction={async () => {}} onClose={() => {}}/>);
  expect(markup).toContain('归档会话');
  expect(markup).toContain('永久删除');
  expect(markup).toContain('不可恢复');
  expect(markup).toContain('测试项目');
  expect(markup).not.toContain('确认永久删除');
  const archived = renderToStaticMarkup(<SessionActions target={{ thread, archived: true }} projectName="测试项目" blocked="" busy={false} onAction={async () => {}} onClose={() => {}}/>);
  expect(archived).toContain('恢复归档');
  expect(archived).not.toContain('归档会话');
});

it('validates native names by Unicode character count and rejects hidden controls', async () => {
  const { nativeNameError } = await import('./session-actions');
  expect(nativeNameError('  ')).toContain('请输入');
  expect(nativeNameError('  中文会话 🧭  ')).toBe('');
  expect(nativeNameError('🧭'.repeat(128))).toBe('');
  expect(nativeNameError('🧭'.repeat(129))).toContain('128');
  for (const value of ['line\nname', 'a\u007fb', 'a\u0085b', 'a\u202eb', 'a\u2067b']) expect(nativeNameError(value)).toContain('控制字符');
});

it('exposes native controls for the selected session with isolated capability failures', () => {
  const markup = renderToStaticMarkup(<SessionActions target={{ thread, archived: false }} projectName="测试项目" blocked="" busy={false}
    native={{ current: true, turns: [{ id: 'turn-1', label: '第 1 轮' }], blocked: '', renameBlocked: '', operationBlocks: {}, unsupported: ['thread/compact/start'], onAction: async () => {} }} onAction={async () => {}} onClose={() => {}}/>);
  expect(markup).toContain('重命名');
  expect(markup).toContain('分叉会话');
  expect(markup).toContain('审阅未提交更改');
  expect(markup).toContain('回退会话');
  expect(markup).toMatch(/<button disabled=""><svg[^]*?<span>压缩上下文<\/span><small>当前版本暂不支持<\/small>/);
  expect(markup).toContain('归档会话');
  expect(markup).not.toContain('确认移除历史');
});

it('keeps unknown fork separate from rename and hides execution actions for other sessions', () => {
  const markup = renderToStaticMarkup(<SessionActions target={{ thread, archived: false }} projectName="测试项目" blocked="" busy={false}
    native={{ current: false, turns: [], blocked: '', renameBlocked: '', operationBlocks: { 'thread/fork': '结果未知' }, unsupported: [], onAction: async () => {} }} onAction={async () => {}} onClose={() => {}}/>);
  expect(markup).toContain('重命名');
  expect(markup).not.toContain('分叉会话');
  expect(markup).not.toContain('审阅未提交更改');
  expect(markup).not.toContain('压缩上下文');
});
