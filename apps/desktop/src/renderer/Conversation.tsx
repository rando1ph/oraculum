import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { WorkspaceAction, WorkspaceState } from '../contracts/workspace';
import type { ReadingPosition } from './persistence/types';
import { BrandIcon } from './Icon';
import { InteractionCard } from './Interactions';
import { conversationItems, NativeMessage, type MessagePresentation } from './Native';
import { anchorScrollTop, displayItemKey, indexAt, messageLayout, visibleMessageRange } from './conversation-scroll';
import './styles/conversation.css';

export type { ReadingPosition } from './persistence/types';
export interface ConversationProps {
  state: WorkspaceState;
  act: (action: WorkspaceAction) => Promise<WorkspaceState | undefined>;
  disabled: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Includes endpoint/base path, installation, device, project and thread. */
  scopeKey: string;
  readingReady?: boolean;
  readingPosition?: ReadingPosition;
  onReadingPositionChange?: (position: ReadingPosition, scopeKey: string) => void;
}

/** A scope change unmounts all local viewport measurements and pending callbacks. */
export function Conversation(props: ConversationProps) { return <ConversationViewport key={props.scopeKey} {...props} />; }

function MeasuredMessage({ itemKey, onMeasure, children }: { itemKey: string; onMeasure: (key: string, height: number) => void; children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const measure = () => onMeasure(itemKey, node.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [itemKey, onMeasure]);
  return <div className="conversation-row" ref={element} data-conversation-key={itemKey}>{children}</div>;
}

function ConversationViewport({ state, act, disabled, scrollRef, scopeKey, readingReady = true, readingPosition, onReadingPositionChange }: ConversationProps) {
  const items = useMemo(() => conversationItems(state), [state.history, state.streamItems]);
  const keys = useMemo(() => items.map(displayItemKey), [items]);
  const measured = useRef(new Map<string, number>());
  const presentation = useRef(new Map<string, MessagePresentation>());
  const [measurement, setMeasurement] = useState(0);
  const [viewport, setViewport] = useState({ top: Number.MAX_SAFE_INTEGER, height: 800 });
  const [atBottom, setAtBottom] = useState(readingPosition?.atBottom ?? true);
  const [missingAnchor, setMissingAnchor] = useState(false);
  const [focusedKey, setFocusedKey] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const anchor = useRef<ReadingPosition | undefined>(readingPosition);
  const following = useRef(readingPosition?.atBottom ?? true);
  const programmedTop = useRef<number | undefined>(undefined);
  const latest = useRef({ state, onReadingPositionChange, readingReady });
  latest.current = { state, onReadingPositionChange, readingReady };
  const layout = useMemo(() => messageLayout(keys, measured.current), [keys, measurement]);
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const onMeasure = useCallback((key: string, height: number) => {
    if (height > 0 && Math.abs((measured.current.get(key) ?? -1) - height) > .5) {
      measured.current.set(key, height); setMeasurement(value => value + 1);
    }
  }, []);
  function listTop(element: HTMLDivElement) { return (list.current?.getBoundingClientRect().top ?? element.getBoundingClientRect().top) - element.getBoundingClientRect().top + element.scrollTop; }
  const updateViewport = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const top = element.scrollTop - listTop(element), height = element.clientHeight;
    setViewport(previous => Math.abs(previous.top - top) < .5 && previous.height === height ? previous : { top, height });
  }, [scrollRef]);
  function savePosition() {
    const element = scrollRef.current, current = latest.current;
    if (!element || !restored.current || !current.readingReady || !layoutRef.current.keys.length) return;
    const activeLayout = layoutRef.current;
    const top = element.scrollTop - listTop(element), index = indexAt(activeLayout, top);
    const value: ReadingPosition = { itemKey: activeLayout.keys[index], offset: activeLayout.tops[index] - top,
      atBottom: following.current, historyRevision: current.state.history?.historyRevision, updatedAt: Date.now() };
    anchor.current = value;
    current.onReadingPositionChange?.(value, scopeKey);
  }

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !readingReady || !items.length) return;
    if (!restored.current) {
      anchor.current = readingPosition;
      following.current = readingPosition?.atBottom ?? true;
      restored.current = true;
    }
    const anchorHeight = anchor.current?.itemKey ? measured.current.get(anchor.current.itemKey) : undefined;
    if (anchor.current && anchorHeight !== undefined && anchor.current.offset < 1 - anchorHeight) anchor.current = { ...anchor.current, offset: 1 - anchorHeight };
    let target = following.current ? element.scrollHeight : anchorScrollTop(layout, anchor.current?.itemKey, anchor.current?.offset ?? 0, listTop(element));
    if (target === undefined) {
      // The original native item was removed or lies outside the loaded cache.
      // Do not fetch old revisions or keep reapplying an obsolete absolute position.
      setMissingAnchor(!!anchor.current?.itemKey);
      following.current = true; target = element.scrollHeight;
      anchor.current = { itemKey: layout.keys.at(-1), offset: 0, atBottom: true, historyRevision: state.history?.historyRevision, updatedAt: Date.now() };
    }
    if (Math.abs(element.scrollTop - target) > .5) { element.scrollTop = target; programmedTop.current = element.scrollTop; }
    setAtBottom(following.current);
    updateViewport();
  }, [layout, readingReady, readingPosition, items.length, missingAnchor, scrollRef, updateViewport]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let frame = 0;
    const onScroll = () => {
      if (!latest.current.readingReady) return;
      if (programmedTop.current !== undefined && Math.abs(element.scrollTop - programmedTop.current) < 1) {
        programmedTop.current = undefined; updateViewport(); return;
      }
      programmedTop.current = undefined;
      following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 64;
      setAtBottom(following.current);
      // Capture before the virtual range changes, then save at most once per frame.
      const activeLayout = layoutRef.current, top = element.scrollTop - listTop(element), index = indexAt(activeLayout, top);
      if (index >= 0) anchor.current = { itemKey: activeLayout.keys[index], offset: activeLayout.tops[index] - top, atBottom: following.current, updatedAt: Date.now() };
      updateViewport();
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; savePosition(); });
    };
    const onFocus = (event: FocusEvent) => setFocusedKey(event.target instanceof Element && element.contains(event.target) ? event.target.closest<HTMLElement>('[data-conversation-key]')?.dataset.conversationKey : undefined);
    const onResize = () => { updateViewport(); setMeasurement(value => value + 1); };
    const observer = new ResizeObserver(onResize); observer.observe(element);
    element.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('focusin', onFocus);
    return () => {
      observer.disconnect(); element.removeEventListener('scroll', onScroll); document.removeEventListener('focusin', onFocus);
      if (frame) cancelAnimationFrame(frame);
      // The last observed bookmark belongs to this component's scope. Do not
      // inspect a shared scroll element after another conversation has mounted.
      if (restored.current && latest.current.readingReady && anchor.current) latest.current.onReadingPositionChange?.({ ...anchor.current, historyRevision: latest.current.state.history?.historyRevision, updatedAt: Date.now() }, scopeKey);
    };
  }, [scrollRef, updateViewport]);

  useEffect(() => {
    const current = new Set(keys);
    for (const key of measured.current.keys()) if (!current.has(key)) measured.current.delete(key);
    for (const key of presentation.current.keys()) if (!current.has(key)) presentation.current.delete(key);
  }, [keys]);

  let rangeTop = viewport.top;
  if (!restored.current && readingPosition && !readingPosition.atBottom) rangeTop = anchorScrollTop(layout, readingPosition.itemKey, readingPosition.offset, 0) ?? layout.total;
  const range = visibleMessageRange(layout, rangeTop, viewport.height);
  const indices = new Set(Array.from({ length: range.end - range.start }, (_, index) => range.start + index));
  const focusedIndex = focusedKey ? layout.indices.get(focusedKey) : undefined;
  if (focusedIndex !== undefined) indices.add(focusedIndex); // Preserve focused controls until focus leaves them.
  const mounted = [...indices].sort((left, right) => left - right);
  let previousEnd = 0;
  function jumpToLatest() {
    const element = scrollRef.current;
    if (!element) return;
    following.current = true; setAtBottom(true); setMissingAnchor(false);
    element.scrollTop = element.scrollHeight; programmedTop.current = element.scrollTop;
    updateViewport(); savePosition();
  }
  function loadEarlier() {
    // Position restoration is driven by native item identity, not a late
    // asynchronous scrollHeight delta that could affect a different scope.
    following.current = false; setAtBottom(false); savePosition();
    if (anchor.current) anchor.current = { ...anchor.current, atBottom: false };
    void act({ type: 'historyMore', cursor: state.history?.nextCursor ?? undefined, historyRevision: state.history?.historyRevision });
  }
  return <div className="conversation-inner" data-conversation-scope={scopeKey}>
    {state.history?.nextCursor && <button className="quiet-button history-more" disabled={disabled || !readingReady} onClick={loadEarlier}>加载更早历史</button>}
    {(state.history?.truncated || state.history?.complete === false) && <p className="history-note">历史内容尚未完整载入。</p>}
    {missingAnchor && <p className="history-note" role="status">上次阅读的消息不在已加载历史中，已回到最新位置。</p>}
    {!items.length && <div className="conversation-welcome"><BrandIcon size="hero" /><h1>{state.thread?.title || '新的开始'}</h1><p>{disabled ? '已加载的内容会保留在本机，连接后可继续读取原生历史。' : '写下你的想法，让工作从这里展开。'}</p></div>}
    <div ref={list} className="conversation-window" data-message-count={items.length} data-mounted-count={mounted.length}>
      {mounted.map(index => {
        const top = layout.tops[index], gap = Math.max(0, top - previousEnd), key = keys[index]; previousEnd = top + layout.heights[index];
        return <Fragment key={key}>{gap > 0 && <div className="conversation-window-spacer" aria-hidden="true" style={{ height: gap }} />}
          <MeasuredMessage itemKey={key} onMeasure={onMeasure}><NativeMessage value={items[index]} state={state} act={act} disabled={disabled}
            presentation={presentation.current.get(key)} onPresentationChange={patch => presentation.current.set(key, { ...presentation.current.get(key), ...patch })} /></MeasuredMessage>
        </Fragment>;
      })}
      {layout.total > previousEnd && <div className="conversation-window-spacer" aria-hidden="true" style={{ height: layout.total - previousEnd }} />}
    </div>
    {state.interactions.map(interaction => <InteractionCard key={`${interaction.interactionId}:${interaction.generation}`} interaction={interaction} state={state} act={act} disabled={disabled} />)}
    {state.activeTurnId && <div className="stream-status" role="status"><span className="status-dot" />Codex 正在执行 · 以原生完成状态为准</div>}
    {!atBottom && <div className="conversation-latest"><button className="quiet-button" aria-label="回到最新消息" onClick={jumpToLatest}>↓ 回到最新消息</button></div>}
  </div>;
}
