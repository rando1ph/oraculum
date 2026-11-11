import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { quicktype, InputData, JSONSchemaInput, FetchingJSONSchemaStore, getOptionValues, singleWord } from 'quicktype-core';

import { KotlinTargetLanguage, kotlinOptions } from 'quicktype-core/dist/language/Kotlin/language.js';
import { KotlinXRenderer } from 'quicktype-core/dist/language/Kotlin/KotlinXRenderer.js';
import { TypeScriptTargetLanguage, tsFlowOptions } from 'quicktype-core/dist/language/TypeScriptFlow/language.js';
import { TypeScriptRenderer } from 'quicktype-core/dist/language/TypeScriptFlow/TypeScriptRenderer.js';

// Preserve required-null presence: the upstream renderer gives nullable fields a
// default of null, which otherwise disappears when encodeDefaults is false.
class ContractKotlinRenderer extends KotlinXRenderer {
  emitClassDefinition(type, name) {
    this.contractClass = type;
    super.emitClassDefinition(type, name);
    this.contractClass = undefined;
  }
  renameAttribute(name, jsonName, required, metadata) {
    if (!this.contractClass?.getProperties().get(jsonName)?.isOptional) {
      metadata.push(() => this.emitLine('@Required'));
    }
    super.renameAttribute(name, jsonName, required, metadata);
  }
  emitUsageHeader() {
    this.emitLine('// Decode with Json { ignoreUnknownKeys = true; explicitNulls = true }.');
    this.emitLine('// Keep encodeDefaults = false. Validate requests against JSON Schema.');
  }
}
class ContractKotlin extends KotlinTargetLanguage {
  makeRenderer(context, options) { return new ContractKotlinRenderer(this, context, getOptionValues(kotlinOptions, options)); }
}
class ContractTsRenderer extends TypeScriptRenderer {
  sourceFor(type) { return type.kind === 'any' ? singleWord('unknown') : super.sourceFor(type); }
}
class ContractTs extends TypeScriptTargetLanguage {
  makeRenderer(context, options) { return new ContractTsRenderer(this, context, getOptionValues(tsFlowOptions, options)); }
}

const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'packages/gateway-protocol/generated');
const schemaText = await readFile(resolve(root, 'packages/gateway-protocol/schema/v2.json'), 'utf8');
const schema = JSON.parse(schemaText);
const version = JSON.parse(await readFile(resolve(root, 'node_modules/quicktype-core/package.json'), 'utf8')).version;
if (version !== '24.0.0') throw new Error(`Generator version mismatch: ${version}`);
const names = Object.keys(schema.definitions).filter(n => !['JsonValue', 'OpaqueObject', 'InteractionAnswer'].includes(n));
const input = new JSONSchemaInput(new FetchingJSONSchemaStore());
for (const name of names) {
  await input.addSource({ name, schema: JSON.stringify({ ...schema, title: name, description: undefined, $id: undefined, $ref: `#/definitions/${name}` }) });
}
const data = new InputData();
data.addInput(input);
await mkdir(output, { recursive: true });
for (const [lang, filename, rendererOptions] of [
  [new ContractTs(), 'types.ts', { 'just-types': 'true', 'prefer-unions': 'true', 'prefer-const-values': 'true' }],
  [new ContractKotlin(), 'GatewayDtos.kt', { framework: 'kotlinx', package: 'dev.oraculum.gateway.protocol' }],
]) {
  const result = await quicktype({ inputData: data, lang, rendererOptions, alphabetizeProperties: true });
  const header = `// Generated from schema/v2.json by quicktype-core ${version}; DO NOT EDIT.\n// Schema SHA-256: ${createHash('sha256').update(schemaText).digest('hex')}\n`;
  await writeFile(resolve(output, filename), header + result.lines.join('\n').trimEnd() + '\n');
}
await writeFile(resolve(output, 'contract-names.ts'), `// Generated from schema/v2.json; DO NOT EDIT.\nexport const contractNames = ${JSON.stringify(Object.keys(schema.definitions), null, 2)} as const;\nexport type ContractName = typeof contractNames[number];\n`);
await writeFile(resolve(output, 'contract-types.ts'), '// Generated from schema/v2.json; DO NOT EDIT.\nimport type * as Dto from "./types.js";\nexport interface ContractTypes {\n' + Object.keys(schema.definitions).map(name => `  ${name}: ${name === 'JsonValue' ? 'unknown' : name === 'OpaqueObject' ? 'Record<string, unknown>' : `Dto.${name}`};`).join('\n') + '\n}\n');
console.log(`Generated ${names.length} DTO roots with quicktype-core ${version}.`);
