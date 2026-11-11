import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rename, symlink, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { GatewayStore } from './store';
import { ProjectRegistry } from './projects';
import { AttachmentStore, inboxName } from './attachments';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'oraculum-uploads-')), allowed = join(root, 'projects'), path = join(allowed, 'sample');
  await mkdir(path, { recursive: true, mode: 0o700 }); const store = new GatewayStore(join(root, 'state'), { create: true });
  cleanup.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const deviceId = randomUUID(); store.pair({ installationId: store.installationId, deviceId, deviceCredential: randomBytes(32).toString('base64url'), code: store.createPairing().code, label: 'test' });
  const projects = new ProjectRegistry(store, { allowedRoots: [{ id: 'test', path: allowed }] }), project = await projects.register('test', 'sample');
  let now = Date.now(); const attachments = new AttachmentStore(store, projects, { now: () => now });
  const owner = { deviceId, projectId: project.id, threadId: 'thread', draftId: randomUUID(), authorized: () => store.getDevice(deviceId)?.revokedAt === null };
  const upload = (name = 'note.txt', contents = 'hello', operationId?: string) => attachments.upload({ name, size: Buffer.byteLength(contents), mime: 'text/plain', operationId }, Readable.from([contents]), owner);
  const operation = () => { const operationId = randomUUID(); store.reserveOperation({ ...owner, operationId, kind: 'turn.start' }); return operationId; };
  return { root, allowed, path, store, projects, attachments, owner, upload, operation, later: () => { now += 40 * 24 * 3600_000; } };
}
describe('Gateway attachments', () => {
  it('uses a private installation inbox and retains upload operation association after a lost ACK', async () => {
    const s = await setup(); const legacy = join(s.path, '.oraculum-attachments'); await mkdir(legacy); await writeFile(join(legacy, 'old.txt'), 'untouched');
    const operationId = s.operation(), file = await s.upload('note.txt', 'hello', operationId);
    expect(file.state).toBe('ready'); expect(file.digest).toHaveLength(64); expect(s.attachments.forUploadOperation(operationId, s.owner.deviceId)?.id).toBe(file.id);
    expect(s.attachments.forUploadOperation(operationId, randomUUID())).toBeUndefined();
    expect(await readFile(join(legacy, 'old.txt'), 'utf8')).toBe('untouched');
    expect(await readFile(join(s.path, inboxName(s.store.installationId, s.owner.projectId), '.gitignore'), 'utf8')).toBe('*\n');
    const prepared = await s.attachments.prepare([file.id], s.owner); expect(prepared.referenceText).toContain(file.name); expect(prepared.input).toEqual([]);
  });
  it('rejects cross-device/project/thread/draft claims and modified upload contents', async () => {
    const s = await setup(), file = await s.upload();
    for (const change of [{ deviceId: randomUUID() }, { projectId: randomUUID() }, { threadId: 'other' }, { draftId: randomUUID() }]) await expect(s.attachments.prepare([file.id], { ...s.owner, ...change })).rejects.toThrow();
    await expect(s.attachments.prepare([file.id, file.id], s.owner)).rejects.toThrow();
    const path = join(s.path, inboxName(s.store.installationId, s.owner.projectId), file.id, 'input.txt'); await chmod(path, 0o600); await writeFile(path, 'other');
    await expect(s.attachments.prepare([file.id], s.owner)).rejects.toThrow();
  });
  it('atomically rolls back an operation reservation and every attachment claim on competition', async () => {
    const s = await setup(), a = await s.upload('a.txt'), b = await s.upload('b.txt'); const prepared = await s.attachments.prepare([a.id, b.id], s.owner);
    await s.attachments.remove(b.id, s.owner); const operationId = randomUUID();
    expect(() => s.store.transaction(() => { s.store.reserveOperation({ ...s.owner, operationId, kind: 'turn.start' }); s.attachments.claim(prepared.rows, operationId); })).toThrow();
    expect(s.store.getOperation(operationId, s.owner.deviceId)).toBeUndefined(); expect(s.attachments.list(s.owner).find(f => f.id === a.id)?.state).toBe('ready');
  });
  it('retains held, unknown and sent native references beyond TTL and across restart', async () => {
    const s = await setup(), a = await s.upload('a.txt'), b = await s.upload('b.txt'), c = await s.upload('c.txt');
    for (const [file, outcome] of [[a, 'held'], [b, 'unknown'], [c, 'sent']] as const) {
      const prepared = await s.attachments.prepare([file.id], s.owner), op = s.operation(); s.attachments.claim(prepared.rows, op);
      if (outcome === 'unknown') s.attachments.unknown(op); if (outcome === 'sent') s.attachments.accepted(op, 'native-turn');
    }
    s.later(); await s.attachments.cleanup();
    for (const file of [a, b, c]) { await expect(s.attachments.remove(file.id, s.owner)).rejects.toThrow(); expect(await readFile(join(s.path, inboxName(s.store.installationId, s.owner.projectId), file.id, 'input.txt'), 'utf8')).toBe('hello'); }
    const restarted = new AttachmentStore(s.store, s.projects); expect(restarted.list(s.owner).find(f => f.id === a.id)?.state).toBe('unknown');
  });
  it('releases only definitively rejected held attachments and expires unused drafts', async () => {
    const s = await setup(), file = await s.upload(), prepared = await s.attachments.prepare([file.id], s.owner), op = s.operation(); s.attachments.claim(prepared.rows, op);
    s.attachments.rejected(op); expect(s.attachments.list(s.owner)[0]?.state).toBe('ready'); s.later(); await s.attachments.cleanup();
    expect(s.attachments.list(s.owner)[0]?.state).toBe('expired'); await expect(readFile(join(s.path, inboxName(s.store.installationId, s.owner.projectId), file.id, 'input.txt'))).rejects.toThrow();
  });
  it('rejects false lengths, empty/oversize files, MIME mismatches and the seventh batch file', async () => {
    const s = await setup();
    for (const metadata of [{ name: 'test.txt', mime: 'text/plain', size: 0 }, { name: 'test.txt', mime: 'text/plain', size: 20 * 1024 * 1024 + 1 }, { name: 'test.pdf', mime: 'image/png', size: 5 }]) await expect(s.attachments.upload(metadata, Readable.from(['hello']), s.owner)).rejects.toThrow();
    await expect(s.attachments.upload({ name: 'test.txt', mime: 'text/plain', size: 4 }, Readable.from(['hello']), s.owner)).rejects.toThrow();
    await expect(s.attachments.upload({ name: 'test.txt', mime: 'text/plain', size: 6 }, Readable.from(['hello']), s.owner)).rejects.toThrow();
    for (let i = 0; i < 6; i++) await s.upload(`${i}.txt`); await expect(s.upload('seventh.txt')).rejects.toThrow();
  });
  it('enforces the 50 MiB batch limit before accepting more bytes', async () => {
    const s = await setup(), chunk = Buffer.alloc(17 * 1024 * 1024, 'x');
    for (let i = 0; i < 2; i++) await s.attachments.upload({ name: `${i}.txt`, mime: 'text/plain', size: chunk.length }, Readable.from([chunk]), s.owner);
    await expect(s.attachments.upload({ name: 'third.txt', mime: 'text/plain', size: chunk.length }, Readable.from([chunk]), s.owner)).rejects.toThrow();
  });
  it('does not adopt nonempty inboxes or follow substituted inbox/folder paths', async () => {
    const s = await setup(), inbox = join(s.path, inboxName(s.store.installationId, s.owner.projectId)); await mkdir(inbox, { mode: 0o700 }); await writeFile(join(inbox, 'existing.txt'), 'untouched');
    await expect(s.upload()).rejects.toThrow(); expect(await readFile(join(inbox, 'existing.txt'), 'utf8')).toBe('untouched');
    await rename(inbox, inbox + '-old'); const file = await s.upload(); const folder = join(inbox, file.id); await rename(folder, folder + '-old'); await symlink(folder + '-old', folder);
    await expect(s.attachments.prepare([file.id], s.owner)).rejects.toThrow(); await expect(s.attachments.remove(file.id, s.owner)).rejects.toThrow();
    expect(await readFile(join(folder + '-old', 'input.txt'), 'utf8')).toBe('hello');
  });
  it('gives a re-registered project a distinct inbox and preserves original native references', async () => {
    const s = await setup(), old = await s.upload(); const originalPath = join(s.path, inboxName(s.store.installationId, s.owner.projectId), old.id, 'input.txt');
    s.projects.unregister(s.owner.projectId); const fresh = await s.projects.register('test', 'sample'); const owner = { ...s.owner, projectId: fresh.id };
    const next = await s.attachments.upload({ name: 'new.txt', mime: 'text/plain', size: 3 }, Readable.from(['new']), owner);
    expect(await readFile(originalPath, 'utf8')).toBe('hello'); expect(await readFile(join(s.path, inboxName(s.store.installationId, fresh.id), next.id, 'input.txt'), 'utf8')).toBe('new');
  });
  it('aborts an idle upload after revocation and never leaves a ready record', async () => {
    const s = await setup(), input = new PassThrough(); const upload = s.attachments.upload({ name: 'note.txt', mime: 'text/plain', size: 5 }, input, s.owner);
    input.write('he'); await new Promise(resolve => setTimeout(resolve, 50)); s.store.revokeDevice(s.owner.deviceId);
    await expect(upload).rejects.toThrow(); expect(s.store.db.prepare("SELECT id FROM attachments WHERE state='ready'").all()).toEqual([]);
  });
});
