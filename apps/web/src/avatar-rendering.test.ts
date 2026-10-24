import { afterEach, expect, it, vi } from 'vitest';
import { acquireAvatar, avatarBufferSize, observeAvatar } from './avatar-rendering';

const source = 'data:image/webp;base64,AAAA', other = 'data:image/webp;base64,AAAB';
const cleanup: (() => void)[] = [];
const acquire = (value = source) => { const lease = acquireAvatar(value); cleanup.push(lease.release); return lease; };
const bitmap = () => ({ width: 256, height: 256, close: vi.fn() }) as unknown as ImageBitmap;
afterEach(() => { for (const release of cleanup.splice(0)) release(); vi.unstubAllGlobals(); });

it('shares one decode across 600 mounted consumers and closes only at the last release', async () => {
  const picture = bitmap(), decode = vi.fn().mockResolvedValue(picture); vi.stubGlobal('createImageBitmap', decode);
  const leases = Array.from({ length: 600 }, () => acquire());
  expect(new Set(leases.map(value => value.picture)).size).toBe(1);
  expect(await leases[0].picture).toBe(picture); expect(decode).toHaveBeenCalledTimes(1);
  for (const lease of leases.slice(1)) lease.release(); expect(picture.close).not.toHaveBeenCalled();
  leases[0].release(); leases[0].release(); expect(picture.close).toHaveBeenCalledTimes(1);
  const next = bitmap(); decode.mockResolvedValue(next); await acquire().picture;
  expect(decode).toHaveBeenCalledTimes(2); expect(next.close).not.toHaveBeenCalled();
});

it('keeps different images independent while a released pending decode cannot evict its replacement', async () => {
  let finish!: (value: ImageBitmap) => void;
  const stale = bitmap(), replacement = bitmap(), secondRole = bitmap();
  const decode = vi.fn().mockImplementationOnce(() => new Promise<ImageBitmap>(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(replacement).mockResolvedValueOnce(secondRole);
  vi.stubGlobal('createImageBitmap', decode);
  const cancelled = acquire(); await Promise.resolve(); cancelled.release();
  const fresh = acquire(), independent = acquire(other); await Promise.all([fresh.picture, independent.picture]);
  finish(stale); await cancelled.picture; expect(stale.close).toHaveBeenCalledTimes(1);
  const reused = acquire(); expect(await reused.picture).toBe(replacement); expect(decode).toHaveBeenCalledTimes(3);
  independent.release(); expect(secondRole.close).toHaveBeenCalledTimes(1); expect(replacement.close).not.toHaveBeenCalled();
  fresh.release(); reused.release(); expect(replacement.close).toHaveBeenCalledTimes(1);
});

it('removes failed decodes so later consumers can recover', async () => {
  const picture = bitmap(), decode = vi.fn().mockRejectedValueOnce(new Error('bad image')).mockResolvedValueOnce(picture);
  vi.stubGlobal('createImageBitmap', decode);
  const failed = acquire(); await expect(failed.picture).rejects.toThrow('bad image');
  const recovered = acquire(); expect(await recovered.picture).toBe(picture); failed.release();
  expect(picture.close).not.toHaveBeenCalled(); recovered.release(); expect(picture.close).toHaveBeenCalledTimes(1);
});

it('matches CSS pixels and fractional DPR without enlarging beyond the stored source', () => {
  expect(avatarBufferSize(32, 32, 1)).toEqual([32, 32]);
  expect(avatarBufferSize(32, 32, 1.5)).toEqual([48, 48]);
  expect(avatarBufferSize(28, 28, 3.25)).toEqual([91, 91]);
  expect(avatarBufferSize(64, 64, 3.25)).toEqual([208, 208]);
  expect(avatarBufferSize(400, 80, 4)).toEqual([256, 256]);
  expect(avatarBufferSize(NaN, 0, NaN)).toEqual([1, 1]);
});

it('shares resize/DPR observation and tears down every registration when the list leaves', () => {
  const observations: any[] = [], media: any[] = [];
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn();
    constructor(readonly callback: (entries: any[]) => void) { observations.push(this); }
  });
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  vi.stubGlobal('matchMedia', vi.fn(() => { const query = { addEventListener: vi.fn(), removeEventListener: vi.fn() }; media.push(query); return query; }));
  const first = {} as HTMLCanvasElement, second = {} as HTMLCanvasElement, paint = vi.fn(), paintOther = vi.fn();
  const release = observeAvatar(first, paint), releaseOther = observeAvatar(second, paintOther); cleanup.push(release, releaseOther);
  expect(observations).toHaveLength(1); expect(media).toHaveLength(1);
  observations[0].callback([{ target: first, contentRect: { width: 32, height: 32 } }]); expect(paint).toHaveBeenCalledWith(32, 32); expect(paintOther).not.toHaveBeenCalled();
  (window as any).devicePixelRatio = 2; media[0].addEventListener.mock.calls[0][1]();
  expect(media[0].removeEventListener).toHaveBeenCalledTimes(1); expect(media).toHaveLength(2); expect(paintOther).toHaveBeenCalledTimes(1);
  release(); expect(observations[0].disconnect).not.toHaveBeenCalled(); releaseOther();
  expect(observations[0].disconnect).toHaveBeenCalledTimes(1); expect(media[1].removeEventListener).toHaveBeenCalledTimes(1);
  cleanup.length = 0;
});
