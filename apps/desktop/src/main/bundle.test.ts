import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_ENTRY, APP_ORIGIN, CONTENT_SECURITY_POLICY, isBundleRequest, loadBundle, respondToBundleRequest } from './bundle';

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(files: Record<string, string> = { 'index.html': '<!doctype html><h1>Local app</h1>', 'assets/app-a1.js': 'export {}' }) {
  const directory = mkdtempSync(join(tmpdir(), 'oraculum-bundle-'));
  temporary.push(directory);
  const renderer = join(directory, 'renderer');
  mkdirSync(renderer);
  mkdirSync(join(renderer, 'assets'));
  const manifest = join(directory, 'renderer-manifest.json');
  const entries: Record<string, { sha256: string; size: number }> = {};
  for (const [name, text] of Object.entries(files)) {
    const bytes = Buffer.from(text);
    writeFileSync(join(renderer, name), bytes);
    entries[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  }
  writeFileSync(manifest, JSON.stringify({ version: 1, files: entries }));
  return { directory, renderer, manifest, entries };
}

describe('Desktop private resource protocol', () => {
  it('serves a verified snapshot with strict response security headers, independent of subsequent disk content', async () => {
    const { renderer, manifest } = fixture();
    const bundle = loadBundle(renderer, manifest);
    writeFileSync(join(renderer, 'index.html'), 'replaced after startup');
    const response = respondToBundleRequest({ url: APP_ENTRY, method: 'GET' }, bundle);
    expect(await response.text()).toBe('<!doctype html><h1>Local app</h1>');
    expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'none'");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-inline|unsafe-eval/);
    const head = respondToBundleRequest({ url: APP_ENTRY, method: 'HEAD' }, bundle);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength('<!doctype html><h1>Local app</h1>')));
  });

  it.each([
    'file:///etc/passwd', 'http://127.0.0.1:17860/', 'https://example.invalid/',
    `${APP_ORIGIN}/../index.html`, `${APP_ORIGIN}/%2e%2e/index.html`,
    `${APP_ORIGIN}/%252e%252e/index.html`, `${APP_ORIGIN}/assets%2fapp-a1.js`,
    `${APP_ORIGIN}/assets\\app-a1.js`, `${APP_ORIGIN}/index.html?x=1`,
    `${APP_ORIGIN}/index.html#fragment`, `${APP_ORIGIN}/secret.txt`,
    'oraculum-app://evil/index.html', 'oraculum-app://user@bundle/index.html',
    'oraculum-app://bundle:99/index.html', `${APP_ORIGIN}//index.html`,
  ])('rejects non-allowlisted request %s', url => {
    const { renderer, manifest } = fixture();
    const bundle = loadBundle(renderer, manifest);
    expect(isBundleRequest(url, 'GET', bundle)).toBe(false);
    expect(respondToBundleRequest({ url, method: 'GET' }, bundle).status).toBe(404);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'get'])('rejects method %s', method => {
    const { renderer, manifest } = fixture();
    expect(isBundleRequest(APP_ENTRY, method, loadBundle(renderer, manifest))).toBe(false);
  });

  it.each(['digest', 'size', 'symlink', 'hardlink', 'parent-link', 'missing', 'manifest-link'])('refuses a damaged or aliased bundle: %s', scenario => {
    const { directory, renderer, manifest, entries } = fixture();
    const target = join(renderer, 'index.html');
    const outside = join(directory, 'outside.html');
    writeFileSync(outside, readFileSync(target));
    if (scenario === 'digest') writeFileSync(target, 'invalid');
    if (scenario === 'size') { entries['index.html'].size += 1; writeFileSync(manifest, JSON.stringify({ version: 1, files: entries })); }
    if (scenario === 'symlink' || scenario === 'hardlink') {
      rmSync(target);
      if (scenario === 'symlink') symlinkSync(outside, target); else linkSync(outside, target);
    }
    if (scenario === 'parent-link') {
      const assets = join(renderer, 'assets');
      rmSync(assets, { recursive: true });
      symlinkSync(directory, assets);
    }
    if (scenario === 'missing') rmSync(target);
    if (scenario === 'manifest-link') {
      const copied = join(directory, 'manifest-copy.json');
      writeFileSync(copied, readFileSync(manifest)); rmSync(manifest); symlinkSync(copied, manifest);
    }
    expect(() => loadBundle(renderer, manifest)).toThrow('DESKTOP_BUNDLE_INVALID');
  });

  it.each(['../index.html', '/index.html', 'assets/../../index.html', 'bad%2fname.js', 'script.exe'])('refuses unsafe manifest entry %s', name => {
    const { renderer, manifest, entries } = fixture();
    entries[name] = entries['index.html'];
    writeFileSync(manifest, JSON.stringify({ version: 1, files: entries }));
    expect(() => loadBundle(renderer, manifest)).toThrow('DESKTOP_BUNDLE_INVALID');
  });
});
