import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DirectoryListing, ProjectList } from '../../packages/shared/protocol';

type Registration = { cwd: string; dev: string; ino: string };
const inside = (root: string, path: string) => {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

// Roots are host policy, never renderer input. Browsing does not authorize a cwd.
// Registry metadata shares the private SQLite store; it contains no file content.
export class ProjectDirectories {
  constructor(readonly root: string, readonly defaultCwd: string, private db: DatabaseSync,
    private roots: readonly string[] = [root]) {
    db.exec('CREATE TABLE IF NOT EXISTS projects (cwd TEXT PRIMARY KEY, dev TEXT NOT NULL, ino TEXT NOT NULL)');
  }

  private path(value: unknown): string {
    if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4096 ||
      /[\x00-\x1f\x7f\\%]/.test(value) || normalize(value) !== value || value.endsWith('/')) {
      throw new Error('Expected a canonical absolute project directory');
    }
    return value;
  }
  private async directory(value: unknown, allowRoot = false) {
    const path = this.path(value);
    const root = this.roots.find(r => inside(r, path));
    if (!root || (!allowRoot && root === path)) throw new Error('Project is outside the allowed directory range');
    const hidden = (p: string) => relative(root, p).split(sep).some(part => part.startsWith('.'));
    if (hidden(path)) throw new Error('Hidden directories are not exposed');
    try {
      if (await realpath(root) !== root) throw new Error('Allowed directory root changed');
      const cwd = await realpath(path);
      if (!inside(root, cwd) || hidden(cwd) || (!allowRoot && cwd === root)) throw new Error('Project symlink escapes the allowed directory range');
      const info = await stat(cwd, { bigint: true });
      if (!info.isDirectory()) throw new Error('Project must be a directory');
      return { cwd, dev: String(info.dev), ino: String(info.ino), root };
    } catch (error) {
      // Filesystem errors can include a symlink target or other private paths.
      if (error && typeof error === 'object' && 'code' in error) throw new Error('Directory unavailable; refresh or remove the project');
      throw error;
    }
  }
  private registered(cwd: string) {
    return this.db.prepare('SELECT cwd, dev, ino FROM projects WHERE cwd=?').get(cwd) as Registration | undefined;
  }
  async resolve(value: unknown = this.defaultCwd): Promise<string> {
    const path = this.path(value);
    const directory = await this.directory(path);
    const saved = this.registered(path);
    if (!saved) throw new Error('Project is not registered; add this folder first');
    if (directory.cwd !== saved.cwd || directory.dev !== saved.dev || directory.ino !== saved.ino) {
      throw new Error('Project directory changed; remove it and explicitly add the folder again');
    }
    return directory.cwd;
  }
  async register(value: unknown) {
    const directory = await this.directory(value);
    // Never silently repair a stale canonical registration or retarget a saved path.
    const existingPath = this.registered(this.path(value));
    if (existingPath) await this.resolve(existingPath.cwd);
    const existing = this.registered(directory.cwd);
    if (existing) await this.resolve(existing.cwd);
    else this.db.prepare('INSERT OR IGNORE INTO projects VALUES (?, ?, ?)').run(directory.cwd, directory.dev, directory.ino);
    return { cwd: await this.resolve(directory.cwd), name: basename(directory.cwd) };
  }
  async unregister(value: unknown) {
    const cwd = this.path(value);
    if (cwd === this.defaultCwd) throw new Error('The host default project cannot be removed');
    this.db.prepare('DELETE FROM projects WHERE cwd=?').run(cwd);
    return { removed: true };
  }
  async list(): Promise<ProjectList> {
    const saved = this.db.prepare('SELECT cwd, dev, ino FROM projects ORDER BY cwd').all() as Registration[];
    const projects = await Promise.all(saved.map(async ({ cwd }) => {
      let available = true;
      try { await this.resolve(cwd); } catch { available = false; }
      return { cwd, name: basename(cwd), available };
    }));
    return { root: this.root, projects: projects.sort((a, b) => a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd)) };
  }
  async browse(value?: unknown, cursor?: unknown): Promise<DirectoryListing> {
    const roots: string[] = [];
    for (const root of this.roots) {
      try { await this.directory(root, true); roots.push(root); } catch { /* Unavailable policy roots confer no access. */ }
    }
    const directory = await this.directory(value ?? roots[0], true);
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 255 || /[/\\\x00-\x1f]/.test(cursor))) throw new Error('Invalid directory cursor');
    const entries = (await readdir(directory.cwd, { withFileTypes: true }))
      .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.') && (!cursor || e.name > String(cursor)))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const directories: { name: string; cwd: string }[] = [];
    const seen = new Set<string>();
    let nextCursor: string | null = null;
    // Bound both filesystem work and response size, including directories full of links.
    for (const entry of entries.slice(0, 200)) {
      try {
        const child = await this.directory(join(directory.cwd, entry.name));
        if (!seen.has(child.cwd)) { seen.add(child.cwd); directories.push({ name: basename(child.cwd), cwd: child.cwd }); }
      } catch { /* Do not expose files, hidden targets or escaping links. */ }
      nextCursor = entry.name;
    }
    // Recheck the directory before returning the result of the asynchronous scan.
    const current = await this.directory(directory.cwd, true);
    if (current.dev !== directory.dev || current.ino !== directory.ino) throw new Error('Directory changed; refresh');
    return { roots, cwd: directory.cwd, parent: directory.cwd === directory.root ? null : dirname(directory.cwd),
      directories, nextCursor: entries.length > 200 ? nextCursor : null, canRegister: directory.cwd !== directory.root };
  }
}
