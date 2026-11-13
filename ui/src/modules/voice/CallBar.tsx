import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Hand, Mic, MicOff, PhoneOff } from 'lucide-react';
import { Button, cx } from '../../components/ui';

/**
 * A running call is a small bar, never a window over the chat: it sits just above the message field (or at the
 * bottom of a page without one), so typing, scrolling and switching chats go on while you talk. Nothing behind it is
 * dimmed or blocked, and it never takes the focus.
 */

/** Composer action without anything to see: tells the bar where the message field is (see useDock). */
export function CallDockAnchor() {
  return <span hidden data-tb-call-dock="" />;
}

interface Dock {
  left: number;
  width: number;
  bottom: number;
}

/** Where the bar goes: right above the message field of the chat that is open, else bottom centre of the page. */
function useDock(): CSSProperties {
  const [dock, setDock] = useState<Dock | null>(null);
  useEffect(() => {
    const read = () => {
      let el: HTMLElement | null = document.querySelector<HTMLElement>('[data-tb-call-dock]')?.parentElement || null;
      while (el && !el.querySelector('textarea')) el = el.parentElement;
      const r = el?.getBoundingClientRect();
      const next: Dock | null = r && r.width > 120 && r.top > 80 ? { left: Math.round(r.left), width: Math.round(r.width), bottom: Math.round(window.innerHeight - r.top + 8) } : null;
      setDock((cur) => (cur?.left === next?.left && cur?.width === next?.width && cur?.bottom === next?.bottom ? cur : next));
    };
    read();
    // The field grows while you type and moves when you switch chats or pages: follow it.
    const timer = window.setInterval(read, 250);
    window.addEventListener('resize', read);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('resize', read);
    };
  }, []);
  if (dock) return { left: dock.left, width: dock.width, bottom: dock.bottom };
  return { left: '50%', transform: 'translateX(-50%)', width: 'min(560px, calc(100vw - 24px))', bottom: 'calc(var(--safe-bottom, 0px) + 12px)' };
}

/** The docked, non-modal container of a call (also for "Gesprek beëindigd"). */
export function CallShell({ label, children }: { label: string; children: ReactNode }) {
  const style = useDock();
  return (
    <div role="dialog" aria-label={label} data-testid="call-bar" className="fixed z-40" style={style}>
      <div className="flex max-h-[70vh] flex-col-reverse overflow-hidden rounded-2xl border border-line bg-surface shadow-xl">{children}</div>
    </div>
  );
}

function Meter({ level, on }: { level?: number; on: boolean }) {
  if (level === undefined || !on)
    return (
      <span className="flex h-4 w-5 shrink-0 items-center justify-center" aria-hidden="true">
        <span className={cx('h-2 w-2 rounded-full', on ? 'bg-danger motion-safe:animate-pulse' : 'bg-muted')} />
      </span>
    );
  const l = Math.min(1, level * 12);
  return (
    <span className="flex h-4 shrink-0 items-end gap-0.5" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <i key={i} className="block w-[3px] rounded-sm bg-danger transition-[height] duration-75" style={{ height: 3 + Math.max(0, l * 13 - Math.abs(i - 2) * 3) }} />
      ))}
    </span>
  );
}

/**
 * The bar itself: who listens, thinks or speaks, a level meter, mute, interrupt and hang up. `alerts` (a question, an
 * error) show above it; `children` (subtitles and details) only after "Ondertiteling tonen".
 */
export function CallBar(p: {
  label: string;
  face: ReactNode;
  /** One line: who listens, thinks or speaks. */
  status: ReactNode;
  tone?: 'ok' | 'warn';
  meta?: ReactNode;
  /** Microphone level 0..1; undefined: this kind of call does not measure it (a dot shows the microphone is on). */
  level?: number;
  muted: boolean;
  micOff?: boolean;
  onMute(): void;
  onInterrupt?: () => void;
  onHangup(): void;
  alerts?: ReactNode;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(!!p.defaultOpen);
  const micOn = !p.muted && !p.micOff;
  return (
    <CallShell label={p.label}>
      {/* First in the document, last on screen (flex-col-reverse): the status line is what a screen reader meets first. */}
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <div className="shrink-0">{p.face}</div>
        <div className="min-w-0 flex-1">
          <div className={cx('flex items-center gap-1.5 text-sm font-medium leading-tight', p.tone === 'ok' ? 'text-ok' : p.tone === 'warn' ? 'text-warn' : 'text-fg')} role="status" aria-live="polite">
            {p.status}
          </div>
          {p.meta && <div className="truncate text-[11px] text-muted">{p.meta}</div>}
        </div>
        <span className="flex shrink-0 items-center" role="img" aria-label={micOn ? 'Microfoon aan' : 'Microfoon uit'} title={micOn ? 'Microfoon aan' : 'Microfoon uit'}>
          <Meter level={p.level} on={micOn} />
        </span>
        {p.children && (
          <Button variant="ghost" size="icon" aria-expanded={open} aria-label={open ? 'Ondertiteling verbergen' : 'Ondertiteling tonen'} title={open ? 'Ondertiteling verbergen' : 'Ondertiteling tonen'} onClick={() => setOpen(!open)}>
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </Button>
        )}
        <Button variant="secondary" size="icon" className="rounded-full" aria-label={p.muted ? 'Microfoon aanzetten' : 'Dempen'} title={p.muted ? 'Microfoon aanzetten' : 'Dempen'} aria-pressed={p.muted} onClick={p.onMute}>
          {p.muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </Button>
        {p.onInterrupt && (
          <Button variant="secondary" size="icon" className="rounded-full" aria-label="Onderbreken" title="Onderbreken (stopt het antwoord)" onClick={p.onInterrupt}>
            <Hand className="h-4 w-4" />
          </Button>
        )}
        <Button variant="danger" size="icon" className="rounded-full" aria-label="Ophangen" title="Ophangen" onClick={p.onHangup}>
          <PhoneOff className="h-4 w-4" />
        </Button>
      </div>
      {p.alerts}
      {open && p.children && <div className="scroll-thin min-h-0 space-y-2 overflow-y-auto border-b border-line p-3">{p.children}</div>}
    </CallShell>
  );
}
