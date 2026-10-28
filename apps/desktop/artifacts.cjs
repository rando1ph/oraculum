const types = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
function allowedDownload(item, origin, current) {
  try {
    const name = item.getFilename();
    return new URL(current).origin === origin && item.getURL().startsWith(`blob:${origin}/`) &&
      item.getURLChain().every(url => url.startsWith(`blob:${origin}/`)) &&
      name.length > 0 && name.length <= 180 && !name.startsWith('.') && name.trim() === name && name.normalize('NFC') === name &&
      !/[/\\:%\p{Cc}\p{Cf}]/u.test(name) && types[name.split('.').at(-1).toLowerCase()] === item.getMimeType() &&
      item.getTotalBytes() >= 0 && item.getTotalBytes() <= 64 * 1024 * 1024;
  } catch { return false; }
}
module.exports = { allowedDownload };
