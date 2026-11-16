import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { basename, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { entryExists } from './profile';

export interface JournalIdentity { endpoint: string; installationId: string; deviceId: string }
export interface JournalScope extends JournalIdentity { epoch: string; projectId?: string; threadId?: string }
export type JournalState = 'prepared' | 'unknown' | 'accepted' | 'rejected';
export interface JournalReceipt {
  operationId: string;
  status: Exclude<JournalState, 'prepared'>;
  delivery?: 'notSent' | 'sent' | 'unknown';
  nativeThreadId?: string;
  nativeTurnId?: string;
  errorCode?: string;
}
export interface JournalAttachment {
  draftId: string;
  name: string;
  mime: string;
  size: number;
  digest: string;
}
export interface JournalEntry {
  operationId: string;
  endpointKey: string;
  installationId: string;
  deviceId: string;
  epoch: string;
  projectId?: string;
  threadId?: string;
  kind: string;
  createdAt: number;
  requestDigest: string;
  state: JournalState;
  code?: string;
  receipt?: JournalReceipt;
  attachment?: JournalAttachment;
  attachmentIds?: string[];
  draftId?: string;
}
/** Scope belongs to the original request, not a later receipt response envelope.
 * The controller must validate that envelope against its current authenticated session. */
export interface JournalSettlement extends JournalScope { operation: JournalReceipt }

export const JOURNAL_FILE = 'operations.json';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_INTENT_BYTES = 16 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EXCEPTIONS = new Set(['turn.interrupt', 'interaction.respond']);
// Canonical upload MIME values returned by Gateway attachmentType (gateway/src/file-types.ts).
const ATTACHMENT_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf',
  'text/plain', 'text/markdown', 'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation']);

function fail(code: string): never { throw new Error(code); }
function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key));
}
function token(value: unknown): value is string { return typeof value === 'string' && TOKEN.test(value); }
function clone(entry: JournalEntry): JournalEntry {
  return { ...entry, ...(entry.receipt ? { receipt: { ...entry.receipt } } : {}),
    ...(entry.attachment ? { attachment: { ...entry.attachment } } : {}),
    ...(entry.attachmentIds ? { attachmentIds: [...entry.attachmentIds] } : {}) };
}
function attachment(value: unknown): JournalAttachment {
  if (!object(value) || typeof value.draftId !== 'string' || !UUID.test(value.draftId)
    || typeof value.name !== 'string' || !value.name || value.name.length > 180 || value.name !== basename(value.name)
    || value.name === '.' || value.name === '..' || /[\\/\p{Cc}\p{Cf}]/u.test(value.name)
    || typeof value.mime !== 'string' || !ATTACHMENT_MIMES.has(value.mime)
    || !Number.isSafeInteger(value.size) || (value.size as number) < 1 || (value.size as number) > 20 * 1024 * 1024
    || typeof value.digest !== 'string' || !SHA256.test(value.digest)) fail('JOURNAL_INVALID_ATTACHMENT');
  return { draftId: value.draftId, name: value.name, mime: value.mime, size: value.size as number, digest: value.digest };
}
function operationMetadata(kind: string, intent: unknown): Pick<JournalEntry, 'attachment' | 'attachmentIds' | 'draftId'> {
  if (kind === 'attachment.upload') return { attachment: attachment(intent) };
  if (kind !== 'turn.start' || !object(intent) || (intent.attachmentIds === undefined && intent.draftId === undefined)) return {};
  if (!Array.isArray(intent.attachmentIds) || intent.attachmentIds.length < 1 || intent.attachmentIds.length > 6
    || intent.attachmentIds.some(id => typeof id !== 'string' || !UUID.test(id))
    || new Set(intent.attachmentIds).size !== intent.attachmentIds.length
    || typeof intent.draftId !== 'string' || !UUID.test(intent.draftId)) fail('JOURNAL_INVALID_ATTACHMENT');
  return { attachmentIds: [...intent.attachmentIds] as string[], draftId: intent.draftId };
}
function identity(input: JournalIdentity): Pick<JournalEntry, 'endpointKey' | 'installationId' | 'deviceId'> {
  if (!object(input) || !token(input.installationId) || !token(input.deviceId)
    || typeof input.endpoint !== 'string' || input.endpoint.length > 4096
    || /[\u0000-\u0020\u007f]/.test(input.endpoint)) fail('JOURNAL_INVALID_SCOPE');
  let endpoint: URL;
  try { endpoint = new URL(input.endpoint); } catch { return fail('JOURNAL_INVALID_SCOPE'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash) fail('JOURNAL_INVALID_SCOPE');
  return { endpointKey: digest(endpoint.href), installationId: input.installationId, deviceId: input.deviceId };
}
function scope(input: JournalScope): Pick<JournalEntry, 'endpointKey' | 'installationId' | 'deviceId' | 'epoch' | 'projectId' | 'threadId'> {
  const owner = identity(input);
  if (!token(input.epoch) || (input.projectId !== undefined && !token(input.projectId))
    || (input.threadId !== undefined && (!token(input.threadId) || !input.projectId))) fail('JOURNAL_INVALID_SCOPE');
  return { ...owner, epoch: input.epoch, ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}) };
}
function sameIdentity(a: Pick<JournalEntry, 'endpointKey' | 'installationId' | 'deviceId'>, b: Pick<JournalEntry, 'endpointKey' | 'installationId' | 'deviceId'>): boolean {
  return a.endpointKey === b.endpointKey && a.installationId === b.installationId && a.deviceId === b.deviceId;
}
function overlaps(entry: JournalEntry, projectId?: string, threadId?: string): boolean {
  return !entry.projectId || !projectId || (entry.projectId === projectId && (!entry.threadId || !threadId || entry.threadId === threadId));
}
function isPending(entry: JournalEntry): boolean { return entry.state === 'prepared' || entry.state === 'unknown'; }

/** Hash JSON intent only. Body text, local paths and credentials never enter the journal. */
function intentDigest(intent: unknown): string {
  const ancestors = new Set<object>();
  const canonical = (value: unknown, depth: number): unknown => {
    if (depth > 64) fail('JOURNAL_INVALID_INTENT');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!Array.isArray(value) && !object(value)) fail('JOURNAL_INVALID_INTENT');
    if (ancestors.has(value as object)) fail('JOURNAL_INVALID_INTENT');
    ancestors.add(value as object);
    let result: unknown;
    if (Array.isArray(value)) result = value.map(item => canonical(item, depth + 1));
    else {
      result = Object.fromEntries(Reflect.ownKeys(value as object).sort((a, b) => String(a).localeCompare(String(b))).map(key => {
        const property = Object.getOwnPropertyDescriptor(value, key)!;
        if (typeof key !== 'string' || !('value' in property)) fail('JOURNAL_INVALID_INTENT');
        return [key, canonical(property.value, depth + 1)];
      }));
    }
    ancestors.delete(value as object);
    return result;
  };
  const serialized = JSON.stringify(canonical(intent, 0));
  if (Buffer.byteLength(serialized) > MAX_INTENT_BYTES) fail('JOURNAL_INVALID_INTENT');
  return digest(serialized);
}
function receipt(input: unknown): JournalReceipt {
  if (!object(input) || typeof input.operationId !== 'string' || !UUID.test(input.operationId)
    || typeof input.status !== 'string' || !['unknown', 'accepted', 'rejected'].includes(input.status)
    || (input.delivery !== undefined && (typeof input.delivery !== 'string' || !['notSent', 'sent', 'unknown'].includes(input.delivery)))
    || (input.nativeThreadId !== undefined && !token(input.nativeThreadId))
    || (input.nativeTurnId !== undefined && !token(input.nativeTurnId))
    || (input.errorCode !== undefined && (typeof input.errorCode !== 'string' || !CODE.test(input.errorCode)))) fail('JOURNAL_INVALID_RECEIPT');
  // Gateway DTOs may contain extra fields; explicitly project only safe receipt metadata.
  return { operationId: input.operationId as string, status: input.status as JournalReceipt['status'],
    ...(input.delivery !== undefined ? { delivery: input.delivery as JournalReceipt['delivery'] } : {}),
    ...(input.nativeThreadId !== undefined ? { nativeThreadId: input.nativeThreadId as string } : {}),
    ...(input.nativeTurnId !== undefined ? { nativeTurnId: input.nativeTurnId as string } : {}),
    ...(input.errorCode !== undefined ? { errorCode: input.errorCode as string } : {}) };
}
function parseEntries(bytes: Buffer): JournalEntry[] {
  try {
    const data: unknown = JSON.parse(bytes.toString('utf8'));
    if (!object(data) || !keys(data, ['version', 'entries', 'sha256']) || data.version !== 1 || !Array.isArray(data.entries)
      || data.sha256 !== digest(JSON.stringify(data.entries))) fail('JOURNAL_CORRUPT');
    const ids = new Set<string>();
    return data.entries.map(value => {
      if (!object(value) || !keys(value, ['operationId', 'endpointKey', 'installationId', 'deviceId', 'epoch', 'projectId', 'threadId', 'kind', 'createdAt', 'requestDigest', 'state', 'code', 'receipt', 'attachment', 'attachmentIds', 'draftId'])
        || typeof value.operationId !== 'string' || !UUID.test(value.operationId) || ids.has(value.operationId)
        || typeof value.endpointKey !== 'string' || !SHA256.test(value.endpointKey)
        || !token(value.installationId) || !token(value.deviceId) || !token(value.epoch)
        || (value.projectId !== undefined && !token(value.projectId))
        || (value.threadId !== undefined && (!token(value.threadId) || !value.projectId))
        || typeof value.kind !== 'string' || !/^[a-z][a-zA-Z0-9._:-]{0,95}$/.test(value.kind)
        || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0
        || typeof value.requestDigest !== 'string' || !SHA256.test(value.requestDigest)
        || typeof value.state !== 'string' || !['prepared', 'unknown', 'accepted', 'rejected'].includes(value.state)
        || (value.code !== undefined && (typeof value.code !== 'string' || !CODE.test(value.code)))) fail('JOURNAL_CORRUPT');
      if (value.receipt !== undefined) {
        if (!object(value.receipt) || !keys(value.receipt, ['operationId', 'status', 'delivery', 'nativeThreadId', 'nativeTurnId', 'errorCode'])) fail('JOURNAL_CORRUPT');
        const parsed = receipt(value.receipt);
        if (parsed.operationId !== value.operationId || parsed.status !== value.state) fail('JOURNAL_CORRUPT');
      } else if (value.state === 'accepted' || value.state === 'rejected') fail('JOURNAL_CORRUPT');
      if (value.state === 'prepared' && (value.receipt !== undefined || value.code !== undefined)) fail('JOURNAL_CORRUPT');
      if (value.kind === 'attachment.upload') {
        if (!value.projectId || !value.threadId || !object(value.attachment) || !keys(value.attachment, ['draftId', 'name', 'mime', 'size', 'digest'])
          || value.attachmentIds !== undefined || value.draftId !== undefined) fail('JOURNAL_CORRUPT');
        attachment(value.attachment);
      } else {
        if (value.attachment !== undefined || (value.kind !== 'turn.start' && (value.attachmentIds !== undefined || value.draftId !== undefined))) fail('JOURNAL_CORRUPT');
        if ((value.attachmentIds !== undefined || value.draftId !== undefined) && (!value.projectId || !value.threadId)) fail('JOURNAL_CORRUPT');
        operationMetadata(value.kind, value);
      }
      ids.add(value.operationId);
      return clone(value as unknown as JournalEntry);
    });
  } catch { return fail('JOURNAL_CORRUPT'); }
}

/** Durable write-ahead metadata, deliberately without replay, reset, removal or body APIs.
 * Call prepare exactly once BEFORE sending. Any restored prepared row is query-only unknown.
 * A failed write poisons this instance, including fsync failures after rename. */
export class OperationJournal {
  private readonly directory: string;
  private readonly directoryIdentity: { dev: number; ino: number };
  private fingerprint: string | undefined;
  private fileIdentity: { dev: number; ino: number } | undefined;
  private entries: JournalEntry[] = [];
  private failed = false;

  constructor(directory: string) {
    if (!isAbsolute(directory) || directory.includes('\0')) fail('JOURNAL_UNSAFE');
    this.directory = resolve(directory);
    this.assertDirectory();
    const stat = fs.lstatSync(this.directory);
    this.directoryIdentity = { dev: stat.dev, ino: stat.ino };
    const saved = this.readDisk();
    if (saved === undefined) return;
    this.fingerprint = digest(saved.bytes);
    this.fileIdentity = { dev: saved.dev, ino: saved.ino };
    this.entries = parseEntries(saved.bytes);
    if (this.entries.some(entry => entry.state === 'prepared')) {
      this.persist(this.entries.map(entry => entry.state === 'prepared' ? { ...entry, state: 'unknown', code: 'PROCESS_RESTARTED' } : entry));
    }
  }

  prepare(input: JournalScope, kind: string, intent: unknown): JournalEntry {
    this.assertCurrent();
    const owner = scope(input);
    if (typeof kind !== 'string' || !/^[a-z][a-zA-Z0-9._:-]{0,95}$/.test(kind)) fail('JOURNAL_INVALID_KIND');
    const pending = this.entries.filter(entry => isPending(entry) && sameIdentity(entry, owner) && overlaps(entry, owner.projectId, owner.threadId));
    // Explicit stop/interaction can address an active turn, but cannot repeat an unresolved exception.
    if (pending.some(entry => !EXCEPTIONS.has(kind) || entry.kind === kind)) fail('JOURNAL_SCOPE_PENDING');
    const requestDigest = intentDigest(intent), metadata = operationMetadata(kind, intent);
    if ((metadata.attachment || metadata.attachmentIds) && (!owner.projectId || !owner.threadId)) fail('JOURNAL_INVALID_ATTACHMENT');
    const entry: JournalEntry = { ...owner, operationId: randomUUID(), kind, createdAt: Date.now(), requestDigest, state: 'prepared', ...metadata };
    this.persist([...this.entries, entry]);
    return clone(entry);
  }

  settle(input: JournalSettlement): JournalEntry {
    this.assertCurrent();
    const owner = scope(input);
    const result = receipt(input.operation);
    const existing = this.entries.find(entry => entry.operationId === result.operationId);
    if (!existing) fail('JOURNAL_OPERATION_MISSING');
    if (!sameIdentity(existing, owner) || existing.epoch !== owner.epoch || existing.projectId !== owner.projectId || existing.threadId !== owner.threadId) fail('JOURNAL_SCOPE_MISMATCH');
    if (!isPending(existing)) {
      if (existing.state !== result.status) fail('JOURNAL_TERMINAL_CONFLICT');
      if (JSON.stringify(existing.receipt) !== JSON.stringify(result)) fail('JOURNAL_TERMINAL_CONFLICT');
      return clone(existing);
    }
    const next = { ...existing, state: result.status, receipt: result };
    delete next.code;
    if (result.errorCode) next.code = result.errorCode;
    this.replace(next);
    return clone(next);
  }

  markUnknown(operationId: string, code: string): JournalEntry {
    this.assertCurrent();
    if (typeof operationId !== 'string' || !UUID.test(operationId) || typeof code !== 'string' || !CODE.test(code)) fail('JOURNAL_INVALID_UNKNOWN');
    const existing = this.entries.find(entry => entry.operationId === operationId);
    if (!existing) fail('JOURNAL_OPERATION_MISSING');
    // A late network error/404 cannot demote a definitive receipt.
    if (!isPending(existing)) return clone(existing);
    const next: JournalEntry = { ...existing, state: 'unknown', code };
    this.replace(next);
    return clone(next);
  }

  list(input: JournalIdentity): JournalEntry[] {
    this.assertCurrent();
    const owner = identity(input);
    return this.entries.filter(entry => sameIdentity(entry, owner)).map(clone);
  }
  pending(input: JournalIdentity): JournalEntry[] { return this.list(input).filter(isPending); }
  blocking(input: JournalIdentity, projectId?: string, threadId?: string): JournalEntry[] {
    if ((projectId !== undefined && !token(projectId)) || (threadId !== undefined && (!token(threadId) || !projectId))) fail('JOURNAL_INVALID_SCOPE');
    return this.pending(input).filter(entry => overlaps(entry, projectId, threadId));
  }

  private replace(next: JournalEntry): void { this.persist(this.entries.map(entry => entry.operationId === next.operationId ? next : entry)); }

  private assertDirectory(): void {
    let current = parse(this.directory).root;
    for (const part of this.directory.slice(current.length).split(sep).filter(Boolean)) {
      current = join(current, part);
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== process.getuid!())
        || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) fail('JOURNAL_UNSAFE');
      if (current === this.directory && (stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700
        || (this.directoryIdentity && (this.directoryIdentity.dev !== stat.dev || this.directoryIdentity.ino !== stat.ino)))) fail('JOURNAL_UNSAFE');
    }
  }

  private openDirectory(): number {
    this.assertDirectory();
    const fd = fs.openSync(this.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (stat.dev !== this.directoryIdentity.dev || stat.ino !== this.directoryIdentity.ino
        || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700) fail('JOURNAL_UNSAFE');
      return fd;
    } catch (error) { fs.closeSync(fd); throw error; }
  }

  private safeFile(stat: fs.Stats): boolean {
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid!()
      && (stat.mode & 0o777) === 0o600 && stat.size <= MAX_FILE_BYTES;
  }

  private readDisk(): { bytes: Buffer; dev: number; ino: number } | undefined {
    const directoryFd = this.openDirectory();
    // Ubuntu dirfd paths pin the checked directory even if an ancestor is renamed.
    const file = `/proc/self/fd/${directoryFd}/${JOURNAL_FILE}`;
    try {
      if (!entryExists(file)) return undefined;
      const before = fs.lstatSync(file);
      if (!this.safeFile(before)) fail('JOURNAL_UNSAFE');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(fd);
        if (!this.safeFile(opened) || opened.dev !== before.dev || opened.ino !== before.ino) fail('JOURNAL_UNSAFE');
        const bytes = fs.readFileSync(fd);
        const after = fs.lstatSync(file);
        this.assertDirectory();
        if (!this.safeFile(after) || after.dev !== opened.dev || after.ino !== opened.ino || bytes.length > MAX_FILE_BYTES) fail('JOURNAL_UNSAFE');
        return { bytes, dev: opened.dev, ino: opened.ino };
      } finally { fs.closeSync(fd); }
    } finally { fs.closeSync(directoryFd); }
  }

  private assertCurrent(): void {
    if (this.failed) fail('JOURNAL_UNAVAILABLE');
    try {
      const saved = this.readDisk();
      if ((saved === undefined ? undefined : digest(saved.bytes)) !== this.fingerprint
        || saved?.dev !== this.fileIdentity?.dev || saved?.ino !== this.fileIdentity?.ino) fail('JOURNAL_CHANGED');
    } catch {
      this.failed = true;
      fail('JOURNAL_UNAVAILABLE');
    }
  }

  private persist(next: JournalEntry[]): void {
    this.assertCurrent();
    let directoryFd: number | undefined;
    let temporary: string | undefined;
    let created: { dev: number; ino: number } | undefined;
    try {
      const serialized = JSON.stringify({ version: 1, entries: next, sha256: digest(JSON.stringify(next)) }) + '\n';
      if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) fail('JOURNAL_FULL');
      directoryFd = this.openDirectory();
      temporary = `/proc/self/fd/${directoryFd}/.operations-${randomUUID()}.tmp`;
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      const stat = fs.fstatSync(fd);
      created = { dev: stat.dev, ino: stat.ino };
      try {
        if (!this.safeFile(stat)) fail('JOURNAL_UNSAFE');
        fs.writeFileSync(fd, serialized);
        fs.fsyncSync(fd);
        if (!this.safeFile(fs.fstatSync(fd))) fail('JOURNAL_UNSAFE');
      } finally { fs.closeSync(fd); }
      this.assertCurrent();
      const ready = fs.lstatSync(temporary);
      if (!this.safeFile(ready) || ready.dev !== created.dev || ready.ino !== created.ino) fail('JOURNAL_UNSAFE');
      fs.renameSync(temporary, `/proc/self/fd/${directoryFd}/${JOURNAL_FILE}`);
      created = undefined;
      fs.fsyncSync(directoryFd);
      const readback = this.readDisk();
      if (readback?.bytes.toString('utf8') !== serialized) fail('JOURNAL_CHANGED');
      this.fingerprint = digest(readback.bytes);
      this.fileIdentity = { dev: readback.dev, ino: readback.ino };
      this.entries = next.map(clone);
    } catch {
      this.failed = true;
      fail('JOURNAL_SAVE_FAILED');
    } finally {
      if (created && temporary) {
        // Only remove the temporary inode we exclusively created in the same directory.
        try {
          const stat = fs.lstatSync(temporary);
          if (this.safeFile(stat) && stat.dev === created.dev && stat.ino === created.ino) fs.unlinkSync(temporary);
        } catch { /* Preserve uncertain files. */ }
      }
      if (directoryFd !== undefined) fs.closeSync(directoryFd);
    }
  }
}
