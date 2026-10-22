import { expect, it } from 'vitest';
import { elicitationFields, validElicitationContent } from './elicitation';

it('accepts known primitive fields when the native schema permits additional properties', () => {
  const schema = { type: 'object', properties: { confirmed: { type: 'boolean' } }, required: ['confirmed'], additionalProperties: true };
  expect(elicitationFields(schema)?.map(field => field.id)).toEqual(['confirmed']);
  expect(validElicitationContent(schema, { confirmed: false })).toBe(true);
  expect(validElicitationContent(schema, { confirmed: true, unsolicited: 'value' })).toBe(false);
  expect(elicitationFields({ ...schema, additionalProperties: { type: 'string' } })).toBeNull();
});
