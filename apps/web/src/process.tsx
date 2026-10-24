import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { Approval, ThreadItem, Turn } from '../../../packages/shared/protocol';
import { Item } from './content';
import { Icon } from './icons';
import type { ItemView } from './store';
import './process.css';

// Unknown message phases remain visible. Only the native commentary phase is
// known to be progress; guessing from prose or position can hide an answer.
export function isProcessItem(item: ThreadItem) {
  return item.type !== 'userMessage' && (item.type !== 'agentMessage' || item.phase === 'commentary');
}

export function needsAttention(item: ThreadItem) {
  return ('status' in item && ['failed', 'declined', 'interrupted', 'cancelled'].includes(item.status))
    || (item.type === 'commandExecution' && item.exitCode != null && item.exitCode !== 0)
    || (item.type === 'mcpToolCall' && item.error != null)
    || (item.type === 'dynamicToolCall' && item.success === false)
    || (item.type === 'collabAgentToolCall' && Object.values(item.agentsStates).some(agent => agent && ['errored', 'interrupted', 'notFound'].includes(agent.status)))
    || (item.type === 'imageGeneration' && item.failure != null)
    || (item.type === 'subAgentActivity' && item.kind === 'interrupted');
}

export function elapsedTime(turn: Turn | undefined, now: number): number | undefined {
  if (!turn) return;
  if (turn.status !== 'inProgress' && typeof turn.durationMs === 'number' && Number.isFinite(turn.durationMs) && turn.durationMs >= 0) return turn.durationMs;
  if (typeof turn.startedAt !== 'number' || !Number.isFinite(turn.startedAt)) return;
  const end = turn.status === 'inProgress' ? now : typeof turn.completedAt === 'number' ? turn.completedAt * 1000 : undefined;
  if (end === undefined || !Number.isFinite(end) || end < turn.startedAt * 1000) return;
  return end - turn.startedAt * 1000;
}

export function formatElapsed(ms: number) {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分` : '', `${seconds % 60} 秒`].filter(Boolean).join(' ');
}

export function processCounts(views: ItemView[]) {
  let commands = 0, tools = 0;
  const files = new Set<string>(), agents = new Set<string>();
  for (const { item } of views) {
    if (item.type === 'commandExecution') commands++;
    if (item.type === 'fileChange') for (const change of item.changes) files.add(change.path);
    if (['mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(item.type)) tools++;
    if (item.type === 'collabAgentToolCall') for (const id of item.receiverThreadIds) agents.add(id);
    if (item.type === 'subAgentActivity') agents.add(item.agentThreadId);
  }
  return [commands ? `${commands} 条命令` : '', files.size ? `${files.size} 个文件` : '', tools ? `${tools} 次工具调用` : '', agents.size ? `${agents.size} 个子代理` : ''].filter(Boolean).join(' · ');
}

export function groupTurns(items: ItemView[], turns: Record<string, Turn>) {
  const groups = new Map<string, ItemView[]>(Object.keys(turns).map(id => [id, []]));
  for (const view of items) {
    if (!groups.has(view.turnId)) groups.set(view.turnId, []);
    groups.get(view.turnId)!.push(view);
  }
  return [...groups].map(([id, views]) => ({ id, views, turn: turns[id] }));
}

export function hasTurnApproval(pending: Approval[], threadId: string | undefined, turnId: string, activeTurn: string | undefined) {
  return pending.some(request => request.params.threadId === threadId
    ? request.params.turnId === turnId || (request.params.turnId == null && activeTurn === turnId)
    : activeTurn === turnId && !!threadId && !!request.displayThreadIds?.includes(threadId));
}

type Props = {
  id: string; threadId?: string; turn?: Turn; views: ItemView[]; pending: boolean; connected: boolean; synced?: boolean;
  plan?: string; planAfter?: string; diff?: string; cwd?: string;
  showDiff: (path: string, diff: string) => void;
  showDetails: (item: ThreadItem, turnId: string) => void;
  onToggle: () => void;
};

export function TurnProcess({ id, threadId, turn, views, pending, connected, synced = true, plan, planAfter, diff, cwd, showDiff, showDetails, onToggle }: Props) {
  // Device-local reading preference only, never native conversation content.
  const storageKey = `oraculum.process:${threadId}:${id}`;
  const [expanded, setExpanded] = useState(() => {
    try { return !!threadId && sessionStorage.getItem(storageKey) === 'expanded'; } catch { return false; }
  });
  const [now, setNow] = useState(Date.now);
  const controlId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const toggleTop = useRef<number | null>(null);
  const running = turn?.status === 'inProgress';
  const canCollapse = turn?.status === 'completed' && !pending;
  const open = !canCollapse || expanded;
  useEffect(() => {
    if (running) {
      setExpanded(false);
      try { sessionStorage.removeItem(storageKey); } catch { /* In-memory state still works. */ }
    }
  }, [running, storageKey]);
  useEffect(() => {
    if (!running || !connected || !synced || turn?.startedAt == null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, connected, synced, turn?.startedAt]);
  useLayoutEffect(() => {
    if (toggleTop.current === null || !toggle.current) return;
    const scroller = toggle.current.closest('.conversation-scroll');
    if (scroller) scroller.scrollTop += toggle.current.getBoundingClientRect().top - toggleTop.current;
    toggleTop.current = null;
  }, [expanded]);
  const elapsed = elapsedTime(turn, now);
  const status = pending ? '待审批' : running ? (!connected ? '连接已断开' : synced ? '执行中' : '正在同步')
    : turn?.status === 'completed' ? '已完成' : turn?.status === 'failed' ? '执行失败' : turn?.status === 'interrupted' ? '已中断' : '执行记录';
  const label = `${status}${elapsed === undefined || (running && (!connected || !synced)) ? '' : ` · ${running ? '已运行' : '用时'} ${formatElapsed(elapsed)}`}`;
  const counts = processCounts(views);
  const firstRecord = views.findIndex(view => view.item.type !== 'userMessage');
  const beforeRecords = firstRecord < 0 ? views.length - 1 : firstRecord - 1;
  const planIndex = planAfter ? views.findIndex(view => view.item.id === planAfter) : beforeRecords;
  const lastProcess = views.reduce((last, view, index) => isProcessItem(view.item) ? index : last, -1);
  const diffIndex = lastProcess < 0 ? beforeRecords : lastProcess;
  const extras = (index: number) => <>
    {plan && index === planIndex && <div className="process-records process-extras" hidden={!open}><details className="tool current-plan" open={running}><summary>计划</summary><pre>{plan}</pre></details></div>}
    {diff && index === diffIndex && <div className="process-records process-extras" hidden={!open}><button className="turn-diff" onClick={() => showDiff('本轮变更 · 汇总 Diff', diff)}><Icon name="file" size={14}/>查看变更 Diff</button></div>}
  </>;
  const summary = <div className={`process-status ${running ? 'is-running' : ''}`}>
    {canCollapse ? <button ref={toggle} type="button" className="process-toggle" aria-expanded={open} aria-controls={`${controlId}-records`} onClick={() => {
      toggleTop.current = toggle.current?.getBoundingClientRect().top ?? null;
      onToggle();
      try { if (expanded) sessionStorage.removeItem(storageKey); else sessionStorage.setItem(storageKey, 'expanded'); } catch { /* Optional reading preference. */ }
      setExpanded(value => !value);
    }}><Icon name="check" size={15}/><span>{label}</span><Icon name="chevron" size={14}/></button>
      : <span className="process-label"><span className={running && !pending && connected && synced ? 'process-pulse' : 'process-dot'} aria-hidden="true"/>{label}</span>}
    {counts && <span className="process-counts">{counts}</span>}
  </div>;
  return <section className="turn-process" data-turn-id={id} data-status={turn?.status ?? 'unknown'} aria-label="本轮执行">
    {!running && firstRecord === -1 && summary}
    <div id={`${controlId}-records`} className="turn-records">
      {extras(-1)}
      {views.map((view, index) => {
        const process = isProcessItem(view.item);
        return <Fragment key={view.item.id}>
          {!running && index === firstRecord && summary}
          <div className={process ? 'process-records' : undefined} hidden={process && !open && !needsAttention(view.item)} data-turn-id={id} data-item-id={view.item.id}>
            <Item item={view.item} cwd={cwd} showDiff={showDiff} showDetails={item => showDetails(item, id)} live={running && !view.complete} progress={view.progress}/>
          </div>
          {extras(index)}
        </Fragment>;
      })}
    </div>
    {turn?.error && <p className="error" role="alert">{status}：{turn.error.message}</p>}
    {running && summary}
  </section>;
}
