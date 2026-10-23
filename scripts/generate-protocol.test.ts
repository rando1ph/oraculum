import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oraculum-codegen-'));
  fixtures.push(root);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, '.local/codex-protocol'), { recursive: true });
  mkdirSync(join(root, '.local/codex-schema'), { recursive: true });
  mkdirSync(join(root, 'unrelated-cwd'));
  writeFileSync(join(root, '.local/codex-protocol/previous.ts'), 'previous-types');
  writeFileSync(join(root, '.local/codex-schema/previous.json'), 'previous-schema');
  writeFileSync(join(root, '.local/protocol-fingerprints.json'), 'previous-fingerprints');
  copyFileSync(new URL('./generate-protocol.mjs', import.meta.url), join(root, 'scripts/generate-protocol.mjs'));
  const schema = '{"reviewed":true}';
  writeFileSync(join(root, 'protocol.lock.json'), JSON.stringify({ codexVersion: 'codex-cli 0.160.0', schemaBundleSha256: createHash('sha256').update(schema).digest('hex') }));
  const binary = join(root, 'fixture-codex.mjs');
  writeFileSync(binary, `#!${process.execPath}
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv[2] === '--version') { console.log(process.env.FIXTURE_CODEGEN_VERSION ?? 'codex-cli 0.160.0'); process.exit(0); }
const command = process.argv[3];
const directory = process.argv[5];
mkdirSync(directory, { recursive: true });
if (command === 'generate-ts') writeFileSync(join(directory, 'Type.ts'), 'export type Example = string;');
if (command === 'generate-json-schema') {
  if (process.env.FIXTURE_CODEGEN_FAILURE === 'command') process.exit(7);
  writeFileSync(join(directory, 'codex_app_server_protocol.schemas.json'), process.env.FIXTURE_CODEGEN_FAILURE === 'schema' ? '{}' : ${JSON.stringify(schema)});
}
`, { mode: 0o700 });
  const run = (env: Record<string, string> = {}) => spawnSync(process.execPath, [join(root, 'scripts/generate-protocol.mjs')], {
    cwd: join(root, 'unrelated-cwd'), encoding: 'utf8', env: { ...process.env, ORACULUM_CODEGEN_CODEX_BIN: binary, ...env },
  });
  const previousUnchanged = () => {
    expect(readFileSync(join(root, '.local/codex-protocol/previous.ts'), 'utf8')).toBe('previous-types');
    expect(readFileSync(join(root, '.local/codex-schema/previous.json'), 'utf8')).toBe('previous-schema');
    expect(readFileSync(join(root, '.local/protocol-fingerprints.json'), 'utf8')).toBe('previous-fingerprints');
    expect(readdirSync(join(root, '.local')).some(name => name.startsWith('.protocol-generation-'))).toBe(false);
  };
  return { root, run, previousUnchanged };
}

it('generates from an explicitly selected reviewed CLI independently of cwd and runtime CLI settings', () => {
  const { root, run } = fixture();
  const result = run({ ORACULUM_CODEX_BIN: '/unrelated/runtime-codex' });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(root, '.local/codex-protocol/Type.ts'), 'utf8')).toContain('export type Example');
  expect(readdirSync(join(root, '.local/codex-protocol'))).toEqual(['Type.ts']);
  expect(JSON.parse(readFileSync(join(root, '.local/protocol-fingerprints.json'), 'utf8')).version).toBe('codex-cli 0.160.0');
  expect(readdirSync(join(root, 'unrelated-cwd'))).toEqual([]);
});

it.each(['command', 'schema'])('preserves all existing build inputs when %s generation fails', failure => {
  const { run, previousUnchanged } = fixture();
  expect(run({ FIXTURE_CODEGEN_FAILURE: failure }).status).not.toBe(0);
  previousUnchanged();
});

it('keeps a deliberate reviewed build-version gate with an actionable independent CLI selection', () => {
  const { run, previousUnchanged } = fixture();
  const result = run({ FIXTURE_CODEGEN_VERSION: 'codex-cli 0.161.0' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('ORACULUM_CODEGEN_CODEX_BIN');
  expect(result.stderr).toContain('Runtime CLI versions are independent');
  previousUnchanged();
});

it('fails safely on conflicting output paths without touching existing inputs', () => {
  const { root, run } = fixture();
  rmSync(join(root, '.local/codex-schema'), { recursive: true });
  writeFileSync(join(root, '.local/codex-schema'), 'unexpected-file');
  const result = run();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Build output conflict');
  expect(readFileSync(join(root, '.local/codex-schema'), 'utf8')).toBe('unexpected-file');
  expect(readFileSync(join(root, '.local/codex-protocol/previous.ts'), 'utf8')).toBe('previous-types');
});

it('rejects a relative codegen executable without changing old inputs', () => {
  const { run, previousUnchanged } = fixture();
  const result = run({ ORACULUM_CODEGEN_CODEX_BIN: './fixture-codex.mjs' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('absolute executable path');
  previousUnchanged();
});
