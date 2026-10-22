import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { BridgeClient } from '../../../packages/shared/client';
import type { BridgeEvent, LocalConfig, Model, ProjectList, Snapshot, Thread, ThreadItem } from '../../../packages/shared/protocol';
import type { ThreadStartResponse } from '../../../.local/codex-protocol/v2/ThreadStartResponse';
import type { ThreadListResponse } from '../../../.local/codex-protocol/v2/ThreadListResponse';
import { itemKey, useSession } from './store';
import { captureReading, parseReading, placeReading, readingDeadline, type ReadingPosition } from './reading';
import { Item, ItemDetail } from './content';
import { androidShell, useMobile } from './mobile';
import { OracleEye, OracleLogo } from './brand';
import { Icon } from './icons';
import { ProjectBrowser } from './project-browser';
import { displayPath } from './paths';
import { ResizeHandle, useLayout } from './layout';
import { SessionGate, checkSession } from './auth';
import { ThemeSettings, useTheme } from './themes';
import './style.css';
import './mobile.css';

const Diff = lazy(() => import('./diff').then(module => ({ default: module.Diff })));
type Inspected = { kind: 'diff'; path: string; diff: string } | { kind: 'item'; id: string; turnId: string };
const readSaved = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const save = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Storage is optional. */ } };
// Android server profiles survive WebView recreation; tab-scoped desktop drafts stay unchanged.
const readingStorage = () => androidShell ? localStorage : sessionStorage;
function App() {
  const theme = useTheme();
  const session = useSession();
  const mobile = useMobile();
  const [menu, setMenu] = useState(false);
  const [readingSize, setReadingSize] = useState(() => Math.min(150, Math.max(100, Number(readSaved('oraculum.reading-size')) || 100)));
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [synced, setSynced] = useState(false);
  const [config, setConfig] = useState<LocalConfig>();
  const [projects, setProjects] = useState<ProjectList>({ root: '', projects: [] });
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
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
  const [atBottom, setAtBottom] = useState(true);
  const client = useRef<BridgeClient>(null);
  const selected = useRef('');
  const workspace = useRef('');
  const epoch = useRef(0);
  const connectionEpoch = useRef(0);
  const connectingNow = useRef(false);
  const projectEpoch = useRef(0);
  const listEpoch = useRef(0);
  const registryEpoch = useRef(0);
  const draftRevision = useRef(0);
  const buffer = useRef<BridgeEvent[] | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const scrollContent = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);
  const scrollPositions = useRef(new Map<string, ReadingPosition>());
  const readingRestore = useRef<number | null>(null);
  const overlayPosition = useRef<{ id: string; top: number } | null>(null);
  const composing = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const report = (value: unknown) => setError(value instanceof Error ? value.message : String(value));
  const storageKey = () => `oraculum.thread:${workspace.current}`;
  const draftKey = (id = selected.current) => `oraculum.draft:${workspace.current}:${id}`;
  function readDraft() {
    try {
      const stored = readingStorage().getItem(draftKey());
      if (stored !== null) return stored;
      const previous = sessionStorage.getItem(draftKey()) ?? '';
      if (androidShell) localStorage.setItem(draftKey(), previous);
      return previous;
    } catch { return ''; }
  }
  function writeDraft(value: string) { ++draftRevision.current; setText(value); try { readingStorage().setItem(draftKey(), value); } catch { /* Keep current in-memory input. */ } }
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
    if (current() && !useSession.getState().items[key]) {
      useSession.setState(state => ({ notices: [...state.notices, '未能找到上次阅读的原生记录，暂按保存位置显示。'] }));
    }
  }
  const openDiff = (path: string, diff: string) => { setInspected({ kind: 'diff', path, diff }); setLayout(l => ({ ...l, inspector: true })); };
  function openItem(item: ThreadItem, turnId: string) { setInspected({ kind: 'item', id: item.id, turnId }); setLayout(l => ({ ...l, inspector: true })); }
  async function refreshProjects() {
    const ticket = ++registryEpoch.current;
    const directory = await client.current!.request<ProjectList>('bridge/projects', {});
    if (ticket === registryEpoch.current) setProjects(directory);
  }
  async function listThreads(cursor?: string) {
    const cwd = workspace.current;
    const ticket = ++listEpoch.current;
    const page = await client.current!.request<ThreadListResponse>('thread/list', { cursor, cwd });
    if (cwd !== workspace.current || ticket !== listEpoch.current) return null;
    setThreads(current => [...new Map([...(cursor ? current : []), ...page.data].map(t => [t.id, t])).values()]);
    setNextCursor(page.nextCursor);
    return page;
  }
  function apply(message: BridgeEvent, restoring = false) {
    const state = useSession.getState();
    if (message.type === 'approval') state.approval(message.request);
    if (message.type === 'event') {
      state.event(message.event, restoring);
      if (message.event.method === 'thread/status/changed') {
        const { threadId, status } = message.event.params;
        setThreads(current => current.map(t => t.id === threadId ? { ...t, status } : t));
      }
    }
    if (message.type === 'notice' && (!message.threadId || message.threadId === selected.current)) {
      useSession.setState({ notices: [...state.notices, message.message] });
    }
  }
  async function refresh(id = selected.current) {
    const ticket = ++epoch.current;
    const changed = selected.current !== id;
    rememberScroll();
    let position = savedScroll(id);
    if (changed) { readingRestore.current = ticket; follow.current = false; }
    selected.current = id;
    setSynced(false); setLoadingHistory(false);
    if (changed) {
      useSession.getState().reset(); setModel(''); setEffort(''); setError(''); setInspected(undefined);
      setText(readDraft()); setDrawer(false); setMenu(false);
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
      const queued = buffer.current ?? [];
      buffer.current = null;
      for (const message of queued) apply(message, true);
      if (queued.some(e => e.type === 'event' && e.event.method.endsWith('delta'))) {
        useSession.setState({ notices: [...useSession.getState().notices, '查询期间有流式更新；中间片段可能不全，终态或再次查询后补齐。'] });
      }
      await restoreEarlier(position, id, ticket);
      if (ticket !== epoch.current) return;
      save(storageKey(), id);
      setSynced(true);
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
    const ticket = ++projectEpoch.current;
    ++listEpoch.current;
    setSwitching(true); setError(''); setSynced(false);
    try {
      rememberScroll();
      const settings = await client.current!.request<LocalConfig>('bridge/config', { cwd });
      if (ticket !== projectEpoch.current) return;
      ++epoch.current; readingRestore.current = null; selected.current = ''; buffer.current = null;
      workspace.current = settings.cwd; save('oraculum.project', settings.cwd);
      setConfig(settings); setThreads([]); setNextCursor(null); setQuery(''); setModel(''); setEffort(''); setInspected(undefined);
      useSession.getState().reset(); setText(readDraft());
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
    connectingNow.current = true; setConnecting(true);
    try {
    const ticket = ++connectionEpoch.current;
    ++epoch.current; setSynced(false); setError('');
    const authenticated = await checkSession();
    if (ticket !== connectionEpoch.current) return;
    if (!authenticated) { client.current!.close(); throw new Error('设备需要重新配对'); }
    await client.current!.connect();
    if (ticket !== connectionEpoch.current) return;
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
      if (message.type === 'projectsChanged') { void refreshProjects().catch(report); return; }
      if (message.type === 'unavailable') { ++epoch.current; readingRestore.current = null; buffer.current = null; useSession.setState({ pending: [] }); setError(message.message); setSynced(false); setLoadingHistory(false); return; }
      if (buffer.current) buffer.current.push(message);
      else {
        apply(message);
        if (message.type === 'event' && message.event.method === 'turn/completed' && message.event.params.threadId === selected.current) {
          void refresh().then(() => listThreads()).catch(report);
        }
      }
    }, value => {
      setConnected(value);
      if (!value) { setSynced(false); void checkSession().catch(() => {}); }
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
  useEffect(() => { if (settings) dialog.current?.showModal(); else dialog.current?.close(); }, [settings]);
  useEffect(() => { save('oraculum.reading-size', String(readingSize)); }, [readingSize]);
  const overlay = mobile && (drawer || settings || browsing || menu || layout.inspector);
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
  }, [settings, browsing, menu, drawer, expanded, layout.inspector]);
  async function createThread() {
    setSending(true); setError('');
    try {
      const result = await client.current!.request<ThreadStartResponse>('thread/start', { model, cwd: workspace.current });
      rememberScroll(); ++epoch.current; readingRestore.current = null; buffer.current = null; selected.current = result.thread.id;
      setInspected(undefined); setText(readDraft()); setDrawer(false); follow.current = true;
      useSession.getState().reset(); useSession.getState().snapshot({ thread: result.thread, pending: [] });
      save(storageKey(), result.thread.id);
      setThreads(ids => [result.thread, ...ids]); setSynced(true); composer.current?.focus();
    } catch (value) { report(value); } finally { setSending(false); }
  }
  const active = !!session.activeTurn || session.thread?.status.type === 'active';
  const projectAvailable = !config || projects.projects.some(p => p.cwd === config.cwd && p.available !== false);
  const canSend = projectAvailable && connected && synced && !!session.thread && !active && !session.sendBlocked && !sending && !switching && !!text.trim();
  async function send() {
    if (!canSend || composing.current) return;
    setSending(true); setError(''); follow.current = true;
    const submittedRevision = draftRevision.current;
    try {
      await client.current!.request('turn/start', { threadId: selected.current, text, model, effort });
      if (draftRevision.current === submittedRevision) writeDraft('');
    } catch (value) { report(value); setSynced(false); }
    finally { setSending(false); }
  }
  async function older() {
    const id = selected.current;
    const ticket = epoch.current;
    const cursor = session.history!.nextCursor;
    setLoadingHistory(true); follow.current = false;
    try {
      const value = await client.current!.request<Snapshot>('bridge/history', { threadId: id, cursor });
      if (selected.current !== id || epoch.current !== ticket) return;
      const top = scroller.current?.scrollTop ?? 0;
      const height = scroller.current?.scrollHeight ?? 0;
      useSession.getState().older(value);
      requestAnimationFrame(() => { if (scroller.current && selected.current === id) scroller.current.scrollTop = top + scroller.current.scrollHeight - height; });
    } catch (value) { report(value); } finally { if (ticket === epoch.current) setLoadingHistory(false); }
  }
  const lastTurn = session.turns[session.lastTurnId ?? ''];
  const items = Object.values(session.items);
  const files = items.flatMap(view => view.item.type === 'fileChange' ? view.item.changes : []);
  const tools = items.filter(view => ['commandExecution', 'mcpToolCall'].includes(view.item.type));
  const inspectedItem = inspected?.kind === 'item' ? items.find(view => view.item.id === inspected.id && view.turnId === inspected.turnId)?.item : undefined;
  const title = session.thread?.name || session.thread?.preview.slice(0, 48) || '新会话';
  const disabled = !connected || connecting || sending || approving || switching;
  const connectionLabel = !connected ? '已断开' : synced ? '状态已查询' : '待查询状态';
  const sessionNavigation = <nav aria-label="原生会话">{threads.filter(thread => `${thread.name} ${thread.preview} ${thread.id}`.toLowerCase().includes(query.toLowerCase())).map(thread => {
        const current = thread.id === session.thread?.id;
        const status = current ? session.pending.length ? '待审批' : active ? '执行中' : '' : thread.status.type === 'active' ? thread.status.activeFlags.includes('waitingOnApproval') ? '待审批' : '执行中' : '';
        return <button title={thread.id} aria-current={current ? 'page' : undefined} className={`session-link ${current ? 'selected' : ''}`} key={thread.id} onClick={() => { setDrawer(false); setMenu(false); void refresh(thread.id).catch(report); }} disabled={disabled}>
          <Icon name="file" size={16}/><span>{thread.name || thread.preview.slice(0, 42) || '新会话'}</span>{status && <small className={status === '待审批' ? 'pending-dot' : 'running-dot'} title={status}>{status}</small>}
        </button>;
      })}{!threads.length && <p className="nav-empty">此项目还没有会话</p>}{query && !threads.some(t => `${t.name} ${t.preview} ${t.id}`.toLowerCase().includes(query.toLowerCase())) && <p className="nav-empty">没有匹配的会话</p>}
        {nextCursor && <button className="load-more" disabled={disabled} onClick={() => void listThreads(nextCursor).catch(report)}>加载更多会话</button>}
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
      <div className="nav-section-label desktop-session-label"><span>会话</span><button className="icon-button" aria-label="刷新列表" title="刷新列表" disabled={disabled} onClick={() => void listThreads().catch(report)}><Icon name="refresh" size={14}/></button></div>
      <label className="search-box"><Icon name="search" size={16}/><input aria-label="搜索会话" placeholder="搜索会话…" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <button className="new-session" onClick={() => void createThread()} disabled={disabled || !projectAvailable}><Icon name="plus"/>新建会话</button>
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
      <footer className="navigation-footer"><button className="settings-button" onClick={() => setSettings(true)}><Icon name="settings"/>设置</button><div className="connection"><i className={connected ? 'online' : ''}/><span>{connectionLabel}</span><small>{location.protocol === 'https:' ? 'HTTPS' : 'LOCAL'}</small></div></footer>
      <ResizeHandle side="navigation" value={layout.navigationWidth} onChange={navigationWidth => setLayout(l => ({ ...l, navigationWidth }))}/>
    </aside>
    <section data-theme-slot="conversation" className="conversation" aria-label="对话" inert={browsing || settings || (mobile && (drawer || layout.inspector))}>
      <div data-theme-slot="decoration" className="theme-decoration" aria-hidden="true"/>
      <header data-theme-slot="header" className="conversation-header">
        <button className="icon-button desktop-nav-toggle" aria-label={layout.navigation ? '折叠导航' : '展开导航'} title={layout.navigation ? '折叠导航' : '展开导航'} onClick={() => setLayout(l => ({ ...l, navigation: !l.navigation }))}><Icon name="panel"/></button>
        <button className="mobile-brand icon-button" aria-label="打开导航" onClick={() => setDrawer(true)}><OracleEye/></button>
        <div className="session-title"><span>{session.thread ? title : 'Oraculum · 神谕'}</span><small>{projects.projects.find(p => p.cwd === config?.cwd)?.name ?? 'Codex'}</small></div>
        <button className="icon-button desktop-header-action" title="新建会话" aria-label="新增会话" disabled={disabled || !projectAvailable} onClick={() => void createThread()}><Icon name="plus"/></button>
        <div className="header-actions"><span className="connection-status" role="status" title={connectionLabel}><i className={connected ? 'online' : ''}/><span className="sr-only">{connectionLabel}</span></span><span className={`turn-state ${active ? 'running' : ''}`} data-testid="turn-status">{!synced && session.thread ? '状态未确认' : session.pending.length ? '待审批' : active ? '执行中' : session.thread ? '空闲' : '—'}</span><button className="icon-button desktop-header-action" aria-label="查询状态" title="查询状态" disabled={disabled || !session.thread} onClick={() => void refresh().catch(report)}><Icon name="refresh" size={16}/></button><button className="icon-button inspector-toggle" aria-label={layout.inspector ? '收起检查器' : '打开检查器'} title="检查器" onClick={() => setLayout(l => ({ ...l, inspector: !l.inspector }))}><Icon name="panel"/></button><button className="icon-button mobile-menu-toggle" aria-label="会话菜单" aria-expanded={menu} onClick={() => setMenu(value => !value)}><Icon name="more"/></button></div>
        {menu && <div className="mobile-session-menu" role="menu" aria-label="会话操作">
          <button role="menuitem" disabled={disabled || !projectAvailable} onClick={() => { setMenu(false); void createThread(); }}><Icon name="plus"/>新建会话</button>
          <button role="menuitem" disabled={disabled || !session.thread} onClick={() => { setMenu(false); void refresh().catch(report); }}><Icon name="refresh"/>查询状态</button>
          <button role="menuitem" onClick={() => { setMenu(false); setSettings(true); }}><Icon name="settings"/>设置</button>
        </div>}
      </header>
      {!connected && <div className="disconnect-banner">连接已断开，主机任务不会因此停止。<button disabled={connecting || sending || approving} onClick={() => void connect().catch(report)}>重新连接</button></div>}
      <div className="conversation-scroll" ref={scroller} onScroll={() => { if (readingRestore.current !== null) return; const element = scroller.current!; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60; setAtBottom(follow.current); rememberScroll(); }}>
        <div data-theme-slot="content" className="conversation-content" ref={scrollContent}>
          {theme.notice && !settings && <p className="error theme-protected" role="alert">{theme.notice}</p>}
          {session.history?.nextCursor && <button className="history-more" disabled={loadingHistory || !connected} onClick={() => void older()}>{loadingHistory ? '正在加载…' : '加载更早历史'}</button>}
          {session.history?.warning && <p className="history-warning">{session.history.warning}</p>}
          {session.sendBlocked && <p role="alert" className="error">有发送尚未确认终态，禁止重发。请查询原生状态；结果仍未知时使用新会话。</p>}
          {!projectAvailable && <p className="error" role="alert">项目已移除或目录失效。请浏览主机文件夹并重新添加；仍可停止当前执行或拒绝审批。</p>}
          {error && <p className="error" role="alert">{error}</p>}
          {session.notices.map((notice, i) => <p className="history-warning" key={i}>{notice}</p>)}
          {lastTurn?.error && <p className="error" role="alert">{lastTurn.status}：{lastTurn.error.message}</p>}
          <div className="timeline" aria-label="会话时间线">
            {!items.length && <div className="empty-state"><OracleLogo/><h2>{session.thread ? '从一个问题开始' : '让想法，成为现实'}</h2><p>{session.thread ? '描述目标，Codex 将在当前项目中与你协作。' : '选择项目并新建会话，连接真正的 Codex。'}</p>{!session.thread && <button className="primary" disabled={disabled || !projectAvailable} onClick={() => void createThread()}><Icon name="plus"/>开始新会话</button>}</div>}
            {Object.entries(session.items).map(([key, view]) => <div key={key} data-turn-id={view.turnId} data-item-id={view.item.id}>
              <Item item={view.item} cwd={session.thread?.cwd} showDiff={openDiff} showDetails={item => openItem(item, view.turnId)}/>
              {view.source === 'live' && <small className="provenance">实时事件 · 未确认持久化</small>}
            </div>)}
          </div>
          {session.plan && <details className="tool current-plan"><summary>当前计划 · Codex</summary><pre>{session.plan}</pre></details>}
          {Object.entries(session.diffs).map(([turnId, diff]) => <button className="turn-diff" key={turnId} onClick={() => openDiff(`轮次 ${turnId} · 实时汇总`, diff)}><Icon name="file" size={14}/>查看轮次 Diff · {turnId.slice(-8)}</button>)}
          <section aria-label="待审批" className="approvals">
            {session.pending.map(request => <article className="approval theme-protected" key={`${typeof request.id}:${request.id}`}>
              <div className="approval-heading"><span className="approval-symbol">!</span><h2>需要审批</h2><span>{request.method === 'item/fileChange/requestApproval' ? '文件变更' : '命令执行'}</span></div>
              <p>{request.params.reason ?? 'Codex 请求确认本次操作'}</p>
              {request.method === 'item/commandExecution/requestApproval' && <><pre>{request.params.command ?? '未提供命令内容'}</pre><small className="path">工作目录 · {request.params.cwd}</small></>}
              {request.method === 'item/fileChange/requestApproval' && request.params.grantRoot && <p>此请求涉及写入目录权限：{request.params.grantRoot}</p>}
              <details><summary>原生请求详情</summary><small>request ID：{String(request.id)} · {request.params.itemId}</small><pre>{JSON.stringify(request.params, null, 2)}</pre></details>
              <div className="approval-actions">{(['decline', 'accept'] as const).map(decision => <button className={decision === 'accept' ? 'primary' : ''} key={decision} disabled={!connected || approving || (decision === 'accept' && (!synced || !projectAvailable))} onClick={() => {
                setApproving(true);
                void client.current!.request('bridge/approve', { threadId: selected.current, requestId: request.id, bridgeToken: request.bridgeToken, decision })
                  .then(() => useSession.setState(s => ({ pending: s.pending.filter(p => p.id !== request.id) })))
                  .catch(report).finally(() => setApproving(false));
              }}>{decision === 'accept' ? '允许本次' : '拒绝'}</button>)}</div>
            </article>)}
          </section>
          {session.thread && <details className="session-details"><summary>会话信息与原生事件</summary><div className="session-meta"><span data-testid="thread-id">{session.thread.id}</span><span data-testid="last-turn-status">{lastTurn?.status}</span><span>最近查询配置：{session.thread.model ?? '未知'} / {session.thread.reasoningEffort ?? '未指定'}</span></div>
            {!!session.receipts.length && <details className="events"><summary>最近发送回执</summary>{session.receipts.map(receipt => <p key={receipt.operationId} data-testid="send-receipt" data-operation-id={receipt.operationId}>{{ unknown: '结果未知 · 禁止重发', accepted: 'Harness 已接收 · 待确认终态', rejected: '发送明确被拒绝', completed: '原生已确认完成', failed: '原生已确认失败', interrupted: '原生已确认中断' }[receipt.status]}<small> · {receipt.turnId ?? '尚无已确认的轮次 ID'}</small></p>)}</details>}
            <details className="events"><summary>原生事件 · 最近 {session.events.length} 条</summary><pre>{session.events.join('\n')}</pre></details>
          </details>}
          {!session.thread && <span className="sr-only" data-testid="thread-id">尚未选择会话</span>}
        </div>
      </div>
      <div className="jump-latest-slot">{!atBottom && <button className="jump-latest" onClick={() => { follow.current = true; scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }); }}><Icon name="arrowDown" size={14}/>返回最新{session.pending.length ? ' · 待审批' : ''}</button>}</div>
      <form className={`composer ${expanded ? 'expanded' : ''}`} onSubmit={event => { event.preventDefault(); void send(); }}>
        <div className="composer-input"><label className="sr-only" htmlFor="message">消息</label><textarea ref={composer} id="message" enterKeyHint="enter" onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} value={text} onChange={event => writeDraft(event.target.value)} placeholder="向 Codex 描述你的目标…" maxLength={16000} rows={2} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); void send(); } }}/><button className="icon-button expand-composer" type="button" aria-label={expanded ? '收起输入框' : '展开输入框'} title="展开输入框" onClick={() => setExpanded(value => !value)}><Icon name="expand" size={15}/></button></div>
        <div className="composer-toolbar"><div className="model-controls"><label><span className="sr-only">模型</span><select aria-label="模型" title="下一轮模型" value={model} onChange={event => { setModel(event.target.value); setEffort(''); }}><option value="">继承 · {session.thread?.model ?? config?.model ?? 'Codex 默认'}</option>{models.map(m => <option key={m.id} value={m.model}>{m.displayName}</option>)}</select></label><label><span className="sr-only">思考强度</span><select aria-label="思考强度" title="下一轮思考强度" value={effort} onChange={event => setEffort(event.target.value)}><option value="">继承 · {session.thread?.reasoningEffort ?? config?.effort ?? '默认'}</option>{(models.find(m => m.model === (model || session.thread?.model || config?.model))?.supportedReasoningEfforts ?? []).map(e => <option key={e.reasoningEffort}>{e.reasoningEffort}</option>)}</select></label></div>
          <div className="composer-actions theme-protected">{active && <button type="button" className="stop-button" disabled={!connected || !session.activeTurn} onClick={() => void client.current!.request('turn/interrupt', { threadId: selected.current, turnId: session.activeTurn }).catch(report)}><Icon name="stop" size={15}/>停止</button>}<button className="primary send-button" title="发送 · Ctrl+Enter" aria-label="发送" disabled={!canSend}><Icon name="send"/></button></div>
        </div>
        <div className="composer-caption"><span>{model || effort ? '下一轮使用所选模型 / 思考强度' : '继承 Codex 原生会话设置'}</span><span>Ctrl Enter 发送 · Enter 换行</span></div>
      </form>
    </section>
    {layout.inspector && <section data-theme-slot="inspector" className="inspector" inert={browsing || settings || (mobile && drawer)} aria-label={inspected?.kind === 'item' ? '工具详情面板' : '文件 Diff 面板'}>
      <ResizeHandle side="inspector" value={layout.inspectorWidth} onChange={inspectorWidth => setLayout(l => ({ ...l, inspectorWidth }))}/>
      <header className="inspector-header"><button className="icon-button mobile-detail-back" aria-label="返回会话" onClick={() => setLayout(l => ({ ...l, inspector: false }))}><Icon name="back"/></button><div className="inspector-tabs"><button className={inspected?.kind !== 'item' ? 'active' : ''} onClick={() => { if (files[0]) openDiff(files[0].path, files[0].diff); else setInspected(undefined); }}><Icon name="file" size={15}/>Diff</button><button className={inspected?.kind === 'item' ? 'active' : ''} disabled={!tools.length} onClick={() => { const view = tools.at(-1)!; openItem(view.item, view.turnId); }}><Icon name="terminal" size={15}/>输出</button></div><button className="icon-button" aria-label="关闭面板" title="关闭面板" onClick={() => setLayout(l => ({ ...l, inspector: false }))}><Icon name="close"/></button></header>
      <div className="inspector-scroll">
        {inspected?.kind === 'diff' ? <><div className="inspector-file"><Icon name="file"/><h2 title={inspected.path}>{displayPath(inspected.path, session.thread?.cwd)}</h2></div><small className="inspector-caption">Codex 原生差异 · 只读</small><Suspense fallback={<p>正在加载 Diff…</p>}><Diff text={inspected.diff} label={`Diff ${inspected.path}`}/></Suspense></> : inspectedItem ? <><div className="inspector-file"><Icon name="terminal"/><h2>{inspectedItem.type === 'commandExecution' ? '命令输出' : '工具详情'}</h2></div><ItemDetail item={inspectedItem}/></> : <div className="inspector-empty"><Icon name="file" size={28}/><h2>在此查看执行细节</h2><p>点击对话中的文件变更或工具记录，查看真实 Diff 与输出。</p></div>}
        {!!files.length && <details className="inspector-list" open><summary>变更文件 <span>{files.length}</span></summary>{files.map((file, index) => <button key={`${file.path}:${index}`} onClick={() => openDiff(file.path, file.diff)} className={inspected?.kind === 'diff' && inspected.path === file.path ? 'selected' : ''}><Icon name="file" size={14}/><span title={file.path}>{displayPath(file.path, session.thread?.cwd)}</span></button>)}</details>}
        {!!tools.length && <details className="inspector-list"><summary>工具记录 <span>{tools.length}</span></summary>{tools.map(view => <button key={`${view.turnId}:${view.item.id}`} onClick={() => openItem(view.item, view.turnId)}><Icon name="terminal" size={14}/><span>{view.item.type === 'commandExecution' ? view.item.command : view.item.type}</span></button>)}</details>}
      </div>
      <footer className="mobile-detail-footer"><button onClick={() => setLayout(l => ({ ...l, inspector: false }))}><Icon name="back"/>返回会话</button></footer>
    </section>}
    {browsing && client.current && <ProjectBrowser client={client.current} projects={projects} onRefresh={refreshProjects} onSelect={selectProject} onClose={() => setBrowsing(false)}/>}
    <dialog ref={dialog} className="settings-dialog app-settings theme-protected" aria-label="设置" onCancel={() => setSettings(false)} onClick={event => { if (event.target === event.currentTarget) setSettings(false); }}><div className="settings-content">
      <header><div><OracleEye/><h2>设置</h2></div><button className="icon-button" aria-label="关闭设置" onClick={() => setSettings(false)}><Icon name="close"/></button></header>
      <h3>模型与推理</h3><p>选项来自 Codex 实时目录，仅用于新会话或下一轮，不修改全局配置。</p>
      <div className="settings-model-options" role="group" aria-label="下一轮模型">
        <button aria-pressed={!model} onClick={() => { setModel(''); setEffort(''); }}>继承 Codex 默认<small>{session.thread?.model ?? config?.model ?? '官方默认'}</small></button>
        {models.map(m => <button key={m.id} aria-pressed={model === m.model} onClick={() => { setModel(m.model); setEffort(''); }}>{m.displayName}</button>)}
      </div>
      <h3>思考强度</h3><div className="settings-effort-options" role="group" aria-label="下一轮思考强度"><button aria-pressed={!effort} onClick={() => setEffort('')}>继承</button>{(models.find(m => m.model === (model || session.thread?.model || config?.model))?.supportedReasoningEfforts ?? []).map(e => <button key={e.reasoningEffort} aria-pressed={effort === e.reasoningEffort} onClick={() => setEffort(e.reasoningEffort)}>{e.reasoningEffort}</button>)}</div>
      <ThemeSettings theme={theme} open={settings}/>
      <h3>界面与阅读</h3><label className="reading-size">正文大小 <span>{readingSize}%</span><input aria-label="正文大小" type="range" min="100" max="150" step="10" value={readingSize} onChange={event => setReadingSize(Number(event.target.value))}/></label>
      {!mobile && <button onClick={() => setLayout({ navigation: true, inspector: false, navigationWidth: 264, inspectorWidth: 420 })}>恢复面板默认布局</button>}
      <h3>连接</h3><p className="path">{connectionLabel} · {location.origin}{new URL('.', location.href).pathname}</p><button disabled={connecting || sending || approving} onClick={() => void connect().catch(report)}><Icon name="refresh" size={15}/>重新连接</button>
      {androidShell && <a className="server-settings-link" href="oraculum://settings/server"><Icon name="settings"/>服务器地址</a>}
      <h3>工作目录</h3><p className="path">{config?.cwd}</p><p>从导航浏览 Ubuntu 主机文件夹并添加已有项目。</p>
      <p>当前支持文本消息；尚未接入附件上传或完整文件读取。</p>
    </div></dialog>
  </main>;
}
createRoot(document.getElementById('root')!).render(<SessionGate><App/></SessionGate>);
