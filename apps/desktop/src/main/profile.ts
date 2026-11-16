import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';

export type ProfileKind = 'development' | 'production';
export type DesktopProfile = { directory: string; session: string; logs: string; crashDumps: string; kind: ProfileKind };
const MARKER = '.oraculum-desktop-v2';

function invalid(): never { throw new Error('DESKTOP_PROFILE_UNSAFE'); }

function owner(): number { return process.getuid!(); }

/** Unlike existsSync, a dangling symlink is an existing, unsafe entry. */
export function entryExists(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function assertPrivateDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== owner()
    || (stat.mode & 0o077) !== 0 || (stat.mode & 0o700) !== 0o700) invalid();
}

/** Create only missing directories; never chmod, follow links, or import data. */
function prepareChain(directory: string): void {
  let current = parse(directory).root;
  for (const part of directory.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // mkdir is intentionally exclusive: a concurrent replacement is a failure.
      mkdirSync(current, { mode: 0o700 });
      stat = lstatSync(current);
      assertPrivateDirectory(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
    // Sticky shared roots such as /tmp are safe for user-owned private children.
    if ((stat.mode & 0o022) && !(stat.mode & 0o1000)) invalid();
    if (stat.uid !== 0 && stat.uid !== owner()) invalid();
  }
}

export function assertPrivateFile(file: string, maxBytes: number): void {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== owner()
    || (stat.mode & 0o077) !== 0 || (stat.mode & 0o600) !== 0o600 || stat.size > maxBytes) invalid();
}

export function readPrivateFile(file: string, maxBytes: number): Buffer {
  assertPrivateFile(file, maxBytes);
  const before = lstatSync(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1) invalid();
    const bytes = readFileSync(fd);
    if (bytes.length > maxBytes) invalid();
    return bytes;
  } finally { closeSync(fd); }
}

export function prepareProfile(packaged: boolean, env: NodeJS.ProcessEnv = process.env): DesktopProfile {
  try {
    const kind: ProfileKind = packaged ? 'production' : 'development';
    const slug = env.ORACULUM_DESKTOP_PROFILE;
    if (slug !== undefined && !/^[a-z0-9][a-z0-9-]{0,47}$/.test(slug)) invalid();
    const home = env.HOME || homedir();
    if (!isAbsolute(home) || home.includes('\0')) invalid();
    const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME : join(home, '.config');
    if (config.includes('\0')) invalid();
    const namespace = resolve(config, 'oraculum-desktop-v2');
    const directory = join(namespace, slug ? `${kind}-${slug}` : kind);
    prepareChain(namespace);
    assertPrivateDirectory(namespace);
    prepareChain(directory);
    assertPrivateDirectory(directory);
    const marker = join(directory, MARKER);
    const expected = JSON.stringify({ version: 1, profile: kind }) + '\n';
    if (!entryExists(marker)) {
      // Do not adopt an unknown nonempty directory merely because its name fits.
      if (readdirSync(directory).length !== 0) invalid();
      const fd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, expected); fsyncSync(fd); } finally { closeSync(fd); }
    }
    if (readPrivateFile(marker, 256).toString('utf8') !== expected) invalid();
    const session = join(directory, 'chromium');
    const logs = join(directory, 'logs');
    const crashDumps = join(directory, 'crashes');
    for (const path of [session, logs, crashDumps]) {
      prepareChain(path);
      assertPrivateDirectory(path);
    }
    return { directory, session, logs, crashDumps, kind };
  } catch { return invalid(); }
}
