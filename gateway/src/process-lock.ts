import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GatewayError, privateDirectory, privateFile } from './private-paths';

// Linux flock locks the open file description. Passing this descriptor to the
// tiny util-linux helper acquires a lock retained by the parent descriptor after
// the helper exits. The kernel releases it on close/crash; never unlink the lock
// file, which would allow two processes to lock different inodes at one path.
export function acquireGatewayLock(stateDir: string): () => void {
  privateDirectory(stateDir);
  const path = join(stateDir, 'gateway.lock');
  const fd = openSync(path, constants.O_RDONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    privateFile(path);
    const stat = fstatSync(fd); const current = lstatSync(path);
    if (stat.ino !== current.ino || stat.dev !== current.dev || stat.nlink !== 1) throw new GatewayError('UNSAFE_STATE_PATH', 500, 'Gateway lock path changed');
    const result = spawnSync('flock', ['--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 5000 });
    if (result.error || result.status !== 0) throw new GatewayError('GATEWAY_ALREADY_RUNNING', 503, result.error ? 'Unable to acquire Gateway process lock; util-linux flock is required' : 'Another Gateway already owns this state directory');
    let released = false;
    return () => { if (!released) { released = true; closeSync(fd); } };
  } catch (error) { closeSync(fd); throw error; }
}
