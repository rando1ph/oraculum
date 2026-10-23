import { accessSync, constants, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { basePath, httpsOrigin } from '../../packages/shared/entry';
import { validateTrustSchema } from './trust-schema';

const resourceRoot = fileURLToPath(new URL('../../', import.meta.url));
export function absoluteSetting(env: NodeJS.ProcessEnv, key: string, fallback: string) {
  const value = env[key] ?? fallback;
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${key} must be an absolute path`);
  return resolve(value);
}
function xdg(env: NodeJS.ProcessEnv, key: string, fallback: string) {
  return env[key] && isAbsolute(env[key]) ? absoluteSetting(env, key, fallback) : fallback;
}
export function hostPaths(env: NodeJS.ProcessEnv = process.env) {
  const home = absoluteSetting(env, 'HOME', homedir());
  const resources = absoluteSetting(env, 'ORACULUM_RESOURCE_DIR', resourceRoot);
  const state = absoluteSetting(env, 'ORACULUM_STATE_DIR', join(xdg(env, 'XDG_STATE_HOME', join(home, '.local/state')), 'oraculum'));
  const workspaceRoot = join(xdg(env, 'XDG_DATA_HOME', join(home, '.local/share')), 'oraculum/workspaces');
  const legacyRoots = [...new Set([join(home, '.cache/oraculum/workspaces'),
    join(xdg(env, 'XDG_CACHE_HOME', join(home, '.cache')), 'oraculum/workspaces')])];
  return { resources, state, workspaceRoot, legacyRoots,
    projectRoots: [...new Set([join(home, 'Projects'), workspaceRoot, ...legacyRoots])],
    cwd: absoluteSetting(env, 'ORACULUM_WORKSPACE', join(workspaceRoot, 'local')),
    web: absoluteSetting(env, 'ORACULUM_WEB_DIR', join(resources, 'apps/web/dist')),
    themeSource: absoluteSetting(env, 'ORACULUM_THEME_SOURCE_DIR', join(resources, 'themes')),
    // Keep installed themes beside the selected database: never silently split an old installation.
    themeInstalled: absoluteSetting(env, 'ORACULUM_THEME_DIR', join(state, 'themes')) };
}
function info(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
// Validate every existing ancestor before mkdir/SQLite/spawn. No symlink retargeting.
export function checkDirectory(path: string) {
  const parent = dirname(path);
  if (parent !== path) checkDirectory(parent);
  const found = info(path);
  if (found?.isSymbolicLink()) throw new Error('Directory path contains a symlink; select its canonical location explicitly');
  if (found && !found.isDirectory()) throw new Error('Expected a directory; target conflicts with an existing file');
  return found;
}
export function selectStateDirectory(paths = hostPaths(), env: NodeJS.ProcessEnv = process.env) {
  const folder = checkDirectory(paths.state);
  const database = info(join(paths.state, 'trust.sqlite'));
  if (!database && folder && readdirSync(paths.state).length) throw new Error('State initialization target is not empty; select the existing store explicitly');
  const uid = process.geteuid?.();
  if (folder && ((folder.mode & 0o777) !== 0o700 || (uid !== undefined && folder.uid !== uid))) {
    throw new Error('State directory must be owned by this user with private writable permissions (0700)');
  }
  const writableDirectory = (path: string) => {
    const current = info(path)!;
    // Also honor mode bits when tests or an administrator run with extra privileges.
    if ((uid === undefined || current.uid === uid) && (current.mode & 0o300) !== 0o300) {
      throw new Error('State directory or its existing parent is not writable');
    }
    try { accessSync(path, constants.W_OK | constants.X_OK); }
    catch { throw new Error('State directory or its existing parent is not writable'); }
  };
  if (folder) writableDirectory(paths.state);
  else {
    let parent = dirname(paths.state);
    while (!info(parent)) parent = dirname(parent);
    writableDirectory(parent);
  }
  if (database) {
    if (!folder || !database.isFile() || database.nlink !== 1 || (database.mode & 0o777) !== 0o600 ||
      (uid !== undefined && database.uid !== uid)) {
      throw new Error('Selected state must be private (directory 0700 / database 0600) without links');
    }
    try { accessSync(join(paths.state, 'trust.sqlite'), constants.R_OK | constants.W_OK); }
    catch { throw new Error('Selected trust database is not readable and writable'); }
    // Only inspect schema metadata. A foreign/corrupt DB must not be initialized in place.
    const db = new DatabaseSync(join(paths.state, 'trust.sqlite'), { readOnly: true });
    try { validateTrustSchema(db); }
    finally { db.close(); }
    return paths.state;
  }
  if (env.ORACULUM_INIT_STATE !== '1') {
    throw new Error('No existing trust store selected. Set ORACULUM_STATE_DIR to the intended existing directory; only for a deliberate fresh installation set ORACULUM_INIT_STATE=1. No data was migrated.');
  }
  return paths.state;
}
const inside = (root: string, child: string) => {
  const path = relative(root, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path) && !path.split(sep).some(part => part.startsWith('.'));
};
export function startupPaths(env: NodeJS.ProcessEnv = process.env) {
  const paths = hostPaths(env);
  const port = Number(env.ORACULUM_PORT ?? 17860);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  const remoteOrigin = env.ORACULUM_REMOTE_ORIGIN ? httpsOrigin(env.ORACULUM_REMOTE_ORIGIN) : undefined;
  const remoteBasePath = basePath(env.ORACULUM_REMOTE_BASE_PATH);
  if (!remoteOrigin && remoteBasePath !== '/') throw new Error('Remote Base Path requires a remote origin');
  if (remoteOrigin && ['localhost', '127.0.0.1'].includes(new URL(remoteOrigin).hostname)) throw new Error('Remote access requires an exact remote HTTPS origin');
  if (!checkDirectory(paths.web) || !info(join(paths.web, 'index.html'))?.isFile()) throw new Error('Web resources missing; build Web UI or select ORACULUM_WEB_DIR');
  if (!checkDirectory(paths.themeSource)) throw new Error('Theme sources missing; select ORACULUM_THEME_SOURCE_DIR');
  accessSync(join(paths.web, 'index.html'), constants.R_OK);
  accessSync(paths.web, constants.R_OK | constants.X_OK);
  accessSync(paths.themeSource, constants.R_OK | constants.X_OK);
  checkDirectory(paths.themeInstalled);
  selectStateDirectory(paths, env);
  const root = paths.projectRoots.find(candidate => inside(candidate, paths.cwd));
  if (!root) throw new Error('Workspace must be inside an allowed host project root');
  const workspace = checkDirectory(paths.cwd);
  if (!env.ORACULUM_WORKSPACE && paths.legacyRoots.some(candidate => info(candidate))) {
    throw new Error('Legacy workspaces exist. Select ORACULUM_WORKSPACE explicitly; existing projects are never moved or replaced.');
  }
  if (!workspace && root !== paths.workspaceRoot && !paths.legacyRoots.includes(root)) throw new Error('Select an existing project directory under Projects');
  if (!workspace && !env.ORACULUM_WORKSPACE && info(join(paths.state, 'trust.sqlite'))) {
    throw new Error('Existing state requires an explicit ORACULUM_WORKSPACE or its existing default workspace; refusing to select an empty replacement');
  }
  if (workspace && realpathSync(paths.cwd) !== paths.cwd) throw new Error('Workspace must be canonical');
  return { ...paths, port, remoteOrigin, remoteBasePath };
}
