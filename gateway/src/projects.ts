import { constants } from 'node:fs';
import { open, opendir, lstat, realpath, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GatewayStore, Project } from './store';

export type Identity = { dev: string; ino: string };
export const identity = (s: { dev: bigint; ino: bigint }): Identity => ({ dev: String(s.dev), ino: String(s.ino) });
export const sameIdentity = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
export const fdPath = (h: FileHandle, name = '') => `/proc/self/fd/${h.fd}${name ? '/' + name : ''}`;
export class HostFileError extends Error {
  constructor(readonly code: string, message = 'Host file or project is unavailable or has changed.') { super(message); }
}
export const unavailable = () => new HostFileError('FILE_CHANGED');
export const allowedName = (s: string) => !!s && s.length <= 180 && s === s.normalize('NFC') && s.trim() === s && !s.startsWith('.') &&
  !/[/\\:%\p{Cc}\p{Cf}]/u.test(s) &&
  !/(^|[._ -])(auth|credentials?|secrets?|tokens?|passwords?|passwd|config(?:uration)?|settings|private[-_ ]?keys?|id_rsa|id_ed25519)([._ -]|$)/i.test(s) &&
  !['node_modules', 'vendor'].includes(s);
export function relativeParts(value: unknown, empty = false) {
  if (typeof value !== 'string' || value.length > 1024 || (!value && !empty)) throw unavailable();
  const parts = value ? value.split('/') : [];
  if (parts.length > 12 || parts.some(p => !allowedName(p))) throw unavailable();
  return parts;
}
const inside = (root: string, path: string) => { const r = relative(root, path); return r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
export async function openCanonicalDirectory(path: string) {
  if (!isAbsolute(path) || normalize(path) !== path || /[\x00-\x1f\x7f\\%]/.test(path)) throw unavailable();
  let current = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of path.split('/').filter(Boolean)) {
      const next = await open(fdPath(current, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await current.close(); current = next;
    }
    return current;
  } catch { await current.close(); throw unavailable(); }
}

/** Bounded opaque cursors are scoped to one query and directory version. */
export class DirectoryCursors {
  private cursors = new Map<string, { scope: string; version: string; last: string; expiresAt: number }>();
  constructor(private now = () => Date.now()) {}
  read(token: unknown, scope: string, version: string) {
    if (token === undefined || token === null || token === '') return '';
    const c = typeof token === 'string' ? this.cursors.get(token) : undefined;
    if (!c || c.expiresAt <= this.now() || c.scope !== scope || c.version !== version) throw new HostFileError('CURSOR_RESET_REQUIRED');
    return c.last;
  }
  issue(scope: string, version: string, last: string) {
    for (const [id, c] of this.cursors) if (c.expiresAt <= this.now()) this.cursors.delete(id);
    if (this.cursors.size >= 256) this.cursors.delete(this.cursors.keys().next().value!);
    const id = randomUUID(); this.cursors.set(id, { scope, version, last, expiresAt: this.now() + 300_000 }); return id;
  }
}
export const directoryVersion = (s: { dev: bigint; ino: bigint; mtimeNs: bigint; ctimeNs: bigint }) => `${s.dev}:${s.ino}:${s.mtimeNs}:${s.ctimeNs}`;
export const pageLimit = (limit: unknown) => { if (limit === undefined) return 80; if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new HostFileError('INVALID_REQUEST'); return Number(limit); };

export class ProjectRegistry {
  private roots = new Map<string, { path: string; identity?: Identity }>();
  private cursors = new DirectoryCursors();
  constructor(readonly store: GatewayStore, options: { allowedRoots: readonly { id: string; path: string }[] }) {
    for (const root of options.allowedRoots) {
      if (this.roots.has(root.id) || !isAbsolute(root.path) || normalize(root.path) !== root.path || root.path === '/' || root.path.endsWith('/')) throw new HostFileError('INVALID_ROOT');
      this.roots.set(root.id, { path: root.path });
    }
  }
  private async root(rootId: string) {
    const root = this.roots.get(rootId); if (!root) throw new HostFileError('PROJECT_UNAVAILABLE');
    const handle = await openCanonicalDirectory(root.path);
    try {
      const current = identity(await handle.stat({ bigint: true }));
      if (await realpath(root.path) !== root.path || root.identity && !sameIdentity(current, root.identity)) throw unavailable();
      root.identity ??= current;
      return { handle, path: root.path, identity: current };
    } catch { await handle.close(); throw new HostFileError('PROJECT_UNAVAILABLE'); }
  }
  get(projectId: string): Project {
    const p = this.store.getProject(projectId);
    if (!p || p.unregisteredAt !== null || !this.roots.has(p.rootId)) throw new HostFileError('PROJECT_UNAVAILABLE');
    return p;
  }
  async validate(projectId: string) {
    const opened = await this.openDirectory(projectId); try { await opened.check(); return opened.project; } finally { await opened.close(); }
  }
  async register(rootId: string, path: string, options: { operation?: { operationId: string; deviceId: string } } = {}) {
    const names = relativeParts(path); const root = await this.root(rootId);
    let handle = root.handle;
    try {
      for (const name of names) { const next = await open(fdPath(handle, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); await handle.close(); handle = next; }
      const canonicalPath = join(root.path, ...names), info = identity(await handle.stat({ bigint: true }));
      if (await realpath(canonicalPath) !== canonicalPath || !sameIdentity(info, identity(await lstat(canonicalPath, { bigint: true })))) throw unavailable();
      const prior = this.store.listProjects().find(p => p.canonicalPath === canonicalPath);
      if (prior) await this.validate(prior.id);
      return this.store.transaction(() => {
        if (options.operation) this.store.reserveOperation({ ...options.operation, projectId: prior?.id ?? null, kind: 'project.register' });
        const p = prior ?? this.store.insertProject({ canonicalPath, rootId, ...info });
        if (options.operation) {
          this.store.db.prepare('UPDATE operations SET project_id=? WHERE operation_id=?').run(p.id, options.operation.operationId);
          this.store.finishOperation(options.operation.operationId, 'accepted');
        }
        return this.public(p, true);
      });
    } catch (e) { if (e instanceof HostFileError) throw e; throw new HostFileError('PROJECT_UNAVAILABLE'); }
    finally { await handle.close(); }
  }
  unregister(id: string, options: { operation?: { operationId: string; deviceId: string } } = {}) {
    this.get(id);
    return this.store.transaction(() => {
      if (this.store.hasUnknownOperation(id)) throw new HostFileError('OPERATION_UNKNOWN', 'Unconfirmed project operations must be reviewed before unregistering.');
      if (options.operation) this.store.reserveOperation({ ...options.operation, projectId: id, kind: 'project.unregister' });
      this.store.unregisterProject(id);
      if (options.operation) this.store.finishOperation(options.operation.operationId, 'accepted');
      return { removed: true };
    });
  }
  private public(p: Project, available: boolean) { return { id: p.id, rootId: p.rootId, canonicalPath: p.canonicalPath, name: basename(p.canonicalPath), available }; }
  async list() {
    return Promise.all(this.store.listProjects().filter(p => p.unregisteredAt === null).map(async p => {
      let available = true; try { await this.validate(p.id); } catch { available = false; } return this.public(p, available);
    }));
  }
  isNested(projectId: string, path: string) { return this.store.listProjects().some(p => p.id !== projectId && p.unregisteredAt === null && p.canonicalPath === path); }
  async openDirectory(projectId: string, names: string[] = [], expected?: Identity[]) {
    const project = this.get(projectId), root = await this.root(project.rootId);
    const handles: FileHandle[] = [root.handle], pinned: { path: string; identity: Identity }[] = [];
    let current = root.handle;
    try {
      if (!inside(root.path, project.canonicalPath) || project.canonicalPath === root.path) throw unavailable();
      for (const name of relative(root.path, project.canonicalPath).split(sep)) {
        const next = await open(fdPath(current, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(next); current = next;
      }
      const info = identity(await current.stat({ bigint: true })); if (!sameIdentity(info, project)) throw unavailable();
      pinned.push({ path: project.canonicalPath, identity: info });
      for (const name of names) {
        if (!allowedName(name)) throw unavailable();
        const path = join(pinned.at(-1)!.path, name); if (this.isNested(projectId, path)) throw unavailable();
        const next = await open(fdPath(current, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(next); current = next;
        pinned.push({ path, identity: identity(await current.stat({ bigint: true })) });
      }
      const check = async () => {
        const active = this.get(projectId); if (!sameIdentity(active, project) || active.canonicalPath !== project.canonicalPath || active.rootId !== project.rootId) throw unavailable();
        if (await realpath(root.path) !== root.path || !sameIdentity(root.identity, identity(await lstat(root.path, { bigint: true }))) || await realpath(project.canonicalPath) !== project.canonicalPath) throw unavailable();
        for (const [i, item] of pinned.entries()) {
          const stat = await lstat(item.path, { bigint: true });
          if (!stat.isDirectory() || !sameIdentity(identity(stat), item.identity) || expected && (!expected[i] || !sameIdentity(item.identity, expected[i])) || i > 0 && this.isNested(projectId, item.path)) throw unavailable();
        }
      };
      await check();
      return { project, handle: current, identities: pinned.map(p => p.identity), check, close: async () => { for (const h of handles.reverse()) await h.close(); } };
    } catch { for (const h of handles.reverse()) await h.close().catch(() => {}); throw new HostFileError('PROJECT_UNAVAILABLE'); }
  }
  async queryDirectories(rootId: string, path = '', limit?: number, cursor?: string) {
    const names = relativeParts(path, true), count = pageLimit(limit), root = await this.root(rootId);
    let handle = root.handle;
    try {
      for (const name of names) { const next = await open(fdPath(handle, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); await handle.close(); handle = next; }
      const canonicalPath = join(root.path, ...names), info = await handle.stat({ bigint: true }), version = directoryVersion(info), scope = `${rootId}:${path}`;
      const after = this.cursors.read(cursor, scope, version), entries: { name: string; path: string }[] = [];
      let scanned = 0;
      for await (const e of await opendir(fdPath(handle), { bufferSize: 32 })) {
        if (++scanned > 4000) break;
        if (e.isDirectory() && allowedName(e.name) && e.name > after) entries.push({ name: e.name, path: [...names, e.name].join('/') });
      }
      if (await realpath(canonicalPath) !== canonicalPath || directoryVersion(await lstat(canonicalPath, { bigint: true })) !== version) throw unavailable();
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0); const page = entries.slice(0, count);
      return { rootId, path, entries: page, nextCursor: entries.length > count ? this.cursors.issue(scope, version, page.at(-1)!.name) : null, limited: scanned > 4000, canRegister: names.length > 0 };
    } catch (e) { if (e instanceof HostFileError) throw e; throw new HostFileError('PROJECT_UNAVAILABLE'); }
    finally { await handle.close(); }
  }
}
