import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createPrivateFile, GatewayError, privateDirectory, privateFile } from './private-paths';
import { resolveCodexExecutable } from './codex-executable';

export interface GatewayConfig {
  configVersion: 2;
  stateDir: string;
  host: '127.0.0.1' | '::1';
  port: number;
  basePath: string;
  externalOrigin: string | null;
  allowedRoots: { id: string; path: string }[];
  codexCommand: string;
}

export const defaultConfigPath = () => process.env.ORACULUM_GATEWAY_CONFIG ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'oraculum-gateway', 'config.json');
export const defaultStateDir = () => join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'oraculum-gateway');
const invalid = (message: string) => new GatewayError('INVALID_CONFIG', 500, message);

export function validateGatewayConfig(value: unknown): GatewayConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Gateway config must be an object');
  const config = value as GatewayConfig;
  const keys = ['configVersion', 'stateDir', 'host', 'port', 'basePath', 'externalOrigin', 'allowedRoots', 'codexCommand'];
  if (Object.keys(config).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(config, key)) || config.configVersion !== 2) throw invalid('Unsupported Gateway configuration format');
  if (typeof config.stateDir !== 'string' || !isAbsolute(config.stateDir) || resolve(config.stateDir) !== config.stateDir || ['/', homedir()].includes(config.stateDir)) throw invalid('stateDir must be a separate absolute private directory');
  if (!['127.0.0.1', '::1'].includes(config.host) || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw invalid('Gateway must use a loopback host and a valid port');
  if (typeof config.basePath !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(config.basePath) || config.basePath.length > 160) throw invalid('basePath must be / or slash-delimited path segments ending in /');
  if (config.externalOrigin !== null) {
    if (typeof config.externalOrigin !== 'string') throw invalid('externalOrigin must be an HTTPS origin');
    try {
      const url = new URL(config.externalOrigin);
      if (url.protocol !== 'https:' || url.origin !== config.externalOrigin || url.username || url.password) throw invalid('externalOrigin must be an HTTPS origin without path or credentials');
    } catch { throw invalid('externalOrigin must be an HTTPS origin without path or credentials'); }
  }
  if (!Array.isArray(config.allowedRoots) || config.allowedRoots.length > 32) throw invalid('allowedRoots must contain at most 32 explicit host roots');
  const seen = new Set<string>();
  for (const root of config.allowedRoots) {
    if (!root || typeof root !== 'object' || Object.keys(root).sort().join(',') !== 'id,path' || typeof root.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(root.id) || seen.has(root.id) || typeof root.path !== 'string' || !isAbsolute(root.path) || resolve(root.path) !== root.path || root.path === '/') throw invalid('Each allowed root needs a unique id and an absolute non-root path');
    seen.add(root.id);
  }
  if (typeof config.codexCommand !== 'string' || !config.codexCommand || config.codexCommand.length > 4096 || /[\x00-\x1f\x7f]/.test(config.codexCommand)) throw invalid('codexCommand must name one executable, without arguments');
  return config;
}

export function loadGatewayConfig(path = defaultConfigPath()): GatewayConfig {
  privateDirectory(dirname(path));
  privateFile(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd); const current = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.dev !== current.dev || stat.ino !== current.ino || stat.size > 64 * 1024) throw invalid('Unsafe Gateway configuration file');
    return validateGatewayConfig(JSON.parse(readFileSync(fd, 'utf8')) as unknown);
  } finally { closeSync(fd); }
}

export function initGatewayConfig(options: { configPath?: string; stateDir?: string; allowedRoots?: { id: string; path: string }[]; port?: number; basePath?: string; externalOrigin?: string | null; codexCommand?: string } = {}): GatewayConfig {
  const configPath = options.configPath ?? defaultConfigPath();
  // Refuse existing files (including dangling symlinks) before probing any replacement executable.
  try { lstatSync(configPath); throw new GatewayError('CONFIG_ALREADY_EXISTS', 409, 'Gateway configuration already exists; init never replaces an existing installation'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const config = validateGatewayConfig({ configVersion: 2, stateDir: options.stateDir ?? defaultStateDir(), host: '127.0.0.1', port: options.port ?? 8790, basePath: options.basePath ?? '/', externalOrigin: options.externalOrigin ?? null, allowedRoots: options.allowedRoots ?? [], codexCommand: options.codexCommand ?? 'codex' });
  config.codexCommand = resolveCodexExecutable(options.codexCommand);
  privateDirectory(dirname(configPath), true);
  const fd = createPrivateFile(configPath);
  try { writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`, 'utf8'); fsyncSync(fd); }
  finally { closeSync(fd); }
  return config;
}
