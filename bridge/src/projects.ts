import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import type { ProjectList } from '../../packages/shared/protocol';

// The host chooses this root at startup. The renderer can select directories
// within it, but cannot turn a path picker into arbitrary host filesystem access.
export class ProjectDirectories {
  constructor(readonly root: string, readonly defaultCwd: string) {}

  async resolve(value: unknown = this.defaultCwd): Promise<string> {
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
      throw new Error('Expected an absolute project directory');
    }
    const inside = (path: string) => {
      const child = relative(this.root, path);
      return !!child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
    };
    if (!inside(value)) throw new Error('Project is outside the managed workspace root');
    const cwd = await realpath(value);
    if (!inside(cwd)) throw new Error('Project symlink escapes the managed workspace root');
    if (!(await stat(cwd)).isDirectory()) throw new Error('Project must be a directory');
    return cwd;
  }

  async list(): Promise<ProjectList> {
    const projects = new Map<string, { cwd: string; name: string }>();
    const add = async (path: string) => {
      try {
        const cwd = await this.resolve(path);
        projects.set(cwd, { cwd, name: basename(cwd) });
      } catch { /* Deleted directories and escaping symlinks are not selectable. */ }
    };
    await add(this.defaultCwd);
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) await add(join(this.root, entry.name));
    }
    return { root: this.root, projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  }
}
