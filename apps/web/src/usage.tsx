import { useEffect, useRef } from 'react';
import type { AccountUsageSnapshot, LimitsSnapshot, QuotaBucket, QuotaWindow, ThreadUsage, TokenCounts } from '../../../packages/shared/usage';
import './usage.css';

export const tokenNumber = (value: number | null | undefined) => value == null ? '暂不可用' : value.toLocaleString();
export function resetTime(seconds: number | null) {
  if (seconds === null || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 253402300799) return '暂不可用';
  return new Date(seconds * 1000).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
}
const at = (ms: number) => ms ? new Date(ms).toLocaleString() : '尚未收到';
const duration = (minutes: number) => minutes % 1440 === 0 ? `${minutes / 1440} 天` : minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes.toLocaleString()} 分钟`;
export function cacheRatio(counts: TokenCounts) {
  return counts.inputTokens !== null && counts.inputTokens > 0 && counts.cachedInputTokens !== null && counts.cachedInputTokens <= counts.inputTokens
    ? `${(counts.cachedInputTokens / counts.inputTokens * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : '暂不可用';
}
function Counts({ title, counts }: { title: string; counts: TokenCounts }) {
  return <section className="usage-counts"><h3>{title}</h3><dl>
    <dt>总 Token</dt><dd>{tokenNumber(counts.totalTokens)}</dd>
    <dt>输入</dt><dd>{tokenNumber(counts.inputTokens)}</dd>
    <dt>缓存输入（含于输入）</dt><dd>{tokenNumber(counts.cachedInputTokens)}</dd>
    {counts.cacheWriteInputTokens !== null && <><dt>缓存写入</dt><dd>{tokenNumber(counts.cacheWriteInputTokens)}</dd></>}
    <dt>输出</dt><dd>{tokenNumber(counts.outputTokens)}</dd>
    <dt>推理输出（含于输出）</dt><dd>{tokenNumber(counts.reasoningOutputTokens)}</dd>
    <dt>缓存率</dt><dd>{cacheRatio(counts)}</dd>
  </dl></section>;
}
function Window({ label, value }: { label: string; value: QuotaWindow | null }) {
  return <div className="usage-window"><div><span>{label}{value?.windowDurationMins != null ? ` · ${duration(value.windowDurationMins)}` : ''}</span>
    <strong>{value?.usedPercent != null ? `已用 ${value.usedPercent.toLocaleString()}%` : '暂不可用'}</strong></div>
    {value?.usedPercent != null && <progress max={100} value={value.usedPercent} aria-label={`${label} 已用百分比`}/>}
    <small>重置：{resetTime(value?.resetsAt ?? null)}</small></div>;
}
function Bucket({ bucket }: { bucket: QuotaBucket }) {
  return <section className="usage-bucket"><h3>{bucket.limitName ?? bucket.limitId ?? '账户额度'}{bucket.limitName && bucket.limitId && <small>{bucket.limitId}</small>}</h3>
    <Window label="Primary" value={bucket.primary}/><Window label="Secondary" value={bucket.secondary}/>
    {bucket.credits && <p className="usage-note">账户 Credits：{bucket.credits.unlimited === true ? '原生报告不限额' : bucket.credits.balance !== null ? bucket.credits.balance : '暂不可用'}（独立于 Token 和窗口额度）</p>}
  </section>;
}
export function UsagePanel({ thread, account, activity, connected, open, onOpen, onClose, onRefresh, refreshing }: {
  thread?: ThreadUsage; account?: LimitsSnapshot; activity?: AccountUsageSnapshot; connected: boolean; open: boolean;
  onOpen: () => void; onClose: () => void; onRefresh: () => void; refreshing: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  const primary = account?.status === 'available' ? account.buckets.find(b => b.primary?.usedPercent != null) : undefined;
  return <>
    <button className="usage-summary" aria-label="用量详情" onClick={onOpen}>
      <span>用量 · {thread?.total.totalTokens != null ? `${tokenNumber(thread.total.totalTokens)} Token` : 'Token 暂不可用'}</span>
      <span>{!connected ? '已断线' : primary ? `${primary.limitName ?? primary.limitId ?? '账户'} 已用 ${primary.primary!.usedPercent}%` : '额度暂不可用'} <span aria-hidden="true">↗</span></span>
    </button>
    <dialog ref={dialog} className="usage-dialog" aria-labelledby="usage-title" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="usage-content"><header><div><h2 id="usage-title">用量</h2><p>Codex 原生快照</p></div><button aria-label="关闭用量" onClick={onClose}>关闭</button></header>
        {!connected && <p className="usage-note" role="status">连接已断开。会话数据为缓存，账户额度需重连后查询。</p>}
        <section><h3 className="usage-section-title">当前会话 · Token</h3>
          {thread ? <><div className="usage-count-grid"><Counts title="累计" counts={thread.total}/><Counts title="最近一次" counts={thread.last}/></div>
            <p className="usage-note">缓存率 = 缓存输入 ÷ 输入。缓存输入和推理输出是子集，不额外加总。</p>
            <div className="usage-context"><span>上下文窗口上限</span><strong>{tokenNumber(thread.modelContextWindow)}{thread.modelContextWindow !== null ? ' Token' : ''}</strong><small>当前占用未知</small></div>
            <p className="usage-note">最近收到：{at(thread.observedAt)}。累计 Token 不代表当前上下文占用。</p>
          </> : <p className="usage-note">暂不可用，等待该会话的原生用量快照。历史会话不保证提供此数据。</p>}
        </section>
        <section><h3 className="usage-section-title">账户额度 · 已用百分比</h3>
          {account?.status === 'available' ? <>{account.buckets.map(bucket => <Bucket key={bucket.key} bucket={bucket}/>)}<p className="usage-note">最近收到：{at(account.observedAt)} · 重置时间为本地时间。其他窗口请逐项查看。</p></>
            : <p className="usage-note">{account?.status === 'unsupported' ? '当前 Codex 不支持额度接口。' : '暂不可用，当前账户、Provider 或连接未提供额度。'}</p>}
        </section>
        <details className="usage-activity"><summary>账户 Token 活动（可选）</summary>
          {activity?.status === 'available' ? <><dl><dt>账户生命周期 Token</dt><dd>{tokenNumber(activity.lifetimeTokens)}</dd><dt>单日峰值 Token</dt><dd>{tokenNumber(activity.peakDailyTokens)}</dd></dl><p className="usage-note">最近读取：{at(activity.observedAt)}。这是账户累计统计，与当前会话和额度窗口分开。</p></>
            : <p className="usage-note">{activity?.status === 'unsupported' ? '当前 Codex 不支持账户活动接口。' : '暂不可用。该附加统计不影响会话操作。'}</p>}
        </details>
        <footer><span className="usage-note">读取有短暂缓存，更新事件自动同步</span><button disabled={!connected || refreshing} onClick={onRefresh}>{refreshing ? '读取中…' : '刷新用量'}</button></footer>
      </div>
    </dialog>
  </>;
}
