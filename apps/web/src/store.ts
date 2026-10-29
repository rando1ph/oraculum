import { create } from 'zustand';
import type { Approval, NativeOperation, ServerNotification, Snapshot, Thread, ThreadItem, Turn } from '../../../packages/shared/protocol';
import type { AgentSummary } from '../../../packages/shared/subagents';

export const itemKey = (turnId: string, itemId: string) => JSON.stringify([turnId, itemId]);
export type ItemView = { turnId: string; item: ThreadItem; source: 'native' | 'live'; complete: boolean; progress?: string[] };
type State = {
  agents: Record<string, AgentSummary>;
  subagent: (agent: AgentSummary, ancestors: string[]) => void;
  thread?: Thread;
  items: Record<string, ItemView>;
  turns: Record<string, Turn>;
  pending: Approval[];
  events: string[];
  notices: string[];
  activeTurn?: string;
  lastTurnId?: string;
  history?: Snapshot['history'];
  settings?: Snapshot['settings'];
  diffs: Record<string, string>;
  plans: Record<string, string>;
  planAfter: Record<string, string | undefined>;
  plan: string;
  sendBlocked: boolean;
  receipts: NonNullable<Snapshot['receipts']>;
  attachments: NonNullable<Snapshot['attachments']>;
  nativeOperations: NativeOperation[];
  nativeCapabilities?: Snapshot['nativeCapabilities'];
  historyRevision: number;
  historyReloading: boolean;
  discardedTurns: string[];
  nativeOperation: (operation: NativeOperation) => void;
  invalidateHistory: (revision: number) => void;
  reset: () => void;
  snapshot: (value: Snapshot) => void;
  older: (value: Snapshot) => void;
  event: (event: ServerNotification, skipDeltas?: boolean) => void;
  approval: (request: Approval) => void;
};
const empty = () => ({ agents: {}, thread: undefined, items: {}, turns: {}, pending: [], events: [], notices: [],
  activeTurn: undefined, lastTurnId: undefined, history: undefined, settings: undefined, sendBlocked: false, receipts: [],
  attachments: [], nativeOperations: [], nativeCapabilities: undefined, historyRevision: 0, historyReloading: false, discardedTurns: [],
  diffs: {}, plans: {}, planAfter: {}, plan: '' });

// Native pages define the order of their items. Keep observed-only records at
// their nearest surviving native anchor instead of moving them to the end.
function nativeOrder<T>(previous: Record<string, T>, incoming: Record<string, T>, unanchored: 'before' | 'after' = 'before'): Record<string, T> {
  const keys = Object.keys(incoming);
  if (!keys.length) return { ...previous };
  const native = new Set(keys);
  const before = new Map<string, string[]>();
  let pending: string[] = [];
  let lastAnchor: string | undefined;
  for (const key of Object.keys(previous)) {
    if (native.has(key)) {
      before.set(key, pending); pending = []; lastAnchor = key;
    } else pending.push(key);
  }
  const ordered = keys.flatMap(key => [...before.get(key) ?? [], key, ...(key === lastAnchor ? pending : [])]);
  if (!lastAnchor) unanchored === 'before' ? ordered.unshift(...pending) : ordered.push(...pending);
  return Object.fromEntries(ordered.map(key => [key, incoming[key] ?? previous[key]]));
}

function mergeTurn(previous: Turn | undefined, incoming: Turn): Turn {
  if (!previous) return incoming;
  const merged = { ...previous, ...incoming };
  for (const field of ['startedAt', 'completedAt', 'durationMs'] as const) {
    if (incoming[field] == null && previous[field] != null) merged[field] = previous[field];
  }
  // A snapshot or queued start can be older than an observed terminal event.
  if (previous.status !== 'inProgress' && incoming.status === 'inProgress') {
    merged.status = previous.status;
    merged.error = previous.error;
  }
  return merged;
}

function mergeAgents(previous: State['agents'], incoming: AgentSummary[]) {
  const result = { ...previous };
  for (const agent of incoming) {
    const old = result[agent.id];
    if (old?.generation === agent.generation && old.revision >= agent.revision) continue;
    result[agent.id] = agent;
  }
  return result;
}

function mergeAgentItem(previous: ThreadItem | undefined, incoming: ThreadItem): ThreadItem {
  if (previous?.type === 'collabAgentToolCall' && incoming.type === 'collabAgentToolCall') {
    const agentsStates = { ...incoming.agentsStates };
    for (const [id, state] of Object.entries(previous.agentsStates)) if (state && ['completed', 'errored', 'interrupted', 'shutdown', 'notFound'].includes(state.status) &&
      agentsStates[id] && ['pendingInit', 'running'].includes(agentsStates[id]!.status)) agentsStates[id] = state;
    return { ...incoming, agentsStates };
  }
  if (previous?.type === 'subAgentActivity' && incoming.type === 'subAgentActivity' && ['completed', 'interrupted'].includes(previous.kind) && incoming.kind === 'started') return previous;
  return incoming;
}

function nativeItems(thread: Thread, previous: State['items']): State['items'] {
  const items: State['items'] = {};
  for (const turn of thread.turns) for (const item of turn.items) {
    const key = itemKey(turn.id, item.id);
    const prior = previous[key];
    // A completed live item is newer than a still-running history snapshot.
    if (prior?.complete && turn.status === 'inProgress') {
      items[key] = prior;
      continue;
    }
    items[key] = { ...prior, turnId: turn.id, item: mergeAgentItem(prior?.item, item), source: 'native',
      complete: turn.status !== 'inProgress' || ('status' in item && item.status !== 'inProgress') };
  }
  return items;
}
export const useSession = create<State>((set, get) => ({
  ...empty(),
  reset: () => set(empty()),
  subagent: (agent, ancestors) => {
    if (!get().thread?.id || !ancestors.includes(get().thread!.id)) return;
    set({ agents: mergeAgents(get().agents, [agent]) });
  },
  nativeOperation: operation => {
    const state = get();
    if (operation.threadId !== state.thread?.id) return;
    const prior = state.nativeOperations.find(value => value.operationId === operation.operationId);
    if (prior && ['completed', 'rejected'].includes(prior.state) && ['running', 'accepted', 'unknown'].includes(operation.state)) return;
    set({ nativeOperations: [...state.nativeOperations.filter(value => value.operationId !== operation.operationId), operation] });
  },
  invalidateHistory: revision => {
    const state = get();
    if (revision <= state.historyRevision) return;
    set({ items: {}, turns: {}, pending: [], receipts: [], attachments: [], diffs: {}, plans: {}, planAfter: {}, plan: '',
      activeTurn: undefined, lastTurnId: undefined, history: undefined, historyRevision: revision,
      historyReloading: true, sendBlocked: true,
      discardedTurns: [...new Set([...state.discardedTurns, ...Object.keys(state.turns)])] });
  },
  snapshot: ({ thread, pending, history, settings, sendBlocked, receipts, attachments, nativeOperations, nativeCapabilities, agents, historyRevision = 0 }) => {
    const state = get();
    const same = state.thread?.id === thread.id;
    if (same && historyRevision < state.historyRevision) return;
    const retain = same && historyRevision === state.historyRevision;
    const previous = retain ? state.items : {};
    const items = nativeOrder(previous, nativeItems(thread, previous));
    const turns = nativeOrder(retain ? state.turns : {}, Object.fromEntries(thread.turns.map(turn =>
      [turn.id, mergeTurn(retain ? state.turns[turn.id] : undefined, turn)])));
    const lastTurnId = Object.keys(turns).at(-1);
    // Retain live items internally; never persist them as native history.
    const discarded = same ? [...new Set([...state.discardedTurns, ...(!retain ? Object.keys(state.turns) : [])])] : [];
    set({ ...(retain ? {} : empty()), thread, pending, items, history, settings, sendBlocked: !!sendBlocked, receipts: receipts ?? [],
      agents: mergeAgents(retain ? state.agents : {}, agents ?? []),
      nativeOperations: nativeOperations ?? [], nativeCapabilities, historyRevision, historyReloading: false,
      attachments: [...(retain ? state.attachments.filter(prior => !attachments?.some(value => value.operationId === prior.operationId)) : []), ...(attachments ?? [])],
      discardedTurns: discarded.filter(id => !(id in turns)),
      turns, lastTurnId, plan: retain && lastTurnId ? state.plans[lastTurnId] ?? '' : '',
      activeTurn: thread.turns.find(turn => turns[turn.id].status === 'inProgress')?.id });
  },
  older: snapshot => {
    const state = get();
    if (snapshot.thread.id !== state.thread?.id) return;
    if (state.historyReloading || (snapshot.historyRevision ?? 0) !== state.historyRevision) return;
    const incoming = nativeItems(snapshot.thread, state.items);
    const ordered = nativeOrder(state.items, incoming, 'after');
    set({ items: Object.fromEntries(Object.keys(ordered).map(key => [key, state.items[key] ?? ordered[key]])),
      agents: mergeAgents(state.agents, snapshot.agents ?? []),
      attachments: [...state.attachments.filter(prior => !snapshot.attachments?.some(value => value.operationId === prior.operationId)), ...(snapshot.attachments ?? [])],
      turns: nativeOrder(state.turns, Object.fromEntries(snapshot.thread.turns.map(turn =>
        [turn.id, state.turns[turn.id] ?? turn])), 'after'),
      history: snapshot.history, discardedTurns: state.discardedTurns.filter(id => !snapshot.thread.turns.some(turn => turn.id === id)) });
  },
  approval: request => {
    const state = get();
    const threadId = state.thread?.id;
    if (!threadId || (request.params.threadId !== threadId && !request.displayThreadIds?.includes(threadId))) return;
    if (state.historyReloading || typeof request.params.turnId === 'string' && state.discardedTurns.includes(request.params.turnId)) return;
    set({ pending: [...state.pending.filter(p => p.id !== request.id), request] });
  },
  event: (event, skipDeltas = false) => {
    const state = get();
    if (!('threadId' in event.params) || event.params.threadId !== state.thread?.id) return;
    if (event.method === 'thread/name/updated') {
      set({ thread: { ...state.thread!, name: event.params.threadName ?? null } });
      return;
    }
    const turnId = 'turnId' in event.params ? event.params.turnId : 'turn' in event.params ? event.params.turn.id : undefined;
    if (state.historyReloading || (typeof turnId === 'string' && state.discardedTurns.includes(turnId))) return;
    const changes: Partial<State> = { events: [...state.events.slice(-99), event.method] };
    if (event.method === 'turn/started' || event.method === 'turn/completed') {
      const turn = mergeTurn(state.turns[event.params.turn.id], event.params.turn);
      changes.turns = { ...state.turns, [turn.id]: turn };
      if (event.params.turn.items?.length) {
        const received: State['items'] = {};
        for (const item of event.params.turn.items) {
          const key = itemKey(turn.id, item.id);
          const prior = state.items[key];
          // Individual completed items are authoritative. A nonempty Turn can
          // still supply items whose lifecycle notifications were not observed.
          received[key] = prior?.complete ? prior : { ...prior, turnId: turn.id, item, source: 'live',
            complete: event.method === 'turn/completed' || ('status' in item && item.status !== 'inProgress') };
        }
        changes.items = nativeOrder(state.items, received);
      }
      if (event.method === 'turn/started' ? turn.status === 'inProgress' : !state.activeTurn || state.activeTurn === turn.id) changes.lastTurnId = turn.id;
      changes.activeTurn = event.method === 'turn/started' && turn.status === 'inProgress' ? turn.id : state.activeTurn === turn.id ? undefined : state.activeTurn;
      if (event.method === 'turn/started' && turn.status === 'inProgress') changes.plan = state.plans[turn.id] ?? '';
      if (event.method === 'turn/completed') {
        changes.pending = state.pending.filter(p => p.params.turnId !== turn.id);
        // Only a fresh Bridge snapshot can resolve persisted send uncertainty.
      }
    }
    if (event.method === 'thread/status/changed') changes.thread = { ...state.thread!, status: event.params.status };
    if (event.method === 'thread/settings/updated') {
      const settings = event.params.threadSettings;
      if (settings?.approvalPolicy && settings.sandboxPolicy?.type && settings.approvalsReviewer) {
        changes.settings = { ...state.settings, approvalPolicy: settings.approvalPolicy, sandbox: settings.sandboxPolicy, approvalsReviewer: settings.approvalsReviewer,
          ...(typeof settings.model === 'string' ? { model: settings.model } : {}),
          ...(settings.effort !== undefined ? { effort: settings.effort } : {}),
        };
      }
    }
    if (event.method === 'item/started' || event.method === 'item/completed') {
      const { item, turnId } = event.params;
      const key = itemKey(turnId, item.id);
      const view = state.items[key];
      if (event.method === 'item/completed' || (!view?.complete && !(skipDeltas && view))) {
        changes.items = { ...state.items, [key]: { ...view, turnId, item: mergeAgentItem(view?.item, item), source: 'live', complete: event.method === 'item/completed' } };
      }
    }
    if (!skipDeltas && 'itemId' in event.params && 'turnId' in event.params && typeof event.params.turnId === 'string') {
      const key = itemKey(event.params.turnId, event.params.itemId);
      const view = state.items[key];
      if (view && !view.complete && (!state.turns[view.turnId] || state.turns[view.turnId].status === 'inProgress')) {
        const item = view.item;
        let updated: ThreadItem | undefined;
        if (item.type === 'plan' && event.method === 'item/plan/delta') updated = { ...item, text: item.text + event.params.delta };
        if (item.type === 'reasoning') {
          if (event.method === 'item/reasoning/summaryPartAdded' || event.method === 'item/reasoning/summaryTextDelta') {
            const summary = [...item.summary];
            const index = event.params.summaryIndex;
            summary[index] = (summary[index] ?? '') + (event.method === 'item/reasoning/summaryTextDelta' ? event.params.delta : '');
            updated = { ...item, summary };
          }
          if (event.method === 'item/reasoning/textDelta') {
            const content = [...item.content];
            const index = event.params.contentIndex;
            content[index] = (content[index] ?? '') + event.params.delta;
            updated = { ...item, content };
          }
        }
        if (item.type === 'fileChange' && event.method === 'item/fileChange/patchUpdated') updated = { ...item, changes: event.params.changes };
        if (updated) changes.items = { ...state.items, [key]: { ...view, item: updated } };
        if (item.type === 'mcpToolCall' && event.method === 'item/mcpToolCall/progress') {
          changes.items = { ...state.items, [key]: { ...view, progress: [...view.progress ?? [], event.params.message] } };
        }
      }
    }
    if (event.method === 'item/agentMessage/delta' || event.method === 'item/commandExecution/outputDelta') {
      const { itemId, delta, turnId } = event.params;
      const key = itemKey(turnId, itemId);
      const view = state.items[key];
      if (!skipDeltas && view && !view.complete && (!state.turns[turnId] || state.turns[turnId].status === 'inProgress')) {
        const item = view.item;
        if (item.type === 'agentMessage' && event.method === 'item/agentMessage/delta') {
          changes.items = { ...state.items, [key]: { ...view, item: { ...item, text: item.text + delta } } };
        }
        if (item.type === 'commandExecution' && event.method === 'item/commandExecution/outputDelta') {
          changes.items = { ...state.items, [key]: { ...view, item: { ...item, aggregatedOutput: (item.aggregatedOutput ?? '') + delta } } };
        }
      }
    }
    if (event.method === 'serverRequest/resolved') changes.pending = state.pending.filter(p => p.id !== event.params.requestId);
    if (event.method === 'turn/diff/updated') changes.diffs = { ...state.diffs, [event.params.turnId]: event.params.diff };
    if (event.method === 'turn/plan/updated') {
      const plan = [event.params.explanation, ...event.params.plan.map(p => `${p.status} · ${p.step}`)].filter(Boolean).join('\n');
      changes.plans = { ...state.plans, [event.params.turnId]: plan };
      changes.planAfter = { ...state.planAfter, [event.params.turnId]: Object.values(state.items).filter(view => view.turnId === event.params.turnId).at(-1)?.item.id };
      if (event.params.turnId === state.activeTurn || event.params.turnId === state.lastTurnId) changes.plan = plan;
    }
    if (event.method === 'error') changes.notices = [...state.notices, `${event.params.willRetry ? 'Codex 正在重试' : '错误'}：${event.params.error.message}`];
    set(changes);
  },
}));
