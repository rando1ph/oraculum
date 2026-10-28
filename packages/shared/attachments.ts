// Public limits and display metadata. No renderer-supplied filesystem path is accepted.
export const attachmentLimits = { count: 6, fileBytes: 20 * 1024 * 1024, batchBytes: 50 * 1024 * 1024,
  readyMs: 24 * 60 * 60 * 1000, sentMs: 30 * 24 * 60 * 60 * 1000 } as const;
export const attachmentTypes = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', txt: 'text/plain', md: 'text/markdown',
} as const;
export const attachmentAccept = [...new Set(Object.values(attachmentTypes))].join(',');
export type AttachmentFile = { id: string; name: string; size: number; mime: string; kind: 'image' | 'document'; expiresAt: number };
export type AttachmentDelivery = { operationId: string; turnId: string; files: (AttachmentFile & { available: boolean })[]; referenceText: string };
export type AttachmentScope = { cwd: string; threadId: string; draftId: string };
export const attachmentId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function attachmentType(name: unknown, mime: unknown, size: unknown) {
  if (typeof name !== 'string' || !name || name.length > 180 || name !== name.normalize('NFC') ||
      /[/\\:%\p{Cc}\p{Cf}]/u.test(name) || name.startsWith('.') || name.trim() !== name) throw new Error('文件名无效，请重命名后选择。');
  const extension = name.split('.').at(-1)?.toLowerCase() as keyof typeof attachmentTypes;
  const expected = attachmentTypes[extension];
  if (!expected || typeof mime !== 'string' || !['', 'application/octet-stream', expected,
    ...(['csv', 'md', 'txt'].includes(extension) ? ['text/plain'] : [])].includes(mime.toLowerCase())) throw new Error('不支持此文件类型，或类型与扩展名不符。');
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > attachmentLimits.fileBytes) throw new Error('附件不能为空，单个文件最多 20 MB。');
  return { extension, mime: expected, kind: expected.startsWith('image/') ? 'image' as const : 'document' as const };
}
