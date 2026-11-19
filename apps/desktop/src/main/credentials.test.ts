import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore, type SafeStorageLike } from './credentials';

const ENDPOINT = 'http://127.0.0.1:4400/';
const INSTALLATION = '12345678-1234-4123-8123-123456789abc';
const OTHER_INSTALLATION = '12345678-1234-4123-8123-123456789abd';
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A test-only cipher: production always receives Electron safeStorage from main. */
function secureStorage(): SafeStorageLike {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: value => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString: value => {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

function fixture(storage = secureStorage()) {
  const directory = mkdtempSync(join(tmpdir(), 'oraculum-credentials-'));
  temporary.push(directory);
  const file = join(directory, `identity-${createHash('sha256').update(ENDPOINT).digest('hex')}.sealed`);
  return { directory, file, storage, store: new CredentialStore(directory, storage) };
}

describe('Desktop encrypted device identities', () => {
  it('durably saves the pending identity before pairing, recovers after restart, and exposes secret-free metadata', () => {
    const { directory, file, storage, store } = fixture();
    expect(store.load(ENDPOINT, INSTALLATION)).toBeNull();
    const identity = store.create(ENDPOINT, INSTALLATION);
    expect(identity.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Buffer.from(identity.deviceCredential, 'base64url').length).toBe(32);
    expect(identity.paired).toBe(false);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(lstatSync(file).nlink).toBe(1);
    const bytes = readFileSync(file);
    for (const secret of [identity.deviceCredential, identity.deviceId, ENDPOINT, INSTALLATION]) {
      expect(bytes.includes(Buffer.from(secret))).toBe(false);
    }
    const restarted = new CredentialStore(directory, storage);
    expect(restarted.load(ENDPOINT, INSTALLATION)).toEqual(identity);
    // A lost pair ACK must reuse exactly the identity which may have reached Gateway.
    expect(restarted.create(ENDPOINT, INSTALLATION)).toEqual(identity);
    expect(readFileSync(file)).toEqual(bytes);
    restarted.markPaired(identity);
    expect(new CredentialStore(directory, storage).load(ENDPOINT, INSTALLATION)).toEqual({ ...identity, paired: true });
    expect(store.metadata(ENDPOINT, INSTALLATION)).toEqual({ endpoint: ENDPOINT, installationId: INSTALLATION, deviceId: identity.deviceId, paired: true });
    expect(store.metadataForEndpoint(ENDPOINT)).toEqual({ endpoint: ENDPOINT, installationId: INSTALLATION, deviceId: identity.deviceId, paired: true });
    expect(JSON.stringify(store.metadataForEndpoint(ENDPOINT))).not.toContain(identity.deviceCredential);
    expect(readdirSync(directory).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('keeps identities isolated by endpoint, installation, and profile', () => {
    const { directory, file, storage, store } = fixture();
    const first = store.create(ENDPOINT, INSTALLATION);
    const second = store.create('https://example.test/gateway/', INSTALLATION);
    expect(second.deviceId).not.toBe(first.deviceId);
    expect(second.deviceCredential).not.toBe(first.deviceCredential);
    const before = readFileSync(file);
    expect(() => store.load(ENDPOINT, OTHER_INSTALLATION)).toThrow('CREDENTIAL_BINDING_MISMATCH');
    expect(() => store.create(ENDPOINT, OTHER_INSTALLATION)).toThrow('CREDENTIAL_BINDING_MISMATCH');
    expect(readFileSync(file)).toEqual(before);
    const other = fixture(storage);
    copyFileSync(file, other.file);
    expect(() => other.store.load(ENDPOINT, INSTALLATION)).toThrow('CREDENTIAL_BINDING_MISMATCH');
    expect(store.load(ENDPOINT, INSTALLATION)).toEqual(first);
    expect(readdirSync(directory).filter(name => name.endsWith('.sealed')).length).toBe(2);
  });

  it.each(['basic_text', 'unknown', 'kwallet', 'kwallet5', 'kwallet6', ''])('rejects unsafe storage backend %s without creating a file', backend => {
    const storage = secureStorage();
    storage.getSelectedStorageBackend = () => backend;
    const { directory, store } = fixture(storage);
    expect(() => store.load(ENDPOINT, INSTALLATION)).toThrow('CREDENTIAL_STORAGE_UNAVAILABLE');
    expect(() => store.create(ENDPOINT, INSTALLATION)).toThrow('CREDENTIAL_STORAGE_UNAVAILABLE');
    expect(readdirSync(directory)).toEqual([]);
  });

  it('fails closed when keyring availability or backend changes, retaining prior encrypted bytes', () => {
    const { file, storage, store } = fixture();
    const identity = store.create(ENDPOINT, INSTALLATION);
    const before = readFileSync(file);
    storage.isEncryptionAvailable = () => false;
    expect(() => store.load(ENDPOINT, INSTALLATION)).toThrow('CREDENTIAL_STORAGE_UNAVAILABLE');
    expect(() => store.markPaired(identity)).toThrow('CREDENTIAL_STORAGE_UNAVAILABLE');
    storage.isEncryptionAvailable = () => true;
    const encrypt = storage.encryptString;
    storage.encryptString = text => { const value = encrypt(text); storage.getSelectedStorageBackend = () => 'basic_text'; return value; };
    expect(() => store.markPaired(identity)).toThrow('CREDENTIAL_STORAGE_UNAVAILABLE');
    expect(readFileSync(file)).toEqual(before);
  });

  it.each(['symlink', 'dangling', 'hardlink', 'public', 'executable', 'oversized'])('refuses unsafe identity file %s and preserves it', scenario => {
    const { directory, file, store } = fixture();
    const target = join(directory, 'unrelated');
    if (scenario !== 'dangling') writeFileSync(target, 'preserve', { mode: 0o600 });
    if (scenario === 'symlink' || scenario === 'dangling') symlinkSync(target, file);
    if (scenario === 'hardlink') linkSync(target, file);
    if (scenario === 'public') writeFileSync(file, 'preserve', { mode: 0o644 });
    if (scenario === 'executable') writeFileSync(file, 'preserve', { mode: 0o700 });
    if (scenario === 'oversized') writeFileSync(file, Buffer.alloc(16 * 1024 + 1), { mode: 0o600 });
    const before = lstatSync(file);
    expect(() => store.load(ENDPOINT, INSTALLATION)).toThrow('CREDENTIAL_STORAGE_UNSAFE');
    expect(() => store.create(ENDPOINT, INSTALLATION)).toThrow('CREDENTIAL_STORAGE_UNSAFE');
    expect(lstatSync(file).ino).toBe(before.ino);
    if (scenario === 'dangling') expect(existsSync(target)).toBe(false);
    else expect(readFileSync(target, 'utf8')).toBe('preserve');
  });

  it('refuses a nonowner file and a changed directory protection', () => {
    const { directory, file, store } = fixture();
    const identity = store.create(ENDPOINT, INSTALLATION);
    const before = readFileSync(file);
    const uid = process.getuid!();
    const owner = vi.spyOn(process as NodeJS.Process & { getuid(): number }, 'getuid').mockReturnValue(uid + 1);
    expect(() => store.load(ENDPOINT, INSTALLATION)).toThrow('CREDENTIAL_STORAGE_UNSAFE');
    owner.mockRestore();
    chmodSync(directory, 0o755);
    expect(() => store.markPaired(identity)).toThrow('CREDENTIAL_STORAGE_UNSAFE');
    expect(readFileSync(file)).toEqual(before);
    chmodSync(directory, 0o700);
  });

  it('preserves corrupt encrypted state, never recreating the identity', () => {
    const { file, store } = fixture();
    store.create(ENDPOINT, INSTALLATION);
    const corrupt = Buffer.from('broken encrypted state');
    writeFileSync(file, corrupt);
    expect(() => store.load(ENDPOINT, INSTALLATION)).toThrow('CREDENTIAL_STORAGE_CORRUPT');
    expect(() => store.create(ENDPOINT, INSTALLATION)).toThrow('CREDENTIAL_STORAGE_CORRUPT');
    expect(readFileSync(file)).toEqual(corrupt);
  });

  it('rejects swapped endpoint ciphertext and invalid decoded shapes', () => {
    const { directory, file, storage, store } = fixture();
    const identity = store.create(ENDPOINT, INSTALLATION);
    const original = { profile: directory, identity: { version: 1, ...identity } };
    writeFileSync(file, storage.encryptString(JSON.stringify({ ...original, identity: { ...original.identity, endpoint: 'https://other.test/' } })));
    expect(() => store.load(ENDPOINT, INSTALLATION)).toThrow('CREDENTIAL_BINDING_MISMATCH');
    for (const value of [null, [], { ...original, extra: true }, { ...original, identity: { ...original.identity, accessToken: 'must-not-be-saved' } },
      { ...original, identity: { ...original.identity, deviceCredential: 'short' } }, { ...original, identity: { ...original.identity, version: 2 } }]) {
      writeFileSync(file, storage.encryptString(JSON.stringify(value)));
      expect(() => store.load(ENDPOINT, INSTALLATION)).toThrow('CREDENTIAL_STORAGE_CORRUPT');
    }
  });

  it('rejects mismatched pairing confirmations without altering the pending identity', () => {
    const { store } = fixture();
    const identity = store.create(ENDPOINT, INSTALLATION);
    expect(() => store.markPaired({ ...identity, deviceId: OTHER_INSTALLATION })).toThrow('CREDENTIAL_BINDING_MISMATCH');
    expect(() => store.markPaired({ ...identity, deviceCredential: 'A'.repeat(43) })).toThrow('CREDENTIAL_BINDING_MISMATCH');
    expect(store.load(ENDPOINT, INSTALLATION)).toEqual(identity);
  });

  it('redacts backend errors and leaves no partial files when encryption fails', () => {
    const { directory, storage, store } = fixture();
    storage.encryptString = () => { throw new Error('secret backend detail'); };
    try { store.create(ENDPOINT, INSTALLATION); throw new Error('expected failure'); }
    catch (error) {
      expect((error as Error).message).toBe('CREDENTIAL_SAVE_FAILED');
      expect(String(error)).not.toContain('secret backend detail');
    }
    expect(readdirSync(directory)).toEqual([]);
  });

  it('does not overwrite an identity that appears during first persistence', () => {
    const { directory, file, storage, store } = fixture();
    const encrypt = storage.encryptString;
    const concurrent = Buffer.from('preserve-concurrent-identity');
    storage.encryptString = value => {
      writeFileSync(file, concurrent, { mode: 0o600 });
      return encrypt(value);
    };
    expect(() => store.create(ENDPOINT, INSTALLATION)).toThrow('CREDENTIAL_SAVE_FAILED');
    expect(readFileSync(file)).toEqual(concurrent);
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it.each(['http://user:password@127.0.0.1/', 'https://example.test/?token=secret', 'https://example.test/#secret',
    'https://example.test', ' https://example.test/', 'file:///etc/passwd', 'https://example.test/\n'])('rejects an unnormalized or credential-bearing endpoint %#', endpoint => {
    const { directory, store } = fixture();
    expect(() => store.create(endpoint, INSTALLATION)).toThrow('CREDENTIAL_IDENTITY_INVALID');
    expect(readdirSync(directory)).toEqual([]);
  });
});
