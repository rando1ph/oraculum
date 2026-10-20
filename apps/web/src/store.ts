import { create } from 'zustand';
import type { Approval, ServerNotification, Snapshot, Thread } from '../../../packages/shared/protocol';
import type { ThreadItem } from '../../../.local/codex-protocol/v2/ThreadItem';

type State = {
  thread?: Thread;
  items: Record<string, ThreadItem>;
  pending: Approval[];
  events: string[];
  activeTurn?: string;
  snapshot: (value: Snapshot) => void;
  event: (event: ServerNotification) => void;
  approval: (request: Approval) => void;
};
export const useSession = create<State>((set, get) => ({
  items: {}, pending: [], events: [],
  snapshot: ({ thread, pending }) => set({
    thread, pending,
    items: Object.fromEntries(thread.turns.flatMap(turn => turn.items).map(item => [item.id, item])),
    activeTurn: thread.turns.find(turn => turn.status === 'inProgress')?.id,
  }),
  approval: request => {
    if (request.params.threadId !== get().thread?.id) return;
    set({ pending: [...get().pending.filter(p => p.id !== request.id), request] });
  },
  event: event => {
    const state = get();
    if (!('threadId' in event.params) || event.params.threadId !== state.thread?.id) return;
    const changes: Partial<State> = { events: [...state.events.slice(-99), event.method] };
    if (event.method === 'turn/started') changes.activeTurn = event.params.turn.id;
    if (event.method === 'turn/completed') {
      changes.activeTurn = undefined;
      changes.pending = [];
    }
    if (event.method === 'item/started' || event.method === 'item/completed') {
      changes.items = { ...state.items, [event.params.item.id]: event.params.item };
    }
    if (event.method === 'item/agentMessage/delta') {
      const { itemId, delta } = event.params;
      const item = state.items[itemId];
      if (item?.type === 'agentMessage') changes.items = { ...state.items, [itemId]: { ...item, text: item.text + delta } };
    }
    if (event.method === 'item/commandExecution/outputDelta') {
      const { itemId, delta } = event.params;
      const item = state.items[itemId];
      if (item?.type === 'commandExecution') changes.items = { ...state.items, [itemId]: { ...item, aggregatedOutput: (item.aggregatedOutput ?? '') + delta } };
    }
    if (event.method === 'serverRequest/resolved') changes.pending = state.pending.filter(p => p.id !== event.params.requestId);
    set(changes);
  },
}));
