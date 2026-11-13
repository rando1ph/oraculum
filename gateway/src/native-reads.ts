import { CodexError, record, type JsonObject } from './codex';

/** Display facts only. Never return native config trees, layer paths, identity, or credentials. */
export type NativeDefaults = {
  source: 'native-config'; readAt: number;
  model: string | null; effort: string | null; approvalPolicy: string | null; sandboxMode: string | null;
  workspaceWriteNetworkAccess: boolean | null;
  origins: Partial<Record<'model' | 'effort' | 'approvalPolicy' | 'sandboxMode' | 'workspaceWriteNetworkAccess', string>>;
};
export type RateLimitWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };
export type RateLimitSnapshot = {
  limitId: string | null; limitName: string | null; planType: string | null;
  primary: RateLimitWindow | null; secondary: RateLimitWindow | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  rateLimitReachedType: string | null; spendControlReached: boolean | null;
  individualLimit: { limit: string; used: string; remainingPercent: number; resetsAt: number } | null;
};
export type AccountRateLimits = {
  source: 'native-rate-limits'; readAt: number; rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null;
  ordinaryUsageAllowed: boolean | null; resetCreditsAvailable: number | null; limited: boolean;
};
export type AccountUsage = {
  source: 'native-account-usage'; readAt: number;
  summary: { lifetimeTokens: number | null; peakDailyTokens: number | null; longestRunningTurnSec: number | null;
    currentStreakDays: number | null; longestStreakDays: number | null };
  dailyUsageBuckets: { startDate: string; tokens: number }[] | null; limited: boolean;
};

const incompatible = (): never => { throw new CodexError('NATIVE_PROTOCOL', 'Incompatible supported native read response', 'rejected'); };
const object = (value: unknown): JsonObject => record(value) ? value : incompatible();
const number = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : incompatible();
const optionalNumber = (value: unknown): number | null => value == null ? null : number(value);
const boolean = (value: unknown): boolean => typeof value === 'boolean' ? value : incompatible();
const optionalBoolean = (value: unknown): boolean | null => value == null ? null : boolean(value);
const string = (value: unknown, max: number): string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : incompatible();
const optionalString = (value: unknown, max: number): string | null => value == null ? null : string(value, max);
const amount = (value: unknown): string => {
  const result = string(value, 64);
  return /^-?\d+(?:\.\d+)?$/.test(result) ? result : incompatible();
};
const optionalAmount = (value: unknown): string | null => value == null ? null : amount(value);
const sourceKinds = new Set(['packagedDefaults', 'mdm', 'system', 'enterpriseManaged', 'user', 'project', 'sessionFlags',
  'legacyManagedConfigTomlFromFile', 'legacyManagedConfigTomlFromMdm']);

/** On-disk resolved defaults, never a claim about an already loaded thread's execution settings. */
export function projectNativeDefaults(raw: unknown, readAt = Date.now()): NativeDefaults {
  const result = object(raw), config = object(result.config), origins = object(result.origins);
  const approval = config.approval_policy;
  const approvalPolicy = approval == null ? null : record(approval) ? 'custom'
    : typeof approval === 'string' && ['untrusted', 'on-request', 'on-failure', 'never'].includes(approval) ? approval : incompatible();
  const sandboxMode = config.sandbox_mode == null ? null
    : typeof config.sandbox_mode === 'string' && ['read-only', 'workspace-write', 'danger-full-access'].includes(config.sandbox_mode) ? config.sandbox_mode : incompatible();
  const workspaceWrite = config.sandbox_workspace_write == null ? undefined : object(config.sandbox_workspace_write);
  const provenance: NativeDefaults['origins'] = {};
  for (const [field, key] of Object.entries({ model: 'model', effort: 'model_reasoning_effort', approvalPolicy: 'approval_policy',
    sandboxMode: 'sandbox_mode', workspaceWriteNetworkAccess: 'sandbox_workspace_write.network_access' })) {
    const metadata = origins[key] ?? (field === 'workspaceWriteNetworkAccess' ? origins.sandbox_workspace_write : undefined);
    if (!record(metadata) || !record(metadata.name) || typeof metadata.name.type !== 'string' || !sourceKinds.has(metadata.name.type)) continue;
    provenance[field as keyof NativeDefaults['origins']] = metadata.name.type;
  }
  return { source: 'native-config', readAt: number(readAt), model: optionalString(config.model, 256),
    effort: optionalString(config.model_reasoning_effort, 64), approvalPolicy, sandboxMode,
    workspaceWriteNetworkAccess: optionalBoolean(workspaceWrite?.network_access), origins: provenance };
}

function window(value: unknown): RateLimitWindow | null {
  if (value == null) return null;
  const raw = object(value);
  return { usedPercent: number(raw.usedPercent), windowDurationMins: optionalNumber(raw.windowDurationMins), resetsAt: optionalNumber(raw.resetsAt) };
}
function snapshot(value: unknown): RateLimitSnapshot {
  const raw = object(value);
  const credit = raw.credits == null ? null : object(raw.credits);
  const individual = raw.individualLimit == null ? null : object(raw.individualLimit);
  return { limitId: optionalString(raw.limitId, 128), limitName: optionalString(raw.limitName, 256), planType: optionalString(raw.planType, 128),
    primary: window(raw.primary), secondary: window(raw.secondary),
    credits: credit && { hasCredits: boolean(credit.hasCredits), unlimited: boolean(credit.unlimited), balance: optionalAmount(credit.balance) },
    rateLimitReachedType: optionalString(raw.rateLimitReachedType, 128), spendControlReached: optionalBoolean(raw.spendControlReached),
    individualLimit: individual && { limit: amount(individual.limit), used: amount(individual.used),
      remainingPercent: number(individual.remainingPercent), resetsAt: number(individual.resetsAt) } };
}

/** Quota windows and spend-control facts retain their native meaning; no remaining tokens are invented. */
export function projectAccountRateLimits(raw: unknown, readAt = Date.now()): AccountRateLimits {
  const result = object(raw);
  let limited = false, rateLimitsByLimitId: AccountRateLimits['rateLimitsByLimitId'] = null;
  if (result.rateLimitsByLimitId != null) {
    const buckets = Object.entries(object(result.rateLimitsByLimitId));
    const accepted: [string, RateLimitSnapshot][] = [];
    limited = buckets.length > 64;
    for (const [key, value] of buckets.slice(0, 64)) {
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) { limited = true; continue; }
      accepted.push([key, snapshot(value)]);
    }
    rateLimitsByLimitId = Object.fromEntries(accepted);
  }
  const resetCredits = result.rateLimitResetCredits == null ? null : object(result.rateLimitResetCredits);
  return { source: 'native-rate-limits', readAt: number(readAt), rateLimits: snapshot(result.rateLimits), rateLimitsByLimitId,
    ordinaryUsageAllowed: optionalBoolean(result.ordinaryUsageAllowed), resetCreditsAvailable: resetCredits ? number(resetCredits.availableCount) : null, limited };
}

/** Account token activity is separate from quota windows and from project-authorized thread token usage. */
export function projectAccountUsage(raw: unknown, readAt = Date.now()): AccountUsage {
  const result = object(raw), summary = object(result.summary);
  let dailyUsageBuckets: AccountUsage['dailyUsageBuckets'] = null, limited = false;
  if (result.dailyUsageBuckets != null) {
    if (!Array.isArray(result.dailyUsageBuckets)) return incompatible();
    limited = result.dailyUsageBuckets.length > 366;
    dailyUsageBuckets = result.dailyUsageBuckets.slice(0, 366).map(value => {
      const bucket = object(value), date = string(bucket.startDate, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00.000Z')) || new Date(date + 'T00:00:00.000Z').toISOString().slice(0, 10) !== date) return incompatible();
      return { startDate: date, tokens: number(bucket.tokens) };
    });
  }
  return { source: 'native-account-usage', readAt: number(readAt), summary: {
    lifetimeTokens: optionalNumber(summary.lifetimeTokens), peakDailyTokens: optionalNumber(summary.peakDailyTokens),
    longestRunningTurnSec: optionalNumber(summary.longestRunningTurnSec), currentStreakDays: optionalNumber(summary.currentStreakDays),
    longestStreakDays: optionalNumber(summary.longestStreakDays) }, dailyUsageBuckets, limited };
}
