import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Ajv from 'ajv';

const root = fileURLToPath(new URL('../', import.meta.url));
const contractRoot = resolve(root, 'packages/gateway-protocol');
const temp = await mkdtemp(join(tmpdir(), 'oraculum-protocol-'));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180_000 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  const generated = join(temp, 'generated');
  console.log(run(process.execPath, ['scripts/generate-gateway-protocol.mjs', generated]).trim());
  for (const filename of await readdir(generated)) {
    assert.equal(await readFile(join(generated, filename), 'utf8'), await readFile(join(contractRoot, 'generated', filename), 'utf8'), `Generated drift: ${filename}; run pnpm gateway:protocol`);
  }
  const fixtures = JSON.parse(await readFile(join(contractRoot, 'fixtures/valid.json'), 'utf8'));
  const schema = JSON.parse(await readFile(join(contractRoot, 'schema/v2.json'), 'utf8'));
  const typed = 'import type * as Dto from "./generated/types.js";\n' + fixtures.map((fixture, index) => `const fixture${index}: Dto.${fixture.contract} = ${JSON.stringify(fixture.value)};`).join('\n');
  await writeFile(join(temp, 'fixtures.ts'), typed);
  console.log(run('pnpm', ['exec', 'tsc', '--strict', '--noEmit', '--skipLibCheck', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', join(temp, 'fixtures.ts'), join(generated, 'contract-types.ts')]).trim());
  console.log(run('pnpm', ['exec', 'tsx', 'scripts/verify-gateway-fixtures.ts']).trim());

  const lock = JSON.parse(await readFile(join(contractRoot, 'kotlin/toolchain.lock.json'), 'utf8'));
  const cache = resolve(root, '.local/gateway-protocol-toolchain');
  await mkdir(cache, { recursive: true });
  const jars = await Promise.all(lock.artifacts.map(async artifact => {
    const filename = join(cache, artifact.name);
    if (!existsSync(filename)) {
      const response = await fetch(artifact.url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`Cannot fetch ${artifact.name}: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256, `Downloaded artifact integrity: ${artifact.name}`);
      await writeFile(filename, bytes, { flag: 'wx' });
    }
    assert.equal(createHash('sha256').update(await readFile(filename)).digest('hex'), artifact.sha256, `Cached artifact integrity: ${artifact.name}`);
    return filename;
  }));
  const jar = prefix => jars.find(file => file.split('/').at(-1).startsWith(prefix));
  const classpath = jars.join(delimiter);
  const names = [...new Set(fixtures.map(fixture => fixture.contract))];
  const harness = `package dev.oraculum.gateway.protocol
import java.io.File
import kotlinx.serialization.*
import kotlinx.serialization.json.*
@OptIn(ExperimentalSerializationApi::class)
fun main(args: Array<String>) {
  val json = Json { ignoreUnknownKeys = true; explicitNulls = true; encodeDefaults = false }
  val fixtures = json.parseToJsonElement(File(args[0]).readText()).jsonArray
  val results = fixtures.map { entry ->
    val fixture = entry.jsonObject
    val contract = fixture.getValue("contract").jsonPrimitive.content
    val value = fixture.getValue("value")
    val result = when (contract) {
${names.map(name => `      "${name}" -> json.encodeToJsonElement(${name}.serializer(), json.decodeFromJsonElement(${name}.serializer(), value))`).join('\n')}
      else -> error("Unknown fixture contract: $contract")
    }
    buildJsonObject { put("name", fixture.getValue("name")); put("value", result) }
  }
  print(JsonArray(results).toString())
}
`;
  await writeFile(join(temp, 'Roundtrip.kt'), harness);
  const output = join(temp, 'kotlin-classes');
  run('java', ['-cp', classpath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-classpath', classpath, `-Xplugin=${jar('kotlin-serialization-compiler-plugin-embeddable-')}`, '-d', output, join(generated, 'GatewayDtos.kt'), join(temp, 'Roundtrip.kt')]);
  const kotlin = JSON.parse(run('java', ['-cp', [output, ...jars].join(delimiter), 'dev.oraculum.gateway.protocol.RoundtripKt', join(contractRoot, 'fixtures/valid.json')]));
  assert.equal(kotlin.length, fixtures.length);
  const ajv = new Ajv({ strict: true, allErrors: false });
  ajv.addSchema(schema);
  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i];
    assert.equal(kotlin[i].name, fixture.name);
    const validate = ajv.compile({ $ref: `${schema.$id}#/definitions/${fixture.contract}` });
    assert(validate(kotlin[i].value), `${fixture.name} Kotlin output failed schema: ${JSON.stringify(validate.errors)}`);
    assert.deepEqual(kotlin[i].value, fixture.roundtrip ?? fixture.value, `${fixture.name} Kotlin round trip`);
  }
  console.log(`Kotlin ${lock.kotlinVersion}/kotlinx.serialization ${lock.serializationVersion}: compiled ${names.length} DTO roots and passed ${kotlin.length} shared-fixture round trips.`);
  console.log('Gateway protocol generation, TypeScript compilation, runtime validation and Kotlin round trips passed.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
