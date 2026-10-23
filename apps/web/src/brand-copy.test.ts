import { describe, expect, it } from 'vitest';
import { emptyBrandState } from './brand-copy';

describe('empty conversation brand state', () => {
  it('prioritizes the missing or unavailable project over either selected-thread state', () => {
    for (const threadId of [undefined, 'thread-1']) {
      expect(emptyBrandState({ projectAvailable: false, threadId, createdThreadId: 'thread-1', hasActivity: false })).toBe('noProject');
    }
  });
  it('distinguishes no thread, a current creation, and an existing empty thread', () => {
    const input = { projectAvailable: true, hasActivity: false, createdThreadId: 'thread-1' };
    expect(emptyBrandState(input)).toBe('beforeThread');
    expect(emptyBrandState({ ...input, threadId: 'thread-1' })).toBe('createdThread');
    expect(emptyBrandState({ ...input, threadId: 'thread-2' })).toBe('existingThread');
    expect(emptyBrandState({ ...input, threadId: 'thread-1', createdThreadId: '' })).toBe('existingThread');
  });
  it('does not describe a live turn, pending approval, or messages as an empty conversation', () => {
    expect(emptyBrandState({ projectAvailable: false, threadId: 'thread-1', createdThreadId: 'thread-1', hasActivity: true })).toBeUndefined();
  });
});
