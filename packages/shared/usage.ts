// Deliberately small, sanitized projection of stable Codex usage APIs.
// Counters are snapshots; cached input / reasoning output are subsets.
export type TokenCounts = {
  totalTokens: number | null; inputTokens: number | null; cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null; outputTokens: number | null; reasoningOutputTokens: number | null;
};
export type UsageStamp = { source: 'codex-app-server'; revision: number; observedAt: number };
export type ThreadUsage = UsageStamp & {
  threadId: string; cwd: string; turnId: string | null;
  total: TokenCounts; last: TokenCounts; modelContextWindow: number | null;
};
export type QuotaWindow = { usedPercent: number | null; windowDurationMins: number | null; resetsAt: number | null };
export type QuotaBucket = {
  key: string; limitId: string | null; limitName: string | null;
  primary: QuotaWindow | null; secondary: QuotaWindow | null;
  credits: { hasCredits: boolean | null; unlimited: boolean | null; balance: string | null } | null;
};
export type LimitsSnapshot = UsageStamp & {
  generation: number; status: 'available' | 'unavailable' | 'unsupported'; buckets: QuotaBucket[];
};
export type AccountUsageSnapshot = UsageStamp & {
  generation: number; status: 'available' | 'unavailable' | 'unsupported'; lifetimeTokens: number | null; peakDailyTokens: number | null;
};
export type UsageSnapshot = { account: LimitsSnapshot; thread: ThreadUsage | null };
