import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { Themes } from './themes';
import { compileThemeCss } from './theme-css';
import { TrustStore } from './trust-store';
import { createServer } from './server';
import type { BridgeService } from './service';

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
const meta = { id: 'test-theme', name: '测试主题', version: '1.0.0', themeApi: 1 };
const css = ':root { --accent: #bbccff; } [data-theme-slot="content"] { padding-inline: 16px; }';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'oraculum-themes-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), installed = join(root, 'installed');
  const path = join(source, 'candidate');
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'manifest.json'), JSON.stringify(meta));
  await writeFile(join(path, 'theme.css'), css);
  return { root, path, source, installed, themes: new Themes({ source, installed }) };
}

describe('Theme API v1 CSS boundary', () => {
  it('scopes public hooks and mobile overrides; never emits input comments', () => {
    expect(compileThemeCss(css + '/* ignored */', false, new Set(), '/')).toBe('[data-theme-root]{--accent:#bbccff}[data-theme-root] [data-theme-slot="content"]{padding-inline:16px}');
    expect(compileThemeCss('[data-theme-slot="tool"]{margin-block:8px}', true, new Set(), '/')).toContain('@media (max-width: 760px), (pointer: coarse)');
  });
  it.each([
    'button{display:none}', '[data-theme-slot="content"] button{opacity:0}',
    '[data-theme-slot="content"]{display:none}', '[data-theme-slot="content"]{position:fixed}',
    '[data-theme-slot="content"]{padding-inline:999px}', '[data-theme-slot="header"]{z-index:999}',
    '[data-theme-slot="header"]{pointer-events:none}', '[data-theme-slot="header"]{content:"允许"}',
    '[data-theme-slot="header"]::after{content:""}', '[data-theme-slot="header"]{all:unset}',
    ':root{--background:#000000;--foreground:#000000}', ':root{--surface:#ffffff}',
    ':root{--app-height:0px}', ':root{--accent:var(--background)}', ':root{--accent:#bbccff!important}',
    ':root{--font-sans:url("secret")}', ':root{--accent:red}', ':root{--accent:#fff',
    ':root{--accent:#bbccff}:root{--foreground:#000000}',
    '@media (max-width: 760px){:root{--background:#000000}}',
    '@import "https://evil.invalid/a.css";', '@font-face{src:url("https://evil.invalid/font")}',
    '@supports(display:block){:root{--accent:#bbccff}}',
    '[data-theme-slot="decoration"]{background-image:url("https://evil.invalid/a.png")}',
    '[data-theme-slot="decoration"]{background-image:url("/auth/logout")}',
    '[data-theme-slot="decoration"]{background-image:url("data:image/svg+xml,hi")}',
    '[data-theme-slot="decoration"]{background-image:url("assets/../secret.png")}',
    '[data-theme-slot="decoration"]{background-image:image-set("https://evil.invalid")}',
    '[data-theme-slot="decoration"]{background-image:u\\72l("assets/a.png")}',
    '[data-theme-slot="header"]{& button{display:none}}',
  ])('rejects hazardous/unsupported CSS: %s', source => {
    expect(() => compileThemeCss(source, false, new Set(), '/')).toThrow('Theme CSS:');
  });
});

describe('explicit, bounded local directory installation', () => {
  it('installs an independent validated copy, survives a new service, and never overwrites an id', async () => {
    const { themes, path, source, installed } = await fixture();
    expect((await themes.catalog()).installed).toEqual([]);
    expect((await themes.catalog()).sources[0].manifest).toEqual(meta);
    expect(await themes.install('candidate')).toEqual(meta);
    await writeFile(join(path, 'theme.css'), 'bad');
    expect((await new Themes({ source, installed }).bundle(meta.id, '/')).css).toContain('--accent:#bbccff');
    await writeFile(join(path, 'theme.css'), css);
    await expect(themes.install('candidate')).rejects.toThrow('已安装');
    expect(await readFile(join(installed, meta.id, 'theme.css'), 'utf8')).toBe(css);
  });
  it('only serves in-package typed raster assets; references respect the configured entry', async () => {
    const { themes, path } = await fixture();
    await mkdir(join(path, 'assets')); await writeFile(join(path, 'assets/paper.png'), png);
    await writeFile(join(path, 'theme.css'), css + '[data-theme-slot="decoration"]{background-image:url("assets/paper.png")}');
    await themes.install('candidate');
    const bundle = await themes.bundle(meta.id, '/console/');
    expect(bundle.css).toContain('/console/themes/test-theme/assets/paper.png');
    expect(await themes.asset(meta.id, 'assets/paper.png')).toEqual({ bytes: png, type: 'image/png' });
    await expect(themes.asset(meta.id, 'assets/../../manifest.json')).rejects.toThrow();
    await expect(themes.asset(meta.id, 'manifest.json')).rejects.toThrow();
  });
  it.each(['bad.json', 'index.html', 'theme.js', 'assets/bad.svg', 'assets/fake.png'])('rejects extra/executable resource %s', async name => {
    const { themes, path } = await fixture();
    await mkdir(join(path, 'assets')); await writeFile(join(path, name), '<script>bad</script>');
    await expect(themes.install('candidate')).rejects.toThrow();
    expect((await themes.catalog()).installed).toHaveLength(0);
  });
  it('rejects path traversal, symlink files/directories, hard links and oversized files', async () => {
    const { themes, root, path, source } = await fixture();
    await expect(themes.install('../candidate')).rejects.toThrow();
    await expect(themes.install(path)).rejects.toThrow();
    await symlink(path, join(source, 'linked')); await expect(themes.install('linked')).rejects.toThrow();
    await writeFile(join(root, 'outside.png'), png); await mkdir(join(path, 'assets'));
    await symlink(join(root, 'outside.png'), join(path, 'assets/p.png')); await expect(themes.install('candidate')).rejects.toThrow();
    await rm(join(path, 'assets/p.png')); await link(join(root, 'outside.png'), join(path, 'assets/p.png'));
    await expect(themes.install('candidate')).rejects.toThrow(); await rm(join(path, 'assets/p.png'));
    await writeFile(join(path, 'theme.css'), ' '.repeat(65537)); await expect(themes.install('candidate')).rejects.toThrow();
  });
  it('revalidates installed files on every read, including missing/incompatible/corrupt packages', async () => {
    const { themes, installed } = await fixture(); await themes.install('candidate');
    const manifest = join(installed, meta.id, 'manifest.json');
    await writeFile(manifest, JSON.stringify({ ...meta, themeApi: 2 }));
    await expect(themes.bundle(meta.id, '/')).rejects.toThrow('不兼容');
    expect((await themes.catalog()).installed[0].error).toContain('不兼容');
    await writeFile(manifest, 'invalid'); await expect(themes.bundle(meta.id, '/')).rejects.toThrow('损坏');
    await rm(join(installed, meta.id), { recursive: true }); await expect(themes.bundle(meta.id, '/')).rejects.toThrow();
  });
  it('accepts the checked-in template and sole acceptance theme', async () => {
    const { installed } = await fixture();
    const themes = new Themes({ source: resolve('themes'), installed });
    const catalog = await themes.catalog();
    expect(catalog.sources).toHaveLength(2);
    expect(catalog.sources.every(entry => entry.manifest && !entry.error)).toBe(true);
  });
});

describe('authenticated theme HTTP boundary', () => {
  it('requires trust, exact origin, scope, and canonical resource paths at root and subpath', async () => {
    const { themes, root, path } = await fixture();
    await mkdir(join(path, 'assets')); await writeFile(join(path, 'assets/p.png'), png);
    const trust = new TrustStore(join(root, 'trust')); cleanup.push(() => trust.close());
    const service = new EventEmitter() as BridgeService;
    const server = await createServer(service, 17864, '/missing', { themes, trust, remoteOrigin: 'https://theme.example', remoteBasePath: '/console/' });
    cleanup.push(() => server.close());
    for (const remote of [false, true]) {
      const origin = remote ? 'https://theme.example' : 'http://127.0.0.1:17864', base = remote ? '/console/' : '/';
      const headers = { host: new URL(origin).host, origin, ...(remote ? { 'x-forwarded-proto': 'https' } : {}) };
      expect((await server.inject({ url: base + 'themes', headers })).statusCode).toBe(401);
      const paired = trust.pair(trust.createPairing().code, 'Test', remote ? origin + base : origin);
      const auth = { ...headers, cookie: `${remote ? '__Secure-oraculum_session' : 'oraculum_local'}=${paired.token}` };
      expect((await server.inject({ url: base + 'themes', headers: auth })).statusCode).toBe(200);
      const { origin: _origin, ...withoutOrigin } = auth;
      expect((await server.inject({ method: 'POST', url: base + 'themes/install', headers: withoutOrigin, payload: { directory: 'candidate' } })).statusCode).toBe(403);
      if (!remote) expect((await server.inject({ method: 'POST', url: base + 'themes/install', headers: auth, payload: { directory: 'candidate' } })).statusCode).toBe(200);
      expect((await server.inject({ url: base + `themes/${meta.id}/bundle`, headers: auth })).statusCode).toBe(200);
      const asset = await server.inject({ url: base + `themes/${meta.id}/assets/p.png`, headers: auth });
      expect(asset.statusCode).toBe(200); expect(asset.headers['content-type']).toContain('image/png');
      expect(asset.headers['x-content-type-options']).toBe('nosniff'); expect(asset.headers['cache-control']).toBe('no-store');
      // The injector can normalize encoded dot segments before routing; both
      // canonical-path rejection and a missing route must deny file exposure.
      const traversal = await server.inject({ url: base + `themes/${meta.id}/assets/%2e%2e/manifest.json`, headers: auth });
      expect([400, 404]).toContain(traversal.statusCode); expect(traversal.body).not.toContain('themeApi');
      expect((await server.inject({ url: base + 'themes', headers: { ...auth, origin: 'https://evil.invalid' } })).statusCode).toBe(403);
      trust.revoke(paired.device.id);
      expect((await server.inject({ url: base + `themes/${meta.id}/bundle`, headers: auth })).statusCode).toBe(401);
      expect((await server.inject({ url: base + `themes/${meta.id}/assets/p.png`, headers: auth })).statusCode).toBe(401);
    }
  });
});
