import { useEffect, useRef, useState } from 'react';
import { appUrl } from '../../../packages/shared/entry';
import { attachmentId, attachmentLimits as limits, attachmentType, type AttachmentDelivery, type AttachmentFile, type AttachmentScope } from '../../../packages/shared/attachments';
import type { SendReceipt } from '../../../packages/shared/protocol';
import { Icon } from './icons';
import './attachments.css';

type UploadState = 'queued' | 'uploading' | 'ready' | 'failed' | 'sending' | 'unknown' | 'removing';
export type QueuedAttachment = { key: string; file: File; preview?: string; state: UploadState; progress: number; uploaded?: AttachmentFile; error?: string; retryable?: boolean; operationId?: string };
type Queue = { scope: AttachmentScope; files: QueuedAttachment[]; notice: string };
export const fileSize = (size: number) => size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB`;
const stateLabel: Record<UploadState, string> = { queued: '等待上传', uploading: '上传中', ready: '已上传', failed: '上传失败', sending: '正在发送', unknown: '发送待确认', removing: '正在移除' };
const scopeKey = (scope: Pick<AttachmentScope, 'cwd' | 'threadId'>) => JSON.stringify([scope.cwd, scope.threadId]);

// Per-page, per-project/thread queues; no file bytes, URLs or upload IDs go into
// browser storage. Only a native receipt can release an uncertain submission.
export class AttachmentQueues {
  private queues = new Map<string, Queue>();
  private running = false;
  private request?: XMLHttpRequest;
  private closed = false;
  constructor(private changed: () => void) {}
  queue(scope: Pick<AttachmentScope, 'cwd' | 'threadId'>) {
    const key = scopeKey(scope);
    let queue = this.queues.get(key);
    if (!queue) { queue = { scope: { ...scope, draftId: crypto.randomUUID() }, files: [], notice: '' }; this.queues.set(key, queue); }
    return queue;
  }
  add(queue: Queue, files: File[]) {
    queue.notice = '';
    for (const file of files) {
      if (queue.files.length >= limits.count || queue.files.reduce((sum, item) => sum + item.file.size, 0) + file.size > limits.batchBytes) { queue.notice = '每批最多 6 个附件，合计最多 50 MB。'; break; }
      const item: QueuedAttachment = { key: crypto.randomUUID(), file, state: 'queued', progress: 0 };
      try {
        const type = attachmentType(file.name, file.type, file.size);
        if (type.kind === 'image') item.preview = URL.createObjectURL(file);
      } catch (error) { item.state = 'failed'; item.error = (error as Error).message; }
      queue.files.push(item);
    }
    this.changed(); void this.pump();
  }
  retry(item: QueuedAttachment) { if (item.state !== 'failed' || !item.retryable) return; item.state = 'queued'; item.error = undefined; item.progress = 0; this.changed(); void this.pump(); }
  private async pump() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      for (;;) {
        const queue = [...this.queues.values()].find(queue => queue.files.some(item => item.state === 'queued'));
        const item = queue?.files.find(item => item.state === 'queued');
        if (!queue || !item || this.closed) break;
        item.state = 'uploading'; this.changed();
        try {
          const uploaded = await new Promise<AttachmentFile>((resolve, reject) => {
            const xhr = this.request = new XMLHttpRequest();
            xhr.open('POST', appUrl('attachments')); xhr.withCredentials = true; xhr.timeout = 125000;
            xhr.setRequestHeader('Content-Type', 'application/octet-stream'); xhr.setRequestHeader('X-Oraculum-Upload', '1');
            xhr.setRequestHeader('X-Oraculum-File', encodeURIComponent(JSON.stringify({ ...queue.scope, name: item.file.name.normalize('NFC'), mime: item.file.type, size: item.file.size })));
            xhr.upload.onprogress = event => { if (event.lengthComputable) { item.progress = Math.min(99, Math.round(event.loaded / event.total * 100)); this.changed(); } };
            xhr.onload = () => {
              let body: any; try { body = JSON.parse(xhr.responseText); } catch { reject(new Error('上传响应无效，请重新选择文件。')); return; }
              if (xhr.status !== 200) { reject(new Error(typeof body.error === 'string' ? body.error : '上传失败，请重试。')); return; }
              if (!attachmentId(body.id) || body.size !== item.file.size || body.name !== item.file.name.normalize('NFC') || !Number.isFinite(body.expiresAt)) { reject(new Error('上传响应无效，请重新选择文件。')); return; }
              resolve(body);
            };
            xhr.onerror = xhr.ontimeout = () => reject(new Error('网络中断或上传超时，请重试。'));
            xhr.onabort = () => reject(new Error('上传已取消。'));
            xhr.send(item.file);
          });
          if (queue.files.includes(item)) { item.uploaded = uploaded; item.state = 'ready'; item.progress = 100; }
        } catch (error) { if (queue.files.includes(item)) { item.state = 'failed'; item.error = (error as Error).message; item.retryable = true; } }
        finally { this.request = undefined; if (!this.closed) this.changed(); }
      }
    } finally { this.running = false; }
  }
  async remove(queue: Queue, item: QueuedAttachment) {
    if (['sending', 'unknown', 'removing'].includes(item.state)) return;
    if (item.state === 'uploading') this.request?.abort();
    if (item.uploaded) {
      item.state = 'removing'; this.changed();
      try {
        const response = await fetch(appUrl('attachments/remove'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Oraculum-Upload': '1' }, body: JSON.stringify({ ...queue.scope, id: item.uploaded.id }) });
        if (!response.ok) throw new Error('主机未确认移除，请查询连接后重试。');
      } catch (error) { item.state = 'failed'; item.error = (error as Error).message; this.changed(); return; }
    }
    this.drop(queue, [item]); this.changed();
  }
  private drop(queue: Queue, files: QueuedAttachment[]) {
    for (const item of files) if (item.preview) URL.revokeObjectURL(item.preview);
    queue.files = queue.files.filter(item => !files.includes(item));
    if (!queue.files.length) { queue.scope = { ...queue.scope, draftId: crypto.randomUUID() }; queue.notice = ''; }
  }
  ready(queue: Queue) { return queue.files.every(item => item.state === 'ready' && !!item.uploaded && item.uploaded.expiresAt > Date.now()); }
  begin(queue: Queue, operationId: string) {
    if (!this.ready(queue)) throw new Error('请等待附件上传成功，或移除失败/过期的附件。');
    if (!queue.files.length) return undefined;
    for (const item of queue.files) { item.state = 'sending'; item.operationId = operationId; }
    this.changed(); return { ...queue.scope, attachmentIds: queue.files.map(item => item.uploaded!.id) };
  }
  settled(queue: Queue, operationId: string, status: 'accepted' | 'rejected' | 'notSent' | 'unknown') {
    const files = queue.files.filter(item => item.operationId === operationId);
    if (status === 'accepted') this.drop(queue, files);
    else for (const item of files) { item.state = status === 'unknown' ? 'unknown' : item.uploaded!.expiresAt <= Date.now() ? 'failed' : 'ready'; item.error = item.state === 'failed' ? '附件已过期，请移除后重新选择。' : undefined; }
    this.changed();
  }
  reconcile(queue: Queue, receipts: SendReceipt[]) {
    for (const operationId of new Set(queue.files.filter(item => item.state === 'unknown').map(item => item.operationId!))) {
      const receipt = receipts.find(receipt => receipt.operationId === operationId);
      if (receipt && receipt.status !== 'unknown') this.settled(queue, operationId, receipt.status === 'rejected' ? 'rejected' : 'accepted');
    }
  }
  close() { this.closed = true; this.request?.abort(); for (const queue of this.queues.values()) for (const item of queue.files) if (item.preview) URL.revokeObjectURL(item.preview); }
}
export function useAttachments(cwd: string, threadId: string) {
  const [, render] = useState(0);
  const ref = useRef<AttachmentQueues | null>(null);
  if (!ref.current) ref.current = new AttachmentQueues(() => render(value => value + 1));
  const queues = ref.current, queue = queues.queue({ cwd, threadId });
  useEffect(() => () => queues.close(), [queues]);
  return { queues, queue };
}
export function AttachmentTray({ queue, queues, locked }: { queue: Queue; queues: AttachmentQueues; locked: boolean }) {
  return <>{!!queue.files.length && <div className="attachment-tray" aria-label="待发送附件">
    {queue.files.map(item => <div className={`attachment-tile ${item.state}`} data-state={item.state} key={item.key}>
      {item.preview ? <img className="attachment-thumbnail" src={item.preview} alt={item.file.name}/> : <span className="attachment-thumbnail attachment-file-icon"><Icon name="file" size={23}/></span>}
      <div className="attachment-info"><span className="attachment-name" title={item.file.name}>{item.file.name}</span><small>{fileSize(item.file.size)} · {item.uploaded && item.uploaded.expiresAt <= Date.now() && item.state === 'ready' ? '已过期，请重新选择' : stateLabel[item.state]}{item.state === 'uploading' ? ` ${item.progress}%` : ''}</small>{item.state === 'uploading' && <progress value={item.progress} max={100} aria-label={`上传进度：${item.file.name}`}/>} {item.error && <span className="attachment-error" role="alert">{item.error}</span>}</div>
      <div className="attachment-tile-actions">{item.state === 'failed' && !item.uploaded && item.retryable && <button type="button" disabled={locked} onClick={() => queues.retry(item)} aria-label={`重试上传：${item.file.name}`}><Icon name="refresh" size={15}/></button>}<button type="button" disabled={locked || ['sending', 'unknown', 'removing'].includes(item.state)} aria-label={`移除附件：${item.file.name}`} onClick={() => void queues.remove(queue, item)}><Icon name="close" size={16}/></button></div>
    </div>)}
  </div>}{queue.notice && <p className="attachment-error" role="alert">{queue.notice}</p>}{queue.files.some(item => item.state === 'unknown') && <p className="attachment-error" role="status">发送结果待确认，附件已保留。请查询状态，勿重复发送。</p>}</>;
}
export function AttachmentCards({ delivery }: { delivery: AttachmentDelivery }) {
  return <div className="attachment-cards" aria-label="已发送附件">{delivery.files.map(file => <div className="attachment-card" key={file.id}><span className="attachment-file-icon"><Icon name="file" size={22}/></span><div className="attachment-info"><span className="attachment-name" title={file.name}>{file.name}</span><small>{fileSize(file.size)} · {file.kind === 'image' ? '图片' : '文档 · 主机工具读取'}{!file.available ? ' · 文件已失效' : ''}</small></div></div>)}</div>;
}
