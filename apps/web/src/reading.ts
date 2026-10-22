/** Device-local reading metadata, keyed by native item identity; never conversation content. */
export type ReadingPosition = {
  itemId?: string;
  turnId?: string;
  offset: number;
  top: number;
  bottom: boolean;
};

function itemElements(scroller: HTMLElement) {
  return Array.from(scroller.querySelectorAll<HTMLElement>('[data-turn-id][data-item-id]'));
}

export function captureReading(scroller: HTMLElement): ReadingPosition {
  const edge = scroller.getBoundingClientRect().top;
  const items = itemElements(scroller);
  const anchor = items.find(item => item.getBoundingClientRect().bottom > edge + 1) ?? items.at(-1);
  return {
    itemId: anchor?.dataset.itemId,
    turnId: anchor?.dataset.turnId,
    offset: anchor ? anchor.getBoundingClientRect().top - edge : 0,
    top: scroller.scrollTop,
    bottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60,
  };
}

export function parseReading(stored: string | null): ReadingPosition | undefined {
  try {
    const value = JSON.parse(stored ?? 'null');
    if (!value || !Number.isFinite(value.top) || value.top < 0 || typeof value.bottom !== 'boolean') return;
    const hasAnchor = typeof value.itemId === 'string' && typeof value.turnId === 'string' && Number.isFinite(value.offset);
    return { top: value.top, bottom: value.bottom, offset: hasAnchor ? value.offset : 0,
      ...(hasAnchor ? { itemId: value.itemId, turnId: value.turnId } : {}) };
  } catch { return; }
}

export function placeReading(scroller: HTMLElement, position?: ReadingPosition) {
  if (!position || position.bottom) { scroller.scrollTop = scroller.scrollHeight; return; }
  const anchor = position.itemId && itemElements(scroller).find(item => item.dataset.itemId === position.itemId && item.dataset.turnId === position.turnId);
  scroller.scrollTop = anchor
    ? scroller.scrollTop + anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - position.offset
    : position.top;
}

/** A read-only history lookup must not hold restoration indefinitely. */
export async function readingDeadline<T>(request: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Reading history deadline reached')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
