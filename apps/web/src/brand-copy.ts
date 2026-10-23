// Brand Copy v0.2 — approved wording and punctuation, Notion Phase 4B.
export const brandCopy = {
  beforeThread: '万象俯首，静候神谕。',
  createdThread: '谕章初启，诸界屏息。',
  noProject: '万象无疆，诸界未名。',
  existingThread: '谕令未书，万象屏息。',
  create: '启封神谕',
  placeholder: '意志将临…',
  inspectorTitle: '洞见幽微',
  inspectorDescription: '所行皆迹，所隐皆明。',
} as const;

export type EmptyBrandState = 'noProject' | 'beforeThread' | 'createdThread' | 'existingThread';

// Presentation only: the caller keeps the creation marker in component memory.
// Native messages, approvals or turns are never replaced by an empty-state slogan.
export function emptyBrandState(input: {
  projectAvailable: boolean;
  threadId?: string;
  createdThreadId: string;
  hasActivity: boolean;
}): EmptyBrandState | undefined {
  if (input.hasActivity) return undefined;
  if (!input.projectAvailable) return 'noProject';
  if (!input.threadId) return 'beforeThread';
  return input.createdThreadId === input.threadId ? 'createdThread' : 'existingThread';
}
