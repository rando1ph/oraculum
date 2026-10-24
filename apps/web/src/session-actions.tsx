import { useEffect, useRef, useState } from 'react';
import type { Thread } from '../../../packages/shared/protocol';
import { Icon } from './icons';

export type SessionAction = 'archive' | 'unarchive' | 'delete';
export type SessionTarget = { thread: Thread; archived: boolean };
export const sessionLabel = (thread: Thread) => thread.name || thread.preview.slice(0, 42) || '新会话';

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

export function SessionActions({ target, projectName, blocked, busy, onAction, onClose }: {
  target: SessionTarget; projectName: string; blocked: string; busy: boolean;
  onAction: (action: SessionAction) => Promise<void>; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => { if (confirmDelete) cancel.current?.focus(); }, [confirmDelete]);
  async function act(action: SessionAction) {
    if (blocked || busy) return;
    setError('');
    try { await onAction(action); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
  }
  return <dialog ref={dialog} className="session-actions-dialog" aria-labelledby="session-action-title" aria-describedby="session-action-description"
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const first = buttons[0], last = buttons.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}
    onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="session-actions-content">
      <header><h2 id="session-action-title">{confirmDelete ? '永久删除会话？' : '会话操作'}</h2><button className="icon-button" aria-label="关闭会话操作" disabled={busy} onClick={onClose}><Icon name="close"/></button></header>
      <div className="session-action-subject"><Icon name={target.archived ? 'archive' : 'file'}/><span>{sessionLabel(target.thread)}</span></div>
      <p className="session-action-project">{projectName} · {target.thread.id.slice(-8)}</p>
      <p id="session-action-description">{confirmDelete ? '删除后无法恢复此会话的原生历史。请确认这是你要永久删除的会话。' : target.archived ? '此会话已归档。恢复后可在会话列表中继续使用。' : '归档后可在「已归档」中恢复。永久删除无法恢复。'}</p>
      {blocked && <p className="history-warning" role="status">{blocked}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {confirmDelete ? <div className="session-confirm-actions"><button ref={cancel} disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button><button className="danger-button" disabled={!!blocked || busy} onClick={() => void act('delete')}>{busy ? '正在处理…' : '确认永久删除'}</button></div>
        : <div className="session-action-list"><button disabled={!!blocked || busy} onClick={() => void act(target.archived ? 'unarchive' : 'archive')}><Icon name={target.archived ? 'restore' : 'archive'}/><span>{target.archived ? '恢复归档' : '归档会话'}</span><small>{busy ? '正在处理…' : '可恢复'}</small></button><button className="danger-button" disabled={!!blocked || busy} onClick={() => setConfirmDelete(true)}><Icon name="trash"/><span>永久删除</span><small>不可恢复</small></button></div>}
    </div>
  </dialog>;
}
