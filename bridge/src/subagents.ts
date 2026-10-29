import { randomUUID } from 'node:crypto';
import type { Thread, ThreadItem, Turn, WireMessage } from '../../packages/shared/protocol';
import type { AgentState, AgentSummary } from '../../packages/shared/subagents';

const text = (value: unknown, max = 1200) => typeof value === 'string' && value ? value.slice(0, max) : null;
const timestamp = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const turnState = (turn: Turn): AgentState => ({ inProgress: 'running', completed: 'completed', failed: 'errored', interrupted: 'interrupted' })[turn.status] as AgentState;
const terminal = (status: AgentState) => ['completed', 'errored', 'interrupted', 'shutdown', 'notFound'].includes(status);
export function internalAgent(thread: Thread) {
  return typeof thread.source === 'object' && thread.source !== null && 'subAgent' in thread.source &&
    typeof thread.source.subAgent === 'string' && ['review', 'compact', 'memory_consolidation'].includes(thread.source.subAgent);
}

// A transient display projection of already authorized native threads. No
// execution, polling, scheduling, persisted transcript or request routing.
export class AgentSummaries {
  readonly values = new Map<string, AgentSummary>();
  readonly references = new Map<string, Set<string>>();
  private generation = randomUUID();
  private terminalTurns = new Map<string, Set<string>>();

  register(thread: Thread, parentThreadId: string) {
    const previous = this.values.get(thread.id);
    const value: AgentSummary = { id: thread.id, parentThreadId,
      nickname: text(thread.agentNickname, 160) ?? text(thread.name, 160), role: text(thread.agentRole, 160),
      status: 'unknown', turnId: null, startedAt: null, progress: null, result: null,
      generation: this.generation, revision: 0, ...previous };
    value.nickname = text(thread.agentNickname, 160) ?? text(thread.name, 160) ?? value.nickname;
    value.role = text(thread.agentRole, 160) ?? value.role;
    return this.save(value);
  }
  observeReferences(owner: string, items: ThreadItem[]) {
    const ids = this.references.get(owner) ?? new Set<string>();
    for (const item of items) {
      if (item.type === 'collabAgentToolCall') {
        for (const id of [...item.receiverThreadIds ?? [], ...Object.keys(item.agentsStates ?? {})]) if (id && id !== owner) ids.add(id);
      }
      if (item.type === 'subAgentActivity' && item.agentThreadId !== owner) ids.add(item.agentThreadId);
    }
    this.references.set(owner, ids);
  }
  private save(value: AgentSummary) {
    const next = { ...value, revision: value.revision + 1 };
    this.values.set(next.id, next);
    return next;
  }
  observe(threadId: string, event: WireMessage): AgentSummary | undefined {
    const old = this.values.get(threadId);
    if (!old) return;
    const params = event.params ?? {}, next = { ...old };
    if (event.method === 'turn/started' || event.method === 'turn/completed') {
      const turn = params.turn as Turn | undefined;
      if (!turn?.id || !turnState(turn)) return;
      const ended = this.terminalTurns.get(threadId) ?? new Set<string>();
      const startedAt = timestamp(turn.startedAt);
      if (event.method === 'turn/completed' && (turn.status === 'inProgress' || ended.has(turn.id))) return;
      // A delayed/duplicate start never revives an ended turn. Across distinct
      // turns require native ordering before replacing a confirmed terminal.
      if (event.method === 'turn/started' && (ended.has(turn.id) ||
        terminal(old.status) && (startedAt === null || old.startedAt !== null && startedAt <= old.startedAt))) return;
      if (old.turnId && old.turnId !== turn.id && (ended.has(turn.id) ||
        startedAt !== null && old.startedAt !== null && startedAt <= old.startedAt)) return;
      if (old.turnId && old.turnId !== turn.id && event.method === 'turn/completed' && startedAt === null) return;
      if (old.turnId !== turn.id) { next.progress = null; next.result = null; }
      next.turnId = turn.id; next.startedAt = startedAt ?? old.startedAt; next.status = turnState(turn);
      if (event.method === 'turn/completed') {
        ended.add(turn.id); this.terminalTurns.set(threadId, ended);
        const answer = turn.items?.filter(item => item.type === 'agentMessage' && item.phase === 'final_answer').at(-1);
        if (answer?.type === 'agentMessage') next.result = text(answer.text);
      }
      return this.save(next);
    }
    if (event.method === 'item/completed') {
      const item = params.item as ThreadItem | undefined;
      if (params.turnId !== old.turnId || this.terminalTurns.get(threadId)?.has(params.turnId as string)) return;
      if (item?.type === 'agentMessage') {
        if (item.phase === 'final_answer') next.result = text(item.text);
        else if (item.phase === 'commentary') next.progress = text(item.text);
        else return;
        return this.save(next);
      }
    }
    if (event.method === 'item/mcpToolCall/progress' && params.turnId === old.turnId && !terminal(old.status)) {
      next.progress = text(params.message); return this.save(next);
    }
  }
  hydrate(thread: Thread, revision: number) {
    const old = this.values.get(thread.id);
    if (!old || old.revision !== revision) return;
    const turn = thread.turns.at(-1);
    if (turn) {
      const latest = this.observe(thread.id, { method: turn.status === 'inProgress' ? 'turn/started' : 'turn/completed', params: { turn } });
      // A loaded native history may include completed commentary even while the
      // turn itself is running; project that same visible progress once.
      if (latest && turn.status === 'inProgress') for (const item of turn.items) this.observe(thread.id, { method: 'item/completed', params: { turnId: turn.id, item } });
    }
  }
}
