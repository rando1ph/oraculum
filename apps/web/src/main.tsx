import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { BridgeClient, BridgeRpcError } from '../../../packages/shared/client';
import { attachmentAccept } from '../../../packages/shared/attachments';
import { AttachmentTray, useAttachments } from './attachments';
import type { BridgeEvent, LocalConfig, Model, NativeOperation, NativeOperationMethod, ProjectList, Snapshot, Thread, ThreadItem } from '../../../packages/shared/protocol';
import type { ThreadStartResponse } from '../../../.local/codex-protocol/v2/ThreadStartResponse';
import type { ThreadListResponse } from '../../../.local/codex-protocol/v2/ThreadListResponse';
import { itemKey, useSession } from './store';
import { captureReading, parseReading, placeReading, readingDeadline, type ReadingPosition } from './reading';
import { groupTurns, hasTurnApproval, TurnProcess } from './process';
import { ItemDetail } from './content';
import { IdentityProvider, IdentitySettings } from './identity-ui';
import { androidShell, useMobile } from './mobile';
import { OracleEye, OracleLogo } from './brand';
import { brandCopy, emptyBrandState } from './brand-copy';
import { Icon } from './icons';
import { ProjectBrowser } from './project-browser';
import { displayPath } from './paths';
import { ResizeHandle, useLayout } from './layout';
import { SessionGate, checkSession } from './auth';
import { ThemeSettings, useTheme } from './themes';
import { NativeRequest } from './native-request';
import { PermissionDetails, permissionModes } from './permissions';
import { acknowledgedComposerDraft, actualComposerValues, composerOverrides, confirmedComposerDraft, parseComposerDraft, reconcileComposerDraft, type ComposerDraft } from './composer-settings';
import { SessionActions, sessionActionBlock, sessionLabel, type SessionAction, type SessionNativeAction, type SessionTarget } from './session-actions';
import { steerDeliveryBlocked, steerOperationBlocked } from './native-controls';
import { SessionUsage, WeeklyQuota } from './usage';
import { usageKey, useUsage } from './usage-store';
import type { UsageSnapshot } from '../../../packages/shared/usage';
import './style.css';
import './mobile.css';
import './native-controls.css';

const Artifacts = lazy(() => import('./artifacts').then(module => ({ default: module.Artifacts })));
const Diff = lazy(() => import('./diff').then(module => ({ default: module.Diff })));
type Inspected = { kind: 'diff'; path: string; diff: string } | { kind: 'item'; id: string; turnId: string } | { kind: 'usage' | 'emptyDiff' | 'artifacts' };
const readSaved = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const save = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Storage is optional. */ } };
// Android server profiles survive WebView recreation; tab-scoped desktop drafts stay unchanged.
const readingStorage = () => androidShell ? localStorage : sessionStorage;
function App() {
  const theme = useTheme();
  const session = useSession();
  const usage = useUsage();
  const [usageRefreshing, setUsageRefreshing] = useState(false);
  const usageRequest = useRef(0);
  const mobile = useMobile();
  const [menu, setMenu] = useState(false);
  const [readingSize, setReadingSize] = useState(() => Math.min(150, Math.max(100, Number(readSaved('oraculum.reading-size')) || 100)));
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [synced, setSynced] = useState(false);
  const [config, setConfig] = useState<LocalConfig>();
  const [projects, setProjects] = useState<ProjectList>({ root: '', projects: [] });
  const [models, setModels] = useState<Model[]>([]);
  const [composerDraft, setComposerDraft] = useState<{ key: string; draft: ComposerDraft }>({ key: '', draft: {} });
  const [composerMenu, setComposerMenu] = useState<'project' | 'model' | 'permission' | 'more' | null>(null);
  const [modelMenuLevel, setModelMenuLevel] = useState<'summary' | 'model' | 'effort'>('summary');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [archived, setArchived] = useState(false);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState('');
  const [actionTarget, setActionTarget] = useState<SessionTarget>();
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecycleNotice, setLifecycleNotice] = useState('');
  const [unknownThreads, setUnknownThreads] = useState(new Set<string>());
  const [backgroundNative, setBackgroundNative] = useState<NativeOperation[]>([]);
  // A brand presentation cue, never persisted or sent to the native Harness.
  const [createdThreadId, setCreatedThreadId] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [steerDraft, setSteerDraft] = useState<{ threadId: string; turnId: string }>();
  const steerBinding = useRef<typeof steerDraft>(undefined);
  const nativeSubmitting = useRef(false);
  const [switching, setSwitching] = useState(false);
  const [approving, setApproving] = useState(false);
  const [inspected, setInspected] = useState<Inspected>();
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [layout, setLayout] = useLayout();
  const [drawer, setDrawer] = useState(false);
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const [settings, setSettings] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const attachmentPicker = useRef<HTMLInputElement>(null);
  const pickerScope = useRef('');
  const { queues: attachmentQueues, queue: attachmentQueue } = useAttachments(config?.cwd ?? '', session.thread?.id ?? '');
  const [atBottom, setAtBottom] = useState(true);
  const client = useRef<BridgeClient>(null);
  const selected = useRef('');
  const workspace = useRef('');
  const epoch = useRef(0);
  const connectionEpoch = useRef(0);
  const connectingNow = useRef(false);
  const projectEpoch = useRef(0);
  const listEpoch = useRef(0);
  const archivedView = useRef(false);
  const actionReturnFocus = useRef<HTMLButtonElement | null>(null);
  const actionTargetId = useRef('');
  const sessionTabs = useRef<HTMLDivElement>(null);
  const registryEpoch = useRef(0);
  const draftRevision = useRef(0);
  const buffer = useRef<BridgeEvent[] | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const scrollContent = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const composerForm = useRef<HTMLFormElement>(null);
  const composerPanel = useRef<HTMLDivElement>(null);
  const composerTrigger = useRef<HTMLButtonElement>(null);
  const modelMenuReturn = useRef<'model' | 'effort'>('model');
  const follow = useRef(true);
  const scrollPositions = useRef(new Map<string, ReadingPosition>());
  const readingRestore = useRef<number | null>(null);
  const overlayPosition = useRef<{ id: string; top: number } | null>(null);
  const composing = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const report = (value: unknown) => setError(value instanceof Error ? value.message : String(value));
  const storageKey = () => `oraculum.thread:${workspace.current}`;
  const draftKey = (id = selected.current) => `oraculum.draft:${workspace.current}:${id}`;
  const settingsDraftKey = (cwd = config?.cwd ?? '', id = session.thread?.id ?? '') => `oraculum.composer:${new URL('.', location.href).pathname}:${cwd}:${id}`;
  const settingsKey = settingsDraftKey();
  const actualSettings = actualComposerValues(models, config, session.settings, !!session.thread);
  const storedChoices = composerDraft.key === settingsKey ? composerDraft.draft : parseComposerDraft(readSaved(settingsKey));
  const choices = synced ? reconcileComposerDraft(storedChoices, actualSettings) : storedChoices;
  const model = choices.model?.value ?? actualSettings.model;
  const selectedModel = models.find(entry => entry.model === model);
  const effort = choices.effort?.value ?? (choices.model && (session.thread ? session.settings?.effort : config?.effort) === null
    ? selectedModel?.defaultReasoningEffort ?? '' : actualSettings.effort);
  const permissionMode = choices.permissionMode?.value ?? actualSettings.permissionMode;
  const modelLabel = selectedModel?.displayName || model || '未读取';
  const permissionLabel = permissionModes.find(entry => entry.value === permissionMode)?.label ?? (permissionMode === 'custom'
    ? !session.thread && config?.sandbox ? { 'workspace-write': 'Workspace Write', 'read-only': 'Read Only', 'danger-full-access': 'Full Access' }[config.sandbox] : '自定义'
    : '未读取');
  const projectLabel = projects.projects.find(project => project.cwd === config?.cwd)?.name ?? '选择项目';
  function saveChoices(draft: ComposerDraft, key = settingsKey) {
    save(key, JSON.stringify(draft));
    setComposerDraft({ key, draft });
  }
  function chooseSetting(key: keyof ComposerDraft, value: string) {
    const draft = { ...choices };
    if (value === actualSettings[key]) delete draft[key];
    else draft[key] = { value, base: key === 'permissionMode' ? actualSettings.permissionKey : actualSettings[key] };
    if (key === 'model') {
      const nextModel = models.find(entry => entry.model === value);
      if (nextModel && !nextModel.supportedReasoningEfforts.some(option => option.reasoningEffort === effort)) {
        draft.effort = { value: nextModel.defaultReasoningEffort, base: actualSettings.effort };
      }
    }
    saveChoices(draft);
  }
  function closeComposerMenu(restoreFocus = false) {
    setComposerMenu(null);
    setModelMenuLevel('summary');
    if (restoreFocus) requestAnimationFrame(() => composerTrigger.current?.focus());
  }
  function toggleComposerMenu(value: NonNullable<typeof composerMenu>, trigger: HTMLButtonElement) {
    composerTrigger.current = trigger;
    modelMenuReturn.current = 'model';
    setModelMenuLevel('summary');
    setComposerMenu(current => current === value ? null : value);
  }
  function openModelMenu(level: 'model' | 'effort') {
    modelMenuReturn.current = level;
    setModelMenuLevel(level);
  }
  function navigateModelMenu(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft' && modelMenuLevel !== 'summary') {
      event.preventDefault(); setModelMenuLevel('summary'); return;
    }
    const panel = event.currentTarget;
    const options = Array.from(panel.querySelectorAll<HTMLButtonElement>(modelMenuLevel === 'summary'
      ? '.composer-model-summary button:not(:disabled)' : '[role="radio"]:not(:disabled)'));
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowRight' && modelMenuLevel === 'summary' && current !== -1) {
      event.preventDefault(); options[current]!.click(); return;
    }
    if (!options.length || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : current === -1 ? 0 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    const option = options[index]!;
    option.focus({ preventScroll: true });
    const bounds = option.getBoundingClientRect();
    const panelBounds = panel.getBoundingClientRect();
    const visibleTop = panelBounds.top + (panel.querySelector('header')?.getBoundingClientRect().height ?? 0) + 7;
    if (bounds.top < visibleTop) panel.scrollTop -= visibleTop - bounds.top;
    else if (bounds.bottom > panelBounds.bottom - 7) panel.scrollTop += bounds.bottom - panelBounds.bottom + 7;
  }
  function readDraft() {
    try {
      const stored = readingStorage().getItem(draftKey());
      if (stored !== null) return stored;
      const previous = sessionStorage.getItem(draftKey()) ?? '';
      if (androidShell) localStorage.setItem(draftKey(), previous);
      return previous;
    } catch { return ''; }
  }
  function bindSteerDraft(value: typeof steerDraft) {
    steerBinding.current = value; setSteerDraft(value);
    try { if (value) readingStorage().setItem(`${draftKey()}:steer`, JSON.stringify(value)); else readingStorage().removeItem(`${draftKey()}:steer`); } catch { /* Draft remains available in memory. */ }
  }
  function restoreSteerDraft() {
    let value: typeof steerDraft;
    try {
      const stored: unknown = JSON.parse(readingStorage().getItem(`${draftKey()}:steer`) ?? 'null');
      if (stored && typeof stored === 'object' && 'threadId' in stored && stored.threadId === selected.current && 'turnId' in stored && typeof stored.turnId === 'string') value = { threadId: stored.threadId, turnId: stored.turnId };
    } catch { /* Invalid optional binding is discarded. */ }
    steerBinding.current = value; setSteerDraft(value);
  }
  function writeDraft(value: string) {
    ++draftRevision.current; setText(value);
    if (!value.trim()) bindSteerDraft(undefined);
    else {
      const state = useSession.getState();
      if (!steerBinding.current && state.thread?.id === selected.current && state.activeTurn) bindSteerDraft({ threadId: selected.current, turnId: state.activeTurn });
    }
    try { readingStorage().setItem(draftKey(), value); } catch { /* Keep current in-memory input. */ }
  }
  const readingKey = (id = selected.current) => `oraculum.reading:${workspace.current}:${id}`;
  function rememberScroll() {
    if (readingRestore.current !== null || !scroller.current || !selected.current || useSession.getState().thread?.id !== selected.current) return;
    // pagehide can precede the queued scroll event; persist the actual viewport,
    // not a follow flag that may still describe the previous position.
    const position = captureReading(scroller.current);
    scrollPositions.current.set(readingKey(), position);
    try { readingStorage().setItem(readingKey(), JSON.stringify(position)); } catch { /* Reading state is optional. */ }
  }
  function savedScroll(id: string) {
    const key = readingKey(id);
    if (scrollPositions.current.has(key)) return scrollPositions.current.get(key);
    try {
      const stored = readingStorage().getItem(key) ?? sessionStorage.getItem(key);
      if (androidShell && stored !== null) localStorage.setItem(key, stored);
      return parseReading(stored);
    } catch { return undefined; }
  }
  async function restoreEarlier(position: ReadingPosition | undefined, id: string, ticket: number) {
    if (!position?.itemId || !position.turnId || position.bottom) return;
    const key = itemKey(position.turnId, position.itemId);
    const current = () => ticket === epoch.current && selected.current === id;
    const cursors = new Set<string>();
    const deadline = performance.now() + 10_000;
    try {
      while (current() && !useSession.getState().items[key]) {
        const cursor = useSession.getState().history?.nextCursor;
        if (!cursor || cursors.has(cursor) || cursors.size >= 20 || performance.now() >= deadline) break;
        cursors.add(cursor); setLoadingHistory(true);
        const page = await readingDeadline(client.current!.request<Snapshot>('bridge/history', { threadId: id, cursor }), deadline - performance.now());
        if (!current()) return;
        useSession.getState().older(page);
      }
    } catch { /* The current snapshot remains usable if older history is unavailable. */ }
    finally { if (current()) setLoadingHistory(false); }
  }
  const openDiff = (path: string, diff: string) => { setInspected({ kind: 'diff', path, diff }); setLayout(l => ({ ...l, inspector: true })); };
  function openItem(item: ThreadItem, turnId: string) { setInspected({ kind: 'item', id: item.id, turnId }); setLayout(l => ({ ...l, inspector: true })); }
  function openUsage() { setInspected({ kind: 'usage' }); setLayout(l => ({ ...l, inspector: true })); setMenu(false); void refreshUsage(); }
  async function refreshProjects() {
    const ticket = ++registryEpoch.current;
    const directory = await client.current!.request<ProjectList>('bridge/projects', {});
    if (ticket === registryEpoch.current) setProjects(directory);
  }
  async function listThreads(cursor?: string) {
    const cwd = workspace.current;
    const archived = archivedView.current;
    const ticket = ++listEpoch.current;
    setListing(true); setListError('');
    try {
      const page = await client.current!.request<ThreadListResponse>('thread/list', { cursor, cwd, archived });
      if (cwd !== workspace.current || archived !== archivedView.current || ticket !== listEpoch.current) return null;
      setThreads(current => [...new Map([...(cursor ? current : []), ...page.data].map(t => [t.id, t])).values()]);
      setNextCursor(page.nextCursor);
      return page;
    } catch (value) {
      if (ticket === listEpoch.current) setListError(value instanceof Error ? value.message : String(value));
      throw value;
    } finally { if (ticket === listEpoch.current) setListing(false); }
  }
  function changeSessionView(value: boolean) {
    archivedView.current = value; setArchived(value); ++listEpoch.current;
    setThreads([]); setNextCursor(null); setQuery(''); actionTargetId.current = ''; setActionTarget(undefined);
    void listThreads().catch(() => {});
  }
  function closeSessionActions() {
    actionTargetId.current = ''; setActionTarget(undefined);
    requestAnimationFrame(() => {
      if (actionReturnFocus.current?.isConnected) actionReturnFocus.current.focus();
      else { const tab = sessionTabs.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]'); if (tab?.checkVisibility()) tab.focus(); else composer.current?.focus(); }
    });
  }
  function openSessionActions(thread: Thread, trigger: HTMLButtonElement, isArchived = archivedView.current) {
    actionReturnFocus.current = trigger.closest('.mobile-session-menu') ? document.querySelector<HTMLButtonElement>('.mobile-menu-toggle') : trigger.closest('.composer-popover') ? composerTrigger.current : trigger;
    actionTargetId.current = thread.id;
    setActionTarget({ thread, archived: isArchived });
  }
  function lifecycleChanged(message: Extract<BridgeEvent, { type: 'threadLifecycleChanged' }>) {
    // Handle before the subscribe buffer: an older snapshot must never revive
    // a thread removed by another device while that snapshot was in flight.
    if (message.state === 'unknown') setUnknownThreads(ids => new Set([...ids, message.threadId]));
    else setUnknownThreads(ids => { const next = new Set(ids); next.delete(message.threadId); return next; });
    if (selected.current === message.threadId) {
      ++epoch.current; readingRestore.current = null; buffer.current = null;
      selected.current = ''; save(storageKey(), '');
      useSession.getState().reset(); setText(''); steerBinding.current = undefined; setSteerDraft(undefined); ++draftRevision.current;
      setSynced(true); setLoadingHistory(false); setCreatedThreadId(''); setInspected(undefined);
      closeComposerMenu();
    }
    if (actionTargetId.current === message.threadId) closeSessionActions();
    if (message.cwd !== workspace.current) return;
    setLifecycleNotice(message.state === 'unknown' ? '会话操作结果尚未确认，请查询原生状态，勿重复操作。' : message.state === 'archived' ? '会话已归档，可从「已归档」恢复。' : message.state === 'active' ? '会话已恢复到会话列表。' : '会话已永久删除。');
    ++listEpoch.current;
    setThreads(current => current.filter(thread => thread.id !== message.threadId));
    void listThreads().catch(() => {});
  }
  async function changeSession(action: SessionAction) {
    if (!actionTarget || lifecycleBusy) return;
    const target = actionTarget;
    setLifecycleBusy(true); setError('');
    try {
      await client.current!.request(`thread/${action}`, { threadId: target.thread.id, cwd: target.thread.cwd, ...(action === 'delete' ? { confirm: true } : {}) });
      closeSessionActions();
      // The broadcast normally refreshes all devices; a query also reconciles
      // clients whose connection missed it. Never repeat the mutation itself.
      if (workspace.current === target.thread.cwd) await listThreads();
    } catch (value) { report(value); throw value; }
    finally { setLifecycleBusy(false); }
  }
  async function changeNativeSession(action: SessionNativeAction) {
    if (!actionTarget || lifecycleBusy || nativeSubmitting.current || methodBlock(action.method, actionTarget.thread.id) || (action.method === 'thread/name/set' ? renameBlocked : nativeActionBlocked || actionBlocked)) return;
    const target = actionTarget.thread;
    const operationId = crypto.randomUUID();
    nativeSubmitting.current = true; setLifecycleBusy(true); setError('');
    try {
      const result = await client.current!.request<{ thread?: Thread }>(action.method, { threadId: target.id, cwd: target.cwd,
        ...(action.method === 'thread/name/set' ? { name: action.name } : action.method === 'thread/revert' ? { beforeTurnId: action.beforeTurnId, confirm: true } : action.method === 'review/start' ? { target: { type: 'uncommittedChanges' } } : {}) }, operationId);
      closeSessionActions();
      if (workspace.current !== target.cwd) return;
      await listThreads();
      if (action.method === 'thread/fork' && result.thread) { await refresh(result.thread.id); composer.current?.focus(); }
      else if (selected.current === target.id) await refresh(target.id);
    } catch (value) { report(value); if (!['thread/name/set', 'thread/fork'].includes(action.method) && useSession.getState().nativeOperations.find(operation => operation.operationId === operationId)?.state !== 'rejected') setSynced(false); throw value; }
    finally { nativeSubmitting.current = false; setLifecycleBusy(false); }
  }
  function cacheNativeOperation(operation: NativeOperation) {
    setBackgroundNative(current => {
      const prior = current.find(value => value.operationId === operation.operationId);
      if (prior && ['completed', 'rejected'].includes(prior.state) && ['running', 'accepted', 'unknown'].includes(operation.state)) return current;
      return [...current.filter(value => value.operationId !== operation.operationId), operation].slice(-100);
    });
  }
  function apply(message: BridgeEvent, restoring = false) {
    const state = useSession.getState();
    if (message.type === 'attachmentsChanged' && message.cwd === state.thread?.cwd && message.threadId === state.thread.id) {
      useSession.setState({ attachments: [...state.attachments.filter(prior => !message.deliveries.some(value => value.operationId === prior.operationId)), ...message.deliveries] });
      return;
    }
    if (message.type === 'settingsChanged' && message.threadId === state.thread?.id) {
      useSession.setState({ settings: message.settings });
      const key = settingsDraftKey(workspace.current, message.threadId);
      saveChoices(confirmedComposerDraft(parseComposerDraft(readSaved(key)), message.settings), key);
    }
    if (message.type === 'nativeOperationChanged') state.nativeOperation(message.operation);
    if (message.type === 'nativeCapabilitiesChanged') useSession.setState({ nativeCapabilities: message.capabilities });
    if (message.type === 'approval') state.approval(message.request);
    if (message.type === 'requestAnswered') useSession.setState({ pending: state.pending.filter(request => request.id !== message.requestId || request.bridgeToken !== message.bridgeToken) });
    if (message.type === 'event') {
      state.event(message.event, restoring);
      if (message.event.method === 'thread/name/updated') {
        const { threadId, threadName } = message.event.params;
        setThreads(current => current.map(thread => thread.id === threadId ? { ...thread, name: threadName ?? null } : thread));
        ++listEpoch.current; void listThreads().catch(() => {});
      }
      if (message.event.method === 'thread/status/changed') {
        const { threadId, status } = message.event.params;
        setThreads(current => current.map(t => t.id === threadId ? { ...t, status } : t));
      }
    }
    if (message.type === 'notice' && (!message.threadId || message.threadId === selected.current || message.displayThreadIds?.includes(selected.current))) {
      useSession.setState({ notices: [...state.notices, message.message] });
    }
  }
  async function refreshUsage(id = selected.current) {
    const connection = useUsage.getState().connection;
    const ticket = ++usageRequest.current;
    setUsageRefreshing(true);
    // Optional read failures never affect connection, sends, model settings or recovery.
    try {
      const value = await client.current!.request<UsageSnapshot>('bridge/usage', { ...(id ? { threadId: id, cwd: workspace.current } : {}) });
      useUsage.getState().snapshot(value, connection);
    } catch { /* Keep the last verified values; connection changes invalidate the store. */ }
    finally { if (ticket === usageRequest.current) setUsageRefreshing(false); }
  }
  async function refresh(id = selected.current) {
    setCreatedThreadId('');
    const ticket = ++epoch.current;
    const changed = selected.current !== id;
    rememberScroll();
    let position = savedScroll(id);
    if (changed) { readingRestore.current = ticket; follow.current = false; }
    selected.current = id;
    void refreshUsage(id);
    setSynced(false); setLoadingHistory(false);
    if (changed) {
      useSession.getState().reset(); closeComposerMenu(); setError(''); setInspected(undefined);
      setText(readDraft()); restoreSteerDraft(); setDrawer(false); setMenu(false);
    }
    if (!id) { readingRestore.current = null; useSession.getState().reset(); setSynced(true); buffer.current = null; return; }
    buffer.current = [];
    let scheduled = false;
    try {
      const snapshot = await client.current!.request<Snapshot>('bridge/subscribe', { threadId: id });
      if (ticket !== epoch.current) return;
      // A same-thread query leaves the reader in control while the response is pending.
      // Capture at projection time, then suppress only DOM-induced scroll updates.
      if (!changed) { rememberScroll(); position = savedScroll(id); }
      readingRestore.current = ticket; follow.current = false;
      useSession.getState().snapshot(snapshot);
      for (const operation of snapshot.nativeOperations ?? []) cacheNativeOperation(operation);
      const key = settingsDraftKey(workspace.current, id);
      saveChoices(confirmedComposerDraft(parseComposerDraft(readSaved(key)), snapshot.settings, snapshot.receipts), key);
      const queued = buffer.current ?? [];
      buffer.current = null;
      for (const message of queued) apply(message, true);
      await restoreEarlier(position, id, ticket);
      if (ticket !== epoch.current) return;
      save(storageKey(), id);
      setSynced(!useSession.getState().historyReloading);
      scheduled = true;
      requestAnimationFrame(() => {
        if (ticket !== epoch.current || selected.current !== id || !scroller.current) return;
        placeReading(scroller.current, position);
        readingRestore.current = null;
        follow.current = !position || position.bottom || scroller.current.scrollHeight - scroller.current.scrollTop - scroller.current.clientHeight < 60;
        setAtBottom(follow.current); rememberScroll();
      });
    } finally {
      if (ticket === epoch.current) {
        buffer.current = null;
        if (!scheduled) readingRestore.current = null;
      }
    }
  }
  async function selectProject(cwd: string, restore = true) {
    setCreatedThreadId('');
    const ticket = ++projectEpoch.current;
    ++listEpoch.current;
    setSwitching(true); setError(''); setSynced(false);
    try {
      rememberScroll();
      const settings = await client.current!.request<LocalConfig>('bridge/config', { cwd });
      if (ticket !== projectEpoch.current) return;
      ++epoch.current; readingRestore.current = null; selected.current = ''; buffer.current = null;
      workspace.current = settings.cwd; save('oraculum.project', settings.cwd);
      archivedView.current = false; setArchived(false); actionTargetId.current = ''; setActionTarget(undefined); setLifecycleNotice('');
      setConfig(settings); setThreads([]); setNextCursor(null); setQuery(''); closeComposerMenu(); setInspected(undefined);
      useSession.getState().reset(); setText(readDraft()); restoreSteerDraft();
      const saved = restore ? readSaved(storageKey()) : null;
      let page = await listThreads();
      const fallback = restore ? page?.data[0]?.id ?? '' : '';
      const cursors = new Set<string>();
      // A remembered thread can live beyond the first native history page.
      while (saved && page && !page.data.some(t => t.id === saved) && page.nextCursor) {
        if (cursors.has(page.nextCursor)) throw new Error('会话分页游标重复');
        cursors.add(page.nextCursor);
        page = await listThreads(page.nextCursor);
        if (ticket !== projectEpoch.current) return;
      }
      if (ticket !== projectEpoch.current || !page) return;
      await refresh(page.data.some(t => t.id === saved) ? saved! : fallback);
    } finally { if (ticket === projectEpoch.current) setSwitching(false); }
  }
  async function connect() {
    if (connectingNow.current) return;
    connectingNow.current = true; setConnecting(true); setCreatedThreadId('');
    try {
    const ticket = ++connectionEpoch.current;
    ++epoch.current; setSynced(false); setError('');
    const authenticated = await checkSession();
    if (ticket !== connectionEpoch.current) return;
    if (!authenticated) { client.current!.close(); throw new Error('设备需要重新配对'); }
    await client.current!.connect();
    if (ticket !== connectionEpoch.current) return;
    void refreshUsage('');
    const settings = await client.current!.request<LocalConfig>('bridge/config', {});
    const directory = await client.current!.request<ProjectList>('bridge/projects', {});
    if (ticket !== connectionEpoch.current) return;
    setProjects(directory);
    const allModels: Model[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { data: Model[]; nextCursor: string | null } = await client.current!.request('model/list', { cursor });
      allModels.push(...page.data); cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('模型分页游标重复');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (ticket !== connectionEpoch.current) return;
    setModels(allModels);
    const saved = readSaved('oraculum.project');
    await selectProject(directory.projects.some(p => p.cwd === saved && p.available !== false) ? saved! : settings.cwd);
    } finally { connectingNow.current = false; setConnecting(false); }
  }
  useEffect(() => {
    client.current = new BridgeClient(message => {
      if (message.type === 'accountLimits') { useUsage.getState().limits(message.snapshot); return; }
      if (message.type === 'threadUsage') { useUsage.getState().thread(message.snapshot); return; }
      if (message.type === 'projectsChanged') { void refreshProjects().catch(report); void listThreads().catch(() => {}); return; }
      if (message.type === 'threadLifecycleChanged') { lifecycleChanged(message); return; }
      if (message.type === 'threadHistoryChanged') {
        if (message.threadId === selected.current) {
          ++epoch.current; buffer.current = null; readingRestore.current = null;
          useSession.getState().invalidateHistory(message.historyRevision);
          setSynced(false); setInspected(undefined); setLoadingHistory(false);
          void refresh().catch(report);
        }
        if (message.cwd === workspace.current) void listThreads().catch(() => {});
        return;
      }
      if (message.type === 'nativeOperationChanged') cacheNativeOperation(message.operation);
      if (message.type === 'nativeCapabilitiesChanged') { useSession.setState({ nativeCapabilities: message.capabilities }); return; }
      if (message.type === 'unavailable') { useUsage.getState().connect(false); ++epoch.current; readingRestore.current = null; buffer.current = null; useSession.setState({ pending: [] }); setError(message.message); setSynced(false); setLoadingHistory(false); return; }
      if (buffer.current) buffer.current.push(message);
      else {
        apply(message);
        if (message.type === 'event' && message.event.method === 'turn/completed' && message.event.params.threadId === selected.current) {
          void refresh().then(() => listThreads()).catch(report);
        }
      }
    }, value => {
      useUsage.getState().connect(value);
      setConnected(value);
      if (!value) { ++epoch.current; ++listEpoch.current; setListing(false); setSynced(false); void checkSession().catch(() => {}); }
    });
    void connect().catch(report);
    return () => { ++epoch.current; ++connectionEpoch.current; ++registryEpoch.current; client.current?.close(); };
  }, []);
  useEffect(() => {
    const observer = new ResizeObserver(() => { if (follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; });
    if (scrollContent.current) observer.observe(scrollContent.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!composer.current) return;
    composer.current.style.height = 'auto';
    composer.current.style.height = `${Math.min(expanded ? 360 : 180, Math.max(52, composer.current.scrollHeight))}px`;
  }, [text, expanded]);
  useLayoutEffect(() => {
    const form = composerForm.current;
    if (!form) return;
    const size = () => {
      const header = form.closest('.conversation')?.querySelector('.conversation-header');
      const available = form.getBoundingClientRect().top - (header?.getBoundingClientRect().bottom ?? 0) - 8;
      form.style.setProperty('--composer-popup-height', `${Math.max(44, available)}px`);
    };
    const observer = new ResizeObserver(size);
    observer.observe(form);
    visualViewport?.addEventListener('resize', size);
    window.addEventListener('resize', size);
    size();
    return () => { observer.disconnect(); visualViewport?.removeEventListener('resize', size); window.removeEventListener('resize', size); };
  }, []);
  useEffect(() => { if (settings) dialog.current?.showModal(); else dialog.current?.close(); }, [settings]);
  useEffect(() => { save('oraculum.reading-size', String(readingSize)); }, [readingSize]);
  const choicesJson = JSON.stringify(choices);
  useEffect(() => { saveChoices(choices); }, [settingsKey, choicesJson]);
  useEffect(() => {
    if (!composerMenu) return;
    const panel = composerPanel.current;
    const first = composerMenu === 'model' && modelMenuLevel === 'summary'
      ? panel?.querySelector<HTMLButtonElement>(`button[data-level="${modelMenuReturn.current}"]`)
      : panel?.querySelector<HTMLButtonElement>('button[aria-checked="true"]:not(:disabled)')
      ?? panel?.querySelector<HTMLButtonElement>('[role="radio"]:not(:disabled)')
      ?? panel?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    if (panel) panel.scrollTop = 0;
    (first ?? panel)?.focus({ preventScroll: true });
    if (first && panel && first.offsetTop + first.offsetHeight > panel.clientHeight) {
      panel.scrollTop = first.offsetTop + first.offsetHeight - panel.clientHeight;
    }
    const outside = (event: PointerEvent) => {
      if (!panel?.contains(event.target as Node) && !composerTrigger.current?.contains(event.target as Node)) closeComposerMenu();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [composerMenu, modelMenuLevel]);
  const overlay = mobile && (drawer || settings || browsing || menu || !!composerMenu || !!actionTarget || layout.inspector);
  useLayoutEffect(() => {
    if (overlay && !overlayPosition.current && scroller.current) {
      overlayPosition.current = { id: selected.current, top: scroller.current.scrollTop };
      follow.current = false;
    } else if (!overlay && overlayPosition.current) {
      const previous = overlayPosition.current;
      overlayPosition.current = null;
      if (previous.id === selected.current && scroller.current) {
        scroller.current.scrollTop = previous.top;
        follow.current = scroller.current.scrollHeight - scroller.current.scrollTop - scroller.current.clientHeight < 60;
        setAtBottom(follow.current);
      }
    }
  }, [overlay]);
  useEffect(() => {
    const persist = () => rememberScroll();
    document.addEventListener('visibilitychange', persist);
    window.addEventListener('pagehide', persist);
    return () => { document.removeEventListener('visibilitychange', persist); window.removeEventListener('pagehide', persist); };
  }, []);
  useEffect(() => {
    // Android invokes this single UI-only callback after the IME has handled Back.
    // It grants no native, filesystem, network or credential capability to JS.
    const back = () => {
      if (composerMenu) {
        if (composerMenu === 'model' && modelMenuLevel !== 'summary') setModelMenuLevel('summary');
        else closeComposerMenu(true);
        return true;
      }
      if (actionTarget) { if (!lifecycleBusy) closeSessionActions(); return true; }
      if (menu) { setMenu(false); return true; }
      if (browsing) { setBrowsing(false); return true; }
      if (settings) { setSettings(false); return true; }
      if (layout.inspector) { setLayout(l => ({ ...l, inspector: false })); return true; }
      if (drawer) { setDrawer(false); return true; }
      if (expanded) { setExpanded(false); return true; }
      return false;
    };
    window.oraculumAndroidBack = back;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && back()) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener('keydown', close);
    return () => { delete window.oraculumAndroidBack; window.removeEventListener('keydown', close); };
  }, [settings, browsing, menu, composerMenu, modelMenuLevel, drawer, expanded, layout.inspector, actionTarget, lifecycleBusy]);
  async function createThread() {
    setSending(true); setError('');
    try {
      // A new thread starts from project configuration, never another thread's draft.
      const initialChoices = session.thread ? {} : choices;
      const result = await client.current!.request<ThreadStartResponse>('thread/start', {
        model: initialChoices.model?.value, permissionMode: initialChoices.permissionMode?.value, cwd: workspace.current,
      });
      rememberScroll(); ++epoch.current; readingRestore.current = null; buffer.current = null; selected.current = result.thread.id;
      setInspected(undefined); setText(readDraft()); restoreSteerDraft(); setDrawer(false); follow.current = true;
      useSession.getState().reset(); useSession.getState().snapshot({ thread: result.thread, pending: [], nativeCapabilities: session.nativeCapabilities, settings: {
        approvalPolicy: result.approvalPolicy, sandbox: result.sandbox, approvalsReviewer: result.approvalsReviewer, model: result.model, effort: result.reasoningEffort,
      } });
      if (initialChoices.effort) saveChoices({ effort: { ...initialChoices.effort,
        base: actualComposerValues(models, config, { approvalPolicy: result.approvalPolicy, sandbox: result.sandbox, approvalsReviewer: result.approvalsReviewer, model: result.model, effort: result.reasoningEffort }, true).effort,
      } }, settingsDraftKey(workspace.current, result.thread.id));
      if (!session.thread) save(settingsKey, '{}');
      closeComposerMenu();
      setCreatedThreadId(result.thread.id);
      save(storageKey(), result.thread.id);
      if (archivedView.current) changeSessionView(false);
      else setThreads(ids => [result.thread, ...ids]);
      setSynced(true); composer.current?.focus();
    } catch (value) { report(value); } finally { setSending(false); }
  }
  const active = !!session.activeTurn || session.thread?.status.type === 'active';
  const projectAvailable = !!config && projects.projects.some(p => p.cwd === config.cwd && p.available !== false);
  const nativeRunning = session.nativeOperations.find(operation => operation.state === 'running');
  const nativePending = nativeRunning ?? session.nativeOperations.find(operation => ['accepted', 'unknown'].includes(operation.state) && ['review/start', 'thread/compact/start', 'thread/revert', 'turn/steer'].includes(operation.method));
  const methodBlock = (method: NativeOperationMethod, threadId = selected.current) => (threadId === session.thread?.id ? session.nativeOperations : backgroundNative).some(operation => operation.threadId === threadId && operation.method === method && ['running', 'accepted', 'unknown'].includes(operation.state)) ? '此操作尚未确认完成，请查询状态，勿重复操作。' : '';
  const canAttach = projectAvailable && connected && synced && !!session.thread && !active && !session.sendBlocked && !session.historyReloading && !nativePending && !steerDraft && !sending && !switching && !lifecycleBusy;
  const canSend = canAttach && attachmentQueues.ready(attachmentQueue) && (!!text.trim() || !!attachmentQueue.files.length);
  const attachmentScope = JSON.stringify([config?.cwd, session.thread?.id]);
  const canAttachNow = () => canAttach && !nativeSubmitting.current && selected.current === attachmentQueue.scope.threadId && workspace.current === attachmentQueue.scope.cwd;
  function addAttachments(files: File[]) { if (!canAttachNow()) { setError('请先选择可发送消息的会话，再添加附件。运行中的补充指令仅支持文字。'); return; } attachmentQueues.add(attachmentQueue, files); }
  function openAttachmentPicker() { if (!canAttachNow()) return; pickerScope.current = attachmentScope; attachmentPicker.current?.click(); }
  useEffect(() => { attachmentQueues.reconcile(attachmentQueue, session.receipts); }, [attachmentQueues, attachmentQueue, session.receipts]);
  useEffect(() => { setDraggingFiles(false); }, [attachmentScope]);
  useEffect(() => {
    const preventFileNavigation = (event: DragEvent) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); };
    window.addEventListener('dragover', preventFileNavigation); window.addEventListener('drop', preventFileNavigation);
    return () => { window.removeEventListener('dragover', preventFileNavigation); window.removeEventListener('drop', preventFileNavigation); };
  }, []);
  const canSteer = projectAvailable && connected && synced && !!session.activeTurn && !session.pending.length && !steerDeliveryBlocked(session.sendBlocked, session.receipts, session.activeTurn, session.nativeOperations.some(operation => operation.method === 'review/start' && operation.state === 'accepted' && operation.turnId === session.activeTurn)) && !session.historyReloading && !steerOperationBlocked(session.nativeOperations, session.activeTurn) && !sending && !switching && !lifecycleBusy && !!text.trim()
    && !attachmentQueue.files.length && !session.nativeCapabilities?.unsupportedMethods.includes('turn/steer') && (!steerDraft || steerDraft.threadId === session.thread?.id && steerDraft.turnId === session.activeTurn);
  async function steer() {
    if (!canSteer || composing.current || nativeSubmitting.current) return;
    const observedThread = session.thread!.id;
    const observedTurn = steerBinding.current?.turnId ?? session.activeTurn!;
    const current = useSession.getState();
    if (selected.current !== observedThread || current.thread?.id !== observedThread || current.activeTurn !== observedTurn) { setError('原运行已结束或切换，补充指令未发送。'); return; }
    nativeSubmitting.current = true; setSending(true); setError('');
    bindSteerDraft({ threadId: observedThread, turnId: observedTurn });
    const submittedRevision = draftRevision.current;
    const operationId = crypto.randomUUID();
    try {
      await client.current!.request('turn/steer', { threadId: observedThread, cwd: workspace.current, expectedTurnId: observedTurn, text }, operationId);
      if (selected.current === observedThread && draftRevision.current === submittedRevision) writeDraft('');
    } catch (value) { report(value); if (useSession.getState().nativeOperations.find(operation => operation.operationId === operationId)?.state !== 'rejected') setSynced(false); }
    finally { nativeSubmitting.current = false; setSending(false); }
  }
  function submitComposer() { if (useSession.getState().activeTurn || steerBinding.current) void steer(); else void send(); }
  async function send() {
    if (!canSend || composing.current || nativeSubmitting.current || steerBinding.current || useSession.getState().activeTurn) return;
    nativeSubmitting.current = true; setSending(true); setError(''); follow.current = true;
    const submittedRevision = draftRevision.current;
    const submittedSettings = useSession.getState().settings;
    const submittedKey = settingsKey;
    const submittedThread = selected.current;
    const operationId = crypto.randomUUID();
    const submittedChoices: ComposerDraft = {};
    for (const key of ['model', 'effort', 'permissionMode'] as const) {
      if (choices[key]) submittedChoices[key] = { ...choices[key], acknowledged: false, operationId };
    }
    saveChoices(submittedChoices, submittedKey);
    try {
      const attachments = attachmentQueues.begin(attachmentQueue, operationId);
      await client.current!.request('turn/start', { threadId: submittedThread, text, ...composerOverrides(submittedChoices), ...attachments }, operationId);
      attachmentQueues.settled(attachmentQueue, operationId, 'accepted');
      const acknowledged = acknowledgedComposerDraft(parseComposerDraft(readSaved(submittedKey)), operationId);
      const current = useSession.getState();
      const readback = current.thread?.id === submittedThread ? current.settings : undefined;
      saveChoices(readback !== submittedSettings ? confirmedComposerDraft(acknowledged, readback) : acknowledged, submittedKey);
      if (draftRevision.current === submittedRevision && selected.current === submittedThread) writeDraft('');
    } catch (value) { attachmentQueues.settled(attachmentQueue, operationId, value instanceof BridgeRpcError ? value.sendStatus ?? 'unknown' : 'unknown'); report(value); setSynced(false); }
    finally { nativeSubmitting.current = false; setSending(false); }
  }
  async function older() {
    const id = selected.current;
    const ticket = epoch.current;
    const cursor = session.history!.nextCursor;
    setLoadingHistory(true); follow.current = false;
    try {
      const value = await client.current!.request<Snapshot>('bridge/history', { threadId: id, cursor, historyRevision: session.historyRevision });
      if (selected.current !== id || epoch.current !== ticket) return;
      const top = scroller.current?.scrollTop ?? 0;
      const height = scroller.current?.scrollHeight ?? 0;
      useSession.getState().older(value);
      requestAnimationFrame(() => { if (scroller.current && selected.current === id) scroller.current.scrollTop = top + scroller.current.scrollHeight - height; });
    } catch (value) { report(value); } finally { if (ticket === epoch.current) setLoadingHistory(false); }
  }
  const lastTurn = session.turns[session.lastTurnId ?? ''];
  const lastReceipt = session.receipts[0];
  const turnLabel = lastTurn?.status === 'completed' ? '已完成' : lastTurn?.status === 'failed' ? '执行失败' : lastTurn?.status === 'interrupted' ? '已停止' : '空闲';
  const items = Object.values(session.items);
  const emptyBrand = emptyBrandState({ projectAvailable, threadId: session.thread?.id, createdThreadId,
    hasActivity: items.length > 0 || Object.keys(session.turns).length > 0 || session.pending.length > 0 || active || session.sendBlocked });
  const files = items.flatMap(view => view.item.type === 'fileChange' ? view.item.changes : []);
  const tools = items.filter(view => ['commandExecution', 'mcpToolCall'].includes(view.item.type));
  const inspectedItem = inspected?.kind === 'item' ? items.find(view => view.item.id === inspected.id && view.turnId === inspected.turnId)?.item : undefined;
  const viewingUsage = !inspected || inspected.kind === 'usage';
  const viewingArtifacts = inspected?.kind === 'artifacts';
  const title = session.thread?.name || session.thread?.preview.slice(0, 48) || '新会话';
  const disabled = !connected || connecting || sending || approving || switching || lifecycleBusy;
  const targetThread = actionTarget && (threads.find(thread => thread.id === actionTarget.thread.id) ?? actionTarget.thread);
  const targetNative = targetThread?.id === session.thread?.id ? session.nativeOperations : backgroundNative.filter(operation => operation.threadId === targetThread?.id);
  const nativeActionBlocked = nativePending ? nativePending.state === 'unknown' ? '操作结果尚未确认，请查询状态，勿重复操作。' : '原生操作正在进行，请等待完成。' : '';
  const actionBlocked = !connected ? '连接已断开，重新连接后才能操作。' : !projectAvailable ? '项目已移除或目录失效。' : targetThread && unknownThreads.has(targetThread.id) ? '此会话操作结果尚未确认，请查询原生状态，勿重复操作。' : targetThread?.id === selected.current && nativeActionBlocked ? nativeActionBlocked : targetNative.some(operation => operation.state === 'running') ? '原生操作正在进行，请等待完成。' : targetThread ? sessionActionBlock(targetThread, targetThread.id === selected.current ? { active, pending: !!session.pending.length, sendBlocked: session.sendBlocked, synced } : undefined) : '';
  const renameBlocked = targetNative.some(operation => operation.state === 'running') ? '原生操作正在进行，请等待完成。' : !connected ? '连接已断开，重新连接后才能操作。' : !projectAvailable ? '项目已移除或目录失效。' : !synced || session.historyReloading ? '当前会话状态尚未确认，请先查询状态。' : '';
  const completedTurns = Object.values(session.turns).map((turn, index) => {
    const user = items.find(view => view.turnId === turn.id && view.item.type === 'userMessage')?.item;
    const preview = user?.type === 'userMessage' ? user.content.filter(input => input.type === 'text').map(input => input.text).join(' ').slice(0, 36) : '';
    return { id: turn.id, completed: turn.status === 'completed', label: `第 ${index + 1} 轮${preview ? ' · ' + preview : ''}` };
  }).filter(turn => turn.completed);
  const nativeLatest = session.nativeOperations.find(operation => operation.state === 'unknown') ?? nativePending ?? [...session.nativeOperations].sort((a, b) => b.createdAt - a.createdAt)[0];
  const nativeLabels = { 'thread/name/set': '重命名', 'thread/fork': '分叉', 'thread/revert': '历史回退', 'turn/steer': '补充指令', 'review/start': '原生审阅', 'thread/compact/start': '上下文压缩' };
  const nativeStatusLabel = nativeLatest ? `${nativeLabels[nativeLatest.method]}${nativeLatest.state === 'running' || nativeLatest.state === 'accepted' ? '正在进行' : nativeLatest.state === 'unknown' ? '结果待确认，请查询状态，勿重复操作' : nativeLatest.state === 'rejected' ? '未完成' : '已完成'}` : '';
  const connectionLabel = !connected ? '已断开' : synced ? '状态已查询' : '待查询状态';
  const sessionNavigation = <nav aria-label="原生会话" aria-busy={listing}>{threads.filter(thread => `${thread.name} ${thread.preview} ${thread.id}`.toLowerCase().includes(query.toLowerCase())).map(thread => {
        const current = thread.id === session.thread?.id;
        const status = current ? session.pending.length ? '待审批' : active ? '执行中' : '' : thread.status.type === 'active' ? thread.status.activeFlags.includes('waitingOnApproval') ? '待审批' : '执行中' : '';
        return <div className="session-row" key={thread.id}><button data-thread-id={thread.id} title={sessionLabel(thread)} aria-current={current ? 'page' : undefined} className={`session-link ${current ? 'selected' : ''}`} onClick={event => {
          if (archived) { openSessionActions(thread, event.currentTarget); return; }
          setDrawer(false); setMenu(false); void refresh(thread.id).catch(report);
        }} disabled={disabled || unknownThreads.has(thread.id)}>
          <Icon name={archived ? 'archive' : 'file'} size={16}/><span>{sessionLabel(thread)}</span>{status && <small className={status === '待审批' ? 'pending-dot' : 'running-dot'} title={status}>{status}</small>}
        </button><button className="icon-button session-more" aria-label={`会话操作：${sessionLabel(thread)}`} title="会话操作" aria-haspopup="dialog" disabled={disabled} onClick={event => openSessionActions(thread, event.currentTarget)}><Icon name="more" size={17}/></button></div>;
      })}{!threads.length && !listing && !listError && <p className="nav-empty">{archived ? '此项目没有已归档会话' : '此项目还没有会话'}</p>}{query && threads.length > 0 && !threads.some(t => `${t.name} ${t.preview} ${t.id}`.toLowerCase().includes(query.toLowerCase())) && <p className="nav-empty">已加载会话中没有匹配项</p>}
        {listing && <p className="nav-empty" role="status">正在加载会话…</p>}
        {listError && <p className="error" role="alert">{listError}</p>}
        {query && nextCursor && <p className="session-search-hint">搜索已加载的会话；可加载更多以查找更早记录。</p>}
        {nextCursor && <button className="load-more" disabled={disabled || listing} onClick={() => void listThreads(nextCursor).catch(() => {})}>加载更多会话</button>}
      </nav>;
  return <main data-theme-root data-theme-id={theme.id} className={`app-shell ${layout.navigation ? '' : 'nav-collapsed'} ${layout.inspector ? 'inspector-open' : ''} ${drawer ? 'drawer-open' : ''}`}
    style={{ '--nav-width': `${layout.navigationWidth}px`, '--inspector-width': `${layout.inspectorWidth}px`, '--reading-scale': readingSize / 100 } as CSSProperties}>
    {drawer && <button className="drawer-backdrop" aria-label="关闭导航遮罩" onClick={() => setDrawer(false)}/>}
    <aside data-theme-slot="navigation" className="navigation" aria-label="项目导航" inert={browsing || settings || (mobile && !drawer)}>
      <div className="brand-row"><OracleEye/><div><h1>ORACULUM</h1><span>神谕</span></div><button className="icon-button nav-close" aria-label="折叠导航" title="折叠导航" onClick={() => { setLayout(l => ({ ...l, navigation: false })); setDrawer(false); }}><Icon name="close"/></button></div>
      <div className="nav-section-label"><span>项目</span><button className="icon-button" aria-label="刷新项目目录" title="刷新项目目录" disabled={disabled} onClick={() => void refreshProjects().catch(report)}><Icon name="refresh" size={14}/></button></div>
      <label className="project-picker desktop-project-picker"><Icon name="folder"/><select aria-label="项目目录" value={config?.cwd ?? ''} disabled={disabled} onChange={event => void selectProject(event.target.value).catch(report)}>{config && !projects.projects.some(p => p.cwd === config.cwd) && <option value={config.cwd}>项目已移除</option>}{projects.projects.map(project => <option key={project.cwd} value={project.cwd} disabled={project.available === false}>{project.name}{projects.projects.filter(p => p.name === project.name).length > 1 ? ` · ${project.cwd}` : ''}{project.available === false ? ' · 目录失效' : ''}</option>)}</select></label>
      <p className="project-path desktop-project-path" title={config?.cwd}>{config?.cwd ?? '正在连接工作目录…'}</p>
      <button className="browse-projects" disabled={disabled} onClick={() => setBrowsing(true)}><Icon name="folder" size={15}/>浏览主机文件夹 / 添加项目</button>
      <div className="nav-section-label desktop-session-label"><span>会话</span><button className="icon-button" aria-label="刷新列表" title="刷新列表" disabled={disabled || listing} onClick={() => void listThreads().catch(() => {})}><Icon name="refresh" size={14}/></button></div>
      <div className="session-view-tabs" ref={sessionTabs} role="group" aria-label="会话列表范围"><button aria-pressed={!archived} disabled={disabled} onClick={() => changeSessionView(false)}>会话</button><button aria-pressed={archived} disabled={disabled} onClick={() => changeSessionView(true)}><Icon name="archive" size={14}/>已归档</button></div>
      <label className="search-box"><Icon name="search" size={16}/><input aria-label="搜索会话" placeholder={archived ? '搜索已归档会话…' : '搜索会话…'} value={query} onChange={event => setQuery(event.target.value)}/></label>
      <button className="new-session" onClick={() => void createThread()} disabled={disabled || !projectAvailable}><Icon name="plus"/>新建会话</button>
      {lifecycleNotice && <p className="session-lifecycle-notice" role="status" aria-label="会话操作状态">{lifecycleNotice}</p>}
      {mobile ? <div className="mobile-project-tree">{projects.projects.map(project => {
        const current = config?.cwd === project.cwd;
        const open = current && !treeCollapsed;
        return <section className={`project-group ${current ? 'selected' : ''}`} key={project.cwd}>
          <button className="project-group-heading" title={project.cwd} aria-expanded={open} disabled={disabled || project.available === false} onClick={() => {
            if (current) setTreeCollapsed(value => !value);
            else { setTreeCollapsed(false); void selectProject(project.cwd).catch(report); }
          }}><Icon name="folder"/><span>{project.name}{project.available === false ? ' · 目录失效' : ''}</span><Icon name="chevron" size={15}/></button>
          {open && <><p className="project-group-path" title={project.cwd}>{project.cwd}</p>{sessionNavigation}</>}
        </section>;
      })}</div> : sessionNavigation}
      <footer className="navigation-footer"><WeeklyQuota account={usage.account} connected={usage.connected}/><button className="settings-button" onClick={() => setSettings(true)}><Icon name="settings"/>设置</button><div className="connection"><i className={connected ? 'online' : ''}/><span>{connectionLabel}</span><small>{location.protocol === 'https:' ? 'HTTPS' : 'LOCAL'}</small></div></footer>
      <ResizeHandle side="navigation" value={layout.navigationWidth} onChange={navigationWidth => setLayout(l => ({ ...l, navigationWidth }))}/>
    </aside>
    <section data-theme-slot="conversation" data-thread-id={session.thread?.id ?? ''} data-last-turn-status={lastTurn?.status ?? ''} className="conversation" aria-label="对话" inert={browsing || settings || (mobile && (drawer || layout.inspector))}>
      <div data-theme-slot="decoration" className="theme-decoration" aria-hidden="true"/>
      <header data-theme-slot="header" className="conversation-header">
        <button className="icon-button desktop-nav-toggle" aria-label={layout.navigation ? '折叠导航' : '展开导航'} title={layout.navigation ? '折叠导航' : '展开导航'} onClick={() => setLayout(l => ({ ...l, navigation: !l.navigation }))}><Icon name="panel"/></button>
        <button className="mobile-brand icon-button" aria-label="打开导航" onClick={() => setDrawer(true)}><OracleEye/></button>
        <div className="session-title"><span>{session.thread ? title : 'Oraculum · 神谕'}</span><small>{projects.projects.find(p => p.cwd === config?.cwd)?.name ?? 'Codex'}</small></div>
        <button className="icon-button desktop-header-action" title="新建会话" aria-label="新增会话" disabled={disabled || !projectAvailable} onClick={() => void createThread()}><Icon name="plus"/></button>
        <div className="header-actions"><span className="connection-status" role="status" title={connectionLabel}><i className={connected ? 'online' : ''}/><span className="sr-only">{connectionLabel}</span></span><span className={`turn-state ${active ? 'running' : ''}`} data-testid="turn-status">{!synced && session.thread ? '状态未确认' : session.pending.length ? '待审批' : active ? '执行中' : session.sendBlocked ? '发送待确认' : session.thread ? turnLabel : '—'}</span><button className="icon-button desktop-header-action" aria-label="查询状态" title="查询状态" disabled={disabled || !session.thread} onClick={() => void refresh().catch(report)}><Icon name="refresh" size={16}/></button><button className="icon-button desktop-header-action" aria-label="当前会话操作" title="会话操作" aria-haspopup="dialog" disabled={disabled || !session.thread} onClick={event => openSessionActions(session.thread!, event.currentTarget, false)}><Icon name="more"/></button><button className="icon-button inspector-toggle" aria-label={layout.inspector ? '收起检查器' : '打开检查器'} title="检查器" onClick={() => setLayout(l => ({ ...l, inspector: !l.inspector }))}><Icon name="panel"/></button><button className="icon-button mobile-menu-toggle" aria-label="会话菜单" aria-expanded={menu} onClick={() => setMenu(value => !value)}><Icon name="more"/></button></div>
        {menu && <div className="mobile-session-menu" role="menu" aria-label="会话操作">
          <button role="menuitem" disabled={disabled || !projectAvailable} onClick={() => { setMenu(false); void createThread(); }}><Icon name="plus"/>新建会话</button>
          <button role="menuitem" disabled={disabled || !session.thread} onClick={() => { setMenu(false); void refresh().catch(report); }}><Icon name="refresh"/>查询状态</button>
          <button role="menuitem" disabled={disabled || !session.thread} onClick={event => { setMenu(false); openSessionActions(session.thread!, event.currentTarget, false); }}><Icon name="more"/>当前会话操作</button>
          <button role="menuitem" onClick={() => { setInspected({ kind: 'artifacts' }); setLayout(l => ({ ...l, inspector: true })); setMenu(false); }}><Icon name="folder"/>项目成果</button>
          <button role="menuitem" onClick={openUsage}><Icon name="usage"/>会话用量</button>
          <button role="menuitem" onClick={() => { setMenu(false); setSettings(true); }}><Icon name="settings"/>设置</button>
        </div>}
      </header>
      {!connected && <div className="disconnect-banner">连接已断开，主机任务不会因此停止。<button disabled={connecting || sending || approving} onClick={() => void connect().catch(report)}>重新连接</button></div>}
      <div className="conversation-scroll" ref={scroller} onScroll={() => { if (readingRestore.current !== null) return; const element = scroller.current!; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60; setAtBottom(follow.current); rememberScroll(); }}>
        <div data-theme-slot="content" className="conversation-content" ref={scrollContent}>
          {theme.notice && !settings && <p className="error" role="alert">{theme.notice}</p>}
          {session.history?.nextCursor && <button className="history-more" disabled={loadingHistory || !connected} onClick={() => void older()}>{loadingHistory ? '正在加载…' : '加载更早历史'}</button>}
          {session.sendBlocked && (session.receipts.some(receipt => receipt.status === 'unknown') || !active && !nativePending) && <p role="alert" className="error">有发送尚未确认终态，禁止重发。请查询原生状态；结果仍未知时使用新会话。</p>}
          {config && !projectAvailable && <p className="error" role="alert">项目已移除或目录失效。请浏览主机文件夹并重新添加；仍可停止当前执行或拒绝审批。</p>}
          {error && <p className="error" role="alert">{error}</p>}
          {nativeLatest && <p className={`native-operation-status ${nativeLatest.state}`} role="status" aria-label="原生操作状态">{nativeStatusLabel}{nativeLatest.state === 'rejected' && nativeLatest.message ? `：${nativeLatest.message}` : ''}</p>}
          {session.notices.map((notice, i) => <p className="history-warning" key={i}>{notice}</p>)}
          {lastReceipt?.status === 'rejected' && <p className="error" role="alert">最近一次发送已被拒绝，请检查错误提示后再发送。</p>}
          <div className="timeline" aria-label="会话时间线">
            {emptyBrand && <div className="empty-state" data-brand-state={emptyBrand}>
              <OracleLogo/><div className="empty-state-copy">
                <div className="brand-rule" aria-hidden="true"/><h2>{brandCopy[emptyBrand]}</h2>
                {emptyBrand === 'noProject'
                  ? <button disabled={disabled} onClick={() => setBrowsing(true)}><Icon name="folder"/>选择项目</button>
                  : !session.thread && <button className="primary" disabled={disabled} onClick={() => void createThread()}><Icon name="plus"/>{brandCopy.create}</button>}
              </div>
            </div>}
            {groupTurns(items, session.turns).map(group => <TurnProcess key={`${session.thread?.id}:${group.id}`} {...group} threadId={session.thread?.id}
              pending={hasTurnApproval(session.pending, session.thread?.id, group.id, session.activeTurn)}
              connected={connected} synced={synced} plan={session.plans[group.id]} planAfter={session.planAfter[group.id]} diff={session.diffs[group.id]} cwd={session.thread?.cwd}
              attachments={session.attachments.find(delivery => delivery.turnId === group.id)}
              showDiff={openDiff} showDetails={openItem} onToggle={() => { follow.current = false; }}/>) }
          </div>
          <section aria-label="待审批" className="approvals">
            {session.pending.map(request => <NativeRequest key={`${typeof request.id}:${request.id}:${request.bridgeToken ?? ''}`} request={request} busy={approving} canReply={connected} canAccept={synced && projectAvailable} reply={value => {
                setApproving(true);
                void client.current!.request('bridge/approve', { threadId: request.params.threadId, requestId: request.id, bridgeToken: request.bridgeToken, ...value })
                  .then(() => useSession.setState(s => ({ pending: s.pending.filter(p => p.id !== request.id || p.bridgeToken !== request.bridgeToken) })))
                  .catch(report).finally(() => setApproving(false));
              }}/>)}
          </section>
        </div>
      </div>
      <div className="jump-latest-slot">{!atBottom && <button className="jump-latest" onClick={() => { follow.current = true; scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }); }}><Icon name="arrowDown" size={14}/>返回最新{session.pending.length ? ' · 待审批' : ''}</button>}</div>
      <form ref={composerForm} data-theme-slot="composer" className={`composer ${expanded ? 'expanded' : ''} ${draggingFiles ? 'is-dragging' : ''}`} onSubmit={event => { event.preventDefault(); submitComposer(); }}
        onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = canAttach ? 'copy' : 'none'; setDraggingFiles(canAttach); } }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false); }}
        onDrop={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDraggingFiles(false); addAttachments(Array.from(event.dataTransfer.files)); } }}
        onPaste={event => { const images = Array.from(event.clipboardData.items).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => !!file); if (images.length) { event.preventDefault(); addAttachments(images); } }}>
        <input ref={attachmentPicker} className="attachment-picker" type="file" multiple accept={attachmentAccept} aria-label="选择图片或文档" onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (pickerScope.current === attachmentScope) addAttachments(files); }}/>
        <div className="composer-context model-controls">
          <button type="button" className="composer-control project-control" aria-label={`项目：${projectLabel}`} title={projectLabel} aria-haspopup="dialog" aria-expanded={composerMenu === 'project'} disabled={disabled} onClick={event => toggleComposerMenu('project', event.currentTarget)}><Icon name="folder"/><span className="composer-value">{projectLabel}</span><Icon name="chevron" size={12}/></button>
          <button type="button" className="composer-control model-control" aria-label={`模型与思考强度：${modelLabel} · ${effort || '未读取'}`} title={`${modelLabel} · ${effort || '未读取'}`} aria-haspopup="dialog" aria-expanded={composerMenu === 'model'} data-state={choices.model || choices.effort ? 'pending' : 'native'} disabled={disabled || active || !synced || !projectAvailable || session.sendBlocked} onClick={event => toggleComposerMenu('model', event.currentTarget)}><Icon name="model"/><span className="composer-value">{modelLabel}</span>{effort && <span className="effort-badge">{effort}</span>}<Icon name="chevron" size={12}/></button>
        </div>
        <AttachmentTray queue={attachmentQueue} queues={attachmentQueues} locked={sending || switching || lifecycleBusy}/>
        {!!attachmentQueue.files.length && <p className="attachment-hint">最多 6 个 · 单个 20 MB · 合计 50 MB。文档通过主机工具读取。{active ? '附件保留到下一轮发送。' : ''}</p>}
        <div className="composer-input"><label className="sr-only" htmlFor="message">消息</label><textarea ref={composer} id="message" enterKeyHint="enter" onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} value={text} onChange={event => writeDraft(event.target.value)} placeholder={brandCopy.placeholder} maxLength={16000} rows={2} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); submitComposer(); } }}/><button className="icon-button expand-composer" type="button" aria-label={expanded ? '收起输入框' : '展开输入框'} title="展开输入框" onClick={() => setExpanded(value => !value)}><Icon name="expand" size={15}/></button></div>
        {steerDraft && <div className="steer-draft-status" role="status">{active && session.activeTurn === steerDraft.turnId ? '补充到当前运行，不开启新一轮。' : '原运行已结束或切换，草稿已保留。'}{!active && <button type="button" onClick={() => bindSteerDraft(undefined)}>作为新消息</button>}</div>}
        <div className="composer-toolbar">
          <div className="composer-options">
            <button type="button" className="icon-button composer-more" aria-label="更多操作" title="更多操作" aria-haspopup="dialog" aria-expanded={composerMenu === 'more'} onClick={event => toggleComposerMenu('more', event.currentTarget)}><Icon name="plus" size={21}/></button>
            <button type="button" className={`composer-control permission-control ${permissionMode === 'full-access' ? 'full-access' : ''}`} aria-label={`权限：${permissionLabel}`} title={permissionLabel} aria-haspopup="dialog" aria-expanded={composerMenu === 'permission'} data-state={choices.permissionMode ? 'pending' : 'native'} disabled={disabled || active || !synced || !projectAvailable || session.sendBlocked} onClick={event => toggleComposerMenu('permission', event.currentTarget)}><Icon name="shield"/><span className="composer-value">{permissionLabel}</span><Icon name="chevron" size={12}/></button>
          </div>
          <div className="composer-actions">{active
            ? <><button type="button" className="steer-button" aria-label="补充指令" title={session.nativeCapabilities?.unsupportedMethods.includes('turn/steer') ? '当前版本暂不支持' : '补充到当前运行 · Ctrl+Enter'} disabled={!canSteer} onClick={() => void steer()}>补充指令</button><button type="button" className="stop-button" aria-label="停止" title="停止" disabled={!connected || !session.activeTurn} onClick={() => void client.current!.request('turn/interrupt', { threadId: selected.current, turnId: session.activeTurn }).catch(report)}><Icon name="stop" size={18}/></button></>
            : <button className="primary send-button" title="发送 · Ctrl+Enter" aria-label="发送" disabled={!canSend}><Icon name="arrowUp" size={21}/></button>}
          </div>
        </div>
        {composerMenu && <div ref={composerPanel} className={`composer-popover composer-popover-${composerMenu}`} data-level={composerMenu === 'model' ? modelMenuLevel : undefined} role="dialog" aria-label={{ project: '项目', model: '模型与思考强度', permission: '权限', more: '更多操作' }[composerMenu]} tabIndex={-1} onKeyDown={composerMenu === 'model' ? navigateModelMenu : undefined}>
          {composerMenu === 'more' && <><button type="button" disabled={!canAttach} onClick={() => { closeComposerMenu(); openAttachmentPicker(); }}><Icon name="file"/>添加图片或文档</button><p className="attachment-hint">PNG / JPEG / WebP、PDF、Office、CSV、TXT、MD。最多 6 个，单个 20 MB，合计 50 MB。{!session.thread ? '请先选择或新建会话。' : active ? '请在当前运行结束后添加附件。' : ''}</p></>}
          {composerMenu === 'project' && <>
            <div role="radiogroup" aria-label="项目" className="composer-choice-list">{projects.projects.map(project => <button type="button" role="radio" aria-checked={project.cwd === config?.cwd} data-value={project.cwd} key={project.cwd} disabled={disabled || project.available === false} onClick={() => { closeComposerMenu(true); void selectProject(project.cwd).catch(report); }}><Icon name="folder" size={17}/><span>{project.name}{projects.projects.filter(entry => entry.name === project.name).length > 1 && <small>{project.cwd}</small>}</span>{project.cwd === config?.cwd && <Icon name="check" size={16}/>}</button>)}</div>
            <button type="button" className="composer-add-project" onClick={() => { closeComposerMenu(); setBrowsing(true); }}><Icon name="plus" size={17}/>添加项目</button>
          </>}
          {composerMenu === 'model' && (modelMenuLevel === 'summary'
            ? <div className="composer-model-summary">
              <button type="button" aria-label="模型" data-level="model" onClick={() => openModelMenu('model')}><span>模型</span><span className="composer-summary-value">{modelLabel}</span><Icon name="chevron" size={14}/></button>
              <button type="button" aria-label="思考强度" data-level="effort" onClick={() => openModelMenu('effort')}><span>思考强度</span><span className="composer-summary-value">{effort || '未读取'}</span><Icon name="chevron" size={14}/></button>
            </div>
            : <>
              <header className="composer-submenu-header"><button type="button" aria-label="返回模型与思考强度" onClick={() => setModelMenuLevel('summary')}><Icon name="back" size={17}/><span>{modelMenuLevel === 'model' ? '模型' : '思考强度'}</span></button></header>
              {modelMenuLevel === 'model'
                ? <div role="radiogroup" aria-label="模型" className="composer-choice-list">{model && !models.some(entry => entry.model === model) && <div className="composer-custom-value">{model}</div>}{models.filter(entry => !entry.hidden || entry.model === model).map(entry => <button type="button" role="radio" aria-checked={entry.model === model} data-value={entry.model} key={entry.id} onClick={() => { chooseSetting('model', entry.model); setModelMenuLevel('summary'); }}><span>{entry.displayName}</span>{entry.model === model && <Icon name="check" size={16}/>}</button>)}</div>
                : <div role="radiogroup" aria-label="思考强度" className="composer-choice-list">{effort && !selectedModel?.supportedReasoningEfforts.some(option => option.reasoningEffort === effort) && <div className="composer-custom-value">{effort}</div>}{(selectedModel?.supportedReasoningEfforts ?? []).map(option => <button type="button" role="radio" aria-checked={option.reasoningEffort === effort} data-value={option.reasoningEffort} key={option.reasoningEffort} onClick={() => { chooseSetting('effort', option.reasoningEffort); setModelMenuLevel('summary'); }}><span>{option.reasoningEffort}</span>{option.reasoningEffort === effort && <Icon name="check" size={16}/>}</button>)}</div>}
            </>)}
          {composerMenu === 'permission' && <div role="radiogroup" aria-label="权限" className="composer-choice-list">{permissionMode === 'custom' && <div className="composer-custom-value">{permissionLabel}<Icon name="check" size={16}/></div>}{permissionModes.map(mode => <button type="button" role="radio" aria-checked={permissionMode === mode.value} data-value={mode.value} key={mode.value} onClick={() => { chooseSetting('permissionMode', mode.value); closeComposerMenu(true); }}><Icon name="shield" size={17}/><span>{mode.label}</span>{permissionMode === mode.value && <Icon name="check" size={16}/>}</button>)}</div>}
        </div>}
      </form>
    </section>
    {layout.inspector && <section data-theme-slot="inspector" className="inspector" inert={browsing || settings || (mobile && drawer)} aria-label={viewingArtifacts ? '项目成果面板' : viewingUsage ? '会话用量面板' : inspected?.kind === 'item' ? '工具详情面板' : '文件 Diff 面板'}>
      <ResizeHandle side="inspector" value={layout.inspectorWidth} onChange={inspectorWidth => setLayout(l => ({ ...l, inspectorWidth }))}/>
      <header className="inspector-header">
        <button className="icon-button mobile-detail-back" aria-label="返回会话" onClick={() => setLayout(l => ({ ...l, inspector: false }))}><Icon name="back"/></button>
        <div className="inspector-tabs" role="group" aria-label="检查器视图">
          <button className={!viewingUsage && !viewingArtifacts && inspected?.kind !== 'item' ? 'active' : ''} aria-pressed={!viewingUsage && !viewingArtifacts && inspected?.kind !== 'item'}
            onClick={() => { if (files[0]) openDiff(files[0].path, files[0].diff); else setInspected({ kind: 'emptyDiff' }); }}><Icon name="file" size={15}/>Diff</button>
          <button className={inspected?.kind === 'item' ? 'active' : ''} aria-pressed={inspected?.kind === 'item'} disabled={!tools.length}
            onClick={() => { const view = tools.at(-1)!; openItem(view.item, view.turnId); }}><Icon name="terminal" size={15}/>输出</button>
          <button className={viewingArtifacts ? 'active' : ''} aria-pressed={viewingArtifacts} onClick={() => setInspected({ kind: 'artifacts' })}><Icon name="folder" size={15}/>文件</button>
          <button className={viewingUsage ? 'active' : ''} aria-pressed={viewingUsage} onClick={openUsage}><Icon name="usage" size={15}/>用量</button>
        </div>
        <button className="icon-button" aria-label="关闭面板" title="关闭面板" onClick={() => setLayout(l => ({ ...l, inspector: false }))}><Icon name="close"/></button>
      </header>
      <div className="inspector-scroll">
        {viewingArtifacts ? <Suspense fallback={<p>正在加载项目成果…</p>}><Artifacts key={`${config?.cwd}:${session.thread?.id}`} scope={{ cwd: config?.cwd ?? '', threadId: session.thread?.id ?? '' }} enabled={connected && synced && !switching && !!session.thread && session.thread.cwd === config?.cwd && projectAvailable}/></Suspense> : viewingUsage ? <SessionUsage thread={session.thread && !switching ? usage.threads[usageKey(session.thread.cwd, session.thread.id)] : undefined} selected={!!session.thread && !switching} connected={usage.connected} refreshing={usageRefreshing} onRefresh={() => void refreshUsage()}/> : inspected?.kind === 'diff' ? <><div className="inspector-file"><Icon name="file"/><h2 title={inspected.path}>{displayPath(inspected.path, session.thread?.cwd)}</h2></div><small className="inspector-caption">Codex 原生差异 · 只读</small><Suspense fallback={<p>正在加载 Diff…</p>}><Diff text={inspected.diff} label={`Diff ${inspected.path}`}/></Suspense></> : inspectedItem ? <><div className="inspector-file"><Icon name="terminal"/><h2>{inspectedItem.type === 'commandExecution' ? '命令输出' : '工具详情'}</h2></div><ItemDetail item={inspectedItem}/></> : <div className="inspector-empty"><OracleEye/><h2>{brandCopy.inspectorTitle}</h2><p>{brandCopy.inspectorDescription}</p></div>}
        {!viewingUsage && !viewingArtifacts && !!files.length && <details className="inspector-list" open><summary>变更文件 <span>{files.length}</span></summary>{files.map((file, index) => <button key={`${file.path}:${index}`} onClick={() => openDiff(file.path, file.diff)} className={inspected?.kind === 'diff' && inspected.path === file.path ? 'selected' : ''}><Icon name="file" size={14}/><span title={file.path}>{displayPath(file.path, session.thread?.cwd)}</span></button>)}</details>}
        {!viewingUsage && !viewingArtifacts && !!tools.length && <details className="inspector-list"><summary>工具记录 <span>{tools.length}</span></summary>{tools.map(view => <button key={`${view.turnId}:${view.item.id}`} onClick={() => openItem(view.item, view.turnId)}><Icon name="terminal" size={14}/><span>{view.item.type === 'commandExecution' ? view.item.command : view.item.type}</span></button>)}</details>}
      </div>
      <footer className="mobile-detail-footer"><button onClick={() => setLayout(l => ({ ...l, inspector: false }))}><Icon name="back"/>返回会话</button></footer>
    </section>}
    {browsing && client.current && <ProjectBrowser client={client.current} projects={projects} onRefresh={refreshProjects} onSelect={selectProject} onClose={() => setBrowsing(false)}/>}
    {actionTarget && targetThread && <SessionActions key={targetThread.id} target={{ ...actionTarget, thread: targetThread }} projectName={projects.projects.find(project => project.cwd === targetThread.cwd)?.name ?? '当前项目'} blocked={actionBlocked} busy={lifecycleBusy} native={{ current: targetThread.id === session.thread?.id, turns: targetThread.id === session.thread?.id ? completedTurns : [], blocked: targetThread.id === session.thread?.id ? nativeActionBlocked : targetNative.some(operation => operation.state === 'running') ? '原生操作正在进行，请等待完成。' : '', renameBlocked, operationBlocks: Object.fromEntries(targetNative.filter(operation => operation.threadId === targetThread.id && ['running', 'accepted', 'unknown'].includes(operation.state)).map(operation => [operation.method, '此操作尚未确认完成，请查询状态，勿重复操作。'])), unsupported: session.nativeCapabilities?.unsupportedMethods ?? [], onAction: changeNativeSession }} onAction={changeSession} onClose={closeSessionActions}/>}
    <dialog data-theme-slot="settings" ref={dialog} className="settings-dialog app-settings" aria-label="设置" onCancel={event => { if (event.target === event.currentTarget) setSettings(false); }} onClick={event => { if (event.target === event.currentTarget) setSettings(false); }}><div className="settings-content">
      <header><div><OracleEye/><h2>设置</h2></div><button className="icon-button" aria-label="关闭设置" onClick={() => setSettings(false)}><Icon name="close"/></button></header>
      {settings && <IdentitySettings/>}
      <PermissionDetails settings={session.settings} synced={connected && synced} hasThread={!!session.thread}/>
      <ThemeSettings theme={theme} open={settings}/>
      <h3>界面与阅读</h3><label className="reading-size">正文大小 <span>{readingSize}%</span><input aria-label="正文大小" type="range" min="100" max="150" step="10" value={readingSize} onChange={event => setReadingSize(Number(event.target.value))}/></label>
      {!mobile && <button onClick={() => setLayout({ navigation: true, inspector: false, navigationWidth: 264, inspectorWidth: 420 })}>恢复面板默认布局</button>}
      <h3>连接</h3><p className="path">{connectionLabel} · {location.origin}{new URL('.', location.href).pathname}</p><button disabled={connecting || sending || approving} onClick={() => void connect().catch(report)}><Icon name="refresh" size={15}/>重新连接</button>
      {androidShell && <a className="server-settings-link" href="oraculum://settings/server"><Icon name="settings"/>服务器地址</a>}
      <h3>工作目录</h3><p className="path">{config?.cwd}</p><p>从导航浏览 Ubuntu 主机文件夹并添加已有项目。</p>
      <p>可发送图片和 PDF、Office、CSV、TXT、Markdown 文档。图片直接交给 Codex；文档上传到当前主机项目，由原生工具读取并遵循已有审批。每批最多 6 个、单个 20 MB、合计 50 MB。</p>
    </div></dialog>
  </main>;
}
createRoot(document.getElementById('root')!).render(<SessionGate><IdentityProvider><App/></IdentityProvider></SessionGate>);
