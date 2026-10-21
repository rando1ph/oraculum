import { expect, it } from 'vitest';
import { analyzeDiff } from './diff-lines';

it('counts and highlights header-like source text as changes inside a hunk', () => {
  const diff = ['--- a/example.txt', '+++ b/example.txt', '@@ -1,2 +1,2 @@', '--- before', '+++ after', ' unchanged'].join('\n');
  expect(analyzeDiff(diff)).toEqual({
    kinds: ['file', 'file', 'hunk', 'removed', 'added', ''], added: 1, removed: 1,
  });
});

it('recognizes the next file headers after completed hunks without a git separator', () => {
  const diff = ['--- a/one', '+++ b/one', '@@ -1 +1 @@', '--- first', '+++ first',
    '--- a/two', '+++ b/two', '@@ -0,0 +1,2 @@', '+++ second', '+new line'].join('\n');
  expect(analyzeDiff(diff)).toEqual({
    kinds: ['file', 'file', 'hunk', 'removed', 'added', 'file', 'file', 'hunk', 'added', 'added'], added: 3, removed: 1,
  });
});

it('keeps partial streamed hunks and no-newline markers from changing the counts', () => {
  const diff = ['diff --git a/one b/one', '--- a/one', '+++ b/one', '@@ -1,2 +1,2 @@', '-old', '\\ No newline at end of file', '+++ new'].join('\n');
  expect(analyzeDiff(diff)).toEqual({
    kinds: ['file', 'file', 'file', 'hunk', 'removed', '', 'added'], added: 1, removed: 1,
  });
});
