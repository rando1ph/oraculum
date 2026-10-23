const { readFileSync, lstatSync } = require('node:fs');
const { join, isAbsolute } = require('node:path');
const { homedir } = require('node:os');

// One private, non-executable configuration shared by the desktop and user service.
// Environment overrides remain useful for isolated validation and deployments.
function loadRuntimeConfig(env = process.env) {
  const home = env.HOME || homedir();
  const configHome = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, '.config');
  const file = env.ORACULUM_CONFIG_FILE || join(configHome, 'oraculum/runtime.json');
  if (!isAbsolute(file)) throw new Error('ORACULUM_CONFIG_FILE must be absolute');
  let stat;
  try { stat = lstatSync(file); } catch (error) { if (error.code !== 'ENOENT' || env.ORACULUM_CONFIG_FILE) throw error; }
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.uid !== process.getuid()) {
      throw new Error('Runtime configuration must be a private, user-owned regular file (0600)');
    }
    const values = JSON.parse(readFileSync(file, 'utf8'));
    const allowed = new Set(['ORACULUM_STATE_DIR', 'ORACULUM_WORKSPACE', 'ORACULUM_USER_DATA_DIR',
      'ORACULUM_THEME_DIR', 'ORACULUM_THEME_SOURCE_DIR', 'ORACULUM_CODEX_BIN', 'ORACULUM_PORT',
      'ORACULUM_REMOTE_ORIGIN', 'ORACULUM_REMOTE_BASE_PATH', 'CODEX_HOME', 'PATH']);
    if (!values || Array.isArray(values) || typeof values !== 'object') throw new Error('Invalid runtime configuration');
    for (const [key, value] of Object.entries(values)) {
      if (!allowed.has(key) || typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid runtime configuration key or value');
      if (env[key] === undefined) env[key] = value;
    }
  }
  // systemd's environment often lacks the official user's CLI installation.
  env.PATH = [...new Set([...(env.PATH || '/usr/local/bin:/usr/bin:/bin').split(':'), join(home, '.local/bin')])].join(':');
  return file;
}
module.exports = { loadRuntimeConfig };
