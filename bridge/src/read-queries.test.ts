import { expect, it, vi } from 'vitest';
import { ReadQueries } from './read-queries';
import { retryRead } from '../../packages/shared/read-recovery';

it('deduplicates a hung read, releases its waiter on timeout and allows a fresh read', async () => {
  vi.useFakeTimers();
  try {
    const reads = new ReadQueries(100), read = vi.fn(() => new Promise<never>(() => {}));
    const a = reads.run('thread/read', { threadId: 't' }, read);
    expect(reads.run('thread/read', { threadId: 't' }, read)).toBe(a);
    const failed = expect(a).rejects.toThrow('只读查询超时');
    await vi.advanceTimersByTimeAsync(100); await failed;
    expect(read).toHaveBeenCalledTimes(1);
    await expect(reads.run('thread/read', { threadId: 't' }, async () => 'recovered')).resolves.toBe('recovered');
  } finally { vi.useRealTimers(); }
});
it('bounds recovery attempts and cancels a pending backoff without another read', async () => {
  vi.useFakeTimers();
  try {
    const read = vi.fn().mockRejectedValue(new Error('temporary')), controller = new AbortController();
    const result = expect(retryRead(read, controller.signal, [10, 20])).rejects.toThrow('temporary');
    await vi.advanceTimersByTimeAsync(30); await result; expect(read).toHaveBeenCalledTimes(3);
    const next = expect(retryRead(read, controller.signal, [100])).rejects.toThrow('stop');
    await vi.advanceTimersByTimeAsync(1); controller.abort(new Error('stop')); await next;
    expect(read).toHaveBeenCalledTimes(4);
  } finally { vi.useRealTimers(); }
});
