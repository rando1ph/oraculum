import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { assertPrivateDirectory, assertPrivateFile, entryExists, readPrivateFile } from './profile';

/** Electron safeStorage is supplied by main after app readiness. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface DeviceIdentity {
  endpoint: string;
  installationId: string;
  deviceId: string;
  deviceCredential: string;
  paired: boolean;
}
export type DeviceIdentityMetadata = Omit<DeviceIdentity, 'deviceCredential'>;

type CredentialErrorCode = 'CREDENTIAL_STORAGE_UNAVAILABLE' | 'CREDENTIAL_STORAGE_UNSAFE'
  | 'CREDENTIAL_STORAGE_CORRUPT' | 'CREDENTIAL_BINDING_MISMATCH' | 'CREDENTIAL_SAVE_FAILED'
  | 'CREDENTIAL_IDENTITY_INVALID';
export class CredentialError extends Error {
  constructor(readonly code: CredentialErrorCode) { super(code); this.name = 'CredentialError'; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const MAX_BYTES = 16 * 1024;
const MAX_PLAINTEXT_BYTES = 8 * 1024;

function fail(code: CredentialErrorCode): never { throw new CredentialError(code); }
function assertCredentialFile(file: string): void {
  assertPrivateFile(file, MAX_BYTES);
  if ((lstatSync(file).mode & 0o7777) !== 0o600) fail('CREDENTIAL_STORAGE_UNSAFE');
}
function checkBinding(endpoint: string, installationId: string): void {
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || /[\x00-\x20\x7f]/.test(endpoint)
    || typeof installationId !== 'string' || !UUID.test(installationId)) fail('CREDENTIAL_IDENTITY_INVALID');
  try {
    const parsed = new URL(endpoint);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.search || parsed.hash || parsed.href !== endpoint) fail('CREDENTIAL_IDENTITY_INVALID');
  } catch { fail('CREDENTIAL_IDENTITY_INVALID'); }
}

function parseIdentity(value: unknown): DeviceIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('CREDENTIAL_STORAGE_CORRUPT');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 6 || !['endpoint', 'installationId', 'deviceId', 'deviceCredential', 'paired'].every(key => Object.hasOwn(input, key))
    || input.version !== 1 || typeof input.deviceId !== 'string' || !UUID.test(input.deviceId)
    || typeof input.deviceCredential !== 'string' || !CREDENTIAL.test(input.deviceCredential)
    || Buffer.from(input.deviceCredential, 'base64url').toString('base64url') !== input.deviceCredential
    || typeof input.paired !== 'boolean') fail('CREDENTIAL_STORAGE_CORRUPT');
  try { checkBinding(input.endpoint as string, input.installationId as string); }
  catch { fail('CREDENTIAL_STORAGE_CORRUPT'); }
  return { endpoint: input.endpoint as string, installationId: input.installationId as string,
    deviceId: input.deviceId, deviceCredential: input.deviceCredential, paired: input.paired };
}

/**
 * One encrypted file per normalized endpoint, under the isolated Desktop profile.
 * No access tokens, pairing codes, or renderer-controlled paths are persisted.
 * A pending identity survives a missing pair ACK and is never silently replaced.
 */
export class CredentialStore {
  private readonly directory: string;
  private readonly directoryIdentity: { dev: number; ino: number };

  constructor(directory: string, private readonly storage: SafeStorageLike) {
    try {
      if (!isAbsolute(directory) || directory.includes('\0') || realpathSync(directory) !== resolve(directory)) fail('CREDENTIAL_STORAGE_UNSAFE');
      assertPrivateDirectory(directory);
      this.directory = resolve(directory);
      const stat = lstatSync(directory);
      this.directoryIdentity = { dev: stat.dev, ino: stat.ino };
    } catch { fail('CREDENTIAL_STORAGE_UNSAFE'); }
  }

  load(endpoint: string, installationId: string): DeviceIdentity | null {
    checkBinding(endpoint, installationId);
    this.assertStorage();
    this.assertDirectory();
    const file = this.file(endpoint);
    let bytes: Buffer;
    try {
      if (!entryExists(file)) return null;
      assertCredentialFile(file);
      bytes = readPrivateFile(file, MAX_BYTES);
    } catch { fail('CREDENTIAL_STORAGE_UNSAFE'); }
    let identity: DeviceIdentity;
    try {
      const plaintext = this.storage.decryptString(bytes);
      this.assertStorage();
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) fail('CREDENTIAL_STORAGE_CORRUPT');
      const saved = JSON.parse(plaintext) as unknown;
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)
        || Object.keys(saved).length !== 2 || !Object.hasOwn(saved, 'profile') || !Object.hasOwn(saved, 'identity')) fail('CREDENTIAL_STORAGE_CORRUPT');
      const envelope = saved as { profile: unknown; identity: unknown };
      if (envelope.profile !== this.directory) fail('CREDENTIAL_BINDING_MISMATCH');
      identity = parseIdentity(envelope.identity);
    } catch (error) {
      if (error instanceof CredentialError) throw error;
      fail('CREDENTIAL_STORAGE_CORRUPT');
    }
    if (identity.endpoint !== endpoint || identity.installationId !== installationId) fail('CREDENTIAL_BINDING_MISMATCH');
    return identity;
  }

  create(endpoint: string, installationId: string): DeviceIdentity {
    const existing = this.load(endpoint, installationId);
    if (existing) return existing;
    const identity: DeviceIdentity = { endpoint, installationId, deviceId: randomUUID(),
      deviceCredential: randomBytes(32).toString('base64url'), paired: false };
    this.persist(identity, false);
    return identity;
  }

  markPaired(identity: DeviceIdentity): void {
    if (!identity || typeof identity !== 'object') fail('CREDENTIAL_IDENTITY_INVALID');
    const current = this.load(identity.endpoint, identity.installationId);
    if (!current || current.deviceId !== identity.deviceId || typeof identity.deviceCredential !== 'string'
      || !CREDENTIAL.test(identity.deviceCredential)
      || !timingSafeEqual(Buffer.from(current.deviceCredential), Buffer.from(identity.deviceCredential))) fail('CREDENTIAL_BINDING_MISMATCH');
    if (current.paired) return;
    this.persist({ ...current, paired: true }, true);
  }

  metadata(endpoint: string, installationId: string): DeviceIdentityMetadata | null {
    const identity = this.load(endpoint, installationId);
    if (!identity) return null;
    return { endpoint: identity.endpoint, installationId: identity.installationId, deviceId: identity.deviceId, paired: identity.paired };
  }

  private file(endpoint: string): string {
    return join(this.directory, `identity-${createHash('sha256').update(endpoint).digest('hex')}.sealed`);
  }

  private assertStorage(): void {
    try {
      if (!this.storage.isEncryptionAvailable() || this.storage.getSelectedStorageBackend() !== 'gnome_libsecret') fail('CREDENTIAL_STORAGE_UNAVAILABLE');
    } catch { fail('CREDENTIAL_STORAGE_UNAVAILABLE'); }
  }

  private assertDirectory(): void {
    try {
      assertPrivateDirectory(this.directory);
      const stat = lstatSync(this.directory);
      if (stat.dev !== this.directoryIdentity.dev || stat.ino !== this.directoryIdentity.ino
        || realpathSync(this.directory) !== this.directory) fail('CREDENTIAL_STORAGE_UNSAFE');
    } catch { fail('CREDENTIAL_STORAGE_UNSAFE'); }
  }

  private persist(identity: DeviceIdentity, replacing: boolean): void {
    this.assertStorage();
    this.assertDirectory();
    const file = this.file(identity.endpoint);
    const temporary = join(this.directory, `.identity-${randomUUID()}.tmp`);
    let temporaryCreated = false;
    try {
      const plaintext = JSON.stringify({ profile: this.directory, identity: { version: 1, ...identity } });
      if (Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) fail('CREDENTIAL_SAVE_FAILED');
      const encrypted = this.storage.encryptString(plaintext);
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.length > MAX_BYTES) fail('CREDENTIAL_SAVE_FAILED');
      // A locked or changed keyring during encryption cannot fall back to weak storage.
      this.assertStorage();
      this.assertDirectory();
      if (replacing) assertCredentialFile(file);
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      temporaryCreated = true;
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600) fail('CREDENTIAL_STORAGE_UNSAFE');
        writeFileSync(fd, encrypted);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      this.assertDirectory();
      if (replacing) {
        assertCredentialFile(file);
        renameSync(temporary, file);
      } else {
        // Unlike rename, exclusive linking cannot overwrite a concurrently saved identity.
        linkSync(temporary, file);
        unlinkSync(temporary);
      }
      temporaryCreated = false;
      const dirFd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      const saved = this.load(identity.endpoint, identity.installationId);
      if (!saved || saved.deviceId !== identity.deviceId || saved.deviceCredential !== identity.deviceCredential || saved.paired !== identity.paired) fail('CREDENTIAL_SAVE_FAILED');
    } catch (error) {
      if (error instanceof CredentialError) throw error;
      fail('CREDENTIAL_SAVE_FAILED');
    } finally {
      if (temporaryCreated) {
        try { unlinkSync(temporary); } catch { /* Preserve the stored identity on any failure. */ }
      }
    }
  }
}
