import { useEffect, useRef, useState } from 'react';
import { Minus, MoveHorizontal, Plus } from 'lucide-react';
// pdf.js (Apache-2.0): renders pdf pages into canvases. Loaded only when a pdf is opened (own chunk).
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Button, Spinner } from './ui';
import { t } from '../lib/i18n';

GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_PAGES = 300;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/**
 * Pdf preview: every page as a picture, fit to the width (phone included), lazily rendered while scrolling, with zoom
 * and "page x of y". The text of each page is there for screen readers and Ctrl+F. No scripts or forms in the pdf run.
 */
export default function PdfView({ data, name }: { data: ArrayBuffer; name: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(1);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setDoc(null);
    setError('');
    // pdf.js hands the buffer to its worker; give it a copy so the preview can be opened again.
    const task = getDocument({ data: new Uint8Array(data.slice(0)), useSystemFonts: true, enableXfa: false });
    task.promise.then(
      (d) => alive && setDoc(d),
      (e) => alive && setError(e?.name === 'PasswordException' ? 'Deze pdf is beveiligd met een wachtwoord. Download hem om hem te openen.' : 'Deze pdf kan niet getoond worden (beschadigd of een onbekende soort). Download hem om hem te openen.'),
    );
    return () => {
      alive = false;
      void task.destroy();
    };
  }, [data]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, Math.floor((el.clientWidth - 16) / 8) * 8)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc]);

  if (error)
    return (
      <p role="alert" className="text-sm text-muted">
        {error}
      </p>
    );
  if (!doc)
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  const pages = Math.min(doc.numPages, MAX_PAGES);
  const zi = ZOOMS.indexOf(zoom);
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <span aria-live="polite">
          {t('Pagina {0} van {1}', current, doc.numPages)}
        </span>
        <span className="ms-auto inline-flex items-center gap-1">
          <Button size="icon" variant="ghost" aria-label="Kleiner" disabled={zi <= 0} onClick={() => setZoom(ZOOMS[zi - 1])}>
            <Minus className="h-4 w-4" />
          </Button>
          <span className="w-11 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <Button size="icon" variant="ghost" aria-label="Groter" disabled={zi >= ZOOMS.length - 1} onClick={() => setZoom(ZOOMS[zi + 1])}>
            <Plus className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" icon={<MoveHorizontal className="h-4 w-4" />} disabled={zoom === 1} onClick={() => setZoom(1)}>
            Passend
          </Button>
        </span>
      </div>
      <div ref={box} data-testid="pdf-pages" className="scroll-thin min-h-0 flex-1 overflow-auto rounded-lg bg-surface-3 p-2" aria-label={`Pdf ${name}, ${doc.numPages} ${doc.numPages === 1 ? 'pagina' : "pagina's"}`} role="document">
        {width > 0 && (
          <div className="flex flex-col items-center gap-3" style={{ minWidth: Math.round(width * zoom) }}>
            {Array.from({ length: pages }, (_, i) => (
              <PdfPage key={i} doc={doc} n={i + 1} total={doc.numPages} width={Math.round(width * zoom)} onSeen={setCurrent} />
            ))}
            {doc.numPages > pages && <p className="py-2 text-xs text-muted">Alleen de eerste {MAX_PAGES} pagina’s worden getoond. Download de pdf voor de rest.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function PdfPage({ doc, n, total, width, onSeen }: { doc: PDFDocumentProxy; n: number; total: number; width: number; onSeen(n: number): void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const task = useRef<RenderTask | null>(null);
  const [ratio, setRatio] = useState(1.414);
  const [near, setNear] = useState(n <= 2);
  const [text, setText] = useState('');
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    let alive = true;
    doc.getPage(n).then((p) => {
      if (!alive) return;
      const vp = p.getViewport({ scale: 1 });
      setRatio(vp.height / vp.width);
    }, () => {});
    return () => {
      alive = false;
    };
  }, [doc, n]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          if (e.isIntersecting) setNear(true);
          if (e.intersectionRatio >= 0.5) onSeen(n);
        }
      },
      { rootMargin: '600px 0px', threshold: [0, 0.5] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [n, onSeen]);

  useEffect(() => {
    if (!near || !width) return;
    let alive = true;
    (async () => {
      // One render per canvas at a time: wait until a previous one (other zoom/width) has stopped.
      const prev = task.current;
      if (prev) {
        prev.cancel();
        await prev.promise.catch(() => {});
      }
      const page = await doc.getPage(n);
      const c = canvas.current;
      if (!alive || !c) return;
      const base = page.getViewport({ scale: 1 });
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const vp = page.getViewport({ scale: (width / base.width) * dpr });
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      const t = page.render({ canvas: c, viewport: vp });
      task.current = t;
      await t.promise;
      if (alive) setDrawn(true);
      if (alive && !text) {
        const tc = await page.getTextContent();
        if (alive) setText(tc.items.map((i: any) => (typeof i.str === 'string' ? i.str + (i.hasEOL ? '\n' : ' ') : '')).join('').slice(0, 50_000));
      }
    })().catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, width, doc, n]);

  return (
    <div ref={wrap} className="relative shrink-0 bg-white shadow-sm ring-1 ring-black/10" style={{ width, height: Math.round(width * ratio) }}>
      <canvas ref={canvas} role="img" aria-label={`Pagina ${n} van ${total}`} className="block h-full w-full" />
      {!drawn && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner />
        </div>
      )}
      {text && <div className="sr-only">{text}</div>}
    </div>
  );
}
