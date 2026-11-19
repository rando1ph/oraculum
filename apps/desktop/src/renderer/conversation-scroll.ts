import type { DisplayItem } from './Native';

export const MAX_MOUNTED_MESSAGES = 80;
export const ESTIMATED_MESSAGE_HEIGHT = 160;
export interface MessageLayout { keys: string[]; tops: number[]; heights: number[]; total: number; indices: Map<string, number> }

export function displayItemKey(value: DisplayItem): string { return JSON.stringify([value.turnId, value.item.id]); }

export function messageLayout(keys: string[], measured: ReadonlyMap<string, number>): MessageLayout {
  let total = 0;
  const tops: number[] = [], heights: number[] = [], indices = new Map<string, number>();
  for (const [index, key] of keys.entries()) {
    const value = measured.get(key);
    const height = value !== undefined && Number.isFinite(value) && value > 0 ? value : ESTIMATED_MESSAGE_HEIGHT;
    tops.push(total); heights.push(height); indices.set(key, index); total += height;
  }
  return { keys, tops, heights, total, indices };
}

/** First row whose bottom crosses this coordinate; negative/beyond-end positions clamp. */
export function indexAt(layout: MessageLayout, offset: number): number {
  if (!layout.keys.length) return -1;
  let low = 0, high = layout.keys.length - 1;
  const target = Number.isFinite(offset) ? Math.max(0, offset) : 0;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (layout.tops[middle] + layout.heights[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Small lists remain native DOM; long lists render viewport + two screens, capped. */
export function visibleMessageRange(layout: MessageLayout, top: number, height: number): { start: number; end: number } {
  const count = layout.keys.length;
  if (count <= MAX_MOUNTED_MESSAGES) return { start: 0, end: count };
  const viewport = Number.isFinite(height) ? Math.max(1, height) : 800;
  const first = indexAt(layout, Math.max(0, top));
  const before = indexAt(layout, Math.max(0, top - viewport));
  const after = Math.min(count, indexAt(layout, Math.max(0, top) + viewport * 2) + 1);
  // Always include the first visible row even when measurements are extremely small.
  const start = Math.max(before, first - Math.floor(MAX_MOUNTED_MESSAGES / 3));
  return { start, end: Math.min(count, Math.max(first + 1, Math.min(after, start + MAX_MOUNTED_MESSAGES))) };
}

export function anchorScrollTop(layout: MessageLayout, key: string | undefined, offset: number, listTop: number): number | undefined {
  const index = key === undefined ? undefined : layout.indices.get(key);
  if (index === undefined) return undefined;
  // A terminal replacement or local collapse can shorten the anchor itself.
  // Keep at least its last pixel visible instead of jumping into another item.
  const boundedOffset = Math.max(1 - layout.heights[index], Number.isFinite(offset) ? offset : 0);
  return Math.max(0, listTop + layout.tops[index] - boundedOffset);
}
