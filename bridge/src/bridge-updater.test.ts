import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('exercises isolated APT source, backup, rollback, service transition and real DEB safety cases', () => {
  const result = execFileSync('python3', [fileURLToPath(new URL('../../scripts/bridge-update.test.py', import.meta.url))], { encoding: 'utf8' });
  expect(result).toBe('');
}, 30_000);
