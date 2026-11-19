import { randomUUID } from 'node:crypto';
import { constants, closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeEndpoint } from './endpoint';
import { assertPrivateDirectory, assertPrivateFile, entryExists, readPrivateFile } from './profile';

interface ConnectionPreference { endpoint: string; autoConnect: boolean; signedOut: boolean }
const MAX_BYTES = 8 * 1024;

/** A private, non-secret startup preference, separate from appearance and credentials. */
export class ConnectionPreferences {
  private value?: ConnectionPreference;
  private recover = false;
  private readonly file: string;
  constructor(private directory: string) {
    assertPrivateDirectory(directory);
    this.file = join(directory, 'connection.json');
    if (!entryExists(this.file)) return;
    const bytes = readPrivateFile(this.file, MAX_BYTES);
    try {
      const data = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 4 || data.version !== 1
        || typeof data.endpoint !== 'string' || typeof data.autoConnect !== 'boolean'
        || typeof data.signedOut !== 'boolean' || (data.signedOut && data.autoConnect)
        || normalizeEndpoint(data.endpoint) !== data.endpoint) throw new Error('INVALID_CONNECTION_PREFERENCE');
      this.value = { endpoint: data.endpoint, autoConnect: data.autoConnect, signedOut: data.signedOut };
    } catch { this.recover = true; }
  }
  read(): ConnectionPreference | undefined { return this.value ? { ...this.value } : undefined; }
  get recovered(): boolean { return this.recover; }
  save(input: string, autoConnect: boolean, signedOut = false): void {
    const next = { endpoint: normalizeEndpoint(input), autoConnect, signedOut };
    if (typeof autoConnect !== 'boolean' || typeof signedOut !== 'boolean' || (signedOut && autoConnect)) throw new Error('CONNECTION_PREFERENCES_INVALID');
    const temporary = join(this.directory, `.connection-${randomUUID()}.tmp`);
    let created = false;
    try {
      assertPrivateDirectory(this.directory);
      if (entryExists(this.file)) assertPrivateFile(this.file, MAX_BYTES);
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try { writeFileSync(fd, JSON.stringify({ version: 1, ...next }) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      if (this.recover && entryExists(this.file)) {
        renameSync(this.file, join(this.directory, `connection-recovered-${randomUUID()}.json`));
        this.recover = false;
      }
      renameSync(temporary, this.file); created = false;
      const directoryFd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      this.value = next;
    } catch { throw new Error('CONNECTION_PREFERENCES_SAVE_FAILED'); }
    finally { if (created) { try { unlinkSync(temporary); } catch { /* Preserve existing saved state. */ } } }
  }
}
