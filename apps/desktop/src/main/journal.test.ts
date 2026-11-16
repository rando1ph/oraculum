import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOURNAL_FILE, OperationJournal, type JournalEntry, type JournalScope } from './journal';
import { PreferencesStore } from './preferences';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), lstatSync: vi.fn(actual.lstatSync) };
});
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const temporary: string[] = [];
afterEach(() => {
  vi.mocked(fs.fsyncSync).mockImplementation(realFs.fsyncSync);
  vi.mocked(fs.lstatSync).mockImplementation(realFs.lstatSync);
  vi.clearAllMocks();
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const scope: JournalScope = { endpoint: 'https://fixture.invalid/gateway/', installationId: 'installation-1', deviceId: 'desktop-1',
  epoch: 'epoch-1', projectId: 'project-1', threadId: 'thread-1' };
function fixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'oraculum-journal-'));
  temporary.push(directory);
  return { directory, file: join(directory, JOURNAL_FILE), journal: new OperationJournal(directory) };
}
function prepare(journal: OperationJournal, owner = scope, kind = 'turn.start') {
  return journal.prepare(owner, kind, { text: 'sensitive fixture text', localPath: '/fixture/private/local-file' });
}
function settle(journal: OperationJournal, entry: JournalEntry, status: 'accepted' | 'rejected' | 'unknown', owner = scope) {
  return journal.settle({ ...owner, operation: { operationId: entry.operationId, status, delivery: status === 'rejected' ? 'notSent' : 'sent' } });
}
function corrupt(file: string, change: (data: { version: number; entries: Record<string, unknown>[]; sha256: string }) => void) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(data);
  data.sha256 = createHash('sha256').update(JSON.stringify(data.entries)).digest('hex');
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  return fs.readFileSync(file);
}

describe('durable Desktop operation journal', () => {
  it('persists and fsyncs private metadata before issuing the operation ID; never persists intent or endpoint', () => {
    const { directory, file, journal } = fixture();
    const entry = prepare(journal);
    expect(entry.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(entry.state).toBe('prepared');
    expect(entry.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.endpointKey).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(file).mode & 0o777).toBe(0o600);
    expect(fs.fsyncSync).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).entries[0]).toEqual(entry);
    const bytes = fs.readFileSync(file, 'utf8');
    for (const privateValue of ['sensitive fixture text', '/fixture/private/local-file', 'fixture.invalid', 'localPath', 'endpoint":']) expect(bytes).not.toContain(privateValue);
    expect(fs.readdirSync(directory)).toEqual([JOURNAL_FILE]);
  });

  it('recovers crash-before-send and crash-after-send identically as query-only unknown', () => {
    const { directory, journal } = fixture();
    const original = prepare(journal);
    const restarted = new OperationJournal(directory);
    expect(restarted.pending(scope)).toEqual([{ ...original, state: 'unknown', code: 'PROCESS_RESTARTED' }]);
    expect(() => prepare(restarted)).toThrow('JOURNAL_SCOPE_PENDING');
    expect(new OperationJournal(directory).pending(scope)[0].operationId).toBe(original.operationId);
    expect('resend' in restarted).toBe(false);
    expect('reset' in restarted).toBe(false);
    expect('remove' in restarted).toBe(false);
  });

  it('lost ACK and receipt 404 retain the same unknown ID across restart without sending again', () => {
    const { directory, journal } = fixture();
    const send = vi.fn(() => { throw new Error('fixture connection dropped after delivery'); });
    const entry = prepare(journal);
    try { send(); } catch { journal.markUnknown(entry.operationId, 'CONNECTION_LOST'); }
    const recovered = new OperationJournal(directory);
    recovered.markUnknown(entry.operationId, 'OPERATION_NOT_FOUND');
    expect(send).toHaveBeenCalledTimes(1);
    expect(recovered.pending(scope)).toHaveLength(1);
    expect(recovered.pending(scope)[0]).toMatchObject({ operationId: entry.operationId, state: 'unknown', code: 'OPERATION_NOT_FOUND' });
    expect(() => prepare(recovered)).toThrow('JOURNAL_SCOPE_PENDING');
    expect(settle(recovered, entry, 'accepted').state).toBe('accepted');
    expect(recovered.pending(scope)).toEqual([]);
  });

  it('hashes semantically identical object-key order deterministically but issues a new ID only for a new settled intent', () => {
    const { journal } = fixture();
    const first = journal.prepare(scope, 'turn.start', { text: 'hello', options: { b: 2, a: 1 } });
    settle(journal, first, 'accepted');
    const next = journal.prepare(scope, 'turn.start', { options: { a: 1, b: 2 }, text: 'hello' });
    expect(next.requestDigest).toBe(first.requestDigest);
    expect(next.operationId).not.toBe(first.operationId);
  });

  it.each(['accepted', 'rejected'] as const)('keeps %s terminal across duplicate and late conflicting receipts', status => {
    const { directory, journal } = fixture();
    const entry = prepare(journal);
    const final = settle(journal, entry, status);
    expect(settle(journal, entry, status)).toEqual(final);
    expect(journal.markUnknown(entry.operationId, 'OPERATION_NOT_FOUND')).toEqual(final);
    expect(() => settle(journal, entry, 'unknown')).toThrow('JOURNAL_TERMINAL_CONFLICT');
    expect(() => settle(journal, entry, status === 'accepted' ? 'rejected' : 'accepted')).toThrow('JOURNAL_TERMINAL_CONFLICT');
    expect(new OperationJournal(directory).list(scope)).toEqual([final]);
  });

  it('projects receipt fields without persisting response text, auth metadata or paths', () => {
    const { journal, file } = fixture();
    const entry = prepare(journal);
    journal.settle({ ...scope, operation: { operationId: entry.operationId, status: 'accepted', nativeThreadId: 'native-thread',
      ...{ text: 'server secret', accessToken: 'fixture-secret-token', path: '/private/file' } } });
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/server secret|fixture-secret-token|\/private\/file/);
  });

  it('isolates identities and rejects mismatched endpoint, installation, device, epoch, project, thread or ID', () => {
    const { journal } = fixture();
    const entry = prepare(journal);
    const variants: JournalScope[] = [{ ...scope, endpoint: 'https://other.invalid/' }, { ...scope, installationId: 'installation-2' },
      { ...scope, deviceId: 'desktop-2' }, { ...scope, epoch: 'epoch-2' }, { ...scope, projectId: 'project-2' }, { ...scope, threadId: 'thread-2' }];
    for (const owner of variants) expect(() => settle(journal, entry, 'accepted', owner)).toThrow('JOURNAL_SCOPE_MISMATCH');
    for (const owner of variants.slice(0, 3)) {
      expect(journal.list(owner)).toEqual([]);
      expect(prepare(journal, owner).state).toBe('prepared');
    }
    expect(() => journal.settle({ ...scope, operation: { operationId: '00000000-0000-4000-8000-000000000000', status: 'accepted' } })).toThrow('JOURNAL_OPERATION_MISSING');
    expect(() => prepare(journal, { ...scope, epoch: 'epoch-2' })).toThrow('JOURNAL_SCOPE_PENDING');
    expect(journal.pending(scope)[0].operationId).toBe(entry.operationId);
  });

  it('blocks overlapping scopes while allowing independent threads and explicit nonrepeated stop/interaction', () => {
    const { journal } = fixture();
    prepare(journal);
    expect(journal.blocking(scope, scope.projectId, scope.threadId)).toHaveLength(1);
    expect(journal.blocking(scope, scope.projectId)).toHaveLength(1);
    expect(journal.blocking(scope, scope.projectId, 'other-thread')).toHaveLength(0);
    expect(() => prepare(journal, { ...scope, threadId: undefined }, 'thread.create')).toThrow('JOURNAL_SCOPE_PENDING');
    expect(prepare(journal, { ...scope, threadId: 'other-thread' }).state).toBe('prepared');
    expect(prepare(journal, scope, 'turn.interrupt').state).toBe('prepared');
    expect(prepare(journal, scope, 'interaction.respond').state).toBe('prepared');
    expect(() => prepare(journal, scope, 'turn.interrupt')).toThrow('JOURNAL_SCOPE_PENDING');
    expect(() => prepare(journal, scope, 'interaction.respond')).toThrow('JOURNAL_SCOPE_PENDING');
  });

  it('project-level and identity-level pending operations block their descendants', () => {
    const { journal } = fixture();
    prepare(journal, { ...scope, threadId: undefined }, 'thread.create');
    expect(() => prepare(journal)).toThrow('JOURNAL_SCOPE_PENDING');
    const other = { ...scope, projectId: 'other-project' };
    expect(prepare(journal, other).state).toBe('prepared');
    const second = fixture().journal;
    prepare(second, { ...scope, threadId: undefined, projectId: undefined }, 'project.register');
    expect(() => prepare(second, other)).toThrow('JOURNAL_SCOPE_PENDING');
  });

  it('returns defensive copies and appearance reset cannot clear pending operations', () => {
    const { directory, journal } = fixture();
    const entry = prepare(journal);
    entry.state = 'accepted';
    const visible = journal.list(scope);
    visible[0].state = 'rejected';
    visible.splice(0);
    new PreferencesStore(directory).reset();
    expect(journal.pending(scope)).toHaveLength(1);
    expect(() => prepare(journal)).toThrow('JOURNAL_SCOPE_PENDING');
  });

  it.each(['syntax', 'checksum', 'duplicate', 'extra', 'missing-receipt', 'unsafe-code', 'bad-scope'] as const)('fails closed on %s corruption and preserves original bytes', scenario => {
    const { directory, file, journal } = fixture();
    prepare(journal);
    if (scenario === 'syntax') fs.writeFileSync(file, '{broken');
    else if (scenario === 'checksum') fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('prepared', 'unknown'));
    else corrupt(file, data => {
      if (scenario === 'duplicate') data.entries.push(data.entries[0]);
      if (scenario === 'extra') data.entries[0].body = 'should never be persisted';
      if (scenario === 'missing-receipt') data.entries[0].state = 'accepted';
      if (scenario === 'unsafe-code') data.entries[0].code = '/private/path';
      if (scenario === 'bad-scope') data.entries[0].projectId = '/private/path';
    });
    const before = fs.readFileSync(file);
    expect(() => new OperationJournal(directory)).toThrow('JOURNAL_CORRUPT');
    expect(fs.readFileSync(file)).toEqual(before);
    expect(() => journal.pending(scope)).toThrow('JOURNAL_UNAVAILABLE');
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it.each(['symlink', 'dangling', 'hardlink', 'public', 'executable'] as const)('refuses %s journal files without replacing them', scenario => {
    const { directory, file } = fixture();
    const target = join(directory, 'preserved');
    if (scenario !== 'dangling') fs.writeFileSync(target, 'preserve', { mode: 0o600 });
    if (scenario === 'symlink' || scenario === 'dangling') fs.symlinkSync(target, file);
    if (scenario === 'hardlink') fs.linkSync(target, file);
    if (scenario === 'public' || scenario === 'executable') fs.writeFileSync(file, 'preserve', { mode: scenario === 'public' ? 0o644 : 0o700 });
    const inode = fs.lstatSync(file).ino;
    expect(() => new OperationJournal(directory)).toThrow('JOURNAL_UNSAFE');
    expect(fs.lstatSync(file).ino).toBe(inode);
    if (scenario !== 'dangling') expect(fs.readFileSync(target, 'utf8')).toBe('preserve');
  });

  it('rejects a symlink in the directory ancestor chain and a nonprivate parent', () => {
    const { directory } = fixture();
    const child = join(directory, 'child');
    fs.mkdirSync(child, { mode: 0o700 });
    const link = join(directory, 'link');
    fs.symlinkSync(child, link);
    fs.mkdirSync(join(child, 'nested'), { mode: 0o700 });
    expect(() => new OperationJournal(join(link, 'nested'))).toThrow('JOURNAL_UNSAFE');
    fs.chmodSync(child, 0o755);
    expect(() => new OperationJournal(child)).toThrow('JOURNAL_UNSAFE');
  });

  it('rejects foreign ownership without modifying the private fixture', () => {
    const { directory, file, journal } = fixture();
    prepare(journal);
    const before = fs.readFileSync(file);
    vi.mocked(fs.lstatSync).mockImplementation(((path: fs.PathLike, options?: unknown) => {
      const stat = realFs.lstatSync(path, options as undefined);
      return String(path).endsWith('/' + JOURNAL_FILE) ? new Proxy(stat, { get(target, property) { return property === 'uid' ? process.getuid!() + 1 : Reflect.get(target, property); } }) : stat;
    }) as typeof fs.lstatSync);
    expect(() => new OperationJournal(directory)).toThrow('JOURNAL_UNSAFE');
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it('poisons the instance after file disappearance or directory permissions change', () => {
    const { directory, file, journal } = fixture();
    prepare(journal);
    const before = fs.readFileSync(file);
    fs.unlinkSync(file);
    expect(() => prepare(journal)).toThrow('JOURNAL_UNAVAILABLE');
    fs.writeFileSync(file, before, { mode: 0o600 });
    expect(() => prepare(journal)).toThrow('JOURNAL_UNAVAILABLE');
    const restored = new OperationJournal(directory);
    fs.chmodSync(directory, 0o755);
    expect(() => restored.markUnknown(restored.list(scope)[0].operationId, 'CONNECTION_LOST')).toThrow('JOURNAL_UNAVAILABLE');
    fs.chmodSync(directory, 0o700);
    expect(() => restored.pending(scope)).toThrow('JOURNAL_UNAVAILABLE');
  });

  it('fails before send on file fsync failure and preserves all earlier pending operations', () => {
    const { directory, file, journal } = fixture();
    const existing = prepare(journal);
    const before = fs.readFileSync(file);
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw new Error('fixture ENOSPC'); });
    expect(() => prepare(journal, { ...scope, threadId: 'other-thread' })).toThrow('JOURNAL_SAVE_FAILED');
    expect(fs.readFileSync(file)).toEqual(before);
    expect(() => journal.pending(scope)).toThrow('JOURNAL_UNAVAILABLE');
    expect(fs.readdirSync(directory).some(name => name.endsWith('.tmp'))).toBe(false);
    expect(new OperationJournal(directory).pending(scope).map(row => row.operationId)).toEqual([existing.operationId]);
  });

  it('poisons the process on directory fsync failure after rename and restart retains the prepared ID as unknown', () => {
    const { directory, file, journal } = fixture();
    vi.mocked(fs.fsyncSync).mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error('fixture directory fsync failed');
      realFs.fsyncSync(fd);
    });
    expect(() => prepare(journal)).toThrow('JOURNAL_SAVE_FAILED');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')).entries[0];
    expect(saved.state).toBe('prepared');
    expect(() => prepare(journal, { ...scope, threadId: 'other-thread' })).toThrow('JOURNAL_UNAVAILABLE');
    vi.mocked(fs.fsyncSync).mockImplementation(realFs.fsyncSync);
    const restarted = new OperationJournal(directory);
    expect(restarted.pending(scope)[0]).toMatchObject({ operationId: saved.operationId, state: 'unknown' });
    expect(() => prepare(restarted)).toThrow('JOURNAL_SCOPE_PENDING');
  });

  it('fails a terminal receipt persistence safely instead of unlocking another write', () => {
    const { directory, file, journal } = fixture();
    const entry = prepare(journal);
    const before = fs.readFileSync(file);
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw new Error('fixture write failure'); });
    expect(() => settle(journal, entry, 'accepted')).toThrow('JOURNAL_SAVE_FAILED');
    expect(fs.readFileSync(file)).toEqual(before);
    expect(() => prepare(journal)).toThrow('JOURNAL_UNAVAILABLE');
    expect(new OperationJournal(directory).pending(scope)[0].operationId).toBe(entry.operationId);
  });

  it.each(['hardlink', 'replacement', 'public'] as const)('refuses a %s temporary file before replacing prior journal and preserves uncertain files', scenario => {
    const { directory, file, journal } = fixture();
    prepare(journal);
    const before = fs.readFileSync(file);
    let temporaryFile = '';
    const preserved = join(directory, 'preserved');
    vi.mocked(fs.fsyncSync).mockImplementationOnce(fd => {
      realFs.fsyncSync(fd);
      temporaryFile = join(directory, fs.readdirSync(directory).find(name => name.endsWith('.tmp'))!);
      if (scenario === 'hardlink') fs.linkSync(temporaryFile, preserved);
      if (scenario === 'public') fs.chmodSync(temporaryFile, 0o644);
      if (scenario === 'replacement') {
        fs.renameSync(temporaryFile, preserved);
        fs.writeFileSync(temporaryFile, 'do not delete a substituted file', { mode: 0o600 });
      }
    });
    expect(() => prepare(journal, { ...scope, threadId: 'other-thread' })).toThrow('JOURNAL_SAVE_FAILED');
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.existsSync(temporaryFile)).toBe(true);
    if (scenario === 'replacement') expect(fs.readFileSync(temporaryFile, 'utf8')).toBe('do not delete a substituted file');
  });

  it('detects replacement of the loaded journal even when replacement bytes match', () => {
    const { directory, file, journal } = fixture();
    prepare(journal);
    const replacement = join(directory, 'replacement');
    fs.writeFileSync(replacement, fs.readFileSync(file), { mode: 0o600 });
    fs.renameSync(replacement, file);
    expect(() => prepare(journal, { ...scope, threadId: 'other-thread' })).toThrow('JOURNAL_UNAVAILABLE');
  });

  it('pins writes to the checked directory and cannot replace a file in a substituted parent', () => {
    const { directory, file, journal } = fixture();
    prepare(journal);
    const before = fs.readFileSync(file);
    const moved = directory + '-moved';
    temporary.push(moved);
    vi.mocked(fs.fsyncSync).mockImplementationOnce(fd => {
      realFs.fsyncSync(fd);
      fs.renameSync(directory, moved);
      fs.mkdirSync(directory, { mode: 0o700 });
      fs.writeFileSync(file, 'preserve replacement parent data', { mode: 0o600 });
    });
    expect(() => prepare(journal, { ...scope, threadId: 'other-thread' })).toThrow('JOURNAL_SAVE_FAILED');
    expect(fs.readFileSync(file, 'utf8')).toBe('preserve replacement parent data');
    expect(fs.readFileSync(join(moved, JOURNAL_FILE))).toEqual(before);
  });

  it('durably preserves safe upload metadata and later turn attachment claims across lost ACK and restart', () => {
    const { directory, file, journal } = fixture();
    const metadata = { draftId: '11111111-1111-4111-8111-111111111111', name: 'fixture 文档.txt', mime: 'text/plain', size: 42, digest: 'a'.repeat(64) };
    const upload = journal.prepare(scope, 'attachment.upload', { ...metadata, localPath: '/private/fixture/document.txt' });
    expect(upload.attachment).toEqual(metadata);
    upload.attachment!.name = 'caller changed';
    expect(journal.list(scope)[0].attachment).toEqual(metadata);
    settle(journal, upload, 'accepted');
    const attachmentIds = ['22222222-2222-4222-8222-222222222222'];
    const claim = journal.prepare(scope, 'turn.start', { input: [{ type: 'text', text: 'private message' }], attachmentIds, draftId: metadata.draftId });
    attachmentIds.push('33333333-3333-4333-8333-333333333333');
    claim.attachmentIds!.push('44444444-4444-4444-8444-444444444444');
    const restarted = new OperationJournal(directory);
    expect(restarted.list(scope).find(row => row.kind === 'attachment.upload')!.attachment).toEqual(metadata);
    expect(restarted.pending(scope)[0]).toMatchObject({ operationId: claim.operationId, state: 'unknown', attachmentIds: ['22222222-2222-4222-8222-222222222222'], draftId: metadata.draftId });
    const bytes = fs.readFileSync(file, 'utf8');
    expect(bytes).not.toContain('/private/fixture/document.txt');
    expect(bytes).not.toContain('private message');
  });

  it.each([
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ])('prepares and recovers Gateway-supported %s upload expectations', (extension, mime) => {
    const { directory, file, journal } = fixture();
    const metadata = { draftId: '11111111-1111-4111-8111-111111111111', name: `fixture.${extension}`, mime, size: 42, digest: 'a'.repeat(64) };
    const prepared = journal.prepare(scope, 'attachment.upload', metadata);
    expect(prepared.attachment).toEqual(metadata);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).entries[0].attachment).toEqual(metadata);
    const restarted = new OperationJournal(directory);
    expect(restarted.pending(scope)).toEqual([{ ...prepared, state: 'unknown', code: 'PROCESS_RESTARTED' }]);
    expect(restarted.pending(scope)[0].attachment).toEqual(metadata);
  });

  it.each([
    { name: '/private/path.txt' }, { name: '../path.txt' }, { name: 'sub\\path.txt' }, { name: 'bad\nname.txt' }, { name: 'bad\u202ename.txt' },
    { mime: 'application/x-executable' }, { mime: 'image/gif' }, { mime: 'application/json' }, { mime: 'text/yaml' },
    { size: 0 }, { size: 20 * 1024 * 1024 + 1 }, { size: 1.5 }, { digest: 'not-a-sha256' }, { draftId: 'not-a-uuid' },
  ])('rejects unsafe upload metadata %# before any journal write', patch => {
    const { journal, file } = fixture();
    const metadata = { draftId: '11111111-1111-4111-8111-111111111111', name: 'fixture.txt', mime: 'text/plain', size: 42, digest: 'a'.repeat(64), ...patch };
    expect(() => journal.prepare(scope, 'attachment.upload', metadata)).toThrow('JOURNAL_INVALID_ATTACHMENT');
    expect(fs.existsSync(file)).toBe(false);
  });

  it.each([
    { attachmentIds: [] }, { attachmentIds: ['not-a-uuid'] }, { attachmentIds: ['22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222'] },
    { attachmentIds: Array(7).fill('22222222-2222-4222-8222-222222222222') }, { draftId: 'not-a-uuid' },
  ])('rejects unsafe turn attachment claims %# before persistence', patch => {
    const { journal, file } = fixture();
    expect(() => journal.prepare(scope, 'turn.start', { attachmentIds: ['22222222-2222-4222-8222-222222222222'], draftId: '11111111-1111-4111-8111-111111111111', ...patch })).toThrow('JOURNAL_INVALID_ATTACHMENT');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('rejects corrupted attachment metadata while preserving the original pending journal bytes', () => {
    const { directory, file, journal } = fixture();
    journal.prepare(scope, 'attachment.upload', { draftId: '11111111-1111-4111-8111-111111111111', name: 'fixture.txt', mime: 'text/plain', size: 42, digest: 'a'.repeat(64) });
    const original = corrupt(file, data => { (data.entries[0].attachment as Record<string, unknown>).name = '/private/path.txt'; });
    expect(() => new OperationJournal(directory)).toThrow('JOURNAL_CORRUPT');
    expect(fs.readFileSync(file)).toEqual(original);
  });
});
