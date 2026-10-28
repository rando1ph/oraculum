import type { AccountUsageSnapshot, LimitsSnapshot, QuotaBucket, QuotaWindow, ThreadUsage, TokenCounts } from '../../packages/shared/usage';
import { NativeRpcError } from './codex';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const label = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value) ? value : null;
const boolean = (value: unknown) => typeof value === 'boolean' ? value : null;
function counts(value: unknown): TokenCounts {
  const data = object(value);
  return Object.fromEntries(['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'].map(key => [key, number(data[key])])) as TokenCounts;
}
export function normalizeThreadUsage(value: unknown) {
  const data = object(value);
  if (!Object.keys(data).length) return null;
  return { total: counts(data.total), last: counts(data.last), modelContextWindow: number(data.modelContextWindow) || null };
}
function window(value: unknown): QuotaWindow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = object(value), percent = data.usedPercent, reset = number(data.resetsAt);
  return { usedPercent: typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null,
    windowDurationMins: number(data.windowDurationMins) || null,
    // Unix seconds, never guess ms. Reject invalid / implausibly distant dates.
    resetsAt: reset !== null && reset > 0 && reset <= 253402300799 ? reset : null };
}
function bucket(value: unknown, key: string): QuotaBucket {
  const data = object(value), credits = object(data.credits);
  return { key, limitId: label(data.limitId), limitName: label(data.limitName), primary: window(data.primary), secondary: window(data.secondary),
    credits: data.credits && typeof data.credits === 'object' ? { hasCredits: boolean(credits.hasCredits), unlimited: boolean(credits.unlimited),
      balance: typeof credits.balance === 'string' && /^\d+(\.\d+)?$/.test(credits.balance) && credits.balance.length <= 40 ? credits.balance : null } : null };
}
export function normalizeLimits(value: unknown): QuotaBucket[] {
  const data = object(value), buckets = new Map<string, QuotaBucket>();
  const byId = object(data.rateLimitsByLimitId);
  if (Object.keys(object(data.rateLimits)).length) {
    const single = object(data.rateLimits), key = label(single.limitId) ?? 'default';
    // The legacy single view mirrors the map; without an ID it cannot prove an
    // additional independent bucket. Prefer the explicitly keyed native view.
    if (label(single.limitId) || !Object.keys(byId).length) buckets.set(key, bucket(single, key));
  }
  for (const [id, value] of Object.entries(byId).slice(0, 100)) {
    if (!label(id) || !Object.keys(object(value)).length) continue;
    buckets.set(id, bucket(value, id));
  }
  return [...buckets.values()];
}
export function mergeLimits(previous: QuotaBucket[], value: unknown): QuotaBucket[] {
  const merged = new Map(previous.map(entry => [entry.key, entry]));
  for (const next of normalizeLimits(value)) {
    const prior = merged.get(next.key);
    // Native rolling updates are sparse. Nullable metadata is not a clear.
    merged.set(next.key, prior ? { ...next, limitId: next.limitId ?? prior.limitId, limitName: next.limitName ?? prior.limitName,
      primary: next.primary ?? prior.primary, secondary: next.secondary ?? prior.secondary, credits: next.credits ?? prior.credits } : next);
  }
  return [...merged.values()];
}

type Request = <T>(method: string, params: object) => Promise<T>;
// No polling, persistence, credential exposure or dependency on experimentalApi.
export class NativeUsage {
  private revision = 0;
  private generation = 0;
  private lastRead = -Infinity;
  private pending?: Promise<LimitsSnapshot>;
  private patches: unknown[] = [];
  private accountId: string | null = null; // internal identity only; never serialized
  private usagePending?: Promise<AccountUsageSnapshot>;
  private usageReadAt = -Infinity;
  private live = true;
  private awaitingAccountRead = false;
  readonly threads = new Map<string, ThreadUsage>();
  account: LimitsSnapshot = { source: 'codex-app-server', generation: 0, revision: 0, observedAt: 0, status: 'unavailable', buckets: [] };
  activity: AccountUsageSnapshot = { source: 'codex-app-server', generation: 0, revision: 0, observedAt: 0, status: 'unavailable', lifetimeTokens: null, peakDailyTokens: null };
  constructor(private request: Request, private publish: (value: LimitsSnapshot) => void, private now = Date.now) {}
  private stamp() { return { source: 'codex-app-server' as const, generation: this.generation, revision: ++this.revision, observedAt: this.now() }; }
  invalidate(stopped = false) {
    ++this.generation; this.pending = undefined; this.usagePending = undefined; this.patches = []; this.accountId = null;
    this.lastRead = -Infinity; this.usageReadAt = -Infinity; if (stopped) this.live = false;
    this.awaitingAccountRead = true;
    this.activity = { ...this.stamp(), status: 'unavailable', lifetimeTokens: null, peakDailyTokens: null };
    this.account = { ...this.stamp(), status: 'unavailable', buckets: [] }; this.publish(this.account);
  }
  update(value: unknown) {
    // Rolling notifications have no account identity. After an auth change,
    // only a successful read in the new generation can establish ownership.
    if (!this.live || this.awaitingAccountRead || !normalizeLimits(value).length) return;
    // Save only the sanitized projection while a read is pending.
    const patch = { rateLimitsByLimitId: Object.fromEntries(normalizeLimits(value).map(b => [b.key, b])) };
    if (this.pending) this.patches.push(patch);
    this.account = { ...this.stamp(), status: 'available', buckets: mergeLimits(this.account.buckets, patch) };
    this.publish(this.account);
  }
  thread(threadId: string, cwd: string, turnId: unknown, value: unknown) {
    const data = normalizeThreadUsage(value);
    if (!data || !this.live) return null;
    const previous = this.threads.get(threadId), nativeTurn = label(turnId);
    // Reject provably older cumulative snapshots; never add counters ourselves.
    if (previous?.total.totalTokens != null && data.total.totalTokens != null && data.total.totalTokens < previous.total.totalTokens) return null;
    if (previous && JSON.stringify({ total: previous.total, last: previous.last, modelContextWindow: previous.modelContextWindow }) === JSON.stringify(data) && previous.turnId === nativeTurn) return null;
    const snapshot = { ...this.stamp(), threadId, cwd, turnId: nativeTurn, ...data };
    this.threads.set(threadId, snapshot); return snapshot;
  }
  read(): Promise<LimitsSnapshot> {
    if (this.pending) return this.pending;
    if (!this.live || this.account.status === 'unsupported' || this.now() - this.lastRead < 30_000) return Promise.resolve(this.account);
    const generation = this.generation, revision = this.account.revision;
    this.patches = []; this.lastRead = this.now();
    const pending = this.request<unknown>('account/rateLimits/read', {}).then(value => {
      if (generation !== this.generation) return this.account;
      const identity = label(object(value).accountId);
      const changed = this.accountId !== null && identity !== null && identity !== this.accountId;
      this.accountId = identity ?? this.accountId;
      if (changed) {
        ++this.generation; this.usagePending = undefined;
        this.activity = { ...this.stamp(), status: 'unavailable', lifetimeTokens: null, peakDailyTokens: null }; this.usageReadAt = -Infinity;
      }
      let buckets = normalizeLimits(value);
      if (!changed) for (const patch of this.patches) buckets = mergeLimits(buckets, patch);
      this.awaitingAccountRead = !buckets.length;
      this.account = { ...this.stamp(), status: buckets.length ? 'available' : 'unavailable', buckets };
      this.publish(this.account); return this.account;
    }).catch(error => {
      if (generation !== this.generation || this.account.revision !== revision) return this.account;
      this.account = { ...this.stamp(), status: error instanceof NativeRpcError && error.code === -32601 ? 'unsupported' : 'unavailable', buckets: [] };
      this.publish(this.account); return this.account;
    }).finally(() => { if (this.pending === pending) { this.pending = undefined; this.patches = []; } });
    this.pending = pending; return pending;
  }
  readActivity(): Promise<AccountUsageSnapshot> {
    if (this.usagePending) return this.usagePending;
    if (!this.live || this.activity.status === 'unsupported' || this.now() - this.usageReadAt < 60_000) return Promise.resolve(this.activity);
    const generation = this.generation; this.usageReadAt = this.now();
    const pending = this.request<unknown>('account/usage/read', {}).then(value => {
      if (generation !== this.generation) return this.activity;
      const summary = object(object(value).summary), lifetimeTokens = number(summary.lifetimeTokens), peakDailyTokens = number(summary.peakDailyTokens);
      this.activity = { ...this.stamp(), status: lifetimeTokens !== null || peakDailyTokens !== null ? 'available' : 'unavailable', lifetimeTokens, peakDailyTokens };
      return this.activity;
    }).catch(error => {
      if (generation !== this.generation) return this.activity;
      this.activity = { ...this.stamp(), status: error instanceof NativeRpcError && error.code === -32601 ? 'unsupported' : 'unavailable', lifetimeTokens: null, peakDailyTokens: null };
      return this.activity;
    }).finally(() => { if (this.usagePending === pending) this.usagePending = undefined; });
    this.usagePending = pending; return pending;
  }
}
