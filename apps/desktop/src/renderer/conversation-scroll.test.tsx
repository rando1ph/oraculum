import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkspaceState } from '../contracts/workspace';
import { anchorScrollTop, displayItemKey, indexAt, MAX_MOUNTED_MESSAGES, messageLayout, visibleMessageRange } from './conversation-scroll';
import { conversationItems, ExpandableText, NativeMessage, TEXT_SEGMENT_LENGTH } from './Native';
import { Conversation } from './Conversation';

const sample = (turnId: string, id: string) => ({ turnId, turnStatus: 'completed', item: { id, type: 'agentMessage', text: id } });
const state = { connection: { status: 'offline', endpoint: '', secureStorage: false }, projects: [], roots: [], streamItems: [], interactions: [], synchronization: 'stale', attachments: [], draftId: 'fixture', operations: [], busy: false } as WorkspaceState;

describe('bounded native conversation layout', () => {
  it('uses both native identities without delimiter collisions', () => {
    expect(displayItemKey(sample('a:b', 'c'))).not.toBe(displayItemKey(sample('a', 'b:c')));
    expect(displayItemKey(sample('first', 'same'))).not.toBe(displayItemKey(sample('second', 'same')));
  });
  it('renders small conversations completely and clamps an empty viewport', () => {
    const empty = messageLayout([], new Map());
    expect(indexAt(empty, 0)).toBe(-1);
    expect(visibleMessageRange(empty, 0, 800)).toEqual({ start: 0, end: 0 });
    const small = messageLayout(['a', 'b'], new Map([['a', 100], ['b', 300]]));
    expect(visibleMessageRange(small, 99999, 800)).toEqual({ start: 0, end: 2 });
    expect(indexAt(small, -100)).toBe(0);
    expect(indexAt(small, 100)).toBe(1);
    expect(indexAt(small, 1e9)).toBe(1);
  });
  it('keeps the first visible message mounted at top, middle and tail with a hard DOM bound', () => {
    const keys = Array.from({ length: 1000 }, (_, index) => String(index));
    const layout = messageLayout(keys, new Map(keys.map(key => [key, 1])));
    for (const top of [0, 1, 99, 500, 990, 100_000]) {
      const range = visibleMessageRange(layout, top, 800), current = indexAt(layout, top);
      expect(range.end - range.start).toBeLessThanOrEqual(MAX_MOUNTED_MESSAGES);
      expect(range.start).toBeLessThanOrEqual(current);
      expect(range.end).toBeGreaterThan(current);
      expect(range.end).toBeLessThanOrEqual(keys.length);
    }
  });
  it('restores the same message offset through prepend plus independent tail growth', () => {
    const measurements = new Map([['one', 100], ['two', 200], ['three', 400], ['older', 600], ['newest', 900]]);
    const before = messageLayout(['one', 'two', 'three'], measurements);
    expect(anchorScrollTop(before, 'two', -30, 40)).toBe(170);
    const after = messageLayout(['older', 'one', 'two', 'three', 'newest'], measurements);
    // Only the prepended row contributes: unrelated bottom growth cannot pull old reading downward.
    expect(anchorScrollTop(after, 'two', -30, 40)).toBe(770);
  });
  it('replaces stale pixel heights on resize without losing the native item anchor', () => {
    const before = messageLayout(['one', 'two'], new Map([['one', 100], ['two', 300]]));
    const after = messageLayout(['one', 'two'], new Map([['one', 240], ['two', 700]]));
    expect(anchorScrollTop(after, 'two', -10, 20)! - anchorScrollTop(before, 'two', -10, 20)!).toBe(140);
    expect(anchorScrollTop(after, 'removed', -10, 20)).toBeUndefined();
  });
  it('rejects invalid measurements rather than corrupting scrollbar geometry', () => {
    const layout = messageLayout(['a', 'b', 'c', 'd'], new Map([['a', NaN], ['b', -10], ['c', Infinity], ['d', 20]]));
    expect(layout.total).toBe(500);
    expect(layout.tops).toEqual([0, 160, 320, 480]);
  });
  it('keeps a shortened anchor visible after terminal replacement or collapsing output', () => {
    const before = messageLayout(['earlier', 'anchor', 'later'], new Map([['earlier', 100], ['anchor', 1500], ['later', 400]]));
    const after = messageLayout(['earlier', 'anchor', 'later'], new Map([['earlier', 100], ['anchor', 200], ['later', 400]]));
    expect(anchorScrollTop(before, 'anchor', -900, 0)).toBe(1000);
    expect(anchorScrollTop(after, 'anchor', -900, 0)).toBe(299);
    expect(indexAt(after, anchorScrollTop(after, 'anchor', -900, 0)!)).toBe(1);
  });
});

describe('long native content render boundaries', () => {
  it('bounds actual message DOM for a thousand-item history without omitting the native tail', () => {
    const long = { ...state, threadId: 'thread', history: { epoch: 'epoch', historyRevision: 'revision', source: 'native-pagination' as const, complete: true, truncated: false, nextCursor: null,
      items: Array.from({ length: 500 }, (_, index) => ({ id: `turn-${index}`, status: 'completed', items: [
        { id: 'user', type: 'userMessage', text: `Question ${index}` }, { id: 'answer', type: 'agentMessage', text: `Answer ${index}` },
      ] })) } };
    const html = renderToStaticMarkup(<Conversation state={long} act={async () => undefined} disabled scrollRef={{ current: null }} scopeKey="fixture-scope" />);
    expect((html.match(/data-conversation-key=/g) ?? []).length).toBeLessThanOrEqual(MAX_MOUNTED_MESSAGES);
    expect(html).toContain('Answer 499');
    expect(html).toContain('data-message-count="1000"');
    expect(html).not.toContain('Question 0');
  });
  it('does not parse or mount a closed tool output and restores explicitly opened tools', () => {
    const value = { turnId: 'turn', turnStatus: 'completed', item: { id: 'tool', type: 'commandExecution', command: 'fixture', aggregatedOutput: 'never-mount-closed'.repeat(10_000) } };
    const closed = renderToStaticMarkup(<NativeMessage value={value} state={state} disabled act={async () => undefined} />);
    expect(closed).toContain('fixture');
    expect(closed).not.toContain('never-mount-closed');
    expect(closed).not.toContain('native-output');
    const opened = renderToStaticMarkup(<NativeMessage value={value} state={state} disabled act={async () => undefined} presentation={{ expanded: true }} />);
    expect(opened).toContain('never-mount-closed');
    expect(opened).toContain('继续显示内容');
    expect(opened.length).toBeLessThan(TEXT_SEGMENT_LENGTH + 2500);
  });
  it('limits large message parse input without claiming the native item was truncated', () => {
    const text = 'x'.repeat(TEXT_SEGMENT_LENGTH) + 'END_MARKER';
    const html = renderToStaticMarkup(<ExpandableText text={text} markdown />);
    expect(html).not.toContain('END_MARKER');
    expect(html).toContain('继续显示内容（还有 10 字符）');
    expect(html).not.toContain('载入原生详情');
  });
  it('does not split a UTF-16 pair at a local display segment boundary', () => {
    const text = 'x'.repeat(TEXT_SEGMENT_LENGTH - 1) + '😀end';
    const html = renderToStaticMarkup(<ExpandableText text={text} />);
    expect(html).not.toContain('\uD83D');
    expect(html).toContain('还有 5 字符');
  });
  it('retains repeated item IDs across turns but deduplicates the same native identity', () => {
    const history: WorkspaceState['history'] = { epoch: 'epoch', historyRevision: 'revision', complete: true, truncated: false, source: 'native-pagination', nextCursor: null,
      items: [{ id: 'first', status: 'completed', items: [{ id: 'same', type: 'agentMessage', text: 'old' }, { id: 'same', type: 'agentMessage', text: 'new' }] }, { id: 'second', status: 'completed', items: [{ id: 'same', type: 'agentMessage', text: 'other-turn' }] }] };
    const items = conversationItems({ history, streamItems: [{ turnId: 'first', item: { id: 'same', type: 'agentMessage', text: 'terminal' } }] });
    expect(items).toHaveLength(2);
    expect(items[0].item.text).toBe('terminal');
    expect(items[1].item.text).toBe('other-turn');
  });
  it('keeps native details actions disabled while offline and exposes full turn identity', () => {
    const value = { ...sample('turn', 'item'), item: { ...sample('turn', 'item').item, truncated: true, detailsAvailable: true } };
    const html = renderToStaticMarkup(<NativeMessage value={value} state={state} disabled act={async () => undefined} />);
    expect(html).toContain('data-turn-id="turn"');
    expect(html.match(/<button[^>]*disabled=""[^>]*>载入详情/)).not.toBeNull();
  });
});
