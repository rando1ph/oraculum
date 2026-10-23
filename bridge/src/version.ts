import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

export function codexExecutable() {
  const configured = process.env.ORACULUM_CODEX_BIN;
  if (configured !== undefined && !isAbsolute(configured)) {
    throw new Error('ORACULUM_CODEX_BIN must be an absolute executable path');
  }
  return configured ?? 'codex';
}

// The reviewed schema lock is a build input, never a runtime version gate.
export function readCodexVersion(binary = codexExecutable()) {
  let version: string;
  try {
    version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 }).trim();
  } catch {
    throw new Error('Cannot read Codex CLI version; check ORACULUM_CODEX_BIN or PATH and executable permissions');
  }
  if (!version || version.includes('\n') || version.includes('\r')) throw new Error('Codex CLI returned an invalid version response');
  return version;
}
