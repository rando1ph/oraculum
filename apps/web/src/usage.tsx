import type { LimitsSnapshot, QuotaWindow, ThreadUsage, TokenCounts } from '../../../packages/shared/usage';
import { Icon } from './icons';
import './usage.css';

export const tokenNumber = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString();
export function compactTokens(value: number | null | undefined) {
  if (value == null) return '—';
  const unit = value >= 1_000_000 ? 1_000_000 : value >= 1_000 ? 1_000 : 1;
  return (value / unit).toLocaleString(undefined, { maximumFractionDigits: unit === 1 ? 0 : 1 }) + (unit === 1_000_000 ? 'm' : unit === 1_000 ? 'k' : '');
}
export function resetTime(seconds: number | null) {
  if (seconds === null || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 253402300799) return null;
  return new Date(seconds * 1000).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function weeklyQuota(account: LimitsSnapshot | undefined): { remaining: number; resetsAt: number | null } | null {
  if (account?.status !== 'available') return null;
  const windows = account.buckets
    // Match a proven Codex bucket, not its display name or another product's quota.
    .filter(bucket => bucket.limitId === 'codex' || (bucket.limitId === null && bucket.key === 'codex'))
    .flatMap(bucket => [bucket.primary, bucket.secondary])
    .filter((window): window is QuotaWindow => window?.windowDurationMins === 10080 &&
      typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100);
  const window = windows[0];
  // Two conflicting weekly windows cannot establish one reliable remaining value.
  if (!window || windows.some(other => other.usedPercent !== window.usedPercent || other.resetsAt !== window.resetsAt)) return null;
  return { remaining: 100 - window.usedPercent!, resetsAt: window.resetsAt };
}
export function cacheRatio(counts: TokenCounts) {
  return counts.inputTokens !== null && counts.inputTokens > 0 && counts.cachedInputTokens !== null && counts.cachedInputTokens <= counts.inputTokens
    ? `${(counts.cachedInputTokens / counts.inputTokens * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : '—';
}
export function tokenSplit(counts: TokenCounts) {
  const { totalTokens: total, inputTokens: input, outputTokens: output } = counts;
  // Cached input / reasoning output are subsets. A chart uses only verified
  // input + output = total, and never total / context-window capacity.
  return total !== null && input !== null && output !== null &&
    [total, input, output, input + output].every(value => Number.isSafeInteger(value) && value >= 0) && total > 0 && input + output === total
    ? { input: input / total * 100, output: output / total * 100 } : null;
}
export function WeeklyQuota({ account, connected }: { account?: LimitsSnapshot; connected: boolean }) {
  const quota = connected ? weeklyQuota(account) : null;
  const percent = quota?.remaining.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const reset = quota ? resetTime(quota.resetsAt) : null;
  return <section className={`weekly-quota ${quota ? '' : 'quota-unavailable'}`} aria-label="Codex 本周额度">
    {quota && <svg className="quota-ring" aria-hidden="true" viewBox="0 0 48 48" data-remaining={quota.remaining}>
      <circle className="quota-ring-track" cx="24" cy="24" r="20"/>
      <circle className="quota-ring-value" cx="24" cy="24" r="20" pathLength="100" strokeDasharray={`${quota.remaining} 100`} transform="rotate(-90 24 24)"/>
    </svg>}
    <div className="weekly-quota-copy">
      {quota ? <><span className="quota-label">本周额度</span><div className="quota-remaining"><strong>{percent}%</strong><span>剩余</span></div>
        <small>{reset ? <><time dateTime={new Date(quota.resetsAt! * 1000).toISOString()}>{reset}</time> 重置</> : '重置时间暂不可用'}</small></>
        : <><span className="quota-label">本周额度暂不可用</span><small>{connected ? '额度更新后显示' : '连接后查看'}</small></>}
    </div>
  </section>;
}
function Counts({ counts }: { counts: TokenCounts }) {
  return <dl className="usage-metrics">
    <dt>总计</dt><dd>{tokenNumber(counts.totalTokens)}</dd>
    <dt>输入</dt><dd>{tokenNumber(counts.inputTokens)}</dd>
    <dt>输出</dt><dd>{tokenNumber(counts.outputTokens)}</dd>
    <dt title="缓存输入包含在输入 Token 中">缓存输入</dt><dd>{tokenNumber(counts.cachedInputTokens)}</dd>
    {counts.cacheWriteInputTokens !== null && <><dt>缓存写入</dt><dd>{tokenNumber(counts.cacheWriteInputTokens)}</dd></>}
    <dt title="推理输出包含在输出 Token 中">推理输出</dt><dd>{tokenNumber(counts.reasoningOutputTokens)}</dd>
    <dt title="缓存输入 ÷ 输入 Token；分母为零或未知时不计算">缓存率</dt><dd>{cacheRatio(counts)}</dd>
  </dl>;
}
export function SessionUsage({ thread, selected, connected, refreshing, onRefresh }: {
  thread?: ThreadUsage; selected: boolean; connected: boolean; refreshing: boolean; onRefresh: () => void;
}) {
  const split = thread ? tokenSplit(thread.total) : null;
  return <section className="session-usage" aria-label="当前会话用量">
    <header className="usage-heading"><h2>会话用量</h2><button className="icon-button" aria-label="刷新用量" title="刷新用量" disabled={!connected || refreshing} onClick={onRefresh}><Icon name="refresh" size={16}/></button></header>
    {!connected && thread && <p className="usage-offline">已离线 · 显示上次数据</p>}
    <div className="usage-total" title={thread ? `${tokenNumber(thread.total.totalTokens)} Tokens` : undefined}>
      <span>本会话累计</span><div><strong>{compactTokens(thread?.total.totalTokens)}</strong><span>Tokens</span></div>
    </div>
    {thread ? <>
      {split && <div className="token-split" aria-hidden="true"><span className="token-split-input" style={{ width: `${split.input}%` }}/><span className="token-split-output" style={{ width: `${split.output}%` }}/></div>}
      <dl className="usage-key-metrics"><div><dt><i className="input-key"/>输入</dt><dd>{tokenNumber(thread.total.inputTokens)}</dd></div><div><dt><i className="output-key"/>输出</dt><dd>{tokenNumber(thread.total.outputTokens)}</dd></div></dl>
      <div className="usage-context" title="模型的上下文容量上限；当前占用未知，不从累计 Token 推算"><span>上下文窗口</span><strong>{compactTokens(thread.modelContextWindow)}<small> 上限</small></strong></div>
      <details className="usage-details"><summary>详细数据<Icon name="chevron" size={14}/></summary>
        <section><h3>累计</h3><Counts counts={thread.total}/></section><section><h3>最近一次</h3><Counts counts={thread.last}/></section>
      </details>
    </> : <p className="usage-empty">{!selected ? '选择会话查看用量' : !connected ? '连接后查看用量' : '此会话暂无用量数据'}</p>}
  </section>;
}
