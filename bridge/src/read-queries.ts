import { randomUUID } from 'node:crypto';
import { requestTrace } from './diagnostics';

export const nativeReads = new Set(['config/read', 'model/list', 'thread/list', 'thread/read', 'thread/resume', 'thread/turns/list', 'thread/items/list', 'account/rateLimits/read']);
// No mutation enters this map. A timeout removes the waiter, never replays work.
export class ReadQueries {
  private pending = new Map<string, Promise<unknown>>();
  private generation = 0;
  constructor(private timeoutMs = 8000) {}
  invalidate() { this.generation++; }
  run<T>(method: string, params: object, read: () => Promise<T>, coalesce = true): Promise<T> {
    const key = JSON.stringify([this.generation, method, params, coalesce ? '' : randomUUID()]);
    const prior = this.pending.get(key);
    if (prior) return prior as Promise<T>;
    const id = randomUUID(), parentRequestId = requestTrace.getStore(), start = performance.now();
    let timer: ReturnType<typeof setTimeout>;
    let outcome = 'ok';
    const promise = Promise.race([Promise.resolve().then(read), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { outcome = 'timeout'; reject(new Error(`${method}: 只读查询超时，可重新查询状态`)); }, this.timeoutMs);
    })]).catch(error => { if (outcome === 'ok') outcome = 'error'; throw error; }).finally(() => {
      clearTimeout(timer); this.pending.delete(key);
      const elapsedMs = Math.round(performance.now() - start);
      if (outcome === 'timeout' || elapsedMs >= 1000 || process.env.ORACULUM_DIAGNOSTICS === '1') console.info(JSON.stringify({ layer: 'native-read', requestId: id, parentRequestId, method, elapsedMs, outcome }));
    });
    this.pending.set(key, promise);
    return promise;
  }
}
