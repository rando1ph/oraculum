import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import schema from '../schema/v2.json';
import { contractNames, type ContractName } from '../generated/contract-names.js';
import type { ContractTypes } from '../generated/contract-types.js';
import type { EventEnvelope } from '../generated/types.js';

export type * from '../generated/types.js';
export type { ContractName, ContractTypes };
export { contractNames };
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const PROTOCOL = Object.freeze({ major: 2, minor: 1, minClientMinor: 0 });
export const API_PREFIX = '/api/v2';

const ajv = new Ajv({ allErrors: false, strict: true, strictNumbers: true, removeAdditional: false, coerceTypes: false, useDefaults: false });
ajv.addSchema(schema);
const validators = new Map<ContractName, ValidateFunction>();
for (const name of contractNames) {
  validators.set(name, ajv.compile({ $ref: `${schema.$id}#/definitions/${name}` }));
}

/** Only structural paths/keywords are exposed: never echo input or secrets. */
export class ContractValidationError extends Error {
  readonly code = 'INVALID_REQUEST';
  readonly issues: ReadonlyArray<{ path: string; keyword: string }>;
  constructor(readonly contract: ContractName, errors: ErrorObject[] | null | undefined) {
    super(`Invalid ${contract}`);
    this.name = 'ContractValidationError';
    this.issues = (errors ?? []).map(error => ({ path: error.schemaPath, keyword: error.keyword }));
  }
}
export function validateContract<K extends ContractName>(name: K, value: unknown): value is ContractTypes[K] {
  return validators.get(name)!(value) as boolean;
}
export function assertContract<K extends ContractName>(name: K, value: unknown): asserts value is ContractTypes[K] {
  const validator = validators.get(name)!;
  if (!validator(value)) throw new ContractValidationError(name, validator.errors);
}
export function parseContract<K extends ContractName>(name: K, value: unknown): ContractTypes[K] {
  assertContract(name, value);
  return value;
}

// Unknown state changes invalidate the projection. They never grant permission,
// approve a native request, or allow a pending operation to be retried.
const payloadContracts: Readonly<Record<string, ContractName>> = Object.freeze({
  'item.delta': 'ItemDelta',
  'item.completed': 'ItemCompleted',
  'item.started': 'ItemCompleted',
  'interaction.opened': 'Interaction',
  'interaction.resolved': 'Interaction',
  'operation.changed': 'OperationReceipt',
  'project.changed': 'ProjectChanged',
  'history.invalidated': 'HistoryInvalidated',
  'connection.changed': 'ConnectionChanged',
});
export type EventDisposition = 'apply' | 'skip' | 'resynchronize';
export function classifyEvent(event: EventEnvelope): EventDisposition {
  const contract = payloadContracts[event.kind];
  if (contract && validateContract(contract, event.payload)) return 'apply';
  return event.impact === 'informational' ? 'skip' : 'resynchronize';
}
