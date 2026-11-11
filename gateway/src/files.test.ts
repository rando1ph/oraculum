import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rename, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { GatewayStore } from './store';
import { ProjectRegistry } from './projects';
import { FileService } from './files';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'oraculum-files-')); const state = join(root, 'state'), allowed = join(root, 'projects'), path = join(allowed, 'sample');
  await mkdir(path, { recursive: true, mode: 0o700 }); const store = new GatewayStore(state, { create: true });
  cleanup.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const deviceId = randomUUID(); store.pair({ installationId: store.installationId, deviceId, deviceCredential: randomBytes(32).toString('base64url'), code: store.createPairing().code, label: 'test' });
  const projects = new ProjectRegistry(store, { allowedRoots: [{ id: 'test', path: allowed }] });
  const project = await projects.register('test', 'sample'); let now = Date.now(); const files = new FileService(projects, { now: () => now });
  const owner = { deviceId, projectId: project.id, threadId: 'test-thread', authorized: () => store.getDevice(deviceId)?.revokedAt === null };
  return { root, allowed, path, store, projects, project, files, owner, later: () => { now += 300_001; } };
}
const consume = async (stream: AsyncIterable<unknown>) => { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer)); return Buffer.concat(chunks).toString(); };

describe('Gateway host project and file boundaries', () => {
  it('persists explicit registration and its receipt atomically, then creates a new identity after unregister', async () => {
    const s = await setup(); const operationId = randomUUID();
    const existing = await s.projects.register('test', 'sample', { operation: { operationId, deviceId: s.owner.deviceId } });
    expect(existing.id).toBe(s.project.id); expect(s.store.getOperation(operationId, s.owner.deviceId)).toMatchObject({ projectId: s.project.id, status: 'accepted' });
    await expect(s.projects.register('test', 'sample', { operation: { operationId, deviceId: s.owner.deviceId } })).rejects.toThrow();
    await writeFile(join(s.path, 'report.txt'), 'original'); const grant = await s.files.select({ ...s.owner, path: 'report.txt' });
    s.projects.unregister(s.project.id); const fresh = await s.projects.register('test', 'sample'); expect(fresh.id).not.toBe(s.project.id);
    await expect(s.files.content(grant.fileId, s.owner)).rejects.toThrow(); expect(s.store.getProject(s.project.id)?.unregisteredAt).not.toBeNull();
  });
  it('prevents unregistering and re-registering a workspace to bypass an unknown operation', async () => {
    const s = await setup(); s.store.reserveOperation({ deviceId: s.owner.deviceId, operationId: randomUUID(), projectId: s.project.id, threadId: s.owner.threadId, kind: 'turn.start' });
    expect(() => s.projects.unregister(s.project.id)).toThrow(); expect((await s.projects.register('test', 'sample')).id).toBe(s.project.id);
  });
  it('rejects traversal, encoded separators, hidden and sensitive directories and symlinks', async () => {
    const s = await setup(); await symlink(s.path, join(s.allowed, 'alias'));
    for (const path of ['', '../sample', '/sample', 'sample//child', 'sample/%2e%2e', 'sample\\child', 'sample/.git', 'sample/config', 'alias']) await expect(s.projects.register('test', path)).rejects.toThrow();
    await expect(s.projects.register('missing', 'sample')).rejects.toThrow();
    expect((await s.projects.queryDirectories('test')).entries.map(e => e.name)).toEqual(['sample']);
  });
  it('denies changed project inode and root symlink and requires explicit re-registration', async () => {
    const s = await setup(); await rename(s.path, s.path + '-old'); await mkdir(s.path);
    expect((await s.projects.list())[0]?.available).toBe(false); await expect(s.projects.register('test', 'sample')).rejects.toThrow();
    s.projects.unregister(s.project.id); const fresh = await s.projects.register('test', 'sample'); expect(fresh.id).not.toBe(s.project.id);
    await rename(s.allowed, s.allowed + '-old'); await symlink(s.allowed + '-old', s.allowed);
    await expect(s.projects.validate(fresh.id)).rejects.toThrow();
  });
  it('enforces nested registration as a separate boundary, bound cursors and safe file types', async () => {
    const s = await setup(); await mkdir(join(s.path, 'nested')); await writeFile(join(s.path, 'nested', 'report.txt'), 'nested');
    await writeFile(join(s.path, 'main.ts'), 'export const answer = 42;'); await writeFile(join(s.path, 'report.md'), 'hello');
    await writeFile(join(s.path, 'secrets.txt'), 'secret'); await writeFile(join(s.path, '.env'), 'secret'); await writeFile(join(s.path, 'view.html'), '<script>bad</script>');
    await s.projects.register('test', 'sample/nested');
    const list = await s.files.query(s.project.id, '', 1); expect(list.entries).toHaveLength(1); expect(list.nextCursor).not.toBeNull();
    expect((await s.files.query(s.project.id, '', 1, list.nextCursor!)).entries[0]?.name).toBe('report.md');
    await expect(s.files.query(s.project.id, '', 1, randomUUID())).rejects.toThrow();
    for (const path of ['nested/report.txt', 'secrets.txt', '.env', 'view.html', '../report.md', 'report%2emd']) await expect(s.files.select({ ...s.owner, path })).rejects.toThrow();
    await writeFile(join(s.path, 'new.txt'), 'new'); await expect(s.files.query(s.project.id, '', 1, list.nextCursor!)).rejects.toThrow();
  });
  it('binds grants to device, project, thread, expiry and exact content version', async () => {
    const s = await setup(); await writeFile(join(s.path, 'report.txt'), 'hello world');
    const grant = await s.files.select({ ...s.owner, path: 'report.txt' }); const body = await s.files.content(grant.fileId, s.owner);
    expect(await consume(body.stream)).toBe('hello world'); expect(body.digest).toHaveLength(64);
    await expect(s.files.content(grant.fileId, { ...s.owner, deviceId: randomUUID() })).rejects.toThrow();
    await expect(s.files.content(grant.fileId, { ...s.owner, threadId: 'another-thread' })).rejects.toThrow();
    await expect(s.files.content(grant.fileId, { ...s.owner, projectId: randomUUID() })).rejects.toThrow();
    await writeFile(join(s.path, 'report.txt'), 'HELLO WORLD'); await expect(s.files.content(grant.fileId, s.owner)).rejects.toThrow();
    const newer = await s.files.select({ ...s.owner, path: 'report.txt' }); s.later(); await expect(s.files.content(newer.fileId, s.owner)).rejects.toThrow();
  });
  it('rejects symlink, hardlink, FIFO, binary text and changed ancestor directory', async () => {
    const s = await setup(); await writeFile(join(s.root, 'external.txt'), 'private');
    await symlink(join(s.root, 'external.txt'), join(s.path, 'link.txt')); await link(join(s.root, 'external.txt'), join(s.path, 'hard.txt'));
    execFileSync('mkfifo', [join(s.path, 'pipe.txt')]); await writeFile(join(s.path, 'binary.txt'), Buffer.from([0, 1, 2]));
    for (const path of ['link.txt', 'hard.txt', 'pipe.txt', 'binary.txt']) await expect(s.files.select({ ...s.owner, path })).rejects.toThrow();
    await mkdir(join(s.path, 'outputs')); await writeFile(join(s.path, 'outputs', 'report.txt'), 'initial');
    const grant = await s.files.select({ ...s.owner, path: 'outputs/report.txt' });
    await rename(join(s.path, 'outputs'), join(s.path, 'outputs-old')); await mkdir(join(s.path, 'outputs')); await writeFile(join(s.path, 'outputs', 'report.txt'), 'replacement');
    await expect(s.files.content(grant.fileId, s.owner)).rejects.toThrow();
  });
  it('aborts idle downloads within the authorization check interval after revocation', async () => {
    const s = await setup(); await writeFile(join(s.path, 'report.txt'), 'content'); const grant = await s.files.select({ ...s.owner, path: 'report.txt' });
    const download = await s.files.content(grant.fileId, s.owner);
    const closed = new Promise<void>(resolve => { download.stream.once('error', () => {}); download.stream.once('close', resolve); });
    s.store.revokeDevice(s.owner.deviceId); await closed; expect(download.stream.destroyed).toBe(true);
  });
  it('aborts a stream when the pinned version changes after download preparation', async () => {
    const s = await setup(); await writeFile(join(s.path, 'report.txt'), 'original'); const grant = await s.files.select({ ...s.owner, path: 'report.txt' });
    const download = await s.files.content(grant.fileId, s.owner); await writeFile(join(s.path, 'report.txt'), 'modified');
    await expect(consume(download.stream)).rejects.toThrow();
  });
});
