import { closeSync, fsyncSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultConfigPath, defaultStateDir, initGatewayConfig, loadGatewayConfig } from './config';
import { createPrivateFile } from './private-paths';
import { GatewayStore, UUID_PATTERN } from './store';

const usage = 'Usage: oraculum init [--config path] [--state-dir path] [--root id=/absolute/path] [--port number] [--codex /absolute/path] | status | pair | devices list | devices revoke <device-id> (all commands accept --config)';

export function runCli(args: string[], output: (message: string) => void = console.log): void {
  let configPath = defaultConfigPath(); let stateDir: string | undefined; let port: number | undefined; let codexCommand: string | undefined;
  const roots: { id: string; path: string }[] = []; const words: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    if (['--config', '--state-dir', '--root', '--port', '--codex'].includes(word)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(usage);
      if (word === '--config') configPath = resolve(value);
      if (word === '--state-dir') stateDir = resolve(value);
      if (word === '--port') port = Number(value);
      if (word === '--codex') codexCommand = value;
      if (word === '--root') {
        const separator = value.indexOf('=');
        roots.push(separator < 0 ? { id: `root${roots.length + 1}`, path: resolve(value) } : { id: value.slice(0, separator), path: resolve(value.slice(separator + 1)) });
      }
    } else if (word.startsWith('-')) throw new Error(usage);
    else words.push(word);
  }
  const [command, subcommand, id] = words;
  if (command === 'init' && words.length === 1) {
    // Config creation is exclusive; an existing installation is never reset.
    const config = initGatewayConfig({ configPath, stateDir: stateDir ?? defaultStateDir(), allowedRoots: roots, port, codexCommand });
    const store = new GatewayStore(config.stateDir, { create: true });
    try { output(JSON.stringify({ initialized: true, installationId: store.installationId, configPath, stateDir: config.stateDir, allowedRoots: config.allowedRoots, codexCommand: config.codexCommand }, null, 2)); }
    finally { store.close(); }
    return;
  }
  if (stateDir || port !== undefined || roots.length || codexCommand !== undefined) throw new Error('Only init accepts --state-dir, --root, --port, and --codex; other commands read the private config');
  if (!((command === 'status' || command === 'pair') && words.length === 1) && !(command === 'devices' && ((subcommand === 'list' && words.length === 2) || (subcommand === 'revoke' && words.length === 3 && UUID_PATTERN.test(id!))))) throw new Error(usage);
  const config = loadGatewayConfig(configPath);
  const store = new GatewayStore(config.stateDir);
  try {
    if (command === 'status') output(JSON.stringify({ initialized: true, installationId: store.installationId, schemaVersion: 1, configPath, stateDir: config.stateDir, codexCommand: config.codexCommand, endpoint: `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port}${config.basePath}`, devices: store.listDevices().filter(device => device.revokedAt === null).length, registeredProjects: store.listProjects().length, serviceState: 'not-probed' }, null, 2));
    else if (command === 'pair') {
      const { code, expiresAt } = store.createPairing();
      // A private file works both on a terminal and in automation without
      // accidentally copying the one-use secret to redirected CLI logs.
      const path = join(config.stateDir, `pairing-${Date.now()}-${process.pid}.txt`);
      const fd = createPrivateFile(path);
      try { writeFileSync(fd, `${code}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      output(JSON.stringify({ pairingFile: path, expiresAt, installationId: store.installationId }, null, 2));
    } else if (subcommand === 'list') output(JSON.stringify(store.listDevices(), null, 2));
    else if (subcommand === 'revoke') {
      if (!store.revokeDevice(id!)) throw new Error('Unknown device ID');
      output('Device revoked. Existing connections recheck trust at least once per second.');
    }
  } finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { runCli(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Gateway CLI failed'); process.exitCode = 1; }
}
