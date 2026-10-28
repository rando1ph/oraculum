import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, rename, symlink, link, open, unlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TrustStore } from './trust-store';
import { ReceiptStore } from './receipts';
import { ProjectDirectories } from './projects';
import { BridgeService } from './service';
import { createServer } from './server';
import { ArtifactStore, type ArtifactOwner } from './artifacts';
import { AttachmentStore } from './attachments';
import { artifactLimits, type ArtifactFile } from '../../packages/shared/artifacts';
import { attachmentPng, officeFixture } from '../../scripts/fixtures/attachments';
import { artifactPdf } from '../../scripts/fixtures/artifacts';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), 'oraculum-output-')); cleanups.push(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'Projects'), cwd = join(root, 'local'), other = join(root, 'other');
  await mkdir(cwd, { recursive: true }); await mkdir(other);
  const trust = new TrustStore(join(temp, 'state')); cleanups.push(() => trust.close());
  const projects = new ProjectDirectories(root, cwd, trust.db); await projects.register(cwd); await projects.register(other);
  let now = Date.now(); const artifacts = new ArtifactStore(trust.db, () => now);
  const thread = { id: 'owned', cwd, name: 'test', status: { type: 'idle' }, turns: [] };
  const bus = new EventEmitter();
  const codex = { on: bus.on.bind(bus), send: () => {}, request: async <T>(method: string): Promise<T> => {
    if (method === 'thread/start') return { thread, model: 'fixture', reasoningEffort: 'low', approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: [cwd] }, approvalsReviewer: 'user' } as T;
    throw new Error('Unexpected method ' + method);
  } };
  const service = new BridgeService(codex, cwd, new ReceiptStore(trust.db), projects, undefined, new AttachmentStore(trust.db), artifacts);
  await service.dispatch('thread/start', { cwd });
  const app = await createServer(service, 17904, '/missing', { trust, remoteOrigin: 'https://output.example', remoteBasePath: '/console/' });
  await app.ready(); cleanups.push(() => app.close());
  const origin = 'https://output.example', scope = origin + '/console/';
  const first = trust.pair(trust.createPairing().code, 'first', scope), second = trust.pair(trust.createPairing().code, 'second', scope);
  const headers = { host: 'output.example', origin, 'x-forwarded-proto': 'https', cookie: `__Secure-oraculum_session=${first.token}`, 'x-oraculum-artifact': '1' };
  const context = { deviceId: first.device.id, isAuthorized: () => !!trust.authenticate(first.token, scope) };
  const owner: ArtifactOwner = { cwd, threadId: thread.id, deviceId: first.device.id, authorized: context.isAuthorized, validate: async () => { await projects.resolve(cwd); } };
  const payload = { cwd, threadId: thread.id };
  const post = (action: string, data: object = {}, changes: object = {}) => app.inject({ method: 'POST', url: '/console/artifacts/' + action, headers: { ...headers, ...changes }, payload: { ...payload, ...data } });
  const select = async (path = 'result.txt') => { const response = await post('select', { path }); expect(response.statusCode, response.body).toBe(200); return response.json<ArtifactFile>(); };
  await writeFile(join(cwd, 'result.txt'), '合成成果');
  return { temp, root, cwd, other, trust, projects, artifacts, service, app, first, second, headers, context, owner, payload, post, select,
    advance: (ms: number) => { now += ms; } };
}

it('discovers real files; fully downloads PDF/Office/images/UTF-8 and empty text with correct secure headers', async () => {
  const f = await fixture();
  for (const [name, data] of [ ['中文成果.pdf', artifactPdf()], ['deck.pptx', officeFixture('pptx')], ['table.xlsx', officeFixture('xlsx')], ['document.docx', officeFixture('docx')],
    ['figure.png', attachmentPng], ['notes.md', Buffer.from('# 成果\n<script>alert(1)</script>')], ['empty.txt', Buffer.alloc(0)], ['table.csv', Buffer.from('x,y\n1,2')],
    ['large.txt', Buffer.alloc(2 * 1024 ** 2, 'x')] ] as const) {
    await writeFile(join(f.cwd, name), data);
    const file = await f.select(name), response = await f.post('content/' + file.id);
    expect(response.statusCode, response.body).toBe(200); expect(response.rawPayload).toEqual(data);
    expect(response.headers['content-length']).toBe(String(data.length)); expect(response.headers['content-type']).toContain(file.mime);
    expect(response.headers['content-disposition']).toContain('attachment;'); expect(response.headers['content-disposition']).toContain(encodeURIComponent(name));
    expect(response.headers['x-oraculum-sha256']).toBe(createHash('sha256').update(data).digest('hex'));
    expect(response.headers['x-content-type-options']).toBe('nosniff'); expect(response.headers['cache-control']).toBe('no-store, no-transform'); expect(response.headers['content-encoding']).toBe('identity');
    expect(response.headers['accept-ranges']).toBe('none'); expect(file.preview).toBe(name === 'large.txt' || /\.(docx|pptx|xlsx)$/.test(name) ? null : name.endsWith('.png') ? 'image' : name.endsWith('.pdf') ? 'pdf' : name.endsWith('.md') ? 'markdown' : 'text');
  }
  const list = (await f.post('list')).json(); expect(list.entries).toHaveLength(10); expect(JSON.stringify(list)).not.toContain(f.temp);
}, 15000); // Ten real filesystem/HTTP transfers share this one test's I/O budget.

it('requires cookie, exact Origin, CSRF, Host, transport and entry path, preserving JSON/WS limits', async () => {
  const f = await fixture(), file = await f.select();
  for (const action of ['list', 'select', 'content/' + file.id]) for (const changes of [{ cookie: '' }, { origin: '' }, { origin: 'https://evil.example' }, { host: 'evil.example' }, { 'x-oraculum-artifact': '' }, { 'x-forwarded-proto': 'http' }, { 'sec-fetch-site': 'cross-site' }])
    expect((await f.post(action, { path: 'result.txt' }, changes)).statusCode).toBeGreaterThanOrEqual(400);
  for (const path of ['/artifacts/list', '/console/../artifacts/list', '/console/%2e%2e/artifacts/list', '/console//artifacts/list'])
    expect((await f.app.inject({ method: 'POST', url: path, headers: f.headers, payload: f.payload })).statusCode).toBeGreaterThanOrEqual(400);
  expect((await f.post('list', { path: 'x'.repeat(66000) })).statusCode).toBe(413);
  expect((await f.post('content/' + file.id, {}, { range: 'bytes=0-1' })).statusCode).toBe(416);
  expect((await f.app.inject({ method: 'GET', url: '/console/artifacts/content/' + file.id, headers: f.headers })).statusCode).toBe(404);
  const socket = await f.app.injectWS('/console/ws', { headers: f.headers });
  const closed = new Promise<void>(resolve => socket.on('close', () => resolve())); socket.send('x'.repeat(66000)); await closed;
});

it('supports authenticated local root-path with an independent cookie scope', async () => {
  const f = await fixture(), local = 'http://127.0.0.1:17904';
  const paired = f.trust.pair(f.trust.createPairing().code, 'local', local);
  const headers = { host: '127.0.0.1:17904', origin: local, cookie: 'oraculum_local=' + paired.token, 'x-oraculum-artifact': '1' };
  const selected = await f.app.inject({ method: 'POST', url: '/artifacts/select', headers, payload: { ...f.payload, path: 'result.txt' } });
  expect(selected.statusCode).toBe(200);
  expect((await f.app.inject({ method: 'POST', url: '/artifacts/content/' + selected.json().id, headers, payload: {} })).body).toBe('合成成果');
});

it('rejects forged/expired/input IDs, other devices, untracked/cross-project threads and removed projects', async () => {
  const f = await fixture(), file = await f.select();
  for (const id of [randomUUID(), '../result.txt', file.id + '?token=x']) expect((await f.post('content/' + id)).statusCode).toBeGreaterThanOrEqual(400);
  const input = await f.service.uploadAttachment({ ...f.payload, draftId: randomUUID(), name: 'input.txt', size: 5, mime: 'text/plain' }, Readable.from(['input']), f.context);
  expect((await f.post('content/' + input.id)).statusCode).toBe(400);
  expect((await f.post('content/' + file.id, {}, { cookie: '__Secure-oraculum_session=' + f.second.token })).statusCode).toBe(400);
  for (const extra of [{ cwd: f.other }, { threadId: 'not-tracked' }, { cwd: f.root }]) expect((await f.post('select', { path: 'result.txt', ...extra })).statusCode).toBe(400);
  f.advance(artifactLimits.grantMs); expect((await f.post('content/' + file.id)).statusCode).toBe(400);
  const file2 = await f.select(); f.trust.db.prepare('DELETE FROM projects WHERE cwd=?').run(f.cwd);
  expect((await f.post('content/' + file2.id)).statusCode).toBe(400);
});

it.each(['../other/private.txt', '/etc/passwd', 'folder/../../result.txt', 'folder//result.txt', './result.txt', 'folder/%2e%2e/result.txt', 'folder\\result.txt', 'folder/result.txt\u0000', 'foo\u202etxt', 'result.txt/', '.git/HEAD', '.env', '.oraculum-attachments/test/input.txt', 'credentials.txt', 'secrets.md', 'config.txt', 'auth.json', 'settings.md', 'private-key.txt', 'id_rsa.txt', 'node_modules/readme.md'])('refuses unsafe or sensitive path %j without leaking host errors', async path => {
  const f = await fixture(), result = await f.post('select', { path }); expect(result.statusCode).toBe(400);
  expect(result.body).not.toContain(f.temp); expect(result.body).not.toContain('ENOENT');
});

it('hides dotfiles, credentials, upload state, unknown binaries, links and independently registered nested projects', async () => {
  const f = await fixture();
  for (const name of ['.env', 'config.txt', 'my-token.txt', 'run.html', 'icon.svg', 'main.js', 'binary.bin']) await writeFile(join(f.cwd, name), 'private');
  for (const name of ['.git', '.oraculum-attachments', 'secrets', 'node_modules', 'nested']) await mkdir(join(f.cwd, name));
  await f.projects.register(join(f.cwd, 'nested'));
  await symlink(f.other, join(f.cwd, 'outside')); await link(join(f.cwd, 'result.txt'), join(f.cwd, 'hard.txt'));
  expect((await f.post('list')).json().entries).toEqual([]); // original now has nlink=2 too
  expect((await f.post('list', { path: 'nested' })).statusCode).toBe(400);
});

it.each(['symlink', 'hardlink', 'same-size', 'rename', 'parent', 'root', 'ancestor'])('fails closed after selected file or %s is replaced', async attack => {
  const f = await fixture(); await mkdir(join(f.cwd, 'folder')); const path = join(f.cwd, 'folder', 'result.txt'); await writeFile(path, '123456');
  const file = await f.select('folder/result.txt');
  if (attack === 'symlink') { await unlink(path); await symlink(join(f.other, 'result.txt'), path); }
  if (attack === 'hardlink') await link(path, join(f.other, 'alias.txt'));
  if (attack === 'same-size') await writeFile(path, '654321');
  if (attack === 'rename') { await rename(path, path + '.old'); await writeFile(path, '123456'); }
  if (attack === 'parent') { await rename(join(f.cwd, 'folder'), join(f.cwd, 'old')); await mkdir(join(f.cwd, 'folder')); await writeFile(path, 'private'); }
  if (attack === 'root') { await rename(f.cwd, f.cwd + '-old'); await mkdir(f.cwd); }
  if (attack === 'ancestor') { await rename(f.root, f.root + '-old'); await symlink(f.root + '-old', f.root); }
  const response = await f.post('content/' + file.id); expect(response.statusCode).toBe(400); expect(response.body).not.toContain('private');
});

it('rejects MIME spoofing, corrupt Office, script formats and oversized sparse files; bounded paginated discovery', async () => {
  const f = await fixture();
  for (const name of ['spoof.png', 'broken.pdf', 'wrong.pptx', 'nul.txt', 'bad.txt']) {
    await writeFile(join(f.cwd, name), name === 'nul.txt' ? Buffer.from([0]) : name === 'bad.txt' ? Buffer.from([255]) : Buffer.from('<script>bad</script>'));
    expect((await f.post('select', { path: name })).statusCode).toBe(400);
  }
  const large = await open(join(f.cwd, 'huge.txt'), 'w'); await large.truncate(artifactLimits.fileBytes + 1); await large.close();
  expect((await f.post('select', { path: 'huge.txt' })).statusCode).toBe(400);
  await mkdir(join(f.cwd, 'many'));
  for (let i = 0; i < 90; i++) await writeFile(join(f.cwd, 'many', String(i).padStart(3, '0') + '.txt'), 'x');
  const first = (await f.post('list', { path: 'many' })).json(); expect(first.entries).toHaveLength(80);
  const second = (await f.post('list', { path: 'many', cursor: first.cursor })).json(); expect(second.entries).toHaveLength(10); expect(second.cursor).toBeNull();
});

it.each(['revoke', 'abort', 'mutate', 'replace-directory', 'timeout'])('interrupts an active stream on %s and releases its bounded resources', async attack => {
  const f = await fixture(); await writeFile(join(f.cwd, 'large.txt'), Buffer.alloc(2 * 1024 ** 2, 'x'));
  const file = await f.select('large.txt'), controller = new AbortController();
  const { stream } = await f.service.downloadArtifact(file.id, controller.signal, f.context);
  let received = 0;
  await expect((async () => {
    for await (const chunk of stream) {
      received += chunk.length;
      if (received === chunk.length) {
        if (attack === 'revoke') f.trust.revoke(f.first.device.id);
        if (attack === 'abort') controller.abort();
        if (attack === 'mutate') await writeFile(join(f.cwd, 'large.txt'), Buffer.alloc(2 * 1024 ** 2, 'y'));
        if (attack === 'replace-directory') { await rename(f.cwd, f.cwd + '-old'); await mkdir(f.cwd); }
        if (attack === 'timeout') f.advance(180001);
      }
    }
  })()).rejects.toThrow();
  expect(received).toBeLessThan(2 * 1024 ** 2);
  if (attack === 'abort') expect((await f.post('content/' + file.id)).statusCode).toBe(200);
});

it('bounds concurrency and grant resources and frees an unconsumed destroyed stream', async () => {
  const f = await fixture(), file = await f.select();
  const a = await f.service.downloadArtifact(file.id, new AbortController().signal, f.context);
  await expect(f.service.downloadArtifact(file.id, new AbortController().signal, f.context)).rejects.toThrow('正在下载');
  const closed = new Promise<void>(resolve => a.stream.once('close', resolve)); a.stream.destroy(); await closed;
  await new Promise(resolve => setTimeout(resolve, 10));
  expect((await f.post('content/' + file.id)).statusCode).toBe(200);
  for (let n = 0; n < 47; n++) await f.select();
  expect((await f.post('select', { path: 'result.txt' })).statusCode).toBe(400);
});

it('sanitizes filesystem failures before the first streamed byte as well as during transfer', async () => {
  const f = await fixture(), file = await f.select();
  const { stream } = await f.service.downloadArtifact(file.id, new AbortController().signal, f.context);
  await rename(f.cwd, f.cwd + '-old');
  try { for await (const _chunk of stream) { throw new Error('No bytes may be read'); } throw new Error('Must fail'); }
  catch (error) { expect((error as Error).message).toBe('文件不存在、已变化或不允许读取，请刷新后重新选择。'); }
});

it('rejects finite/expired legacy device authorizations independently of an unexpired file grant', async () => {
  const f = await fixture(), file = await f.select();
  f.trust.db.prepare('UPDATE devices SET expires_at=? WHERE id=?').run(Date.now() - 1, f.first.device.id);
  expect((await f.post('content/' + file.id)).statusCode).toBe(401);
  expect((await f.post('list')).statusCode).toBe(401);
});
