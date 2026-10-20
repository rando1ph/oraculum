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
export function Item({ item }: { item: ThreadItem }) {
  if (item.type === 'agentMessage') return <article className="message"><small>CODEX</small><Message text={item.text}/><Copy text={item.text}/></article>;
  if (item.type === 'userMessage') return <article className="message user"><small>你</small><p>{item.content.map(input => input.type === 'text' ? input.text : `[${input.type}]`).join('\n')}</p></article>;
  if (item.type === 'plan') return <article className="message"><small>计划</small><Message text={item.text}/></article>;
  return <details className="tool"><summary>{item.type}{'status' in item ? ` · ${item.status}` : ''}</summary><pre>{JSON.stringify(item, null, 2)}</pre></details>;
}
