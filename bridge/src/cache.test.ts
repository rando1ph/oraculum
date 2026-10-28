import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createServer } from './server';
import { Themes } from './themes';
import { TrustStore } from './trust-store';
import type { BridgeService } from './service';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'oraculum-cache-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const web = join(root, 'web'), theme = join(root, 'installed', 'cache-test');
  await mkdir(join(web, 'assets'), { recursive: true });
  await mkdir(join(theme, 'assets'), { recursive: true });
  await writeFile(join(web, 'index.html'), '<html>first entry</html>');
  for (const file of ['entry-AbCd_123.js', 'entry-ZyXw_456.js', 'style-AbCd_123.css', 'font-AbCd_123.woff2', 'image-AbCd_123.webp', 'plain.js', 'library-development.js']) {
    await writeFile(join(web, 'assets', file), file);
  }
  await writeFile(join(theme, 'manifest.json'), JSON.stringify({ id: 'cache-test', name: 'Cache test', version: '1.0.0', themeApi: 1 }));
  await writeFile(join(theme, 'theme.css'), '.app-shell{background:url("assets/image.png?author=1#crop")}');
  await writeFile(join(theme, 'assets/image.png'), png);
  const trust = new TrustStore(join(root, 'trust'));
  cleanup.push(() => trust.close());
  const service = Object.assign(new EventEmitter(), { codex: {} }) as BridgeService;
  const app = await createServer(service, 17864, web, { trust,
    themes: new Themes({ installed: join(root, 'installed'), source: join(root, 'source') }),
    remoteOrigin: 'https://cache.example', remoteBasePath: '/console/' });
  cleanup.push(() => app.close());
  return { app, root, web, theme, trust };
}
function entry(remote: boolean) {
  const origin = remote ? 'https://cache.example' : 'http://127.0.0.1:17864';
  const base = remote ? '/console/' : '/';
  return { origin, base, headers: { host: new URL(origin).host, origin, ...(remote ? { 'x-forwarded-proto': 'https' } : {}) } };
}

describe('static and authenticated theme HTTP cache', () => {
  it.each([false, true])('caches only fingerprinted static assets and refreshes entry HTML (remote=%s)', async remote => {
    const { app, web } = await fixture();
    const { base, headers } = entry(remote);
    for (const file of ['entry-AbCd_123.js', 'style-AbCd_123.css', 'font-AbCd_123.woff2', 'image-AbCd_123.webp']) {
      const response = await app.inject({ url: base + 'assets/' + file, headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    }
    const changed = await app.inject({ url: base + 'assets/entry-ZyXw_456.js', headers });
    expect(changed.statusCode).toBe(200);
    expect(changed.body).toBe('entry-ZyXw_456.js');
    const html = await app.inject({ url: base, headers });
    expect(html.headers['cache-control']).toBe('no-store');
    await writeFile(join(web, 'index.html'), '<html>newer entry</html>');
    const updated = await app.inject({ url: base, headers: { ...headers, 'if-modified-since': new Date().toUTCString() } });
    expect(updated.statusCode).toBe(200);
    expect(updated.body).toContain('newer entry');
    for (const path of ['index.html', 'assets/plain.js', 'assets/library-development.js', 'assets/missing-AbCd_123.js', 'missing', 'health']) {
      const response = await app.inject({ url: base + path, headers });
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it.each([false, true])('revalidates private theme bytes only after authentication (remote=%s)', async remote => {
    const { app, trust } = await fixture();
    const { origin, base, headers } = entry(remote);
    const paired = trust.pair(trust.createPairing().code, 'Cache fixture', remote ? origin + base : origin);
    const auth = { ...headers, cookie: `${remote ? '__Secure-oraculum_session' : 'oraculum_local'}=${paired.token}` };
    for (const path of ['bundle', 'assets/image.png']) {
      const url = base + 'themes/cache-test/' + path;
      const first = await app.inject({ url, headers: auth });
      expect(first.statusCode).toBe(200);
      expect(first.headers['cache-control']).toBe('private, no-cache');
      expect(first.headers.vary).toBe('Cookie, Origin');
      expect(first.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
      for (const value of [first.headers.etag, `"unrelated", W/${first.headers.etag}`, '*']) {
        const unchanged = await app.inject({ url, headers: { ...auth, 'if-none-match': value as string } });
        expect(unchanged.statusCode).toBe(304);
        expect(unchanged.body).toBe('');
        expect(unchanged.headers['cache-control']).toBe('private, no-cache');
      }
      const modified = await app.inject({ url, headers: { ...auth, 'if-none-match': '"outdated"' } });
      expect(modified.statusCode).toBe(200);
      const rejected: [Record<string, string>, number][] = [
        [headers, 401], [{ ...auth, cookie: 'invalid=x' }, 401],
        [{ ...auth, origin: 'https://other.invalid' }, 403], [{ ...auth, host: 'other.invalid' }, 403],
        [{ ...auth, 'sec-fetch-site': 'cross-site' }, 403],
      ];
      if (remote) rejected.push([{ ...auth, 'x-forwarded-proto': 'http' }, 403]);
      for (const [deniedHeaders, status] of rejected) {
        const denied = await app.inject({ url, headers: { ...deniedHeaders, 'if-none-match': first.headers.etag as string } });
        expect(denied.statusCode).toBe(status);
        expect(denied.headers['cache-control']).toBe('no-store');
        expect(denied.headers.etag).toBeUndefined();
      }
      if (remote) {
        const outside = await app.inject({ url: '/themes/cache-test/' + path, headers: { ...auth, 'if-none-match': first.headers.etag as string } });
        expect(outside.statusCode).toBe(404);
        expect(outside.headers['cache-control']).toBe('no-store');
      }
    }
    for (const path of ['auth/session', 'themes']) {
      const response = await app.inject({ url: base + path, headers: auth });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    trust.revoke(paired.device.id);
    for (const path of ['bundle', 'assets/image.png']) {
      const revoked = await app.inject({ url: base + 'themes/cache-test/' + path, headers: { ...auth, 'if-none-match': '*' } });
      expect(revoked.statusCode).toBe(401);
      expect(revoked.headers['cache-control']).toBe('no-store');
      expect(revoked.headers.etag).toBeUndefined();
    }
  });

  it('invalidates changed bundles/assets, rejects corruption, and distinguishes entry variants', async () => {
    const { app, trust, theme } = await fixture();
    const local = entry(false), remote = entry(true);
    const localToken = trust.pair(trust.createPairing().code, 'Local', local.origin).token;
    const remoteToken = trust.pair(trust.createPairing().code, 'Remote', remote.origin + remote.base).token;
    const headers = { ...local.headers, cookie: `oraculum_local=${localToken}` };
    const url = '/themes/cache-test/bundle', assetUrl = '/themes/cache-test/assets/image.png';
    const first = await app.inject({ url, headers });
    const asset = await app.inject({ url: assetUrl, headers });
    const bundle = first.json();
    expect(bundle.assets).toEqual([`${assetUrl}?oraculum-revision=${bundle.revision}`]);
    expect(bundle.css).toContain(`${assetUrl}?author=1&oraculum-revision=${bundle.revision}#crop`);
    const remoteBundle = await app.inject({ url: remote.base + 'themes/cache-test/bundle', headers: {
      ...remote.headers, cookie: `__Secure-oraculum_session=${remoteToken}`, 'if-none-match': first.headers.etag as string,
    } });
    expect(remoteBundle.statusCode).toBe(200);
    expect(remoteBundle.headers.etag).not.toBe(first.headers.etag);
    expect(remoteBundle.json().revision).toBe(bundle.revision);
    await writeFile(join(theme, 'theme.css'), '.app-shell{background:url("assets/image.png");color:red}');
    const cssChanged = await app.inject({ url, headers: { ...headers, 'if-none-match': first.headers.etag as string } });
    expect(cssChanged.statusCode).toBe(200);
    expect(cssChanged.headers.etag).not.toBe(first.headers.etag);
    expect(cssChanged.json().assets).not.toEqual(bundle.assets);
    await writeFile(join(theme, 'assets/image.png'), Buffer.concat([png, Buffer.from('changed')]));
    const imageChanged = await app.inject({ url: assetUrl, headers: { ...headers, 'if-none-match': asset.headers.etag as string } });
    expect(imageChanged.statusCode).toBe(200);
    expect(imageChanged.headers.etag).not.toBe(asset.headers.etag);
    const assetBundle = await app.inject({ url, headers: { ...headers, 'if-none-match': cssChanged.headers.etag as string } });
    expect(assetBundle.statusCode).toBe(200);
    expect(assetBundle.json().assets).not.toEqual(cssChanged.json().assets);
    await writeFile(join(theme, 'assets/image.png'), 'invalid image');
    for (const path of [url, assetUrl]) {
      const damaged = await app.inject({ url: path, headers: { ...headers, 'if-none-match': '*' } });
      expect(damaged.statusCode).toBe(400);
      expect(damaged.headers['cache-control']).toBe('no-store');
      expect(damaged.headers.etag).toBeUndefined();
    }
  });
});
