import { describe, expect, it } from 'vitest';
import { emptyIdentities, imageDimensions, imageType, normalizeNickname, parseIdentities, validAvatar } from './identity';
describe('local display identity', () => {
  it('keeps plain text including markup and counts Unicode characters', () => {
    expect(normalizeNickname('  <img src=x onerror=alert(1)>  ')).toBe('<img src=x onerror=alert(1)>');
    expect(normalizeNickname('🌙'.repeat(32))).toHaveLength(64);
    expect(() => normalizeNickname('🌙'.repeat(33))).toThrow('32');
    for (const name of ['a\nb', 'a\u0000b', 'a\u202eb']) expect(() => normalizeNickname(name)).toThrow('控制');
  });
  it('recovers damaged preferences field by field and rejects remote or active avatars', () => {
    for (const raw of [null, '{', 'null', '{"version":2}', 'x'.repeat(400000)]) expect(parseIdentities(raw)).toEqual(emptyIdentities());
    const value = parseIdentities(JSON.stringify({ version: 1, user: { nickname: 'x'.repeat(33), avatar: 'https://example.com/a.png' }, assistant: { nickname: '神谕', avatar: 'data:image/svg+xml;base64,PHN2Zz4=' } }));
    expect(value).toEqual({ user: { nickname: '', avatar: null }, assistant: { nickname: '神谕', avatar: null } });
    for (const uri of ['data:image/png;base64,A', 'data:image/png;base64,', 'data:image/webp;base64,====']) expect(validAvatar(uri)).toBe(false);
  });
  it('checks real signatures and dimensions before decoding', () => {
    const bytes = new Uint8Array(30); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(bytes.buffer); view.setUint32(16, 10000); view.setUint32(20, 10000);
    expect(imageType(bytes)).toBe('image/png'); expect(imageDimensions(bytes, 'image/png')).toEqual([10000, 10000]);
    expect(() => imageType(new TextEncoder().encode('<svg/>'))).toThrow('JPG');
    expect(() => imageDimensions(bytes.slice(0, 12), 'image/png')).toThrow('损坏');
    const jpeg = new Uint8Array([255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 17, 8, 1, 44, 2, 88, 0]);
    expect(imageDimensions(jpeg, 'image/jpeg')).toEqual([600, 300]);
    const webp = new Uint8Array(30); webp.set(new TextEncoder().encode('RIFF0000WEBPVP8X')); webp[24] = 255; webp[27] = 127;
    expect(imageType(webp)).toBe('image/webp'); expect(imageDimensions(webp, 'image/webp')).toEqual([256, 128]);
  });
});
