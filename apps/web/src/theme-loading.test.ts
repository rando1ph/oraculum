import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { decodeThemeAsset, loadThemeBundle, temporaryThemeFailure } from './theme-loading';

const bundle = { manifest: { id: 'hong-kong-neon', themeApi: 1 }, css: ':root{}', revision: 'revision-one', assets: [] };
const controller = () => new AbortController();
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('location', new URL('https://example.test/oraculum/'));
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('uses private HTTP revalidation and the configured base for theme bundles', async () => {
  fetcher.mockResolvedValue(new Response(JSON.stringify(bundle)));
  await expect(loadThemeBundle('hong-kong-neon', controller().signal)).resolves.toEqual(bundle);
  expect(fetcher.mock.calls[0][0].href).toBe('https://example.test/oraculum/themes/hong-kong-neon/bundle');
  expect(fetcher.mock.calls[0][1].cache).toBe('no-cache');
});

it('retries a transient interruption once and returns its successful response', async () => {
  fetcher.mockRejectedValueOnce(new TypeError('connection interrupted')).mockResolvedValueOnce(new Response(JSON.stringify(bundle)));
  const pending = loadThemeBundle('hong-kong-neon', controller().signal);
  await vi.advanceTimersByTimeAsync(750);
  await expect(pending).resolves.toEqual(bundle); expect(fetcher).toHaveBeenCalledTimes(2);
});

it('bounds retries for server failures and distinguishes invalid packages', async () => {
  fetcher.mockImplementation(() => Promise.resolve(new Response('', { status: 503 })));
  const temporary = loadThemeBundle('hong-kong-neon', controller().signal).catch(error => error);
  await vi.advanceTimersByTimeAsync(750);
  expect(temporaryThemeFailure(await temporary)).toBe(true); expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockClear().mockResolvedValue(new Response('', { status: 400 }));
  const invalid = await loadThemeBundle('hong-kong-neon', controller().signal).catch(error => error);
  expect(temporaryThemeFailure(invalid)).toBe(false); expect(fetcher).toHaveBeenCalledTimes(1);
});

it('signals revoked authentication without retrying or discarding preference as invalid', async () => {
  fetcher.mockResolvedValue(new Response('', { status: 401 }));
  const error = await loadThemeBundle('hong-kong-neon', controller().signal).catch(error => error);
  expect(temporaryThemeFailure(error)).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
  expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'oraculum-auth-required' }));
});

it('manual reset aborts retry backoff before any further request', async () => {
  fetcher.mockRejectedValue(new TypeError('offline'));
  const abort = controller(), pending = loadThemeBundle('hong-kong-neon', abort.signal).catch(error => error);
  await vi.advanceTimersByTimeAsync(100); abort.abort(); await vi.advanceTimersByTimeAsync(1000);
  expect((await pending).name).toBe('AbortError'); expect(fetcher).toHaveBeenCalledTimes(1);
});

it('separates corrupt bytes from transport failures and rejects an out-of-base asset', async () => {
  fetcher.mockResolvedValue(new Response('corrupt'));
  vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('cannot decode')));
  const error = await decodeThemeAsset('/oraculum/themes/hong-kong-neon/assets/night.webp', controller().signal).catch(error => error);
  expect(error.message).toBe('主题图片损坏'); expect(temporaryThemeFailure(error)).toBe(false); expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(decodeThemeAsset('/themes/hong-kong-neon/assets/night.webp', controller().signal)).rejects.toThrow('主题资源越界');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('keeps a slow decode temporary and closes the late bitmap after its deadline', async () => {
  fetcher.mockResolvedValue(new Response('image'));
  let finish!: (bitmap: ImageBitmap) => void;
  vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise<ImageBitmap>(resolve => { finish = resolve; })));
  const pending = decodeThemeAsset('/oraculum/themes/hong-kong-neon/assets/night.webp', controller().signal).catch(error => error);
  await vi.advanceTimersByTimeAsync(5000);
  expect(temporaryThemeFailure(await pending)).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
  const close = vi.fn(); finish({ close } as unknown as ImageBitmap); await Promise.resolve();
  expect(close).toHaveBeenCalledTimes(1);
});

// A response can send headers immediately and stall its body; a body reader
// may report AbortError even though the transfer deadline expired.
it('preserves a body-read deadline as temporary and still bounds retries', async () => {
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const abort = controller();
    setTimeout(() => abort.abort(new DOMException('deadline', 'TimeoutError')), milliseconds);
    return abort.signal;
  });
  fetcher.mockImplementation((_url, options) => Promise.resolve({
    ok: true, json: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('body aborted', 'AbortError')), { once: true });
    }),
  }));
  const pending = loadThemeBundle('hong-kong-neon', controller().signal).catch(error => error);
  await vi.advanceTimersByTimeAsync(20_750);
  expect(temporaryThemeFailure(await pending)).toBe(true); expect(fetcher).toHaveBeenCalledTimes(2);
});
