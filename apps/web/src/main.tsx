import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BridgeClient } from '../../../packages/shared/client';
import type { BridgeEvent, LocalConfig, Model, Snapshot, Thread } from '../../../packages/shared/protocol';
import type { ThreadStartResponse } from '../../../.local/codex-protocol/v2/ThreadStartResponse';
import type { ThreadListResponse } from '../../../.local/codex-protocol/v2/ThreadListResponse';
import { useSession } from './store';
import { Item } from './content';
import './style.css';

const Diff = lazy(() => import('./diff').then(module => ({ default: module.Diff })));
function App() {
  const session = useSession();
  const [connected, setConnected] = useState(false);
  const [synced, setSynced] = useState(false);
  const [config, setConfig] = useState<LocalConfig>();
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [approving, setApproving] = useState(false);
  const [inspected, setInspected] = useState<{ path: string; diff: string }>();
  const [loadingHistory, setLoadingHistory] = useState(false);
  const client = useRef<BridgeClient>(null);
  const selected = useRef('');
  const workspace = useRef('');
  const epoch = useRef(0);
  const buffer = useRef<BridgeEvent[] | null>(null);
  const report = (error: unknown) => setError(error instanceof Error ? error.message : String(error));
  const storageKey = () => `oraculum.thread:${workspace.current}`;
  async function listThreads(cursor?: string) {
    const page = await client.current!.request<ThreadListResponse>('thread/list', { cursor });
    setThreads(current => [...new Map([...(cursor ? current : []), ...page.data].map(t => [t.id, t])).values()]);
    setNextCursor(page.nextCursor);
    return page.data;
  }
  function apply(message: BridgeEvent, restoring = false) {
    const state = useSession.getState();
    if (message.type === 'approval') state.approval(message.request);
    if (message.type === 'event') state.event(message.event, restoring);
    if (message.type === 'notice' && (!message.threadId || message.threadId === selected.current)) {
      useSession.setState({ notices: [...state.notices, message.message] });
    }
  }
  async function refresh(id = selected.current) {
    const ticket = ++epoch.current;
    const changed = selected.current !== id;
    selected.current = id;
    setSynced(false);
    if (changed) { useSession.getState().reset(); setModel(''); setEffort(''); setError(''); setInspected(undefined); }
    if (!id) { useSession.getState().reset(); setSynced(true); buffer.current = null; return; }
    buffer.current = [];
    try {
      const snapshot = await client.current!.request<Snapshot>('bridge/subscribe', { threadId: id });
      if (ticket !== epoch.current) return;
      useSession.getState().snapshot(snapshot);
      // Buffered absolute notifications win; overlapping deltas must not double-append.
      const queued = buffer.current ?? [];
      buffer.current = null;
      for (const message of queued) apply(message, true);
      if (queued.some(e => e.type === 'event' && e.event.method.endsWith('delta'))) {
        useSession.setState({ notices: [...useSession.getState().notices, '查询期间有流式更新；中间片段可能不全，终态或再次查询后补齐。'] });
      }
      localStorage.setItem(storageKey(), id);
      setSynced(true);
    } finally { if (ticket === epoch.current) buffer.current = null; }
  }
  async function connect() {
    ++epoch.current; setSynced(false); setError('');
    await client.current!.connect();
    const settings = await client.current!.request<LocalConfig>('bridge/config', {});
    workspace.current = settings.cwd;
    setConfig(settings);
    const allModels: Model[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { data: Model[]; nextCursor: string | null } = await client.current!.request('model/list', { cursor });
      allModels.push(...page.data);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('模型分页游标重复');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    setModels(allModels);
    const directory = await listThreads();
    const saved = localStorage.getItem(storageKey());
    await refresh(directory.some(t => t.id === saved) ? saved! : directory[0]?.id ?? '');
  }
  useEffect(() => {
    client.current = new BridgeClient(message => {
      if (message.type === 'unavailable') { setError(message.message); setSynced(false); return; }
      if (buffer.current) buffer.current.push(message);
      else {
        apply(message);
        if (message.type === 'event' && message.event.method === 'turn/completed' && message.event.params.threadId === selected.current) {
          void refresh().then(() => listThreads()).catch(report);
        }
      }
    }, value => { setConnected(value); if (!value) setSynced(false); });
    void connect().catch(report);
    return () => { ++epoch.current; client.current?.close(); };
  }, []);
  async function createThread() {
    setSending(true); setError('');
    try {
      const result = await client.current!.request<ThreadStartResponse>('thread/start', { model });
      ++epoch.current; buffer.current = null; selected.current = result.thread.id;
      setInspected(undefined);
      useSession.getState().reset();
      useSession.getState().snapshot({ thread: result.thread, pending: [] });
      localStorage.setItem(storageKey(), result.thread.id);
      setThreads(ids => [result.thread, ...ids]); setSynced(true);
    } catch (error) { report(error); } finally { setSending(false); }
  }
  async function send() {
    setSending(true); setError('');
    try {
      await client.current!.request('turn/start', { threadId: selected.current, text, model, effort });
      setText('');
    } catch (error) {
      report(error);
      // No automatic resend. A native snapshot is required before another attempt.
      setSynced(false);
    } finally { setSending(false); }
  }
  const active = !!session.activeTurn || session.thread?.status.type === 'active';
  const lastTurn = session.turns[session.lastTurnId ?? ''];
  return <main>
    <header className="flex items-center justify-between gap-4">
      <div><h1>Oraculum <span>神谕</span></h1><small>LOCAL CODEX · PHASE 1</small></div>
      <div className="connection" role="status">{!connected ? '已断开' : synced ? '状态已查询' : '待查询状态'}<button disabled={sending || approving} onClick={() => void connect().catch(report)}>重新连接</button></div>
    </header>
    <div className={`workspace ${inspected ? 'with-inspector' : ''}`}>
      <aside>
        <h2>本地会话</h2>
        <button onClick={() => void createThread()} disabled={!connected || sending}>新建会话</button>
        <button onClick={() => void listThreads().catch(report)} disabled={!connected}>刷新列表</button>
        <nav aria-label="原生会话">{threads.map(thread => <button title={thread.id} className={thread.id === session.thread?.id ? 'selected' : ''} key={thread.id} onClick={() => void refresh(thread.id).catch(report)} disabled={!connected || sending || approving}>{thread.name || thread.preview.slice(0, 40) || '新会话'}<small>{thread.id.slice(-8)}</small></button>)}</nav>
        {nextCursor && <button onClick={() => void listThreads(nextCursor).catch(report)}>更多会话</button>}
        <p className="muted path">{config?.cwd}</p>
        <p className="muted">当前范围：隔离工作区。模型与思考强度继承 Codex；执行限制为 workspace-write / on-request，测试进程禁用外部工具。</p>
      </aside>
      <section className="conversation">
        <div className="toolbar">
          <label>模型<select aria-label="模型" value={model} onChange={e => { setModel(e.target.value); setEffort(''); }}><option value="">继承 · {session.thread?.model ?? config?.model ?? 'Codex 默认'}</option>{models.map(m => <option key={m.id} value={m.model}>{m.displayName}</option>)}</select></label>
          <label>思考强度<select aria-label="思考强度" value={effort} onChange={e => setEffort(e.target.value)}><option value="">继承 · {session.thread?.reasoningEffort ?? config?.effort ?? '默认'}</option>{(models.find(m => m.model === (model || session.thread?.model || config?.model))?.supportedReasoningEfforts ?? []).map(e => <option key={e.reasoningEffort}>{e.reasoningEffort}</option>)}</select></label>
          <button disabled={!connected || !session.thread || sending || approving} onClick={() => void refresh().catch(report)}>查询状态</button>
        </div>
        <p className="muted">{model || effort ? `下一轮显式覆盖：${model || '继承模型'} / ${effort || '继承思考强度'}` : '下一轮继承原生会话设置'} · 模型目录不代表逐模型订阅权限验收</p>
        <div className="session-meta">
          <span data-testid="thread-id">{session.thread?.id ?? '尚未选择会话'}</span>
          <span data-testid="turn-status">{!synced && session.thread ? '状态未确认' : active ? '执行中' : session.thread ? '空闲' : '—'}</span>
          <span data-testid="last-turn-status">{lastTurn?.status}</span>
          <span>最近查询配置：{session.thread?.model ?? '未知'} / {session.thread?.reasoningEffort ?? '未指定'}</span>
        </div>
        {session.history?.warning && <p className="history-warning">{session.history.warning}</p>}
        {session.history?.nextCursor && <button disabled={loadingHistory || !connected} onClick={() => {
          const id = selected.current;
          setLoadingHistory(true);
          void client.current!.request<Snapshot>('bridge/history', { threadId: id, cursor: session.history!.nextCursor })
            .then(value => { if (selected.current === id) useSession.getState().older(value); })
            .catch(report).finally(() => setLoadingHistory(false));
        }}>加载更早历史</button>}
        {session.sendBlocked && <p role="alert" className="error">上次发送结果未知，禁止自动重发。请核查原生状态；无法确认时使用新会话。</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {session.notices.map((notice, i) => <p className="history-warning" key={i}>{notice}</p>)}
        {lastTurn?.error && <p className="error" role="alert">{lastTurn.status}：{lastTurn.error.message}</p>}
        {session.plan && <details className="tool"><summary>当前计划</summary><pre>{session.plan}</pre></details>}
        <div className="timeline" aria-label="会话时间线">
          {!Object.keys(session.items).length && <p className="empty">连接真正的 Codex。<br/><span>选择或新建会话，然后发送消息。</span></p>}
          {Object.entries(session.items).map(([key, view]) => <div key={key} data-turn-id={view.turnId} data-item-id={view.item.id}>
            <Item item={view.item} showDiff={(path, diff) => setInspected({ path, diff })}/>
            {view.source === 'live' && <small className="provenance">实时事件 · 未确认持久化</small>}
          </div>)}
        </div>
        {Object.entries(session.diffs).map(([turnId, diff]) => <button className="turn-diff" key={turnId} onClick={() => setInspected({ path: `轮次 ${turnId} · 实时汇总`, diff })}>查看轮次 Diff · {turnId.slice(-8)}</button>)}
        <section aria-label="待审批">
          {session.pending.map(request => <article className="approval" key={`${typeof request.id}:${request.id}`}>
            <h2>需要审批</h2><p>{request.method === 'item/fileChange/requestApproval' ? '文件变更审批' : '命令执行审批'}</p>
            <small>原生 request ID：{String(request.id)} · {request.params.itemId}</small>
            <p>{request.params.reason ?? 'Codex 请求确认本次操作'}</p>
            {request.method === 'item/commandExecution/requestApproval' && <><pre>{request.params.command ?? '未提供命令内容'}</pre><small>{request.params.cwd}</small></>}
            {request.method === 'item/fileChange/requestApproval' && request.params.grantRoot && <p className="error">此请求涉及写入目录权限：{request.params.grantRoot}</p>}
            <details><summary>原生请求详情</summary><pre>{JSON.stringify(request.params, null, 2)}</pre></details>
            {(['accept', 'decline'] as const).map(decision => <button key={decision} disabled={!connected || !synced || approving} onClick={() => {
              setApproving(true);
              void client.current!.request('bridge/approve', { threadId: selected.current, requestId: request.id, bridgeToken: request.bridgeToken, decision })
                .then(() => useSession.setState(s => ({ pending: s.pending.filter(p => p.id !== request.id) })))
                .catch(report).finally(() => setApproving(false));
            }}>{decision === 'accept' ? '允许本次' : '拒绝'}</button>)}
          </article>)}
        </section>
        <form onSubmit={e => { e.preventDefault(); void send(); }}>
          <label className="sr-only" htmlFor="message">消息</label>
          <textarea id="message" value={text} onChange={e => setText(e.target.value)} placeholder="向 Codex 发送消息…" maxLength={16000} rows={3}/>
          <div className="flex justify-between items-center gap-3"><small>关闭界面不会停止主机上的任务</small><div className="flex gap-3"><button type="button" disabled={!connected || !session.activeTurn} onClick={() => void client.current!.request('turn/interrupt', { threadId: selected.current, turnId: session.activeTurn }).catch(report)}>停止</button><button className="primary" disabled={!connected || !synced || !session.thread || active || session.sendBlocked || sending || !text.trim()}>发送</button></div></div>
        </form>
        <details className="events"><summary>原生事件 · 最近 {session.events.length} 条</summary><pre>{session.events.join('\n')}</pre></details>
      </section>
      {inspected && <section className="inspector" aria-label="文件 Diff 面板">
        <div className="file-row"><h2>文件 Diff</h2><button onClick={() => setInspected(undefined)}>关闭面板</button></div>
        <p className="path">{inspected.path}</p>
        <small>Codex 原生差异 · 只读</small>
        {inspected.diff ? <Suspense fallback={<p>正在加载 Diff…</p>}><Diff text={inspected.diff} label={`Diff ${inspected.path}`}/></Suspense> : <p>原生事件未提供 diff 内容。</p>}
      </section>}
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
