import { describe, expect, it } from 'vitest';
import { projectAccountRateLimits, projectAccountUsage, projectNativeDefaults } from './native-reads';
import { CodexError } from './codex';

describe('native config display projection', () => {
  it('keeps only supported facts and provenance kinds; strips all layer/config private data', () => {
    const raw = { config: { model: 'native-model', model_reasoning_effort: 'ultra', approval_policy: 'never', sandbox_mode: 'danger-full-access',
      sandbox_workspace_write: { network_access: true, writable_roots: ['/PRIVATE/root'] }, api_key: 'PRIVATE_KEY',
      developer_instructions: 'PRIVATE_INSTRUCTIONS', mcp_servers: { private: { env: { TOKEN: 'PRIVATE_TOKEN' } } } },
    origins: { model: { name: { type: 'user', file: '/PRIVATE/config.toml', profile: 'PRIVATE_PROFILE' }, version: 'PRIVATE_VERSION' },
      model_reasoning_effort: { name: { type: 'project', dotCodexFolder: '/PRIVATE/project/.codex' } },
      approval_policy: { name: { type: 'sessionFlags' } }, sandbox_workspace_write: { name: { type: 'system', file: '/PRIVATE/system' } },
      api_key: { name: { type: 'user', file: '/PRIVATE/credentials' } } },
    layers: [{ config: { token: 'PRIVATE_TOKEN' }, disabledReason: 'PRIVATE_REASON', name: { type: 'user', file: '/PRIVATE/config' } }] };
    expect(projectNativeDefaults(raw, 123)).toEqual({ source: 'native-config', readAt: 123, model: 'native-model', effort: 'ultra',
      approvalPolicy: 'never', sandboxMode: 'danger-full-access', workspaceWriteNetworkAccess: true,
      origins: { model: 'user', effort: 'project', approvalPolicy: 'sessionFlags', workspaceWriteNetworkAccess: 'system' } });
    expect(JSON.stringify(projectNativeDefaults(raw, 123))).not.toContain('PRIVATE');
  });
  it('retains absence as null without substituting model catalog or permission defaults', () => {
    expect(projectNativeDefaults({ config: {}, origins: {} }, 0)).toEqual({ source: 'native-config', readAt: 0, model: null,
      effort: null, approvalPolicy: null, sandboxMode: null, workspaceWriteNetworkAccess: null, origins: {} });
    expect(projectNativeDefaults({ config: { approval_policy: { granular: { rules: false, sandbox_approval: false, mcp_elicitations: true } } },
      origins: { model: { name: { type: 'futureSource', file: '/PRIVATE/file' } } } }, 0).approvalPolicy).toBe('custom');
  });
  it.each([null, { config: {} }, { config: [], origins: {} }, { config: { model: 'x'.repeat(257) }, origins: {} },
    { config: { model_reasoning_effort: 'high\nPRIVATE' }, origins: {} }, { config: { sandbox_mode: 'future' }, origins: {} },
    { config: { approval_policy: 'PRIVATE' }, origins: {} }, { config: { approval_policy: ['never'] }, origins: {} },
    { config: { sandbox_mode: ['read-only'] }, origins: {} }, { config: { sandbox_workspace_write: { network_access: 'true' } }, origins: {} }])(
    'rejects incompatible config facts without echoing their contents', raw => {
      expect(() => projectNativeDefaults(raw)).toThrow(CodexError);
      expect(() => projectNativeDefaults(raw)).toThrow('Incompatible supported native read response');
    });
});

describe('native account display projections', () => {
  it('preserves real quota, reset, and credit facts while omitting identities and opaque payloads', () => {
    const bucket = { limitId: 'codex', limitName: 'Codex', planType: 'pro', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1900000000 },
      secondary: { usedPercent: 102, windowDurationMins: 10080 }, credits: { hasCredits: true, unlimited: false, balance: '12.50' },
      individualLimit: { limit: '100', used: '42.5', remainingPercent: 58, resetsAt: 1900000001 }, spendControlReached: false,
      private: 'PRIVATE_DATA' };
    const value = projectAccountRateLimits({ rateLimits: bucket, rateLimitsByLimitId: { codex: bucket }, ordinaryUsageAllowed: false,
      accountId: 'PRIVATE_ACCOUNT', rateLimitUpsell: { message: 'PRIVATE_DATA' }, rateLimitResetCredits: { availableCount: 2,
        credits: [{ id: 'PRIVATE_ID', description: 'PRIVATE_DATA' }] } }, 123);
    expect(value.source).toBe('native-rate-limits');
    expect(value.readAt).toBe(123);
    expect(value.rateLimits.primary).toEqual({ usedPercent: 25, windowDurationMins: 300, resetsAt: 1900000000 });
    expect(value.rateLimits.secondary).toEqual({ usedPercent: 102, windowDurationMins: 10080, resetsAt: null });
    expect(value.rateLimits.credits).toEqual({ hasCredits: true, unlimited: false, balance: '12.50' });
    expect(value.rateLimits.individualLimit).toEqual({ limit: '100', used: '42.5', remainingPercent: 58, resetsAt: 1900000001 });
    expect(value.rateLimitsByLimitId?.codex).toEqual(value.rateLimits);
    expect(value.ordinaryUsageAllowed).toBe(false);
    expect(value.resetCreditsAvailable).toBe(2);
    expect(value.limited).toBe(false);
    expect(JSON.stringify(value)).not.toContain('PRIVATE');
  });
  it('keeps missing quota and token activity facts unknown', () => {
    expect(projectAccountRateLimits({ rateLimits: {} }, 0)).toEqual({ source: 'native-rate-limits', readAt: 0,
      rateLimits: { limitId: null, limitName: null, planType: null, primary: null, secondary: null, credits: null,
        rateLimitReachedType: null, spendControlReached: null, individualLimit: null }, rateLimitsByLimitId: null,
      ordinaryUsageAllowed: null, resetCreditsAvailable: null, limited: false });
    expect(projectAccountUsage({ summary: {} }, 0)).toEqual({ source: 'native-account-usage', readAt: 0,
      summary: { lifetimeTokens: null, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null },
      dailyUsageBuckets: null, limited: false });
    expect(projectAccountUsage({ summary: { lifetimeTokens: 0 }, dailyUsageBuckets: [] }, 0).summary.lifetimeTokens).toBe(0);
    expect(projectAccountUsage({ summary: {}, dailyUsageBuckets: [] }, 0).dailyUsageBuckets).toEqual([]);
  });
  it('projects bounded token activity and omits unscoped thread usage', () => {
    const value = projectAccountUsage({ summary: { lifetimeTokens: 12345, peakDailyTokens: 678, longestRunningTurnSec: 45,
      currentStreakDays: 2, longestStreakDays: 4, email: 'PRIVATE_EMAIL' }, dailyUsageBuckets: [{ startDate: '2026-11-14', tokens: 123,
      identity: 'PRIVATE_ID' }], threadUsage: { threadId: 'PRIVATE_THREAD', groups: [] } }, 1);
    expect(value).toEqual({ source: 'native-account-usage', readAt: 1, summary: { lifetimeTokens: 12345, peakDailyTokens: 678,
      longestRunningTurnSec: 45, currentStreakDays: 2, longestStreakDays: 4 }, dailyUsageBuckets: [{ startDate: '2026-11-14', tokens: 123 }], limited: false });
    expect(JSON.stringify(value)).not.toContain('PRIVATE');
  });
  it('bounds bucket counts and marks truncated or invalid identifiers', () => {
    const rateLimitsByLimitId = Object.fromEntries(Array.from({ length: 70 }, (_, i) => ['bucket' + i, {}]));
    const projected = projectAccountRateLimits({ rateLimits: {}, rateLimitsByLimitId });
    expect(projected.limited).toBe(true);
    expect(Object.keys(projected.rateLimitsByLimitId!)).toHaveLength(64);
    expect(projectAccountRateLimits({ rateLimits: {}, rateLimitsByLimitId: { '/PRIVATE/path': {} } }).rateLimitsByLimitId).toEqual({});
    expect(projectAccountRateLimits({ rateLimits: {}, rateLimitsByLimitId: { '/PRIVATE/path': {} } }).limited).toBe(true);
    const usage = projectAccountUsage({ summary: {}, dailyUsageBuckets: Array.from({ length: 400 }, () => ({ startDate: '2026-11-14', tokens: 1 })) });
    expect(usage.dailyUsageBuckets).toHaveLength(366);
    expect(usage.limited).toBe(true);
  });
  it.each([{ rateLimits: null }, { rateLimits: { primary: { usedPercent: -1 } } }, { rateLimits: { primary: { usedPercent: '25' } } },
    { rateLimits: { primary: { usedPercent: 20, resetsAt: Number.MAX_SAFE_INTEGER + 1 } } },
    { rateLimits: { credits: { hasCredits: true, unlimited: false, balance: 'PRIVATE' } } }, { rateLimits: {}, ordinaryUsageAllowed: 1 }])(
    'rejects malformed quota facts with a sanitized protocol error', raw => expect(() => projectAccountRateLimits(raw)).toThrow('Incompatible supported native read response'));
  it.each([{ summary: null }, { summary: { lifetimeTokens: -1 } }, { summary: { lifetimeTokens: Infinity } },
    { summary: { peakDailyTokens: 1.5 } }, { summary: {}, dailyUsageBuckets: [{ startDate: '2026-02-31', tokens: 1 }] },
    { summary: {}, dailyUsageBuckets: [{ startDate: '2026-11-14', tokens: 'PRIVATE' }] }])(
    'rejects malformed account activity without fabricating metrics', raw => expect(() => projectAccountUsage(raw)).toThrow(CodexError));
});
