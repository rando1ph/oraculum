import { constants } from 'node:fs';
import { open, mkdir, lstat, readdir, unlink, rmdir, statfs, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { GatewayStore } from './store';
import { ProjectRegistry, HostFileError, identity, sameIdentity, fdPath, unavailable } from './projects';
import { attachmentLimits as limits, attachmentType, isUuid, sniffAttachment } from './file-types';

export type AttachmentOwner = { deviceId: string; projectId: string; threadId: string; draftId: string; authorized: () => boolean; validate?: () => Promise<void> };
export type AttachmentRow = { id: string; deviceId: string; projectId: string; threadId: string; draftId: string; name: string; mime: string; kind: 'image' | 'document'; extension: string; size: number; digest: string; dev: string; ino: string; folderDev: string; folderIno: string; state: 'uploading' | 'ready' | 'held' | 'sent' | 'unknown' | 'expired'; uploadOperationId: string | null; operationId: string | null; turnId: string | null; createdAt: number; expiresAt: number | null };
const columns = `id,device_id AS deviceId,project_id AS projectId,thread_id AS threadId,draft_id AS draftId,name,mime,kind,extension,size,digest,dev,ino,folder_dev AS folderDev,folder_ino AS folderIno,state,upload_operation_id AS uploadOperationId,operation_id AS operationId,turn_id AS turnId,created_at AS createdAt,expires_at AS expiresAt`;
export const inboxName = (installationId: string, projectId: string) => `.oraculum-gateway-inbox-${installationId}-${projectId}`;

/** Only this installation's pinned inbox is writable. Codex retains execution authority. */
export class AttachmentStore {
  private active = new Set<string>();
  private initializing = new Map<string, Promise<unknown>>();
  private attempts = new Map<string, number[]>();
  private now: () => number;
  constructor(private store: GatewayStore, private projects: ProjectRegistry, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    // Crashes cannot turn uncertain sent material into disposable draft files.
    this.store.db.exec("UPDATE attachments SET state='unknown',expires_at=NULL WHERE state='held'; UPDATE attachments SET expires_at=0 WHERE state='uploading'");
  }
  private row(id: string) { return this.store.db.prepare(`SELECT ${columns} FROM attachments WHERE id=?`).get(id) as AttachmentRow | undefined; }
  private public(row: AttachmentRow) { return { id: row.id, projectId: row.projectId, threadId: row.threadId, draftId: row.draftId, name: row.name, size: row.size, mime: row.mime, kind: row.kind, digest: row.digest, state: row.state, expiresAt: row.expiresAt, operationId: row.operationId }; }
  private path(row: AttachmentRow) { return join(this.projects.get(row.projectId).canonicalPath, inboxName(this.store.installationId, row.projectId), row.id, 'input.' + row.extension); }
  private belongs(row: AttachmentRow | undefined, owner: AttachmentOwner): row is AttachmentRow { return !!row && row.deviceId === owner.deviceId && row.projectId === owner.projectId && row.threadId === owner.threadId && row.draftId === owner.draftId; }
  private async auth(owner: AttachmentOwner) {
    if (!owner.authorized()) throw new HostFileError('UNAUTHENTICATED');
    await owner.validate?.(); await this.projects.validate(owner.projectId);
    if (!owner.authorized()) throw new HostFileError('UNAUTHENTICATED');
  }
  private async directories(projectId: string, create = false) {
    if (create) {
      const pending = this.initializing.get(projectId);
      if (pending) await pending;
      if (!this.projects.get(projectId).inboxName) {
        const initializing = this.initializeInbox(projectId); this.initializing.set(projectId, initializing);
        try { await initializing; } finally { this.initializing.delete(projectId); }
      }
    }
    const dirs = await this.projects.openDirectory(projectId), p = dirs.project;
    let root: FileHandle | undefined;
    try {
      if (p.inboxName !== inboxName(this.store.installationId, projectId) || !p.inboxDev || !p.inboxIno) throw unavailable();
      root = await open(fdPath(dirs.handle, p.inboxName), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const info = await root.stat({ bigint: true }), expected = { dev: p.inboxDev, ino: p.inboxIno };
      if (!sameIdentity(identity(info), expected) || Number(info.mode & 0o777n) !== 0o700 || info.uid !== BigInt(process.getuid!())) throw unavailable();
      const check = async () => {
        await dirs.check(); const linked = await lstat(fdPath(dirs.handle, p.inboxName!), { bigint: true });
        if (!linked.isDirectory() || !sameIdentity(identity(linked), expected) || Number(linked.mode & 0o777n) !== 0o700 || linked.uid !== BigInt(process.getuid!())) throw unavailable();
        const ignore = await open(fdPath(root!, '.gitignore'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try { const s = await ignore.stat(); if (!s.isFile() || s.nlink !== 1 || s.size !== 2 || (await ignore.readFile('utf8')) !== '*\n') throw unavailable(); } finally { await ignore.close(); }
      };
      await check(); return { root, check, close: async () => { await root!.close(); await dirs.close(); } };
    } catch { await root?.close(); await dirs.close(); throw unavailable(); }
  }
  private async initializeInbox(projectId: string) {
    const dirs = await this.projects.openDirectory(projectId), name = inboxName(this.store.installationId, projectId);
    let root: FileHandle | undefined;
    try {
      try { await mkdir(fdPath(dirs.handle, name), { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      root = await open(fdPath(dirs.handle, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const info = await root.stat({ bigint: true });
      if (Number(info.mode & 0o777n) !== 0o700 || info.uid !== BigInt(process.getuid!()) || (await readdir(fdPath(root))).length) throw unavailable();
      // An existing nonempty directory belongs to somebody else, even with our name.
      const ignore = await open(fdPath(root, '.gitignore'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await ignore.writeFile('*\n'); await ignore.sync(); } finally { await ignore.close(); }
      await root.sync(); await dirs.handle.sync(); await dirs.check();
      if (!sameIdentity(identity(info), identity(await lstat(fdPath(dirs.handle, name), { bigint: true })))) throw unavailable();
      this.store.updateProjectInbox(projectId, { name, ...identity(info) });
    } finally { await root?.close(); await dirs.close(); }
  }
  async upload(raw: { name: string; mime: string; size: number; operationId?: string }, input: Readable, owner: AttachmentOwner) {
    await this.auth(owner);
    if (!isUuid(owner.draftId) || !owner.threadId || owner.threadId.length > 256) throw new HostFileError('INVALID_REQUEST');
    let type:ReturnType<typeof attachmentType>;
    try { type=attachmentType(raw.name,raw.mime,raw.size); } catch { throw new HostFileError('INVALID_REQUEST','Unsupported attachment metadata'); }
    const size = raw.size;
    for (const [id, times] of this.attempts) { const recent = times.filter(t => t > this.now() - 60_000); if (recent.length) this.attempts.set(id, recent); else this.attempts.delete(id); }
    const times = this.attempts.get(owner.deviceId) ?? [];
    if (times.length >= 24 || [...this.attempts.values()].reduce((n, a) => n + a.length, 0) >= 60 || this.active.size >= 2 || this.active.has(owner.deviceId)) throw new HostFileError('RATE_LIMITED');
    times.push(this.now()); this.attempts.set(owner.deviceId, times); this.active.add(owner.deviceId);
    const started = this.now(); let received = 0, lastChunk = started;
    input.on('error', () => {});
    const abort = () => { if (!owner.authorized() || this.now() - started > 120_000 || this.now() - lastChunk > 15_000 || this.now() - started > 15_000 && received * 1000 / (this.now() - started) < 1024) input.destroy(new HostFileError('UPLOAD_ABORTED')); };
    const timer = setInterval(abort, 250); timer.unref();
    let row: AttachmentRow | undefined, dirs: Awaited<ReturnType<AttachmentStore['directories']>> | undefined, folder: FileHandle | undefined, file: FileHandle | undefined;
    try {
      await this.cleanup(); await this.auth(owner);
      row = this.store.transaction(() => {
        const db = this.store.db;
        const total = db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM attachments WHERE state<>'expired'").get() as { count: number; bytes: number };
        const device = db.prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM attachments WHERE device_id=? AND state<>'expired'").get(owner.deviceId) as { bytes: number };
        const batch = db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM attachments WHERE device_id=? AND project_id=? AND thread_id=? AND draft_id=? AND state<>'expired'").get(owner.deviceId, owner.projectId, owner.threadId, owner.draftId) as { count: number; bytes: number };
        if (batch.count >= limits.count || batch.bytes + size > limits.batchBytes || total.count >= 256 || total.bytes + size > 1024 ** 3 || device.bytes + size > 200 * 1024 ** 2) throw new HostFileError('ATTACHMENT_LIMIT');
        if (raw.operationId) {
          const op = this.store.getOperation(raw.operationId, owner.deviceId);
          if (!op || op.projectId !== owner.projectId || op.threadId !== owner.threadId || op.status !== 'unknown') throw new HostFileError('INVALID_OPERATION');
        }
        const id = randomUUID();
        db.prepare(`INSERT INTO attachments (id,device_id,project_id,thread_id,draft_id,name,mime,kind,extension,size,digest,dev,ino,folder_dev,folder_ino,state,upload_operation_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'0','0','0','0','uploading',?,?,?)`).run(id, owner.deviceId, owner.projectId, owner.threadId, owner.draftId, raw.name, type.mime, type.kind, type.extension, size, '0'.repeat(64), raw.operationId ?? null, this.now(), this.now() + limits.readyMs);
        return this.row(id)!;
      });
      dirs = await this.directories(owner.projectId, true);
      const disk = await statfs(fdPath(dirs.root), { bigint: true }); if (disk.bavail * disk.bsize < BigInt(256 * 1024 * 1024 + limits.fileBytes)) throw new HostFileError('INSUFFICIENT_STORAGE');
      await mkdir(fdPath(dirs.root, row.id), { mode: 0o700 });
      folder = await open(fdPath(dirs.root, row.id), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const folderIdentity = identity(await folder.stat({ bigint: true }));
      this.store.db.prepare('UPDATE attachments SET folder_dev=?,folder_ino=? WHERE id=?').run(folderIdentity.dev, folderIdentity.ino, row.id);
      file = await open(fdPath(folder, 'input.' + row.extension), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      const initial = identity(await file.stat({ bigint: true })); this.store.db.prepare('UPDATE attachments SET dev=?,ino=? WHERE id=?').run(initial.dev, initial.ino, row.id);
      const hash = createHash('sha256');
      for await (const rawChunk of input) {
        await this.auth(owner); await dirs.check();
        if (!sameIdentity(folderIdentity, identity(await lstat(fdPath(dirs.root, row.id), { bigint: true })))) throw unavailable();
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk); received += chunk.length; lastChunk = this.now();
        if (received > size || received > limits.fileBytes) throw new HostFileError('ATTACHMENT_LIMIT'); hash.update(chunk);
        for (let at = 0; at < chunk.length;) { const written = await file.write(chunk, at, chunk.length - at); if (!written.bytesWritten) throw unavailable(); at += written.bytesWritten; }
      }
      if (received !== size || input.destroyed && !input.readableEnded) throw new HostFileError('UPLOAD_ABORTED');
      await sniffAttachment(file, row.extension, size); await file.chmod(0o400); await file.sync(); await folder.sync(); await dirs.root.sync();
      await this.auth(owner); await dirs.check();
      if (!sameIdentity(folderIdentity, identity(await lstat(fdPath(dirs.root, row.id), { bigint: true })))) throw unavailable();
      const info = await file.stat({ bigint: true }), linked = await lstat(fdPath(folder, 'input.' + row.extension), { bigint: true });
      if (!info.isFile() || info.nlink !== 1n || !sameIdentity(initial, identity(linked)) || info.size !== BigInt(size)) throw unavailable();
      this.store.db.prepare("UPDATE attachments SET state='ready',digest=?,dev=?,ino=? WHERE id=? AND state='uploading'").run(hash.digest('hex'), String(info.dev), String(info.ino), row.id);
      return this.public(this.row(row.id)!);
    } catch (error) {
      if (row) {
        this.store.db.prepare("UPDATE attachments SET state='expired' WHERE id=? AND state='uploading'").run(row.id);
        // Delete only the inode we opened, never a replaced path or unowned tree.
        if (file && folder) { const s = await lstat(fdPath(folder, 'input.' + row.extension), { bigint: true }).catch(() => null); if (s && sameIdentity(identity(s), identity(await file.stat({ bigint: true })))) await unlink(fdPath(folder, 'input.' + row.extension)).catch(() => {}); }
        if (folder && dirs) { const s = await lstat(fdPath(dirs.root, row.id), { bigint: true }).catch(() => null); if (s && sameIdentity(identity(s), identity(await folder.stat({ bigint: true })))) await rmdir(fdPath(dirs.root, row.id)).catch(() => {}); }
      }
      if (error instanceof HostFileError) throw error; throw new HostFileError('UPLOAD_ABORTED', 'Attachment upload failed or its content type is invalid.');
    } finally { clearInterval(timer); await file?.close(); await folder?.close(); await dirs?.close(); this.active.delete(owner.deviceId); }
  }
  private async checked(row: AttachmentRow) {
    const dirs = await this.directories(row.projectId); let folder: FileHandle | undefined, file: FileHandle | undefined;
    try {
      folder = await open(fdPath(dirs.root, row.id), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (!sameIdentity({ dev: row.folderDev, ino: row.folderIno }, identity(await folder.stat({ bigint: true })))) throw unavailable();
      file = await open(fdPath(folder, 'input.' + row.extension), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await file.stat({ bigint: true });
      if (!info.isFile() || info.nlink !== 1n || info.size !== BigInt(row.size) || !sameIdentity(row, identity(info))) throw unavailable();
      const hash = createHash('sha256'), buffer = Buffer.alloc(65536);
      for (let at = 0; at < row.size;) { const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, row.size - at), at); if (!bytesRead) throw unavailable(); hash.update(buffer.subarray(0, bytesRead)); at += bytesRead; }
      if (hash.digest('hex') !== row.digest) throw unavailable();
      await dirs.check();
      const after = await file.stat({ bigint: true });
      if (after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs || !sameIdentity(row, identity(await lstat(fdPath(folder, 'input.' + row.extension), { bigint: true }))) || !sameIdentity({ dev: row.folderDev, ino: row.folderIno }, identity(await lstat(fdPath(dirs.root, row.id), { bigint: true })))) throw unavailable();
      return this.path(row);
    } finally { await file?.close(); await folder?.close(); await dirs.close(); }
  }
  async prepare(ids: unknown, owner: AttachmentOwner) {
    await this.auth(owner);
    if (!Array.isArray(ids) || ids.length > limits.count || ids.some(id => !isUuid(id)) || new Set(ids).size !== ids.length) throw new HostFileError('INVALID_REQUEST');
    const rows: AttachmentRow[] = [], paths: string[] = [];
    for (const id of ids) {
      const row = this.row(id);
      if (!this.belongs(row, owner) || row.state !== 'ready' || row.expiresAt === null || row.expiresAt <= this.now()) throw new HostFileError('ATTACHMENT_UNAVAILABLE');
      paths.push(await this.checked(row)); rows.push(row);
    }
    if (rows.reduce((sum, row) => sum + row.size, 0) > limits.batchBytes) throw new HostFileError('ATTACHMENT_LIMIT'); await this.auth(owner);
    return { rows, input: rows.flatMap((row, i) => row.kind === 'image' ? [{ type: 'localImage' as const, path: paths[i]! }] : []), referenceText: rows.some(r => r.kind === 'document') ? '\n\n[Oraculum attachments: use existing host tools and native permissions to read these files.]\n' + rows.flatMap((row, i) => row.kind === 'document' ? [`${JSON.stringify(row.name)}: ${JSON.stringify(paths[i])}`] : []).join('\n') : '' };
  }
  /** Compose inside the SAME synchronous transaction as reserveOperation. */
  claim(rows: AttachmentRow[], operationId: string) {
    return this.store.transaction(() => {
      for (const row of rows) {
        const op = this.store.getOperation(operationId, row.deviceId);
        if (!op || op.status !== 'unknown' || op.projectId !== row.projectId || op.threadId !== row.threadId) throw new HostFileError('INVALID_OPERATION');
        if (this.store.db.prepare("UPDATE attachments SET state='held',operation_id=?,expires_at=NULL WHERE id=? AND device_id=? AND project_id=? AND thread_id=? AND draft_id=? AND state='ready' AND digest=? AND expires_at>?").run(operationId, row.id, row.deviceId, row.projectId, row.threadId, row.draftId, row.digest, this.now()).changes !== 1) throw new HostFileError('ATTACHMENT_UNAVAILABLE');
      }
    });
  }
  accepted(operationId: string, turnId: string) { this.store.db.prepare("UPDATE attachments SET state='sent',turn_id=?,expires_at=NULL WHERE operation_id=? AND state IN ('held','unknown')").run(turnId, operationId); }
  rejected(operationId: string) { this.store.db.prepare("UPDATE attachments SET state='ready',operation_id=NULL,expires_at=? WHERE operation_id=? AND state='held'").run(this.now() + limits.readyMs, operationId); }
  unknown(operationId: string) { this.store.db.prepare("UPDATE attachments SET state='unknown',expires_at=NULL WHERE operation_id=? AND state='held'").run(operationId); }
  forUploadOperation(operationId: string, deviceId: string) { const row = this.store.db.prepare(`SELECT ${columns} FROM attachments WHERE upload_operation_id=? AND device_id=?`).get(operationId, deviceId) as AttachmentRow | undefined; return row ? this.public(row) : undefined; }
  list(owner: AttachmentOwner) { if (!owner.authorized()) throw new HostFileError('UNAUTHENTICATED'); return (this.store.db.prepare(`SELECT ${columns} FROM attachments WHERE device_id=? AND project_id=? AND thread_id=? AND draft_id=? ORDER BY created_at,id`).all(owner.deviceId, owner.projectId, owner.threadId, owner.draftId) as AttachmentRow[]).map(r => this.public(r)); }
  async remove(id: string, owner: AttachmentOwner) {
    await this.auth(owner); const row = isUuid(id) ? this.row(id) : undefined;
    if (!this.belongs(row, owner)) throw new HostFileError('ATTACHMENT_UNAVAILABLE');
    if (row.state === 'expired') return { removed: true };
    if (row.state !== 'ready') throw new HostFileError('ATTACHMENT_IN_USE', 'Sent and uncertain attachments are retained.');
    await this.expire(row); return { removed: true };
  }
  private async expire(row: AttachmentRow) {
    if (this.store.db.prepare("UPDATE attachments SET state='expired' WHERE id=? AND state IN ('ready','uploading')").run(row.id).changes !== 1) return;
    const dirs = await this.directories(row.projectId); let folder: FileHandle | undefined;
    try {
      folder = await open(fdPath(dirs.root, row.id), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (!sameIdentity({ dev: row.folderDev, ino: row.folderIno }, identity(await folder.stat({ bigint: true })))) throw unavailable();
      await dirs.check(); const name = 'input.' + row.extension, info = await lstat(fdPath(folder, name), { bigint: true });
      if (!info.isFile() || info.nlink !== 1n || !sameIdentity(row, identity(info))) throw unavailable();
      await unlink(fdPath(folder, name));
      if (sameIdentity({ dev: row.folderDev, ino: row.folderIno }, identity(await lstat(fdPath(dirs.root, row.id), { bigint: true })))) await rmdir(fdPath(dirs.root, row.id));
    } finally { await folder?.close(); await dirs.close(); }
  }
  async cleanup() {
    const rows = this.store.db.prepare(`SELECT ${columns} FROM attachments WHERE state IN ('ready','uploading') AND expires_at<=? LIMIT 256`).all(this.now()) as AttachmentRow[];
    for (const row of rows) try { await this.expire(row); } catch { /* Preserve replaced paths and unavailable projects; never recursively delete. */ }
  }
}
