import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BridgeClient } from '../../../packages/shared/client';
import type { BridgeEvent, Model, Snapshot } from '../../../packages/shared/protocol';
import type { ThreadStartResponse } from '../../../.local/codex-protocol/v2/ThreadStartResponse';
import type { ThreadItem } from '../../../.local/codex-protocol/v2/ThreadItem';
import { useSession } from './store';
import './style.css';

function Item({ item }: { item: ThreadItem }) {
  if (item.type === 'agentMessage') return <article className="message"><small>CODEX</small><p>{item.text}</p></article>;
  if (item.type === 'userMessage') return <article className="message user"><small>你</small><p>{item.content.map(input => input.type === 'text' ? input.text : `[${input.type}]`).join('\n')}</p></article>;
  return <details className="tool"><summary>{item.type}{'status' in item ? ` · ${item.status}` : ''}</summary><pre>{JSON.stringify(item, null, 2)}</pre></details>;
}
function App() {
  const session = useSession();
  const [connected, setConnected] = useState(false);
  const [synced, setSynced] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [threads, setThreads] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const restoring = useRef(false);
  const client = useRef<BridgeClient>(null);
  const selected = useRef('');

  const report = (error: unknown) => setError(error instanceof Error ? error.message : String(error));
  async function refresh(id = selected.current) {
    if (!id) {
      selected.current = '';
      useSession.setState({ thread: undefined, items: {}, pending: [], activeTurn: undefined, events: [] });
      setSynced(true); return;
    }
    setSynced(false);
    restoring.current = true;
    try {
      const snapshot = await client.current!.request<Snapshot>('bridge/subscribe', { threadId: id });
      selected.current = id;
      sessionStorage.setItem('oraculum.thread', id);
      useSession.getState().snapshot(snapshot);
      setSynced(true);
    } finally { restoring.current = false; }
  }
  async function connect() {
    setError('');
    await client.current!.connect();
    const directory = await client.current!.request<{ data: Model[]; nextCursor: string | null }>('model/list', {});
    const allModels = [...directory.data];
    let cursor = directory.nextCursor;
    while (cursor) {
      const page = await client.current!.request<typeof directory>('model/list', { cursor });
      allModels.push(...page.data); cursor = page.nextCursor;
    }
    setModels(allModels);
    const ids = await client.current!.request<string[]>('bridge/threads', {});
    setThreads(ids);
    const saved = sessionStorage.getItem('oraculum.thread');
    await refresh(saved && ids.includes(saved) ? saved : ids.at(-1) ?? '');
  }
  useEffect(() => {
    const receive = (message: BridgeEvent) => {
      if (message.type === 'unavailable') { setError(message.message); setSynced(false); return; }
      if (message.type === 'approval') { useSession.getState().approval(message.request); return; }
      // A snapshot is authoritative. Do not append overlapping deltas during read.
      if (!restoring.current) useSession.getState().event(message.event);
      if (message.event.method === 'error') report(message.event.params.error.message);
      if (message.event.method === 'turn/completed' && message.event.params.threadId === selected.current) {
        void refresh().catch(report);
      }
    };
    client.current = new BridgeClient(receive, value => { setConnected(value); if (!value) setSynced(false); });
    void connect().catch(report);
    return () => client.current?.close();
  }, []);
  async function createThread() {
    setSending(true); setError('');
    try {
      const result = await client.current!.request<ThreadStartResponse>('thread/start', { model });
      selected.current = result.thread.id;
      setThreads(ids => [...ids, result.thread.id]);
      // A brand-new thread has no rollout yet. Use its native start response.
      useSession.getState().snapshot({ thread: result.thread, pending: [] });
      sessionStorage.setItem('oraculum.thread', result.thread.id);
      setSynced(true);
    } catch (error) { report(error); } finally { setSending(false); }
  }
  async function send() {
    setSending(true); setError('');
    try {
      await client.current!.request('turn/start', { threadId: selected.current, text, model, effort });
      setText('');
    } catch (error) { report(error); } finally { setSending(false); }
  }
  return <main>
    <header className="flex items-center justify-between gap-4">
      <div><h1>Oraculum <span>神谕</span></h1><small>LOCAL PROTOTYPE · PHASE 0B</small></div>
      <div className="connection" role="status">{!connected ? '已断开' : synced ? '状态已查询' : '正在同步'}<button onClick={() => void connect().catch(report)}>重新连接</button></div>
    </header>
    <div className="workspace">
      <aside>
        <h2>测试会话</h2>
        <button onClick={() => void createThread()} disabled={!connected || sending}>新建会话</button>
        <nav>{threads.map(id => <button className={id === session.thread?.id ? 'selected' : ''} key={id} onClick={() => void refresh(id).catch(report)} disabled={!connected || sending}>{id.slice(0, 8)}…{id.slice(-6)}</button>)}</nav>
        <p className="muted">所有新会话仅使用 Bridge 创建的临时测试工作区。</p>
      </aside>
      <section className="conversation">
        <div className="toolbar">
          <label>模型<select aria-label="模型" value={model} onChange={e => { setModel(e.target.value); setEffort(''); }}><option value="">继承 Codex 配置</option>{models.map(m => <option key={m.id} value={m.model}>{m.displayName}</option>)}</select></label>
          <label>思考强度<select aria-label="思考强度" value={effort} onChange={e => setEffort(e.target.value)}><option value="">继承配置</option>{(models.find(m => m.model === (model || session.thread?.model))?.supportedReasoningEfforts ?? []).map(e => <option key={e.reasoningEffort}>{e.reasoningEffort}</option>)}</select></label>
          <button disabled={!connected || !session.thread} onClick={() => void refresh().catch(report)}>查询状态</button>
        </div>
        <div className="session-meta">
          <span data-testid="thread-id">{session.thread?.id ?? '尚未选择会话'}</span>
          <span data-testid="turn-status">{session.activeTurn ? '执行中' : session.thread ? '空闲' : '—'}</span>
          <span data-testid="last-turn-status">{session.thread?.turns.at(-1)?.status}</span>
          <span>{session.thread?.model} / {session.thread?.reasoningEffort}</span>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="timeline" aria-label="会话时间线">
          {!Object.keys(session.items).length && <p className="empty">连接真正的 Codex。<br/><span>新建测试会话，然后发送一条消息。</span></p>}
          {Object.values(session.items).map(item => <Item key={item.id} item={item}/>)}
        </div>
        <section aria-label="待审批">
          {session.pending.map(request => <article className="approval" key={request.id}>
            <h2>需要审批</h2><p>{request.method}</p>
            <pre>{JSON.stringify(request.params, null, 2)}</pre>
            {(['accept', 'decline'] as const).map(decision => <button key={decision} disabled={!connected || !synced} onClick={() => void client.current!.request('bridge/approve', { threadId: selected.current, requestId: request.id, decision }).then(() => refresh()).catch(report)}>{decision === 'accept' ? '允许本次' : '拒绝'}</button>)}
          </article>)}
        </section>
        <form onSubmit={e => { e.preventDefault(); void send(); }}>
          <label className="sr-only" htmlFor="message">消息</label>
          <textarea id="message" value={text} onChange={e => setText(e.target.value)} placeholder="向 Codex 发送测试消息…" maxLength={16000} rows={3}/>
          <div className="flex justify-between items-center gap-3"><small>关闭界面不会停止主机上的任务</small><div className="flex gap-3"><button type="button" disabled={!connected || !session.activeTurn} onClick={() => void client.current!.request('turn/interrupt', { threadId: selected.current, turnId: session.activeTurn }).catch(report)}>停止</button><button className="primary" disabled={!connected || !synced || !session.thread || !!session.activeTurn || sending || !text.trim()}>发送</button></div></div>
        </form>
        <details className="events"><summary>原生事件 · 最近 {session.events.length} 条</summary><pre>{session.events.join('\n')}</pre></details>
      </section>
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
