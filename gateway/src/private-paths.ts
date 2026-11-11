import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

export class GatewayError extends Error {
  constructor(readonly code: string, readonly statusCode: number, message: string) {
    super(message);
    this.name = 'GatewayError';
  }
}

const unsafe = () => new GatewayError('UNSAFE_STATE_PATH', 500, 'Gateway state/config path must be private, owned by this user, and contain no symbolic or hard links');
const uid = () => process.getuid?.();

// Walk every existing ancestor; checking only the leaf would follow a symlink
// in its parent. The shared sticky /tmp ancestor is allowed for isolated tests.
export function checkAncestors(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw unsafe();
  const root = parse(path).root;
  let current = root;
  for (const component of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== uid() && stat.uid !== 0)) throw unsafe();
    if ((stat.mode & 0o022) && !(stat.uid === 0 && (stat.mode & 0o1000))) throw unsafe();
  }
}

export function privateDirectory(path: string, create = false): void {
  if (!isAbsolute(path) || resolve(path) !== path || path === parse(path).root) throw unsafe();
  const root = parse(path).root;
  let current = root;
  for (const component of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, component);
    try { lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
      mkdirSync(current, { mode: 0o700 });
    }
    checkAncestors(current);
  }
  const stat = lstatSync(path);
  if (stat.uid !== uid() || (stat.mode & 0o077) || !(stat.mode & 0o700)) throw unsafe();
}

export function privateFile(path: string): void {
  checkAncestors(dirname(path));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid() || stat.nlink !== 1 || (stat.mode & 0o077)) throw unsafe();
}

export function createPrivateFile(path: string): number {
  privateDirectory(dirname(path));
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid() || stat.nlink !== 1 || (stat.mode & 0o077)) throw unsafe();
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
