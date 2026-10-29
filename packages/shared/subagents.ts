import type { Turn } from './protocol';

export type AgentState = 'unknown' | 'pendingInit' | 'running' | 'completed' | 'errored' | 'interrupted' | 'shutdown' | 'notFound';
export type AgentSummary = {
  id: string; parentThreadId: string; nickname: string | null; role: string | null;
  status: AgentState; turnId: string | null; startedAt: number | null;
  progress: string | null; result: string | null;
  // Projection ordering only; never displayed as native timing or completion.
  generation: string; revision: number;
};
export type AgentDetail = {
  status: 'ready' | 'unavailable'; message: string; agent?: AgentSummary;
  turns?: Turn[]; nextCursor?: string | null;
};
