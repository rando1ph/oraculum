import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Await a bounded renderer flush. Failure requires an explicit native discard choice. */
export class CloseGuard {
  private pending?: { id: string; timer: ReturnType<typeof setTimeout>; confirming: boolean };
  private allowed = false;
  constructor(private notify: (id: string) => void, private confirmDiscard: () => Promise<boolean>,
    private close: () => void, private timeoutMs = 8000) {}
  get canClose(): boolean { return this.allowed; }
  request(): void {
    if (this.pending || this.allowed) return;
    const id = randomUUID();
    const timer = setTimeout(() => { void this.finish(id, false); }, this.timeoutMs);
    this.pending = { id, timer, confirming: false };
    try { this.notify(id); } catch { void this.finish(id, false); }
  }
  acknowledge(id: unknown, saved: unknown): void {
    if (typeof id !== 'string' || !UUID.test(id) || typeof saved !== 'boolean') throw new Error('CLOSE_ACK_INVALID');
    void this.finish(id, saved);
  }
  dispose(): void { if (this.pending) clearTimeout(this.pending.timer); this.pending = undefined; }
  private async finish(id: string, saved: boolean): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.id !== id || pending.confirming) return;
    clearTimeout(pending.timer);
    pending.confirming = true;
    let proceed = saved;
    if (!saved) { try { proceed = await this.confirmDiscard(); } catch { proceed = false; } }
    if (this.pending !== pending) return;
    this.pending = undefined;
    if (proceed) { this.allowed = true; this.close(); }
  }
}
