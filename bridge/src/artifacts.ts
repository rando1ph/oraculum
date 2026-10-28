import { constants } from 'node:fs';
import { open, opendir, lstat, realpath, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import { artifactLimits as limits, artifactType, artifactPreview, type ArtifactEntry, type ArtifactFile, type ArtifactListing, type ArtifactScope } from '../../packages/shared/artifacts';
import { attachmentId } from '../../packages/shared/attachments';
import { sniffAttachment } from './attachment-types';

export type ArtifactOwner = ArtifactScope & { deviceId: string; authorized: () => boolean; validate: () => Promise<void> };
type Identity = { dev: string; ino: string };
type Version = Identity & { size: string; mtimeNs: string; ctimeNs: string };
type Grant = { file: ArtifactFile; owner: ArtifactScope & { deviceId: string }; version: Version; directories: Identity[] };
const identity = (s: { dev: bigint; ino: bigint }): Identity => ({ dev: String(s.dev), ino: String(s.ino) });
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const version = (s: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): Version =>
  ({ ...identity(s), size: String(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) });
const unchanged = (a: Version, b: Version) => same(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const fd = (h: FileHandle, name = '') => `/proc/self/fd/${h.fd}${name ? '/' + name : ''}`;
const unavailable = () => new Error('文件不存在、已变化或不允许读取，请刷新后重新选择。');
const allowedName = (s: string) => !!s && s.length <= 180 && s === s.normalize('NFC') && s.trim() === s && !s.startsWith('.') &&
  !/[/\\:%\p{Cc}\p{Cf}]/u.test(s) &&
  !/(^|[._ -])(auth|credentials?|secrets?|tokens?|passwords?|passwd|config(?:uration)?|settings|private[-_ ]?keys?|id_rsa|id_ed25519)([._ -]|$)/i.test(s) &&
  !['node_modules', 'vendor'].includes(s);
function parts(value: unknown, empty = false) {
  if (typeof value !== 'string' || value.length > 1024 || (!value && !empty)) throw unavailable();
  const p = value ? value.split('/') : [];
  if (p.length > 12 || p.some(s => !allowedName(s))) throw unavailable();
  return p;
}

// Linux descriptor-relative reads pin every ancestor; no stat-then-open path reads.
// Grants are bounded, short-lived in-memory metadata, never content or credentials.
export class ArtifactStore {
  private grants = new Map<string, Grant>();
  private active = new Set<string>();
  private busy = new Set<string>();
  private attempts = new Map<string, number[]>();
  constructor(private db: DatabaseSync, private now = () => Date.now()) {}
  private auth(owner: ArtifactOwner) { if (!owner.authorized()) throw new Error('设备授权已失效，读取已停止。'); }
  private budget(owner: ArtifactOwner) {
    this.auth(owner);
    for (const [id, times] of this.attempts) if (!times.some(t => this.now() - t < 60000)) this.attempts.delete(id);
    const times = (this.attempts.get(owner.deviceId) ?? []).filter(t => this.now() - t < 60000);
    if (times.length >= 60 || [...this.attempts.values()].reduce((n, a) => n + a.length, 0) >= 180 || this.busy.size >= 4 || this.busy.has(owner.deviceId)) throw new Error('文件请求过于频繁，请稍后重试。');
    times.push(this.now()); this.attempts.set(owner.deviceId, times); this.busy.add(owner.deviceId);
  }
  private async directories(owner: ArtifactOwner, names: string[], expected?: Identity[]) {
    const handles: FileHandle[] = [], saved: { path: string; id: Identity }[] = [];
    let current = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (const name of owner.cwd.split('/').filter(Boolean)) {
        const next = await open(fd(current, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await current.close(); current = next;
      }
      handles.push(current);
      const root = identity(await current.stat({ bigint: true }));
      const registered = this.db.prepare('SELECT dev, ino FROM projects WHERE cwd=?').get(owner.cwd) as Identity | undefined;
      if (!registered || !same(root, registered)) throw unavailable();
      saved.push({ path: owner.cwd, id: root });
      for (const name of names) {
        const path = join(saved.at(-1)!.path, name);
        // An independently registered nested project has its own authorization boundary.
        if (this.db.prepare('SELECT cwd FROM projects WHERE cwd=?').get(path)) throw unavailable();
        current = await open(fd(current, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        handles.push(current); saved.push({ path, id: identity(await current.stat({ bigint: true })) });
      }
      const check = async () => {
        this.auth(owner); await owner.validate(); this.auth(owner);
        if (await realpath(owner.cwd) !== owner.cwd) throw unavailable();
        for (const [i, item] of saved.entries()) {
          const info = await lstat(item.path, { bigint: true });
          if (!info.isDirectory() || !same(identity(info), item.id) || expected && (!expected[i] || !same(expected[i]!, item.id))) throw unavailable();
        }
      };
      await check();
      return { handle: current, identities: saved.map(s => s.id), check,
        close: async () => { for (const h of handles.reverse()) await h.close(); } };
    } catch (error) { for (const h of new Set([...handles, current])) await h.close().catch(() => {}); throw error; }
  }
  private async checkedFile(owner: ArtifactOwner, path: string, grant?: Grant) {
    const names = parts(path), name = names.pop()!, type = artifactType(name);
    const dirs = await this.directories(owner, names, grant?.directories);
    let file: FileHandle | undefined;
    try {
      // O_NONBLOCK prevents a replaced FIFO/device from blocking the event loop.
      file = await open(fd(dirs.handle, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await file.stat({ bigint: true });
      if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(limits.fileBytes) || info.size < 0n ||
        grant && !unchanged(grant.version, version(info))) throw unavailable();
      const snapshot = version(info);
      const check = async () => {
        await dirs.check();
        const linked = await lstat(fd(dirs.handle, name), { bigint: true });
        if (!linked.isFile() || linked.nlink !== 1n || !unchanged(snapshot, version(linked)) ||
          !unchanged(snapshot, version(await file!.stat({ bigint: true })))) throw unavailable();
      };
      await check();
      return { file, type, size: Number(info.size), version: snapshot, directories: dirs.identities, check,
        close: async () => { await file!.close(); await dirs.close(); } };
    } catch (error) { await file?.close(); await dirs.close(); throw error; }
  }
  async list(owner: ArtifactOwner, path: unknown = '', cursor: unknown = ''): Promise<ArtifactListing> {
    this.budget(owner);
    try {
      const names = parts(path, true);
      if (typeof cursor !== 'string' || cursor && !allowedName(cursor)) throw unavailable();
      const dirs = await this.directories(owner, names);
      try {
        const entries: ArtifactEntry[] = [];
        const directory = await opendir(fd(dirs.handle), { bufferSize: 32 });
        let scanned = 0;
        // Bound directory work/memory even when an agent creates millions of entries.
        for await (const item of directory) {
          if (++scanned > 4000) break;
          if (!allowedName(item.name) || item.name <= cursor || (!item.isFile() && !item.isDirectory())) continue;
          const relative = [...names, item.name].join('/');
          if (this.db.prepare('SELECT cwd FROM projects WHERE cwd=?').get(join(owner.cwd, relative))) continue;
          try {
            const type = item.isDirectory() ? { mime: '' } : artifactType(item.name);
            const s = await lstat(fd(dirs.handle, item.name), { bigint: true });
            if (s.isSymbolicLink() || !s.isDirectory() && (!s.isFile() || s.nlink !== 1n || s.size > BigInt(limits.fileBytes))) continue;
            entries.push({ name: item.name, path: relative, directory: s.isDirectory(), size: s.isDirectory() ? 0 : Number(s.size), mime: type.mime });
          } catch { /* A changing/unknown/sensitive file is never an output fact. */ }
        }
        await dirs.check();
        entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        const page = entries.slice(0, limits.page);
        return { path: names.join('/'), entries: page, cursor: entries.length > limits.page ? page.at(-1)!.name : null, limited: scanned > 4000 };
      } finally { await dirs.close(); }
    } catch { throw unavailable(); }
    finally { this.busy.delete(owner.deviceId); }
  }
  async select(owner: ArtifactOwner, path: unknown): Promise<ArtifactFile> {
    this.budget(owner);
    try {
      parts(path);
      for (const [id, grant] of this.grants) if (grant.file.expiresAt <= this.now()) this.grants.delete(id);
      if (this.grants.size >= 256 || [...this.grants.values()].filter(g => g.owner.deviceId === owner.deviceId).length >= 48) throw new Error('已选择的文件过多，请稍后重试。');
      const checked = await this.checkedFile(owner, path as string);
      try {
        await sniffAttachment(checked.file, checked.type.extension, checked.size); await checked.check();
        const name = (path as string).split('/').at(-1)!;
        const file: ArtifactFile = { id: randomUUID(), name, path: path as string, directory: false, size: checked.size,
          mime: checked.type.mime, preview: artifactPreview(checked.type.mime, checked.size), expiresAt: this.now() + limits.grantMs };
        this.grants.set(file.id, { file, owner: { cwd: owner.cwd, threadId: owner.threadId, deviceId: owner.deviceId }, version: checked.version, directories: checked.directories });
        return file;
      } finally { await checked.close(); }
    } catch { throw unavailable(); }
    finally { this.busy.delete(owner.deviceId); }
  }
  scope(id: unknown, deviceId: string): ArtifactScope {
    const grant = attachmentId(id) ? this.grants.get(id) : undefined;
    if (!grant || grant.owner.deviceId !== deviceId || grant.file.expiresAt <= this.now()) throw unavailable();
    return { cwd: grant.owner.cwd, threadId: grant.owner.threadId };
  }
  async download(owner: ArtifactOwner, id: string, signal: AbortSignal) {
    this.budget(owner);
    let checked: Awaited<ReturnType<ArtifactStore['checkedFile']>> | undefined;
    let release: (() => Promise<void>) | undefined;
    try {
      this.scope(id, owner.deviceId);
      const grant = this.grants.get(id)!;
      if (owner.cwd !== grant.owner.cwd || owner.threadId !== grant.owner.threadId) throw unavailable();
      if (this.active.size >= 2 || this.active.has(owner.deviceId)) throw new Error('已有文件正在下载，请稍后重试。');
      this.active.add(owner.deviceId);
      const started = this.now(); let lastRead = started, closed = false, aborted = false;
      let stream: Readable | undefined;
      const abort = () => { aborted = true; stream?.destroy(new Error('下载已取消或授权失效。')); };
      signal.addEventListener('abort', abort, { once: true });
      const timer = setInterval(() => { if (!owner.authorized() || signal.aborted || this.now() - started > 180000 || this.now() - lastRead > 15000) abort(); }, 250);
      timer.unref();
      release = async () => {
        if (closed) return; closed = true;
        clearInterval(timer); signal.removeEventListener('abort', abort);
        await checked?.close(); this.active.delete(owner.deviceId);
      };
      const live = () => { this.auth(owner); if (aborted || signal.aborted || this.now() - started > 180000 || grant.file.expiresAt <= this.now()) throw unavailable(); };
      checked = await this.checkedFile(owner, grant.file.path, grant);
      await sniffAttachment(checked.file, checked.type.extension, checked.size); live();
      const hash = createHash('sha256'), buffer = Buffer.alloc(65536);
      for (let at = 0; at < checked.size;) {
        live(); await checked.check();
        const { bytesRead } = await checked.file.read(buffer, 0, Math.min(buffer.length, checked.size - at), at);
        if (!bytesRead) throw unavailable();
        hash.update(buffer.subarray(0, bytesRead)); at += bytesRead; lastRead = this.now();
      }
      await checked.check(); live(); const digest = hash.digest('hex');
      const reader = checked, done = release, store = this;
      stream = Readable.from((async function* () {
        const sentHash = createHash('sha256');
        try {
          for (let at = 0; at < reader.size;) {
            live(); await reader.check();
            const bytes = Buffer.alloc(Math.min(65536, reader.size - at));
            const { bytesRead } = await reader.file.read(bytes, 0, bytes.length, at);
            if (!bytesRead) throw unavailable();
            at += bytesRead; lastRead = store.now(); sentHash.update(bytes.subarray(0, bytesRead));
            // Keep the last chunk until file/digest checks succeed, so a mutation
            // cannot look like a complete Content-Length response to the client.
            if (at === reader.size) { await reader.check(); live(); if (sentHash.digest('hex') !== digest) throw unavailable(); }
            yield bytes.subarray(0, bytesRead);
          }
          await reader.check(); live();
        } finally { await done(); }
      })());
      stream.once('close', () => { void done(); });
      // If the consumer disconnects before iteration starts, close still owns FDs.
      return { file: grant.file, digest, stream };
    } catch (error) {
      await release?.();
      if (error instanceof Error && error.message === '已有文件正在下载，请稍后重试。') throw error;
      throw unavailable();
    } finally { this.busy.delete(owner.deviceId); }
  }
}
