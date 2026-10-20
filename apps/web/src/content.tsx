import { useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import type { ThreadItem } from '../../../packages/shared/protocol';

export function Copy({ text }: { text: string }) {
  const [status, setStatus] = useState('复制');
  return <button type="button" className="copy" onClick={() => void navigator.clipboard.writeText(text)
    .then(() => setStatus('已复制'), () => setStatus('复制失败'))}>{status}</button>;
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const [element, setElement] = useState<HTMLPreElement | null>(null);
  return <div className="code-block"><Copy text={element?.textContent ?? ''}/><pre ref={setElement}>{children}</pre></div>;
}
export function Message({ text }: { text: string }) {
  return <div className="markdown"><Markdown skipHtml components={{
    pre: CodeBlock,
    a: ({ children, href }) => <span title={href}>{children}{href && <> <Copy text={href}/></>}</span>,
    img: ({ alt }) => <span>[图片：{alt || '未加载'}]</span>,
  }}>{text}</Markdown></div>;
}
export function Item({ item, showDiff }: { item: ThreadItem; showDiff?: (path: string, diff: string) => void }) {
  if (item.type === 'agentMessage') return <article className="message"><small>CODEX</small><Message text={item.text}/><Copy text={item.text}/></article>;
  if (item.type === 'userMessage') return <article className="message user"><small>你</small><p>{item.content.map(input => input.type === 'text' ? input.text : `[${input.type}]`).join('\n')}</p></article>;
  if (item.type === 'plan') return <article className="message"><small>计划</small><Message text={item.text}/></article>;
  if (item.type === 'commandExecution') return <details className="tool command" open={item.status === 'inProgress'}>
    <summary>命令 · {item.status} {item.exitCode !== null && `· exit ${item.exitCode}`}</summary>
    <pre className="command-text">{item.command}</pre><small>{item.cwd}</small>
    <Copy text={`${item.command}\n${item.aggregatedOutput ?? ''}`}/>
    <pre aria-label="命令输出">{item.aggregatedOutput ?? '尚无输出'}</pre>
    {item.durationMs !== null && <small>{item.durationMs} ms</small>}
  </details>;
  if (item.type === 'fileChange') return <details className="tool files" open>
    <summary>文件变更 · {item.status} · {item.changes.length} 个文件</summary>
    {item.changes.map((change, index) => <div className="file-row" key={`${change.path}:${index}`}>
      <span>{change.kind.type} · {change.path}</span>
      <button type="button" onClick={() => showDiff?.(change.path, change.diff)}>查看 Diff</button>
    </div>)}
  </details>;
  if (item.type === 'reasoning') return <details className="tool"><summary>过程摘要</summary><Message text={item.summary.join('\n') || '暂无公开摘要'}/></details>;
  if (item.type === 'mcpToolCall') return <details className="tool">
    <summary>工具 · {item.server}/{item.tool} · {item.status}</summary>
    <pre>{JSON.stringify(item.result ?? item.error ?? item.arguments, null, 2)}</pre>
  </details>;
  return <details className="tool"><summary>{item.type}{'status' in item ? ` · ${item.status}` : ''}</summary><pre>{JSON.stringify(item, null, 2)}</pre></details>;
}
