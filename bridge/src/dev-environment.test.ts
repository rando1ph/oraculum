import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
const { developmentEnvironment } = createRequire(import.meta.url)('../../scripts/dev-environment.cjs');
it('isolates all mutable development paths and drops inherited production settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'oraculum-dev-'));
  try {
    const env = developmentEnvironment({ ORACULUM_DEV_ROOT: root, ORACULUM_INIT_STATE: '1', ORACULUM_CONFIG_FILE: '/production/runtime.json' });
    for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'ORACULUM_STATE_DIR', 'ORACULUM_WORKSPACE', 'ORACULUM_THEME_DIR', 'ORACULUM_USER_DATA_DIR']) expect(env[key]).toMatch(root + '/');
    expect(env.ORACULUM_PORT).toBe('17861'); expect(env.ORACULUM_CONFIG_FILE).toBeUndefined();
    expect(() => developmentEnvironment({ ORACULUM_DEV_ROOT: root, ORACULUM_STATE_DIR: join(homedir(), '.local/state/oraculum/runtime') })).toThrow('isolated');
    expect(() => developmentEnvironment({ ORACULUM_DEV_ROOT: root }, undefined, [{ ORACULUM_WORKSPACE: root }])).toThrow('overlaps');
    mkdirSync(join(root, 'real')); symlinkSync(join(root, 'real'), join(root, 'link'));
    expect(() => developmentEnvironment({ ORACULUM_DEV_ROOT: join(root, 'link') })).toThrow('symlinks');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
