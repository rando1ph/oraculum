import type { FileHandle } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

const invalid = () => { throw new Error('文件内容与类型不符，或文件损坏。'); };
async function bytes(file: FileHandle, size: number, at = 0) {
  const buffer = Buffer.alloc(size);
  const { bytesRead } = await file.read(buffer, 0, size, at);
  return buffer.subarray(0, bytesRead);
}
// Bounded sniffing only; never extract an archive or parse Office documents.
export async function sniffAttachment(file: FileHandle, extension: string, size: number) {
  const head = await bytes(file, Math.min(size, 65536));
  const tail = await bytes(file, Math.min(size, 65557), Math.max(0, size - 65557));
  let dimensions: [number, number] | undefined;
  if (extension === 'png') {
    if (head.length < 33 || head.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || head.toString('ascii', 12, 16) !== 'IHDR' ||
      tail.subarray(-12).toString('hex') !== '0000000049454e44ae426082') invalid();
    dimensions = [head.readUInt32BE(16), head.readUInt32BE(20)];
  } else if (['jpg', 'jpeg'].includes(extension)) {
    if (head[0] !== 255 || head[1] !== 216 || tail.at(-2) !== 255 || tail.at(-1) !== 217) invalid();
    for (let i = 2; i + 9 < head.length;) {
      if (head[i++] !== 255) invalid();
      while (head[i] === 255) i++;
      const marker = head[i++]!;
      if (marker === 0xda || marker === 0xd9) break;
      const length = head.readUInt16BE(i);
      if (length < 2) invalid();
      if ([0xc0, 0xc1, 0xc2].includes(marker)) { dimensions = [head.readUInt16BE(i + 5), head.readUInt16BE(i + 3)]; break; }
      i += length;
    }
    if (!dimensions) invalid();
  } else if (extension === 'webp') {
    if (head.length < 30 || head.toString('ascii', 0, 4) !== 'RIFF' || head.readUInt32LE(4) + 8 !== size || head.toString('ascii', 8, 12) !== 'WEBP') invalid();
    const kind = head.toString('ascii', 12, 16);
    if (kind === 'VP8X') dimensions = [head.readUIntLE(24, 3) + 1, head.readUIntLE(27, 3) + 1];
    else if (kind === 'VP8 ' && head.subarray(23, 26).toString('hex') === '9d012a') dimensions = [head.readUInt16LE(26) & 0x3fff, head.readUInt16LE(28) & 0x3fff];
    else if (kind === 'VP8L' && head[20] === 0x2f) { const value = head.readUInt32LE(21); dimensions = [(value & 0x3fff) + 1, ((value >>> 14) & 0x3fff) + 1]; }
    else invalid();
  } else if (extension === 'pdf') {
    if (!/^%PDF-(1\.[0-9]|2\.0)/.test(head.toString('ascii', 0, 9)) || !/%%EOF\s*$/.test(tail.subarray(-1024).toString('ascii'))) invalid();
  } else if (['docx', 'xlsx', 'pptx'].includes(extension)) {
    if (head.readUInt32LE(0) !== 0x04034b50) invalid();
    const eocd = tail.lastIndexOf(Buffer.from('504b0506', 'hex'));
    if (eocd < 0 || eocd + 22 > tail.length || eocd + 22 + tail.readUInt16LE(eocd + 20) !== tail.length || tail.readUInt32LE(eocd + 4) !== 0) invalid();
    const entries = tail.readUInt16LE(eocd + 10), length = tail.readUInt32LE(eocd + 12), offset = tail.readUInt32LE(eocd + 16);
    if (entries < 2 || entries > 1024 || length > 65536 || offset + length > size - 22) invalid();
    const central = await bytes(file, length, offset), names = new Set<string>();
    let typeEntry: { at: number; compressed: number; method: number } | undefined;
    let cursor = 0;
    for (let index = 0; index < entries; index++) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) invalid();
      const nameLength = central.readUInt16LE(cursor + 28), extra = central.readUInt16LE(cursor + 30), comment = central.readUInt16LE(cursor + 32);
      const name = central.toString('utf8', cursor + 46, cursor + 46 + nameLength);
      if (!name || names.has(name) || /(^\/|\\|(^|\/)\.\.(\/|$)|vbaProject\.bin$)/i.test(name) || central.readUInt16LE(cursor + 8) & 1) invalid();
      names.add(name);
      if (name === '[Content_Types].xml') typeEntry = { at: central.readUInt32LE(cursor + 42), compressed: central.readUInt32LE(cursor + 20), method: central.readUInt16LE(cursor + 10) };
      cursor += 46 + nameLength + extra + comment;
    }
    const main = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' }[extension]!;
    if (cursor !== central.length || !names.has(main) || !typeEntry || typeEntry.compressed > 32768 || ![0, 8].includes(typeEntry.method)) invalid();
    const entry = typeEntry!;
    const local = await bytes(file, 30, entry.at);
    if (local.length !== 30 || local.readUInt32LE(0) !== 0x04034b50) invalid();
    const packed = await bytes(file, entry.compressed, entry.at + 30 + local.readUInt16LE(26) + local.readUInt16LE(28));
    const xml = (entry.method === 8 ? inflateRawSync(packed, { maxOutputLength: 65536 }) : packed).toString('utf8');
    const content = { docx: 'wordprocessingml.document.main+xml', xlsx: 'spreadsheetml.sheet.main+xml', pptx: 'presentationml.presentation.main+xml' }[extension]!;
    if (!xml.includes(content) || !xml.includes('/' + main)) invalid();
  } else {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (let at = 0; at < size; at += 65536) {
      const chunk = await bytes(file, Math.min(65536, size - at), at);
      if (chunk.includes(0)) invalid();
      decoder.decode(chunk, { stream: at + chunk.length < size });
    }
  }
  if (dimensions && (!dimensions[0] || !dimensions[1] || dimensions[0] > 16384 || dimensions[1] > 16384 || dimensions[0] * dimensions[1] > 40_000_000)) invalid();
}
