import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdtemp, mkdir, readFile, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { Themes, themeDirectories } from './themes';
import { compileThemeCss } from './theme-css';
import { TrustStore } from './trust-store';
import { createServer } from './server';
import type { BridgeService } from './service';

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; vi.unstubAllEnvs(); });
const meta = { id: 'test-theme', name: '测试主题', version: '1.0.0', themeApi: 1 };
const builtinManifests = [
  { ...meta, id: 'hong-kong-neon', name: 'Hong Kong Neon · 香港霓虹' },
  { ...meta, id: 'old-terminal', name: 'Old Terminal · 老式终端', version: '2.0.0' },
];
const builtinEntries = builtinManifests.map(manifest => ({ directory: manifest.id, builtin: true, manifest }));
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
async function builtinFixture(id: string) {
  const f = await fixture();
  const builtin = join(f.root, 'resources', 'themes');
  for (const manifest of builtinManifests) {
    const path = join(builtin, manifest.id);
    await mkdir(join(path, 'assets'), { recursive: true });
    await writeFile(join(path, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(path, 'theme.css'), '.app-shell{background-image:url("assets/night.png")}');
    await writeFile(join(path, 'assets/night.png'), png);
  }
  const manifest = builtinManifests.find(manifest => manifest.id === id)!;
  return { ...f, builtin, builtinPath: join(builtin, id), id, manifest, themes: new Themes({ source: f.source, installed: f.installed, builtin }) };
}

describe('Trusted Theme API v1 CSS', () => {
  it('preserves standard CSS, legacy hooks and mobile rules without visual restrictions', () => {
    const source = `:root { --background: white; --foreground: #121212; color-scheme: light; }
      button.primary:hover, [data-theme-slot="content"] > p::before { opacity: .8; content: "雨夜"; }
      @supports (display: grid) { .composer { display: grid; & textarea { font-size: 18px !important; } } }
      @keyframes rain { to { transform: translateY(50px); } }
      .glass { backdrop-filter: blur(12px); animation: rain 3s infinite; }
      body { visibility: hidden !important; }`;
    expect(compileThemeCss(source, false, new Set(), '/')).toBe(source + '\n');
    expect(compileThemeCss(css, true, new Set(), '/')).toContain('@media (max-width: 760px), (pointer: coarse)');
  });
  it('resolves images and font sources, escaped URLs, nested values and image-set strings', () => {
    const source = String.raw`@font-face { font-family: Rain; src: url('./assets/type.woff2') format('woff2'); }
      .a { background: image-set("assets/a.png" 1x, url(assets/b.png) 2x), url("assets/a.png?v=1#x");
        --image: u\72l("assets/a.png"); content: "assets/a.png"; }`;
    const output = compileThemeCss(source, false, new Set(['assets/a.png', 'assets/b.png', 'assets/type.woff2']), '/console/themes/rain/');
    expect(output).toContain("url('/console/themes/rain/assets/type.woff2') format('woff2')");
    expect(output).toContain('image-set("/console/themes/rain/assets/a.png" 1x, url(/console/themes/rain/assets/b.png) 2x)');
    expect(output).toContain('assets/a.png?v=1#x');
    expect(output).toContain('content: "assets/a.png"');
  });
  it('leaves external URLs to the unchanged browser CSP', () => {
    const source = '@import "https://example.invalid/a.css"; .a{background:url(https://example.invalid/a.png)}';
    expect(compileThemeCss(source, false, new Set(), '/')).toBe(source + '\n');
  });
  it.each([':root{--accent:', '.a{color:red', '.a{background:url("assets/missing.png")}',
    '.a{background:url("assets/../secret.png")}', '@import "other.css";'])('reports malformed CSS or invalid local resources: %s', source => {
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
    expect((await new Themes({ source, installed }).bundle(meta.id, '/')).css).toContain('--accent: #bbccff');
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
  it('serves local fonts with fixed MIME and requires matching signatures', async () => {
    const { themes, path } = await fixture();
    await mkdir(join(path, 'assets'));
    const bytes = Buffer.from('wOF2font-fixture');
    await writeFile(join(path, 'assets/type.woff2'), bytes);
    await writeFile(join(path, 'theme.css'), '@font-face{font-family:Test;src:url("assets/type.woff2")}');
    await themes.install('candidate');
    expect(await themes.asset(meta.id, 'assets/type.woff2')).toEqual({ bytes, type: 'font/woff2' });
    await writeFile(join(path, 'assets/type.woff2'), 'not a font');
    expect((await themes.catalog()).sources[0].error).toContain('资源不是允许');
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
  it('accepts the checked-in template and acceptance themes', async () => {
    const { installed } = await fixture();
    const themes = new Themes({ source: resolve('themes'), installed });
    const catalog = await themes.catalog();
    expect(catalog.sources.map(entry => entry.directory)).toEqual(expect.arrayContaining(['template', 'test-violet']));
    expect(catalog.sources.every(entry => entry.manifest && !entry.error)).toBe(true);
  });
});

describe('read-only built-in themes', () => {
  it('resolves built-ins from program resources independently of source and state overrides', async () => {
    const { root, installed, source } = await fixture();
    vi.stubEnv('ORACULUM_RESOURCE_DIR', join(root, 'program'));
    vi.stubEnv('ORACULUM_THEME_SOURCE_DIR', source);
    vi.stubEnv('ORACULUM_THEME_DIR', installed);
    expect(themeDirectories()).toEqual({ installed, source, builtin: join(root, 'program', 'themes') });
  });
  it('validates both checked-in built-in packages independently of source overrides', async () => {
    const { installed, source } = await fixture();
    const themes = new Themes({ source, installed, builtin: resolve('themes') });
    expect((await themes.catalog()).installed).toEqual(builtinEntries);
    for (const manifest of builtinManifests) {
      for (const base of ['/', '/console/']) {
        const bundle = await themes.bundle(manifest.id, base);
        expect(bundle.manifest).toEqual(manifest);
        expect(bundle.css).toBeTruthy();
        expect(bundle.assets.every(asset => asset.startsWith(`${base}themes/${manifest.id}/assets/`))).toBe(true);
      }
    }
  });
  it.each(builtinManifests)('$id is selectable without installation with a separate source directory and base-aware assets', async ({ id }) => {
    const { themes, installed } = await builtinFixture(id);
    const catalog = await themes.catalog();
    expect(catalog.installed).toEqual(builtinEntries);
    expect(catalog.sources.map(entry => entry.manifest?.id)).toEqual([meta.id]);
    expect((await themes.bundle(id, '/')).css).toContain(`/themes/${id}/assets/night.png`);
    expect((await themes.bundle(id, '/console/')).css).toContain(`/console/themes/${id}/assets/night.png`);
    expect(await themes.asset(id, 'assets/night.png')).toEqual({ bytes: png, type: 'image/png' });
    await expect(lstat(installed)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(builtinManifests)('reserves $id and never serves an installed shadow or exposes its source alias for installation', async ({ id }) => {
    const { themes, installed, source, path, builtin, manifest } = await builtinFixture(id);
    await writeFile(join(path, 'manifest.json'), JSON.stringify(manifest));
    await mkdir(join(installed, id), { recursive: true });
    await writeFile(join(installed, id, 'manifest.json'), JSON.stringify({ ...manifest, name: 'Shadow' }));
    await writeFile(join(installed, id, 'theme.css'), ':root{--accent:red}');
    expect((await themes.catalog()).sources).toEqual([]);
    expect((await themes.catalog()).installed).toEqual(builtinEntries);
    expect((await themes.bundle(id, '/')).manifest.name).toBe(manifest.name);
    await expect(themes.install('candidate')).rejects.toThrow('已内置');
    expect(await readFile(join(installed, id, 'theme.css'), 'utf8')).toBe(':root{--accent:red}');
    // The default source root is the same resource directory. It still has no install button.
    expect((await new Themes({ source: builtin, installed, builtin }).catalog()).sources).toEqual([]);
    expect(source).not.toBe(builtin);
  });
  it.each(builtinManifests)('revalidates $id and reports damage without falling through to a same-id installed copy', async ({ id }) => {
    const { themes, installed, builtinPath, manifest } = await builtinFixture(id);
    await mkdir(join(installed, id), { recursive: true });
    await writeFile(join(installed, id, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(installed, id, 'theme.css'), css);
    await rm(join(builtinPath, 'assets/night.png'));
    await expect(themes.bundle(id, '/')).rejects.toThrow('Theme CSS:');
    expect((await themes.catalog()).installed).toEqual(builtinEntries.map(entry => entry.directory === id
      ? { directory: id, builtin: true, error: expect.stringContaining('Theme CSS:') } : entry));
    await rm(builtinPath, { recursive: true });
    await expect(themes.bundle(id, '/')).rejects.toThrow();
    expect((await themes.catalog()).installed.find(entry => entry.directory === id)?.error).toBeTruthy();
  });
  it.each(builtinManifests)('$id uses the existing authenticated root and subpath routes with unchanged asset headers', async ({ id }) => {
    const { themes, root } = await builtinFixture(id);
    const trust = new TrustStore(join(root, 'trust')); cleanup.push(() => trust.close());
    const service = new EventEmitter() as BridgeService;
    const server = await createServer(service, 17864, '/missing', { themes, trust, remoteOrigin: 'https://theme.example', remoteBasePath: '/console/' });
    cleanup.push(() => server.close());
    for (const remote of [false, true]) {
      const origin = remote ? 'https://theme.example' : 'http://127.0.0.1:17864', base = remote ? '/console/' : '/';
      const headers = { host: new URL(origin).host, origin, ...(remote ? { 'x-forwarded-proto': 'https' } : {}) };
      expect((await server.inject({ url: `${base}themes/${id}/bundle`, headers })).statusCode).toBe(401);
      expect((await server.inject({ url: `${base}themes/${id}/assets/night.png`, headers })).statusCode).toBe(401);
      const paired = trust.pair(trust.createPairing().code, 'Test', remote ? origin + base : origin);
      const auth = { ...headers, cookie: `${remote ? '__Secure-oraculum_session' : 'oraculum_local'}=${paired.token}` };
      const bundle = await server.inject({ url: `${base}themes/${id}/bundle`, headers: auth });
      expect(bundle.statusCode).toBe(200);
      expect(bundle.json().css).toContain(`${base}themes/${id}/assets/night.png`);
      const asset = await server.inject({ url: `${base}themes/${id}/assets/night.png`, headers: auth });
      expect(asset.statusCode).toBe(200); expect(asset.headers['content-type']).toContain('image/png');
      expect(asset.headers['x-content-type-options']).toBe('nosniff'); expect(asset.headers['cache-control']).toBe('no-store');
      trust.revoke(paired.device.id);
      expect((await server.inject({ url: `${base}themes/${id}/bundle`, headers: auth })).statusCode).toBe(401);
      expect((await server.inject({ url: `${base}themes/${id}/assets/night.png`, headers: auth })).statusCode).toBe(401);
    }
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
