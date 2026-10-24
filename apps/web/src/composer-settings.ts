import type { LocalConfig, Model, NativeSessionSettings, PermissionMode, SendReceipt } from '../../../packages/shared/protocol';

export type ComposerPermission = Exclude<PermissionMode, 'inherit'>;
type Choice = { value: string; base: string; acknowledged?: boolean; operationId?: string };
export type ComposerDraft = { model?: Choice; effort?: Choice; permissionMode?: Choice };
export type ComposerValues = { model: string; effort: string; permissionMode: ComposerPermission | 'custom' | ''; permissionKey: string };

export function permissionPreset(settings: NativeSessionSettings): ComposerValues['permissionMode'] {
  if (settings.approvalsReviewer !== 'user') return 'custom';
  const sandbox = settings.sandbox;
  if (sandbox.type === 'dangerFullAccess' && settings.approvalPolicy === 'never') return 'full-access';
  if (settings.approvalPolicy !== 'on-request') return 'custom';
  if (sandbox.type === 'readOnly' && sandbox.networkAccess === false) return 'read-only';
  if (sandbox.type === 'workspaceWrite' && sandbox.networkAccess === false && sandbox.writableRoots?.length === 0
    && sandbox.excludeTmpdirEnvVar === false && sandbox.excludeSlashTmp === false) return 'auto';
  return 'custom';
}

export function actualComposerValues(models: Model[], config?: LocalConfig, settings?: NativeSessionSettings, hasThread = false): ComposerValues {
  const model = hasThread ? settings?.model ?? '' : config?.model ?? models.find(model => model.isDefault)?.model ?? '';
  const catalog = models.find(entry => entry.model === model);
  const rawEffort = hasThread ? settings?.effort : config?.effort;
  const effort = rawEffort === null ? catalog?.defaultReasoningEffort ?? '' : rawEffort ?? '';
  if (hasThread) return { model, effort, permissionMode: settings ? permissionPreset(settings) : '',
    permissionKey: settings ? JSON.stringify([settings.approvalPolicy, settings.sandbox, settings.approvalsReviewer]) : '' };
  // Config reports a sandbox mode, not all resolved roots/network restrictions.
  // Wait for thread/start before claiming it matches an exact preset.
  const permissionMode = !config?.sandbox || !config.approvalPolicy ? '' : 'custom';
  return { model, effort, permissionMode, permissionKey: JSON.stringify([config?.approvalPolicy, config?.sandbox, config?.approvalsReviewer]) };
}

export function parseComposerDraft(raw: string | null): ComposerDraft {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const result: ComposerDraft = {};
    for (const key of ['model', 'effort', 'permissionMode'] as const) {
      const choice = (parsed as Record<string, unknown>)[key];
      if (!choice || typeof choice !== 'object') continue;
      const { value, base, acknowledged, operationId } = choice as Choice;
      if (typeof value !== 'string' || !value || value.length > 200 || typeof base !== 'string' || base.length > 20_000) continue;
      if (key === 'permissionMode' && !['read-only', 'auto', 'full-access'].includes(value)) continue;
      result[key] = { value, base, ...(acknowledged === true ? { acknowledged } : {}),
        ...(typeof operationId === 'string' && /^[a-f0-9-]{36}$/i.test(operationId) ? { operationId } : {}) };
    }
    return result;
  } catch { return {}; }
}

export function confirmedComposerDraft(draft: ComposerDraft, settings?: NativeSessionSettings, receipts: SendReceipt[] = []): ComposerDraft {
  if (!settings) return draft;
  const result = { ...draft };
  for (const key of ['model', 'effort', 'permissionMode'] as const) {
    const choice = draft[key];
    const receipt = choice?.operationId && receipts.find(receipt => receipt.operationId === choice.operationId);
    const accepted = choice?.acknowledged || (receipt && receipt.status !== 'unknown' && receipt.status !== 'rejected');
    if (accepted && (key === 'permissionMode' || settings[key] !== undefined)) delete result[key];
  }
  return result;
}

export function acknowledgedComposerDraft(draft: ComposerDraft, operationId: string): ComposerDraft {
  const result = { ...draft };
  for (const key of ['model', 'effort', 'permissionMode'] as const) {
    const choice = draft[key];
    if (choice?.operationId === operationId) result[key] = { ...choice, acknowledged: true };
  }
  return result;
}

// Draft overrides are not effective native settings. Native confirmation removes
// them; a changed base from another client wins over an obsolete local draft.
export function reconcileComposerDraft(draft: ComposerDraft, actual: ComposerValues): ComposerDraft {
  const result = { ...draft };
  for (const key of ['model', 'effort', 'permissionMode'] as const) {
    const choice = draft[key];
    const current = key === 'permissionMode' ? actual.permissionKey : actual[key];
    if (choice && current && (choice.value === actual[key] || choice.base !== current)) delete result[key];
  }
  return result;
}

export function composerOverrides(draft: ComposerDraft) {
  return {
    ...(draft.model ? { model: draft.model.value } : {}),
    ...(draft.effort ? { effort: draft.effort.value } : {}),
    ...(draft.permissionMode ? { permissionMode: draft.permissionMode.value as ComposerPermission } : {}),
  };
}
