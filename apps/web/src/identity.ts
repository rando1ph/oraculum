export type IdentityRole = 'user' | 'assistant';
export type Identity = { nickname: string; avatar: string | null };
export type Identities = Record<IdentityRole, Identity>;
export const defaultNames = { user: '你', assistant: 'Codex' };
export const emptyIdentities = (): Identities => ({ user: { nickname: '', avatar: null }, assistant: { nickname: '', avatar: null } });
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_AVATAR_LENGTH = 192 * 1024;
export const AVATAR_SIZE = 256;
export function normalizeNickname(value: string): string {
  const name = value.trim();
  if ([...name].length > 32) throw new Error('昵称最多 32 个字符。');
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name)) throw new Error('昵称不能包含控制字符或换行。');
  return name;
}
export function validAvatar(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_AVATAR_LENGTH && /^data:image\/(?:webp|png);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) && !value.endsWith(',');
}
// One bounded, atomic localStorage write. Never send identities through BridgeClient.
export function parseIdentities(raw: string | null): Identities {
  const result = emptyIdentities();
  if (!raw || raw.length > MAX_AVATAR_LENGTH * 2 + 2048) return result;
  try {
    const saved = JSON.parse(raw);
    if (saved.version !== 1) return result;
    for (const role of ['user', 'assistant'] as const) {
      const value = saved[role];
      if (!value || typeof value.nickname !== 'string') continue;
      try { result[role].nickname = normalizeNickname(value.nickname); } catch { /* Recover this field only. */ }
      if (validAvatar(value.avatar)) result[role].avatar = value.avatar;
    }
  } catch { /* Malformed local preference falls back to defaults. */ }
  return result;
}
export function imageType(bytes: Uint8Array): string {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return 'image/png';
  if (starts(82, 73, 70, 70) && [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value)) return 'image/webp';
  throw new Error('请选择 JPG、PNG 或 WebP 图片，文件内容必须与类型一致。');
}
// Reject excessive header dimensions before asking the browser to decode pixels.
export function imageDimensions(bytes: Uint8Array, type: string): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (type === 'image/png') return [view.getUint32(16), view.getUint32(20)];
    if (type === 'image/jpeg') {
      let offset = 2;
      while (offset + 8 < bytes.length) {
        if (bytes[offset++] !== 0xff) break;
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++];
        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
        const length = view.getUint16(offset);
        if (length < 2) break;
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
        offset += length;
      }
    }
    if (type === 'image/webp') {
      const chunk = String.fromCharCode(...bytes.slice(12, 16));
      if (chunk === 'VP8X') return [1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)];
      if (chunk === 'VP8 ') return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
      if (chunk === 'VP8L') {
        const bits = view.getUint32(21, true);
        return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
      }
    }
  } catch { /* Truncated input. */ }
  throw new Error('图片损坏或无法识别，请换一张图片。');
}
export async function decodeAvatarFile(file: File): Promise<ImageBitmap> {
  if (!file.size || file.size > MAX_IMAGE_BYTES) throw new Error('图片不能为空，且不能超过 8 MB。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = imageType(bytes);
  if (file.type && file.type !== type) throw new Error('图片内容与文件类型不一致。');
  const [width, height] = imageDimensions(bytes, type);
  if (!(width > 0 && height > 0) || width > 8192 || height > 8192 || width * height > 32_000_000) throw new Error('图片分辨率过大，请使用 8192 × 8192 以内、总像素不超过 3200 万的图片。');
  try { return await createImageBitmap(new Blob([bytes], { type })); }
  catch { throw new Error('图片解码失败，请换一张图片。'); }
}
export type Crop = { zoom: number; x: number; y: number };
export const centeredCrop = (): Crop => ({ zoom: 1, x: 50, y: 50 });
export function drawCrop(canvas: HTMLCanvasElement, picture: ImageBitmap, crop: Crop) {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('此设备无法处理图片。');
  const side = Math.min(picture.width, picture.height) / crop.zoom;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(picture, (picture.width - side) * crop.x / 100, (picture.height - side) * crop.y / 100, side, side, 0, 0, canvas.width, canvas.height);
}
export function exportAvatar(picture: ImageBitmap, crop: Crop): string {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = AVATAR_SIZE;
  drawCrop(canvas, picture, crop);
  const encoded = canvas.toDataURL('image/webp', 0.86);
  if (!validAvatar(encoded)) throw new Error('图片压缩失败，请换一张图片。');
  return encoded;
}
// Decode bytes directly; no network/data/blob image URLs or broader CSP needed.
export function avatarBlob(value: string): Blob {
  if (!validAvatar(value)) throw new Error('无效的本地头像');
  const [prefix, body] = value.split(',');
  return new Blob([Uint8Array.from(atob(body), character => character.charCodeAt(0))], { type: prefix.slice(5, prefix.indexOf(';')) });
}
