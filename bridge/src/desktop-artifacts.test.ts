import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
const { allowedDownload } = createRequire(import.meta.url)('../../apps/desktop/artifacts.cjs');
const origin = 'http://127.0.0.1:17860';
const fixture = (changes: object = {}) => ({ getFilename: () => '中文成果.pdf', getMimeType: () => 'application/pdf', getTotalBytes: () => 1024,
  getURL: () => `blob:${origin}/123`, getURLChain: () => [`blob:${origin}/123`], ...changes });
it('allows only bounded same-origin validated blobs with a safe matching file type', () => {
  expect(allowedDownload(fixture(), origin, origin + '/')).toBe(true);
  for (const [name, mime] of [['图.png', 'image/png'], ['数据.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ['演示.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'], ['空.txt', 'text/plain']])
    expect(allowedDownload(fixture({ getFilename: () => name, getMimeType: () => mime, getTotalBytes: () => 0 }), origin, origin)).toBe(true);
});
it('blocks arbitrary HTTP downloads, other origins, executables, mismatched types and unsafe display names', () => {
  for (const changes of [{ getURL: () => origin + '/private' }, { getURL: () => 'blob:https://evil.example/123' }, { getURLChain: () => [origin + '/private'] }, { getTotalBytes: () => 64 * 1024 ** 2 + 1 },
    { getFilename: () => 'run.exe' }, { getFilename: () => '../file.pdf' }, { getFilename: () => '.private.pdf' }, { getFilename: () => 'bad\u202e.pdf' }, { getFilename: () => 'file.svg' }, { getMimeType: () => 'text/html' }])
    expect(allowedDownload(fixture(changes), origin, origin)).toBe(false);
  expect(allowedDownload(fixture(), origin, 'https://evil.example/')).toBe(false);
});
