import { randomUUID } from 'node:crypto';
import { constants, closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Preferences } from '../contracts/desktop';
import { assertPrivateDirectory, assertPrivateFile, entryExists, readPrivateFile } from './profile';

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({ theme: 'light', inspectorVisible: true });
const MAX_FILE_BYTES = 16 * 1024;

export function parsePreferencesPatch(value: unknown): Partial<Preferences> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('INVALID_PREFERENCES');
  const keys = Reflect.ownKeys(value);
  if (keys.length > 2 || keys.some(key => key !== 'theme' && key !== 'inspectorVisible')) throw new Error('INVALID_PREFERENCES');
  const input = value as Record<string, unknown>;
  if ('theme' in input && !['light', 'dark', 'oled'].includes(input.theme as string)) throw new Error('INVALID_PREFERENCES');
  if ('inspectorVisible' in input && typeof input.inspectorVisible !== 'boolean') throw new Error('INVALID_PREFERENCES');
  return { ...('theme' in input ? { theme: input.theme as Preferences['theme'] } : {}),
    ...('inspectorVisible' in input ? { inspectorVisible: input.inspectorVisible as boolean } : {}) };
}

export class PreferencesStore {
  private preferences: Preferences = { ...DEFAULT_PREFERENCES };
  private recovered = false;
  private backupRequired = false;
  private readonly file: string;

  constructor(private readonly directory: string) {
    this.file = join(directory, 'appearance.json');
    assertPrivateDirectory(directory);
    if (!entryExists(this.file)) return;
    // Unsafe files fail closed; only a private, regular appearance file can be recovered.
    const bytes = readPrivateFile(this.file, MAX_FILE_BYTES);
    try {
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      const patch = parsePreferencesPatch(parsed);
      if (Object.keys(patch).length !== 2) throw new Error('INVALID_PREFERENCES');
      this.preferences = patch as Preferences;
    } catch {
      this.recovered = true;
      this.backupRequired = true;
    }
  }

  read(): { preferences: Preferences; preferencesRecovered: boolean } {
    return { preferences: { ...this.preferences }, preferencesRecovered: this.recovered };
  }

  update(input: unknown): void {
    const patch = parsePreferencesPatch(input);
    if (!Object.keys(patch).length) return;
    this.persist({ ...this.preferences, ...patch });
  }

  reset(): void { this.persist({ ...DEFAULT_PREFERENCES }); }

  private persist(next: Preferences): void {
    const temporary = join(this.directory, `.appearance-${randomUUID()}.tmp`);
    let temporaryCreated = false;
    try {
      assertPrivateDirectory(this.directory);
      if (entryExists(this.file)) assertPrivateFile(this.file, MAX_FILE_BYTES);
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      temporaryCreated = true;
      try { writeFileSync(fd, JSON.stringify(next) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      if (this.backupRequired && entryExists(this.file)) {
        // Preserve corrupt/unknown appearance bytes before the first explicit update.
        renameSync(this.file, join(this.directory, `appearance-recovered-${randomUUID()}.json`));
        this.backupRequired = false;
      }
      renameSync(temporary, this.file);
      temporaryCreated = false;
      const dirFd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      this.preferences = { ...next };
      this.recovered = false;
    } catch {
      throw new Error('PREFERENCES_SAVE_FAILED');
    } finally {
      if (temporaryCreated) {
        try { unlinkSync(temporary); } catch { /* Never remove anything else on failure. */ }
      }
    }
  }
}
