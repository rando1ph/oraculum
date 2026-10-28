import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttachmentCards, AttachmentQueues } from './attachments';
import { Item } from './content';
import type { AttachmentDelivery } from '../../../packages/shared/attachments';
import type { ThreadItem } from '../../../packages/shared/protocol';

class Xhr {
  static requests: Xhr[] = [];
  upload = { onprogress: undefined as any }; status = 200; timeout = 0; withCredentials = false;
  responseText = ''; headers: Record<string, string> = {}; body?: File;
  onload?: () => void; onerror?: () => void; onabort?: () => void;
  open() {} setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(file: File) { this.body = file; Xhr.requests.push(this); }
  abort() { this.onabort?.(); }
  respond() { this.responseText = JSON.stringify({ id: randomUUID(), name: this.body!.name, mime: this.body!.type, size: this.body!.size, kind: 'document', expiresAt: Date.now() + 60000 }); this.onload?.(); }
}
const live: AttachmentQueues[] = [];
afterEach(() => { for (const queues of live.splice(0)) queues.close(); Xhr.requests = []; vi.unstubAllGlobals(); });
function fixture() {
  vi.stubGlobal('XMLHttpRequest', Xhr); vi.stubGlobal('location', { href: 'https://example.com/console/' });
  const queues = new AttachmentQueues(vi.fn()); live.push(queues);
  const first = queues.queue({ cwd: '/Projects/first', threadId: 'one' }), second = queues.queue({ cwd: '/Projects/second', threadId: 'two' });
  return { queues, first, second, file: (name = '合成.txt') => new File(['synthetic'], name, { type: 'text/plain' }) };
}
it('serializes raw HTTP uploads with explicit scope and progress, never substituting a different project queue', async () => {
  const f = fixture(); f.queues.add(f.first, [f.file()]); f.queues.add(f.second, [f.file('第二份.txt')]);
  expect(Xhr.requests).toHaveLength(1);
  const request = Xhr.requests[0]!;
  expect(request.body).toBeInstanceOf(File); expect(request.headers['Content-Type']).toBe('application/octet-stream');
  expect(JSON.parse(decodeURIComponent(request.headers['X-Oraculum-File']!))).toMatchObject(f.first.scope);
  request.upload.onprogress({ lengthComputable: true, loaded: 5, total: 10 }); expect(f.first.files[0]?.progress).toBe(50);
  request.respond(); await vi.waitFor(() => expect(Xhr.requests).toHaveLength(2)); Xhr.requests[1]!.respond();
  await vi.waitFor(() => expect(f.queues.ready(f.second)).toBe(true));
  const operation = randomUUID(), firstIds = f.queues.begin(f.first, operation)!;
  expect(firstIds.cwd).toBe(f.first.scope.cwd); expect(firstIds.attachmentIds).not.toContain(f.second.files[0]?.uploaded?.id);
  expect(f.queues.ready(f.first)).toBe(false); f.queues.settled(f.first, operation, 'accepted'); expect(f.first.files).toEqual([]); expect(f.second.files).toHaveLength(1);
});
it('holds unknown sends through query, blocks removal/reuse, and releases only a matching confirmed receipt', async () => {
  const f = fixture(); f.queues.add(f.first, [f.file()]); Xhr.requests[0]!.respond(); await vi.waitFor(() => expect(f.queues.ready(f.first)).toBe(true));
  const operationId = randomUUID(); f.queues.begin(f.first, operationId); f.queues.settled(f.first, operationId, 'unknown');
  await f.queues.remove(f.first, f.first.files[0]!); expect(f.first.files).toHaveLength(1); expect(() => f.queues.begin(f.first, randomUUID())).toThrow();
  f.queues.reconcile(f.first, []); expect(f.first.files[0]?.state).toBe('unknown');
  f.queues.reconcile(f.first, [{ operationId, status: 'completed', turnId: 'native', createdAt: 0 }]); expect(f.first.files).toEqual([]);
});
it('keeps explicit rejection retryable; handles empty files, failed upload and reselect without accidental send', async () => {
  const f = fixture(); f.queues.add(f.first, [new File([], '空文件.txt', { type: 'text/plain' })]); expect(f.first.files[0]?.state).toBe('failed'); f.queues.retry(f.first.files[0]!); expect(Xhr.requests).toHaveLength(0);
  await f.queues.remove(f.first, f.first.files[0]!); f.queues.add(f.first, [f.file()]); Xhr.requests[0]!.onerror?.();
  await vi.waitFor(() => expect(f.first.files[0]?.state).toBe('failed')); f.queues.retry(f.first.files[0]!); Xhr.requests[1]!.respond();
  await vi.waitFor(() => expect(f.queues.ready(f.first)).toBe(true)); const id = randomUUID(); f.queues.begin(f.first, id); f.queues.settled(f.first, id, 'notSent'); expect(f.queues.ready(f.first)).toBe(true);
});
it('renders trustworthy delivery cards as inert escaped metadata, keeping unverified native content intact', () => {
  const referenceText = '\n\n[controlled paths]';
  const delivery: AttachmentDelivery = { operationId: randomUUID(), turnId: 'native', referenceText, files: [{ id: randomUUID(), name: '<script>图表.txt', size: 123, mime: 'text/plain', kind: 'document', expiresAt: 0, available: false }] };
  const cards = renderToStaticMarkup(<AttachmentCards delivery={delivery}/>); expect(cards).toContain('&lt;script&gt;'); expect(cards).toContain('文件已失效'); expect(cards).not.toContain('href='); expect(cards).not.toContain('<script>');
  const item = { id: 'user', type: 'userMessage', content: [{ type: 'text', text: '用户说明' + referenceText, text_elements: [] }] } as unknown as ThreadItem;
  expect(renderToStaticMarkup(<Item item={item} attachments={delivery}/>)).not.toContain('[controlled paths]');
  expect(renderToStaticMarkup(<Item item={item}/>)).toContain('[controlled paths]');
});
