import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { DesktopState, Preferences, Theme } from '../contracts/desktop';
import { BrandIcon, Icon } from './Icon';

type View = 'connect' | 'preview';
type Panel = 'diff' | 'files' | 'process' | 'usage' | 'extensions';
const themes: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'oled', label: 'OLED Dark' },
];
const panels: { value: Panel; label: string }[] = [
  { value: 'diff', label: '变更' }, { value: 'files', label: '文件' }, { value: 'process', label: '执行' },
  { value: 'usage', label: '用量' }, { value: 'extensions', label: '扩展' },
];

function useCompactWindow() {
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 1099px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1099px)');
    const update = () => setCompact(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return compact;
}

export function App() {
  const [state, setState] = useState<DesktopState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<View>('connect');
  const [panel, setPanel] = useState<Panel>('diff');
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [preferenceError, setPreferenceError] = useState(false);
  const compact = useCompactWindow();
  const [overlayOpen, setOverlayOpen] = useState(false);
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  const inspectorClose = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const mainHeading = useRef<HTMLHeadingElement>(null);
  const visible = compact ? overlayOpen : state?.preferences.inspectorVisible ?? true;

  useEffect(() => {
    let current = true;
    const bridge = window.oraculumDesktop;
    setLoadError(false);
    if (!bridge) { setLoadError(true); return; }
    const unsubscribe = bridge.onStateChanged(next => { if (current) setState(next); });
    void bridge.getState().then(next => {
      if (!current) return;
      setState(next);
      if (next.preferencesRecovered) setNotice('外观设置已恢复为默认值，可以重新选择主题。');
    }).catch(() => { if (current) setLoadError(true); });
    return () => { current = false; unsubscribe(); };
  }, [attempt]);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = state?.preferences.theme ?? 'light';
  }, [state?.preferences.theme]);

  useEffect(() => { setOverlayOpen(false); }, [compact, view]);

  useEffect(() => {
    if (compact && overlayOpen) inspectorClose.current?.focus();
  }, [compact, overlayOpen]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape' && compact && overlayOpen) {
        event.preventDefault(); closeInspector();
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'k' && view === 'preview') {
        event.preventDefault(); searchInput.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compact, overlayOpen, view]);

  async function updatePreferences(patch: Partial<Preferences>) {
    if (saving || !window.oraculumDesktop) return;
    setSaving(true); setPreferenceError(false); setNotice('');
    try { setState(await window.oraculumDesktop.setPreferences(patch)); }
    catch { setPreferenceError(true); }
    finally { setSaving(false); }
  }

  async function resetAppearance() {
    if (saving || !window.oraculumDesktop) return;
    setSaving(true); setPreferenceError(false);
    try {
      setState(await window.oraculumDesktop.resetAppearance());
      setOverlayOpen(false); setNotice('已恢复默认外观。');
    } catch { setPreferenceError(true); }
    finally { setSaving(false); }
  }

  function changeView(next: View) {
    setView(next);
    setSearch('');
    requestAnimationFrame(() => mainHeading.current?.focus());
  }

  function toggleInspector() {
    if (compact) setOverlayOpen(open => !open);
    else void updatePreferences({ inspectorVisible: !visible });
  }

  function closeInspector() {
    setOverlayOpen(false);
    requestAnimationFrame(() => inspectorToggle.current?.focus());
  }

  if (loadError) return <div className="launch-screen">
    <BrandIcon size="hero" /><h1>暂时无法打开工作台</h1>
    <p>应用的本机设置未能载入。请重试，或关闭窗口后重新启动 Oraculum。</p>
    <button className="primary-button" onClick={() => setAttempt(value => value + 1)}>重新尝试</button>
  </div>;

  if (!state) return <div className="launch-screen" role="status"><BrandIcon size="hero" /><p>正在打开工作台…</p></div>;

  return <div className={`app-shell ${visible && !compact ? 'with-inspector' : ''}`}>
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>跳到主要内容</a>
    <nav className="navigation flex min-h-0 flex-col" aria-label="项目与会话导航" inert={compact && visible}>
      <div className="brand flex items-center"><BrandIcon /><div><strong>Oraculum</strong><span>神谕 · 你的工作，从这里展开</span></div></div>
      <button className="new-conversation flex items-center" disabled aria-describedby="navigation-unavailable"><Icon name="plus" />新建会话<kbd>Ctrl N</kbd></button>
      <label className="search-field flex items-center"><Icon name="search" /><input ref={searchInput} aria-label={view === 'preview' ? '搜索本地样例' : '搜索会话'} placeholder={view === 'preview' ? '搜索本地样例' : '搜索会话'} value={search} onChange={event => setSearch(event.target.value)} disabled={view !== 'preview'} /><kbd>Ctrl K</kbd></label>
      <div className="navigation-scroll">
        <div className="section-label flex items-center justify-between"><span>项目</span>{view === 'preview' && <span>本地样例</span>}</div>
        {view === 'connect' ? <div className="navigation-empty"><Icon name="folder" /><b>还没有项目</b><p>连接后，项目与会话<br />会显示在这里。</p></div> : <>
          <div className="project-current flex items-center"><span className="project-initial">A</span><span><b>Atlas Studio</b><small>外观预览 · 样例项目</small></span></div>
          <div className="section-label"><span>样例会话</span></div>
          {'重构会话恢复流程'.includes(search.trim()) ? <button className="thread selected flex items-center" aria-current="page" onClick={() => mainHeading.current?.focus()}><span className="thread-marker" /><span><b>重构会话恢复流程</b><small>设计、边界与恢复策略</small></span></button> : <p className="empty-search">没有匹配的样例会话</p>}
        </>}
        <p className="navigation-unavailable" id="navigation-unavailable">会话功能尚未开放</p>
      </div>
      <div className="navigation-footer">
        <button className={`settings-link flex items-center ${view === 'connect' ? 'selected' : ''}`} aria-current={view === 'connect' ? 'page' : undefined} onClick={() => changeView('connect')}><Icon name="settings" /><span>连接与外观</span><Icon name="chevron" /></button>
        <button className={`settings-link flex items-center ${view === 'preview' ? 'selected' : ''}`} aria-current={view === 'preview' ? 'page' : undefined} onClick={() => changeView('preview')}><Icon name="eye" /><span>本地外观预览</span><Icon name="chevron" /></button>
        <div className="theme-heading flex items-center"><Icon name="sun" /><span>外观</span></div>
        <div className="theme-control flex" role="group" aria-label="外观主题" aria-busy={saving}>
          {themes.map(theme => <button key={theme.value} aria-pressed={state.preferences.theme === theme.value} disabled={saving} onClick={() => void updatePreferences({ theme: theme.value })}>{theme.label}</button>)}
        </div>
        <div className="connection-summary flex items-center"><span className="status-dot offline" /><span>尚未连接</span><span className="version-label">{state.profile === 'development' ? '开发预览' : '2.0'}</span></div>
      </div>
    </nav>

    <main className="conversation flex min-h-0 flex-col" id="main-content" tabIndex={-1} inert={compact && visible}>
      <header className="conversation-header flex items-center justify-between">
        <div className="breadcrumb flex items-center"><Icon name="folder" /><span>{view === 'connect' ? 'Oraculum' : 'Atlas Studio'}</span><span>/</span><b>{view === 'connect' ? '连接与外观' : '重构会话恢复流程'}</b></div>
        <button ref={inspectorToggle} className={`icon-button ${visible ? 'active' : ''}`} onClick={toggleInspector} aria-label={visible ? '收起 Inspector' : '展开 Inspector'} aria-expanded={visible} aria-controls="inspector" disabled={saving && !compact}><Icon name="panel" /></button>
      </header>
      <div className={`connection-banner flex items-center ${view === 'preview' ? 'preview-banner' : ''}`}><Icon name={view === 'preview' ? 'eye' : 'offline'} /><span>{view === 'preview' ? '本地样例 · 仅用于外观预览，不连接 Gateway' : '尚未配置 Gateway · 当前可调整外观和查看本地预览'}</span></div>
      {(notice || preferenceError) && <div className={`notice flex items-center ${preferenceError ? 'notice-error' : ''}`} role={preferenceError ? 'alert' : 'status'}><span>{preferenceError ? '外观设置未能保存，请重试。' : notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => { setNotice(''); setPreferenceError(false); }}><Icon name="close" /></button></div>}
      <div className="conversation-scroll" aria-label={view === 'connect' ? '连接与外观设置' : '本地样例对话'}>
        {view === 'connect' ? <ConnectionView headingRef={mainHeading} saving={saving} onReset={() => void resetAppearance()} onPreview={() => changeView('preview')} /> : <PreviewConversation headingRef={mainHeading} onShowDiff={() => { setPanel('diff'); if (compact) setOverlayOpen(true); else if (!visible) void updatePreferences({ inspectorVisible: true }); }} />}
      </div>
      {view === 'preview' && <ComposerPreview />}
    </main>

    {compact && visible && <button className="inspector-scrim" aria-label="关闭 Inspector" onClick={closeInspector} />}
    {visible && <aside className={`inspector flex min-h-0 flex-col ${compact ? 'inspector-overlay' : ''}`} id="inspector" role={compact ? 'dialog' : undefined} aria-modal={compact ? true : undefined} aria-label={view === 'connect' ? '连接说明' : 'Inspector 样例详情'} onKeyDown={event => {
      if (!compact || event.key !== 'Tab') return;
      const stops = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')];
      const first = stops[0]; const last = stops[stops.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header className="inspector-header flex items-center justify-between"><b>Inspector</b><span>{view === 'connect' ? '连接前' : '本地样例'}</span>{compact && <button ref={inspectorClose} className="icon-button" aria-label="收起 Inspector" onClick={closeInspector}><Icon name="close" /></button>}</header>
      {view === 'preview' && <InspectorTabs panel={panel} setPanel={setPanel} />}
      <div className="inspector-scroll" role={view === 'preview' ? 'tabpanel' : undefined} id="inspector-content" aria-labelledby={view === 'preview' ? `tab-${panel}` : undefined} tabIndex={view === 'preview' ? 0 : undefined}>
        {view === 'connect' ? <ConnectionGuide /> : panel === 'diff' ? <DiffPreview /> : <InspectorEmpty panel={panel} />}
      </div>
      <div className="inspector-footnote">{view === 'connect' ? '连接功能尚未开放' : '所有文件与状态均为本地样例'}</div>
    </aside>}
  </div>;
}

function ConnectionView({ headingRef, saving, onReset, onPreview }: { headingRef: RefObject<HTMLHeadingElement | null>; saving: boolean; onReset: () => void; onPreview: () => void }) {
  return <section className="connect-content">
    <BrandIcon size="hero" /><div className="connect-eyebrow">YOUR OWN WORKSPACE</div>
    <h1 ref={headingRef} tabIndex={-1}>把神谕连接到<br />你的工作台。</h1>
    <p>独立的桌面空间，专注于你的工作。现在可以选择喜欢的外观，或先看看对话工作台。</p>
    <label className="form-label" htmlFor="gateway-address">Gateway 地址</label>
    <input className="form-input" id="gateway-address" value="" placeholder="http://127.0.0.1:端口/" readOnly aria-describedby="gateway-help" />
    <p className="form-help" id="gateway-help">连接功能尚未开放。后续可连接本机 HTTP / WS，或配置 HTTPS / WSS 地址。</p>
    <div className="form-label">设备配对</div>
    <div className="pairing-placeholder flex items-center"><Icon name="shield" /><span>连接开放后，再使用一次性配对码建立信任。</span></div>
    <div className="connect-footer flex items-center"><button className="primary-button" disabled aria-describedby="connect-unavailable">连接并配对</button><small id="connect-unavailable">当前不会发起连接或读取凭据</small></div>
    <div className="appearance-section">
      <div className="section-eyebrow">先让工作台，成为你的样子</div>
      <p>左下角可切换 Light、Dark 和 OLED Dark。外观只保存在这台设备。</p>
      <div className="appearance-actions flex items-center"><button className="quiet-button" onClick={onPreview}><Icon name="eye" />查看本地外观预览</button><button className="text-button" onClick={onReset} disabled={saving}><Icon name="refresh" />恢复默认外观</button></div>
      <div className="recovery-hint"><kbd>Ctrl Shift 0</kbd> 也可恢复默认外观</div>
    </div>
  </section>;
}

function ConnectionGuide() {
  return <>
    <section className="connection-step"><span>01 / EXISTING GATEWAY</span><h2>从已有的 Gateway 开始</h2><p>后续连接你已配置的 Gateway。桌面客户端不会启动、安装或重启服务。</p></section>
    <section className="connection-step"><span>02 / DEVICE TRUST</span><h2>这台设备，独立的信任</h2><p>连接开放后，通过一次性配对码确认这台设备。现在无需输入配对码。</p></section>
    <section className="connection-step"><span>03 / LOCAL EXPERIENCE</span><h2>你的外观，留在本机</h2><p>三套主题和面板偏好在这台设备保存。首次使用从全新的工作台开始。</p></section>
    <p className="inspector-note">当前可以调整外观和浏览本地样例。会话、文件与配对功能尚未开放。</p>
  </>;
}

function PreviewConversation({ headingRef, onShowDiff }: { headingRef: RefObject<HTMLHeadingElement | null>; onShowDiff: () => void }) {
  return <div className="conversation-inner">
    <div className="conversation-day">本地样例 · 仅供外观预览</div>
    <article className="message user-message"><div className="message-person flex items-center"><span className="avatar">你</span><b>你</b><time>14:31</time></div><div className="message-body">请梳理会话恢复方案，重点看看长历史、草稿和未知操作的边界。</div></article>
    <article className="message"><div className="message-person flex items-center"><BrandIcon size="avatar" /><b>Oraculum</b><span className="model-label">样例回复</span><time>14:32</time></div>
      <div className="message-body"><h1 ref={headingRef} tabIndex={-1}>让恢复更轻，也更可靠。</h1><p>可以把恢复过程拆成三条清晰的路径。已加载的历史让阅读立即继续，草稿留在本机，未决操作则单独核实。</p>
        <div className="process-summary flex items-center"><Icon name="check" /><span>样例过程 · 查看 3 个文件</span><span className="duration">8.2 s</span></div>
        <ol className="steps">
          <li><span className="step-index">1</span><div><b>先恢复阅读，再校正历史</b><small>缓存只负责首屏。连接恢复后，按历史版本校正当前会话。</small></div></li>
          <li><span className="step-index">2</span><div><b>草稿和历史分开保存</b><small>切换会话、清理历史缓存，都不会顺手清空尚未发送的内容。</small></div></li>
          <li><span className="step-index">3</span><div><b>未知结果，先核实再继续</b><small>用原操作标识查询结果，避免重发一条已经执行过的指令。</small></div></li>
        </ol>
        <p className="muted">右侧展示这份方案的样例 Diff，帮助你查看工作台的文字层次与布局。</p><button className="inline-link" onClick={onShowDiff}>查看样例变更<Icon name="chevron" /></button>
      </div>
      <div className="message-meta flex items-center"><span>本地排版样例</span><span>未读取任何真实文件</span></div>
    </article>
  </div>;
}

function ComposerPreview() {
  return <div className="composer-area">
    <div className="composer-state flex items-center"><span className="status-dot offline" /><span>尚未连接</span><span className="composer-state-detail">消息功能尚未开放</span></div>
    <div className="composer"><label htmlFor="composer-input" className="sr-only">消息输入（尚未开放）</label><textarea id="composer-input" rows={2} placeholder="连接后，从这里开始新的问题…" disabled aria-describedby="composer-reason" /><div className="composer-toolbar flex items-center justify-between"><div className="composer-tools flex items-center"><button className="icon-button" disabled aria-label="添加附件（尚未开放）"><Icon name="plus" /></button><span className="composer-option">模型与思考强度</span><span className="toolbar-separator" /><span className="composer-option flex items-center"><Icon name="shield" />权限未确认</span></div><button className="send-button" disabled aria-label="发送消息（尚未开放）" aria-describedby="composer-reason"><Icon name="arrow" /></button></div></div>
    <p className="composer-hint" id="composer-reason">本地外观预览 · 输入与发送尚未开放</p>
  </div>;
}

function InspectorTabs({ panel, setPanel }: { panel: Panel; setPanel: (panel: Panel) => void }) {
  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const current = panels.findIndex(item => item.value === panel);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? panels.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + panels.length) % panels.length;
    event.preventDefault();
    setPanel(panels[next].value);
    document.getElementById(`tab-${panels[next].value}`)?.focus();
  }
  return <div className="inspector-tabs flex" role="tablist" aria-label="Inspector 内容" onKeyDown={onKey}>{panels.map(item => <button role="tab" id={`tab-${item.value}`} key={item.value} aria-selected={panel === item.value} aria-controls="inspector-content" tabIndex={panel === item.value ? 0 : -1} onClick={() => setPanel(item.value)}>{item.label}</button>)}</div>;
}

function DiffPreview() {
  return <><section className="inspector-section"><h2>本轮变更<span>只读样例</span></h2><div className="change-stats flex"><span>2 个文件</span><span className="add-text">+18</span><span className="remove-text">−6</span></div><div className="file-row selected flex items-center"><Icon name="file" /><span className="file-name">recovery.ts</span><small><span className="add-text">+14</span> <span className="remove-text">−4</span></small></div><div className="file-row flex items-center"><Icon name="file" /><span className="file-name">drafts.ts</span><small><span className="add-text">+4</span> <span className="remove-text">−2</span></small></div><div className="diff-heading flex items-center"><Icon name="file" />recovery.ts</div><div className="file-path">src / state / recovery.ts</div><div className="diff-code" aria-label="样例只读差异" tabIndex={0}><div className="diff-line meta">@@ −18,6 +18,8 @@</div><div className="diff-line"><span className="line-number">18</span>{'  async function restore() {'}</div><div className="diff-line removed"><span className="line-number">19</span>−   await reloadAll();</div><div className="diff-line added"><span className="line-number">19</span>+   await showCached();</div><div className="diff-line added"><span className="line-number">20</span>+   await reconcilePending();</div><div className="diff-line added"><span className="line-number">21</span>+   await validateHistory();</div><div className="diff-line"><span className="line-number">22</span>{'  }'}</div></div><p className="inspector-note">示意代码只用于展示排版，不代表真实文件或已经实现的功能。</p></section><section className="inspector-section"><h2>会话上下文</h2><dl className="detail-list"><div><dt>项目</dt><dd>Atlas Studio · 样例</dd></div><div><dt>模型</dt><dd>尚未连接</dd></div><div><dt>权限</dt><dd>未确认</dd></div><div><dt>文件访问</dt><dd>未读取</dd></div></dl></section></>;
}

function InspectorEmpty({ panel }: { panel: Exclude<Panel, 'diff'> }) {
  const content = {
    files: ['项目文件', '连接后，这里将展示授权范围内的项目文件与成果。'],
    process: ['执行过程', '连接后，这里将展示会话执行、计划与相关详情。'],
    usage: ['会话用量', '连接后，这里将展示可获取的会话用量。当前没有用量数据。'],
    extensions: ['扩展能力', '连接后，这里将展示可获取的 MCP、Skills 与扩展信息。'],
  }[panel];
  return <section className="inspector-empty"><Icon name={panel === 'files' ? 'folder' : 'chat'} /><h2>{content[0]}</h2><p>{content[1]}</p><span>功能尚未开放</span></section>;
}
