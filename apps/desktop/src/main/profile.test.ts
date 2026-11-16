import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareProfile } from './profile';

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'oraculum-profile-'));
  temporary.push(directory);
  return { directory, env: { HOME: directory, XDG_CONFIG_HOME: join(directory, 'config') } };
}

describe('independent Desktop profiles', () => {
  it('creates distinct private development, production and QA profiles without inspecting or changing legacy data', () => {
    const { directory, env } = fixture();
    const legacy = join(directory, '.config/oraculum');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'user-data'), 'preserve exactly');
    const development = prepareProfile(false, env);
    const production = prepareProfile(true, env);
    const qa = prepareProfile(false, { ...env, ORACULUM_DESKTOP_PROFILE: 'gui' });
    expect(new Set([development.directory, production.directory, qa.directory]).size).toBe(3);
    expect(development.directory).toBe(join(env.XDG_CONFIG_HOME, 'oraculum-desktop-v2/development'));
    expect(qa.directory.endsWith('/development-gui')).toBe(true);
    for (const path of [development.directory, development.session, development.logs, development.crashDumps]) {
      expect(lstatSync(path).mode & 0o777).toBe(0o700);
      expect(lstatSync(path).uid).toBe(process.getuid!());
    }
    const inode = lstatSync(development.directory).ino;
    expect(prepareProfile(false, env)).toEqual(development);
    expect(lstatSync(development.directory).ino).toBe(inode);
    expect(readFileSync(join(legacy, 'user-data'), 'utf8')).toBe('preserve exactly');
  });

  it.each(['../old', '/tmp/profile', '', 'with space', 'a/b', 'A', 'x'.repeat(49), 'a\0b'])('rejects an unsafe QA selector %s without creating the namespace', slug => {
    const { env } = fixture();
    expect(() => prepareProfile(false, { ...env, ORACULUM_DESKTOP_PROFILE: slug })).toThrow('DESKTOP_PROFILE_UNSAFE');
    expect(existsSync(env.XDG_CONFIG_HOME)).toBe(false);
  });

  it('does not adopt a nonempty unmarked directory or overwrite its sentinel', () => {
    const { env } = fixture();
    const profile = join(env.XDG_CONFIG_HOME, 'oraculum-desktop-v2/development');
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    writeFileSync(join(profile, 'sentinel'), 'unknown state');
    expect(() => prepareProfile(false, env)).toThrow('DESKTOP_PROFILE_UNSAFE');
    expect(readFileSync(join(profile, 'sentinel'), 'utf8')).toBe('unknown state');
    expect(existsSync(join(profile, '.oraculum-desktop-v2'))).toBe(false);
  });

  it.each(['profile-link', 'ancestor-link', 'public', 'read-only', 'marker-link', 'dangling-marker', 'marker-hardlink', 'wrong-marker'])('refuses unsafe existing profile: %s', scenario => {
    const { directory, env } = fixture();
    const profile = prepareProfile(false, env);
    const marker = join(profile.directory, '.oraculum-desktop-v2');
    const external = join(directory, 'external');
    mkdirSync(external, { mode: 0o700 });
    writeFileSync(join(external, 'sentinel'), 'preserve');
    if (scenario === 'profile-link') { rmSync(profile.directory, { recursive: true }); symlinkSync(external, profile.directory); }
    if (scenario === 'ancestor-link') { rmSync(env.XDG_CONFIG_HOME, { recursive: true }); symlinkSync(external, env.XDG_CONFIG_HOME); }
    if (scenario === 'public') chmodSync(profile.directory, 0o755);
    if (scenario === 'read-only') chmodSync(profile.directory, 0o500);
    if (scenario === 'marker-link' || scenario === 'marker-hardlink' || scenario === 'dangling-marker') {
      const copy = join(external, 'marker');
      if (scenario !== 'dangling-marker') writeFileSync(copy, readFileSync(marker), { mode: 0o600 });
      rmSync(marker);
      if (scenario === 'marker-hardlink') linkSync(copy, marker); else symlinkSync(copy, marker);
    }
    if (scenario === 'wrong-marker') writeFileSync(marker, '{"version":1,"profile":"production"}\n');
    expect(() => prepareProfile(false, env)).toThrow('DESKTOP_PROFILE_UNSAFE');
    expect(readFileSync(join(external, 'sentinel'), 'utf8')).toBe('preserve');
    if (scenario === 'read-only') chmodSync(profile.directory, 0o700);
  });
});
