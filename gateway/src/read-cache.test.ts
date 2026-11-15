import { describe, expect, it, vi } from 'vitest';
import { BoundedReadCache } from './read-cache';

describe('disposable native read cache', () => {
  it('shares simultaneous work, detaches callers and revalidates after its bounded lifetime', async () => {
    let now = 1000;
    const cache = new BoundedReadCache({ now: () => now });
    const load = vi.fn(async () => ({ value: ['native'] }));
    const [first, second] = await Promise.all([cache.get('same', 10, load), cache.get('same', 10, load)]);
    expect(load).toHaveBeenCalledTimes(1);
    first.value.push('modified');
    expect(second.value).toEqual(['native']);
    expect((await cache.get('same', 10, load)).value).toEqual(['native']);
    now += 10; await cache.get('same', 10, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('rejects invalidated in-flight results without replacing the next generation', async () => {
    const cache = new BoundedReadCache(); let release!: (value: string) => void;
    const old = cache.get('same', 1000, () => new Promise<string>(resolve => { release = resolve; }));
    const rejected = expect(old).rejects.toMatchObject({ code: 'READ_STALE' });
    await Promise.resolve(); cache.invalidate('same');
    expect(await cache.get('same', 1000, async () => 'new')).toBe('new');
    release('old'); await rejected;
    expect(await cache.get('same', 1000, async () => 'wrong')).toBe('new');
  });

  it('cleans failures, budgets entries/bytes and counts invalidated upstream work until completion', async () => {
    const cache = new BoundedReadCache({ maxEntries: 1, maxBytes: 16, maxPending: 1 });
    await expect(cache.get('failed', 100, async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    expect(await cache.get('failed', 100, async () => 'ok')).toBe('ok');
    await cache.get('second', 100, async () => 'other');
    const load = vi.fn(async () => 'replacement'); await cache.get('failed', 100, load);
    expect(load).toHaveBeenCalledTimes(1);
    const tooLarge = vi.fn(async () => 'x'.repeat(100));
    await cache.get('large', 100, tooLarge); await cache.get('large', 100, tooLarge);
    expect(tooLarge).toHaveBeenCalledTimes(2);
    let release!: (value: string) => void;
    const pending = cache.get('pending', 100, () => new Promise<string>(resolve => { release = resolve; }));
    const rejected = expect(pending).rejects.toMatchObject({ code: 'READ_STALE' });
    await Promise.resolve(); cache.clear();
    await expect(cache.get('new', 100, async () => 'new')).rejects.toMatchObject({ code: 'NATIVE_BUSY' });
    release('old'); await rejected;
    expect(await cache.get('new', 100, async () => 'new')).toBe('new');
  });
});
