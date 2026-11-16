import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export const APP_SCHEME = 'oraculum-app';
export const APP_ORIGIN = `${APP_SCHEME}://bundle`;
export const APP_ENTRY = `${APP_ORIGIN}/index.html`;
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'",
  "img-src 'self' data:", "font-src 'self'", "connect-src 'none'",
  "frame-src 'none'", "frame-ancestors 'none'", "worker-src 'none'",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2',
};
const MAX_FILES = 256;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;
type BundledFile = { bytes: Uint8Array; contentType: string };

function fail(): never { throw new Error('DESKTOP_BUNDLE_INVALID'); }

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/** No symlink component is accepted, including a link to another build directory. */
export function assertRegularDirectoryChain(directory: string): void {
  const absolute = resolve(directory);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  }
}

function readRegular(file: string, limit: number): Buffer {
  assertRegularDirectoryChain(dirname(file));
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) fail();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > limit
      || opened.dev !== before.dev || opened.ino !== before.ino) fail();
    const bytes = readFileSync(fd);
    if (bytes.length > limit) fail();
    return bytes;
  } finally { closeSync(fd); }
}

/**
 * Validate and snapshot the complete, small renderer bundle before opening a
 * window. URL handling then never reads the filesystem or constructs a path.
 */
export function loadBundle(rendererRoot: string, manifestFile: string): ReadonlyMap<string, BundledFile> {
  try {
    assertRegularDirectoryChain(rendererRoot);
    const manifest: unknown = JSON.parse(readRegular(manifestFile, MAX_MANIFEST_BYTES).toString('utf8'));
    if (!plain(manifest) || Object.keys(manifest).sort().join(',') !== 'files,version'
      || manifest.version !== 1 || !plain(manifest.files)) fail();
    const entries = Object.entries(manifest.files);
    if (!entries.length || entries.length > MAX_FILES) fail();
    const result = new Map<string, BundledFile>();
    let total = 0;
    for (const [name, metadata] of entries) {
      // A literal allowlist avoids URL decoding ambiguities and path traversal.
      if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.[a-zA-Z0-9]+$/.test(name)
        || isAbsolute(name) || !plain(metadata)
        || Object.keys(metadata).sort().join(',') !== 'sha256,size'
        || typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sha256)
        || !Number.isSafeInteger(metadata.size) || (metadata.size as number) < 0) fail();
      const contentType = MIME[name.split('.').at(-1)!.toLowerCase()];
      if (!contentType || (total += metadata.size as number) > MAX_BYTES) fail();
      const file = resolve(rendererRoot, name);
      if (relative(resolve(rendererRoot), file).startsWith(`..${sep}`)) fail();
      const bytes = readRegular(file, MAX_BYTES);
      if (bytes.length !== metadata.size || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) fail();
      result.set(`${APP_ORIGIN}/${name}`, { bytes: new Uint8Array(bytes), contentType });
    }
    if (!result.has(APP_ENTRY)) fail();
    return result;
  } catch { return fail(); }
}

export function isBundleRequest(url: string, method: string, bundle: ReadonlyMap<string, BundledFile>): boolean {
  return (method === 'GET' || method === 'HEAD') && bundle.has(url);
}

export function respondToBundleRequest(request: { url: string; method: string }, bundle: ReadonlyMap<string, BundledFile>): Response {
  const headers = {
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
  };
  if (!isBundleRequest(request.url, request.method, bundle)) {
    return new Response(null, { status: 404, headers });
  }
  const file = bundle.get(request.url)!;
  return new Response(request.method === 'HEAD' ? null : file.bytes as BodyInit, {
    status: 200,
    headers: { ...headers, 'Content-Type': file.contentType, 'Content-Length': String(file.bytes.length) },
  });
}
