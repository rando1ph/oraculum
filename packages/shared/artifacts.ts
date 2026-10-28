import { attachmentTypes } from './attachments';

// Output grants are independent of input attachment IDs. Neither is a bearer URL.
export const artifactLimits = { fileBytes: 64 * 1024 * 1024, textBytes: 512 * 1024,
  imageBytes: 8 * 1024 * 1024, pdfBytes: 16 * 1024 * 1024, grantMs: 5 * 60 * 1000, page: 80 } as const;
export type ArtifactScope = { cwd: string; threadId: string };
export type ArtifactEntry = { name: string; path: string; directory: boolean; size: number; mime: string };
export type ArtifactListing = { path: string; entries: ArtifactEntry[]; cursor: string | null; limited: boolean };
export type ArtifactFile = ArtifactEntry & { id: string; expiresAt: number; preview: 'image' | 'text' | 'markdown' | 'pdf' | null };
export function artifactType(name: string) {
  const extension = name.split('.').at(-1)?.toLowerCase() as keyof typeof attachmentTypes;
  const mime = attachmentTypes[extension];
  if (!mime) throw new Error('此类型暂不提供成果下载。');
  return { extension, mime };
}
export function artifactPreview(mime: string, size: number): ArtifactFile['preview'] {
  if (mime.startsWith('image/') && size <= artifactLimits.imageBytes) return 'image';
  if (mime === 'application/pdf' && size <= artifactLimits.pdfBytes) return 'pdf';
  if (mime.startsWith('text/') && size <= artifactLimits.textBytes) return mime === 'text/markdown' ? 'markdown' : 'text';
  return null;
}
