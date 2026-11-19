import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionPreferences } from './connection-preferences';
import { PreferencesStore } from './preferences';

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-connection-preferences-')); temporary.push(directory);
  return { directory, file: join(directory, 'connection.json'), store: new ConnectionPreferences(directory) };
}
describe('private endpoint startup preference', () => {
  it('normalizes and restores the complete base path without secrets, independently of appearance', () => {
    const f = fixture(); f.store.save('https://fixture.invalid/gateway', true);
    new PreferencesStore(f.directory).reset();
    expect(new ConnectionPreferences(f.directory).read()).toEqual({ endpoint: 'https://fixture.invalid/gateway/', autoConnect: true, signedOut: false });
    expect(Object.keys(JSON.parse(readFileSync(f.file, 'utf8'))).sort()).toEqual(['autoConnect', 'endpoint', 'signedOut', 'version']);
    f.store.save('http://127.0.0.1:41234/', false);
    expect(new ConnectionPreferences(f.directory).read()?.autoConnect).toBe(false);
    f.store.save('http://127.0.0.1:41234/', false, true);
    expect(new ConnectionPreferences(f.directory).read()?.signedOut).toBe(true);
  });
  it.each(['https://user:password@fixture.invalid/', 'https://fixture.invalid/?token=secret', 'http://192.0.2.1/', 'file:///etc/passwd'])('refuses unsafe endpoint %s without writing', endpoint => {
    const f = fixture(); expect(() => f.store.save(endpoint, true)).toThrow(); expect(existsSync(f.file)).toBe(false);
  });
  it('preserves corrupt or future preference bytes until the next explicit endpoint change', () => {
    const f = fixture(); const corrupt = '{"version":99,"future":"preserve"}'; writeFileSync(f.file, corrupt, { mode: 0o600 });
    const store = new ConnectionPreferences(f.directory); expect(store.read()).toBeUndefined(); expect(store.recovered).toBe(true);
    expect(readFileSync(f.file, 'utf8')).toBe(corrupt); store.save('https://fixture.invalid/', true);
    const backup = readdirSync(f.directory).find(file => file.startsWith('connection-recovered-'))!;
    expect(readFileSync(join(f.directory, backup), 'utf8')).toBe(corrupt);
  });
  it('rejects symlinks and retains saved endpoint when directory safety changes', () => {
    const f = fixture(); f.store.save('https://fixture.invalid/', true); const before = readFileSync(f.file);
    chmodSync(f.directory, 0o755); expect(() => f.store.save('https://other.invalid/', true)).toThrow('CONNECTION_PREFERENCES_SAVE_FAILED');
    expect(readFileSync(f.file)).toEqual(before); chmodSync(f.directory, 0o700);
    rmSync(f.file); symlinkSync(join(f.directory, 'target'), f.file);
    expect(() => new ConnectionPreferences(f.directory)).toThrow('DESKTOP_PROFILE_UNSAFE');
  });
});
