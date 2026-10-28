import { beforeEach, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { cacheRatio, compactTokens, resetTime, SessionUsage, tokenSplit, WeeklyQuota, weeklyQuota } from './usage';
import { usageKey, useUsage } from './usage-store';
import { tokenUsage, rateLimits } from '../../../scripts/fixtures/usage';
import { normalizeLimits } from '../../../bridge/src/usage';
import type { LimitsSnapshot, ThreadUsage } from '../../../packages/shared/usage';
const stamp = { source: 'codex-app-server' as const, revision: 1, observedAt: 1793188800000 };
const thread: ThreadUsage = { ...stamp, threadId: 'a', cwd: '/a', turnId: 'turn-a', ...tokenUsage };
const account: LimitsSnapshot = { ...stamp, generation: 0, status: 'available', buckets: normalizeLimits(rateLimits) };
beforeEach(() => useUsage.getState().connect(true));
it('isolates projects and threads, rejects late RPCs and never accumulates duplicate snapshots', () => {
  const store = useUsage.getState(), ticket = store.connection;
  store.thread(thread); store.thread(thread);
  store.thread({ ...thread, cwd: '/b', threadId: 'b', total: { ...thread.total, totalTokens: 99 } });
  expect(useUsage.getState().threads[usageKey('/a', 'a')].total.totalTokens).toBe(42000);
  expect(useUsage.getState().threads[usageKey('/b', 'b')].total.totalTokens).toBe(99);
  store.thread({ ...thread, revision: 0, total: { ...thread.total, totalTokens: 5 } });
  expect(useUsage.getState().threads[usageKey('/a', 'a')].total.totalTokens).toBe(42000);
  store.limits({ ...account, revision: 10 }); store.snapshot({ account, thread }, ticket);
  expect(useUsage.getState().account?.revision).toBe(10);
  store.connect(false); store.snapshot({ account, thread }, ticket);
  expect(useUsage.getState().account).toBeUndefined();
  store.connect(true); store.snapshot({ account, thread }, ticket);
  expect(useUsage.getState().account).toBeUndefined(); expect(useUsage.getState().threads).toEqual({});
});
it('discards optional activity when the account changes and ignores old-account results', () => {
  const store = useUsage.getState(), ticket = store.connection;
  store.limits(account);
  store.accountActivity({ ...stamp, generation: 0, status: 'available', lifetimeTokens: 9000, peakDailyTokens: 1000 }, ticket);
  store.limits({ ...account, generation: 1, revision: 2, buckets: [], status: 'unavailable' });
  expect(useUsage.getState().activity).toBeUndefined();
  store.accountActivity({ ...stamp, generation: 0, status: 'available', lifetimeTokens: 9000, peakDailyTokens: 1000 }, ticket);
  expect(useUsage.getState().activity).toBeUndefined();
});
const renderSession = (value: ThreadUsage | undefined = thread, connected = true) => renderToStaticMarkup(<SessionUsage thread={value} selected connected={connected} refreshing={false} onRefresh={() => {}}/>);
const renderQuota = (value: LimitsSnapshot | undefined = account, connected = true) => renderToStaticMarkup(<WeeklyQuota account={value} connected={connected}/>);
it('selects only a verified Codex seven-day window and displays remaining quota', () => {
  expect(weeklyQuota(account)).toEqual({ remaining: 58, resetsAt: 1793635200 });
  const html = renderQuota();
  expect(html).toContain('58%'); expect(html).toContain('剩余'); expect(html).toContain('data-remaining="58"');
  expect(html).toContain('stroke-dasharray="58 100"');
  expect(html).toContain(new Date(1793635200 * 1000).toISOString());
  for (const text of ['Primary', 'Secondary', 'Code review', 'Credits', '25%', 'codex', 'review']) expect(html).not.toContain(text);
  const swapped = structuredClone(account); [swapped.buckets[0].primary, swapped.buckets[0].secondary] = [swapped.buckets[0].secondary, swapped.buckets[0].primary];
  expect(weeklyQuota(swapped)?.remaining).toBe(58);
  const other = structuredClone(account); other.buckets[0].secondary = null;
  other.buckets[1].primary = { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1793635200 };
  expect(weeklyQuota(other)).toBeNull();
  const unnamed = structuredClone(account); unnamed.buckets[0].limitId = null;
  expect(weeklyQuota(unnamed)?.remaining).toBe(58);
  unnamed.buckets[0].key = 'default'; expect(weeklyQuota(unnamed)).toBeNull();
});
it('keeps missing, five-hour-only, invalid or disconnected weekly quota unavailable without a fake ring', () => {
  const fiveHours = structuredClone(account); fiveHours.buckets[0].secondary = null;
  for (const value of [undefined, fiveHours, { ...account, status: 'unavailable' as const }, { ...account, buckets: [] }]) {
    expect(weeklyQuota(value)).toBeNull();
    const html = renderToStaticMarkup(<WeeklyQuota account={value} connected/>);
    expect(html).toContain('本周额度暂不可用'); expect(html).not.toContain('quota-ring'); expect(html).not.toContain('%');
  }
  for (const usedPercent of [null, NaN, Infinity, -1, 101]) {
    const invalid = structuredClone(account); invalid.buckets[0].secondary!.usedPercent = usedPercent;
    expect(weeklyQuota(invalid)).toBeNull();
  }
  for (const [usedPercent, remaining] of [[0, 100], [100, 0], [42.5, 57.5]]) {
    const valid = structuredClone(account); valid.buckets[0].secondary!.usedPercent = usedPercent;
    expect(weeklyQuota(valid)?.remaining).toBe(remaining);
  }
  expect(renderQuota(account, false)).toContain('连接后查看'); expect(renderQuota(account, false)).not.toContain('quota-ring');
  const missingReset = structuredClone(account); missingReset.buckets[0].secondary!.resetsAt = null;
  expect(renderQuota(missingReset)).toContain('重置时间暂不可用');
});
it('uses only verified input/output subsets for the chart, never context capacity', () => {
  expect(tokenSplit(tokenUsage.total)).toEqual({ input: 32000 / 42000 * 100, output: 10000 / 42000 * 100 });
  for (const value of [{ ...tokenUsage.total, totalTokens: 1 }, { ...tokenUsage.total, inputTokens: null }, { ...tokenUsage.total, outputTokens: -1 }, { ...tokenUsage.total, totalTokens: 0, inputTokens: 0, outputTokens: 0 }]) expect(tokenSplit(value)).toBeNull();
  expect(tokenSplit({ ...tokenUsage.total, cachedInputTokens: 1, reasoningOutputTokens: 1 })).toEqual(tokenSplit(tokenUsage.total));
  const html = renderSession();
  for (const text of ['本会话累计', '42k', '32,000', '10,000', '128k', '上限', '详细数据']) expect(html).toContain(text);
  expect(html).toContain('class="token-split"'); expect(html).not.toContain('<progress'); expect(html).not.toContain('32.8%');
  expect(html).toContain('<details class="usage-details">');
  expect(renderSession({ ...thread, total: { ...thread.total, totalTokens: 1 } })).not.toContain('class="token-split"');
});
it('keeps detailed counters accurate, defaults unavailable values to a dash and removes engineering/account prose', () => {
  const html = renderSession() + renderQuota();
  for (const text of ['6,500', '24,000', '6,000', '75%', '最近一次']) expect(html).toContain(text);
  for (const text of ['原生快照', '最近收到', '含于输入', '含于输出', '累计 Token 不代表', '生命周期', '单日峰值']) expect(html).not.toContain(text);
  expect(cacheRatio(thread.total)).toBe('75%');
  expect(cacheRatio({ ...thread.total, inputTokens: 0 })).toBe('—');
  expect(cacheRatio({ ...thread.total, cachedInputTokens: 999999 })).toBe('—');
  expect(compactTokens(42000)).toBe('42k'); expect(compactTokens(0)).toBe('0'); expect(compactTokens(null)).toBe('—');
  const empty = renderToStaticMarkup(<SessionUsage selected connected refreshing={false} onRefresh={() => {}}/>);
  expect(empty).toContain('此会话暂无用量数据'); expect(empty).not.toContain('class="token-split"');
  expect(renderSession(thread, false)).toContain('已离线 · 显示上次数据');
});
it('formats actual Unix seconds in local time and rejects ms and invalid dates', () => {
  const date = new Date(1793203200 * 1000);
  expect(resetTime(1793203200)).toBe(date.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
  for (const input of [null, -1, NaN, Infinity, 1793203200000]) expect(resetTime(input)).toBeNull();
});
