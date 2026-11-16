import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as files from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileGrant } from '../../../../packages/gateway-protocol/src/index';
import { filePreview, safeFileName, saveDownload, selectLocalUpload, verifyDownload, type FileDialogs } from './file-transfer';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
const realFiles = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const temporary: string[] = [];
afterEach(() => {
  vi.mocked(files.open).mockImplementation(realFiles.open);
  vi.restoreAllMocks();
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function directory(): string {
  const result = fs.mkdtempSync(join(tmpdir(), 'oraculum-file-transfer-'));
  temporary.push(result);
  return result;
}
function dialogs(upload?: string, download?: string): FileDialogs {
  return { chooseUpload: vi.fn(async () => upload), chooseDownload: vi.fn(async () => download) };
}
function local(name = 'fixture.txt', bytes: Buffer = Buffer.from('verified upload')) {
  const root = directory(), path = join(root, name);
  fs.writeFileSync(path, bytes, { mode: 0o600 });
  return { root, path, bytes };
}
const ID = '00000000-0000-4000-8000-000000000001';
const PROJECT = '00000000-0000-4000-8000-000000000002';
const NOW = 1_800_000_000_000;
function grant(bytes: Buffer = Buffer.from('verified download'), patch: Partial<FileGrant> = {}): FileGrant {
  return { fileId: ID, projectId: PROJECT, threadId: 'thread-1', path: 'docs/fixture.txt', name: 'fixture.txt',
    mime: 'text/plain', size: bytes.length, expiresAt: NOW + 60_000, ...patch };
}
function response(bytes: Buffer, selected = grant(bytes)) {
  return { status: 200, bytes, headers: { 'content-length': String(bytes.length), 'content-type': selected.mime,
    'content-digest': `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(selected.name)}` } };
}

describe('Desktop local upload boundary', () => {
  it.each(['fixture.txt', '报告.md', 'two words.csv', 'image.JPG'])('accepts canonical names: %s', name => {
    expect(safeFileName(name)).toBe(true);
  });
  it.each(['', '.', '..', '.hidden.txt', ' x.txt', 'x.txt ', 'a/b.txt', 'a\\b.txt', 'a:b.txt', 'a%b.txt',
    'e\u0301.txt', 'a\u0000.txt', 'a\u007f.txt', 'a\u202e.txt', 'a'.repeat(181)])('rejects unsafe or ambiguous names: %s', name => {
    expect(safeFileName(name)).toBe(false);
  });
  it('cancellation does not open a local file', async () => {
    const before = vi.mocked(files.open).mock.calls.length;
    expect(await selectLocalUpload(dialogs(), 1024)).toBeUndefined();
    expect(vi.mocked(files.open).mock.calls.length).toBe(before);
  });
  it.each([
    ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['pdf', 'application/pdf'],
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['csv', 'text/csv'], ['txt', 'text/plain'], ['md', 'text/markdown'],
  ])('returns the Gateway upload MIME and digest for .%s', async (extension, mime) => {
    const fixture = local(`fixture.${extension}`);
    const result = await selectLocalUpload(dialogs(fixture.path), 1024);
    expect(result).toEqual({ name: basename(fixture.path), mime, bytes: fixture.bytes,
      digest: createHash('sha256').update(fixture.bytes).digest('hex') });
  });
  it.each(['gif', 'json', 'log', 'yaml', 'yml', 'svg', 'html', 'exe'])('rejects unsupported upload .%s before opening', async extension => {
    const fixture = local(`fixture.${extension}`);
    const before = vi.mocked(files.open).mock.calls.length;
    await expect(selectLocalUpload(dialogs(fixture.path), 1024)).rejects.toThrow();
    expect(vi.mocked(files.open).mock.calls.length).toBe(before);
  });
  it('rejects empty and oversized files before reading their bytes', async () => {
    const empty = local('empty.txt', Buffer.alloc(0));
    const oversized = local('large.txt', Buffer.alloc(33));
    await expect(selectLocalUpload(dialogs(empty.path), 32)).rejects.toThrow();
    await expect(selectLocalUpload(dialogs(oversized.path), 32)).rejects.toThrow();
  });
  it('never lets invalid or excessive advertised limits bypass the 20 MiB cap', async () => {
    const fixture = local();
    for (const limit of [0, -1, NaN, Infinity, 0.5]) await expect(selectLocalUpload(dialogs(fixture.path), limit)).rejects.toThrow();
    fs.truncateSync(fixture.path, 20 * 1024 * 1024 + 1);
    await expect(selectLocalUpload(dialogs(fixture.path), 100 * 1024 * 1024)).rejects.toThrow();
  });
  it('refuses symlinks and hardlinks while preserving original bytes', async () => {
    const fixture = local();
    const symlink = join(fixture.root, 'symlink.txt'), hardlink = join(fixture.root, 'hardlink.txt');
    fs.symlinkSync(fixture.path, symlink);
    await expect(selectLocalUpload(dialogs(symlink), 1024)).rejects.toThrow();
    fs.linkSync(fixture.path, hardlink);
    await expect(selectLocalUpload(dialogs(hardlink), 1024)).rejects.toThrow();
    expect(fs.readFileSync(fixture.path)).toEqual(fixture.bytes);
  });
  it('bounds the read itself when the selected file grows after its size check', async () => {
    const fixture = local('growing.txt', Buffer.alloc(32, 65));
    let copied = 0, grew = false;
    vi.mocked(files.open).mockImplementation(async (...args) => {
      const handle = await realFiles.open(...args);
      if (String(args[0]) === fixture.path) {
        vi.spyOn(handle, 'readFile').mockRejectedValue(new Error('UNBOUNDED_READ_FORBIDDEN'));
        const read = handle.read.bind(handle);
        vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
          if (!grew) { grew = true; fs.appendFileSync(fixture.path, Buffer.alloc(1024 * 1024, 66)); }
          const result = await read(...readArgs);
          copied += result.bytesRead;
          return result;
        });
      }
      return handle;
    });
    await expect(selectLocalUpload(dialogs(fixture.path), 64)).rejects.toThrow();
    expect(grew).toBe(true);
    expect(copied).toBeLessThanOrEqual(65);
  });
  it('rejects a pathname replacement while reading the original open inode', async () => {
    const fixture = local();
    let replaced = false;
    vi.mocked(files.open).mockImplementation(async (...args) => {
      const handle = await realFiles.open(...args);
      if (String(args[0]) === fixture.path) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
          const result = await read(...readArgs);
          if (!replaced) {
            replaced = true;
            fs.renameSync(fixture.path, join(fixture.root, 'original.txt'));
            fs.writeFileSync(fixture.path, 'replacement');
          }
          return result;
        });
      }
      return handle;
    });
    await expect(selectLocalUpload(dialogs(fixture.path), 1024)).rejects.toThrow();
    expect(replaced).toBe(true);
    expect(fs.readFileSync(fixture.path, 'utf8')).toBe('replacement');
    expect(fs.readFileSync(join(fixture.root, 'original.txt'))).toEqual(fixture.bytes);
  });
});

describe('Desktop authorized download integrity', () => {
  it('returns only exact bytes authorized by the grant and response headers', () => {
    const bytes = Buffer.from('verified download'), selected = grant(bytes);
    expect(verifyDownload(selected, response(bytes, selected), NOW)).toEqual(bytes);
  });
  it.each([
    { fileId: 'not-a-uuid' }, { projectId: 'not-a-uuid' }, { expiresAt: NOW }, { size: -1 }, { size: 64 * 1024 * 1024 + 1 },
    { path: '../fixture.txt' }, { path: '/fixture.txt' }, { path: 'docs/other.txt' }, { name: '.fixture.txt', path: 'docs/.fixture.txt' },
    { mime: 'text/html' }, { mime: 'application/octet-stream' }, { mime: 'image/png' },
  ])('rejects malformed/expired/rebound grants %#', patch => {
    const bytes = Buffer.from('verified download'), selected = grant(bytes, patch);
    expect(() => verifyDownload(selected, response(bytes, selected), NOW)).toThrow();
  });
  it('requires source files to use canonical inert text MIME', () => {
    const bytes = Buffer.from('{"value":1}');
    for (const extension of ['json', 'ts', 'tsx', 'py', 'yaml', 'log']) {
      const selected = grant(bytes, { path: `source/file.${extension}`, name: `file.${extension}`, mime: 'text/plain' });
      expect(verifyDownload(selected, response(bytes, selected), NOW)).toEqual(bytes);
    }
    const unsafe = grant(bytes, { path: 'file.json', name: 'file.json', mime: 'application/json' });
    expect(() => verifyDownload(unsafe, response(bytes, unsafe), NOW)).toThrow();
  });
  it.each(['content-length', 'content-type', 'content-digest', 'content-disposition'] as const)('rejects missing or altered %s', key => {
    const bytes = Buffer.from('verified download'), selected = grant(bytes);
    const missing = response(bytes, selected);
    delete (missing.headers as Record<string, string>)[key];
    expect(() => verifyDownload(selected, missing, NOW)).toThrow();
    const altered = response(bytes, selected);
    altered.headers[key] += 'changed';
    expect(() => verifyDownload(selected, altered, NOW)).toThrow();
  });
  it('rejects truncated/overlong/replaced payloads and non-200 status', () => {
    const bytes = Buffer.from('verified download'), selected = grant(bytes), valid = response(bytes, selected);
    for (const changed of [bytes.subarray(1), Buffer.concat([bytes, Buffer.from('x')]), Buffer.alloc(bytes.length)]) {
      expect(() => verifyDownload(selected, { ...valid, bytes: changed }, NOW)).toThrow();
    }
    for (const status of [201, 206, 302, 401]) expect(() => verifyDownload(selected, { ...valid, status }, NOW)).toThrow();
  });
  it('limits text previews and keeps Office/PDF documents as unsupported previews', () => {
    const text = Buffer.alloc(256 * 1024 + 1, 65), selected = grant(text);
    const preview = filePreview(selected, text);
    expect(preview.limited).toBe(true);
    expect(Buffer.byteLength(preview.text!)).toBeLessThanOrEqual(256 * 1024);
    for (const [extension, mime] of [['pdf', 'application/pdf'], ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']]) {
      expect(filePreview(grant(Buffer.from('document'), { path: `a.${extension}`, name: `a.${extension}`, mime }), Buffer.from('document')))
        .toEqual({ name: `a.${extension}`, mime, limited: true });
    }
  });
  it('rejects invalid text encoding and unverified preview byte counts', () => {
    const invalidUtf8 = Buffer.from([0xc3, 0x28]);
    expect(() => filePreview(grant(invalidUtf8), invalidUtf8)).toThrow();
    const bytes = Buffer.from('complete');
    expect(() => filePreview(grant(bytes), bytes.subarray(1))).toThrow();
  });
});

describe('Desktop explicit local download destination', () => {
  it('writes exact bytes privately only after the native save choice', async () => {
    const root = directory(), destination = join(root, 'chosen.txt'), bytes = Buffer.from('saved bytes');
    const chooser = dialogs(undefined, destination);
    expect(await saveDownload(chooser, grant(bytes), bytes)).toBe(true);
    expect(chooser.chooseDownload).toHaveBeenCalledWith('fixture.txt');
    expect(fs.readFileSync(destination)).toEqual(bytes);
    expect(fs.lstatSync(destination).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(root)).toEqual(['chosen.txt']);
  });
  it('cancelled save creates no file', async () => {
    const before = vi.mocked(files.open).mock.calls.length;
    const bytes = Buffer.from('data');
    expect(await saveDownload(dialogs(), grant(bytes), bytes)).toBe(false);
    expect(vi.mocked(files.open).mock.calls.length).toBe(before);
  });
  it('never overwrites an existing destination or follows its symlink', async () => {
    const fixture = local('existing.txt', Buffer.from('original'));
    const bytes = Buffer.from('new');
    await expect(saveDownload(dialogs(undefined, fixture.path), grant(bytes), bytes)).rejects.toThrow();
    const symlink = join(fixture.root, 'link.txt'); fs.symlinkSync(fixture.path, symlink);
    await expect(saveDownload(dialogs(undefined, symlink), grant(bytes), bytes)).rejects.toThrow();
    expect(fs.readFileSync(fixture.path, 'utf8')).toBe('original');
    expect(fs.lstatSync(symlink).isSymbolicLink()).toBe(true);
  });
  it('refuses a symlinked destination ancestor', async () => {
    const root = directory(), outside = directory(), alias = join(root, 'alias');
    fs.symlinkSync(outside, alias);
    const bytes = Buffer.from('new');
    await expect(saveDownload(dialogs(undefined, join(alias, 'result.txt')), grant(bytes), bytes)).rejects.toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
  });
  it('removes only its own partial destination after a write failure', async () => {
    const root = directory(), destination = join(root, 'result.txt');
    let failedWrite = false;
    vi.mocked(files.open).mockImplementation(async (...args) => {
      const handle = await realFiles.open(...args);
      if (typeof args[1] === 'number' && (args[1] & fs.constants.O_CREAT)) {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementation(async () => {
          await write(Buffer.from('partial')); failedWrite = true; throw new Error('ENOSPC_FIXTURE');
        });
      }
      return handle;
    });
    const bytes = Buffer.from('new');
    await expect(saveDownload(dialogs(undefined, destination), grant(bytes), bytes)).rejects.toThrow();
    expect(failedWrite).toBe(true);
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it('preserves a replacement pathname during failure cleanup', async () => {
    const root = directory(), destination = join(root, 'result.txt');
    let replaced = false;
    vi.mocked(files.open).mockImplementation(async (...args) => {
      const handle = await realFiles.open(...args);
      if (typeof args[1] === 'number' && (args[1] & fs.constants.O_CREAT)) {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementation(async () => {
          await write(Buffer.from('partial'));
          fs.unlinkSync(String(args[0])); fs.writeFileSync(String(args[0]), 'foreign replacement');
          replaced = true; throw new Error('ENOSPC_FIXTURE');
        });
      }
      return handle;
    });
    const bytes = Buffer.from('new');
    await expect(saveDownload(dialogs(undefined, destination), grant(bytes), bytes)).rejects.toThrow();
    expect(replaced).toBe(true);
    expect(fs.readFileSync(destination, 'utf8')).toBe('foreign replacement');
  });
  it('verifies saved bytes by readback before reporting success', async () => {
    const root = directory(), destination = join(root, 'result.txt'), bytes = Buffer.from('intended bytes');
    let corrupted = false;
    vi.mocked(files.open).mockImplementation(async (...args) => {
      const handle = await realFiles.open(...args);
      if (typeof args[1] === 'number' && (args[1] & fs.constants.O_CREAT)) {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementation(async () => {
          await write(Buffer.alloc(bytes.length, 65)); corrupted = true;
        });
      }
      return handle;
    });
    await expect(saveDownload(dialogs(undefined, destination), grant(bytes), bytes)).rejects.toThrow();
    expect(corrupted).toBe(true);
    expect(fs.existsSync(destination)).toBe(false);
  });
});
