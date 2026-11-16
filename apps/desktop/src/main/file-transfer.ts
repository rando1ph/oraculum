import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import { parseContract, type FileGrant } from '../../../../packages/gateway-protocol/src/index';

export interface FileDialogs {
  chooseUpload(): Promise<string | undefined>;
  chooseDownload(name: string): Promise<string | undefined>;
}
export interface LocalUpload { name: string; mime: string; bytes: Buffer; digest: string }
const uploadTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.py', '.rs', '.c', '.cpp', '.h',
  '.java', '.kt', '.kts', '.css', '.sh', '.yaml', '.yml', '.toml', '.sql', '.log']);
const UPLOAD_LIMIT = 20 * 1024 * 1024;
const DOWNLOAD_LIMIT = 64 * 1024 * 1024;
type FileIdentity = { dev: bigint; ino: bigint };
const sameFile = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino;
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const fdPath = (directory: FileHandle, name: string): string => `/proc/self/fd/${directory.fd}/${name}`;
function fail(code = 'FILE_INTEGRITY_FAILED'): never { throw new Error(code); }
export function safeFileName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= 180 && name === name.normalize('NFC')
    && name.trim() === name && !name.startsWith('.') && name === basename(name) && !/[/\\:%\p{Cc}\p{Cf}]/u.test(name);
}
function selectedPath(path: string): void {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || path !== resolve(path)
    || /[\x00-\x1f\x7f]/.test(path)) fail('LOCAL_FILE_PATH_INVALID');
}
async function readExact(handle: FileHandle, length: number, limit: number): Promise<Buffer> {
  if (!Number.isSafeInteger(length) || length < 0 || length > limit) fail();
  const bytes = Buffer.alloc(length);
  for (let offset = 0; offset < length;) {
    const result = await handle.read(bytes, offset, Math.min(64 * 1024, length - offset), offset);
    if (!result.bytesRead) fail('LOCAL_FILE_CHANGED');
    offset += result.bytesRead;
  }
  // Never read to EOF: a concurrently growing source cannot exceed the bound.
  if ((await handle.read(Buffer.alloc(1), 0, 1, length)).bytesRead !== 0) fail('LOCAL_FILE_CHANGED');
  return bytes;
}
export async function selectLocalUpload(dialogs: FileDialogs, limit: number): Promise<LocalUpload | undefined> {
  const path = await dialogs.chooseUpload();
  if (!path) return undefined;
  selectedPath(path);
  if (!Number.isSafeInteger(limit) || limit < 1) fail('ATTACHMENT_SIZE_OR_TYPE');
  const name = basename(path), mime = uploadTypes[extname(name).toLowerCase()];
  if (!safeFileName(name) || !mime) fail('ATTACHMENT_TYPE_UNSUPPORTED');
  const selected = await lstat(path, { bigint: true });
  if (!selected.isFile() || selected.isSymbolicLink()) fail('ATTACHMENT_SIZE_OR_TYPE');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameFile(selected, before) || !before.isFile() || before.nlink !== 1n || before.size < 1n
      || before.size > BigInt(Math.min(limit, UPLOAD_LIMIT))) fail('ATTACHMENT_SIZE_OR_TYPE');
    const bytes = await readExact(handle, Number(before.size), Math.min(limit, UPLOAD_LIMIT));
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (!sameFile(before, after) || !sameFile(before, named) || !named.isFile() || named.isSymbolicLink()
      || after.nlink !== 1n || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('LOCAL_FILE_CHANGED');
    return { name, mime, bytes, digest: sha256(bytes) };
  } finally { await handle.close(); }
}

function validateGrant(grant: FileGrant): void {
  try { parseContract('FileGrant', grant); } catch { fail(); }
  const parts = grant.path.split('/'), extension = extname(grant.name).toLowerCase();
  const mime = uploadTypes[extension] ?? (sourceExtensions.has(extension) ? 'text/plain' : undefined);
  if (!safeFileName(grant.name) || parts.length > 12 || grant.path.length > 1024 || parts.some(part => !safeFileName(part))
    || parts.at(-1) !== grant.name || !mime || grant.mime !== mime || grant.size > DOWNLOAD_LIMIT) fail();
}
export function verifyDownload(grant: FileGrant, result: { bytes: Buffer; headers: Record<string, string>; status: number }, now = Date.now()): Buffer {
  validateGrant(grant);
  if (grant.expiresAt <= now || result.status !== 200 || !Buffer.isBuffer(result.bytes)) fail();
  const headers = result.headers, bytes = result.bytes;
  if (bytes.length !== grant.size || headers['content-length'] !== String(grant.size)
    || headers['content-type']?.split(';')[0] !== grant.mime) fail();
  const digest = `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
  if (headers['content-digest'] !== digest || headers['content-disposition'] !== `attachment; filename*=UTF-8''${encodeURIComponent(grant.name)}`) fail();
  return bytes;
}

export function filePreview(grant: FileGrant, bytes: Buffer): { name: string; mime: string; text?: string; image?: string; limited: boolean } {
  validateGrant(grant);
  if (!Buffer.isBuffer(bytes) || bytes.length !== grant.size) fail();
  const base = { name: grant.name, mime: grant.mime };
  if (['image/png', 'image/jpeg', 'image/webp'].includes(grant.mime) && bytes.length <= 5 * 1024 * 1024) {
    return { ...base, image: `data:${grant.mime};base64,${bytes.toString('base64')}`, limited: false };
  }
  if (grant.mime.startsWith('text/')) {
    const limited = bytes.length > 256 * 1024;
    try {
      return { ...base, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 256 * 1024), { stream: limited }), limited };
    } catch { return fail(); }
  }
  return { ...base, limited: true };
}

/** Follow the selected directory using descriptors, refusing symlink redirection. */
async function openParent(path: string): Promise<FileHandle> {
  let directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of dirname(path).split('/').filter(Boolean)) {
      const next = await open(fdPath(directory, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close(); directory = next;
    }
    return directory;
  } catch (error) { await directory.close(); throw error; }
}
async function removeOwned(path: string, identity: FileIdentity): Promise<void> {
  try {
    const named = await lstat(path, { bigint: true });
    if (named.isFile() && !named.isSymbolicLink() && sameFile(named, identity)) await unlink(path);
  } catch { /* Never remove a replaced pathname or hide the original failure. */ }
}

/** Only the native dialog supplies a destination. Exclusive creation preserves
 * existing files; failures remove only our inode. A process crash while saving
 * can leave a partial new destination, never a successful download receipt. */
export async function saveDownload(dialogs: FileDialogs, grant: FileGrant, bytes: Buffer): Promise<boolean> {
  validateGrant(grant);
  if (!Buffer.isBuffer(bytes) || bytes.length !== grant.size) fail();
  const destination = await dialogs.chooseDownload(grant.name);
  if (!destination) return false;
  selectedPath(destination);
  const directory = await openParent(destination), target = fdPath(directory, basename(destination));
  let handle: FileHandle | undefined, identity: FileIdentity | undefined, complete = false;
  try {
    try { handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('DOWNLOAD_DESTINATION_EXISTS'); throw error; }
    identity = await handle.stat({ bigint: true });
    await handle.writeFile(bytes); await handle.sync();
    const saved = await handle.stat({ bigint: true }), named = await lstat(target, { bigint: true });
    if (!saved.isFile() || saved.nlink !== 1n || saved.uid !== BigInt(process.getuid!()) || (saved.mode & 0o777n) !== 0o600n
      || !sameFile(saved, identity) || !sameFile(named, identity) || named.isSymbolicLink() || saved.size !== BigInt(bytes.length)) fail();
    const readback = await readExact(handle, bytes.length, DOWNLOAD_LIMIT);
    const final = await handle.stat({ bigint: true });
    if (sha256(readback) !== sha256(bytes) || final.size !== saved.size || final.mtimeNs !== saved.mtimeNs || final.ctimeNs !== saved.ctimeNs
      || !sameFile(await lstat(target, { bigint: true }), identity)) fail();
    await directory.sync(); complete = true;
    return true;
  } finally {
    if (!complete && identity) await removeOwned(target, identity);
    await handle?.close().catch(() => {}); await directory.close();
  }
}
