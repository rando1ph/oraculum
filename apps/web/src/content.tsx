import { useEffect, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import type { ThreadItem } from '../../../packages/shared/protocol';
import { OracleEye } from './brand';
import { analyzeDiff } from './diff-lines';
import { displayPath } from './paths';
import './content.css';

export function Copy({ text }: { text: string }) {
  const [status, setStatus] = useState('复制');
  useEffect(() => {
    if (status === '复制') return;
    const timeout = window.setTimeout(() => setStatus('复制'), 2200);
    return () => window.clearTimeout(timeout);
  }, [status]);
  return <button type="button" className="copy" aria-live="polite" onClick={async () => {
    try { await navigator.clipboard.writeText(text); setStatus('已复制'); }
    catch { setStatus('复制失败'); }
  }}>{status}</button>;
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [element, setElement] = useState<HTMLPreElement | null>(null);
  return <div className="code-block"><div className="code-block-actions"><Copy text={element?.textContent ?? ''}/></div><pre ref={setElement}>{children}</pre></div>;
}

export function Message({ text }: { text: string }) {
  return <div className="markdown"><Markdown skipHtml components={{
    pre: CodeBlock,
    a: ({ children, href }) => <span className="message-link" title={href}>{children}{href && <> <Copy text={href}/></>}</span>,
    img: ({ alt }) => <span>[图片：{alt || '未加载'}]</span>,
  }}>{text}</Markdown></div>;
}

function Glyph({ kind }: { kind: 'command' | 'file' | 'plan' | 'tool' | 'reasoning' }) {
  return <svg className="item-glyph" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'command' ? <><path d="m4 5 5 5-5 5M11 15h5"/></> : kind === 'file' ? <><path d="M5 2.5h7L16 7v10.5H5zM12 2.5V7h4M8 10h5M8 13h5"/></> : kind === 'plan' ? <><rect x="4" y="3.5" width="12" height="14" rx="2"/><path d="M7 2.5h6v3H7zM7 10h6M7 13.5h4"/></> : kind === 'reasoning' ? <><path d="M6.5 13a5.5 5.5 0 1 1 7 0L13 16H7zM8 18h4M8 8h4M10 8v5"/></> : <><rect x="4" y="4" width="12" height="12" rx="3"/><path d="M8 8h4v4H8zM7 2v2M13 2v2M7 16v2M13 16v2M2 7h2M16 7h2M2 13h2M16 13h2"/></>}
  </svg>;
}

const statusLabels: Record<string, string> = {
  inProgress: '进行中', completed: '已完成', failed: '失败', declined: '已拒绝',
  interrupted: '已中断', pending: '等待中', cancelled: '已取消',
};

function Status({ value }: { value: string }) {
  return <span className={`item-status status-${value}`}>{statusLabels[value] ?? value}</span>;
}

function DetailButton({ item, showDetails }: { item: ThreadItem; showDetails?: (item: ThreadItem) => void }) {
  return showDetails ? <button className="item-detail-button" type="button" onClick={() => showDetails(item)}>{item.type === 'commandExecution' ? '查看输出' : '查看详情'} <span aria-hidden="true">↗</span></button> : null;
}

function duration(ms: number) { return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`; }

function FileChanges({ item, showDiff, cwd }: { item: Extract<ThreadItem, { type: 'fileChange' }>; showDiff?: (path: string, diff: string) => void; cwd?: string }) {
  const changeLabels = { add: '新增', delete: '删除', update: '修改' };
  return <div className="changed-files">{item.changes.map((change, index) => {
    const stats = analyzeDiff(change.diff);
    return <button type="button" className="file-change-row" key={`${change.path}:${index}`} disabled={!showDiff} onClick={() => showDiff?.(change.path, change.diff)} title={`${change.path} · 查看 Diff`} aria-label="查看 Diff">
      <Glyph kind="file"/><span className="file-change-path" title={change.path}>{displayPath(change.path, cwd)}</span><span className="file-change-kind">{changeLabels[change.kind.type]}</span>
      {change.diff && <span className="diff-stats"><span className="added">+{stats.added}</span><span className="removed">−{stats.removed}</span></span>}
      <span className="file-change-arrow" aria-hidden="true">↗</span>
    </button>;
  })}</div>;
}

export function Item({ item, showDiff, showDetails, cwd }: { item: ThreadItem; showDiff?: (path: string, diff: string) => void; showDetails?: (item: ThreadItem) => void; cwd?: string }) {
  if (item.type === 'agentMessage') return <article className="message agent-message"><div className="message-heading"><OracleEye className="message-avatar"/><span>Codex</span></div><div className="message-body"><Message text={item.text}/><div className="message-actions"><Copy text={item.text}/></div></div></article>;
  if (item.type === 'userMessage') return <article data-theme-slot="user-message" className="message user"><div className="user-label">你</div><p>{item.content.map(input => input.type === 'text' ? input.text : `[${input.type}]`).join('\n')}</p></article>;
  if (item.type === 'plan') return <article data-theme-slot="tool" className="tool plan"><div className="tool-heading"><Glyph kind="plan"/><span>计划</span><span className="native-label">Codex</span></div><Message text={item.text}/></article>;
  if (item.type === 'commandExecution') return <details data-theme-slot="tool" className="tool command">
    <summary><Glyph kind="command"/><span className="tool-title">命令执行</span><code className="tool-preview" title={item.command}>{item.command}</code><Status value={item.status}/></summary>
    <div className="tool-body"><pre className="command-text">{item.command}</pre><div className="tool-meta"><span title={item.cwd}>{item.cwd}</span>{item.exitCode !== null && <span>退出码 {item.exitCode}</span>}{item.durationMs !== null && <span>{duration(item.durationMs)}</span>}</div>
      <pre className="tool-output" aria-label="命令输出">{item.aggregatedOutput || '尚无输出'}</pre><div className="tool-actions"><Copy text={`${item.command}\n${item.aggregatedOutput ?? ''}`}/><DetailButton item={item} showDetails={showDetails}/></div></div>
  </details>;
  if (item.type === 'fileChange') return <details data-theme-slot="tool" className="tool files" open>
    <summary><Glyph kind="file"/><span className="tool-title">文件变更</span><span className="tool-count">{item.changes.length}</span><Status value={item.status}/></summary>
    <FileChanges item={item} showDiff={showDiff} cwd={cwd}/>
  </details>;
  if (item.type === 'reasoning') return <details data-theme-slot="tool" className="tool reasoning"><summary><Glyph kind="reasoning"/><span className="tool-title">思考摘要</span></summary><div className="tool-body"><Message text={item.summary.join('\n') || '暂无公开摘要'}/><DetailButton item={item} showDetails={showDetails}/></div></details>;
  if (item.type === 'mcpToolCall') return <details data-theme-slot="tool" className="tool">
    <summary><Glyph kind="tool"/><span className="tool-title">{item.tool}</span><span className="tool-preview">{item.server}</span><Status value={item.status}/></summary>
    <div className="tool-body"><pre className="tool-output">{JSON.stringify(item.result ?? item.error ?? item.arguments, null, 2)}</pre><div className="tool-actions">{item.durationMs !== null && <small>{duration(item.durationMs)}</small>}<DetailButton item={item} showDetails={showDetails}/></div></div>
  </details>;
  return <details data-theme-slot="tool" className="tool"><summary><Glyph kind="tool"/><span className="tool-title">{item.type}</span>{'status' in item && <Status value={item.status}/>}</summary><div className="tool-body"><pre className="tool-output">{JSON.stringify(item, null, 2)}</pre><DetailButton item={item} showDetails={showDetails}/></div></details>;
}

export function ItemDetail({ item }: { item: ThreadItem }) {
  return <div className="item-detail">
    {item.type === 'commandExecution' && <><div className="tool-meta"><Status value={item.status}/>{item.exitCode !== null && <span>退出码 {item.exitCode}</span>}{item.durationMs !== null && <span>{duration(item.durationMs)}</span>}</div><p className="detail-label">命令</p><pre className="command-text">{item.command}</pre><p className="detail-label">工作目录</p><p className="detail-path">{item.cwd}</p><div className="detail-output-heading"><span>执行输出</span><Copy text={item.aggregatedOutput ?? ''}/></div><pre className="detail-output">{item.aggregatedOutput || '尚无输出'}</pre></>}
    {item.type === 'mcpToolCall' && <><div className="tool-meta"><Status value={item.status}/><span>{item.server}</span>{item.durationMs !== null && <span>{duration(item.durationMs)}</span>}</div><p className="detail-label">参数</p><pre className="detail-output">{JSON.stringify(item.arguments, null, 2)}</pre><p className="detail-label">结果</p><pre className="detail-output">{JSON.stringify(item.result ?? item.error, null, 2)}</pre></>}
    <details className="native-event" open={item.type !== 'commandExecution' && item.type !== 'mcpToolCall'}><summary>原生事件 · {item.type}</summary><Copy text={JSON.stringify(item, null, 2)}/><pre className="detail-output">{JSON.stringify(item, null, 2)}</pre></details>
  </div>;
}
