import { describe, expect, it } from 'vitest';
import type { LocalConfig, Model, NativeSessionSettings, SendReceipt } from '../../../packages/shared/protocol';
import { acknowledgedComposerDraft, actualComposerValues, composerOverrides, confirmedComposerDraft, parseComposerDraft, permissionPreset, reconcileComposerDraft } from './composer-settings';

const models = [{ model: 'one', isDefault: true, defaultReasoningEffort: 'low' }, { model: 'two', defaultReasoningEffort: 'high' }] as Model[];
const settings: NativeSessionSettings = { model: 'one', effort: null, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } };
const config = { cwd: '/project', model: null, effort: null, approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user' } as LocalConfig;

describe('native composer values', () => {
  it('resolves native null effort from that model catalog, without replacing missing readback with global values', () => {
    expect(actualComposerValues(models, config, settings, true)).toMatchObject({ model: 'one', effort: 'low', permissionMode: 'read-only' });
    expect(actualComposerValues(models, config, { ...settings, model: 'two' }, true)).toMatchObject({ model: 'two', effort: 'high' });
    expect(actualComposerValues(models, config, undefined, true)).toEqual({ model: '', effort: '', permissionMode: '', permissionKey: '' });
    expect(actualComposerValues(models, config, { ...settings, effort: undefined }, true).effort).toBe('');
  });
  it('uses project model/catalog for a new thread, without claiming a sandbox mode is an exact permission preset', () => {
    expect(actualComposerValues(models, config)).toMatchObject({ model: 'one', effort: 'low', permissionMode: 'custom' });
    expect(actualComposerValues(models, { ...config, model: 'two' })).toMatchObject({ model: 'two', effort: 'high' });
  });
  it('never calls native custom roots, network, reviewer or approval policy a preset', () => {
    const auto: NativeSessionSettings = { ...settings, sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
    expect(permissionPreset(auto)).toBe('auto');
    expect(permissionPreset({ ...auto, sandbox: { ...auto.sandbox, writableRoots: ['/extra'] } } as NativeSessionSettings)).toBe('custom');
    expect(permissionPreset({ ...settings, sandbox: { type: 'readOnly', networkAccess: true } })).toBe('custom');
    expect(permissionPreset({ ...settings, approvalPolicy: 'never' })).toBe('custom');
    expect(permissionPreset({ ...settings, approvalsReviewer: 'guardian_subagent' })).toBe('custom');
    expect(permissionPreset({ ...settings, approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } })).toBe('full-access');
  });
});

describe('thread-scoped pending composer overrides', () => {
  const actual = actualComposerValues(models, config, settings, true);
  it('keeps unsent selections until actual confirmation and emits only explicit overrides', () => {
    const draft = { model: { value: 'two', base: 'one' }, effort: { value: 'high', base: 'low' } };
    expect(reconcileComposerDraft(draft, actual)).toEqual(draft);
    expect(composerOverrides(draft)).toEqual({ model: 'two', effort: 'high' });
    expect(reconcileComposerDraft(draft, { ...actual, model: 'two', effort: 'high' })).toEqual({});
    expect(composerOverrides({})).toEqual({});
  });
  it('drops stale pending values when another client changes native settings', () => {
    expect(reconcileComposerDraft({ model: { value: 'two', base: 'one' } }, { ...actual, model: 'three' })).toEqual({});
    expect(reconcileComposerDraft({ permissionMode: { value: 'auto', base: actual.permissionKey } }, { ...actual, permissionKey: 'changed-native-policy' })).toEqual({});
  });
  it('keeps an uncertain send, but lets confirmed actual custom permissions replace an accepted preset request', () => {
    const requested = { permissionMode: { value: 'auto', base: actual.permissionKey } };
    expect(confirmedComposerDraft(requested, settings)).toEqual(requested);
    const accepted = { permissionMode: { ...requested.permissionMode, acknowledged: true } };
    expect(confirmedComposerDraft(accepted)).toEqual(accepted);
    expect(confirmedComposerDraft(accepted, settings)).toEqual({});
  });
  it('resolves a lost ACK using only the submitted operation receipt, including a normalized unchanged native value', () => {
    const operationId = '12345678-1234-1234-1234-123456789abc';
    const submitted = { permissionMode: { value: 'auto', base: actual.permissionKey, operationId } };
    const receipt = { operationId, status: 'completed', turnId: 'turn', createdAt: 1 } as SendReceipt;
    expect(parseComposerDraft(JSON.stringify(submitted))).toEqual(submitted);
    for (const status of ['accepted', 'completed', 'failed', 'interrupted'] as const) {
      expect(confirmedComposerDraft(submitted, settings, [{ ...receipt, status }])).toEqual({});
    }
    for (const status of ['unknown', 'rejected'] as const) {
      expect(confirmedComposerDraft(submitted, settings, [{ ...receipt, status }])).toEqual(submitted);
    }
    expect(confirmedComposerDraft(submitted, settings, [{ ...receipt, operationId: 'different-operation' }])).toEqual(submitted);
    expect(confirmedComposerDraft(submitted, undefined, [receipt])).toEqual(submitted);
    const unsent = { permissionMode: { value: 'auto', base: actual.permissionKey } };
    expect(confirmedComposerDraft(unsent, settings, [receipt])).toEqual(unsent);
  });
  it('does not let an older ACK confirm a newly selected identical value or another pending operation', () => {
    const operationId = '12345678-1234-1234-1234-123456789abc';
    const draft = {
      model: { value: 'two', base: 'one', operationId },
      effort: { value: 'high', base: 'low', operationId: '87654321-1234-1234-1234-123456789abc' },
      permissionMode: { value: 'auto', base: actual.permissionKey },
    };
    const acknowledged = acknowledgedComposerDraft(draft, operationId);
    expect(acknowledged).toEqual({ ...draft, model: { ...draft.model, acknowledged: true } });
    expect(confirmedComposerDraft(acknowledged)).toEqual(acknowledged);
    expect(confirmedComposerDraft(acknowledged, settings)).toEqual({ effort: draft.effort, permissionMode: draft.permissionMode });
    expect(draft.model).not.toHaveProperty('acknowledged');
  });
  it('round-trips only bounded valid local draft data, without introducing an inherit choice', () => {
    expect(parseComposerDraft('{"model":{"value":"two","base":"one","acknowledged":true},"permissionMode":{"value":"inherit","base":"x"}}')).toEqual({ model: { value: 'two', base: 'one', acknowledged: true } });
    expect(parseComposerDraft('invalid')).toEqual({});
    expect(parseComposerDraft(JSON.stringify({ model: { value: 'x'.repeat(201), base: '' } }))).toEqual({});
  });
});
