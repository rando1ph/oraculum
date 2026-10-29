import { useEffect, useRef, useState } from 'react';
import type { BridgeClient } from '../../../packages/shared/client';
import type { AgentDetail, AgentSummary } from '../../../packages/shared/subagents';
import type { ThreadItem } from '../../../packages/shared/protocol';
import { Item, ItemDetail } from './content';
import { Icon } from './icons';
import { agentLabels, orderedAgents, type AgentNode } from './agent-tree';
import type { ItemView } from './store';
import './subagents.css';

export function AgentTree({ nodes, root, running, connected, synced, views, showAgent, showDiff, showDetails }: {
  nodes: AgentNode[]; root: string; running: boolean; connected: boolean; synced: boolean; views: ItemView[];
  showAgent?: (agent: AgentNode) => void; showDiff: (path: string, diff: string) => void; showDetails: (item: ThreadItem) => void;
}) {
  return <details className="tool subagent-tree" data-theme-slot="tool" open={running}>
    <summary><Icon name="model" size={16}/><span className="tool-title">子代理</span><span className="tool-count">{nodes.length}</span><span className="agent-tree-caption">{nodes.filter(node => node.status === 'running' || node.status === 'pendingInit').length} 运行 · {nodes.filter(node => node.status === 'completed').length} 完成</span></summary>
    <div className="subagent-tree-body">
      {(!connected || !synced) && <p className="agent-stale" role="status">{connected ? '正在同步，以下为上次可见状态。' : '连接已断开，以下为上次可见状态。'}</p>}
      <ol className="agent-tree-list" aria-label="子代理层级">
        {orderedAgents(nodes, root).map(({ node, depth }) => <li key={node.id} data-agent-id={node.id} data-agent-state={node.status} data-depth={depth} style={{ marginInlineStart: Math.min(depth, 2) * 12 }}>
          <div className="agent-node-heading"><span className="agent-node-icon" aria-hidden="true">{depth ? '↳' : '◇'}</span><strong>{node.name}</strong><span className="agent-node-state">{agentLabels[node.status]}</span></div>
          <div className="agent-node-meta">{node.role && <span>{node.role}</span>}{node.parentId === null ? <span>层级未确认</span> : node.parentId !== root ? <span>隶属 {nodes.find(value => value.id === node.parentId)?.name ?? node.parentId}</span> : <span>父任务的子代理</span>}</div>
          <p className="agent-node-preview">{node.result || node.progress || '暂无可见进展或结论。'}</p>
          {showAgent && <button className="agent-detail-button" onClick={() => showAgent(node)} aria-label={`查看子代理 ${node.name}`}><span>查看详情</span><Icon name="chevron" size={13}/></button>}
        </li>)}
      </ol>
      <details className="subagent-events"><summary>原生活动 · {views.length} 条</summary>{views.map(view => <Item key={view.item.id} item={view.item} showDiff={showDiff} showDetails={showDetails}/>)}</details>
    </div>
  </details>;
}

export function AgentDetailPanel({ agent, client, root, cwd, connected, synced, onClose, showDiff }: {
  agent: AgentNode; client: BridgeClient | null; root: string; cwd: string; connected: boolean; synced: boolean;
  onClose: () => void; showDiff: (path: string, diff: string) => void;
}) {
  const [value, setValue] = useState<AgentDetail>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [item, setItem] = useState<ThreadItem>();
  const generation = useRef(0);
  async function read(cursor?: string) {
    if (!connected || !synced || !client) return;
    const ticket = ++generation.current; setBusy(true); setError('');
    try {
      const result = await client.request<AgentDetail>('bridge/agent', { threadId: root, cwd, agentId: agent.id, ...(cursor ? { cursor } : {}) });
      if (ticket !== generation.current) return;
      if (result.status === 'ready' && result.agent?.id !== agent.id) throw new Error('Invalid agent detail');
      setValue(previous => cursor && previous && result.status === 'ready' ? { ...result, turns: [...new Map([...(result.turns ?? []), ...(previous.turns ?? [])].map(turn => [turn.id, turn])).values()] } : result);
    } catch { if (ticket === generation.current) setError('子会话详情未能读取；父任务中的活动摘要仍可查看。'); }
    finally { if (ticket === generation.current) setBusy(false); }
  }
  useEffect(() => {
    ++generation.current; setValue(undefined); setItem(undefined); setBusy(false); setError('');
    if (connected && synced) void read();
    return () => { ++generation.current; };
  }, [agent.id, root, cwd, connected, synced, client]);
  const identity: Pick<AgentSummary, 'nickname' | 'role'> | undefined = value?.agent;
  return <section className="agent-detail" aria-label="子代理详情">
    <div className="agent-detail-toolbar"><button onClick={onClose}><Icon name="back" size={15}/>返回父任务</button><button disabled={!connected || !synced || busy} onClick={() => void read()}><Icon name="refresh" size={14}/>刷新详情</button></div>
    <h2>{identity?.nickname || agent.name}</h2><div className="agent-detail-meta"><span>{identity?.role || agent.role || '角色未提供'}</span><span>{agentLabels[agent.status !== 'unknown' ? agent.status : value?.agent?.status ?? 'unknown']}</span><span>只读</span></div>
    {(!connected || !synced) && <p role="status">状态尚未确认；以下为父任务中上次可见的摘要。</p>}
    {(agent.result || agent.progress) && <div className="agent-visible-summary"><small>{agent.result ? '可见结论' : '最近可见进展'}</small><p>{agent.result || agent.progress}</p></div>}
    {agent.prompt && <details className="agent-task"><summary>任务说明</summary><p>{agent.prompt}</p></details>}
    {busy && <p role="status">正在读取子会话…</p>}{error && <p role="status">{error}</p>}
    {value?.status === 'unavailable' && <p role="status">{value.message}</p>}
    {value?.status === 'ready' && <>
      <details className="agent-history-note"><summary>历史范围</summary><p>{value.message || '只显示原生接口当前可读的历史。'}</p></details>
      <p className="inspector-caption">子会话记录 · 按刷新读取</p>
      {item ? <><button onClick={() => setItem(undefined)}><Icon name="back" size={14}/>返回子会话记录</button><ItemDetail item={item}/></> : <div className="agent-transcript">
        {!value.turns?.some(turn => turn.items.length) && <p>原生子会话暂无可读记录。</p>}
        {value.turns?.map(turn => <section className="agent-native-turn" key={turn.id}><small>{({ inProgress: '执行中', completed: '已完成', failed: '执行失败', interrupted: '已中断' })[turn.status]}</small>{turn.items.map(item => <Item key={item.id} item={item} cwd={cwd} showDiff={showDiff} showDetails={setItem}/>)}{turn.error && <p className="error">{turn.error.message}</p>}</section>)}
      </div>}
      {value.nextCursor && <button disabled={busy || !connected || !synced} onClick={() => void read(value.nextCursor!)}>加载更早子会话记录</button>}
    </>}
  </section>;
}
