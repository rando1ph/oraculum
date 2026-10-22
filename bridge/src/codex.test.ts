import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ spawn: vi.fn(), execFileSync: vi.fn() }));
vi.mock('node:child_process', () => native);
import { Codex } from './codex';

it('inherits native configuration and environment without rewriting feature or MCP settings', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  child.stdin.on('finish', () => child.emit('exit', 0));
  native.execFileSync.mockReturnValueOnce('codex-cli 0.160.0\n').mockReturnValue('[]');
  native.spawn.mockReturnValue(child);
  const codex = new Codex('/native-project');
  try {
    expect(native.execFileSync).toHaveBeenCalledExactlyOnceWith('codex', ['--version'], { encoding: 'utf8' });
    expect(native.spawn).toHaveBeenCalledExactlyOnceWith('codex', ['app-server', '--listen', 'stdio://'], {
      cwd: '/native-project', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } finally { await codex.close(); }
});
