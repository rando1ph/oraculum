import { artifactLimits, type ArtifactFile } from '../../../packages/shared/artifacts';

const endpoint = (path: string) => new URL('artifacts/' + path, new URL('.', location.href));
export async function artifactRequest<T>(action: string, body: object, signal: AbortSignal): Promise<T> {
  const response = await fetch(endpoint(action), { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Oraculum-Artifact': '1' }, body: JSON.stringify(body), signal, redirect: 'error' });
  if (!response.ok) throw new Error(response.status === 401 ? '设备授权已失效，请重新配对。' : '文件不存在、已变化或不允许读取，请刷新后重试。');
  return response.json() as Promise<T>;
}
export async function readArtifact(file: ArtifactFile, signal: AbortSignal, onProgress: (bytes: number) => void): Promise<Blob> {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > artifactLimits.fileBytes) throw new Error('文件超过 64 MB 下载限制。');
  const response = await fetch(endpoint('content/' + file.id), { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'X-Oraculum-Artifact': '1' }, signal, redirect: 'error' });
  if (!response.ok) throw new Error(response.status === 401 ? '设备授权已失效，请重新配对。' : '下载未完成：文件或授权已变化，请刷新后重试。');
  const digest = response.headers.get('X-Oraculum-SHA256');
  if (response.headers.get('Content-Length') === null || Number(response.headers.get('Content-Length')) !== file.size || response.headers.get('Content-Type')?.split(';')[0] !== file.mime ||
    !digest || !/^[a-f0-9]{64}$/.test(digest) || !response.body) { await response.body?.cancel(); throw new Error('下载响应无效，请刷新后重试。'); }
  const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > file.size) throw new Error('下载大小不符，已停止。');
      chunks.push(new Uint8Array(value)); onProgress(total);
    }
    signal.throwIfAborted();
    if (total !== file.size) throw new Error('下载中断，请重新选择文件后重试。');
    const blob = new Blob(chunks, { type: file.mime });
    const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
    signal.throwIfAborted();
    if (actual !== digest) throw new Error('文件校验失败，请刷新后重试。');
    onProgress(total); return blob;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
