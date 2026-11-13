import { useEffect, useId, useRef, useState } from 'react';
import { ChevronRight, Gauge, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { cx, useAsync } from '../../components/ui';
import { Pop } from '../../components/Menu';
import { ProviderMark } from '../../components/ProviderMark';
import { t } from '../../lib/i18n';
import { useLiveUsageBar, useUsageBar } from './api';
import { meterItems, type MeterItem, type MeterTone, type RingPart } from './meter';

/** At most this many rings in the footer; the rest is counted ("+2") and listed behind that button. */
const MAX_RINGS = 4;
/** The popover of "+2": the list of the providers that have no ring of their own in the footer. */
const MORE = '+';

const STROKE: Record<MeterTone, string> = { calm: 'text-muted', warn: 'text-warn-strong', danger: 'text-danger', unknown: 'text-muted' };
const FILL: Record<MeterTone, string> = { calm: 'bg-muted', warn: 'bg-warn-strong', danger: 'bg-danger', unknown: 'bg-muted' };
const WORDS: Record<MeterTone, string> = { calm: 'text-fg', warn: 'text-warn', danger: 'text-danger', unknown: 'text-muted' };

/** One circle of a ring: the track, and the used part from the top, clockwise. */
function Arc({ part, r, c, stroke }: { part: RingPart; r: number; c: number; stroke: number }) {
  const v = part.value;
  // Without a number but with a warning (a source "bijna op"): the track itself in the warning colour.
  const toneTrack = v === null && (part.tone === 'warn' || part.tone === 'danger');
  return (
    <>
      <circle
        cx={c}
        cy={c}
        r={r}
        fill="none"
        strokeWidth={stroke}
        stroke="currentColor"
        className={toneTrack ? STROKE[part.tone] : 'text-line-strong'}
        opacity={toneTrack ? 1 : 0.7}
        strokeDasharray={part.dashed ? '2 2.6' : undefined}
      />
      {v !== null && v > 0 && (
        <circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          stroke="currentColor"
          className={cx(STROKE[part.tone], 'transition-[stroke-dashoffset] duration-500')}
          strokeDasharray={2 * Math.PI * r}
          strokeDashoffset={2 * Math.PI * r * (1 - Math.max(3, Math.min(100, v)) / 100)}
        />
      )}
    </>
  );
}

/**
 * One subscription or provider as a ring: the week outside, the 5 hours inside (when it has one), and in the middle
 * the provider's own mark, or its initial when TeamBot has no mark for it. Decorative: the button around it and the
 * popover say the same in words.
 */
export function MeterRing({ item, size = 28 }: { item: Pick<MeterItem, 'outer' | 'inner' | 'mono' | 'mark'>; size?: number }) {
  const big = size >= 36;
  const stroke = big ? 3 : 2.5;
  const c = size / 2;
  const rOuter = c - stroke / 2;
  const rInner = rOuter - stroke - 1;
  const letters = item.mono.length > 1;
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} aria-hidden>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <Arc part={item.outer} r={rOuter} c={c} stroke={stroke} />
        {item.inner && <Arc part={item.inner} r={rInner} c={c} stroke={stroke} />}
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-fg">
        {item.mark ? (
          // Two rings leave less room in the middle.
          <ProviderMark id={item.mark} size={big ? (item.inner ? 14 : 16) : item.inner ? 11 : 12} />
        ) : (
          <span className={cx('font-bold leading-none', letters ? (big ? 'text-[11px] tracking-tight' : 'text-[8.5px] tracking-tight') : big ? 'text-[13px]' : 'text-[10px]')} translate="no">
            {item.mono}
          </span>
        )}
      </span>
    </span>
  );
}

/** The slim bar of one line in the popover (decorative: the sentence under it carries the meaning). */
export function SlimBar({ part }: { part: RingPart }) {
  const v = part.value;
  return (
    <span aria-hidden className={cx('relative block h-1 min-w-8 flex-1 overflow-hidden rounded-full', part.dashed ? 'border border-dashed border-line-strong' : 'bg-surface-3')}>
      {v !== null && v > 0 && <span className={cx('block h-full rounded-full transition-[width] duration-500', FILL[part.tone])} style={{ width: `${Math.max(3, Math.min(100, v))}%` }} />}
    </span>
  );
}

/** The sentence of one window ("Nog 62%, weer vol om do 09:00."), in its tone; bold when it warns. */
export function LineSentence({ line, estimated, className }: { line: MeterItem['lines'][number]; estimated?: boolean; className: string }) {
  return (
    <span
      className={cx('text-[13px] leading-snug', className, WORDS[line.part.tone], line.part.tone !== 'calm' && line.part.tone !== 'unknown' && 'font-semibold')}
      title={estimated ? t('≈ is een schatting: de aanbieder geeft geen exact cijfer.') : undefined}
    >
      {line.sentence}
    </span>
  );
}

const iconBtn = 'flex size-8 shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-2 hover:text-fg active:bg-surface-3 coarse:size-11';

/** The details of one provider: its windows, what is left, when each is full again. */
export function Detail({ item, titleId, reading, onRefresh }: { item: MeterItem; titleId: string; reading: boolean; onRefresh?: () => void }) {
  return (
    <>
      <div className="flex items-center gap-3">
        <MeterRing item={item} size={32} />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-sm font-semibold leading-5" translate="no">
            {item.name}
          </h2>
          {item.sub && (
            <div className="truncate text-xs leading-4 text-muted" translate="no">
              {item.sub}
            </div>
          )}
        </div>
        {onRefresh && (
          // aria-disabled, not disabled: a focused button that becomes disabled drops the focus, and that would close
          // the popover (focus leaving it closes it).
          <button type="button" onClick={() => !reading && onRefresh()} aria-disabled={reading || undefined} aria-label="Vernieuwen" className={cx(iconBtn, 'tb-tip tb-tip-end -me-1 aria-disabled:opacity-60')}>
            <RefreshCw className={cx('size-icon', reading && 'animate-spin')} aria-hidden />
          </button>
        )}
      </div>
      <ul className="mt-3 space-y-3">
        {item.lines.map((l) => (
          <li key={l.key}>
            {/* No number (a free source that is simply available): the sentence alone, never an empty bar. */}
            {(l.name || l.part.value !== null || l.part.dashed) && (
              <span className="mb-1.5 flex items-center gap-2">
                {l.name && <span className="w-14 shrink-0 truncate text-xs text-muted">{l.name}</span>}
                <SlimBar part={l.part} />
              </span>
            )}
            <LineSentence line={l} estimated={item.estimated} className="block" />
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * The usage meters in the sidebar footer: one ring per subscription or provider (outer = week, inner = 5 hours), calm
 * grey until 75%, amber from 75%, red from 90%. Every ring is its own button and opens the details of that provider
 * only: a slim bar and one plain sentence per window ("Nog 62%, weer vol om do 09:00.") and a refresh button. More
 * providers than fit: "+2" opens the list of the rest. The gauge at the end goes to the full usage page. Nothing to
 * show (no subscription, no free source): nothing in the footer.
 */
export function UsageMeter({ className }: { className?: string }) {
  const bar = useLiveUsageBar();
  const load = useUsageBar((s) => s.load);
  const refreshAll = useUsageBar((s) => s.refreshAll);
  /** The key of the provider whose details are open, MORE for the list of the rest, or null. */
  const [open, setOpen] = useState<string | null>(null);
  /** What the closing popover still shows during its exit animation. */
  const [last, setLast] = useState<string | null>(null);
  const { busy, run } = useAsync();
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  /** The button that opened the popover: Escape puts the focus back on it. */
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const panelId = useId();

  const show = (key: string | null) => {
    if (key) setLast(key);
    setOpen(key);
  };
  const close = (focus = true) => {
    show(null);
    if (focus) opener.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!open) return;
    panel.current?.focus({ preventScroll: true });
    const away = (e: Event) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(null);
    document.addEventListener('mousedown', away);
    document.addEventListener('touchstart', away);
    return () => (document.removeEventListener('mousedown', away), document.removeEventListener('touchstart', away));
  }, [open]);

  if (!bar || (!bar.engines.length && !bar.sources.length)) return null;
  const items = meterItems(bar);
  const shown = items.slice(0, MAX_RINGS);
  const rest = items.slice(MAX_RINGS);
  const view = open || last;
  const current = view && view !== MORE ? items.find((i) => i.key === view) : undefined;
  const engine = current && bar.engines.find((e) => e.providerId === current.key);
  const reading = busy || (current ? !!engine?.reading : bar.engines.some((e) => e.reading));
  const refreshOne = (id: string) => run(async () => (await api.post(`/usage/limits/${id}/refresh`), await load()));
  const toggle = (key: string, e: React.MouseEvent<HTMLElement>) => {
    opener.current = e.currentTarget;
    show(open === key ? null : key);
  };
  const ringBtn = 'tb-tip tb-tip-up tb-tip-start flex size-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-surface-2 active:bg-surface-3 aria-expanded:bg-surface-3 coarse:size-11';

  return (
    <div
      ref={wrap}
      // Not `relative`: the popover anchors to the sidebar's footer (shell/Sidebar.tsx) and opens above the whole footer,
      // so it never half-covers the row of fixed places right above the rings (they stay full-size targets).
      className={cx('flex items-center gap-0.5', className)}
      role="group"
      aria-label="Gebruik"
      // A popover, not a modal: tabbing out of it closes it (the focus is somewhere else then).
      onBlur={(e) => open && e.relatedTarget && !wrap.current?.contains(e.relatedTarget as Node) && setOpen(null)}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return;
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
    >
      {shown.map((i) => (
        // The ring in words (it is decorative): "Claude nog 62%", "Codex op", "Groq beschikbaar".
        <button key={i.key} type="button" data-usage-meter={i.key} aria-haspopup="dialog" aria-expanded={open === i.key} aria-controls={open === i.key ? panelId : undefined} aria-label={i.summary} onClick={(e) => toggle(i.key, e)} className={ringBtn}>
          <MeterRing item={i} />
        </button>
      ))}
      {rest.length > 0 && (
        <button
          type="button"
          data-usage-more
          aria-haspopup="dialog"
          aria-expanded={open === MORE || rest.some((i) => i.key === open)}
          aria-controls={open === MORE ? panelId : undefined}
          aria-label={t('{0, plural, one {Nog # aanbieder} other {Nog # aanbieders}}', rest.length)}
          onClick={(e) => toggle(MORE, e)}
          className="tb-tip tb-tip-up flex h-9 min-w-8 shrink-0 items-center justify-center rounded-full px-1.5 text-[12px] coarse:h-11 font-semibold tabular-nums text-muted transition-colors hover:bg-surface-2 hover:text-fg active:bg-surface-3 aria-expanded:bg-surface-3 aria-expanded:text-fg"
        >
          +{rest.length}
        </button>
      )}
      <a href="#/m/usage/" aria-label="Gebruik en limieten" onClick={() => setOpen(null)} className={cx(iconBtn, 'tb-tip tb-tip-up tb-tip-end ms-auto size-9')}>
        <Gauge className="size-icon" aria-hidden />
      </a>

      <Pop
        ref={panel}
        open={!!open}
        origin="bottom left"
        id={panelId}
        role="dialog"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="scroll-thin absolute inset-x-2 bottom-full z-40 mb-2 max-h-[min(70vh,480px)] overflow-y-auto p-3"
      >
        {current ? (
          <Detail item={current} titleId={titleId} reading={reading} onRefresh={engine?.canRead ? () => void refreshOne(engine.providerId) : undefined} />
        ) : (
          <>
            <div className="flex items-center gap-2 ps-1">
              <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-semibold">
                Meer aanbieders
              </h2>
              {bar.engines.some((e) => e.canRead) && (
                <button type="button" onClick={() => !reading && void run(refreshAll)} aria-disabled={reading || undefined} aria-label="Vernieuwen" className={cx(iconBtn, 'tb-tip tb-tip-end aria-disabled:opacity-60')}>
                  <RefreshCw className={cx('size-icon', reading && 'animate-spin')} aria-hidden />
                </button>
              )}
            </div>
            <ul className="mt-1">
              {rest.map((i) => (
                <li key={i.key}>
                  <button type="button" onClick={() => show(i.key)} className="flex min-h-11 w-full items-center gap-3 rounded-control px-1 py-1.5 text-start transition-colors hover:bg-surface-2 active:bg-surface-3">
                    <MeterRing item={i} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold leading-5" translate="no">
                        {i.name}
                      </span>
                      <span className={cx('block truncate text-xs leading-4', i.lines[0]?.part.tone === 'warn' || i.lines[0]?.part.tone === 'danger' ? WORDS[i.lines[0].part.tone] : 'text-muted')}>{i.lines[0]?.sentence}</span>
                    </span>
                    <ChevronRight className="size-icon shrink-0 text-muted" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="-mx-1 -mb-1 mt-3 border-t border-line pt-1">
          <a href="#/m/usage/" onClick={() => close(false)} className="flex min-h-9 items-center justify-between gap-2 rounded-control px-2 text-[13px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg coarse:min-h-11">
            Alle limieten en verbruik per bot
            <ChevronRight className="size-icon shrink-0" aria-hidden />
          </a>
        </div>
      </Pop>
    </div>
  );
}
