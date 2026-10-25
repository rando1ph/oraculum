import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { hostPaths, selectStateDirectory } from './paths';
import { compileThemeCss } from './theme-css';
import { DEFAULT_THEME, THEME_API, themeId, type ThemeBundle, type ThemeCatalog, type ThemeEntry, type ThemeManifest } from '../../packages/shared/themes';

function invalid(reason: string): never { throw new Error(`主题不可用：${reason}`); }
const safePart = /^[a-zA-Z0-9_-]+$/;
const builtinThemes = ['hong-kong-neon', 'old-terminal', 'minimal-light'] as const;
interface ThemeDirectories { installed: string; source: string; builtin?: string }
export function themeDirectories() {
  const paths = hostPaths();
  if (!process.env.ORACULUM_THEME_DIR) selectStateDirectory(paths);
  return { installed: paths.themeInstalled, source: paths.themeSource, builtin: join(paths.resources, 'themes') };
}
async function directory(path: string) {
  const info = await lstat(path);
  if (!isAbsolute(path) || await realpath(path) !== path || !info.isDirectory() || info.isSymbolicLink()) invalid('目录包含符号链接或已失效');
}
function manifest(bytes?: Buffer): ThemeManifest {
  let v;
  try { v = JSON.parse(bytes?.toString('utf8') ?? ''); } catch { return invalid('manifest.json 损坏'); }
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['id', 'name', 'version', 'themeApi'].includes(k)) ||
    typeof v.id !== 'string' || !themeId.test(v.id) || v.id === DEFAULT_THEME ||
    typeof v.name !== 'string' || !v.name.trim() || v.name.length > 64 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(v.name) ||
    typeof v.version !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v.version)) invalid('manifest 字段无效');
  if (v.themeApi !== THEME_API) invalid('Theme API 不兼容（需要 1）');
  return v as ThemeManifest;
}
function assetType(name: string, bytes: Buffer): string {
  if (name.endsWith('.png') && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (name.endsWith('.jpg') && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (name.endsWith('.webp') && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (name.endsWith('.woff') && bytes.toString('ascii', 0, 4) === 'wOFF') return 'font/woff';
  if (name.endsWith('.woff2') && bytes.toString('ascii', 0, 4) === 'wOF2') return 'font/woff2';
  if (name.endsWith('.otf') && bytes.toString('ascii', 0, 4) === 'OTTO') return 'font/otf';
  if (name.endsWith('.ttf') && bytes.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0]))) return 'font/ttf';
  return invalid('资源不是允许的 PNG/JPEG/WebP/WOFF/WOFF2/TTF/OTF');
}

// All responses are validated snapshots in memory, never sendFile/user paths.
// Local trust is explicit: this is not a sandbox for hostile OS users.
export class Themes {
  private installing = false;
  constructor(readonly paths: ThemeDirectories = themeDirectories()) {}
  private isBuiltin(id: string) { return !!this.paths.builtin && builtinThemes.some(builtin => builtin === id); }
  private root(id: string) { return this.isBuiltin(id) ? this.paths.builtin! : this.paths.installed; }
  private async read(root: string, id: string, installed: boolean, base: string) {
    if (!themeId.test(id) || id === DEFAULT_THEME) invalid('目录标识无效');
    await directory(root);
    const path = join(root, id);
    await directory(path);
    const files = new Map<string, Buffer>();
    let size = 0, count = 0;
    const walk = async (folder = '') => {
      await directory(join(path, folder));
      const entries = await readdir(join(path, folder), { withFileTypes: true });
      if (entries.length > 64) invalid('文件数量超限');
      for (const entry of entries) {
        if (++count > 64) invalid('文件数量超限');
        const name = folder ? `${folder}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!(name === 'assets' || (folder.startsWith('assets') && safePart.test(entry.name))) || name.split('/').length > 4) invalid('不支持的目录');
          await walk(name); continue;
        }
        const css = name === 'theme.css' || name === 'mobile.css';
        const asset = name === 'preview.webp' || /^assets\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(png|jpg|webp|woff|woff2|ttf|otf)$/.test(name);
        if (!css && !asset && name !== 'manifest.json') invalid('包只允许 manifest、CSS 与本地图片/字体');
        const handle = await open(join(path, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.nlink !== 1 || info.size > (asset ? 2 * 1024 * 1024 : css ? 64 * 1024 : 4096)) invalid('文件类型、链接或大小无效');
          const bytes = await handle.readFile();
          if (bytes.length !== info.size || (size += bytes.length) > 4 * 1024 * 1024) invalid('包在读取时变化或大小超限');
          if (asset) assetType(name, bytes);
          files.set(name, bytes);
        } finally { await handle.close(); }
      }
      await directory(join(path, folder));
    };
    await walk();
    await directory(root); await directory(path);
    const meta = manifest(files.get('manifest.json'));
    if (installed && meta.id !== id) invalid('主题 id 与安装目录不一致');
    if (!files.has('theme.css')) invalid('缺少 theme.css');
    const assets = new Set([...files.keys()].filter(name => name.startsWith('assets/')));
    const assetBase = `${base}themes/${meta.id}/`;
    const decode = (name: string) => new TextDecoder('utf-8', { fatal: true }).decode(files.get(name));
    const css = compileThemeCss(decode('theme.css'), false, assets, assetBase) +
      (files.has('mobile.css') ? compileThemeCss(decode('mobile.css'), true, assets, assetBase) : '');
    const digest = createHash('sha256');
    for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) digest.update(name).update(bytes);
    const bundle: ThemeBundle = { manifest: meta, css, revision: digest.digest('hex'),
      assets: [...assets].map(name => assetBase + name) };
    return { files, bundle };
  }
  private async entries(root: string, installed: boolean): Promise<ThemeEntry[]> {
    try {
      await directory(root);
      const entries = (await readdir(root)).filter(name => themeId.test(name)).sort();
      if (entries.length > 100) invalid('主题数量超限');
      const result: ThemeEntry[] = [];
      for (const id of entries) {
        try { result.push({ directory: id, manifest: (await this.read(root, id, installed, '/')).bundle.manifest }); }
        catch (error) { result.push({ directory: id, error: this.message(error) }); }
      }
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(this.message(error));
    }
  }
  message(error: unknown) {
    return error instanceof Error && (error.message.startsWith('主题不可用：') || error.message.startsWith('Theme CSS:'))
      ? error.message : '主题不可用：目录、文件或权限已变化';
  }
  async catalog(): Promise<ThemeCatalog> {
    const builtins: ThemeEntry[] = [];
    if (this.paths.builtin) {
      for (const id of builtinThemes) {
        try { builtins.push({ directory: id, builtin: true, manifest: (await this.read(this.paths.builtin, id, true, '/')).bundle.manifest }); }
        catch (error) { builtins.push({ directory: id, builtin: true, error: this.message(error) }); }
      }
    }
    return {
      installed: [...builtins, ...(await this.entries(this.paths.installed, true)).filter(entry => !this.isBuiltin(entry.directory))],
      sources: (await this.entries(this.paths.source, false)).filter(entry => !this.isBuiltin(entry.manifest?.id ?? entry.directory)),
    };
  }
  async bundle(id: string, base: string) { return (await this.read(this.root(id), id, true, base)).bundle; }
  async asset(id: string, name: string) {
    if (!name.startsWith('assets/') && name !== 'preview.webp') invalid('资源路径无效');
    const { files } = await this.read(this.root(id), id, true, '/');
    const bytes = files.get(name);
    if (!bytes) invalid('资源不存在');
    return { bytes, type: assetType(name, bytes) };
  }
  async install(id: unknown) {
    if (this.installing) invalid('安装进行中，请稍后重试');
    if (typeof id !== 'string') invalid('请选择主机来源目录');
    this.installing = true;
    let created: string | undefined;
    try {
      const { files, bundle } = await this.read(this.paths.source, id, false, '/');
      if (this.isBuiltin(bundle.manifest.id)) invalid('同 id 主题已内置，请使用不同 id');
      await mkdir(this.paths.installed, { recursive: true, mode: 0o700 });
      await directory(this.paths.installed);
      const target = join(this.paths.installed, bundle.manifest.id);
      // No overwrite/update of another installed package, even if names match.
      await mkdir(target, { mode: 0o700 }); created = target;
      for (const [name, bytes] of files) {
        const parent = name.includes('/') ? join(target, name.slice(0, name.lastIndexOf('/'))) : target;
        await mkdir(parent, { recursive: true, mode: 0o700 });
        await directory(parent);
        await writeFile(join(target, name), bytes, { flag: 'wx', mode: 0o600 });
      }
      await this.bundle(bundle.manifest.id, '/');
      return bundle.manifest;
    } catch (error) {
      if (created) await rm(created, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') invalid('同 id 主题已安装，请使用不同 id');
      throw new Error(this.message(error));
    } finally { this.installing = false; }
  }
}
