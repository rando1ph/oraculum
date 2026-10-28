// Synthetic values following native 0.160 / 0.164 / published 0.165 shapes.
// No real account values or identities are kept in fixtures.
export const tokenUsage = {
  total: { totalTokens: 42000, inputTokens: 32000, cachedInputTokens: 24000, cacheWriteInputTokens: 500, outputTokens: 10000, reasoningOutputTokens: 6000 },
  last: { totalTokens: 6500, inputTokens: 5000, cachedInputTokens: 4000, cacheWriteInputTokens: 0, outputTokens: 1500, reasoningOutputTokens: 900 },
  modelContextWindow: 128000,
};
export const rateLimits = {
  accountId: 'synthetic-account-a', ordinaryUsageAllowed: true,
  rateLimits: { limitId: 'codex', limitName: 'Codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1793203200 },
    secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 1793635200 }, credits: { hasCredits: true, unlimited: false, balance: '12.50' } },
  rateLimitsByLimitId: {
    codex: { limitId: 'codex', limitName: 'Codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1793203200 },
      secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 1793635200 }, credits: { hasCredits: true, unlimited: false, balance: '12.50' } },
    review: { limitId: 'review', limitName: 'Code review', primary: { usedPercent: 8, windowDurationMins: 60, resetsAt: 1793192400 }, secondary: null },
  },
};
