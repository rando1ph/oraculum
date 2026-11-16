import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, parsePreferencesPatch, PreferencesStore } from './preferences';

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'oraculum-preferences-'));
  temporary.push(directory);
  return { directory, file: join(directory, 'appearance.json') };
}

describe('bounded appearance preferences', () => {
  it('persists themes and inspector state privately, reads back after restart, and resets only appearance', () => {
    const { directory, file } = fixture();
    writeFileSync(join(directory, 'unrelated-data'), 'preserve');
    const store = new PreferencesStore(directory);
    expect(store.read()).toEqual({ preferences: DEFAULT_PREFERENCES, preferencesRecovered: false });
    for (const theme of ['dark', 'oled', 'light'] as const) {
      store.update({ theme, inspectorVisible: false });
      expect(new PreferencesStore(directory).read().preferences).toEqual({ theme, inspectorVisible: false });
    }
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    store.reset();
    expect(new PreferencesStore(directory).read().preferences).toEqual(DEFAULT_PREFERENCES);
    expect(readFileSync(join(directory, 'unrelated-data'), 'utf8')).toBe('preserve');
    expect(readdirSync(directory).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it.each([null, 'dark', [], 1, { theme: 'custom' }, { theme: 'x'.repeat(50_000) }, { inspectorVisible: 1 },
    { theme: 'light', css: 'body{}' }, { theme: undefined }, { path: '/etc/passwd' }, { channel: 'exec' }])('rejects unsupported preference payload %# without persistence', input => {
    const { directory, file } = fixture();
    const store = new PreferencesStore(directory);
    expect(() => store.update(input)).toThrow('INVALID_PREFERENCES');
    expect(existsSync(file)).toBe(false);
    expect(store.read().preferences).toEqual(DEFAULT_PREFERENCES);
  });

  it('rejects inherited settings and symbol keys', () => {
    expect(() => parsePreferencesPatch(Object.create({ theme: 'dark' }))).toThrow('INVALID_PREFERENCES');
    expect(() => parsePreferencesPatch({ [Symbol('path')]: '/etc/passwd' })).toThrow('INVALID_PREFERENCES');
  });

  it.each(['{broken', '{"theme":"legacy","inspectorVisible":true}', '{"theme":"dark","inspectorVisible":true,"unexpected":"preserve"}'])('recovers invalid private preferences without deleting their original bytes', text => {
    const { directory, file } = fixture();
    writeFileSync(file, text, { mode: 0o600 });
    const store = new PreferencesStore(directory);
    expect(store.read()).toEqual({ preferences: DEFAULT_PREFERENCES, preferencesRecovered: true });
    expect(readFileSync(file, 'utf8')).toBe(text);
    store.reset();
    const backups = readdirSync(directory).filter(name => name.startsWith('appearance-recovered-'));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(directory, backups[0]), 'utf8')).toBe(text);
    expect(store.read()).toEqual({ preferences: DEFAULT_PREFERENCES, preferencesRecovered: false });
  });

  it.each(['symlink', 'dangling', 'hardlink', 'public'])('refuses unsafe preference file %s without following or replacing it', scenario => {
    const { directory, file } = fixture();
    const target = join(directory, 'external-state');
    if (scenario !== 'dangling') writeFileSync(target, JSON.stringify(DEFAULT_PREFERENCES), { mode: 0o600 });
    if (scenario === 'symlink' || scenario === 'dangling') symlinkSync(target, file);
    if (scenario === 'hardlink') linkSync(target, file);
    if (scenario === 'public') writeFileSync(file, JSON.stringify(DEFAULT_PREFERENCES), { mode: 0o644 });
    const before = lstatSync(file);
    expect(() => new PreferencesStore(directory)).toThrow('DESKTOP_PROFILE_UNSAFE');
    expect(lstatSync(file).ino).toBe(before.ino);
    if (scenario === 'dangling') expect(existsSync(target)).toBe(false);
    else expect(readFileSync(target, 'utf8')).toBe(JSON.stringify(DEFAULT_PREFERENCES));
  });

  it('fails a write when directory protection changes and leaves the prior saved state intact', () => {
    const { directory, file } = fixture();
    const store = new PreferencesStore(directory);
    store.update({ theme: 'dark' });
    const before = readFileSync(file);
    chmodSync(directory, 0o755);
    expect(() => store.update({ theme: 'oled' })).toThrow('PREFERENCES_SAVE_FAILED');
    expect(readFileSync(file)).toEqual(before);
    expect(store.read().preferences.theme).toBe('dark');
    chmodSync(directory, 0o700);
  });
});
