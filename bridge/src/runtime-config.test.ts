import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
const { loadRuntimeConfig } = createRequire(import.meta.url)('../../packaging/runtime-config.cjs');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });
function fixture(values: object) {
  const root = mkdtempSync(join(tmpdir(), 'oraculum-config-')); roots.push(root);
  const path = join(root, 'runtime.json');
  writeFileSync(path, JSON.stringify(values), { mode: 0o600 });
  return { root, path };
}
it('loads private non-executable configuration with explicit environment precedence and CLI discovery', () => {
  const { root, path } = fixture({ ORACULUM_STATE_DIR: '/selected/state', CODEX_HOME: '/selected/codex' });
  const env: NodeJS.ProcessEnv = { HOME: root, ORACULUM_CONFIG_FILE: path, ORACULUM_STATE_DIR: '/override', PATH: '/usr/bin' };
  loadRuntimeConfig(env);
  expect(env.ORACULUM_STATE_DIR).toBe('/override');
  expect(env.CODEX_HOME).toBe('/selected/codex');
  expect(env.PATH).toBe(`/usr/bin:${root}/.local/bin`);
});
it('fails on a missing explicitly selected config instead of falling back to another state', () => {
  const { root, path } = fixture({});
  expect(() => loadRuntimeConfig({ HOME: root, ORACULUM_CONFIG_FILE: path + '.missing' })).toThrow('ENOENT');
});
it('rejects public config and persistent fresh-state overrides', () => {
  const { root, path } = fixture({ ORACULUM_INIT_STATE: '1' });
  expect(() => loadRuntimeConfig({ HOME: root, ORACULUM_CONFIG_FILE: path })).toThrow('Invalid runtime configuration');
  writeFileSync(path, '{}'); chmodSync(path, 0o644);
  expect(() => loadRuntimeConfig({ HOME: root, ORACULUM_CONFIG_FILE: path })).toThrow('private');
});
