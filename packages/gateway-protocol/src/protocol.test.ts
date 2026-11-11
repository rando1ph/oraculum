import { describe, expect, it } from 'vitest';
import valid from '../fixtures/valid.json';
import invalid from '../fixtures/invalid.json';
import { assertContract, classifyEvent, parseContract, validateContract, type ContractName, type EventEnvelope } from './index.js';

describe('Gateway v2 JSON Schema contract', () => {
  for (const fixture of valid) {
    it(`accepts ${fixture.name}`, () => {
      expect(() => assertContract(fixture.contract as ContractName, fixture.value)).not.toThrow();
    });
  }
  for (const fixture of invalid) {
    it(`rejects ${fixture.name}`, () => {
      expect(validateContract(fixture.contract as ContractName, fixture.value)).toBe(false);
    });
  }
  it('does not modify input or echo credentials on rejection', () => {
    const request = { ...valid.find(f => f.contract === 'PairRequest')!.value, deviceCredential: 'fake-secret-do-not-echo' };
    const before = JSON.stringify(request);
    try { assertContract('PairRequest', request); } catch (error) {
      expect(JSON.stringify(error)).not.toContain('fake-secret-do-not-echo');
      expect(String(error)).toBe('ContractValidationError: Invalid PairRequest');
    }
    expect(JSON.stringify(request)).toBe(before);
  });
  it('treats unknown or malformed state events as an invalidation', () => {
    const base = parseContract('EventEnvelope', valid.find(f => f.contract === 'EventEnvelope')!.value);
    for (const impact of ['state', undefined, 'future-critical']) {
      expect(classifyEvent({ ...base, impact })).toBe('resynchronize');
    }
    expect(classifyEvent({ ...base, impact: 'informational' })).toBe('skip');
    expect(classifyEvent({ ...base, kind: 'operation.changed', payload: { status: 'accepted' } })).toBe('resynchronize');
    expect(classifyEvent({ ...base, kind: 'history.invalidated', payload: { reasonCode: 'EVENT_TOO_LARGE', truncated: true, detailsAvailable: true } })).toBe('apply');
    expect(classifyEvent({ ...base, kind: 'item.delta', payload: { delta: 'hello' } })).toBe('apply');
  });
  it('rejects nonfinite JS numbers even before JSON transport', () => {
    const event = valid.find(f => f.contract === 'EventEnvelope')!.value as EventEnvelope;
    for (const seq of [NaN, Infinity, -Infinity, 1.5]) expect(validateContract('EventEnvelope', { ...event, seq })).toBe(false);
  });
  it('bounds extension summary collections', () => {
    const section = valid.find(f => f.contract === 'ExtensionSection')!.value;
    expect(validateContract('ExtensionSection', { ...section, entries: Array.from({ length: 101 }, () => ({ id: 'id', name: 'name' })) })).toBe(false);
  });
});
