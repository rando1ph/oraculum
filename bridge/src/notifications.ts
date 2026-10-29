import { randomUUID } from 'node:crypto';
import type { Approval, BridgeEvent } from '../../packages/shared/protocol';
import type { NoticeFeed, TaskNotice } from '../../packages/shared/notifications';

/** A bounded, disposable projection of native facts, never a task/approval ledger. */
export class TaskNotifications {
  private terminal = new Map<string, TaskNotice>();
  private observed = new Set<string>();
  constructor(private cwd: (threadId: string) => string, private root: (threadId: string) => string,
    private now = Date.now) {}

  observe(event: BridgeEvent) {
    if (event.type === 'unavailable') { this.terminal.clear(); return; }
    if (event.type === 'approval') { this.terminal.delete(this.root(event.request.params.threadId)); return; }
    if (event.type === 'threadLifecycleChanged' && event.state !== 'active') {
      this.terminal.delete(event.threadId); return;
    }
    if (event.type !== 'event') return;
    const { method, params } = event.event;
    if (method !== 'turn/started' && method !== 'turn/completed') return;
    const threadId = params?.threadId;
    if (typeof threadId !== 'string' || this.root(threadId) !== threadId) return;
    if (method === 'turn/started') { this.terminal.delete(threadId); return; }
    if (method !== 'turn/completed') return;
    const turn = params?.turn as { id?: string; status?: string } | undefined;
    if (!turn?.id) return;
    const key = `${threadId}:${turn.id}`;
    if (this.observed.has(key)) return;
    this.observed.add(key);
    if (this.observed.size > 512) this.observed.delete(this.observed.values().next().value!);
    if (turn.status !== 'completed' && turn.status !== 'failed') return;
    this.terminal.delete(threadId);
    this.terminal.set(threadId, { id: randomUUID(), kind: turn.status, threadId, cwd: this.cwd(threadId),
      createdAt: this.now(), expiresAt: this.now() + 5 * 60_000 });
    if (this.terminal.size > 64) this.terminal.delete(this.terminal.keys().next().value!);
  }

  feed(pending: Iterable<Approval>): NoticeFeed {
    const now = this.now();
    for (const [id, notice] of this.terminal) if (notice.expiresAt <= now) this.terminal.delete(id);
    const notices = new Map(this.terminal);
    // One OS notification per parent conversation. Requests remain authoritative
    // in BridgeService.pending; resolution on either device removes the reminder.
    const waiting = new Set<string>();
    for (const request of pending) {
      if (!request.bridgeToken) continue;
      const threadId = this.root(request.params.threadId);
      if (waiting.has(threadId)) continue;
      waiting.add(threadId);
      notices.set(threadId, { id: request.bridgeToken,
        kind: request.method === 'item/tool/requestUserInput' || request.method === 'mcpServer/elicitation/request' ? 'input' : 'approval',
        threadId, cwd: this.cwd(threadId), createdAt: now, expiresAt: now + 15_000 });
    }
    return { notices: [...notices.values()].slice(-64), generatedAt: now, validUntil: now + 15_000 };
  }
}
