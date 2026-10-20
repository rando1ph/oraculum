import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BridgeClient } from './client';
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  sent: string[] = [];
  constructor(_url: string) { Socket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
}
beforeEach(() => {
  vi.useFakeTimers(); Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:17860' });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('rejects an unacknowledged operation on disconnect and never retransmits on reconnect', async () => {
  const client = new BridgeClient(vi.fn(), vi.fn());
  const connected = client.connect(); Socket.instances[0].open(); await connected;
  const request = client.request('turn/start', { threadId: 't', text: 'once' });
  const rejection = expect(request).rejects.toThrow('未知');
  Socket.instances[0].close(); await rejection;
  const again = client.connect(); Socket.instances[1].open(); await again;
  expect(Socket.instances[0].sent).toHaveLength(1); expect(Socket.instances[1].sent).toEqual([]);
  client.close();
});
it('times out without retrying and ignores a late reply', async () => {
  const onEvent = vi.fn(); const client = new BridgeClient(onEvent, vi.fn());
  const connected = client.connect(); const socket = Socket.instances[0]; socket.open(); await connected;
  const request = client.request('turn/start', {});
  const rejection = expect(request).rejects.toThrow('结果未知');
  await vi.advanceTimersByTimeAsync(65_000); await rejection;
  socket.onmessage!({ data: JSON.stringify({ id: JSON.parse(socket.sent[0]).id, result: {} }) });
  expect(socket.sent).toHaveLength(1); expect(onEvent).not.toHaveBeenCalled();
  client.close();
});
it('fails a malformed response closed and bounds the connection handshake', async () => {
  const onConnection = vi.fn(); const client = new BridgeClient(vi.fn(), onConnection);
  const connected = client.connect(); Socket.instances[0].open(); await connected;
  const request = client.request('bridge/subscribe', {});
  const rejection = expect(request).rejects.toThrow('未知');
  Socket.instances[0].onmessage!({ data: '{broken' }); await rejection;
  expect(onConnection).toHaveBeenLastCalledWith(false);
  const retry = client.connect(); const timeout = expect(retry).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(10_000); await timeout;
  client.close();
});
