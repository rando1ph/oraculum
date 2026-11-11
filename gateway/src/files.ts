import { constants } from 'node:fs';
import { open, opendir, lstat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ProjectRegistry, HostFileError, DirectoryCursors, allowedName, relativeParts, identity, sameIdentity, directoryVersion, pageLimit, fdPath, unavailable, type Identity } from './projects';
import { fileType, sniffAttachment } from './file-types';

type Version = Identity & { size: string; mtimeNs: string; ctimeNs: string };
const version = (s: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): Version => ({ ...identity(s), size: String(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) });
const unchanged = (a: Version, b: Version) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
export type FileOwner = { deviceId: string; projectId: string; threadId?: string | null; authorized: () => boolean; validate?: () => Promise<void> };
export type FileGrant = { fileId: string; projectId: string; threadId: string | null; path: string; name: string; mime: string; size: number; expiresAt: number };
type Grant = { file: FileGrant; deviceId: string; version: Version; directories: Identity[] };
export const fileLimits = { fileBytes: 64 * 1024 * 1024, grantMs: 300_000 } as const;

export class FileService {
  private grants = new Map<string, Grant>();
  private active = new Set<string>();
  private selecting = new Set<string>();
  private cursors: DirectoryCursors;
  private now: () => number;
  constructor(private projects: ProjectRegistry, options: { now?: () => number } = {}) { this.now = options.now ?? Date.now; this.cursors = new DirectoryCursors(this.now); }
  private async auth(owner: FileOwner) {
    if (!owner.authorized()) throw new HostFileError('UNAUTHENTICATED');
    await owner.validate?.();
    if (!owner.authorized()) throw new HostFileError('UNAUTHENTICATED');
  }
  private async checkedFile(owner: FileOwner, path: string, grant?: Grant) {
    await this.auth(owner);
    const names = relativeParts(path), name = names.pop()!, type = fileType(name);
    const dirs = await this.projects.openDirectory(owner.projectId, names, grant?.directories);
    let file: FileHandle | undefined;
    try {
      file = await open(fdPath(dirs.handle, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await file.stat({ bigint: true });
      if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(fileLimits.fileBytes) || info.size < 0n || grant && !unchanged(grant.version, version(info))) throw unavailable();
      const snapshot = version(info);
      const check = async () => {
        await this.auth(owner); await dirs.check();
        const linked = await lstat(fdPath(dirs.handle, name), { bigint: true });
        if (!linked.isFile() || linked.nlink !== 1n || !unchanged(snapshot, version(linked)) || !unchanged(snapshot, version(await file!.stat({ bigint: true })))) throw unavailable();
      };
      await check(); return { file, type, size: Number(info.size), version: snapshot, directories: dirs.identities, check, close: async () => { await file!.close(); await dirs.close(); } };
    } catch { await file?.close(); await dirs.close(); throw unavailable(); }
  }
  async query(projectId: string, path = '', limit?: number, cursor?: string) {
    const names = relativeParts(path, true), count = pageLimit(limit), dirs = await this.projects.openDirectory(projectId, names);
    try {
      const revision = directoryVersion(await dirs.handle.stat({ bigint: true })), scope = `${projectId}:${path}`, after = this.cursors.read(cursor, scope, revision);
      const entries: { name: string; path: string; directory: boolean; size: number; mime: string }[] = []; let scanned = 0;
      for await (const item of await opendir(fdPath(dirs.handle), { bufferSize: 32 })) {
        if (++scanned > 4000) break;
        if (!allowedName(item.name) || item.name <= after || !item.isFile() && !item.isDirectory()) continue;
        const relative = [...names, item.name].join('/');
        if (this.projects.isNested(projectId, join(dirs.project.canonicalPath, relative))) continue;
        try {
          const type = item.isDirectory() ? { mime: '' } : fileType(item.name), s = await lstat(fdPath(dirs.handle, item.name), { bigint: true });
          if (s.isSymbolicLink() || !s.isDirectory() && (!s.isFile() || s.nlink !== 1n || s.size > BigInt(fileLimits.fileBytes))) continue;
          entries.push({ name: item.name, path: relative, directory: s.isDirectory(), size: s.isDirectory() ? 0 : Number(s.size), mime: type.mime });
        } catch { /* Changing, unknown and sensitive files do not become output facts. */ }
      }
      await dirs.check(); if (directoryVersion(await dirs.handle.stat({ bigint: true })) !== revision) throw unavailable();
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0); const page = entries.slice(0, count);
      return { path, entries: page, nextCursor: entries.length > count ? this.cursors.issue(scope, revision, page.at(-1)!.name) : null, limited: scanned > 4000 };
    } finally { await dirs.close(); }
  }
  async select(owner: FileOwner & { path: string }) {
    await this.auth(owner);
    for (const [id, g] of this.grants) if (g.file.expiresAt <= this.now()) this.grants.delete(id);
    if (this.grants.size >= 256 || [...this.grants.values()].filter(g => g.deviceId === owner.deviceId).length >= 48) throw new HostFileError('RATE_LIMITED');
    if (this.selecting.size >= 4 || this.selecting.has(owner.deviceId)) throw new HostFileError('RATE_LIMITED');
    this.selecting.add(owner.deviceId);
    let checked: Awaited<ReturnType<FileService['checkedFile']>> | undefined;
    try {
      checked = await this.checkedFile(owner, owner.path);
      await sniffAttachment(checked.file, checked.type.extension, checked.size); await checked.check();
      if (this.grants.size >= 256 || [...this.grants.values()].filter(g => g.deviceId === owner.deviceId).length >= 48) throw new HostFileError('RATE_LIMITED');
      const file: FileGrant = { fileId: randomUUID(), projectId: owner.projectId, threadId: owner.threadId ?? null, path: owner.path, name: owner.path.split('/').at(-1)!, mime: checked.type.mime, size: checked.size, expiresAt: this.now() + fileLimits.grantMs };
      this.grants.set(file.fileId, { file, deviceId: owner.deviceId, version: checked.version, directories: checked.directories }); return file;
    } finally { await checked?.close(); this.selecting.delete(owner.deviceId); }
  }
  scope(fileId: string, deviceId: string) {
    const grant = this.grants.get(fileId);
    if (!grant || grant.deviceId !== deviceId || grant.file.expiresAt <= this.now()) throw unavailable();
    return { projectId: grant.file.projectId, threadId: grant.file.threadId };
  }
  async content(fileId: string, owner: FileOwner, signal = new AbortController().signal) {
    await this.auth(owner); this.scope(fileId, owner.deviceId); const grant = this.grants.get(fileId)!;
    if (owner.projectId !== grant.file.projectId || (owner.threadId ?? null) !== grant.file.threadId) throw unavailable();
    if (this.active.size >= 2 || this.active.has(owner.deviceId)) throw new HostFileError('RATE_LIMITED');
    this.active.add(owner.deviceId);
    let checked: Awaited<ReturnType<FileService['checkedFile']>> | undefined, stream: Readable | undefined, closed = false, aborted = false, checking = false;
    const started = this.now(); let lastRead = started;
    const abort = () => { aborted = true; stream?.destroy(unavailable()); };
    const live = () => { if (!owner.authorized() || aborted || signal.aborted || grant.file.expiresAt <= this.now() || this.now() - started > 180_000 || this.now() - lastRead > 15_000) throw unavailable(); };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setInterval(() => {
      try { live(); } catch { abort(); }
      if (checked && !checking && !closed) { checking = true; void checked.check().catch(abort).finally(() => { checking = false; }); }
    }, 250); timer.unref();
    const release = async () => { if (closed) return; closed = true; clearInterval(timer); signal.removeEventListener('abort', abort); await checked?.close(); this.active.delete(owner.deviceId); };
    try {
      checked = await this.checkedFile(owner, grant.file.path, grant); live();
      const hash = createHash('sha256'), buffer = Buffer.alloc(65536);
      for (let at = 0; at < checked.size;) {
        live(); await checked.check(); const { bytesRead } = await checked.file.read(buffer, 0, Math.min(buffer.length, checked.size - at), at);
        if (!bytesRead) throw unavailable(); hash.update(buffer.subarray(0, bytesRead)); at += bytesRead; lastRead = this.now();
      }
      await checked.check(); live(); const digest = hash.digest('hex'), reader = checked, now = this.now;
      stream = Readable.from((async function* () {
        const sentHash = createHash('sha256');
        try {
          for (let at = 0; at < reader.size;) {
            live(); await reader.check(); const bytes = Buffer.alloc(Math.min(65536, reader.size - at)), { bytesRead } = await reader.file.read(bytes, 0, bytes.length, at);
            if (!bytesRead) throw unavailable(); at += bytesRead; lastRead = now(); sentHash.update(bytes.subarray(0, bytesRead));
            // Hold the final bytes until the original version and full digest agree.
            if (at === reader.size) { await reader.check(); live(); if (sentHash.digest('hex') !== digest) throw unavailable(); }
            yield bytes.subarray(0, bytesRead);
          }
          await reader.check(); live();
        } finally { await release(); }
      })());
      stream.once('close', () => { void release(); });
      return { ...grant.file, digest, stream };
    } catch { await release(); throw unavailable(); }
  }
}
