import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

// Canvas only: no viewer HTML, annotations, links, forms, attachments or scripting.
export function ArtifactPdf({ blob }: { blob: Blob }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true, loading: ReturnType<typeof getDocument> | undefined;
    const timeout = window.setTimeout(() => { if (alive) { setError('PDF 预览超时，可下载后用系统阅读器打开。'); void loading?.destroy(); } }, 12000);
    setError(''); setReady(false); setDocument(undefined); setPage(1);
    void blob.arrayBuffer().then(data => {
      if (!alive) return;
      loading = getDocument({ data: new Uint8Array(data), enableXfa: false, useWorkerFetch: false,
        useWasm: false, disableFontFace: true, useSystemFonts: true, stopAtErrors: true, maxImageSize: 4_000_000,
        canvasMaxAreaInBytes: 16_000_000, isOffscreenCanvasSupported: false, isImageDecoderSupported: false });
      return loading.promise.then(pdf => { window.clearTimeout(timeout); if (alive) setDocument(pdf); });
    }).catch(() => { if (alive) setError('此 PDF 暂无法预览，可下载后用系统阅读器打开。'); });
    return () => { alive = false; window.clearTimeout(timeout); void loading?.destroy(); };
  }, [blob]);
  useEffect(() => {
    if (!document || !canvas.current) return;
    let alive = true, task: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    setReady(false);
    const timeout = window.setTimeout(() => { if (alive) { task?.cancel(); void document.loadingTask.destroy(); setError('PDF 预览超时，可下载后用系统阅读器打开。'); } }, 12000);
    void document.getPage(page).then(async pdfPage => {
      if (!alive || !canvas.current) return;
      const natural = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(2, 1000 / natural.width, 1400 / natural.height);
      const viewport = pdfPage.getViewport({ scale });
      if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) throw new Error();
      const target = canvas.current; target.width = Math.ceil(viewport.width); target.height = Math.ceil(viewport.height);
      task = pdfPage.render({ canvas: target, viewport }); await task.promise;
      if (alive) { setReady(true); pdfPage.cleanup(); }
    }).catch(() => { if (alive) setError('此页暂无法预览，可下载后用系统阅读器打开。'); })
      .finally(() => window.clearTimeout(timeout));
    return () => { alive = false; window.clearTimeout(timeout); task?.cancel(); };
  }, [document, page]);
  return <div className="artifact-pdf">{error ? <p role="status">{error}</p> : <>
    {document && <div className="artifact-pdf-pages"><button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button><span>{page} / {document.numPages}</span><button disabled={page >= document.numPages} onClick={() => setPage(p => p + 1)}>下一页</button></div>}
    {!ready && <p role="status">正在绘制 PDF…</p>}<canvas ref={canvas} aria-label={`PDF 第 ${page} 页`} data-ready={ready}/>
  </>}</div>;
}
