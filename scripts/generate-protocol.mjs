import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const expectedVersion = 'codex-cli 0.160.0';
const version = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim();
if (version !== expectedVersion) throw new Error(`Expected ${expectedVersion}; got ${version}. Review protocol upgrade first.`);
for (const [command, directory] of [['generate-ts', 'codex-protocol'], ['generate-json-schema', 'codex-schema']]) {
  mkdirSync(`.local/${directory}`, { recursive: true });
  execFileSync('codex', ['app-server', command, '--out', `.local/${directory}`], { stdio: 'inherit' });
}
const files = readdirSync('.local/codex-schema', { recursive: true }).filter(p => p.endsWith('.json')).sort();
const hashes = Object.fromEntries(files.map(p => [p, createHash('sha256').update(readFileSync(join('.local/codex-schema', p))).digest('hex')]));
writeFileSync('.local/protocol-fingerprints.json', JSON.stringify({ version, hashes }, null, 2) + '\n');
console.log(`Generated protocol for ${version}; ${files.length} JSON schemas (ignored build inputs).`);
