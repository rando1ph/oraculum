import { constants } from 'node:fs';
import { open, mkdir, lstat, realpath, unlink, rmdir, statfs, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Readable } from 'node:stream';
import { attachmentId, attachmentLimits as limits, attachmentType, type AttachmentDelivery, type AttachmentFile, type AttachmentScope } from '../../packages/shared/attachments';
import type { UserInput } from '../../.local/codex-protocol/v2/UserInput';
import { sniffAttachment } from './attachment-types';

export const inboxName = '.oraculum-attachments';
export type AttachmentOwner = AttachmentScope & { deviceId: string; authorized: () => boolean; validate: () => Promise<void> };
type Row = AttachmentFile & AttachmentScope & { deviceId: string; extension: string; state: 'uploading' | 'ready' | 'held' | 'sent' | 'expired';
  operationId: string | null; turnId: string | null; createdAt: number; digest: string; dev: string; ino: string; folderDev: string; folderIno: string };
type Root = { cwd: string; projectDev: string; projectIno: string; dev: string; ino: string };
const identity = (info: { dev: bigint; ino: bigint }) => ({ dev: String(info.dev), ino: String(info.ino) });
const same = (a: { dev: string; ino: string }, b: { dev: string; ino: string }) => a.dev === b.dev && a.ino === b.ino;
const fdPath = (file: FileHandle, name = '') => `/proc/self/fd/${file.fd}${name ? '/' + name : ''}`;
const fail = () => { throw new Error('附件目录或文件已变化，请重新选择文件。'); };
const authorized = (owner: AttachmentOwner) => { if (!owner.authorized()) throw new Error('设备授权已撤销，上传已停止。'); };
async function canonicalDirectory(path: string) {
  let current = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of path.split('/').filter(Boolean)) {
      const next = await open(fdPath(current, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await current.close(); current = next;
    }
    return current;
  } catch (error) { await current.close(); throw error; }
}

// Binary stays in the selected project's private inbox. SQLite holds delivery
// metadata only. Linux descriptor-relative IO pins directories through renames.
export class AttachmentStore {
  private active = new Set<string>();
  private attempts = new Map<string, { start: number; count: number }>();
  private attemptWindow = { start: 0, count: 0 };
  constructor(private db: DatabaseSync, private now = () => Date.now()) {
    db.exec(`CREATE TABLE IF NOT EXISTS attachment_roots (cwd TEXT PRIMARY KEY, projectDev TEXT NOT NULL, projectIno TEXT NOT NULL, dev TEXT NOT NULL, ino TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY, cwd TEXT NOT NULL, threadId TEXT NOT NULL, draftId TEXT NOT NULL, deviceId TEXT NOT NULL,
        name TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, kind TEXT NOT NULL, extension TEXT NOT NULL,
        expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, state TEXT NOT NULL, operationId TEXT, turnId TEXT,
        digest TEXT NOT NULL, dev TEXT NOT NULL, ino TEXT NOT NULL, folderDev TEXT NOT NULL, folderIno TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attachment_scope ON attachments(cwd, threadId, draftId, deviceId);
      UPDATE attachments SET expiresAt=0 WHERE state='uploading';`);
  }
  private row(id: string) { return this.db.prepare('SELECT * FROM attachments WHERE id=?').get(id) as Row | undefined; }
  private public(row: Row): AttachmentFile { return { id: row.id, name: row.name, size: row.size, mime: row.mime, kind: row.kind, expiresAt: row.expiresAt }; }
  private path(row: Row) { return join(row.cwd, inboxName, row.id, 'input.' + row.extension); }
  private belongs(row: Row | undefined, owner: AttachmentOwner): row is Row {
    return !!row && row.cwd === owner.cwd && row.threadId === owner.threadId && row.draftId === owner.draftId && row.deviceId === owner.deviceId;
  }
  private async directories(cwd: string, create = false) {
    if (await realpath(cwd) !== cwd) fail();
    const project = await canonicalDirectory(cwd);
    let root: FileHandle | undefined;
    try {
      const info = await project.stat({ bigint: true });
      // Compare the pinned inode with the canonical registry before the first
      // write, including first use of the inbox. Ancestor swaps cannot redirect IO.
      const registered = this.db.prepare('SELECT dev, ino FROM projects WHERE cwd=?').get(cwd) as { dev: string; ino: string } | undefined;
      if (!registered || !same(registered, identity(info))) fail();
      if (create) { try { await mkdir(fdPath(project, inboxName), { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
      root = await open(fdPath(project, inboxName), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const details = await root.stat({ bigint: true });
      if (Number(details.mode & 0o777n) !== 0o700 || details.uid !== BigInt(process.getuid!())) fail();
      let saved = this.db.prepare('SELECT * FROM attachment_roots WHERE cwd=?').get(cwd) as Root | undefined;
      if (!saved && create) {
        // A pre-existing directory is adoptable only when empty. Never read,
        // overwrite or clean up an unrelated user's staging directory.
        const { readdir } = await import('node:fs/promises');
        if ((await readdir(fdPath(root))).length) fail();
        const ignore = await open(fdPath(root, '.gitignore'), 'wx', 0o600);
        try { await ignore.writeFile('*\n'); await ignore.sync(); } finally { await ignore.close(); }
        const value = { cwd, projectDev: String(info.dev), projectIno: String(info.ino), ...identity(details) };
        this.db.prepare('INSERT INTO attachment_roots VALUES (?, ?, ?, ?, ?)').run(cwd, value.projectDev, value.projectIno, value.dev, value.ino);
        saved = value;
      }
      if (!saved || saved.projectDev !== String(info.dev) || saved.projectIno !== String(info.ino) || !same(saved, identity(details))) fail();
      const check = async () => {
        if (await realpath(cwd) !== cwd || !same(identity(await lstat(cwd, { bigint: true })), identity(info)) ||
          !same(identity(await lstat(join(cwd, inboxName), { bigint: true })), identity(details))) fail();
        // Protect the self-ignoring directory even if an external tool changes it.
        const ignore = await open(fdPath(root!, '.gitignore'), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { const s = await ignore.stat(); if (!s.isFile() || s.nlink !== 1 || s.size !== 2 || (await ignore.readFile('utf8')) !== '*\n') fail(); }
        finally { await ignore.close(); }
      };
      await check();
      return { project, root, check, close: async () => { await root!.close(); await project.close(); } };
    } catch (error) { await root?.close(); await project.close(); throw error; }
  }
  private async disk(path: string) {
    const fs = await statfs(path, { bigint: true });
    if (fs.bavail * fs.bsize < BigInt(256 * 1024 * 1024 + limits.fileBytes)) throw new Error('主机可用磁盘空间不足，请释放空间后重试。');
  }
  async upload(raw: Record<string, unknown>, input: Readable, owner: AttachmentOwner): Promise<AttachmentFile> {
    authorized(owner);
    for (const [id, value] of this.attempts) if (this.now() - value.start >= 60000) this.attempts.delete(id);
    if (this.now() - this.attemptWindow.start >= 60000) this.attemptWindow = { start: this.now(), count: 0 };
    const attempts = this.attempts.get(owner.deviceId) ?? { start: this.now(), count: 0 };
    if (attempts.count >= 24 || this.attemptWindow.count >= 60) throw new Error('上传过于频繁，请一分钟后再试。');
    attempts.count++; this.attemptWindow.count++; this.attempts.set(owner.deviceId, attempts);
    if (!attachmentId(owner.draftId)) throw new Error('附件草稿标识无效。');
    const type = attachmentType(raw.name, raw.mime, raw.size), size = raw.size as number;
    if (this.active.size >= 2 || this.active.has(owner.deviceId)) throw new Error('上传正在进行，请稍后再试。');
    this.active.add(owner.deviceId);
    let received = 0, lastChunk = this.now();
    const started = this.now();
    // Bound slow/idle bodies as well as bytes. Revocation stops even an idle upload.
    const abort = () => { if (!owner.authorized() || this.now() - started > 120000 || this.now() - lastChunk > 15000 ||
      this.now() - started > 15000 && received * 1000 / (this.now() - started) < 1024) input.destroy(new Error('上传超时、速度过慢或设备授权已撤销。')); };
    input.on('error', () => {});
    const timer = setInterval(abort, 250); timer.unref();
    let dirs: Awaited<ReturnType<AttachmentStore['directories']>> | undefined, folder: FileHandle | undefined, file: FileHandle | undefined;
    let row: Row | undefined;
    try {
      await this.cleanup();
      await owner.validate(); authorized(owner);
      const counts = this.db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes FROM attachments WHERE state<>'expired'").get() as { count: number; bytes: number };
      const device = this.db.prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM attachments WHERE deviceId=? AND state<>'expired'").get(owner.deviceId) as { bytes: number };
      const batch = this.db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes FROM attachments WHERE cwd=? AND threadId=? AND draftId=? AND deviceId=? AND state<>'expired'")
        .get(owner.cwd, owner.threadId, owner.draftId, owner.deviceId) as { count: number; bytes: number };
      if (batch.count >= limits.count || batch.bytes + size > limits.batchBytes) throw new Error('每批最多 6 个附件、合计 50 MB。');
      if (counts.count >= 256 || counts.bytes + size > 1024 ** 3 || device.bytes + size > 200 * 1024 ** 2) throw new Error('附件存储已达上限，请等待过期清理。');
      // Reserve resource budget synchronously before filesystem awaits.
      row = { id: randomUUID(), cwd: owner.cwd, threadId: owner.threadId, draftId: owner.draftId, deviceId: owner.deviceId,
        name: raw.name as string, size, ...type, expiresAt: this.now() + limits.readyMs, createdAt: this.now(), state: 'uploading', operationId: null, turnId: null, digest: '', dev: '', ino: '', folderDev: '', folderIno: '' };
      this.db.prepare('INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)')
        .run(row.id, row.cwd, row.threadId, row.draftId, row.deviceId, row.name, size, row.mime, row.kind, row.extension, row.expiresAt, row.createdAt, row.state, '', '', '', '', '');
      dirs = await this.directories(owner.cwd, true); await this.disk(fdPath(dirs.root));
      await mkdir(fdPath(dirs.root, row.id), { mode: 0o700 });
      folder = await open(fdPath(dirs.root, row.id), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const folderInfo = identity(await folder.stat({ bigint: true }));
      this.db.prepare('UPDATE attachments SET folderDev=?, folderIno=? WHERE id=?').run(folderInfo.dev, folderInfo.ino, row.id);
      file = await open(fdPath(folder, 'input.' + row.extension), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      const hash = createHash('sha256');
      for await (const rawChunk of input) {
        authorized(owner); await owner.validate(); await dirs.check();
        if (!same(folderInfo, identity(await lstat(fdPath(dirs.root, row.id), { bigint: true })))) fail();
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        received += chunk.length;
        lastChunk = this.now();
        if (received > size || received > limits.fileBytes) throw new Error('附件超过声明大小或上传限制。');
        hash.update(chunk);
        // FileHandle.write may make a short write; keep stream backpressure.
        for (let at = 0; at < chunk.length;) { const written = await file.write(chunk, at, chunk.length - at); if (!written.bytesWritten) throw new Error('附件写入失败。'); at += written.bytesWritten; }
      }
      if (received !== size || input.destroyed && !input.readableEnded) throw new Error('附件传输中断，请重新选择文件。');
      await sniffAttachment(file, row.extension, size);
      await file.sync(); await file.chmod(0o400);
      await owner.validate(); authorized(owner); await dirs.check();
      if (!same(folderInfo, identity(await lstat(fdPath(dirs.root, row.id), { bigint: true })))) fail();
      const info = await file.stat({ bigint: true });
      this.db.prepare("UPDATE attachments SET state='ready', digest=?, dev=?, ino=? WHERE id=?").run(hash.digest('hex'), String(info.dev), String(info.ino), row.id);
      return this.public(row);
    } catch (error) {
      if (row) {
        this.db.prepare("UPDATE attachments SET state='expired' WHERE id=?").run(row.id);
        // Pinned directory only: never recursively remove a replaced pathname.
        if (folder) await unlink(fdPath(folder, 'input.' + row.extension)).catch(() => {});
        if (dirs) await rmdir(fdPath(dirs.root, row.id)).catch(() => {});
      }
      if (error instanceof Error && !('code' in error)) throw error;
      throw new Error('附件上传失败，请检查主机空间或重新选择文件。');
    } finally { clearInterval(timer); await file?.close(); await folder?.close(); await dirs?.close(); this.active.delete(owner.deviceId); }
  }
  private async checked(row: Row, verifyContent = true) {
    const dirs = await this.directories(row.cwd);
    let folder: FileHandle | undefined, file: FileHandle | undefined;
    try {
      folder = await open(fdPath(dirs.root, row.id), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (!same({ dev: row.folderDev, ino: row.folderIno }, identity(await folder.stat({ bigint: true })))) fail();
      file = await open(fdPath(folder, 'input.' + row.extension), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat({ bigint: true });
      if (!info.isFile() || info.nlink !== 1n || info.size !== BigInt(row.size) || !same(row, identity(info))) fail();
      if (verifyContent) {
        const hash = createHash('sha256');
        for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
        if (hash.digest('hex') !== row.digest) fail();
      }
      await dirs.check();
      if (await realpath(this.path(row)) !== this.path(row) || !same(row, identity(await lstat(this.path(row), { bigint: true })))) fail();
      return this.path(row);
    } finally { await file?.close(); await folder?.close(); await dirs.close(); }
  }
  async prepare(ids: unknown, owner: AttachmentOwner) {
    if (!Array.isArray(ids) || ids.length > limits.count || ids.some(id => !attachmentId(id)) || new Set(ids).size !== ids.length) throw new Error('附件标识无效或重复。');
    const rows: Row[] = [], paths: string[] = [];
    for (const id of ids) {
      const row = this.row(id);
      if (!this.belongs(row, owner) || row.state !== 'ready' || row.expiresAt <= this.now()) throw new Error('附件已失效或不属于当前设备、项目和草稿，请重新选择。');
      paths.push(await this.checked(row)); rows.push(row);
    }
    if (rows.reduce((total, row) => total + row.size, 0) > limits.batchBytes) throw new Error('每批附件合计最多 50 MB。');
    await owner.validate(); authorized(owner);
    return { rows, input: rows.flatMap((row, index): UserInput[] => row.kind === 'image' ? [{ type: 'localImage', path: paths[index]! }] : []), referenceText: this.references(rows) };
  }
  private references(rows: Row[]) {
    const documents = rows.filter(row => row.kind === 'document');
    return documents.length ? '\n\n[Oraculum 附件：请使用当前线程已有主机工具读取以下项目内文件；保留原生权限与审批。]\n' +
      documents.map(row => `${JSON.stringify(row.name)}: ${JSON.stringify(this.path(row))}`).join('\n') : '';
  }
  claim(rows: Row[], operationId: string) {
    for (const row of rows) {
      if (this.db.prepare("UPDATE attachments SET state='held', operationId=? WHERE id=? AND state='ready' AND expiresAt>?").run(operationId, row.id, this.now()).changes !== 1) throw new Error('附件状态已变化，请重新查询。');
    }
  }
  accepted(operationId: string, turnId: string) { this.db.prepare("UPDATE attachments SET state='sent', turnId=?, expiresAt=? WHERE operationId=? AND state='held'").run(turnId, this.now() + limits.sentMs, operationId); }
  rejected(operationId: string) { this.db.prepare("UPDATE attachments SET state='ready', operationId=NULL WHERE operationId=? AND state='held'").run(operationId); }
  async deliveries(cwd: string, threadId: string, turnIds: string[]): Promise<AttachmentDelivery[]> {
    const rows = this.db.prepare('SELECT * FROM attachments WHERE cwd=? AND threadId=? AND turnId IS NOT NULL ORDER BY createdAt, rowid').all(cwd, threadId) as Row[];
    const grouped = new Map<string, AttachmentDelivery>();
    for (const row of rows.filter(row => turnIds.includes(row.turnId!))) {
      let available = row.state === 'sent' && row.expiresAt > this.now();
      if (available) try { await this.checked(row, false); } catch { available = false; }
      const delivery = grouped.get(row.operationId!) ?? { operationId: row.operationId!, turnId: row.turnId!, files: [], referenceText: '' };
      delivery.files.push({ ...this.public(row), available }); grouped.set(row.operationId!, delivery);
    }
    for (const delivery of grouped.values()) delivery.referenceText = this.references(rows.filter(row => row.operationId === delivery.operationId));
    return [...grouped.values()];
  }
  async remove(id: unknown, owner: AttachmentOwner) {
    authorized(owner); await owner.validate(); authorized(owner);
    const row = attachmentId(id) ? this.row(id) : undefined;
    if (!this.belongs(row, owner) || row.state !== 'ready') throw new Error('附件不可移除；发送结果未知的材料会保留。');
    await this.expire(row);
    return { removed: true };
  }
  private async expire(row: Row) {
    // Set the tombstone first. A crash can leak a file, never make an ID reusable.
    this.db.prepare("UPDATE attachments SET state='expired' WHERE id=? AND state IN ('ready','sent','uploading')").run(row.id);
    const dirs = await this.directories(row.cwd);
    let folder: FileHandle | undefined;
    try {
      folder = await open(fdPath(dirs.root, row.id), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (!same({ dev: row.folderDev, ino: row.folderIno }, identity(await folder.stat({ bigint: true })))) fail();
      await dirs.check();
      await unlink(fdPath(folder, 'input.' + row.extension));
      await rmdir(fdPath(dirs.root, row.id));
    } finally { await folder?.close(); await dirs.close(); }
  }
  async cleanup() {
    const expired = this.db.prepare("SELECT * FROM attachments WHERE state IN ('ready','sent','uploading') AND expiresAt<=? LIMIT 256").all(this.now()) as Row[];
    for (const row of expired) { try { await this.expire(row); } catch { /* Fail closed on missing or replaced directories; never follow them. */ } }
  }
}
