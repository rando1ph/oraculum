import { describe, expect, it } from 'vitest';
import { panelWidths, sendShortcut } from './desktop-interaction';

describe('desktop keyboard and panel boundaries', () => {
  const enter = { key: 'Enter', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, timeStamp: 1000 };
  it('does not submit a composition confirmation, including a Chromium 229 fallback or just-finished composition', () => {
    expect(sendShortcut(enter, true)).toBe(false);
    expect(sendShortcut({ ...enter, isComposing: true })).toBe(false);
    expect(sendShortcut({ ...enter, keyCode: 229 })).toBe(false);
    expect(sendShortcut(enter, false, 990)).toBe(false);
    expect(sendShortcut(enter, false, 940)).toBe(true);
  });
  it('only accepts the explicit send chord', () => {
    expect(sendShortcut({ ...enter, ctrlKey: false })).toBe(false);
    expect(sendShortcut({ ...enter, shiftKey: true })).toBe(false);
    expect(sendShortcut({ ...enter, altKey: true })).toBe(false);
    expect(sendShortcut({ ...enter, key: 'Process' })).toBe(false);
    expect(sendShortcut({ ...enter, ctrlKey: false, metaKey: true })).toBe(true);
  });
  it('keeps the conversation readable when reopening oversized saved panels in a smaller window', () => {
    const widths = panelWidths(1100, 360, 560, true, true, false);
    expect(1100 - widths.navigationWidth - widths.inspectorWidth).toBeGreaterThanOrEqual(440);
    expect(panelWidths(1600, 256, 344, true, true, false)).toEqual({ navigationWidth: 256, inspectorWidth: 344 });
    expect(panelWidths(900, 360, 560, true, true, true).navigationWidth).toBe(360);
    expect(panelWidths(1600, Number.NaN, Number.POSITIVE_INFINITY, true, true, false)).toEqual({ navigationWidth: 256, inspectorWidth: 344 });
  });
});
