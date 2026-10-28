import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile, rename, symlink, link, chmod, writeFile, stat, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { TrustStore } from './trust-store';
import { ReceiptStore } from './receipts';
import { ProjectDirectories } from './projects';
import { BridgeService } from './service';
import { NativeRpcError } from './codex';
import { createServer } from './server';
import { AttachmentStore, inboxName } from './attachments';
import { attachmentLimits, type AttachmentFile } from '../../packages/shared/attachments';
import type { Snapshot, Thread } from '../../packages/shared/protocol';
import { officeFixture } from '../../scripts/fixtures/attachments';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), 'oraculum-input-')); cleanups.push(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'Projects'), cwd = join(root, 'local'), other = join(root, 'other');
  await mkdir(cwd, { recursive: true }); await mkdir(other);
  const trust = new TrustStore(join(temp, 'state')); cleanups.push(() => trust.close());
  const projects = new ProjectDirectories(root, cwd, trust.db); await projects.register(cwd); await projects.register(other);
  const receipts = new ReceiptStore(trust.db);
  let now = Date.now(); const attachments = new AttachmentStore(trust.db, () => now);
  const thread = { id: 'owned', cwd, name: 'test', status: { type: 'idle' }, turns: [] } as unknown as Thread;
  const settings = { approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false }, approvalsReviewer: 'user', model: 'fixture', reasoningEffort: 'low' };
  const send = vi.fn(async (params: any) => {
    const documents = params.input.filter((input: any) => input.type === 'text').map((input: any) => input.text).join('');
    const image = params.input.find((input: any) => input.type === 'localImage');
    if (image) expect(await readFile(image.path)).toEqual(png);
    if (documents.includes('input.txt')) { const path = JSON.parse(documents.split(': ').at(-1)!); expect(await readFile(path, 'utf8')).toBe('合成文档'); }
    const turn = { id: 'native-' + randomUUID(), status: 'completed' as const, itemsView: 'full' as const, startedAt: null, completedAt: null, durationMs: null,
      items: [{ id: 'user-' + randomUUID(), clientId: null, type: 'userMessage' as const, content: params.input }], error: null };
    thread.turns.push(turn); return { turn };
  });
  const bus = new EventEmitter();
  const calls: { method: string; params: any }[] = [];
  const codex = { on: bus.on.bind(bus), send: vi.fn(), request: async <T>(method: string, params: any): Promise<T> => {
    calls.push({ method, params });
    if (method === 'turn/start') return await send(params) as T;
    if (method === 'thread/start' || method === 'thread/resume') return { thread, ...settings } as T;
    if (method === 'thread/read') return { thread } as T;
    if (method === 'thread/turns/list') return { data: thread.turns, nextCursor: null } as T;
    if (method === 'thread/items/list') return { data: [], nextCursor: null } as T;
    throw new Error('Unexpected test method ' + method);
  } };
  const service = new BridgeService(codex, cwd, receipts, projects, undefined, attachments);
  await service.dispatch('thread/start', { cwd });
  const app = await createServer(service, 17903, '/missing', { trust, remoteOrigin: 'https://attachments.example', remoteBasePath: '/console/' });
  await app.ready(); cleanups.push(() => app.close());
  const origin = 'https://attachments.example', scope = origin + '/console/';
  const first = trust.pair(trust.createPairing().code, 'first', scope), second = trust.pair(trust.createPairing().code, 'second', scope);
  const headers = { host: 'attachments.example', origin, 'x-forwarded-proto': 'https', cookie: `__Secure-oraculum_session=${first.token}`, 'x-oraculum-upload': '1' };
  const meta = { cwd, threadId: thread.id, draftId: randomUUID(), name: '合成文档.txt', mime: 'text/plain', size: Buffer.byteLength('合成文档') };
  const context = { deviceId: first.device.id, isAuthorized: () => !!trust.authenticate(first.token, scope) };
  const upload = (data: Buffer = Buffer.from('合成文档'), overrides: object = {}, changes: object = {}) => app.inject({ method: 'POST', url: '/console/attachments', payload: data,
    headers: { ...headers, 'content-type': 'application/octet-stream', 'x-oraculum-file': encodeURIComponent(JSON.stringify({ ...meta, ...overrides })), ...changes } });
  const file = async (data?: Buffer, overrides?: object) => { const result = await upload(data, overrides); expect(result.statusCode, result.body).toBe(200); return result.json<AttachmentFile>(); };
  const start = (files: string[], overrides: object = {}, ctx = context) => service.dispatch('turn/start', { ...meta, operationId: randomUUID(), text: '请读取附件', attachmentIds: files, ...overrides }, ctx);
  return { temp, root, cwd, other, trust, projects, receipts, attachments, app, first, second, headers, meta, context, upload, file, start, send, calls, service, thread,
    advance: (ms: number) => { now += ms; } };
}

it('streams authenticated images/documents into generated project paths and native localImage/text input; restores verified cards', async () => {
  const f = await fixture();
  const document = await f.file(), image = await f.file(png, { name: '样例.png', mime: 'image/png', size: png.length });
  expect(await readFile(join(f.cwd, inboxName, '.gitignore'), 'utf8')).toBe('*\n');
  expect((await stat(join(f.cwd, inboxName))).mode & 0o777).toBe(0o700);
  const result = await f.start([image.id, document.id], { text: '' }) as any;
  expect(f.send).toHaveBeenCalledTimes(1);
  const input = f.calls.find(call => call.method === 'turn/start')!.params.input;
  expect(input).toEqual([{ type: 'text', text: expect.stringContaining('请查看所附文件。'), text_elements: [] }, { type: 'localImage', path: join(f.cwd, inboxName, image.id, 'input.png') }]);
  expect(input[0].text).toContain(JSON.stringify(join(f.cwd, inboxName, document.id, 'input.txt')));
  const snapshot = await f.service.dispatch('bridge/subscribe', { threadId: f.thread.id }) as Snapshot;
  expect(snapshot.attachments).toEqual([expect.objectContaining({ turnId: result.turn.id, files: [expect.objectContaining({ id: document.id, available: true }), expect.objectContaining({ id: image.id, available: true })] })]);
  await expect(f.start([document.id])).rejects.toThrow('失效');
});

it('requires exact device, project, resumed thread and draft; rejects duplicate IDs and client paths', async () => {
  const f = await fixture(), file = await f.file();
  for (const overrides of [{ cwd: f.other }, { threadId: 'untracked' }, { draftId: randomUUID() }, { path: '/etc/passwd' }, { input: [{ type: 'localImage', path: '/etc/passwd' }] }]) await expect(f.start([file.id], overrides)).rejects.toThrow();
  await expect(f.start([file.id], {}, { deviceId: f.second.device.id, isAuthorized: () => true })).rejects.toThrow('不属于');
  await expect(f.start([file.id, file.id])).rejects.toThrow('重复');
  expect(f.send).not.toHaveBeenCalled();
  expect(f.receipts.list(f.cwd, f.thread.id)).toEqual([]);
});

it('denies anonymous/Host/Origin/CSRF/transport/Base Path tricks without exposing binary or expanding JSON limits', async () => {
  const f = await fixture();
  for (const changes of [{ cookie: '' }, { host: 'evil.example' }, { origin: 'https://evil.example' }, { origin: '' }, { 'x-oraculum-upload': '' }, { 'x-forwarded-proto': 'http' }]) expect((await f.upload(undefined, {}, changes)).statusCode).toBeGreaterThanOrEqual(400);
  for (const url of ['/attachments', '/console/%2e%2e/attachments', '/console/../attachments', '/console//attachments']) expect((await f.app.inject({ method: 'POST', url, headers: f.headers, payload: {} })).statusCode).toBeGreaterThanOrEqual(400);
  const big = await f.app.inject({ method: 'POST', url: '/console/attachments/remove', headers: f.headers, payload: { data: 'x'.repeat(66000) } }); expect(big.statusCode).toBe(413);
  expect((await f.upload(Buffer.alloc(66000, 'x'), { name: 'large.txt', size: 66000 })).statusCode).toBe(200);
  const socket = await f.app.injectWS('/console/ws', { headers: f.headers });
  const closed = new Promise<void>(resolve => socket.on('close', () => resolve())); socket.send('x'.repeat(66000)); await closed;
  f.trust.revoke(f.first.device.id); expect((await f.upload()).statusCode).toBe(401);
});

it('supports local root-path authenticated upload without trusting remote cookies or origins', async () => {
  const f = await fixture(), local = 'http://127.0.0.1:17903';
  const device = f.trust.pair(f.trust.createPairing().code, 'local', local);
  const headers = { host: '127.0.0.1:17903', origin: local, cookie: `oraculum_local=${device.token}`, 'x-oraculum-upload': '1',
    'x-oraculum-file': encodeURIComponent(JSON.stringify(f.meta)), 'content-type': 'application/octet-stream' };
  expect((await f.app.inject({ method: 'POST', url: '/attachments', headers, payload: Buffer.from('合成文档') })).statusCode).toBe(200);
  expect((await f.app.inject({ method: 'POST', url: '/console/attachments', headers, payload: Buffer.from('合成文档') })).statusCode).toBe(404);
});

it('rejects unsafe names, spoofed types, empty/oversized files and mismatched lengths without retaining partial files', async () => {
  const f = await fixture();
  for (const name of ['../escape.txt', '/etc/passwd', 'a\\b.txt', 'a\u202etxt.pdf', '.hidden.txt', 'a%2f.txt', 'a\n.txt', 'script.exe']) expect((await f.upload(undefined, { name })).statusCode).toBe(400);
  for (const data of [{ size: 0 }, { size: attachmentLimits.fileBytes + 1 }, { mime: 'image/png' }, { size: 1 }]) expect((await f.upload(undefined, data)).statusCode).toBe(400);
  for (const [name, mime] of [['fake.png', 'image/png'], ['fake.pdf', 'application/pdf'], ['fake.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']]) expect((await f.upload(undefined, { name, mime })).statusCode).toBe(400);
  expect((await f.upload(Buffer.from([65, 0, 66]), { size: 3 })).statusCode).toBe(400);
  expect(f.trust.db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE state<>'expired'").get()!.count).toBe(0);
});

it('accepts PDF and all three OOXML document families using bounded type checks; rejects wrong Office family', async () => {
  const f = await fixture();
  const pdf = Buffer.from('%PDF-1.7\nSynthetic fixture\n%%EOF\n');
  await f.file(pdf, { name: '样例.pdf', mime: 'application/pdf', size: pdf.length });
  for (const [type, mime] of [['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']] as const) {
    const bytes = officeFixture(type); await f.file(bytes, { name: `样例.${type}`, mime, size: bytes.length });
  }
  const wrong = officeFixture('xlsx');
  expect((await f.upload(wrong, { name: '伪装.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: wrong.length })).statusCode).toBe(400);
});

it('fails closed on stream truncation, idle/slow transfers, disk write errors and directory swaps during upload', async () => {
  const f = await fixture();
  await expect(f.service.uploadAttachment(f.meta, Readable.from([Buffer.from('合')]), f.context)).rejects.toThrow('中断');
  const handle = await open(join(f.temp, 'prototype-probe'), 'wx');
  const write = vi.spyOn(Object.getPrototypeOf(handle), 'write').mockRejectedValueOnce(Object.assign(new Error('ENOSPC at private-host-path'), { code: 'ENOSPC' }));
  try { const result = await f.upload(); expect(result.statusCode).toBe(400); expect(result.body).not.toContain('private-host-path'); }
  finally { write.mockRestore(); await handle.close(); }
  const stream = new PassThrough();
  const uploading = f.service.uploadAttachment(f.meta, stream, f.context);
  await vi.waitFor(() => expect(f.trust.db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE state='uploading'").get()!.count).toBe(1));
  f.advance(16000); await expect(uploading).rejects.toThrow(/超时/);
  const race = new PassThrough(); const racing = f.service.uploadAttachment(f.meta, race, f.context);
  await vi.waitFor(() => expect(f.trust.db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE state='uploading'").get()!.count).toBe(1));
  await rename(join(f.cwd, inboxName), join(f.cwd, 'moved-inbox')); await mkdir(join(f.cwd, inboxName), { mode: 0o700 });
  race.end(Buffer.from('合成文档')); await expect(racing).rejects.toThrow();
  expect(f.trust.db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE state='ready'").get()!.count).toBe(0);
  // A pre-existing inbox with unrelated data is never adopted or overwritten.
  const g = await fixture(); await mkdir(join(g.cwd, inboxName), { mode: 0o700 }); await writeFile(join(g.cwd, inboxName, 'keep.txt'), 'private');
  expect((await g.upload()).statusCode).toBe(400); expect(await readFile(join(g.cwd, inboxName, 'keep.txt'), 'utf8')).toBe('private');
});

it('enforces batch and storage quotas, expiry and authenticated removal; IDs never revive', async () => {
  const f = await fixture(); const files: AttachmentFile[] = [];
  for (let i = 0; i < attachmentLimits.count; i++) files.push(await f.file());
  expect((await f.upload()).statusCode).toBe(400);
  const remove = (id: string, extra = {}) => f.app.inject({ method: 'POST', url: '/console/attachments/remove', headers: f.headers, payload: { ...f.meta, id, ...extra } });
  expect((await remove(files[0]!.id, { draftId: randomUUID() })).statusCode).toBe(400);
  expect((await remove(files[0]!.id)).statusCode).toBe(200);
  expect((await remove(files[0]!.id)).statusCode).toBe(200);
  await expect(f.start([files[0]!.id])).rejects.toThrow('失效');
  f.advance(attachmentLimits.readyMs + 1); await f.attachments.cleanup();
  for (const file of files) await expect(readFile(join(f.cwd, inboxName, file.id, 'input.txt'))).rejects.toThrow();
  expect((await remove(files[1]!.id)).statusCode).toBe(200);
  expect((await remove(files[1]!.id, { draftId: randomUUID() })).statusCode).toBe(400);
  await expect(f.start([files[1]!.id])).rejects.toThrow('失效');
});

it('pins project/inbox directories and rejects symlink, replacement, hardlink and content changes before native use', async () => {
  const f = await fixture(), file = await f.file();
  const path = join(f.cwd, inboxName, file.id, 'input.txt');
  const alias = join(f.temp, 'hardlink-alias'); await link(path, alias);
  await expect(f.start([file.id])).rejects.toThrow('变化'); await rm(alias);
  await chmod(path, 0o600); await writeFile(path, 'tampered!');
  await expect(f.start([file.id])).rejects.toThrow('变化');
  await rm(path); await symlink('/etc/passwd', path); await expect(f.start([file.id])).rejects.toThrow();
  const oldInbox = join(f.cwd, 'old-inbox'); await rename(join(f.cwd, inboxName), oldInbox); await symlink(f.other, join(f.cwd, inboxName));
  expect((await f.upload()).statusCode).toBe(400); await expect(readFile(join(f.other, '.gitignore'))).rejects.toThrow();
  await rm(join(f.cwd, inboxName)); await rename(oldInbox, join(f.cwd, inboxName));
  await rename(f.cwd, f.cwd + '-old'); await mkdir(f.cwd);
  expect((await f.upload()).statusCode).toBe(400); expect(f.send).not.toHaveBeenCalled();
});

it('aborts in-flight streams on revocation, detects directory races, and never publishes partial IDs', async () => {
  const f = await fixture();
  const stream = new PassThrough();
  const upload = f.service.uploadAttachment(f.meta, stream, f.context);
  await vi.waitFor(() => expect(f.trust.db.prepare('SELECT COUNT(*) AS count FROM attachment_roots').get()!.count).toBe(1));
  stream.write(Buffer.from('合'));
  f.trust.revoke(f.first.device.id);
  await expect(upload).rejects.toThrow(/撤销/);
  expect(f.trust.db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE state='ready'").get()!.count).toBe(0);
});

it('claims attachments atomically with durable unknown receipts; uncertainty survives restart and cannot remove, expire or resend', async () => {
  const f = await fixture(), file = await f.file();
  f.send.mockRejectedValueOnce(new Error('native result unknown'));
  const operationId = randomUUID();
  await expect(f.start([file.id], { operationId })).rejects.toThrow('unknown');
  expect(f.receipts.list(f.cwd, f.thread.id)[0]).toMatchObject({ operationId, status: 'unknown' });
  f.advance(attachmentLimits.sentMs + 1); const reopened = new AttachmentStore(f.trust.db, () => Date.now() + attachmentLimits.sentMs * 2); await reopened.cleanup();
  expect(await readFile(join(f.cwd, inboxName, file.id, 'input.txt'), 'utf8')).toBe('合成文档');
  expect((await f.app.inject({ method: 'POST', url: '/console/attachments/remove', headers: f.headers, payload: { ...f.meta, id: file.id } })).statusCode).toBe(400);
  await expect(f.start([file.id], { operationId })).rejects.toThrow(); expect(f.send).toHaveBeenCalledTimes(1);
});

it('native explicit rejection releases attachments and concurrent sends dispatch at most once', async () => {
  const f = await fixture(), file = await f.file();
  f.send.mockRejectedValueOnce(new NativeRpcError('rejected', -32602)); await expect(f.start([file.id])).rejects.toThrow('rejected');
  expect(f.receipts.list(f.cwd, f.thread.id)[0]?.status).toBe('rejected');
  const first = f.start([file.id]); const second = f.start([file.id]);
  await expect(second).rejects.toThrow('正在进行'); await first; expect(f.send).toHaveBeenCalledTimes(2);
});

it('rolls back the receipt if an attachment is no longer claimable', async () => {
  const f = await fixture(), file = await f.file();
  const prepared = await f.attachments.prepare([file.id], { ...f.meta, ...f.context, deviceId: f.first.device.id, authorized: () => true, validate: async () => {} });
  f.advance(attachmentLimits.readyMs + 1);
  expect(() => f.receipts.reserve(randomUUID(), f.cwd, f.thread.id, f.first.device.id, () => f.attachments.claim(prepared.rows, randomUUID()))).toThrow();
  expect(f.receipts.list(f.cwd, f.thread.id)).toEqual([]);
});

it('reports authenticated send outcomes without letting another device release an uncertain submission', async () => {
  const f = await fixture(), file = await f.file();
  const socket = await f.app.injectWS('/console/ws', { headers: f.headers });
  const request = (id: string, attachmentIds: string[]) => new Promise<any>(resolve => {
    const onMessage = (raw: Buffer) => { const message = JSON.parse(raw.toString()); if (message.id === id) { socket.off('message', onMessage); resolve(message); } };
    socket.on('message', onMessage); socket.send(JSON.stringify({ id, method: 'turn/start', params: { ...f.meta, operationId: id, attachmentIds, text: 'fixture' } }));
  });
  try {
    expect((await request(randomUUID(), [randomUUID()])).error.sendStatus).toBe('notSent');
    f.send.mockRejectedValueOnce(new NativeRpcError('explicit rejection', -32602));
    expect((await request(randomUUID(), [file.id])).error.sendStatus).toBe('rejected');
    const unknownId = randomUUID(); f.send.mockRejectedValueOnce(new Error('uncertain native outcome'));
    expect((await request(unknownId, [file.id])).error.sendStatus).toBe('unknown');
    expect(f.service.sendStatus(unknownId, f.second.device.id)).toBe('unknown');
    f.trust.revoke(f.first.device.id);
    await expect(f.start([file.id])).rejects.toThrow(/授权|撤销/);
    expect(f.send).toHaveBeenCalledTimes(2);
  } finally { socket.close(); }
});

it('bounds draft bytes, retained device/global bytes, attempts and concurrent streams before filesystem writes', async () => {
  const f = await fixture(), file = await f.file();
  const setSize = (size: number) => f.trust.db.prepare('UPDATE attachments SET size=? WHERE id=?').run(size, file.id);
  setSize(attachmentLimits.batchBytes);
  expect((await f.upload()).body).toContain('50 MB');
  setSize(200 * 1024 ** 2);
  expect((await f.upload(undefined, { draftId: randomUUID() })).body).toContain('存储已达上限');
  // Use another device's retained material to exercise the global budget.
  f.trust.db.prepare('UPDATE attachments SET size=?, deviceId=? WHERE id=?').run(1024 ** 3, f.second.device.id, file.id);
  expect((await f.upload(undefined, { draftId: randomUUID() })).body).toContain('存储已达上限');
  setSize(Buffer.byteLength('合成文档'));
  const stream = new PassThrough(); const uploading = f.service.uploadAttachment(f.meta, stream, f.context);
  await vi.waitFor(() => expect(f.trust.db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE state='uploading'").get()!.count).toBe(1));
  expect((await f.upload()).body).toContain('上传正在进行');
  stream.end(Buffer.from('合成文档')); await uploading;
  for (let i = 0; i < 24; i++) await f.upload(undefined, { name: '../bad.txt' });
  expect((await f.upload()).body).toContain('过于频繁');
});

it('expires sent bytes while retaining inert historical metadata', async () => {
  const f = await fixture(), file = await f.file(); await f.start([file.id]);
  f.advance(attachmentLimits.sentMs + 1); await f.attachments.cleanup();
  await expect(readFile(join(f.cwd, inboxName, file.id, 'input.txt'))).rejects.toThrow();
  const snapshot = await f.service.dispatch('bridge/subscribe', { threadId: f.thread.id }) as Snapshot;
  expect(snapshot.attachments?.[0]?.files[0]).toMatchObject({ id: file.id, name: file.name, available: false });
  await expect(f.start([file.id])).rejects.toThrow('失效');
});

it('keeps receipts and material held if persisting a native ACK fails partway through', async () => {
  const f = await fixture(), file = await f.file();
  const accepted = f.attachments.accepted.bind(f.attachments);
  vi.spyOn(f.attachments, 'accepted').mockImplementation((operationId, turnId) => { accepted(operationId, turnId); throw new Error('simulated metadata write failure'); });
  await expect(f.start([file.id])).rejects.toThrow('metadata write failure');
  expect(f.receipts.list(f.cwd, f.thread.id)[0]?.status).toBe('unknown');
  expect(f.trust.db.prepare('SELECT state FROM attachments WHERE id=?').get(file.id)!.state).toBe('held');
  f.advance(attachmentLimits.sentMs + 1); await f.attachments.cleanup();
  expect(await readFile(join(f.cwd, inboxName, file.id, 'input.txt'), 'utf8')).toBe('合成文档');
  await expect(f.start([file.id])).rejects.toThrow(); expect(f.send).toHaveBeenCalledTimes(1);
});
