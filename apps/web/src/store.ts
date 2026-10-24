import { create } from 'zustand';
import type { Approval, ServerNotification, Snapshot, Thread, ThreadItem, Turn } from '../../../packages/shared/protocol';

export const itemKey = (turnId: string, itemId: string) => JSON.stringify([turnId, itemId]);
export type ItemView = { turnId: string; item: ThreadItem; source: 'native' | 'live'; complete: boolean };
type State = {
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
  plan: string;
  sendBlocked: boolean;
  receipts: NonNullable<Snapshot['receipts']>;
  reset: () => void;
  snapshot: (value: Snapshot) => void;
  older: (value: Snapshot) => void;
  event: (event: ServerNotification, skipDeltas?: boolean) => void;
  approval: (request: Approval) => void;
};
const empty = () => ({ thread: undefined, items: {}, turns: {}, pending: [], events: [], notices: [],
  activeTurn: undefined, lastTurnId: undefined, history: undefined, settings: undefined, sendBlocked: false, receipts: [], diffs: {}, plan: '' });
export const useSession = create<State>((set, get) => ({
  ...empty(),
  reset: () => set(empty()),
  snapshot: ({ thread, pending, history, settings, sendBlocked, receipts }) => {
    const same = get().thread?.id === thread.id;
    const items: State['items'] = same ? { ...get().items } : {};
    for (const turn of thread.turns) for (const item of turn.items) {
      items[itemKey(turn.id, item.id)] = { turnId: turn.id, item, source: 'native', complete: turn.status !== 'inProgress' };
    }
    // Retain live items internally; never persist them as native history.
    set({ ...(same ? {} : empty()), thread, pending, items, history, settings, sendBlocked: !!sendBlocked, receipts: receipts ?? [],
      turns: { ...(same ? get().turns : {}), ...Object.fromEntries(thread.turns.map(turn => [turn.id, turn])) },
      lastTurnId: thread.turns.at(-1)?.id,
      activeTurn: thread.turns.find(turn => turn.status === 'inProgress')?.id });
  },
  older: snapshot => {
    if (snapshot.thread.id !== get().thread?.id) return;
    const items: State['items'] = {};
    for (const turn of snapshot.thread.turns) for (const item of turn.items) {
      items[itemKey(turn.id, item.id)] = { turnId: turn.id, item, source: 'native', complete: turn.status !== 'inProgress' };
    }
    set({ items: { ...items, ...get().items },
      turns: { ...Object.fromEntries(snapshot.thread.turns.map(t => [t.id, t])), ...get().turns },
      history: snapshot.history });
  },
  approval: request => {
    const threadId = get().thread?.id;
    if (!threadId || (request.params.threadId !== threadId && !request.displayThreadIds?.includes(threadId))) return;
    set({ pending: [...get().pending.filter(p => p.id !== request.id), request] });
  },
  event: (event, skipDeltas = false) => {
    const state = get();
    if (!('threadId' in event.params) || event.params.threadId !== state.thread?.id) return;
    const changes: Partial<State> = { events: [...state.events.slice(-99), event.method] };
    if (event.method === 'turn/started' || event.method === 'turn/completed') {
      const turn = event.params.turn;
      changes.turns = { ...state.turns, [turn.id]: turn };
      if (event.method === 'turn/started' || !state.activeTurn || state.activeTurn === turn.id) changes.lastTurnId = turn.id;
      changes.activeTurn = event.method === 'turn/started' ? turn.id : state.activeTurn === turn.id ? undefined : state.activeTurn;
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
      if (event.method === 'item/completed' || !state.items[key]?.complete) {
        changes.items = { ...state.items, [key]: { turnId, item, source: 'live', complete: event.method === 'item/completed' } };
      }
    }
    if (event.method === 'item/agentMessage/delta' || event.method === 'item/commandExecution/outputDelta') {
      const { itemId, delta, turnId } = event.params;
      const key = itemKey(turnId, itemId);
      const view = state.items[key];
      if (!skipDeltas && view && !view.complete) {
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
    if (event.method === 'turn/plan/updated') changes.plan = [event.params.explanation, ...event.params.plan.map(p => `${p.status} · ${p.step}`)].filter(Boolean).join('\n');
    if (event.method === 'error') changes.notices = [...state.notices, `${event.params.willRetry ? 'Codex 正在重试' : '错误'}：${event.params.error.message}`];
    set(changes);
  },
}));
