import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mainPath = resolve('apps/desktop/main.cjs');
const desktopRequire = createRequire(mainPath);
const { desktopPaths, prepareDesktopPaths } = desktopRequire('./paths.cjs') as {
  desktopPaths(env: NodeJS.ProcessEnv): { userData: string; icon: string };
  prepareDesktopPaths(env: NodeJS.ProcessEnv): { userData: string; icon: string };
};
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oraculum-desktop-paths-'));
  temporary.push(root);
  const home = join(root, 'other-user'), config = join(root, 'xdg-config');
  const resources = join(root, 'usr/lib/oraculum/resources');
  const icon = join(resources, 'design/reference/02_Brand_OracleEye_App_Icon.png');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(config, { mode: 0o700 });
  mkdirSync(dirname(icon), { recursive: true });
  writeFileSync(icon, 'isolated icon fixture');
  const env: NodeJS.ProcessEnv = { HOME: home, XDG_CONFIG_HOME: config, ORACULUM_RESOURCE_DIR: resources };
  return { root, home, config, resources, icon, env };
}

function start(env: NodeJS.ProcessEnv) {
  const app = { setPath: vi.fn((_name: string, path: string) => {
    // Electron's documented contract requires the target to exist already.
    const entry = lstatSync(path);
    expect(entry.isDirectory() && !entry.isSymbolicLink()).toBe(true);
    expect(entry.mode & 0o777).toBe(0o700);
  }), getPath: vi.fn(() => env.XDG_CONFIG_HOME),
    setName: vi.fn(), setDesktopName: vi.fn(),
    whenReady: vi.fn(() => new Promise(() => {})), on: vi.fn() };
  runInNewContext(readFileSync(mainPath, 'utf8'), {
    require: (name: string) => name === 'electron' ? { app } : desktopRequire(name),
    process: { env, cwd: () => { throw new Error('Desktop must not depend on launch cwd'); } },
    __dirname: dirname(mainPath), URL,
  });
  return app;
}

describe('Desktop startup paths', () => {
  it('uses the selected HOME/XDG profile independently of launch cwd and host-managed group-writable ancestors', () => {
    const { config, env } = fixture();
    const profile = join(config, 'oraculum');
    mkdirSync(profile, { mode: 0o700 });
    expect(start(env).setPath).toHaveBeenCalledWith('userData', profile);
    chmodSync(config, 0o775);
    expect(start(env).setPath).toHaveBeenCalledWith('userData', profile);
    const fresh = join(config, 'explicit-new-profile');
    expect(desktopPaths({ ...env, ORACULUM_USER_DATA_DIR: fresh }).userData).toBe(fresh);
    expect(existsSync(fresh)).toBe(false);
  });

  it('refuses to silently replace an existing legacy profile', () => {
    const { config, env } = fixture();
    mkdirSync(join(config, 'oraculum-phase0b'), { mode: 0o700 });
    expect(() => start(env)).toThrow(/ORACULUM_USER_DATA_DIR/);
    expect(existsSync(join(config, 'oraculum'))).toBe(false);
  });

  it('fails before Electron initialization when the configured icon is missing', () => {
    const { root, env } = fixture();
    env.ORACULUM_USER_DATA_DIR = join(root, 'new-explicit-profile');
    env.ORACULUM_DESKTOP_ICON = join(root, 'missing.png');
    expect(() => start(env)).toThrow(/icon/i);
    expect(existsSync(env.ORACULUM_USER_DATA_DIR)).toBe(false);
  });

  it('uses HOME/.config when XDG is unset or relative and rejects relative product configuration', () => {
    const { home, env } = fixture();
    delete env.XDG_CONFIG_HOME;
    const profile = join(home, '.config/oraculum');
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    expect(desktopPaths(env).userData).toBe(profile);
    expect(desktopPaths({ ...env, XDG_CONFIG_HOME: 'relative-config' }).userData).toBe(profile);
    expect(() => desktopPaths({ ...env, HOME: 'relative-home' })).toThrow('absolute');
    expect(() => desktopPaths({ ...env, ORACULUM_USER_DATA_DIR: 'relative-profile' })).toThrow('absolute');
    expect(() => desktopPaths({ ...env, ORACULUM_RESOURCE_DIR: 'relative-resources' })).toThrow('absolute');
    expect(() => desktopPaths({ ...env, ORACULUM_DESKTOP_ICON: 'relative-icon' })).toThrow('absolute');
  });

  it('requires an explicit choice and creates a private profile before setPath, even with a permissive umask', () => {
    const { config, env } = fixture();
    expect(() => desktopPaths(env)).toThrow(/No existing Desktop profile/);
    expect(existsSync(join(config, 'oraculum'))).toBe(false);
    env.ORACULUM_USER_DATA_DIR = join(config, 'new-parent/oraculum');
    const mask = process.umask(0);
    try {
      expect(start(env).setPath).toHaveBeenCalledWith('userData', env.ORACULUM_USER_DATA_DIR);
      expect(lstatSync(dirname(env.ORACULUM_USER_DATA_DIR)).mode & 0o777).toBe(0o700);
      expect(lstatSync(env.ORACULUM_USER_DATA_DIR).uid).toBe(process.getuid!());
      expect(start(env).setPath).toHaveBeenCalledWith('userData', env.ORACULUM_USER_DATA_DIR);
    } finally { process.umask(mask); }
  });

  it('detects HOME and XDG legacy conflicts while preserving an explicitly selected profile in place', () => {
    const { home, config, env } = fixture();
    const original = join(home, '.config/oraculum-phase0b');
    const other = join(config, 'oraculum-phase0b'), target = join(config, 'oraculum');
    for (const profile of [original, other, target]) mkdirSync(profile, { recursive: true, mode: 0o700 });
    const sentinel = join(original, 'preserved-user-data');
    writeFileSync(sentinel, 'unchanged');
    expect(() => desktopPaths(env)).toThrow(/Legacy Desktop profile/);
    const before = lstatSync(original);
    expect(prepareDesktopPaths({ ...env, ORACULUM_USER_DATA_DIR: original }).userData).toBe(original);
    expect(lstatSync(original).ino).toBe(before.ino);
    expect(lstatSync(original).mode).toBe(before.mode);
    expect(readFileSync(sentinel, 'utf8')).toBe('unchanged');
    rmSync(other, { recursive: true });
    expect(() => desktopPaths(env)).toThrow(/Legacy Desktop profile/);
    expect(existsSync(target)).toBe(true);
  });

  it('rejects symlinks, non-directory targets and non-directory ancestors without touching them', () => {
    const { root, env } = fixture();
    const profile = join(root, 'private-profile');
    mkdirSync(profile, { mode: 0o700 });
    const link = join(root, 'profile-link'), broken = join(root, 'dangling');
    symlinkSync(profile, link);
    symlinkSync(join(root, 'missing'), broken);
    const file = join(root, 'file'); writeFileSync(file, 'preserve');
    for (const selected of [link, join(link, 'child'), broken, file, join(file, 'child')]) {
      expect(() => desktopPaths({ ...env, ORACULUM_USER_DATA_DIR: selected })).toThrow(/symlink|non-directory/);
    }
    expect(readFileSync(file, 'utf8')).toBe('preserve');
    expect(existsSync(join(profile, 'child'))).toBe(false);
  });

  it('rejects unsafe or unwritable profile permissions without chmod or creation', () => {
    const { root, env } = fixture();
    const profile = join(root, 'profile');
    mkdirSync(profile, { mode: 0o755 });
    expect(() => prepareDesktopPaths({ ...env, ORACULUM_USER_DATA_DIR: profile })).toThrow(/private permissions/);
    chmodSync(profile, 0o500);
    expect(() => prepareDesktopPaths({ ...env, ORACULUM_USER_DATA_DIR: profile })).toThrow(/not writable/);
    expect(() => prepareDesktopPaths({ ...env, ORACULUM_USER_DATA_DIR: join(profile, 'new-profile') })).toThrow(/not writable/);
    chmodSync(profile, 0o777);
    expect(() => prepareDesktopPaths({ ...env, ORACULUM_USER_DATA_DIR: join(profile, 'new-profile') })).toThrow(/permissions are unsafe/);
    expect(existsSync(join(profile, 'new-profile'))).toBe(false);
  });

  it.each(['mode', 'owner', 'symlink', 'parent-symlink', 'creation-failure', 'concurrent-target'])(
    'rechecks new directories and stops on %s without changing unrelated data', scenario => {
      const { root, env } = fixture();
      const target = join(root, 'fresh'), unrelated = join(root, 'unrelated');
      mkdirSync(unrelated, { mode: 0o700 }); writeFileSync(join(unrelated, 'sentinel'), 'unchanged');
      const fs = desktopRequire('node:fs') as typeof import('node:fs');
      const module = { exports: {} as { prepareDesktopPaths: typeof prepareDesktopPaths } };
      runInNewContext(readFileSync(resolve('apps/desktop/paths.cjs'), 'utf8'), {
        module, __dirname: dirname(mainPath), process,
        require: (name: string) => name !== 'node:fs' ? desktopRequire(name) : {
          ...fs,
          mkdirSync: (directory: string, options: import('node:fs').MakeDirectoryOptions) => {
            if (scenario === 'creation-failure') throw Object.assign(new Error('fixture EACCES'), { code: 'EACCES' });
            if (scenario === 'concurrent-target') {
              symlinkSync(unrelated, directory);
              return fs.mkdirSync(directory, options); // EEXIST, never accepted/chmodded.
            }
            fs.mkdirSync(directory, options);
            if (scenario === 'mode') chmodSync(directory, 0o755);
            if (scenario === 'symlink' || scenario === 'parent-symlink') {
              rmSync(directory, { recursive: true }); symlinkSync(unrelated, directory);
            }
          },
          lstatSync: (file: string) => {
            const entry = fs.lstatSync(file);
            if (scenario === 'owner' && file === target) Object.defineProperty(entry, 'uid', { value: process.getuid!() + 1 });
            return entry;
          },
        },
      });
      expect(() => module.exports.prepareDesktopPaths({ ...env,
        ORACULUM_USER_DATA_DIR: scenario === 'parent-symlink' ? join(target, 'child') : target,
      })).toThrow(/Desktop profile initialization failed/);
      expect(readFileSync(join(unrelated, 'sentinel'), 'utf8')).toBe('unchanged');
      expect(lstatSync(unrelated).mode & 0o777).toBe(0o700);
      expect(existsSync(join(unrelated, 'child'))).toBe(false);
    });

  it('locates resources in an installation tree or through an explicit icon override', () => {
    const { root, icon, env } = fixture();
    env.ORACULUM_USER_DATA_DIR = join(root, 'explicit-profile');
    expect(desktopPaths(env).icon).toBe(icon);
    const custom = join(root, 'custom.png'); writeFileSync(custom, 'explicit icon');
    expect(desktopPaths({ ...env, ORACULUM_DESKTOP_ICON: custom }).icon).toBe(custom);
    const link = join(root, 'icon-link.png'); symlinkSync(custom, link);
    expect(() => desktopPaths({ ...env, ORACULUM_DESKTOP_ICON: link })).toThrow(/icon/i);
    expect(() => desktopPaths({ ...env, ORACULUM_DESKTOP_ICON: root })).toThrow(/icon/i);
  });
});
