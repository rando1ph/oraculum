import { create } from 'zustand';
import type { AccountUsageSnapshot, LimitsSnapshot, ThreadUsage, UsageSnapshot } from '../../../packages/shared/usage';

export const usageKey = (cwd: string, threadId: string) => JSON.stringify([cwd, threadId]);
type State = {
  connection: number; connected: boolean;
  account?: LimitsSnapshot; activity?: AccountUsageSnapshot; threads: Record<string, ThreadUsage>;
  connect: (connected: boolean) => void;
  limits: (value: LimitsSnapshot, connection?: number) => void;
  thread: (value: ThreadUsage, connection?: number) => void;
  snapshot: (value: UsageSnapshot, connection: number) => void;
  accountActivity: (value: AccountUsageSnapshot, connection: number) => void;
};
export const useUsage = create<State>((set, get) => ({
  connection: 0, connected: false, threads: {},
  // No browser persistence of account information. Reconnect obtains Bridge's
  // last observed thread snapshot; a Bridge restart can legitimately have none.
  connect: connected => set(state => ({ connection: state.connection + 1, connected, account: undefined, activity: undefined,
    threads: connected ? {} : state.threads })),
  limits: (value, connection = get().connection) => {
    const state = get();
    if (!state.connected || connection !== state.connection || (state.account && value.revision < state.account.revision)) return;
    set({ account: value, ...(state.activity && state.activity.generation !== value.generation ? { activity: undefined } : {}) });
  },
  thread: (value, connection = get().connection) => {
    const state = get(), key = usageKey(value.cwd, value.threadId);
    if (!state.connected || connection !== state.connection || (state.threads[key] && value.revision < state.threads[key].revision)) return;
    set({ threads: { ...state.threads, [key]: value } });
  },
  snapshot: (value, connection) => { get().limits(value.account, connection); if (value.thread) get().thread(value.thread, connection); },
  accountActivity: (value, connection) => {
    const state = get();
    if (!state.connected || connection !== state.connection || (state.account && value.generation !== state.account.generation) ||
      (state.activity && value.revision < state.activity.revision)) return;
    set({ activity: value });
  },
}));
