import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { NativeItem } from '../../../../packages/gateway-protocol/src/index';
import type { WorkspaceAction, WorkspaceState } from '../contracts/workspace';
import { BrandIcon } from './Icon';

export const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const string = (value: unknown): string => typeof value === 'string' ? value : '';
export function nativeData(item: NativeItem): Record<string, unknown> { return { ...item, ...record(item.data) }; }
export function nativeText(item: NativeItem): string {
  const data = nativeData(item);
  if (typeof data.text === 'string') return data.text;
  if (Array.isArray(data.content)) return data.content.map(part => {
    if (typeof part === 'string') return part;
    const value = record(part);
    return string(value?.text) || (value?.type === 'image' || value?.type === 'localImage' ? '[图片附件]' : '');
  }).filter(Boolean).join('\n\n');
  if (Array.isArray(data.summary)) return data.summary.map(part => typeof part === 'string' ? part : string(record(part)?.text)).join('\n');
  return '';
}
export type DisplayItem = { turnId: string; item: NativeItem; turnStatus: string };
export function conversationItems(state: Pick<WorkspaceState, 'history' | 'streamItems'>): DisplayItem[] {
  const result: DisplayItem[] = [];
  const positions = new Map<string, number>();
  for (const entry of state.history?.items ?? []) {
    const turn = record(entry);
    if (!turn || typeof turn.id !== 'string' || !Array.isArray(turn.items)) continue;
    for (const raw of turn.items) {
      const item = record(raw);
      if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') continue;
      const key = `${turn.id}\0${item.id}`;
      const at = positions.get(key);
      const value = { turnId: turn.id, turnStatus: string(turn.status), item: item as NativeItem };
      if (at === undefined) { positions.set(key, result.length); result.push(value); }
      else result[at] = value;
    }
  }
  for (const stream of state.streamItems) {
    const key = `${stream.turnId}\0${stream.item.id}`;
    const at = positions.get(key);
    if (at === undefined) {
      positions.set(key, result.length);
      result.push({ ...stream, turnStatus: '' });
    } else result[at] = { ...result[at], item: stream.item };
  }
  return result;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={() => ''}
    components={{ a: ({ children }) => <span className="markdown-link" title="外部链接仅显示文本">{children}</span>,
      img: ({ alt }) => <span className="inline-image-placeholder">[图片：{alt || '未自动加载'}]</span> }}>{text}</ReactMarkdown></div>;
});

export const TEXT_SEGMENT_LENGTH = 16_000;
/** Rendering a long output is an explicit local read, never a native details request. */
export function ExpandableText({ text, markdown = false, initialLimit = TEXT_SEGMENT_LENGTH, onLimitChange }: { text: string; markdown?: boolean; initialLimit?: number; onLimitChange?: (limit: number) => void }) {
  const [limit, updateLimit] = useState(initialLimit);
  function setLimit(value: number) { updateLimit(value); onLimitChange?.(value); }
  // A Unicode surrogate pair must not be split across the visible boundary.
  const end = limit < text.length && /[\uD800-\uDBFF]/.test(text.charAt(limit - 1)) ? limit - 1 : limit;
  const visible = text.slice(0, end), limited = visible.length < text.length;
  return <div className="expandable-text">
    {markdown ? <Markdown text={visible} /> : <pre className="native-output">{visible}</pre>}
    {limited && <button className="text-button output-more" onClick={() => setLimit(limit + TEXT_SEGMENT_LENGTH)}>继续显示内容（还有 {text.length - visible.length} 字符）</button>}
    {limit > TEXT_SEGMENT_LENGTH && <button className="text-button output-collapse" onClick={() => setLimit(TEXT_SEGMENT_LENGTH)}>收起长内容</button>}
  </div>;
}

export interface MessagePresentation { expanded?: boolean; textLimit?: number; outputLimit?: number; detailsLimit?: number; jsonLimit?: number }

export function Diff({ value }: { value: string }) {
  return <div className="diff-code" aria-label="原生差异"><div>{value.split('\n').map((line, index) => <div key={index}
    className={`diff-line ${line.startsWith('+') && !line.startsWith('+++') ? 'added' : line.startsWith('-') && !line.startsWith('---') ? 'removed' : line.startsWith('@@') ? 'meta' : ''}`}>{line || ' '}</div>)}</div></div>;
}

export function NativeMessage({ value, state, act, disabled, presentation, onPresentationChange }: {
  value: DisplayItem; state: WorkspaceState; act: (action: WorkspaceAction) => Promise<WorkspaceState | undefined>; disabled: boolean;
  presentation?: MessagePresentation; onPresentationChange?: (patch: Partial<MessagePresentation>) => void;
}) {
  const { item, turnId } = value;
  const data = nativeData(item), text = nativeText(item);
  const user = item.type === 'userMessage';
  const message = user || item.type === 'agentMessage';
  const labels: Record<string, string> = { commandExecution: '命令执行', fileChange: '文件变更', reasoning: '思考', plan: '计划', mcpToolCall: 'MCP 工具', dynamicToolCall: '工具调用', collabAgentToolCall: '子代理', webSearch: '搜索', imageView: '查看图片', contextCompaction: '上下文压缩' };
  const details = state.itemDetails?.itemId === item.id && state.itemDetails.turnId === turnId ? state.itemDetails : undefined;
  const output = string(data.aggregatedOutput) || string(data.output) || string(data.result);
  const [expanded, setExpanded] = useState(presentation?.expanded ?? item.type === 'plan');
  return <article className={`message ${user ? 'user-message' : ''}`} data-item-id={item.id} data-turn-id={turnId}>
    <div className="message-person flex items-center">{user ? <span className="avatar">你</span> : <BrandIcon size="avatar" />}<b>{user ? '你' : message ? 'Oraculum' : labels[item.type] ?? item.type}</b>
      {!message && <span className="model-label">{string(data.status) || value.turnStatus}</span>}</div>
    <div className="message-body">
      {message ? (text ? <ExpandableText text={text} markdown initialLimit={presentation?.textLimit} onLimitChange={textLimit => onPresentationChange?.({ textLimit })} /> : <p className="muted">{user ? '附件消息' : '正在接收内容…'}</p>) : <details className="native-item" open={expanded} onToggle={event => { setExpanded(event.currentTarget.open); onPresentationChange?.({ expanded: event.currentTarget.open }); }}>
        <summary>{string(data.command) || string(data.tool) || string(data.toolName) || string(data.query) || text.slice(0, 100) || labels[item.type] || item.type}</summary>
        {expanded && <>
        {text && <ExpandableText text={text} markdown initialLimit={presentation?.textLimit} onLimitChange={textLimit => onPresentationChange?.({ textLimit })} />}
        {output && <ExpandableText text={output} initialLimit={presentation?.outputLimit} onLimitChange={outputLimit => onPresentationChange?.({ outputLimit })} />}
        {Array.isArray(data.changes) && data.changes.map((raw, index) => { const change = record(raw); return change ? <section key={index}><p className="file-path">{string(change.path)}</p>{typeof change.diff === 'string' && <Diff value={change.diff} />}</section> : null; })}
        {item.type === 'plan' && Array.isArray(data.plan) && <ol className="native-plan">{data.plan.map((raw, index) => { const step = record(raw); return <li key={index}>{string(step?.step)} <small>{string(step?.status)}</small></li>; })}</ol>}
        {!text && !output && !Array.isArray(data.changes) && <ExpandableText text={JSON.stringify(data, null, 2)} initialLimit={presentation?.jsonLimit} onLimitChange={jsonLimit => onPresentationChange?.({ jsonLimit })} />}
        </>}
      </details>}
      {(item.truncated || item.detailsAvailable) && <div className="item-details"><p className="inspector-note">{item.truncated ? '当前内容不完整，可按需载入原生详情。' : '原生详情可按需载入。'}</p>
        <button className="quiet-button" disabled={disabled} onClick={() => void act({ type: 'details', turnId, itemId: item.id })}>载入详情</button></div>}
      {details && <details className="native-item" open><summary>完整详情 {details.complete ? '' : '· 尚未载完'}</summary><ExpandableText text={details.text} initialLimit={presentation?.detailsLimit} onLimitChange={detailsLimit => onPresentationChange?.({ detailsLimit })} />{details.nextCursor && <button className="quiet-button" disabled={disabled} onClick={() => void act({ type: 'details', turnId, itemId: item.id, cursor: details.nextCursor })}>继续载入详情</button>}</details>}
    </div>
  </article>;
}
