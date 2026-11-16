import type { ReactNode } from 'react';
import type { WorkspaceAction, WorkspaceState } from '../contracts/workspace';
import { Icon } from './Icon';
import './styles/inspector.css';

export type InspectorPanel = 'diff' | 'files' | 'process' | 'usage' | 'extensions';
type Props = { state: WorkspaceState; act: (action: WorkspaceAction) => Promise<WorkspaceState | undefined>; disabled: boolean; panel: InspectorPanel };
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const numberLabel = (value: unknown): string => count(value)?.toLocaleString() ?? '未提供';
const statusLabels: Record<string, string> = { completed: '已完成', inProgress: '执行中', running: '运行中', pending: '待执行', pendingInit: '等待启动', errored: '执行失败', failed: '失败', interrupted: '已中断', shutdown: '已关闭', notFound: '未找到', started: '已开始', accepted: 'Gateway 已接收', rejected: '已拒绝', prepared: '等待结果', unknown: '结果未知', available: '可用', unavailable: '不可用' };
const statusLabel = (value: unknown): string => statusLabels[string(value)] ?? (string(value) || '未提供');
const isRelativePath = (value: string): boolean => !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && !value.split('/').includes('..') && !/^[a-z][a-z0-9+.-]*:/i.test(value);

export function WorkspaceInspector({ state, act, disabled, panel }: Props) {
  if (panel === 'diff') return <DiffPanel state={state} />;
  if (panel === 'files') return <FilesPanel state={state} act={act} disabled={disabled} />;
  if (panel === 'process') return <ProcessPanel state={state} />;
  if (panel === 'usage') return <UsagePanel state={state} act={act} disabled={disabled} />;
  return <ExtensionsPanel state={state} act={act} disabled={disabled} />;
}

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <section className="inspector-empty"><h2>{title}</h2><p>{children}</p></section>;
}

function Refresh({ children, disabled, onClick }: { children: ReactNode; disabled: boolean; onClick: () => void }) {
  return <button className="quiet-button inspector-refresh" disabled={disabled} onClick={onClick}><Icon name="refresh" />{children}</button>;
}

function DiffPanel({ state }: Pick<Props, 'state'>) {
  if (!state.diff) return <Empty title="尚无变更">{state.threadId ? '当前会话尚未收到原生 Diff。' : '选择会话后，原生代码变更会显示在这里。'}</Empty>;
  const lines = state.diff.split('\n');
  const added = lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length;
  return <section className="inspector-section"><h2>原生 Diff <span>当前会话</span></h2>
    <div className="change-stats flex items-center"><span className="add-text">+{added}</span><span className="remove-text">−{removed}</span></div>
    <div className="diff-code inspector-diff" aria-label="原生差异内容">{lines.map((line, index) => <div key={index} className={`diff-line ${line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ') ? 'meta' : line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : ''}`}>{line || ' '}</div>)}</div>
    <p className="inspector-note">显示 Codex 返回的变更内容。Diff 不代表审批已经通过。</p>
  </section>;
}

function FilesPanel({ state, act, disabled }: Omit<Props, 'panel'>) {
  const files = state.files;
  const path = files?.path ?? '';
  const parentPath = path.split('/').filter(Boolean).slice(0, -1).join('/');
  const preview = state.preview;
  const image = preview?.image && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/.test(preview.image) ? preview.image : undefined;
  return <>
    <section className="inspector-section">
      <h2>项目文件 <span>{files?.entries.length ?? 0}</span></h2>
      <Refresh disabled={disabled || !state.projectId} onClick={() => void act({ type: 'files', path })}>{files ? '刷新目录' : '浏览文件'}</Refresh>
      {!state.projectId ? <Empty title="先选择项目">文件浏览与下载仅限 Gateway 授权的项目。</Empty> : <>
        <div className="inspector-path">{path || '项目根目录'}</div>
        {path && <button className="text-button" disabled={disabled || !isRelativePath(parentPath)} onClick={() => void act({ type: 'files', path: parentPath })}>← 返回上级目录</button>}
        {files && files.entries.length === 0 && <p className="inspector-note">此目录没有可显示的文件。</p>}
        {files?.entries.map(entry => <div className="file-row flex items-center" key={entry.path}>
          <Icon name={entry.directory ? 'folder' : 'file'} />
          <button className="inspector-file-name" disabled={disabled || !isRelativePath(entry.path)} onClick={() => void act({ type: entry.directory ? 'files' : 'previewFile', path: entry.path })} title={entry.name}>{entry.name}</button>
          {entry.directory ? <Icon name="chevron" /> : <><small>{sizeLabel(entry.size)}</small><button className="icon-button" title={`下载 ${entry.name}`} aria-label={`下载 ${entry.name}`} disabled={disabled || !isRelativePath(entry.path)} onClick={() => void act({ type: 'downloadFile', path: entry.path })}><span className="download-icon"><Icon name="arrow" /></span></button></>}
        </div>)}
        {files?.nextCursor && <button className="text-button" disabled={disabled} onClick={() => void act({ type: 'files', path, more: true })}>加载更多文件</button>}
        {files?.limited && <p className="inspector-note">目录内容受当前接口限制，以上列表可能不完整。</p>}
      </>}
    </section>
    {preview && <section className="inspector-section"><h2>文件预览</h2><div className="inspector-preview-name">{preview.name}</div><p className="inspector-note">{preview.mime}</p>
      {image ? <img className="inspector-image" src={image} alt={preview.name} /> : preview.text !== undefined ? <pre className="inspector-text-preview">{preview.text}</pre> : <p className="inspector-note">此格式不能直接预览。可使用文件旁的下载按钮保存后查看。</p>}
      {preview.limited && <p className="inspector-note">这里只显示部分内容，请下载查看完整文件。</p>}
    </section>}
  </>;
}

function sizeLabel(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '—';
  return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** History contains native turns; streaming carries NativeItem envelopes. */
function nativeItems(state: WorkspaceState): RecordValue[] {
  const items = new Map<string, RecordValue>();
  for (const raw of state.history?.items ?? []) {
    const turn = object(raw);
    for (const entry of Array.isArray(turn.items) ? turn.items : []) {
      const item = object(entry); const data = object(item.data); const value = Object.keys(data).length ? { ...item, ...data } : item;
      if (typeof value.id === 'string') items.set(value.id, value);
    }
  }
  for (const entry of state.streamItems) {
    const item = entry.item; const data = object(item.data);
    items.set(item.id, { ...item, ...data });
  }
  return [...items.values()];
}

function ProcessPanel({ state }: Pick<Props, 'state'>) {
  const planObject = object(state.plan);
  const plan = Array.isArray(state.plan) ? state.plan : Array.isArray(planObject.plan) ? planObject.plan : [];
  const items = nativeItems(state);
  const tools = items.filter(item => !['userMessage', 'agentMessage', 'reasoning'].includes(string(item.type)));
  const agents = new Map<string, { status: string; message: string }>();
  for (const item of items) {
    if (item.type !== 'collabAgentToolCall') continue;
    for (const [id, raw] of Object.entries(object(item.agentsStates))) {
      const value = object(raw); const previous = agents.get(id); const nextStatus = string(value.status);
      const terminal = (status: string) => ['completed', 'errored', 'interrupted', 'shutdown', 'notFound'].includes(status);
      if (previous && terminal(previous.status) && !terminal(nextStatus) && !['resumeAgent', 'followupTask', 'sendInput'].includes(string(item.tool))) continue;
      agents.set(id, { status: nextStatus, message: string(value.message) });
    }
  }
  return <>
    <section className="inspector-section"><h2>执行状态</h2><dl className="detail-list"><div><dt>当前 Turn</dt><dd>{state.activeTurnId ? '正在执行' : '无进行中的执行'}</dd></div><div><dt>会话同步</dt><dd>{state.synchronization === 'current' ? '已同步' : state.synchronization === 'synchronizing' ? '正在同步' : '等待校正'}</dd></div><div><dt>原生交互</dt><dd>{state.interactions.filter(item => item.status !== 'resolved').length || '无待处理交互'}</dd></div></dl></section>
    <section className="inspector-section"><h2>Plan <span>{plan.length} 项</span></h2>{string(planObject.explanation) && <p className="inspector-note">{string(planObject.explanation)}</p>}{plan.length ? <ol className="inspector-plan">{plan.map((entry, index) => { const step = object(entry); return <li key={index}><span className={step.status === 'completed' ? 'add-text' : ''}>{step.status === 'completed' ? '✓' : index + 1}</span><div>{string(step.step) || string(step.title) || '未命名步骤'}<small>{statusLabel(step.status)}</small></div></li>; })}</ol> : <p className="inspector-note">当前会话尚未收到原生计划。</p>}</section>
    <section className="inspector-section"><h2>工具与执行 <span>{tools.length}</span></h2>{tools.length ? tools.map(item => <details className="inspector-process" key={string(item.id)}><summary><span>{toolLabel(item)}</span><small>{statusLabel(item.status)}</small></summary>{string(item.command) && <pre>{string(item.command)}</pre>}{string(item.aggregatedOutput) && <pre>{string(item.aggregatedOutput)}</pre>}{string(item.text) && <pre>{string(item.text)}</pre>}{item.truncated === true && <p className="inspector-note">内容有截断，可在对话中打开完整详情。</p>}</details>) : <p className="inspector-note">还没有收到工具执行记录。</p>}</section>
    <section className="inspector-section"><h2>可见子代理 <span>{agents.size}</span></h2>{agents.size ? [...agents].map(([id, agent], index) => <details className="inspector-process" key={id}><summary><span>子代理 {index + 1}</span><small>{statusLabel(agent.status)}</small></summary><p className="inspector-note">{id}</p>{agent.message && <pre>{agent.message}</pre>}</details>) : <p className="inspector-note">尚无可见子代理摘要。仅展示原生会话中实际返回的代理状态。</p>}</section>
    <section className="inspector-section"><h2>操作回执</h2>{state.operations.length ? <><dl className="detail-list">{state.operations.slice(-12).reverse().map(operation => <div key={operation.operationId}><dt>{operation.kind}</dt><dd>{statusLabel(operation.status)}</dd></div>)}</dl><p className="inspector-note">Gateway 接收回执与 Codex 执行完成分别确认。未知操作只查询原结果。</p></> : <p className="inspector-note">没有当前设备的操作记录。</p>}</section>
  </>;
}

function toolLabel(item: RecordValue): string {
  const names: Record<string, string> = { commandExecution: '命令执行', fileChange: '文件变更', mcpToolCall: 'MCP 工具', dynamicToolCall: '工具调用', collabAgentToolCall: '子代理操作', subAgentActivity: '子代理活动', webSearch: '网页搜索', imageView: '图片查看', contextCompaction: '上下文压缩', plan: '计划' };
  return names[string(item.type)] ?? (string(item.type) || '原生执行项');
}

function UsagePanel({ state, act, disabled }: Omit<Props, 'panel'>) {
  const nativeUsage = object(state.tokenUsage);
  const usage = Object.keys(object(nativeUsage.tokenUsage)).length ? object(nativeUsage.tokenUsage) : nativeUsage;
  const total = object(usage.total);
  const last = object(usage.last);
  const rate = state.rateLimits;
  const account = state.accountUsage;
  return <>
    <Refresh disabled={disabled} onClick={() => void act({ type: 'inspector', section: 'usage' })}>刷新用量</Refresh>
    <section className="inspector-section"><h2>会话 Token</h2>{Object.keys(usage).length ? <><TokenCounts value={total} /><dl className="detail-list"><div><dt>上下文窗口</dt><dd>{numberLabel(usage.modelContextWindow)}</dd></div></dl>{Object.keys(last).length > 0 && <details className="inspector-process"><summary>最近一次执行</summary><TokenCounts value={last} /></details>}</> : <p className="inspector-note">当前原生会话尚未返回 Token 用量。</p>}</section>
    <section className="inspector-section"><h2>账户额度</h2>{rate ? <>
      <dl className="detail-list"><div><dt>计划</dt><dd>{rate.rateLimits.planType || '未提供'}</dd></div><div><dt>可继续使用</dt><dd>{rate.ordinaryUsageAllowed === null ? '未提供' : rate.ordinaryUsageAllowed ? '是' : '否'}</dd></div></dl>
      {([['主要窗口', rate.rateLimits.primary], ['次要窗口', rate.rateLimits.secondary]] as const).map(([label, window]) => window && <div className="inspector-quota" key={label}><div><span>{label}</span><b>{Number.isFinite(window.usedPercent) ? `${window.usedPercent.toFixed(1)}% 已用` : '未提供'}</b></div>{Number.isFinite(window.usedPercent) && <progress max={100} value={Math.max(0, Math.min(100, window.usedPercent))} aria-label={`${label}已用百分比`} />}{window.resetsAt !== null && <small>重置于 {dateLabel(window.resetsAt)}</small>}</div>)}
      {rate.rateLimits.credits && <dl className="detail-list"><div><dt>Credits</dt><dd>{rate.rateLimits.credits.unlimited ? '不限量' : rate.rateLimits.credits.balance ?? '未提供'}</dd></div></dl>}
      {rate.limited && <p className="inspector-note">当前接口仅提供部分账户额度。</p>}
      <p className="inspector-note">读取时间 {dateLabel(rate.readAt)}</p>
    </> : <p className="inspector-note">账户额度尚未读取或当前接口不可用。</p>}</section>
    <section className="inspector-section"><h2>账户用量</h2>{account ? <><dl className="detail-list"><div><dt>累计 Token</dt><dd>{numberLabel(account.summary.lifetimeTokens)}</dd></div><div><dt>单日最高 Token</dt><dd>{numberLabel(account.summary.peakDailyTokens)}</dd></div><div><dt>连续使用天数</dt><dd>{numberLabel(account.summary.currentStreakDays)}</dd></div><div><dt>最长连续天数</dt><dd>{numberLabel(account.summary.longestStreakDays)}</dd></div></dl>{account.dailyUsageBuckets?.length ? <details className="inspector-process"><summary>每日用量</summary><dl className="detail-list">{account.dailyUsageBuckets.map(day => <div key={day.startDate}><dt>{day.startDate}</dt><dd>{numberLabel(day.tokens)}</dd></div>)}</dl></details> : null}{account.limited && <p className="inspector-note">当前接口仅提供部分账户用量。</p>}<p className="inspector-note">读取时间 {dateLabel(account.readAt)}</p></> : <p className="inspector-note">账户用量尚未读取或当前接口不可用。</p>}</section>
  </>;
}

function TokenCounts({ value }: { value: RecordValue }) {
  return <dl className="detail-list">{([['总计', 'totalTokens'], ['输入', 'inputTokens'], ['缓存输入', 'cachedInputTokens'], ['输出', 'outputTokens'], ['思考输出', 'reasoningOutputTokens']] as const).map(([label, key]) => <div key={key}><dt>{label}</dt><dd>{numberLabel(value[key])}</dd></div>)}</dl>;
}

function dateLabel(value: number): string {
  // Protocol metadata uses milliseconds; native rate-limit reset windows use seconds.
  const date = new Date(value < 100_000_000_000 ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '未提供';
}

function ExtensionsPanel({ state, act, disabled }: Omit<Props, 'panel'>) {
  const labels = { mcp: 'MCP', skills: 'Skills', apps: 'Apps', plugins: 'Plugins' };
  return <><Refresh disabled={disabled || !state.projectId} onClick={() => void act({ type: 'inspector', section: 'extensions' })}>刷新扩展</Refresh>
    {!state.extensions && <Empty title="扩展能力">{state.projectId ? '读取当前项目可见的 MCP、Skills、Apps 和 Plugins。' : '选择项目后查看其可见扩展。'}</Empty>}
    {state.extensions?.sections.map(section => <section className="inspector-section" key={section.kind}><h2>{labels[section.kind]} <span>{section.status === 'available' ? section.entries.length : '不可用'}</span></h2>
      {section.status === 'unavailable' ? <p className="inspector-note">当前 Gateway 或 Codex 未提供此能力。{section.reasonCode && <span className="inspector-reason">{section.reasonCode}</span>}</p> : !section.entries.length ? <p className="inspector-note">没有可见的{labels[section.kind]}。</p> : section.entries.map(entry => <details className="inspector-process" key={entry.id}><summary><span>{entry.name}</span><small>{entry.enabled === false ? '已禁用' : entry.status || (entry.callable === false ? '不可调用' : '')}</small></summary>{entry.description && <p>{entry.description}</p>}<dl className="detail-list">{entry.version && <div><dt>版本</dt><dd>{entry.version}</dd></div>}{entry.toolCount !== undefined && <div><dt>工具</dt><dd>{numberLabel(entry.toolCount)}</dd></div>}{entry.resourceCount !== undefined && <div><dt>资源</dt><dd>{numberLabel(entry.resourceCount)}</dd></div>}</dl></details>)}
      {section.limited && <p className="inspector-note">这里只显示当前接口可读取的部分信息。</p>}
    </section>)}
    <p className="inspector-note">扩展信息为只读状态，不会在这里安装、启用或调用扩展。</p>
  </>;
}
