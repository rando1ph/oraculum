import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { artifactRequest, readArtifact } from './artifact-client';
import type { ArtifactFile } from '../../../packages/shared/artifacts';

afterEach(() => vi.unstubAllGlobals());
const bytes = Buffer.from('合成成果');
const file: ArtifactFile = { id: '12345678-1234-4234-8234-123456789abc', name: '成果.txt', path: 'results/成果.txt', size: bytes.length, mime: 'text/plain', directory: false, expiresAt: Date.now() + 10000, preview: 'text' };
function setup(body = bytes, changes: Record<string, string> = {}, status = 200) {
  vi.stubGlobal('location', { href: 'https://host.example/console/?theme=default' });
  const headers = { 'Content-Type': file.mime, 'Content-Length': String(bytes.length), 'X-Oraculum-SHA256': createHash('sha256').update(bytes).digest('hex'), ...changes };
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(body, { status, headers })); vi.stubGlobal('fetch', fetch); return fetch;
}
it('streams complete bytes and verifies digest using credentialed POST under the configured Base Path', async () => {
  const fetch = setup(), progress: number[] = [];
  expect(Buffer.from(await (await readArtifact(file, new AbortController().signal, n => progress.push(n))).arrayBuffer())).toEqual(bytes);
  expect(progress.at(-1)).toBe(bytes.length);
  expect(fetch.mock.calls[0]![0].toString()).toBe('https://host.example/console/artifacts/content/' + file.id);
  expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'X-Oraculum-Artifact': '1' } });
});
it.each(['mime', 'size', 'digest', 'truncated', 'oversize', 'revoked'])('rejects %s rather than offering a corrupt or unauthorized download', async kind => {
  setup(kind === 'truncated' ? bytes.subarray(0, -1) : kind === 'oversize' ? Buffer.concat([bytes, bytes]) : bytes,
    kind === 'mime' ? { 'Content-Type': 'text/html' } : kind === 'size' ? { 'Content-Length': '999' } : kind === 'digest' ? { 'X-Oraculum-SHA256': '0'.repeat(64) } : {}, kind === 'revoked' ? 401 : 200);
  await expect(readArtifact(file, new AbortController().signal, () => {})).rejects.toThrow();
});
it('aborts without reporting a successful Blob and rejects oversized metadata before fetching', async () => {
  const fetch = setup(), controller = new AbortController(); controller.abort();
  await expect(readArtifact(file, controller.signal, () => {})).rejects.toThrow();
  fetch.mockClear(); await expect(readArtifact({ ...file, size: 64 * 1024 ** 2 + 1 }, new AbortController().signal, () => {})).rejects.toThrow('64 MB');
  expect(fetch).not.toHaveBeenCalled();
});
it('never places host paths or grant data in metadata request URLs', async () => {
  const fetch = setup(Buffer.from('{}'));
  await artifactRequest('select', { cwd: '/synthetic/project', path: 'results/file.pdf', threadId: 'native' }, new AbortController().signal);
  expect(fetch.mock.calls[0]![0].toString()).toBe('https://host.example/console/artifacts/select');
  expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: '{"cwd":"/synthetic/project","path":"results/file.pdf","threadId":"native"}' });
});
