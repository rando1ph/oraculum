export type DiffLineKind = '' | 'file' | 'hunk' | 'added' | 'removed';

export function analyzeDiff(text: string) {
  let added = 0, removed = 0;
  let oldRemaining = 0, newRemaining = 0;
  const kinds: DiffLineKind[] = text.split('\n').map(line => {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldRemaining = Number(hunk[1] ?? 1);
      newRemaining = Number(hunk[2] ?? 1);
      return 'hunk';
    }
    if (line.startsWith('diff ')) {
      oldRemaining = newRemaining = 0;
      return 'file';
    }
    // Header-like text is ordinary source content while a hunk still has lines.
    // Consuming both counts also identifies plain unified multi-file boundaries.
    const inHunk = oldRemaining > 0 || newRemaining > 0;
    const kind = !inHunk && /^(?:\+\+\+|---)[ \t]/.test(line) ? 'file'
      : line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : line.startsWith('@@') ? 'hunk' : '';
    if (inHunk) {
      if (kind === 'removed' || line.startsWith(' ')) oldRemaining--;
      if (kind === 'added' || line.startsWith(' ')) newRemaining--;
    }
    if (kind === 'added') added++;
    if (kind === 'removed') removed++;
    return kind;
  });
  return { kinds, added, removed };
}
