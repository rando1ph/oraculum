import { useEffect, useRef, useState } from 'react';
import { appUrl } from '../../../packages/shared/entry';
import { DEFAULT_THEME, defaultTheme, themeId, type ThemeCatalog } from '../../../packages/shared/themes';
import { androidShell } from './mobile';
import { decodeThemeAsset, loadThemeBundle, temporaryThemeFailure } from './theme-loading';

const preferenceKey = `oraculum.theme:${appUrl('').pathname}`;
let forcedDefault = new URL(location.href).searchParams.get('theme') === 'default';
if (forcedDefault) {
  try { localStorage.setItem(preferenceKey, DEFAULT_THEME); } catch { /* The current launch still bypasses the saved theme. */ }
  const url = new URL(location.href); url.searchParams.delete('theme'); history.replaceState(null, '', url);
}
const savedTheme = () => {
  // Consume the native recovery intent once. A later explicit selection must
  // survive an authentication remount within this same document.
  if (forcedDefault) { forcedDefault = false; return DEFAULT_THEME; }
  try { const id = localStorage.getItem(preferenceKey); return id && themeId.test(id) ? id : DEFAULT_THEME; }
  catch { return DEFAULT_THEME; }
};
async function request<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(appUrl(path), { cache: 'no-store', signal: AbortSignal.timeout(5000),
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('oraculum-auth-required'));
    throw new Error((await response.json()).error ?? '无法加载主题');
  }
  return response.json() as Promise<T>;
}

export function useTheme() {
  const [id, setId] = useState(DEFAULT_THEME);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(DEFAULT_THEME), desired = useRef(DEFAULT_THEME), revision = useRef(''), epoch = useRef(0), pending = useRef(false);
  const loading = useRef<AbortController | null>(null);
  const sheet = useRef<HTMLStyleElement | null>(null);
  function save(value: string) {
    try { localStorage.setItem(preferenceKey, value); }
    catch { setNotice('本次主题已应用，但此设备无法保存偏好。'); }
  }
  function clearTheme() {
    sheet.current?.remove(); sheet.current = null; revision.current = '';
    active.current = DEFAULT_THEME; setId(DEFAULT_THEME);
  }
  function reset(reason = '') {
    ++epoch.current; loading.current?.abort(); pending.current = false; setBusy(false);
    clearTheme(); desired.current = DEFAULT_THEME; setNotice(reason); save(DEFAULT_THEME);
  }
  async function select(next: string, background = false) {
    if (next === DEFAULT_THEME) { reset(); return; }
    if (background && pending.current) return;
    const ticket = ++epoch.current; pending.current = true; desired.current = next;
    loading.current?.abort();
    const controller = new AbortController(); loading.current = controller;
    if (!background) { setBusy(true); setNotice(''); }
    try {
      const result = await loadThemeBundle(next, controller.signal);
      if (revision.current !== result.revision || active.current !== next) {
        await Promise.all(result.assets.map(path => decodeThemeAsset(path, controller.signal)));
        if (ticket !== epoch.current) return;
        const nextSheet = document.createElement('style'); nextSheet.dataset.oraculumTheme = next;
        nextSheet.textContent = result.css;
        document.head.append(nextSheet);
        sheet.current?.remove(); sheet.current = nextSheet; revision.current = result.revision;
      }
      if (ticket !== epoch.current) return;
      active.current = next; setId(next); setNotice(''); save(next);
    } catch (error) {
      if (ticket === epoch.current) {
        controller.abort();
        const reason = error instanceof Error ? error.message : '加载失败';
        if (temporaryThemeFailure(error)) {
          if (active.current !== next) clearTheme();
          save(next);
          setNotice(`主题暂时不可用：${reason}。已保留所选主题，稍后或回到页面时重试；可手动恢复默认主题。`);
        } else reset(`已恢复默认主题：${reason}`);
      }
    } finally {
      if (ticket === epoch.current) { pending.current = false; setBusy(false); }
    }
  }
  useEffect(() => {
    void select(savedTheme());
    let verification: ReturnType<typeof setTimeout> | undefined;
    // Focus and visibilitychange commonly arrive together on a resumed page.
    const verify = () => {
      clearTimeout(verification);
      verification = setTimeout(() => { if (!document.hidden && desired.current !== DEFAULT_THEME) void select(desired.current, true); }, 250);
    };
    const timer = window.setInterval(verify, 30_000);
    window.addEventListener('focus', verify); document.addEventListener('visibilitychange', verify);
    return () => { ++epoch.current; loading.current?.abort(); sheet.current?.remove(); clearTimeout(verification); clearInterval(timer); window.removeEventListener('focus', verify); document.removeEventListener('visibilitychange', verify); };
  }, []);
  return { id, notice, busy, select, reset };
}

export function ThemeSettings({ theme, open }: { theme: ReturnType<typeof useTheme>; open: boolean }) {
  const [catalog, setCatalog] = useState<ThemeCatalog>({ installed: [], sources: [] });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function refresh() {
    setBusy(true); setError('');
    try { setCatalog(await request<ThemeCatalog>('themes')); }
    catch (e) { setError(e instanceof Error ? e.message : '无法查询主题'); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (open) void refresh(); }, [open]);
  async function install(directory: string) {
    setBusy(true); setError('');
    try { await request('themes/install', { directory }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : '安装失败'); }
    finally { setBusy(false); }
  }
  const disabled = busy || theme.busy;
  return <section className="theme-settings" aria-label="主题管理">
    <h3>主题</h3><p>仅更改此设备。安装不会自动切换；其他设备可独立选择。</p>
    <label className="theme-choice">当前主题<select aria-label="当前主题" value={theme.id} disabled={disabled} onChange={e => void theme.select(e.target.value)}>
      <option value={DEFAULT_THEME}>{defaultTheme.name}</option>
      {catalog.installed.filter(entry => entry.manifest).map(entry => <option key={entry.directory} value={entry.manifest!.id}>{entry.manifest!.name} · {entry.builtin ? '内置' : entry.manifest!.version}</option>)}
      {theme.id !== DEFAULT_THEME && !catalog.installed.some(entry => entry.manifest?.id === theme.id) && <option value={theme.id}>{theme.id}</option>}
    </select></label>
    <div className="theme-actions"><button onClick={() => theme.reset()}>恢复默认主题</button><button disabled={disabled} onClick={() => void refresh()}>刷新主题列表</button></div>
    {theme.notice && <p className="error" role="alert">{theme.notice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {catalog.installed.filter(entry => entry.error).map(entry => <p className="error" key={entry.directory}>{entry.directory} · {entry.error}</p>)}
    <details className="theme-sources"><summary>从主机主题目录安装</summary><p>只安装自己信任的主题。来源目录由 Ubuntu 主机配置。</p>
      {catalog.sources.length ? catalog.sources.map(entry => <div className="theme-candidate" key={entry.directory}><span>{entry.manifest?.name ?? entry.directory}<small>{entry.manifest?.version ?? entry.error}</small></span>
        <button disabled={disabled || !!entry.error || catalog.installed.some(i => i.manifest?.id === entry.manifest?.id)} aria-label={`安装 ${entry.manifest?.name ?? entry.directory}`} onClick={() => void install(entry.directory)}>{catalog.installed.some(i => i.manifest?.id === entry.manifest?.id && !!entry.manifest) ? '已安装' : '安装'}</button></div>) : <p>来源目录中没有主题。</p>}
    </details>
    <p>{androidShell ? '页面不可用时：按住音量加键，使用原生「恢复默认主题」。' : '页面不可用时：Ctrl+Shift+0，或 Alt → 神谕 → 恢复默认主题。'}</p>
  </section>;
}
