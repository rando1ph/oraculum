import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { ProjectDirectories } from './projects';

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), 'oraculum-registry-'));
  cleanup.push(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'managed'), host = join(temp, 'Projects'), cwd = join(root, 'local');
  const first = join(host, 'alpha'), second = join(host, 'nested', 'alpha');
  await Promise.all([cwd, first, second].map(p => mkdir(p, { recursive: true })));
  const dbPath = join(temp, 'projects.sqlite');
  const db = new DatabaseSync(dbPath); cleanup.push(() => db.close());
  const projects = new ProjectDirectories(root, cwd, db, [root, host]);
  await projects.register(cwd);
  return { temp, root, host, cwd, first, second, projects, dbPath };
}

it('browses names and paths only; explicit canonical registrations persist and distinguish same names', async () => {
  const { root, host, first, second, cwd, projects, dbPath } = await fixture();
  await writeFile(join(host, 'secret.txt'), 'never expose file contents');
  await mkdir(join(host, '.private'));
  await symlink(first, join(host, 'alias'));
  const listing = await projects.browse(host);
  expect(listing.directories.map(d => d.name)).toEqual(['alpha', 'nested']);
  expect(JSON.stringify(listing)).not.toMatch(/secret|private/);
  await expect(projects.resolve(first)).rejects.toThrow('registered');
  await projects.register(first); await projects.register(join(host, 'alias')); await projects.register(second);
  expect((await projects.list()).projects.map(p => p.cwd).sort()).toEqual([cwd, first, second].sort());
  const db = new DatabaseSync(dbPath); cleanup.push(() => db.close());
  const restarted = new ProjectDirectories(root, cwd, db, [root, host]);
  expect(await restarted.resolve(first)).toBe(first);
  expect((await restarted.list()).projects.filter(p => p.name === 'alpha')).toHaveLength(2);
});

it('rejects malformed, hidden, file, traversal and escaping symlink paths without leaking targets', async () => {
  const { temp, host, first, projects } = await fixture();
  await symlink(temp, join(host, 'escape'));
  await writeFile(join(host, 'file'), 'private');
  for (const path of [undefined, '', '/', temp, host + '-sibling', '../alpha', host + '/../', host + '/%2e%2e', host + '//alpha', host + '/.ssh', host + '/alpha\0', host + '/file', host + '/escape']) {
    await expect(projects.register(path)).rejects.toThrow();
  }
  for (const path of ['/', host + '/..', host + '/escape', host + '/file']) await expect(projects.browse(path)).rejects.toThrow();
  await expect(projects.register(host)).rejects.toThrow();
  expect((await projects.browse(host)).directories.map(d => d.cwd)).toContain(first);
  expect(JSON.stringify(await projects.browse(host))).not.toContain('escape');
});

it('fails closed for removal, replacement, retargeting and root changes, across restart', async () => {
  const { root, host, cwd, first, second, projects, dbPath } = await fixture();
  await projects.register(first); await projects.register(second);
  await rename(first, first + '-moved'); await mkdir(first);
  await expect(projects.resolve(first)).rejects.toThrow('changed');
  await expect(projects.register(first)).rejects.toThrow('changed');
  expect((await projects.list()).projects.find(p => p.cwd === first)?.available).toBe(false);
  await rm(second, { recursive: true });
  await expect(projects.resolve(second)).rejects.toThrow();
  const db = new DatabaseSync(dbPath); cleanup.push(() => db.close());
  const restarted = new ProjectDirectories(root, cwd, db, [root, host]);
  await expect(restarted.resolve(first)).rejects.toThrow('changed');
  await projects.unregister(first);
  await expect(projects.resolve(first)).rejects.toThrow('registered');
  await projects.register(first);
  await rename(first, first + '-replacement'); await symlink(first + '-replacement', first);
  await expect(projects.resolve(first)).rejects.toThrow('changed');
  await rename(host, host + '-moved'); await symlink(host + '-moved', host);
  await expect(projects.browse(host)).rejects.toThrow();
});

it('paginates bounded directory lists without granting execution permission', async () => {
  const { host, projects } = await fixture();
  await Promise.all(Array.from({ length: 205 }, (_, i) => mkdir(join(host, `dir-${String(i).padStart(3, '0')}`))));
  const first = await projects.browse(host);
  expect(first.directories).toHaveLength(200);
  expect(first.nextCursor).toBeTruthy();
  const second = await projects.browse(host, first.nextCursor);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.directories, ...second.directories].map(d => d.cwd)).size).toBe(207);
  await expect(projects.resolve(first.directories[0].cwd)).rejects.toThrow('registered');
});
