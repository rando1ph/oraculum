import { useEffect, useRef, useState } from 'react';
import type { BridgeClient } from '../../../packages/shared/client';
import type { DirectoryListing, ProjectList } from '../../../packages/shared/protocol';
import { Icon } from './icons';

export function ProjectBrowser({ client, projects, onSelect, onRefresh, onClose }: {
  client: BridgeClient; projects: ProjectList; onSelect: (cwd: string, restore: boolean) => Promise<void>;
  onRefresh: () => Promise<void>; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const epoch = useRef(0);
  const [listing, setListing] = useState<DirectoryListing>();
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const report = (value: unknown) => setError(value instanceof Error ? value.message : String(value));
  async function browse(path?: string, cursor?: string) {
    const ticket = ++epoch.current;
    setBusy(true); setError('');
    try {
      const result = await client.request<DirectoryListing>('bridge/browse', { path, cursor });
      if (ticket !== epoch.current) return;
      setListing(previous => ({ ...result, directories: cursor && previous?.cwd === result.cwd
        ? [...new Map([...previous.directories, ...result.directories].map(d => [d.cwd, d])).values()] : result.directories }));
      setPath(result.cwd);
    } catch (value) { if (ticket === epoch.current) report(value); }
    finally { if (ticket === epoch.current) setBusy(false); }
  }
  useEffect(() => { dialog.current?.showModal(); void browse(); return () => { ++epoch.current; }; }, []);
  async function add() {
    if (!listing || busy) return;
    const restore = projects.projects.some(project => project.cwd === listing.cwd);
    setBusy(true); setError('');
    try {
      const project = await client.request<{ cwd: string }>('bridge/registerProject', { path: listing.cwd });
      await onRefresh(); await onSelect(project.cwd, restore); onClose();
    } catch (value) { report(value); }
    finally { setBusy(false); }
  }
  async function remove(cwd: string) {
    setBusy(true); setError('');
    try { await client.request('bridge/unregisterProject', { cwd }); await onRefresh(); }
    catch (value) { report(value); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="settings-dialog project-browser" aria-labelledby="project-browser-title"
    onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="settings-content">
      <header><div><Icon name="folder"/><h2 id="project-browser-title">浏览主机文件夹</h2></div><button className="icon-button" aria-label="关闭文件夹浏览器" onClick={onClose}><Icon name="close"/></button></header>
      <p className="browser-hint">选择 Ubuntu 主机上已有的文件夹，添加后可在原目录使用 Codex。</p>
      {listing && <label className="browser-root">允许浏览的范围<select aria-label="主机目录范围" disabled={busy} value={listing.roots.find(root => listing.cwd === root || listing.cwd.startsWith(root + '/')) ?? ''} onChange={event => void browse(event.target.value)}>{listing.roots.map(root => <option key={root}>{root}</option>)}</select></label>}
      <form className="browser-path" onSubmit={event => { event.preventDefault(); void browse(path); }}><label className="sr-only" htmlFor="host-directory">主机文件夹路径</label><input id="host-directory" value={path} onChange={event => setPath(event.target.value)} placeholder="输入允许范围内的绝对路径" disabled={busy}/><button disabled={busy || !path}>前往</button></form>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="browser-current"><button disabled={busy || !listing?.parent} onClick={() => void browse(listing!.parent!)}>上一级</button><span className="path" data-testid="browsed-directory">{listing?.cwd ?? '正在读取目录…'}</span></div>
      <div className="directory-list" aria-label="主机子文件夹" aria-busy={busy}>
        {listing?.directories.map(directory => <button key={directory.cwd} title={directory.cwd} disabled={busy} onClick={() => void browse(directory.cwd)}><Icon name="folder"/><span>{directory.name}</span></button>)}
        {listing && !listing.directories.length && <p>此处没有可浏览的子文件夹</p>}
        {listing?.nextCursor && <button disabled={busy} onClick={() => void browse(listing.cwd, listing.nextCursor!)}>加载更多文件夹</button>}
      </div>
      <button className="primary add-project" disabled={busy || !listing?.canRegister} onClick={() => void add()}><Icon name="plus"/>{projects.projects.some(p => p.cwd === listing?.cwd && p.available !== false) ? '选择此项目' : '添加当前文件夹为项目'}</button>
      <details className="registered-projects"><summary>已添加的项目 · {projects.projects.length}</summary><p>移除仅取消项目注册，保留主机文件和原生会话。</p>{projects.projects.map(project => <div key={project.cwd}><span className="path">{project.cwd}{project.available === false && <small> · 目录失效，请移除后重新添加</small>}</span><button aria-label={`移除项目 ${project.cwd}`} disabled={busy} onClick={() => void remove(project.cwd)}>移除</button></div>)}</details>
    </div>
  </dialog>;
}
