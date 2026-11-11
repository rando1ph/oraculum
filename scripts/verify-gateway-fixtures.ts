import { strict as assert } from 'node:assert';
import valid from '../packages/gateway-protocol/fixtures/valid.json';
import invalid from '../packages/gateway-protocol/fixtures/invalid.json';
import { parseContract, validateContract, type ContractName } from '../packages/gateway-protocol/src/index.js';
for (const fixture of valid) {
  const decoded = parseContract(fixture.contract as ContractName, JSON.parse(JSON.stringify(fixture.value)));
  const roundtrip = JSON.parse(JSON.stringify(decoded));
  assert(validateContract(fixture.contract as ContractName, roundtrip), fixture.name);
  assert.deepEqual(roundtrip, fixture.value, fixture.name);
}
for (const fixture of invalid) assert(!validateContract(fixture.contract as ContractName, fixture.value), fixture.name);
console.log(`TypeScript/Ajv: ${valid.length} round trips, ${invalid.length} rejected fixtures.`);
