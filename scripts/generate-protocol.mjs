import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const lock = JSON.parse(readFileSync(new URL('../protocol.lock.json', import.meta.url), 'utf8'));
// Build with a separately selected reviewed binary when the user's runtime CLI
// has upgraded. This selection never changes their installation or runtime PATH.
const binary = process.env.ORACULUM_CODEGEN_CODEX_BIN ?? 'codex';
if (process.env.ORACULUM_CODEGEN_CODEX_BIN !== undefined && !isAbsolute(binary)) {
  throw new Error('ORACULUM_CODEGEN_CODEX_BIN must be an absolute executable path');
}
const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
if (version !== lock.codexVersion) throw new Error(`Build schema requires ${lock.codexVersion}; got ${version}. Select the reviewed CLI with ORACULUM_CODEGEN_CODEX_BIN or review a schema upgrade. Runtime CLI versions are independent.`);
const local = fileURLToPath(new URL('../.local/', import.meta.url));
mkdirSync(local, { recursive: true });
const targets = ['codex-protocol', 'codex-schema', 'protocol-fingerprints.json'];
for (const target of targets) {
  const path = join(local, target);
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() ||
    (target.endsWith('.json') ? !lstatSync(path).isFile() : !lstatSync(path).isDirectory()))) {
    throw new Error(`Build output conflict at ${path}; existing inputs were not changed`);
  }
}
const staging = mkdtempSync(join(local, '.protocol-generation-'));
let preserveStaging = false;
try {
  for (const [command, directory] of [['generate-ts', 'codex-protocol'], ['generate-json-schema', 'codex-schema']]) {
    execFileSync(binary, ['app-server', command, '--out', join(staging, directory)], { stdio: 'inherit' });
  }
  const schema = join(staging, 'codex-schema');
  const files = readdirSync(schema, { recursive: true }).filter(p => p.endsWith('.json')).sort();
  const hashes = Object.fromEntries(files.map(p => [p, createHash('sha256').update(readFileSync(join(schema, p))).digest('hex')]));
  if (hashes['codex_app_server_protocol.schemas.json'] !== lock.schemaBundleSha256) {
    throw new Error('Native schema differs from protocol.lock.json. Existing build inputs preserved; review the contract, do not silently upgrade.');
  }
  writeFileSync(join(staging, 'protocol-fingerprints.json'), JSON.stringify({ version, hashes }, null, 2) + '\n');
  const backedUp = [], installed = [];
  try {
    for (const target of targets) {
      if (existsSync(join(local, target))) { renameSync(join(local, target), join(staging, `previous-${target}`)); backedUp.push(target); }
      renameSync(join(staging, target), join(local, target));
      installed.push(target);
    }
  } catch (error) {
    try {
      for (const target of installed.reverse()) rmSync(join(local, target), { recursive: true, force: true });
      for (const target of backedUp.reverse()) renameSync(join(staging, `previous-${target}`), join(local, target));
    } catch {
      preserveStaging = true;
      throw new Error(`Protocol publication rollback failed; preserved prior inputs in ${staging}. Restore them before building.`, { cause: error });
    }
    throw error;
  }
  console.log(`Generated reviewed build protocol for ${version}; ${files.length} JSON schemas (ignored build inputs).`);
} finally {
  if (!preserveStaging) rmSync(staging, { recursive: true, force: true });
}
