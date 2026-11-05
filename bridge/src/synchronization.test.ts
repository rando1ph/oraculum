import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { BridgeService } from './service';
import type { Snapshot, Thread } from '../../packages/shared/protocol';

it('returns session controls without reading history and keeps active/unknown sessions blocked locally', async () => {
  const thread = { id: 'long', cwd: '/fixture', status: { type: 'active', activeFlags: [] }, turns: [] } as unknown as Thread;
  const request = vi.fn(async (method: string) => {
    if (method === 'thread/read' || method === 'thread/resume') return { thread };
    if (method === 'thread/turns/list') throw new Error('history timed out');
    throw new Error('unexpected RPC');
  });
  const codex = Object.assign(new EventEmitter(), { request: async <T>(m: string, p: object) => await request(m) as T, send: vi.fn() });
  const service = new BridgeService(codex, '/fixture'); service.threads.add('long');
  const result = await service.dispatch('bridge/subscribe', { threadId: 'long', metadataOnly: true }) as Snapshot;
  expect(result.thread.turns).toEqual([]);
  expect(request.mock.calls.flat()).not.toContain('thread/turns/list');
  await expect(service.dispatch('turn/start', { threadId: 'long', text: 'do not execute' })).rejects.toThrow(/progress|unknown/i);
});
