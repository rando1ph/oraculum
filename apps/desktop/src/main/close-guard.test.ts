import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloseGuard } from './close-guard';

afterEach(() => vi.useRealTimers());
function fixture(confirm = false) {
  vi.useFakeTimers();
  const notify = vi.fn(), discard = vi.fn(async () => confirm), close = vi.fn();
  return { notify, discard, close, guard: new CloseGuard(notify, discard, close, 100) };
}
describe('bounded draft flush before close', () => {
  it('waits for a matching saved acknowledgement, coalescing duplicate close requests', async () => {
    const f = fixture(); f.guard.request(); f.guard.request();
    expect(f.notify).toHaveBeenCalledTimes(1); expect(f.close).not.toHaveBeenCalled();
    f.guard.acknowledge('11111111-1111-4111-8111-111111111111', true);
    expect(f.close).not.toHaveBeenCalled();
    f.guard.acknowledge(f.notify.mock.calls[0][0], true);
    expect(f.guard.canClose).toBe(true); expect(f.close).toHaveBeenCalledTimes(1); expect(f.discard).not.toHaveBeenCalled();
    await vi.runAllTimersAsync(); expect(f.close).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])('timeout requires native discard choice %s and never silently closes', async choice => {
    const f = fixture(choice); f.guard.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.discard).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalledTimes(choice ? 1 : 0);
    if (!choice) { f.guard.request(); expect(f.notify).toHaveBeenCalledTimes(2); f.guard.dispose(); }
  });
  it('failed flush, failed confirmation and stale acknowledgement retain the window', async () => {
    const f = fixture(); f.discard.mockRejectedValueOnce(new Error('dialog failed')); f.guard.request();
    const id = f.notify.mock.calls[0][0]; f.guard.acknowledge(id, false); f.guard.acknowledge(id, true);
    await vi.runAllTimersAsync(); expect(f.close).not.toHaveBeenCalled(); expect(f.guard.canClose).toBe(false);
    f.guard.acknowledge(id, true); expect(f.close).not.toHaveBeenCalled();
  });
  it.each([[null, true], ['invalid', true], ['00000000-0000-4000-8000-000000000000', 'true']])('rejects malformed ack %#', (id, saved) => {
    const f = fixture(); expect(() => f.guard.acknowledge(id, saved)).toThrow('CLOSE_ACK_INVALID');
    expect(f.close).not.toHaveBeenCalled();
  });
  it('dispose prevents late confirmation from closing another window', async () => {
    const f = fixture(true); f.guard.request(); f.guard.acknowledge(f.notify.mock.calls[0][0], false); f.guard.dispose();
    await vi.runAllTimersAsync(); expect(f.close).not.toHaveBeenCalled();
  });
});
