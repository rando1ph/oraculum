import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, chmodSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrustStore } from './trust-store';
import { hostPaths, selectStateDirectory, startupPaths } from './paths';

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oraculum-paths-')); temporary.push(root);
  const home = join(root, 'another-home'), resources = join(root, 'usr/lib/oraculum/resources');
  mkdirSync(join(resources, 'apps/web/dist'), { recursive: true });
  mkdirSync(join(resources, 'themes'), { recursive: true });
  writeFileSync(join(resources, 'apps/web/dist/index.html'), '<html></html>');
  mkdirSync(home);
  return { root, home, resources, env: { HOME: home, ORACULUM_RESOURCE_DIR: resources } as NodeJS.ProcessEnv };
}
it('uses module-relative resources and absolute HOME/XDG paths independently of cwd', () => {
  const { home, env, root, resources } = fixture();
  Object.assign(env, { XDG_STATE_HOME: join(root, 'state'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache') });
  const p = hostPaths(env);
  expect(p.state).toBe(join(root, 'state/oraculum'));
  expect(p.workspaceRoot).toBe(join(root, 'data/oraculum/workspaces'));
  expect(p.projectRoots).toContain(join(home, 'Projects'));
  expect(p.projectRoots).toContain(join(home, '.cache/oraculum/workspaces'));
  expect(p.projectRoots).toContain(join(root, 'cache/oraculum/workspaces'));
  expect(p.web).toBe(join(resources, 'apps/web/dist'));
  expect(p.themeSource).toBe(join(resources, 'themes'));
});
it('ignores relative XDG values per XDG rules but rejects relative explicit app paths', () => {
  const { home, env } = fixture(); env.XDG_STATE_HOME = 'relative';
  expect(hostPaths(env).state).toBe(join(home, '.local/state/oraculum'));
  for (const key of ['ORACULUM_STATE_DIR', 'ORACULUM_RESOURCE_DIR', 'ORACULUM_WEB_DIR', 'ORACULUM_THEME_DIR', 'ORACULUM_THEME_SOURCE_DIR', 'ORACULUM_WORKSPACE']) {
    expect(() => hostPaths({ ...env, [key]: 'relative' })).toThrow('absolute');
  }
});
it('does not silently initialize a missing trust store, even with multiple legacy candidates', () => {
  const { root, env } = fixture(); const p = hostPaths(env);
  for (const name of ['legacy-a', 'legacy-b']) { mkdirSync(join(root, name)); writeFileSync(join(root, name, 'trust.sqlite'), 'fixture'); }
  expect(() => selectStateDirectory(p, env)).toThrow('ORACULUM_STATE_DIR');
  expect(existsSync(p.state)).toBe(false);
  expect(() => selectStateDirectory(p, { ...env, ORACULUM_STATE_DIR: join(root, 'missing') })).toThrow();
  expect(selectStateDirectory(p, { ...env, ORACULUM_INIT_STATE: '1' })).toBe(p.state);
  expect(existsSync(p.state)).toBe(false); // selection is a read-only preflight
});
it('rejects nonempty initialization targets, files and symlink ancestors without writes', () => {
  const { root, env } = fixture();
  const target = join(root, 'occupied'); mkdirSync(target); writeFileSync(join(target, 'keep'), 'untouched');
  expect(() => selectStateDirectory(hostPaths({ ...env, ORACULUM_STATE_DIR: target }), { ...env, ORACULUM_INIT_STATE: '1' })).toThrow('not empty');
  expect(existsSync(join(target, 'trust.sqlite'))).toBe(false);
  const link = join(root, 'link'); symlinkSync(target, link);
  expect(() => selectStateDirectory(hostPaths({ ...env, ORACULUM_STATE_DIR: join(link, 'new') }), env)).toThrow('symlink');
  expect(() => selectStateDirectory(hostPaths({ ...env, ORACULUM_STATE_DIR: join(target, 'keep') }), env)).toThrow('directory');
});
it('checks resources, port and workspace policy before any state creation', () => {
  const { root, home, env } = fixture(); env.ORACULUM_INIT_STATE = '1';
  const state = hostPaths(env).state;
  expect(() => startupPaths({ ...env, ORACULUM_WEB_DIR: join(root, 'missing') })).toThrow('Web');
  expect(() => startupPaths({ ...env, ORACULUM_PORT: 'NaN' })).toThrow('port');
  expect(() => startupPaths({ ...env, ORACULUM_WORKSPACE: root })).toThrow('allowed');
  expect(() => startupPaths({ ...env, ORACULUM_WORKSPACE: join(home, 'Projects/missing') })).toThrow('existing');
  expect(existsSync(state)).toBe(false);
  const valid = startupPaths(env);
  expect(valid.cwd).toBe(join(home, '.local/share/oraculum/workspaces/local'));
  expect(existsSync(valid.cwd)).toBe(false);
});
it('allows an explicitly selected existing project and preserves the legacy cache policy root', () => {
  const { home, env } = fixture(); env.ORACULUM_INIT_STATE = '1';
  const project = join(home, 'Projects/sample'); mkdirSync(project, { recursive: true });
  expect(startupPaths({ ...env, ORACULUM_WORKSPACE: project }).cwd).toBe(project);
  const old = join(home, '.cache/oraculum/workspaces/old'); mkdirSync(old, { recursive: true });
  expect(startupPaths({ ...env, ORACULUM_WORKSPACE: old }).cwd).toBe(old);
  expect(() => startupPaths(env)).toThrow('ORACULUM_WORKSPACE');
  const escape = join(home, 'Projects/escape'); symlinkSync('/tmp', escape);
  expect(() => startupPaths({ ...env, ORACULUM_WORKSPACE: escape })).toThrow('symlink');
});

it('selects one explicit store without touching another candidate, and rejects unknown schema before startup writes', () => {
  const { root, env } = fixture();
  const selected = join(root, 'selected'), other = join(root, 'other');
  new TrustStore(other).close();
  const store = new TrustStore(selected); store.close();
  const paths = hostPaths({ ...env, ORACULUM_STATE_DIR: selected });
  const otherBytes = readFileSync(join(other, 'trust.sqlite'));
  expect(selectStateDirectory(paths)).toBe(selected);
  const edited = new TrustStore(selected);
  edited.db.exec('ALTER TABLE devices ADD COLUMN custom_data TEXT'); edited.close();
  const before = readFileSync(join(selected, 'trust.sqlite'));
  expect(() => selectStateDirectory(paths)).toThrow('unknown trust schema');
  expect(readFileSync(join(selected, 'trust.sqlite')).equals(before)).toBe(true);
  expect(readFileSync(join(other, 'trust.sqlite')).equals(otherBytes)).toBe(true);
});
it('rejects read-only state/database/parent permissions before opening or creating anything', () => {
  const { root, env } = fixture(); const dir = join(root, 'selected'); new TrustStore(dir).close();
  const path = join(dir, 'trust.sqlite'), before = readFileSync(path);
  const paths = hostPaths({ ...env, ORACULUM_STATE_DIR: dir });
  try {
    chmodSync(dir, 0o500);
    expect(() => selectStateDirectory(paths)).toThrow('0700');
    chmodSync(dir, 0o700); chmodSync(path, 0o400);
    expect(() => selectStateDirectory(paths)).toThrow('0600');
    expect(readFileSync(path).equals(before)).toBe(true);
  } finally { chmodSync(dir, 0o700); chmodSync(path, 0o600); }
  const missing = join(dir, 'new/state'); chmodSync(dir, 0o500);
  try {
    expect(() => selectStateDirectory(hostPaths({ ...env, ORACULUM_STATE_DIR: missing }), { ORACULUM_INIT_STATE: '1' })).toThrow('not writable');
    expect(existsSync(join(dir, 'new'))).toBe(false);
  } finally { chmodSync(dir, 0o700); }
});
