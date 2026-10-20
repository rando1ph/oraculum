import type { BridgeEvent, WireMessage } from './protocol';

export class BridgeClient {
  private socket?: WebSocket;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private onEvent: (event: BridgeEvent) => void, private onConnection: (connected: boolean) => void) {}
  connect(): Promise<void> {
    this.close();
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    this.socket = socket;
    socket.onmessage = ({ data }) => {
      if (this.socket !== socket) return;
      let message: WireMessage | BridgeEvent;
      try {
        message = JSON.parse(data) as WireMessage | BridgeEvent;
        if (!message || typeof message !== 'object') throw new Error('Invalid response');
      } catch {
        this.onConnection(false);
        this.rejectPending();
        socket.close(1002, 'Invalid Bridge response');
        return;
      }
      if ('type' in message) { this.onEvent(message); return; }
      const request = this.pending.get(String(message.id));
      if (!request) return;
      this.pending.delete(String(message.id));
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Bridge 连接超时')); }, 10_000);
      socket.onopen = () => {
        clearTimeout(timer);
        if (this.socket === socket) { this.onConnection(true); resolve(); }
        else reject(new Error('连接已被替换'));
      };
      socket.onclose = () => {
        clearTimeout(timer); reject(new Error('Bridge 连接已关闭'));
        if (this.socket !== socket) return;
        this.onConnection(false);
        this.rejectPending();
      };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('无法连接本机 Bridge')); };
    });
  }
  request<T>(method: string, params: object): Promise<T> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('连接已断开；请重新连接并查询状态'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('响应超时，执行结果未知；请查询状态，勿重复发送'));
      }, 65_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.socket!.send(JSON.stringify({ id, method, params })); }
      catch {
        clearTimeout(timer); this.pending.delete(id);
        reject(new Error('发送失败，结果未知；请查询状态，勿自动重试'));
      }
    });
  }
  private rejectPending() {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('连接断开，未确认操作结果未知；重新连接后查询，不自动重发'));
    }
    this.pending.clear();
  }
  close() {
    this.socket?.close();
    this.socket = undefined;
    this.rejectPending();
  }
}
