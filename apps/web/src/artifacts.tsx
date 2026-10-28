import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { artifactPreview, type ArtifactEntry, type ArtifactFile, type ArtifactListing, type ArtifactScope } from '../../../packages/shared/artifacts';
import { artifactRequest, readArtifact } from './artifact-client';
import { Message } from './content';
import { Icon } from './icons';
import { androidShell } from './mobile';
import './artifacts.css';

const Pdf = lazy(() => import('./artifact-pdf').then(module => ({ default: module.ArtifactPdf })));
const size = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;

export function Artifacts({ scope, enabled }: { scope: ArtifactScope; enabled: boolean }) {
  const [listing, setListing] = useState<ArtifactListing>();
  const [file, setFile] = useState<ArtifactFile>();
  const [preview, setPreview] = useState<{ blob: Blob; text?: string; url?: string }>();
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [progress, setProgress] = useState<{ received: number; total: number }>();
  const operation = useRef<AbortController | null>(null);
  const host = useRef<HTMLDivElement>(null), detail = useRef<HTMLElement>(null);
  const active = useRef(true);
  const blobUrl = useRef('');
  const clearPreview = () => { if (blobUrl.current) URL.revokeObjectURL(blobUrl.current); blobUrl.current = ''; setPreview(undefined); };
  useEffect(() => { active.current = true; return () => { active.current = false; operation.current?.abort(); if (blobUrl.current) URL.revokeObjectURL(blobUrl.current); }; }, []);
  useEffect(() => { if (!enabled) { operation.current?.abort(); clearPreview(); setFile(undefined); setListing(undefined); } }, [enabled]);
  useEffect(() => {
    if (file) { detail.current?.focus({ preventScroll: true }); host.current?.scrollIntoView({ block: 'start' }); }
  }, [file?.id]);
  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (operation.current || !enabled) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(''); setNotice(''); setProgress(undefined);
    const timeout = window.setTimeout(() => controller.abort('timeout'), 180000);
    try { await work(controller.signal); }
    catch (e) { if (active.current) { if (controller.signal.aborted) setNotice(controller.signal.reason === 'timeout' ? '请求超时，请重试。' : '已取消。'); else setError(e instanceof TypeError ? '连接中断，文件未保存。请检查网络并重试。' : e instanceof Error ? e.message : '文件请求失败，请重试。'); } }
    finally { window.clearTimeout(timeout); operation.current = null; if (active.current) { setBusy(false); setProgress(undefined); } }
  }
  function list(path = '', cursor = '') {
    return run(async signal => {
      const result = await artifactRequest<ArtifactListing>('list', { ...scope, path, cursor }, signal);
      signal.throwIfAborted(); if (!active.current) return;
      clearPreview(); setFile(undefined); setListing(previous => ({ ...result, entries: cursor ? [...(previous?.entries ?? []), ...result.entries] : result.entries }));
    });
  }
  useEffect(() => { if (enabled && scope.cwd && scope.threadId) void list(); }, [enabled]);
  async function receive(selected: ArtifactFile, signal: AbortSignal) {
    setProgress({ received: 0, total: selected.size }); let updated = 0;
    return readArtifact(selected, signal, bytes => { if (active.current && (Date.now() - updated > 60 || bytes === selected.size)) { updated = Date.now(); setProgress({ received: bytes, total: selected.size }); } });
  }
  function choose(entry: ArtifactEntry, action: 'preview' | 'download') {
    return run(async signal => {
      clearPreview(); setFile(undefined);
      const selected = await artifactRequest<ArtifactFile>('select', { ...scope, path: entry.path }, signal);
      signal.throwIfAborted(); if (!active.current) return; setFile(selected);
      if (action === 'preview' && selected.preview) {
        const blob = await receive(selected, signal); signal.throwIfAborted();
        if (!active.current) return;
        if (selected.preview === 'text' || selected.preview === 'markdown') { const text = await blob.text(); signal.throwIfAborted(); if (active.current) setPreview({ blob, text }); }
        else if (selected.preview === 'image') { blobUrl.current = URL.createObjectURL(blob); setPreview({ blob, url: blobUrl.current }); }
        else setPreview({ blob });
      } else if (action === 'download' && !androidShell) await download(selected, signal);
    });
  }
  async function download(selected: ArtifactFile, signal: AbortSignal) {
    const blob = await receive(selected, signal); signal.throwIfAborted(); if (!active.current) return;
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = selected.name; anchor.click();
    // Leave enough time for Electron/Chromium to consume the validated Blob.
    window.setTimeout(() => URL.revokeObjectURL(url), 60000); setNotice('文件已校验并交给系统保存。');
  }
  return <div ref={host} className="artifacts" data-theme-slot="artifacts">
    <div className="artifact-toolbar"><div><h2>项目成果</h2><small>当前项目 · 单个文件最多 64 MB</small></div><button className="icon-button" aria-label="刷新成果文件" disabled={busy || !enabled} onClick={() => void list(listing?.path)}><Icon name="refresh" size={17}/></button></div>
    {!enabled ? <p className="artifact-hint">请连接并选择项目会话后查看文件。</p> : <>
      <div className="artifact-location"><button disabled={busy || !listing?.path} onClick={() => void list(listing!.path.split('/').slice(0, -1).join('/'))}><Icon name="back" size={14}/>上一级</button><span title={listing?.path}>{listing?.path || '项目目录'}</span></div>
      {error && <p className="artifact-error" role="alert">{error}</p>}{notice && <p className="artifact-hint" role="status">{notice}</p>}
      {busy && <div className="artifact-transfer" role="status"><span>{progress ? `${size(progress.received)} / ${size(progress.total)}` : '正在读取…'}</span>{progress && <progress aria-label="文件传输进度" max={progress.total || 1} value={progress.received}/>}<button onClick={() => operation.current?.abort()}>取消</button></div>}
      {file && <section ref={detail} tabIndex={-1} className="artifact-detail" aria-label="已选择的成果"><header><strong>{file.name}</strong><small>{file.name.split('.').at(-1)?.toUpperCase()} · {size(file.size)}</small></header><div className="artifact-actions">
        {androidShell ? <><a href={`oraculum://artifact/save/${file.id}`} aria-disabled={busy} onClick={event => { if (busy) event.preventDefault(); }}>保存到设备</a><a href={`oraculum://artifact/share/${file.id}`} aria-disabled={busy} onClick={event => { if (busy) event.preventDefault(); }}>分享</a><a href={`oraculum://artifact/open/${file.id}`} aria-disabled={busy} onClick={event => { if (busy) event.preventDefault(); }}>外部打开</a></> : <button disabled={busy} onClick={() => void run(signal => download(file, signal))}>下载文件</button>}
      </div>{!file.preview && <p className="artifact-hint">此文件提供下载。保存后可用系统应用打开。</p>}
      {preview && (file.preview === 'image' ? <img className="artifact-image" src={preview.url} alt={file.name}/> : file.preview === 'markdown' ? <Message text={preview.text ?? ''}/> : file.preview === 'text' ? <pre className="artifact-text">{preview.text || '（空文件）'}</pre> : <Suspense fallback={<p>正在加载 PDF 预览…</p>}><Pdf blob={preview.blob}/></Suspense>)}
      </section>}
      <div className="artifact-list" aria-label="项目文件">{listing?.entries.map(entry => <article className="artifact-card" key={entry.path}>
        <div className="artifact-file-mark"><Icon name={entry.directory ? 'folder' : 'file'} size={20}/></div><div className="artifact-card-info"><button className="artifact-name" title={entry.path} disabled={busy} onClick={() => void (entry.directory ? list(entry.path) : choose(entry, 'preview'))}>{entry.name}</button><small>{entry.directory ? '文件夹' : `${entry.name.split('.').at(-1)?.toUpperCase()} · ${size(entry.size)}`}</small></div>
        {!entry.directory && <div className="artifact-card-actions">{artifactPreview(entry.mime, entry.size) && <button aria-label={`预览 ${entry.name}`} disabled={busy} onClick={() => void choose(entry, 'preview')}>预览</button>}<button aria-label={`下载 ${entry.name}`} disabled={busy} onClick={() => void choose(entry, 'download')}>下载</button></div>}
      </article>)}</div>
      {listing && !listing.entries.length && !busy && <p className="artifact-hint">此目录暂无可读取的成果文件。</p>}
      {listing?.cursor && <button disabled={busy} onClick={() => void list(listing.path, listing.cursor!)}>加载更多文件</button>}
      {listing?.limited && <p className="artifact-hint">此目录文件较多，仅展示部分结果。请将成果放在更小的目录中查看。</p>}
      <p className="artifact-policy">仅显示项目内允许读取的图片和文档。</p>
    </>}
  </div>;
}
