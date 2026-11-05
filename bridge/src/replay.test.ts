import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createServer } from './server';
import type { BridgeService } from './service';

it('replays bounded sequence gaps, resets evicted or foreign cursors and never dispatches a mutation', async () => {
  const dispatch = vi.fn(async () => ({}));
  const service = Object.assign(new EventEmitter(), { codex: {}, dispatch }) as unknown as BridgeService;
  const app = await createServer(service, 17961, '/missing', { testOnlyUnauthenticated: true });
  await app.ready();
  const socket = await app.injectWS('/ws', { headers: { host: '127.0.0.1:17961', origin: 'http://127.0.0.1:17961' } });
  const rpc = (params: object) => new Promise<any>((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { socket.off('message', receive); reject(new Error('Replay RPC timed out')); }, 1000);
    const receive = (bytes: unknown) => { const message = JSON.parse(String(bytes)); if (message.id === id) { clearTimeout(timer); socket.off('message', receive); resolve(message.result); } };
    socket.on('message', receive); socket.send(JSON.stringify({ id, method: 'bridge/events', params }));
  });
  try {
    const initial = await rpc({ since: 0 }); expect(initial.reset).toBe(true);
    service.emit('event', { type: 'projectsChanged' }); service.emit('event', { type: 'projectsChanged' });
    const gap = await rpc({ streamId: initial.streamId, since: 1 });
    expect(gap.reset).toBe(false); expect(gap.events).toEqual([{ type: 'projectsChanged', seq: 2, streamId: initial.streamId }]);
    for (let i = 0; i < 257; i++) service.emit('event', { type: 'projectsChanged' });
    expect((await rpc({ streamId: initial.streamId, since: 1 })).reset).toBe(true);
    expect((await rpc({ streamId: 'another-process', since: 259 })).reset).toBe(true);
    expect((await rpc({ streamId: initial.streamId, since: 300 })).reset).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  } finally { socket.terminate(); await app.close(); }
  expect(service.listenerCount('event')).toBe(0);
});
