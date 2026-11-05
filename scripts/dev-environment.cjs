const { existsSync, lstatSync } = require('node:fs');
const { resolve, join, dirname, relative, isAbsolute, sep } = require('node:path');
const { homedir } = require('node:os');
const { loadRuntimeConfig } = require('../packaging/runtime-config.cjs');

const overlaps = (a, b) => [relative(a, b), relative(b, a)].some(p => !p || (!isAbsolute(p) && p !== '..' && !p.startsWith('..' + sep)));
function canonical(path) {
  if (!isAbsolute(path)) throw new Error('Development paths must be absolute');
  path = resolve(path);
  for (let p = path; ; p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('Development paths must not contain symlinks');
    if (p === dirname(p)) break;
  }
  return path;
}
function developmentEnvironment(env = process.env, repository = resolve(__dirname, '..'), productionEnvironments = []) {
  // Read installed configuration separately. Test overrides can never hide its paths.
  const installed = { HOME: homedir(), PATH: env.PATH };
  loadRuntimeConfig(installed);
  const protectedPaths = [join(homedir(), '.local/state/oraculum'), join(homedir(), '.local/share/oraculum'),
    join(homedir(), '.config/oraculum'), ...[installed, ...productionEnvironments].flatMap(e =>
      ['ORACULUM_STATE_DIR', 'ORACULUM_WORKSPACE', 'ORACULUM_THEME_DIR', 'ORACULUM_USER_DATA_DIR'].map(k => e[k]).filter(Boolean))].map(canonical);
  const root = canonical(env.ORACULUM_DEV_ROOT || join(repository, '.local/development'));
  if (protectedPaths.some(p => overlaps(root, p))) throw new Error('Development root overlaps production data or workspace');
  const next = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('ORACULUM_') && !k.startsWith('XDG_')));
  Object.assign(next, { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'),
    XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
    // Keep native configuration inheritance; never copy credentials into test state.
    CODEX_HOME: env.CODEX_HOME || join(homedir(), '.codex'), ORACULUM_RESOURCE_DIR: repository,
    ORACULUM_PORT: env.ORACULUM_PORT || '17861', ORACULUM_DEV_ROOT: root });
  for (const [key, suffix] of Object.entries({ ORACULUM_STATE_DIR: 'state/bridge', ORACULUM_WORKSPACE: 'data/oraculum/workspaces/test',
    ORACULUM_THEME_DIR: 'state/bridge/themes', ORACULUM_USER_DATA_DIR: 'profile' })) {
    const path = canonical(env[key] || join(root, suffix));
    const rel = relative(root, path);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) || protectedPaths.some(p => overlaps(path, p))) throw new Error(`${key} must be inside the isolated development root`);
    next[key] = path;
  }
  for (const key of ['ORACULUM_WEB_DIR', 'ORACULUM_THEME_SOURCE_DIR', 'ORACULUM_CODEX_BIN', 'ORACULUM_REMOTE_ORIGIN', 'ORACULUM_REMOTE_BASE_PATH']) if (env[key]) next[key] = env[key];
  // Only an empty, explicitly isolated target may be initialized by startupPaths.
  if (!existsSync(join(next.ORACULUM_STATE_DIR, 'trust.sqlite'))) next.ORACULUM_INIT_STATE = '1';
  return next;
}
module.exports = { developmentEnvironment };
