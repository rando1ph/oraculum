const { accessSync, constants, lstatSync } = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function info(file) {
  try { return lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function directoryChain(directory) {
  const parts = directory.split(path.sep).filter(Boolean);
  let current = path.parse(directory).root;
  let last = current;
  for (const part of parts) {
    current = path.join(current, part);
    const entry = info(current);
    if (!entry) return { exists: false, last };
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Desktop profile path contains a symlink or non-directory');
    // Host-managed user groups may share ancestors (for example 0775 Projects).
    // Reject public write access except sticky roots; the profile itself stays private.
    if ((entry.mode & 0o002) && !(entry.mode & 0o1000)) throw new Error('Desktop profile parent permissions are unsafe');
    last = current;
  }
  return { exists: true, last };
}

function profilePath(env) {
  let selected;
  if (env.ORACULUM_USER_DATA_DIR !== undefined) {
    selected = absolute(env.ORACULUM_USER_DATA_DIR, 'ORACULUM_USER_DATA_DIR');
  } else {
    const home = absolute(env.HOME ?? homedir(), 'HOME');
    // XDG directories must be absolute; unset/relative values use the HOME default.
    const config = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
      ? absolute(env.XDG_CONFIG_HOME, 'XDG_CONFIG_HOME') : path.join(home, '.config');
    selected = path.join(config, 'oraculum');
    const legacy = [...new Set([path.join(config, 'oraculum-phase0b'), path.join(home, '.config/oraculum-phase0b')])];
    if (legacy.some(candidate => info(candidate))) {
      throw new Error('Legacy Desktop profile detected; explicitly select ORACULUM_USER_DATA_DIR. Profile migration requires a separate approved backup and migration.');
    }
    if (!info(selected)) {
      throw new Error('No existing Desktop profile selected; set ORACULUM_USER_DATA_DIR explicitly to an existing profile or a deliberate new profile. No data has been migrated.');
    }
  }
  const chain = directoryChain(selected);
  if (chain.exists) {
    const entry = info(selected);
    if ((typeof process.getuid === 'function' && entry.uid !== process.getuid()) || (entry.mode & 0o077)) {
      throw new Error('Desktop profile must be owned by this user with private permissions');
    }
  }
  if (!(info(chain.last).mode & 0o200)) throw new Error('Desktop profile directory is not writable');
  accessSync(chain.last, constants.R_OK | constants.W_OK | constants.X_OK);
  return selected;
}

// Read-only preflight. Electron creates only a deliberately selected new
// profile; this module never copies, removes or changes existing user data.
function desktopPaths(env = process.env) {
  const resourceRoot = absolute(env.ORACULUM_RESOURCE_DIR ?? path.resolve(__dirname, '../..'), 'ORACULUM_RESOURCE_DIR');
  const icon = absolute(env.ORACULUM_DESKTOP_ICON ?? path.join(resourceRoot, 'design/reference/02_Brand_OracleEye_App_Icon.png'), 'ORACULUM_DESKTOP_ICON');
  const iconInfo = info(icon);
  if (!iconInfo || iconInfo.isSymbolicLink() || !iconInfo.isFile()) throw new Error('Desktop icon is missing or not a regular file; configure ORACULUM_RESOURCE_DIR or ORACULUM_DESKTOP_ICON');
  accessSync(icon, constants.R_OK);
  return { userData: profilePath(env), icon };
}

module.exports = { desktopPaths };
