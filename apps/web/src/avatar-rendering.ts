import { AVATAR_SIZE, avatarBlob } from './identity';

type DecodedAvatar = { users: number; picture?: ImageBitmap; pending: Promise<ImageBitmap> };
// Only mounted consumers retain a decode. Identical images (including both
// roles choosing the same image) share bytes/pixels, never display identity.
const decoded = new Map<string, DecodedAvatar>();
export function acquireAvatar(source: string) {
  let entry = decoded.get(source);
  if (!entry) {
    const created: DecodedAvatar = { users: 0, pending: Promise.resolve().then(() => createImageBitmap(avatarBlob(source))) };
    created.pending = created.pending.then(picture => {
      if (created.users) created.picture = picture;
      else picture.close(); // All consumers left before decoding finished.
      return picture;
    }, error => {
      if (decoded.get(source) === created) decoded.delete(source);
      throw error;
    });
    decoded.set(source, created); entry = created;
  }
  entry.users++;
  const current = entry;
  let released = false;
  return { picture: current.pending, release() {
    if (released) return;
    released = true;
    if (--current.users === 0) {
      if (decoded.get(source) === current) decoded.delete(source);
      current.picture?.close(); current.picture = undefined;
    }
  } };
}

export function avatarBufferSize(width: number, height: number, dpr: number): [number, number] {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const pixels = (size: number) => Math.min(AVATAR_SIZE, Math.max(1, Math.ceil((Number.isFinite(size) ? size : 1) * scale)));
  return [pixels(width), pixels(height)];
}

// One observer and DPR listener for the whole list, rather than per-message
// window listeners. ResizeObserver also catches Trusted CSS theme size changes.
type Paint = (width?: number, height?: number) => void;
const painters = new Map<HTMLCanvasElement, Paint>();
let observer: ResizeObserver | undefined, resolution: MediaQueryList | undefined;
function watchResolution() {
  resolution?.removeEventListener('change', changeResolution);
  resolution = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  resolution.addEventListener('change', changeResolution);
}
function changeResolution() {
  watchResolution();
  for (const paint of painters.values()) paint();
}
export function observeAvatar(canvas: HTMLCanvasElement, paint: Paint) {
  if (!observer) {
    // Use the browser's completed layout. Reading computed styles between 600
    // canvas attribute writes would force repeated layout on a theme resize.
    observer = new ResizeObserver(entries => { for (const entry of entries) painters.get(entry.target as HTMLCanvasElement)?.(entry.contentRect.width, entry.contentRect.height); });
    watchResolution();
  }
  painters.set(canvas, paint); observer.observe(canvas);
  return () => {
    observer?.unobserve(canvas); painters.delete(canvas);
    if (!painters.size) {
      observer?.disconnect(); observer = undefined;
      resolution?.removeEventListener('change', changeResolution); resolution = undefined;
    }
  };
}
