import { appUrl } from '../../../packages/shared/entry';
import { THEME_API, themeId, type ThemeBundle } from '../../../packages/shared/themes';

// A transfer budget includes the response body, but not image/font decoding.
// At most one retry handles interrupted connections without an unbounded spinner.
const bundleTimeout = 10_000, assetTimeout = 15_000, decodeTimeout = 5000;
export class ThemeLoadError extends Error {
  constructor(message: string, readonly temporary = false, readonly retry = temporary) { super(message); }
}
export const temporaryThemeFailure = (error: unknown) => error instanceof ThemeLoadError && error.temporary;

async function transfer<T>(url: URL, read: (response: Response) => Promise<T>, timeout: number, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const deadline = AbortSignal.timeout(timeout);
    try {
      signal.throwIfAborted();
      const response = await fetch(url, { cache: 'no-cache', signal: AbortSignal.any([signal, deadline]) });
      if (!response.ok) {
        if (response.status === 401) window.dispatchEvent(new Event('oraculum-auth-required'));
        // Authentication recovery must not forget the device's theme preference.
        if (response.status === 401 || response.status === 403) throw new ThemeLoadError('主题认证失效', true, false);
        const temporary = [408, 429].includes(response.status) || response.status >= 500;
        throw new ThemeLoadError(temporary ? '主题服务暂时不可用' : '主题包或资源不可用', temporary);
      }
      return await read(response);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const failure = error instanceof ThemeLoadError ? error
        : deadline.aborted || error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')
          ? new ThemeLoadError('主题网络传输中断或超时', true) : error;
      if (!(failure instanceof ThemeLoadError) || !failure.retry || attempt === 1) throw failure;
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 750);
        signal.addEventListener('abort', cancel, { once: true });
      });
    }
  }
}

export async function loadThemeBundle(id: string, signal: AbortSignal): Promise<ThemeBundle> {
  if (!themeId.test(id)) throw new Error('主题标识无效');
  const result = await transfer(appUrl(`themes/${id}/bundle`), response => response.json() as Promise<ThemeBundle>, bundleTimeout, signal);
  if (result?.manifest?.themeApi !== THEME_API || result.manifest.id !== id || typeof result.css !== 'string' ||
      typeof result.revision !== 'string' || !Array.isArray(result.assets) || !result.assets.every(asset => typeof asset === 'string')) throw new Error('Theme API 不兼容');
  return result;
}

export async function decodeThemeAsset(path: string, signal: AbortSignal) {
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin || !url.pathname.startsWith(appUrl('themes/').pathname)) throw new Error('主题资源越界');
  const bytes = await transfer(url, response => response.arrayBuffer(), assetTimeout, signal);
  signal.throwIfAborted();
  const font = /\.(woff2?|ttf|otf)$/.test(url.pathname);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => rejectAbort(signal.reason);
  let rejectAbort!: (error: unknown) => void;
  try {
    const decoded = font ? new FontFace('oraculum-theme-probe', bytes).load().then(() => {})
      : createImageBitmap(new Blob([bytes])).then(picture => picture.close());
    await Promise.race([
      decoded.catch(() => { throw new ThemeLoadError(font ? '主题字体损坏' : '主题图片损坏'); }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ThemeLoadError('主题资源解码超时', true, false)), decodeTimeout); }),
      new Promise<never>((_resolve, reject) => { rejectAbort = reject; signal.addEventListener('abort', cancel, { once: true }); }),
    ]);
  } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
}
