import { execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { GatewayError } from './private-paths';

function executableFile(path: string): boolean {
  try { if (!statSync(path).isFile()) return false; accessSync(path, constants.X_OK); return true; }
  catch { return false; }
}

/** Resolve once in the installing user's environment; never pin a symlink's release target. */
export function resolveCodexExecutable(explicitPath?: string): string {
  let executable: string | undefined;
  if (explicitPath !== undefined) {
    if (typeof explicitPath !== 'string' || explicitPath.length > 4096 || /[\x00-\x1f\x7f]/.test(explicitPath) || !isAbsolute(explicitPath))
      throw new GatewayError('INVALID_CODEX_PATH', 400, 'Codex requires an absolute executable path: --codex /absolute/path/to/codex');
    executable = resolve(explicitPath);
    if (!executableFile(executable))
      throw new GatewayError('INVALID_CODEX_PATH', 400, 'Codex path must identify an executable file: --codex /absolute/path/to/codex');
  } else {
    // Empty/relative PATH entries depend on cwd and must not select a project-local executable.
    executable = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)
      .map(directory => resolve(directory, 'codex'))
      .filter(path => path.length <= 4096 && !/[\x00-\x1f\x7f]/.test(path)).find(executableFile);
    if (!executable)
      throw new GatewayError('CODEX_NOT_FOUND', 400, 'Codex CLI was not found in absolute PATH directories; install official Codex or use --codex /absolute/path/to/codex');
  }
  try {
    const version = execFileSync(executable, ['--version'], {
      encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!/^codex-cli \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid version response');
  } catch {
    // Child output can contain private information; do not include it or the raw process error.
    throw new GatewayError('CODEX_VERSION_FAILED', 400, 'Codex --version verification failed; check the executable or use --codex /absolute/path/to/codex');
  }
  return executable;
}
