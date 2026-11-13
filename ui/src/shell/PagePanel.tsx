import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { AppWindow, ArrowLeft, Download, Maximize2, Minimize2, Quote, X } from 'lucide-react';
import { api, fileUrl, on } from '../lib/api';
import { useIsDesktop, useMedia } from '../lib/media';
import { isRtl, t } from '../lib/i18n';
import { Button, cx } from '../components/ui';

/**
 * Pages a bot made or showed (show_html, HTML files in the chat) as tabs in a panel next to the chat: several at once,
 * each tab can be closed, the panel can go full screen. Docked next to the chat on a wide screen, over it on a narrow
 * one, a full-screen sheet on a phone. Every page runs in the same sandbox as in the chat (SandboxedPage): opaque
 * origin, no network, no access to TeamBot. Selecting text in a page offers "Citeren" (quote into the composer).
 */

export interface PageTab {
  id: string;
  name: string;
}
interface ThreadPages {
  tabs: PageTab[];
  active: string | null;
  open: boolean;
}
interface PagesState {
  byThread: Record<string, ThreadPages>;
  full: boolean;
  width: number;
  open(threadId: string, page: PageTab): void;
  close(threadId: string, id: string): void;
  select(threadId: string, id: string): void;
  setOpen(threadId: string, open: boolean): void;
  setFull(full: boolean): void;
  setWidth(w: number): void;
}

const WIDTH_KEY = 'tb_pages_width';
const MIN_W = 360;
const MAX_W = 1100;
const readWidth = () => {
  try {
    return Number(localStorage.getItem(WIDTH_KEY)) || 560;
  } catch {
    return 560;
  }
};
const empty: ThreadPages = { tabs: [], active: null, open: false };

export const usePages = create<PagesState>((set, get) => {
  const put = (threadId: string, f: (p: ThreadPages) => ThreadPages) => set((s) => ({ byThread: { ...s.byThread, [threadId]: f(s.byThread[threadId] || empty) } }));
  return {
    byThread: {},
    full: false,
    width: readWidth(),
    open: (threadId, page) => put(threadId, (p) => ({ tabs: p.tabs.some((x) => x.id === page.id) ? p.tabs : [...p.tabs, page].slice(-8), active: page.id, open: true })),
    close: (threadId, id) =>
      put(threadId, (p) => {
        const i = p.tabs.findIndex((x) => x.id === id);
        const tabs = p.tabs.filter((x) => x.id !== id);
        const active = p.active === id ? (tabs[Math.min(i, tabs.length - 1)]?.id ?? null) : p.active;
        if (!tabs.length && get().full) set({ full: false });
        return { tabs, active, open: p.open && tabs.length > 0 };
      }),
    select: (threadId, id) => put(threadId, (p) => ({ ...p, active: id, open: true })),
    setOpen: (threadId, open) => {
      put(threadId, (p) => ({ ...p, open: open && p.tabs.length > 0 }));
      if (!open) set({ full: false });
    },
    setFull: (full) => set({ full }),
    setWidth: (w) => {
      const width = Math.round(Math.max(MIN_W, Math.min(MAX_W, w)));
      set({ width });
      try {
        localStorage.setItem(WIDTH_KEY, String(width));
      } catch {
        /* private mode: not remembered */
      }
    },
  };
});

// A conversation that is deleted or emptied ("Geschiedenis wissen") takes its pages with it.
const forget = (d: { id?: string }) => {
  if (!d?.id || !usePages.getState().byThread[d.id]) return;
  usePages.setState((s) => {
    const { [d.id!]: _gone, ...rest } = s.byThread;
    return { byThread: rest, full: false };
  });
};
on('thread.deleted', forget);
on('thread.cleared', forget);

/** Open a page from the chat in the panel (adds a tab, or selects it when it is already open). */
export const openPage = (threadId: string, page: PageTab) => usePages.getState().open(threadId, page);

/** "Citeren": put the text into this conversation's composer as a quote (the Composer listens). */
export function quoteToComposer(threadId: string, text: string) {
  window.dispatchEvent(new CustomEvent('tb:quote', { detail: { threadId, text } }));
}

/** Text as a markdown quote ("> …" per line) followed by an empty line for the user's own words. */
export function asQuote(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').trim().split('\n');
  return lines.map((l) => (l.trim() ? `> ${l.trimEnd()}` : '>')).join('\n') + '\n\n';
}

/**
 * One bot-made page in its sandbox: a short-lived signed URL whose own CSP makes it opaque and network-less, and an
 * iframe without allow-same-origin (security rules: docs/THREAT_MODEL.md T13). With `threadId`, selected text can be
 * quoted: the page's helper (server/api/preview.ts) posts the selection; only messages from this very frame count.
 */
export function SandboxedPage({ id, name, threadId, className, onQuoted }: { id: string; name: string; threadId?: string; className?: string; onQuoted?(): void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    let alive = true;
    setErr('');
    api
      .post<{ url: string }>(`/attachments/${id}/preview`)
      .then((r) => alive && setUrl(r.url))
      .catch((e) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [id]);
  useEffect(() => {
    if (!threadId) return;
    let raf = 0;
    let latest: any = null;
    const apply = () => {
      raf = 0;
      const d = latest;
      const text = typeof d?.text === 'string' ? d.text.slice(0, 4000) : '';
      const el = box.current;
      if (!text.trim() || !el) return setSel(null);
      const w = el.clientWidth;
      const h = el.clientHeight;
      const r = d.rect && [d.rect.x, d.rect.y, d.rect.w, d.rect.h].every((v: unknown) => typeof v === 'number' && isFinite(v as number)) ? d.rect : null;
      // Above the selection, centred; below it when there is no room above; always inside the page.
      const x = r ? Math.max(6, Math.min(w - 112, r.x + r.w / 2 - 50)) : w - 118;
      const y = r ? (r.y > 46 ? r.y - 42 : Math.min(h - 44, r.y + r.h + 8)) : 8;
      setSel({ text, x, y: Math.max(6, y) });
    };
    const f = (e: MessageEvent) => {
      // Only this frame (opaque origin "null"), only the selection message; anything else is ignored.
      if (!frame.current || e.source !== frame.current.contentWindow || e.origin !== 'null') return;
      if (!e.data || typeof e.data !== 'object' || e.data.tb !== 'selection') return;
      latest = e.data;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    window.addEventListener('message', f);
    return () => {
      window.removeEventListener('message', f);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [threadId]);
  return (
    <div ref={box} className={cx('relative bg-white', className)}>
      {err && <div className="p-3 text-xs text-danger">Pagina laden mislukt: {err}</div>}
      {url && <iframe ref={frame} title={name} sandbox="allow-scripts" src={url} referrerPolicy="no-referrer" className="block h-full w-full border-0 bg-white" />}
      {sel && threadId && (
        <button
          type="button"
          className="absolute z-10 inline-flex h-9 items-center gap-1.5 rounded-full bg-fg px-3.5 text-[13px] font-semibold text-canvas shadow-xl hover:opacity-90 coarse:h-11"
          // the page reports physical coordinates (also in a right-to-left interface)
          style={{ left: sel.x, top: sel.y }}
          title="De geselecteerde tekst als citaat in je bericht zetten"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            quoteToComposer(threadId, sel.text);
            setSel(null);
            onQuoted?.();
          }}
        >
          <Quote className="h-3.5 w-3.5" aria-hidden /> Citeren
        </button>
      )}
    </div>
  );
}

/** Wide enough to dock the panel next to the chat (sidebar + at least CHAT_MIN for the chat + the panel). */
export const DOCK_QUERY = '(min-width: 1280px)';
/** The chat keeps at least this width next to a docked panel (its header must fit); the panel gives way first. */
export const CHAT_MIN = 600;

/** Is the panel docked next to this chat right now (open, not full screen, wide screen, no inspector in the way)? */
export function usePagesDocked(threadId: string, canDock: boolean): boolean {
  const open = usePages((s) => !!s.byThread[threadId]?.open && !!s.byThread[threadId]?.tabs.length && !s.full);
  const wide = useMedia(DOCK_QUERY);
  return open && wide && canDock;
}

/** Header button of a chat with open pages: shows or hides the panel. */
export function PagePanelButton({ threadId }: { threadId: string }) {
  const p = usePages((s) => s.byThread[threadId]);
  if (!p?.tabs.length) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="tb-tip aria-pressed:bg-surface-3 aria-pressed:text-fg"
      aria-label={p.tabs.length === 1 ? 'Pagina naast de chat' : `Pagina's naast de chat (${p.tabs.length})`}
      aria-pressed={p.open}
      onClick={() => usePages.getState().setOpen(threadId, !p.open)}
    >
      <AppWindow className="size-icon" />
    </Button>
  );
}

/**
 * The panel itself, rendered by the chat next to the conversation (one element, so pages never reload on resize).
 * `canDock`: false while the chat's own side panel (inspector) is open; then the pages lie over the chat instead.
 */
export function PagePanel({ threadId, canDock = true }: { threadId: string; canDock?: boolean }) {
  const p = usePages((s) => s.byThread[threadId]);
  const full = usePages((s) => s.full);
  const width = usePages((s) => s.width);
  const desktop = useIsDesktop();
  const wide = useMedia(DOCK_QUERY) && canDock;
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const open = !!p?.open && p.tabs.length > 0;
  const sheet = !desktop;
  const docked = desktop && wide && !full;
  useEffect(() => {
    if (open) titleRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('[role="dialog"][aria-modal="true"]:not([data-pages])')) return;
      if (usePages.getState().full) usePages.getState().setFull(false);
      else if (!docked) usePages.getState().setOpen(threadId, false);
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [open, docked, threadId]);
  if (!p?.tabs.length) return null;
  const st = usePages.getState();
  const close = () => st.setOpen(threadId, false);
  const active = p.tabs.find((x) => x.id === p.active) || p.tabs[0];
  const overlay = full || sheet || !wide;
  return (
    <>
      {open && desktop && !wide && !full && <div className="fixed inset-0 z-30 bg-black/40" onClick={close} aria-hidden />}
      <aside
        data-pages
        role={overlay && open ? 'dialog' : undefined}
        aria-modal={overlay && open ? true : undefined}
        aria-label="Pagina's van de bot"
        className={cx(
          'flex flex-col bg-surface',
          !open && 'hidden',
          full || sheet ? 'safe-top safe-bottom safe-x fixed inset-0 z-50 bg-canvas' : docked ? 'relative h-full border-s border-line' : 'fixed inset-y-0 end-0 z-40 w-[min(680px,94vw)] border-s border-line shadow-2xl',
        )}
        // docked: the stored width as flex basis; it shrinks (down to MIN_W) so the chat keeps CHAT_MIN
        style={docked ? { flex: `0 1 ${width}px`, minWidth: MIN_W } : undefined}
      >
        {docked && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Breedte van het paginapaneel"
            aria-valuemin={MIN_W}
            aria-valuemax={MAX_W}
            aria-valuenow={width}
            tabIndex={0}
            className="group absolute inset-y-0 -start-1.5 z-10 w-3 cursor-col-resize touch-none outline-none"
            onPointerDown={(e) => {
              drag.current = { x: e.clientX, w: width };
              setDragging(true);
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            // The panel sits at the end side: dragging towards the start (left, or right in RTL) makes it wider.
            onPointerMove={(e) => drag.current && st.setWidth(drag.current.w + (drag.current.x - e.clientX) * (isRtl() ? -1 : 1))}
            onPointerUp={() => ((drag.current = null), setDragging(false))}
            onPointerCancel={() => ((drag.current = null), setDragging(false))}
            onKeyDown={(e) => {
              const wider = isRtl() ? 'ArrowRight' : 'ArrowLeft';
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') st.setWidth(width + (e.key === wider ? 40 : -40));
            }}
          >
            <span className={cx('absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full transition-colors', dragging ? 'bg-fg/40' : 'bg-transparent group-hover:bg-line-strong group-focus-visible:bg-fg/40')} />
          </div>
        )}
        <div className={cx('flex shrink-0 items-center gap-1.5 border-b border-line px-2', sheet ? 'h-[60px]' : 'h-14')}>
          {sheet && (
            <Button variant="ghost" size="icon" aria-label="Terug naar het gesprek" onClick={close}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
          )}
          <h2 ref={titleRef} tabIndex={-1} className="sr-only">
            Pagina&apos;s van de bot
          </h2>
          <div className="scroll-thin flex min-w-0 flex-1 gap-1 overflow-x-auto py-1" role="group" aria-label="Open pagina's">
            {p.tabs.map((x) => (
              <div key={x.id} className={cx('flex h-8 min-w-0 max-w-[220px] shrink-0 items-center rounded-lg coarse:h-10', x.id === active.id ? 'bg-surface-3 text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg')}>
                <button type="button" aria-pressed={x.id === active.id} title={x.name} onClick={() => st.select(threadId, x.id)} className={cx('flex h-full min-w-0 items-center gap-1.5 ps-2.5 pe-1 text-[12.5px]', x.id === active.id && 'font-semibold')}>
                  <AppWindow className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="truncate" translate="no">
                    {x.name}
                  </span>
                </button>
                <button type="button" aria-label={t('{0} sluiten', x.name)} title="Tabblad sluiten" onClick={() => st.close(threadId, x.id)} className="me-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-surface-2 coarse:h-9 coarse:w-9">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          <a className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-fg coarse:h-11 coarse:w-11" href={fileUrl(active.id, true)} aria-label={t('{0} downloaden', active.name)} title="Downloaden">
            <Download className="h-4 w-4" />
          </a>
          {desktop && (
            <Button variant="ghost" size="icon" aria-label={full ? 'Kleiner' : 'Volledig scherm'} title={full ? 'Terug naast de chat (Esc)' : 'Volledig scherm'} onClick={() => st.setFull(!full)}>
              {full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
          )}
          {!sheet && (
            <Button variant="ghost" size="icon" aria-label="Paginapaneel sluiten" onClick={close}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        <p className="shrink-0 border-b border-line px-3 py-1.5 text-[11.5px] text-muted">Afgeschermd en zonder internet. Selecteer tekst om die te citeren in je bericht.</p>
        <div className="relative min-h-0 flex-1">
          {p.tabs.map((x) => (
            <SandboxedPage key={x.id} id={x.id} name={x.name} threadId={threadId} className={cx('absolute inset-0', x.id !== active.id && 'invisible')} onQuoted={() => (sheet || full) && (st.setFull(false), sheet && close())} />
          ))}
        </div>
      </aside>
    </>
  );
}
