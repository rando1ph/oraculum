/** Authenticated routing metadata only. OS copy is fixed in each native shell. */
export type TaskNotice = {
  id: string;
  kind: 'completed' | 'failed' | 'approval' | 'input';
  threadId: string;
  cwd: string;
  createdAt: number;
  expiresAt: number;
};
export type NoticeFeed = { notices: TaskNotice[]; generatedAt: number; validUntil: number };
