import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { DesktopState, Preferences, Theme } from '../contracts/desktop';
import type { WorkspaceAction, WorkspaceState } from '../contracts/workspace';
import type { Preset } from '../../../../packages/gateway-protocol/src/index';
import { BrandIcon, Icon } from './Icon';
import { useWorkspace, canWrite, canWriteScope, canSendFirstTurn, canControlTurn, canUseCapability, hasPendingOperation, draftKey, getDraft, connectionLabels } from './store';
import { record, string } from './Native';
import { Conversation } from './Conversation';
import { DEFAULT_LAYOUT, composingKey, panelWidths, sendShortcut } from './desktop-interaction';
import { WorkspaceInspector, type InspectorPanel } from './Inspector';

type View = 'connect' | 'workspace' | 'projects';
type Act = (action: WorkspaceAction) => Promise<WorkspaceState | undefined>;
const themes: { value: Theme; label: string }[] = [{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'oled', label: 'OLED Dark' }];
const panels: { value: InspectorPanel; label: string }[] = [{ value: 'diff', label: '变更' }, { value: 'files', label: '文件' }, { value: 'process', label: '执行' }, { value: 'usage', label: '用量' }, { value: 'extensions', label: '扩展' }];
const permissionLabels: Record<string, string> = { 'read-only': '只读', auto: '自动', 'full-access': '完全访问' };

function useCompactWindow() {
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 1099px)').matches);
  useEffect(() => { const media = window.matchMedia('(max-width: 1099px)'); const update = () => setCompact(media.matches); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  return compact;
}

export function App() {
  const [desktop, setDesktop] = useState<DesktopState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<View>('connect');
  const [panel, setPanel] = useState<InspectorPanel>('diff');
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [cacheConfirmation, setCacheConfirmation] = useState(false);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [resize, setResize] = useState<{ side: 'navigation' | 'inspector'; width: number }>();
  const [confirm, setConfirm] = useState<Confirmation & { scope: string }>();
  const compact = useCompactWindow();
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  const cacheScope = useRef('');
  const inspectorClose = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const { workspace: state, pending, error, act, receive, clearError, localStatus, localError, cached, cachedAt, reading, readingReady, setReading, ui, patchUi, clearHistory, retryLocal } = useWorkspace();
  const visible = compact ? overlayOpen : desktop?.preferences.inspectorVisible ?? true;
  const navigationVisible = ui.navigationVisible;
  const modal = !!confirm || cacheConfirmation;
  const widths = panelWidths(viewport, resize?.side === 'navigation' ? resize.width : ui.navigationWidth, resize?.side === 'inspector' ? resize.width : ui.inspectorWidth, navigationVisible, visible, compact);
  const connected = state?.connection.status === 'connected';
  const readDisabled = !connected || pending || !!state?.busy;
  const browseDisabled = pending || !!state?.busy || localStatus === 'loading';
  const writeDisabled = cached || !state || !canWrite(state) || pending;
  const projectWriteDisabled = cached || !state || !canWriteScope(state, 'project') || pending;
  const selectedProject = state?.projects.find(project => project.id === state.projectId);

  useEffect(() => {
    let current = true, stateEvent = false, workspaceEvent = false;
    const bridge = window.oraculumDesktop;
    setLoadError(false);
    if (!bridge) { setLoadError(true); return; }
    const unsubscribe = bridge.onStateChanged(next => {
      stateEvent = true;
      if (!current) return;
      setDesktop(next);
      if (next.appearanceReset) { patchUi(DEFAULT_LAYOUT); setOverlayOpen(false); }
    });
    const workspaceUnsubscribe = bridge.onWorkspaceChanged(next => { workspaceEvent = true; if (current) receive(next); });
    void Promise.all([bridge.getState(), bridge.getWorkspace()]).then(([next, workspace]) => {
      if (!current) return;
      if (!stateEvent) setDesktop(next);
      if (!workspaceEvent) receive(workspace);
      if (next.preferencesRecovered) setNotice('外观设置已恢复为默认值，可以重新选择主题。');
    }).catch(() => { if (current) setLoadError(true); });
    return () => { current = false; unsubscribe(); workspaceUnsubscribe(); };
  }, [attempt, receive, patchUi]);
  useEffect(() => window.oraculumDesktop?.onBeforeClose(() => useWorkspace.getState().flush()), []);
  useLayoutEffect(() => { document.documentElement.dataset.theme = desktop?.preferences.theme ?? 'light'; }, [desktop?.preferences.theme]);
  useEffect(() => { if (connected || cached) setView('workspace'); }, [connected, cached]);
  useEffect(() => { const update = () => setViewport(window.innerWidth); window.addEventListener('resize', update); return () => window.removeEventListener('resize', update); }, []);
  useEffect(() => { setOverlayOpen(false); }, [compact, view]);
  useEffect(() => { if (compact && overlayOpen) inspectorClose.current?.focus(); }, [compact, overlayOpen]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (composingKey(event)) return;
      if (event.key === 'Escape') {
        if (confirm) { setConfirm(undefined); return; }
        if (cacheConfirmation) { setCacheConfirmation(false); return; }
        if (compact && overlayOpen) { event.preventDefault(); closeInspector(); }
      }
      if (modal || compact && overlayOpen) {
        if ((event.ctrlKey || event.metaKey) && ['k', 'n', 'b', 'i'].includes(event.key.toLowerCase())) event.preventDefault();
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'b') { event.preventDefault(); toggleNavigation(); }
      if (event.ctrlKey && event.key.toLowerCase() === 'i') { event.preventDefault(); toggleInspector(); }
      if (event.ctrlKey && event.key.toLowerCase() === 'k') { event.preventDefault(); patchUi({ navigationVisible: true }); requestAnimationFrame(() => searchInput.current?.focus()); }
      if (event.ctrlKey && event.shiftKey && event.code === 'Digit0') { event.preventDefault(); patchUi(DEFAULT_LAYOUT); }
      if (event.ctrlKey && event.key.toLowerCase() === 'n' && state?.projectId && !projectWriteDisabled && canUseCapability(state, 'thread.start')) { event.preventDefault(); void newThread(); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [compact, overlayOpen, confirm, cacheConfirmation, state, projectWriteDisabled, navigationVisible, visible, patchUi]);

  async function updatePreferences(patch: Partial<Preferences>) {
    if (saving || !window.oraculumDesktop) return;
    setSaving(true);
    try { setDesktop(await window.oraculumDesktop.setPreferences(patch)); }
    catch { setNotice('外观设置未能保存，请重试。'); }
    finally { setSaving(false); }
  }
  async function resetAppearance() {
    if (saving || !window.oraculumDesktop) return;
    setSaving(true);
    try { setDesktop(await window.oraculumDesktop.resetAppearance()); patchUi(DEFAULT_LAYOUT); setOverlayOpen(false); setNotice('已恢复默认外观。'); }
    catch { setNotice('外观设置未能恢复，请重试。'); }
    finally { setSaving(false); }
  }
  function closeInspector() { setOverlayOpen(false); requestAnimationFrame(() => inspectorToggle.current?.focus()); }
  function requestConfirmation(value: Confirmation) {
    if (state) setConfirm({ ...value, scope: confirmationScope(state) });
  }
  function dispatchConfirmation() {
    const value = confirm, latest = useWorkspace.getState().workspace;
    setConfirm(undefined);
    if (!value || !latest || value.scope !== confirmationScope(latest)) {
      setNotice('连接、项目或会话已变化。原确认已失效，请重新查看操作范围。');
      return;
    }
    void act(value.action);
  }
  function toggleNavigation() { patchUi({ navigationVisible: !navigationVisible }); requestAnimationFrame(() => navigationToggle.current?.focus()); }
  function toggleInspector() { if (compact) setOverlayOpen(open => !open); else { void updatePreferences({ inspectorVisible: !visible }); requestAnimationFrame(() => inspectorToggle.current?.focus()); } }
  function choosePanel(next: InspectorPanel) {
    setPanel(next);
    if (readDisabled || !state) return;
    if (next === 'files' && state.projectId && !state.files) void act({ type: 'files' });
    else if ((next === 'usage' && !state.accountUsage) || (next === 'extensions' && !state.extensions)) void act({ type: 'inspector', section: next as 'usage' | 'extensions' });
  }
  async function newThread() {
    if (!state || projectWriteDisabled) return;
    setView('workspace');
    await act({ type: 'startThread' });
  }
  function searchThreads(event?: FormEvent) {
    event?.preventDefault(); if (!state?.projectId || browseDisabled) return;
    void act({ type: 'threads', search: search.trim(), archived });
  }

  if (loadError) return <div className="launch-screen"><BrandIcon size="hero" /><h1>暂时无法打开工作台</h1><p>应用的本机状态未能载入。请重试，或关闭窗口后重新启动 Oraculum。</p><button className="primary-button" onClick={() => setAttempt(value => value + 1)}>重新尝试</button></div>;
  if (!desktop || !state) return <div className="launch-screen" role="status"><BrandIcon size="hero" /><p>正在打开工作台…</p></div>;
  const pendingOperations = state.operations.filter(operation => ['prepared', 'unknown'].includes(operation.status));
  const banner = cached ? `上次可见的内容 · ${connected ? '正在核对，仅供阅读' : '离线只读'}${cachedAt ? ` · ${new Date(cachedAt).toLocaleString()}` : ''}` : state.connection.status !== 'connected' ? connectionLabels[state.connection.status] : !state.threadId ? '已连接 Gateway · 选择项目或会话开始工作' : state.firstTurnReady ? '新会话已准备好 · 可以发送第一条消息' : state.synchronization === 'synchronizing' ? state.activeTurnId ? 'Codex 正在执行 · 可停止、插话或回应当前请求' : state.interactions.some(item => item.status === 'pending') ? '等待回应原生请求 · 历史仍在同步' : '正在核对原生状态 · 暂停新操作' : state.synchronization === 'stale' ? '已加载内容等待核对 · 暂停写入' : hasPendingOperation(state) ? '当前范围有结果待核实的操作 · 不会自动重发' : state.activeTurnId ? 'Codex 正在执行' : '已连接 Gateway · 原生状态已同步';

  return <div className={`app-shell ${visible && !compact ? 'with-inspector' : ''} ${navigationVisible ? '' : 'navigation-collapsed'}`} style={{ '--nav-width': `${widths.navigationWidth}px`, '--inspector-width': `${widths.inspectorWidth}px` } as CSSProperties}>
    <a className="skip-link" href="#main-content" tabIndex={modal || compact && visible ? -1 : undefined} onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>跳到主要内容</a>
    <nav className="navigation flex min-h-0 flex-col" id="navigation" aria-label="项目与会话导航" hidden={!navigationVisible} inert={compact && visible || modal}>
      <div className="brand flex items-center"><BrandIcon /><div><strong>Oraculum</strong><span>神谕 · 你的工作，从这里展开</span></div></div>
      <button className="new-conversation flex items-center" disabled={projectWriteDisabled || !state.projectId || !canUseCapability(state, 'thread.start')} onClick={() => void newThread()}><Icon name="plus" />新建会话<kbd>Ctrl N</kbd></button>
      <form className="search-field flex items-center" onSubmit={searchThreads}><Icon name="search" /><input ref={searchInput} aria-label="搜索会话" placeholder={connected ? "搜索会话 · Enter" : "搜索已保存会话"} value={search} onChange={event => setSearch(event.target.value)} disabled={!state.projectId || browseDisabled} /><kbd>Ctrl K</kbd></form>
      <div className="navigation-scroll">
        <div className="section-label flex items-center justify-between"><span>项目</span><button className="icon-button" aria-label="管理项目" onClick={() => setView('projects')}><Icon name="plus" /></button></div>
        {state.projects.length ? <label className="project-picker"><span className="sr-only">当前项目</span><select aria-label="当前项目" value={state.projectId ?? ''} disabled={browseDisabled} onChange={event => { setSearch(''); setArchived(false); setView('workspace'); void act({ type: 'selectProject', projectId: event.target.value }); }}><option value="" disabled>选择项目</option>{state.projects.map(project => <option key={project.id} value={project.id} disabled={connected && !project.available}>{project.name}{!project.available ? ' · 不可用' : ''}</option>)}</select></label> : <div className="navigation-empty"><Icon name="folder" /><b>还没有项目</b><p>{connected ? '打开项目管理，从授权目录注册项目。' : '连接后，项目与会话会显示在这里。'}</p></div>}
        <div className="section-label thread-filter"><span>会话</span><label><input type="checkbox" checked={archived} disabled={browseDisabled || !state.projectId} onChange={event => { setArchived(event.target.checked); void act({ type: 'threads', search: search.trim(), archived: event.target.checked }); }} />已归档</label><button className="icon-button" disabled={readDisabled || !state.projectId} aria-label="刷新会话" onClick={() => searchThreads()}><Icon name="refresh" /></button></div>
        {(state.threads?.threads ?? []).map(thread => <button key={thread.id} className={`thread flex items-center ${state.threadId === thread.id ? 'selected' : ''}`} disabled={browseDisabled} aria-current={state.threadId === thread.id ? 'page' : undefined} onClick={() => { setView('workspace'); void act({ type: 'selectThread', threadId: thread.id }); }}><span className={state.threadId === thread.id ? 'thread-marker' : 'thread-icon'}>{state.threadId !== thread.id && <Icon name="chat" />}</span><span><b>{thread.title || thread.preview || '未命名会话'}</b><small>{connected && !cached ? thread.status : '上次可见'}{thread.archived ? ' · 已归档' : ''}</small></span></button>)}
        {state.projectId && !state.threads?.threads.length && <p className="empty-search">{localStatus === 'loading' ? '正在恢复本地记录…' : !connected ? '没有已保存的匹配会话' : '没有匹配的会话'}</p>}
        {state.threads?.nextCursor && <button className="text-button load-more" disabled={readDisabled} onClick={() => void act({ type: 'threads', more: true, search: search.trim(), archived })}>加载更多会话</button>}
        {state.threads?.truncated && <p className="navigation-unavailable">会话目录尚不完整。</p>}
      </div>
      <div className="navigation-footer">
        <button className={`settings-link flex items-center ${view === 'connect' ? 'selected' : ''}`} onClick={() => setView('connect')}><Icon name="settings" /><span>连接与外观</span><Icon name="chevron" /></button>
        <div className="theme-control flex" role="group" aria-label="外观主题" aria-busy={saving}>{themes.map(theme => <button key={theme.value} aria-pressed={desktop.preferences.theme === theme.value} disabled={saving} onClick={() => void updatePreferences({ theme: theme.value })}>{theme.label}</button>)}</div>
        <div className="connection-summary flex items-center"><span className={`status-dot ${connected ? '' : 'offline'}`} /><span>{connectionLabels[state.connection.status]}</span><span className="version-label">{desktop.profile === 'development' ? '开发 Profile' : '2.0'}</span></div>
      </div>
    </nav>
    <main className="conversation flex min-h-0 flex-col" id="main-content" tabIndex={-1} inert={compact && visible || modal}>
      <header className="conversation-header flex items-center justify-between"><button ref={navigationToggle} className={`icon-button navigation-toggle ${navigationVisible ? 'active' : ''}`} aria-label={navigationVisible ? '收起导航' : '展开导航'} title="导航 · Ctrl B" aria-controls="navigation" aria-expanded={navigationVisible} onClick={toggleNavigation}><Icon name="panel" /></button><div className="breadcrumb flex items-center"><Icon name="folder" /><span>{selectedProject?.name ?? 'Oraculum'}</span><span>/</span><b>{view === 'connect' ? '连接与外观' : view === 'projects' ? '项目管理' : state.thread?.title || state.thread?.preview || '工作台'}</b></div><div className="header-actions">
        {view === 'workspace' && state.threadId && <ThreadActions state={state} disabled={writeDisabled} pending={pending} act={act} confirm={requestConfirmation} />}
        <button ref={inspectorToggle} className={`icon-button ${visible ? 'active' : ''}`} onClick={toggleInspector} title="Inspector · Ctrl I" aria-label={visible ? '收起 Inspector' : '展开 Inspector'} aria-expanded={visible} aria-controls="inspector" disabled={saving && !compact}><Icon name="panel" /></button></div></header>
      <div className="connection-banner flex items-center" role="status"><Icon name={connected ? 'shield' : 'offline'} /><span>{banner}</span><button className="text-button banner-action" disabled={pending || state.busy || !state.connection.endpoint || state.connection.status === 'pairing'} onClick={() => void act({ type: connected ? 'refresh' : 'reconnect' })}>{connected ? '刷新状态' : '重新连接'}</button></div>
      {(notice || error || state.notice) && <div className={`notice flex items-center ${error ? 'notice-error' : ''}`} role={error ? 'alert' : 'status'}><span>{notice || error || humanNotice(state.notice)}</span>{(notice || error) && <button className="icon-button" aria-label="关闭提示" onClick={() => { setNotice(''); clearError(); }}><Icon name="close" /></button>}</div>}
      {!!localError && <div className="notice notice-error local-storage-notice" role="alert"><span>{localError}</span><button className="text-button" onClick={() => void retryLocal()}>重试保存</button></div>}
      {!!pendingOperations.length && <details className="operation-banner"><summary>有 {pendingOperations.length} 项操作等待核实</summary><p>原操作标识已保留。核实结果不会重新发送请求，404 也不代表未执行。</p><ul>{pendingOperations.map(operation => <li key={operation.operationId}><b>{operation.kind}</b> · {operation.status === 'prepared' ? '已记录，发送结果待核实' : '结果未知'} <code>{operation.operationId}</code></li>)}</ul><button className="quiet-button" disabled={readDisabled} onClick={() => void act({ type: 'reconcile' })}>核实原操作</button></details>}
      <div ref={scroll} className="conversation-scroll" aria-label={view === 'workspace' ? '会话内容' : view === 'projects' ? '项目管理' : '连接与外观设置'}>
        {view === 'connect' ? <ConnectionView state={state} profile={desktop.profile} pending={pending || state.busy} act={act} saving={saving} onReset={() => void resetAppearance()} onWorkspace={() => setView('workspace')} confirm={requestConfirmation} onClearHistory={() => { cacheScope.current = confirmationScope(state); setCacheConfirmation(true); }} />
          : view === 'projects' ? <ProjectsView state={state} act={act} onSelected={() => setView('workspace')} readDisabled={readDisabled} browseDisabled={browseDisabled} writeDisabled={cached || !canWriteScope(state, 'identity') || pending} confirm={requestConfirmation} />
            : state.threadId ? <Conversation state={state} act={act} disabled={readDisabled || cached} scrollRef={scroll} scopeKey={draftKey(state)} readingReady={readingReady} readingPosition={reading} onReadingPositionChange={setReading} />
              : <div className="conversation-inner"><div className="conversation-welcome"><BrandIcon size="hero" /><h1>{state.projectId ? selectedProject?.name : '你的工作，从这里展开。'}</h1><p>{state.projectId ? connected ? '选择已有会话，或创建一个新会话。' : '选择已保存的会话，继续阅读和整理草稿。' : connected ? '从左侧选择项目，或在授权目录中注册项目。' : '连接 Gateway 后，你访问过的会话会保存在这台电脑。'}</p><button className="quiet-button" onClick={() => setView('projects')}>管理项目</button></div></div>}
      </div>
      {view === 'workspace' && state.threadId && <Composer state={state} act={act} pending={pending} />}
    </main>
    {compact && visible && <button className="inspector-scrim" aria-label="关闭 Inspector" tabIndex={-1} onClick={closeInspector} />}
    {visible && <aside className={`inspector flex min-h-0 flex-col ${compact ? 'inspector-overlay' : ''}`} id="inspector" role={compact ? 'dialog' : undefined} aria-modal={compact ? true : undefined} aria-label="Inspector" tabIndex={-1} inert={modal} onKeyDown={event => {
      if (!compact || event.key !== 'Tab') return;
      const stops = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')].filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0 && !element.closest('[inert]'));
      if (!stops.length) { event.preventDefault(); event.currentTarget.focus(); return; }
      const first = stops[0], last = stops[stops.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}><header className="inspector-header flex items-center justify-between"><b>Inspector</b><span>{state.threadId ? '当前会话' : '工作区'}</span>{compact && <button ref={inspectorClose} className="icon-button" aria-label="收起 Inspector" onClick={closeInspector}><Icon name="close" /></button>}</header>
      <div className="inspector-tabs flex" role="tablist" aria-label="Inspector 分类">{panels.map(item => <button key={item.value} role="tab" id={`tab-${item.value}`} aria-controls="inspector-content" aria-selected={panel === item.value} tabIndex={panel === item.value ? 0 : -1} onClick={() => choosePanel(item.value)} onKeyDown={event => { if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const index = panels.findIndex(entry => entry.value === panel); const next = event.key === 'Home' ? 0 : event.key === 'End' ? panels.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + panels.length) % panels.length; choosePanel(panels[next].value); document.getElementById(`tab-${panels[next].value}`)?.focus(); }}>{item.label}</button>)}</div>
      <div className="inspector-scroll" role="tabpanel" id="inspector-content" aria-labelledby={`tab-${panel}`} tabIndex={0}><WorkspaceInspector state={state} act={act} disabled={readDisabled || cached} panel={panel} /></div>
      <div className="inspector-footnote">{cached || state.connection.status !== 'connected' || state.synchronization === 'stale' ? '上次可见的内容 · 等待同步' : state.lastKnownInspector ? '部分执行信息为上次记录，当前连接无法补读。' : '数据来自当前授权 Gateway / Codex'}</div>
    </aside>}
    {navigationVisible && !modal && !(compact && visible) && <PanelResize side="navigation" value={widths.navigationWidth} onPreview={width => setResize({ side: 'navigation', width })} onCommit={width => { patchUi({ navigationWidth: width }); setResize(undefined); }} />}
    {visible && !compact && !modal && <PanelResize side="inspector" value={widths.inspectorWidth} onPreview={width => setResize({ side: 'inspector', width })} onCommit={width => { patchUi({ inspectorWidth: width }); setResize(undefined); }} />}
    {cacheConfirmation && <ConfirmDialog title="清除这台电脑保存的历史？" text="已保存的会话内容和阅读位置将被移除，下次连接后可以重新加载。草稿、设备身份和操作记录会保留。" busy={localStatus === 'loading'} onCancel={() => setCacheConfirmation(false)} onConfirm={() => { setCacheConfirmation(false); const latest = useWorkspace.getState().workspace; if (latest && cacheScope.current === confirmationScope(latest)) void clearHistory(); else setNotice('当前连接或会话已变化，请重新确认需要清理的本地历史。'); }} />}
    {confirm && <ConfirmDialog title={confirm.title} text={confirm.text} busy={pending || state.busy} onCancel={() => setConfirm(undefined)} onConfirm={dispatchConfirmation} />}
  </div>;
}

function humanNotice(notice?: string) {
  if (!notice) return '';
  const known: Record<string, string> = {
    GATEWAY_ACCEPTED: 'Gateway 已接受请求；执行完成以原生会话状态为准。',
    OPERATION_UNKNOWN: '操作结果待核实。已保留原操作标识，请核实后继续。',
    UNKNOWN_OPERATION: '操作结果待核实，请核实原操作后继续。',
    NEW_THREAD_READY: '新会话已创建，可以发送第一条消息。',
    NATIVE_UNAVAILABLE: 'Codex 暂时不可用，已加载内容仍可阅读。',
    AUTH_REVOKED: '设备信任已撤销，请重新配对。', DEVICE_REVOKED: '设备信任已撤销，请重新配对。',
    UNAUTHENTICATED: '设备身份已失效，请重新连接或配对。',
    AUTHENTICATION_REQUIRED: '请先完成设备配对。', PAIRING_REQUIRED: '请输入 Gateway 的一次性配对码。',
    PAIR_INPUT_INVALID: '配对信息格式不正确，请检查配对码与设备名称。',
    PAIRING_CODE_INVALID: '配对码无效或已过期，请获取新的配对码。',
    CAPABILITY_UNAVAILABLE: '当前 Gateway 或 Codex 未提供此能力。',
    SECURE_STORAGE_UNAVAILABLE: '系统安全存储不可用，无法安全保存设备身份。',
    KEYRING_UNAVAILABLE: '系统密钥服务不可用，请解锁系统钥匙环后重试。',
    JOURNAL_UNAVAILABLE: '操作记录无法安全读取，写入已停止。请保留当前 Profile 并检查本机存储。',
    JOURNAL_SCOPE_PENDING: '当前操作范围存在未决记录，请先核实原操作。',
    JOURNAL_FULL: '操作记录已达到容量限制。请先处理未决操作。',
    STATE_NOT_CURRENT: '会话状态尚未核对，请刷新状态后继续。',
    STALE_EPOCH: 'Gateway 运行代次已变化，正在重新核对状态。',
    INTERACTION_STALE: '该原生交互已更新或已被处理，请查看最新状态。',
    INTERACTION_RESPONSE_INVALID: '当前回应与原生请求不匹配，未提交回应。',
    FILE_CHANGE_ACCEPT_UNAVAILABLE: '缺少完整、匹配的变更审批证据，当前不能允许该请求。',
    FILE_CHANGE_CONTEXT_STALE: '文件变更证据已更新或失效，请查看最新完整差异后再回应。',
    CONNECTION_NOT_READY: '连接尚未准备好，请等待同步完成。',
    ENDPOINT_INVALID: 'Gateway 地址格式不正确。请使用明确的本机 HTTP 地址，或 HTTPS 地址。',
    INSECURE_ENDPOINT: '远程地址必须使用 HTTPS；明文 HTTP 仅允许明确的本机 loopback 地址。',
    CREDENTIAL_PROTECTION_UNAVAILABLE: '系统安全存储无法提供要求的保护，设备凭据未保存。',
    CREDENTIAL_BINDING_MISMATCH: '设备凭据与当前 Gateway 不匹配，请检查地址或重新配对。',
    NOT_CONNECTED: '连接已断开，已加载内容和草稿仍保留。',
    CONNECTION_FAILED: '无法连接 Gateway，请检查地址与服务可用性。',
    REQUEST_TIMEOUT: '请求超时。若涉及写入，请先核实原操作。',
    PROTOCOL_INCOMPATIBLE: 'Gateway 协议版本与此客户端不兼容。',
    REDIRECT_REJECTED: 'Gateway 返回了重定向，连接已拒绝。请使用服务的实际入口地址。',
    HANDSHAKE_INVALID: 'Gateway 握手数据不符合协议，连接已停止。',
    IDENTITY_MISMATCH: 'Gateway 身份与保存的设备信任不匹配，连接已停止。',
    RESPONSE_IDENTITY_MISMATCH: '响应身份与当前 Gateway 不符，操作已停止。',
    RESPONSE_INVALID: 'Gateway 返回的数据无法安全解析。',
    RESPONSE_TOO_LARGE: '返回内容超过客户端接收上限。',
    ACTION_IN_PROGRESS: '另一个操作仍在处理中。',
    ACTIVE_TURN_CHANGED: '当前执行已变化，请查看更新后的会话。',
    ACTIVE_TURN_REQUIRED: '当前没有可停止或插话的执行。',
    TURN_ACTIVE: 'Codex 仍在执行，请等待完成或先停止。',
    PROJECT_REQUIRED: '请先选择项目。', THREAD_REQUIRED: '请先选择或创建会话。',
    PROJECT_UNAVAILABLE: '当前项目不可访问，请刷新项目列表。',
    MODEL_UNAVAILABLE: '所选模型已不可用，请重新选择。', EFFORT_UNAVAILABLE: '所选模型不支持此思考强度。',
    ATTACHMENT_NOT_READY: '附件尚未就绪，请核实附件状态。',
    ATTACHMENT_BATCH_LIMIT: '附件数量或总大小超过 Gateway 限额。',
    ATTACHMENT_SIZE_OR_TYPE: '所选文件大小或类型不受支持。',
    ATTACHMENT_TYPE_UNSUPPORTED: '此文件类型不能作为附件上传。',
    LOCAL_FILE_CHANGED: '选择的本机文件发生了变化，请重新选择。',
    FILE_DIGEST_MISMATCH: '文件摘要校验失败，未保存该文件。',
    DETAIL_INTEGRITY_FAILED: '原生详情完整性校验失败，未显示不可信内容。',
    DETAIL_CURSOR_INVALID: '详情分页已失效，请重新载入详情。',
    DOWNLOAD_DESTINATION_EXISTS: '目标文件已存在，未覆盖原文件。请另选保存位置。',
    DOWNLOAD_SAVED: '文件已保存到你选择的位置。',
    USAGE_PARTIALLY_UNAVAILABLE: '已载入可获取的用量；部分账户能力当前不可用。',
    SCOPE_CHANGED: '当前项目或会话已变化，操作已停止。',
    CONNECTION_CHANGED: '连接已变化，请在最新连接状态下重新操作。',
    DESKTOP_OPERATION_FAILED: '操作未能完成。请查看连接与操作记录；结果不明时先核实原操作。',
  };
  return known[notice] ?? (/^[A-Z][A-Z0-9_]+$/.test(notice) ? `操作暂不可用（${notice}）。请查看连接和操作记录。` : notice);
}

type Confirmation = { title: string; text: string; action: WorkspaceAction };
export function confirmationScope(state: WorkspaceState): string {
  return JSON.stringify([state.connection.endpoint, state.connection.installationId, state.connection.deviceId,
    state.connection.epoch, state.projectId, state.threadId]);
}
function ConnectionView({ state, profile, pending, act, saving, onReset, onWorkspace, confirm, onClearHistory }: { state: WorkspaceState; profile: DesktopState['profile']; pending: boolean; act: Act; saving: boolean; onReset: () => void; onWorkspace: () => void; confirm: (value: Confirmation) => void; onClearHistory: () => void }) {
  const [endpoint, setEndpoint] = useState(state.connection.endpoint);
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('Oraculum Desktop');
  useEffect(() => { setEndpoint(state.connection.endpoint); setCode(''); }, [state.connection.endpoint]);
  const connected = state.connection.status === 'connected';
  return <section className="connect-content"><BrandIcon size="hero" /><div className="connect-eyebrow">YOUR OWN WORKSPACE</div><h1>把神谕连接到<br />你的工作台。</h1><p>通过已有 Gateway，安全访问你的项目和原生 Codex 会话。</p>
    <form onSubmit={event => { event.preventDefault(); setCode(''); void act({ type: 'connect', endpoint: endpoint.trim() }); }}><label className="form-label" htmlFor="gateway-address">Gateway 地址</label><input className="form-input" id="gateway-address" type="url" required value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="http://127.0.0.1:端口/" disabled={pending} autoComplete="off" spellCheck={false} /><p className="form-help">支持本机 loopback HTTP / WS 与可配置的 HTTPS / WSS。地址可以包含部署 Base Path。</p><button className="primary-button" disabled={pending || !endpoint.trim()}>{pending ? '处理中…' : connected ? '连接此地址' : '连接 Gateway'}</button></form>
    {state.connection.status === 'pairing' && <form className="pairing-form" onSubmit={event => { event.preventDefault(); const value = code; setCode(''); void act({ type: 'pair', code: value.trim(), label: label.trim() }); }}><label className="form-label" htmlFor="device-label">设备名称</label><input className="form-input" id="device-label" value={label} maxLength={80} onChange={event => setLabel(event.target.value)} autoComplete="off" /><label className="form-label" htmlFor="pairing-code">一次性配对码</label><input className="form-input" id="pairing-code" value={code} type="password" maxLength={128} onChange={event => setCode(event.target.value)} autoComplete="off" spellCheck={false} /><p className="form-help">在 Gateway 主机使用正规 CLI 获取配对码。设备身份由主进程和系统安全存储管理。</p><button className="primary-button" disabled={pending || !code.trim() || !label.trim()}>确认配对</button></form>}
    <dl className="detail-list connection-details"><div><dt>连接状态</dt><dd>{connectionLabels[state.connection.status]}</dd></div><div><dt>本机 Profile</dt><dd>{profile === 'development' ? '独立开发 Profile' : '正式 Profile'}</dd></div><div><dt>系统安全存储</dt><dd>{state.connection.secureStorage ? '可用' : '尚不可用'}</dd></div>{state.capabilities && <><div><dt>Gateway</dt><dd>{state.capabilities.gatewayVersion}</dd></div><div><dt>协议</dt><dd>{state.capabilities.protocol.major}.{state.capabilities.protocol.minor}</dd></div><div><dt>Codex</dt><dd>{state.capabilities.codex.connectionState}</dd></div></>}</dl>
    {state.capabilities && <details className="capability-list"><summary>当前能力与验证状态</summary><p className="inspector-note">“尚未验证”表示接口存在，实际可用性以原生操作结果为准。</p><dl className="detail-list">{state.capabilities.capabilities.map(capability => <div key={capability.name}><dt>{capability.name}</dt><dd>{!capability.supported || capability.availability === 'unsupported' ? '尚不支持' : capability.availability === 'unavailable' ? '当前不可用' : capability.verified ? '已观察可用' : '尚未验证'}</dd></div>)}</dl></details>}
    {state.connection.errorCode && <p className="unavailable-note" role="alert">{humanNotice(state.connection.errorCode)}</p>}
    {(connected || state.projects.length > 0) && <div className="connect-footer flex items-center"><button className="quiet-button" onClick={onWorkspace}>返回工作台</button>{connected && <><button className="text-button" disabled={pending} onClick={() => void act({ type: 'disconnect' })}>断开连接</button><button className="text-button danger-text" disabled={pending} onClick={() => confirm({ title: '撤销这台设备的信任？', text: '仅退出当前 Desktop 设备。再次使用需要重新配对；未决操作记录会保留。', action: { type: 'logout' } })}>退出设备</button></>}</div>}
    <div className="appearance-section"><div className="section-eyebrow">你的工作台，留在本机</div><p>主题、面板宽度和每个会话的草稿都会留在这台电脑。断开连接后，仍可阅读已保存的内容和编辑草稿。</p><button className="text-button" onClick={onReset} disabled={saving}><Icon name="refresh" />恢复默认外观</button><div className="recovery-hint"><kbd>Ctrl Shift 0</kbd> 恢复主题与布局，保留草稿和操作记录</div></div>
    <div className="appearance-section local-data-section"><div className="section-eyebrow">离线阅读</div><p>本地历史记录可以重新加载。清理历史不会删除未发送草稿、设备信任或待核实操作。</p><button className="quiet-button" onClick={onClearHistory}>清除本地历史</button></div>
    <details className="keyboard-help"><summary>键盘快捷键</summary><dl><div><dt>搜索会话</dt><dd><kbd>Ctrl K</kbd></dd></div><div><dt>新建会话</dt><dd><kbd>Ctrl N</kbd></dd></div><div><dt>展开或收起导航</dt><dd><kbd>Ctrl B</kbd></dd></div><div><dt>展开或收起 Inspector</dt><dd><kbd>Ctrl I</kbd></dd></div><div><dt>发送消息 / 补充指令</dt><dd><kbd>Ctrl Enter</kbd></dd></div><div><dt>调整面板宽度</dt><dd>聚焦分隔线后按 <kbd>←</kbd> <kbd>→</kbd></dd></div><div><dt>关闭面板或菜单</dt><dd><kbd>Esc</kbd></dd></div></dl></details>
  </section>;
}

function ProjectsView({ state, act, onSelected, readDisabled, browseDisabled, writeDisabled, confirm }: { state: WorkspaceState; act: Act; onSelected: () => void; readDisabled: boolean; browseDisabled: boolean; writeDisabled: boolean; confirm: (value: Confirmation) => void }) {
  const page = state.directories;
  const parent = page?.path.split('/').slice(0, -1).join('/') ?? '';
  return <section className="connect-content projects-content"><div className="connect-eyebrow">PROJECTS</div><h1>你的项目</h1><p>从 Gateway 已授权的根目录浏览和注册。移除注册不会删除项目文件。</p>
    {state.projects.map(project => <div className="registered-project" key={project.id}><span className="project-initial">{project.name.slice(0, 1)}</span><div><b>{project.name}</b><small>{state.connection.status !== 'connected' ? '本机记录' : project.available ? '可用' : '当前不可访问'}</small></div><button className="quiet-button" disabled={browseDisabled || state.connection.status === 'connected' && !project.available} onClick={() => { onSelected(); void act({ type: 'selectProject', projectId: project.id }); }}>选择</button><button className="text-button" disabled={readDisabled || !canWriteScope({ ...state, projectId: project.id }, 'project')} onClick={() => confirm({ title: `移除 ${project.name} 的注册？`, text: '此操作移除 Gateway 项目注册；不会删除磁盘目录或 Codex 历史。', action: { type: 'unregisterProject', projectId: project.id, confirm: true } })}>移除</button></div>)}
    <h2 className="project-browser-heading">浏览授权目录</h2><div className="root-list">{state.roots.map(root => <button className="quiet-button" key={root.id} disabled={readDisabled} onClick={() => void act({ type: 'directories', rootId: root.id })}><Icon name="folder" />{root.label}</button>)}</div>
    {!state.roots.length && <p className="unavailable-note">连接后显示 Gateway 的授权根目录。</p>}
    {page && <div className="directory-browser"><div className="directory-toolbar"><code>{state.roots.find(root => root.id === page.rootId)?.label} / {page.path || '.'}</code>{page.path && <button className="text-button" disabled={readDisabled} onClick={() => void act({ type: 'directories', rootId: page.rootId, path: parent })}>上一级</button>}</div>{page.entries.map(entry => <button className="directory-entry" key={entry.path} disabled={readDisabled} onClick={() => void act({ type: 'directories', rootId: page.rootId, path: entry.path })}><Icon name="folder" />{entry.name}<Icon name="chevron" /></button>)}{!page.entries.length && <p className="inspector-note">此目录没有可浏览的子目录。</p>}{page.nextCursor && <button className="text-button" disabled={readDisabled} onClick={() => void act({ type: 'directories', rootId: page.rootId, path: page.path, cursor: page.nextCursor! })}>下一页目录</button>}{page.limited && <p className="unavailable-note">目录列表受限，尚未完整载入。</p>}<button className="primary-button" disabled={writeDisabled || !page.canRegister} onClick={() => void act({ type: 'registerProject', rootId: page.rootId, path: page.path })}>注册当前目录</button>{!page.canRegister && <p className="inspector-note">Gateway 不允许注册此目录。</p>}</div>}
  </section>;
}

export function ThreadActions({ state, disabled, pending, act, confirm }: { state: WorkspaceState; disabled: boolean; pending: boolean; act: Act; confirm: (value: Confirmation) => void }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const cached = useWorkspace(value => value.cached);
  const [name, setName] = useState(state.thread?.title ?? '');
  const [beforeTurnId, setBeforeTurnId] = useState('');
  useEffect(() => { setName(state.thread?.title ?? ''); setBeforeTurnId(''); }, [state.threadId, state.thread?.title]);
  const scope = confirmationScope(state);
  useEffect(() => { if (menu.current) menu.current.open = false; }, [scope]);
  useEffect(() => {
    const close = (event: globalThis.PointerEvent) => { if (menu.current?.open && !menu.current.contains(event.target as Node)) menu.current.open = false; };
    document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close);
  }, []);
  const stopped = !state.activeTurnId && !state.interactions.some(value => value.status !== 'resolved');
  const isDisabled = (capability: string) => disabled || !stopped || !canUseCapability(state, capability);
  const childThread = state.thread?.parentThreadId != null;
  const archiveAction = state.thread?.archived === true ? 'unarchive' : state.thread?.archived === false ? 'archive' : undefined;
  const turns = (state.history?.items ?? []).map(record).filter(value => value && typeof value.id === 'string');
  return <details ref={menu} className="thread-actions" onKeyDown={event => { if (event.key === 'Escape' && !composingKey(event.nativeEvent) && menu.current?.open) { event.preventDefault(); event.stopPropagation(); menu.current.open = false; menu.current.querySelector('summary')?.focus(); } }}><summary aria-label="会话操作">···</summary><div className="thread-action-menu"><b>会话操作</b><form onSubmit={event => { event.preventDefault(); if (name.trim() && !isDisabled('thread.name.set')) void act({ type: 'threadMutation', action: 'name', name: name.trim() }); }}><label htmlFor="thread-name">会话名称</label><input id="thread-name" value={name} maxLength={200} onChange={event => setName(event.target.value)} /><button className="quiet-button" disabled={isDisabled('thread.name.set') || !name.trim()}>保存名称</button></form><button className="text-button" disabled={cached || state.connection.status !== 'connected' || state.busy || pending || hasPendingOperation(state) || state.synchronization === 'synchronizing' || !stopped || !canUseCapability(state, 'thread.resume') || state.thread?.archived} onClick={() => void act({ type: 'resumeThread' })}>恢复原生会话</button><button className="text-button" disabled={isDisabled('thread.fork')} onClick={() => void act({ type: 'threadMutation', action: 'fork' })}>创建会话分支</button><button className="text-button" disabled={isDisabled('thread.compact')} onClick={() => confirm({ title: '压缩当前会话上下文？', text: '由 Codex 原生执行压缩。完成状态将通过当前会话更新。', action: { type: 'threadMutation', action: 'compact' } })}>压缩上下文</button><button className="text-button" disabled={!archiveAction || childThread || isDisabled(`thread.${archiveAction}`)} onClick={() => {
      if (!archiveAction || childThread || isDisabled(`thread.${archiveAction}`)) return;
      confirm({ title: archiveAction === 'unarchive' ? '恢复已归档会话？' : '归档当前会话？', text: archiveAction === 'unarchive' ? '会话将重新出现在未归档列表。' : '会话将移入归档列表，可以再恢复。', action: { type: 'threadMutation', action: archiveAction } });
    }}>{archiveAction === 'unarchive' ? '取消归档' : archiveAction === 'archive' ? '归档会话' : '归档状态未确认'}</button>
      <label htmlFor="revert-target">回退到指定 Turn 之前</label><select id="revert-target" value={beforeTurnId} onChange={event => setBeforeTurnId(event.target.value)}><option value="">选择已加载的 Turn</option>{turns.map((turn, index) => <option key={string(turn?.id)} value={string(turn?.id)}>Turn {index + 1} · {string(turn?.id).slice(0, 12)}</option>)}</select><button className="text-button" disabled={isDisabled('thread.revert') || !beforeTurnId} onClick={() => confirm({ title: '回退原生会话？', text: '将移除选中 Turn 及之后的原生会话内容。工作区文件不会因此自动恢复。', action: { type: 'threadMutation', action: 'revert', beforeTurnId } })}>确认回退范围</button><button className="text-button danger-text" disabled={childThread || isDisabled('thread.delete')} onClick={() => {
        if (childThread || isDisabled('thread.delete')) return;
        confirm({ title: '永久删除此会话？', text: '将通过 Gateway 删除当前原生会话。此操作无法在客户端撤销。', action: { type: 'threadMutation', action: 'delete', confirm: true } });
      }}>删除会话</button>{!archiveAction && <p className="unavailable-note">归档状态尚未核实，请刷新会话列表后再归档或取消归档。</p>}{childThread && <p className="unavailable-note">此会话属于子代理，Gateway 不允许单独归档、取消归档或删除。</p>}{!stopped && <small>运行或交互尚未完成，部分操作暂不可用。</small>}</div></details>;
}

export function Composer({ state, act, pending }: { state: WorkspaceState; act: Act; pending: boolean }) {
  const drafts = useWorkspace(value => value.drafts), setDraft = useWorkspace(value => value.setDraft);
  const recheckDraft = useWorkspace(value => value.recheckDraft);
  const draftStatus = useWorkspace(value => value.draftStatus), sendDraft = useWorkspace(value => value.sendDraft), cached = useWorkspace(value => value.cached);
  const composing = useRef(false), compositionEnded = useRef(-Infinity);
  const editor = useRef<HTMLTextAreaElement>(null);
  const draft = getDraft(state, drafts), key = draftKey(state);
  useLayoutEffect(() => { const element = editor.current; if (!element) return; element.style.height = '49px'; element.style.height = `${Math.min(180, Math.max(49, element.scrollHeight))}px`; }, [draft.text]);
  const saved = draftStatus[key] === 'saved';
  const draftPending = draftStatus[key] === 'pending';
  const selectedModel = draft.model || state.thread?.model || state.defaults?.model || '';
  const model = state.models?.data.find(value => value.model === selectedModel);
  const canSend = !cached && saved && canSendFirstTurn(state) && !pending && !state.activeTurnId && !state.thread?.archived && canUseCapability(state, 'turn.start');
  const canStop = !cached && canControlTurn(state, 'interrupt', pending), canSteer = !cached && saved && canControlTurn(state, 'steer', pending);
  const attachments = state.attachments.filter(attachment => attachment.threadId === state.threadId && attachment.draftId === state.draftId && attachment.state !== 'sent');
  const blockedAttachments = attachments.some(attachment => attachment.state !== 'ready');
  const permission = state.thread?.permissionReadback;
  async function send(steer = false) {
    if (composing.current || !draft.text.trim() || (steer
      ? !canSteer || !draft.text.trim()
      : !canSend || blockedAttachments)) return;
    await sendDraft(steer);
  }
  return <div className="composer-area"><div className="composer-state flex items-center"><Icon name="shield" /><span>{permission ? `原生回读：${permissionLabels[permission.preset ?? ''] ?? '自定义权限'}` : '权限尚无当前原生回读'}</span><span className="composer-state-detail">{state.thread?.model ?? '模型待确认'}{state.thread?.reasoningEffort ? ` · ${state.thread.reasoningEffort}` : ''}</span></div>
    <div className="composer"><label className="sr-only" htmlFor="message-draft">消息草稿</label><textarea ref={editor} id="message-draft" value={draft.text} maxLength={100000} aria-describedby="draft-save-status composer-hint" placeholder={state.connection.status !== 'connected' ? '离线草稿，连接恢复后由你发送…' : cached ? '正在核对会话，可以先整理草稿…' : state.activeTurnId ? '补充指令，或等待本轮完成…' : '写下你的想法…'} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => { composing.current = false; compositionEnded.current = event.timeStamp; }} onChange={event => setDraft(key, { text: event.target.value })} onKeyDown={event => { if (sendShortcut(event.nativeEvent, composing.current, compositionEnded.current)) { event.preventDefault(); void send(!!state.activeTurnId); } }} />
      {!!attachments.length && <div className="attachment-list">{attachments.map(attachment => <span className="attachment-chip" key={attachment.id}><Icon name="file" /><span>{attachment.name}<small>{attachment.state === 'ready' ? `${Math.ceil(attachment.size / 1024)} KB` : attachment.state}</small></span><button className="icon-button" aria-label={`移除附件 ${attachment.name}`} disabled={cached || !canSendFirstTurn(state) || pending || attachment.state !== 'ready'} onClick={() => void act({ type: 'removeAttachment', attachmentId: attachment.id })}><Icon name="close" /></button></span>)}</div>}
      <div className="composer-toolbar flex items-center justify-between"><div className="composer-tools flex items-center"><button className="icon-button" aria-label="选择并上传本机附件" title="选择本机图片或文档" disabled={cached || !canSendFirstTurn(state) || pending || !canUseCapability(state, 'attachments')} onClick={() => void act({ type: 'upload' })}><Icon name="plus" /></button><span className="toolbar-separator" /><label className="composer-choice"><span className="sr-only">下次发送的模型</span><select aria-label="下次发送的模型" value={draft.model} disabled={!state.models?.data.length} onChange={event => setDraft(key, { model: event.target.value, effort: '' })}><option value="">沿用模型</option>{state.models?.data.map(value => <option key={value.id} value={value.model}>{value.displayName}</option>)}</select></label><label className="composer-choice"><span className="sr-only">下次发送的思考强度</span><select aria-label="下次发送的思考强度" value={draft.effort} onChange={event => setDraft(key, { effort: event.target.value })}><option value="">沿用强度</option>{model?.supportedReasoningEfforts.map(value => <option key={value.reasoningEffort} value={value.reasoningEffort}>{value.reasoningEffort}</option>)}</select></label><label className="composer-choice"><span className="sr-only">下次发送的权限模式</span><select aria-label="下次发送的权限模式" value={draft.permissionPreset} onChange={event => setDraft(key, { permissionPreset: event.target.value as Preset | '' })}><option value="">沿用权限</option><option value="read-only">只读</option><option value="auto">自动</option><option value="full-access">完全访问</option></select></label></div>
        {state.activeTurnId ? <div className="turn-controls"><button className="quiet-button" disabled={!canStop} onClick={() => void act({ type: 'interrupt' })}>停止</button><button className="primary-button" disabled={!canSteer || !draft.text.trim()} onClick={() => void send(true)}>插话</button></div> : <button className="send-button" aria-label="发送消息" title="Ctrl Enter 发送" disabled={!canSend || blockedAttachments || !draft.text.trim()} onClick={() => void send()}><Icon name="arrow" /></button>}
      </div>
    </div><div className="composer-save-row"><span id="draft-save-status" className={`draft-save-status ${draftStatus[key] === 'error' ? 'danger-text' : ''}`} role="status">{draftPending ? '这份草稿的发送结果待核实，不会自动重发' : draftStatus[key] === 'error' ? '草稿尚未保存，请保留窗口并重试保存' : draftStatus[key] === 'saving' ? '正在保存草稿…' : draftStatus[key] === 'loading' ? '正在恢复草稿…' : saved ? '草稿已保存到这台电脑' : '本地草稿暂未就绪'}</span>{draftPending && <button className="text-button draft-recheck" disabled={pending || state.busy} onClick={() => void recheckDraft()}>核实这份草稿</button>}<span>Ctrl Enter 发送</span></div><p id="composer-hint" className="composer-hint">{draft.model || draft.effort || draft.permissionPreset ? `待下次发送：${[draft.model, draft.effort, draft.permissionPreset ? permissionLabels[draft.permissionPreset] : ''].filter(Boolean).join(' · ')}。尚未生效。` : state.connection.status !== 'connected' ? '当前为离线阅读。草稿可以继续编辑，连接恢复后不会自动发送。' : cached ? '正在核对会话。草稿可以继续编辑，核对完成后由你发送。' : ''}{draft.permissionPreset === 'full-access' && ' 完全访问允许 Codex 在沙箱之外执行，请确认范围。'}{!!attachments.length && !draft.text.trim() && ' 发送附件前请填写说明文字。'}{state.models?.nextCursor && ' 模型目录未完整载入。'}</p>
  </div>;
}

function PanelResize({ side, value, onPreview, onCommit }: { side: 'navigation' | 'inspector'; value: number; onPreview: (value: number) => void; onCommit: (value: number) => void }) {
  const drag = useRef<{ startX: number; startWidth: number; width: number } | undefined>(undefined);
  const minimum = side === 'navigation' ? 190 : 280, maximum = side === 'navigation' ? 360 : 560;
  const bound = (width: number) => Math.max(minimum, Math.min(maximum, Math.round(width)));
  return <div className={`panel-resize panel-resize-${side}`} role="separator" tabIndex={0} aria-label={side === 'navigation' ? '调整导航宽度' : '调整 Inspector 宽度'} aria-orientation="vertical" aria-controls={side === 'navigation' ? 'navigation' : 'inspector'} aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={Math.round(value)} aria-valuetext={`${Math.round(value)} 像素`} title="拖动或按左右方向键调整宽度，双击恢复默认宽度"
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { startX: event.clientX, startWidth: value, width: value }; }}
    onPointerMove={event => { if (!drag.current) return; const width = bound(drag.current.startWidth + (event.clientX - drag.current.startX) * (side === 'navigation' ? 1 : -1)); drag.current.width = width; onPreview(width); }}
    onPointerUp={event => { if (!drag.current) return; const width = drag.current.width; drag.current = undefined; event.currentTarget.releasePointerCapture(event.pointerId); onCommit(width); }}
    onPointerCancel={() => { if (drag.current) { const width = drag.current.startWidth; drag.current = undefined; onCommit(width); } }}
    onLostPointerCapture={() => { if (drag.current) { const width = drag.current.startWidth; drag.current = undefined; onCommit(width); } }}
    onDoubleClick={() => onCommit(side === 'navigation' ? DEFAULT_LAYOUT.navigationWidth : DEFAULT_LAYOUT.inspectorWidth)}
    onKeyDown={event => { if (composingKey(event.nativeEvent) || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const delta = (event.key === 'ArrowRight' ? 1 : -1) * (side === 'navigation' ? 1 : -1) * (event.shiftKey ? 32 : 16); onCommit(event.key === 'Home' ? minimum : event.key === 'End' ? maximum : bound(value + delta)); }} />;
}

function ConfirmDialog({ title, text, busy, onCancel, onConfirm }: { title: string; text: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; cancel.current?.focus(); return () => { previous?.focus(); }; }, []);
  return <div className="modal-scrim"><section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onKeyDown={event => { if (event.key !== 'Tab') return; const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); } else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); } }}><h2 id="confirm-title">{title}</h2><p>{text}</p><div><button ref={cancel} className="quiet-button" disabled={busy} onClick={onCancel}>取消</button><button className="primary-button" disabled={busy} onClick={onConfirm}>确认操作</button></div></section></div>;
}
