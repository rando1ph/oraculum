import { useEffect, useRef, useState } from 'react';
import type { NativeOperationMethod, Thread } from '../../../packages/shared/protocol';
import { Icon } from './icons';

export type SessionAction = 'archive' | 'unarchive' | 'delete';
export type SessionNativeAction = { method: 'thread/name/set'; name: string } | { method: 'thread/fork' | 'review/start' | 'thread/compact/start' } | { method: 'thread/revert'; beforeTurnId: string; confirm: true };
export type SessionTarget = { thread: Thread; archived: boolean };
export const sessionLabel = (thread: Thread) => thread.name || thread.preview.slice(0, 42) || '新会话';
export function nativeNameError(value: string) {
  if (!value.trim()) return '请输入会话名称。';
  if ([...value.trim()].length > 128) return '会话名称不能超过 128 个字符。';
  if (/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)) return '名称不能包含控制字符或方向控制字符。';
  return '';
}

// These hints prevent accidental clicks; Bridge rechecks authoritative state.
export function sessionActionBlock(thread: Thread, current?: {
  active: boolean; pending: boolean; sendBlocked: boolean; synced: boolean;
}) {
  if (current?.pending || thread.status.type === 'active' && thread.status.activeFlags.includes('waitingOnApproval')) return '此会话有待处理审批，处理完成后才能操作。';
  if (current?.active || thread.status.type === 'active') return '此会话正在执行，请等待完成或停止后再操作。';
  if (current?.sendBlocked) return '此会话有尚未确认的发送结果，请先查询原生状态。';
  if (current && !current.synced) return '当前会话状态尚未确认，请先查询状态。';
  if (!['idle', 'notLoaded'].includes(thread.status.type)) return '原生状态异常或未知，请先查询状态。';
  if (thread.ephemeral) return '临时会话尚未保存，不能执行归档或删除。';
  if (thread.parentThreadId || typeof thread.source === 'object' && 'subAgent' in thread.source) return '此会话属于子代理，暂不支持单独归档或删除。';
  return '';
}

type NativeActions = {
  current: boolean; turns: { id: string; label: string }[]; blocked: string; renameBlocked: string; operationBlocks: Partial<Record<NativeOperationMethod, string>>;
  unsupported: NativeOperationMethod[];
  onAction: (action: SessionNativeAction) => Promise<void>;
};
export function SessionActions({ target, projectName, blocked, busy, native, onAction, onClose }: {
  target: SessionTarget; projectName: string; blocked: string; busy: boolean; native?: NativeActions;
  onAction: (action: SessionAction) => Promise<void>; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<'list' | 'delete' | 'rename' | 'fork' | 'revert' | 'confirmRevert' | 'plan'>('list');
  const [name, setName] = useState(target.thread.name || target.thread.preview.slice(0, 128));
  const [beforeTurnId, setBeforeTurnId] = useState(native?.turns.at(-1)?.id ?? '');
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => { if (view === 'delete' || view === 'confirmRevert' || view === 'fork') cancel.current?.focus(); else if (view === 'rename') { nameInput.current?.focus(); nameInput.current?.select(); } }, [view]);
  const unavailable = (method: NativeOperationMethod) => native?.unsupported.includes(method) ? '当前版本暂不支持' : '';
  const nativeBlocked = native?.blocked || blocked;
  const blockedFor = (method: NativeOperationMethod) => native?.operationBlocks[method] || (method === 'thread/name/set' ? native?.renameBlocked : nativeBlocked);
  function choose(next: typeof view) { setError(''); setView(next); }
  async function act(action: SessionAction) {
    if (blocked || busy) return;
    setError('');
    try { await onAction(action); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
  }
  async function actNative(action: SessionNativeAction) {
    if (!native || blockedFor(action.method) || busy || unavailable(action.method)) return;
    if (action.method === 'thread/name/set') {
      const invalid = nativeNameError(action.name);
      if (invalid) { setError(invalid); return; }
    }
    setError('');
    try { await native.onAction(action.method === 'thread/name/set' ? { ...action, name: action.name.trim() } : action); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
  }
  const title = { list: '会话操作', delete: '永久删除会话？', rename: '重命名会话', fork: '分叉会话？', revert: '回退会话', confirmRevert: '确认回退会话？', plan: 'Plan 模式' }[view];
  return <dialog ref={dialog} className="session-actions-dialog" aria-labelledby="session-action-title" aria-describedby="session-action-description"
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)'));
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}
    onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="session-actions-content">
      <header><h2 id="session-action-title">{title}</h2><button className="icon-button" aria-label="关闭会话操作" disabled={busy} onClick={onClose}><Icon name="close"/></button></header>
      <div className="session-action-subject"><Icon name={target.archived ? 'archive' : 'file'}/><span>{sessionLabel(target.thread)}</span></div>
      <p className="session-action-project">{projectName}</p>
      <p id="session-action-description">{view === 'delete' ? '删除后无法恢复此会话的原生历史。请确认这是你要永久删除的会话。'
        : view === 'fork' ? '新会话继承当前聊天历史，共享同一主机项目目录。分叉不会复制文件，也不会创建隔离工作目录。'
        : view === 'revert' || view === 'confirmRevert' ? '将移除选中轮次及之后的聊天历史。不会撤销已写到项目文件的修改。'
        : view === 'rename' ? '此名称会同步到使用同一会话的设备。'
        : view === 'plan' ? '当前版本暂不支持原生 Plan 模式。此功能仍属实验能力，为保证会话稳定暂未启用。'
        : target.archived ? '此会话已归档。恢复后可在会话列表中继续使用。' : '管理当前会话与原生运行操作。'}</p>
      {(view === 'rename' ? blockedFor('thread/name/set') : nativeBlocked) && <p className="history-warning" role="status">{view === 'rename' ? blockedFor('thread/name/set') : nativeBlocked}</p>}
      {view === 'list' && !nativeBlocked && native && Object.values(native.operationBlocks).some(Boolean) && <p className="history-warning" role="status">有操作结果尚未确认，请查询状态，勿重复操作。其他功能可继续使用。</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {view === 'rename' ? <form className="session-rename" onSubmit={event => { event.preventDefault(); void actNative({ method: 'thread/name/set', name }); }}>
        <label htmlFor="session-name">会话名称</label><input ref={nameInput} id="session-name" value={name} disabled={busy} autoComplete="off" onChange={event => { setName(event.target.value); setError(''); }}/>
        <div className="session-confirm-actions"><button type="button" disabled={busy} onClick={() => choose('list')}>取消</button><button className="primary" disabled={!!blockedFor('thread/name/set') || busy || !!unavailable('thread/name/set')}>{busy ? '正在保存…' : '保存名称'}</button></div>
      </form> : view === 'revert' ? <>
        <label className="session-turn-label" htmlFor="revert-turn">从这一轮开始移除</label><select id="revert-turn" value={beforeTurnId} disabled={busy} onChange={event => setBeforeTurnId(event.target.value)}>{native?.turns.map(turn => <option key={turn.id} value={turn.id}>{turn.label}</option>)}</select>
        <div className="session-confirm-actions"><button disabled={busy} onClick={() => choose('list')}>取消</button><button className="danger-button" disabled={!beforeTurnId || !!blockedFor('thread/revert') || busy || !!unavailable('thread/revert')} onClick={() => choose('confirmRevert')}>继续回退</button></div>
      </> : view === 'delete' || view === 'confirmRevert' || view === 'fork' ? <>
        {view === 'confirmRevert' && <p className="session-revert-selection">{native?.turns.find(turn => turn.id === beforeTurnId)?.label}</p>}
        <div className="session-confirm-actions"><button ref={cancel} disabled={busy} onClick={() => choose(view === 'confirmRevert' ? 'revert' : 'list')}>取消</button><button className={view === 'fork' ? 'primary' : 'danger-button'} disabled={!!(view === 'delete' ? blocked : blockedFor(view === 'fork' ? 'thread/fork' : 'thread/revert')) || busy} onClick={() => { if (view === 'delete') void act('delete'); else if (view === 'fork') void actNative({ method: 'thread/fork' }); else void actNative({ method: 'thread/revert', beforeTurnId, confirm: true }); }}>{busy ? '正在处理…' : view === 'delete' ? '确认永久删除' : view === 'fork' ? '确认分叉' : '确认移除历史'}</button></div>
      </> : view === 'plan' ? <div className="session-confirm-actions"><button onClick={() => choose('list')}>返回</button></div> : <div className="session-action-list">
        {native && !target.archived && <>
          <button disabled={!!blockedFor('thread/name/set') || busy || !!unavailable('thread/name/set')} onClick={() => choose('rename')}><Icon name="file"/><span>重命名</span><small>{unavailable('thread/name/set')}</small></button>
          {native.current && <>
            <button disabled={!!blockedFor('thread/fork') || busy || !native.turns.length || !!unavailable('thread/fork')} onClick={() => choose('fork')}><Icon name="plus"/><span>分叉会话</span><small>{unavailable('thread/fork')}</small></button>
            <button disabled={!!blockedFor('review/start') || busy || !!unavailable('review/start')} onClick={() => void actNative({ method: 'review/start' })}><Icon name="check"/><span>审阅未提交更改</span><small>{unavailable('review/start')}</small></button>
            <button disabled={!!blockedFor('thread/compact/start') || busy || !!unavailable('thread/compact/start')} onClick={() => void actNative({ method: 'thread/compact/start' })}><Icon name="terminal"/><span>压缩上下文</span><small>{unavailable('thread/compact/start')}</small></button>
            <button disabled={!!blockedFor('thread/revert') || busy || !native.turns.length || !!unavailable('thread/revert')} onClick={() => choose('revert')}><Icon name="restore"/><span>回退会话</span><small>{unavailable('thread/revert')}</small></button>
            <button disabled={busy} onClick={() => choose('plan')}><Icon name="file"/><span>Plan 模式</span><small>当前版本暂不支持</small></button>
          </>}
        </>}
        <button disabled={!!blocked || busy} onClick={() => void act(target.archived ? 'unarchive' : 'archive')}><Icon name={target.archived ? 'restore' : 'archive'}/><span>{target.archived ? '恢复归档' : '归档会话'}</span><small>{busy ? '正在处理…' : '可恢复'}</small></button><button className="danger-button" disabled={!!blocked || busy} onClick={() => choose('delete')}><Icon name="trash"/><span>永久删除</span><small>不可恢复</small></button>
      </div>}
    </div>
  </dialog>;
}
