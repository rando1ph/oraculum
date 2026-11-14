import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initGatewayConfig, loadGatewayConfig } from './config';
import { runCli } from './cli';

const roots: string[] = [];
const directory = () => { const root = mkdtempSync(join(tmpdir(), 'gateway-codex-init-')); roots.push(root); return root; };
function executable(path: string, body = "console.log('codex-cli 0.169.0');") {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return path;
}
const paths = (root: string) => ({ configPath: join(root, 'config/config.json'), stateDir: join(root, 'state') });
const cliArgs = (root: string) => ['init', '--config', paths(root).configPath, '--state-dir', paths(root).stateDir];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('Codex executable selection during user initialization', () => {
  it('persists the absolute PATH launcher without resolving its versioned symlink target', () => {
    const root = directory(), target = executable(join(root, 'releases/v1/codex'));
    const launcher = join(root, 'user bin/codex'); mkdirSync(dirname(launcher), { mode: 0o700 }); symlinkSync(target, launcher);
    vi.stubEnv('PATH', dirname(launcher));
    const config = initGatewayConfig(paths(root));
    expect(config.codexCommand).toBe(launcher);
    expect(loadGatewayConfig(paths(root).configPath).codexCommand).toBe(launcher);
    // A later launcher update and a service PATH without the user bin must work.
    unlinkSync(launcher); symlinkSync(executable(join(root, 'releases/v2/codex'), "console.log('codex-cli 0.170.0');"), launcher);
    const probe = spawnSync(config.codexCommand, ['--version'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    expect(probe.status).toBe(0); expect(probe.stdout.trim()).toBe('codex-cli 0.170.0');
  });

  it('accepts an explicit executable with spaces and shell characters as one literal path', () => {
    const root = directory(), launcher = executable(join(root, 'custom bin/codex ; $literal'));
    vi.stubEnv('PATH', '/nonexistent');
    const output: string[] = [];
    runCli([...cliArgs(root), '--codex', launcher], message => output.push(message));
    expect(loadGatewayConfig(paths(root).configPath).codexCommand).toBe(launcher);
    expect(JSON.parse(output[0]!).codexCommand).toBe(launcher);
    runCli(['status', '--config', paths(root).configPath], message => output.push(message));
    expect(JSON.parse(output[1]!).codexCommand).toBe(launcher);
  });

  it('ignores empty and relative PATH entries and skips non-executable files and directories', () => {
    const root = directory(); mkdirSync(join(root, 'directory/codex'), { recursive: true });
    const disabled = executable(join(root, 'disabled/codex')); chmodSync(disabled, 0o600);
    const launcher = executable(join(root, 'valid/codex'));
    vi.stubEnv('PATH', ['', '.', 'relative/bin', join(root, 'directory'), dirname(disabled), dirname(launcher)].join(':'));
    expect(initGatewayConfig(paths(root)).codexCommand).toBe(launcher);
  });

  it.each(['0.169.0', '0.170.0-alpha.2', '0.170.0-alpha.2+build.1', '1.0.0+commit.abc'])('accepts Codex release version %s without pinning a version', version => {
    const root = directory(), launcher = executable(join(root, 'codex'), `console.log(${JSON.stringify('codex-cli ' + version)});`);
    expect(initGatewayConfig({ ...paths(root), codexCommand: launcher }).codexCommand).toBe(launcher);
  });

  it('never persists or probes a PATH candidate containing control characters', () => {
    const root = directory(), marker = join(root, 'unexpected-probe');
    const launcher = executable(join(root, 'bad\nbin/codex'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran'); console.log('codex-cli 0.169.0');`);
    vi.stubEnv('PATH', dirname(launcher));
    expect(() => initGatewayConfig(paths(root))).toThrow(/Codex/);
    expect(existsSync(marker)).toBe(false); expect(existsSync(paths(root).configPath)).toBe(false);
  });

  it.each(['', '.:relative/bin', '/nonexistent'])('fails before creating configuration/state when PATH has no Codex: %s', path => {
    const root = directory(); vi.stubEnv('PATH', path);
    expect(() => runCli(cliArgs(root), () => {})).toThrow(/Codex.*--codex/i);
    expect(existsSync(paths(root).configPath)).toBe(false);
    expect(existsSync(paths(root).stateDir)).toBe(false);
  });

  it.each(['missing', 'directory', 'not-executable', 'broken-link', 'relative'])('rejects an invalid explicit executable before writing: %s', kind => {
    const root = directory(); let launcher = join(root, 'codex');
    if (kind === 'directory') mkdirSync(launcher);
    if (kind === 'not-executable') { executable(launcher); chmodSync(launcher, 0o600); }
    if (kind === 'broken-link') symlinkSync(join(root, 'absent'), launcher);
    if (kind === 'relative') launcher = './codex';
    expect(() => runCli([...cliArgs(root), '--codex', launcher], () => {})).toThrow(/Codex|absolute/i);
    expect(existsSync(paths(root).configPath)).toBe(false);
    expect(existsSync(paths(root).stateDir)).toBe(false);
  });

  it.each([
    "console.log('PRIVATE-PROBE-OUTPUT');",
    "console.error('PRIVATE-PROBE-OUTPUT'); process.exit(2);",
    "process.stdout.write('PRIVATE-PROBE-OUTPUT'.repeat(4000));",
  ])('rejects a bad/bounded version probe without exposing child output', body => {
    const root = directory(), launcher = executable(join(root, 'codex'), body);
    let message = '';
    try { initGatewayConfig({ ...paths(root), codexCommand: launcher }); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/Codex.*version/i); expect(message).not.toContain('PRIVATE-PROBE-OUTPUT');
    expect(existsSync(paths(root).configPath)).toBe(false);
  });

  it('bounds a hanging version probe and creates no partial installation', () => {
    const root = directory(), launcher = executable(join(root, 'codex'), 'setInterval(() => {}, 1000);');
    expect(() => initGatewayConfig({ ...paths(root), codexCommand: launcher })).toThrow(/Codex.*version/i);
    expect(existsSync(paths(root).configPath)).toBe(false);
  }, 10_000);

  it('refuses reinitialization before executing a replacement, preserving configuration and SQLite', () => {
    const root = directory(), launcher = executable(join(root, 'codex'));
    runCli([...cliArgs(root), '--codex', launcher], () => {});
    const before = readFileSync(paths(root).configPath), database = join(paths(root).stateDir, 'gateway.sqlite'), dbBefore = readFileSync(database);
    const marker = join(root, 'replacement-ran');
    const replacement = executable(join(root, 'replacement'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran'); console.log('codex-cli 0.170.0');`);
    expect(() => runCli([...cliArgs(root), '--codex', replacement], () => {})).toThrow(/exist/i);
    expect(existsSync(marker)).toBe(false); expect(readFileSync(paths(root).configPath)).toEqual(before); expect(readFileSync(database)).toEqual(dbBefore);
  });

  it('allows legacy bare-command configurations to be read without silently rewriting them', () => {
    const root = directory(), configPath = paths(root).configPath;
    const config = initGatewayConfig({ ...paths(root), codexCommand: executable(join(root, 'codex')) });
    writeFileSync(configPath, JSON.stringify({ ...config, codexCommand: 'codex' }));
    const before = readFileSync(configPath); vi.stubEnv('PATH', '/nonexistent');
    expect(loadGatewayConfig(configPath).codexCommand).toBe('codex');
    expect(readFileSync(configPath)).toEqual(before);
  });

  it.each([['status'], ['pair'], ['devices', 'list']])('accepts --codex only for init: %j', (...command) => {
    const root = directory();
    expect(() => runCli([...command, '--config', paths(root).configPath, '--codex', '/unused/codex'], () => {})).toThrow(/Only init/);
  });
});
