import React, { useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useApp } from '../../lib/store';
import type { Agent } from '../../lib/types';
import { uiLocale } from '../../lib/i18n';
import { BotAvatar } from '../../components/BotFace';
import { Badge, cx, listTime } from '../../components/ui';
import type { Mood } from '../../lib/botface';

/** Bots write each other's names into the tables ("Baas", " SEO & Content"): compare loosely. */
export const nameKey = (s: unknown) =>
  String(s ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export function useBotsByName(): Map<string, Agent> {
  const agents = useApp((s) => s.agents);
  return useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents) if (!m.has(nameKey(a.name)) || !a.archived) m.set(nameKey(a.name), a);
    return m;
  }, [agents]);
}

/** A bot named in a table: its own face when it is one of your bots, otherwise a neutral face from the name. */
export function BotName({ name, size = 22, mood, className, bold = true }: { name: string; size?: number; mood?: Mood; className?: string; bold?: boolean }) {
  const bots = useBotsByName();
  const bot = bots.get(nameKey(name));
  const label = String(name || '').trim() || 'onbekend';
  return (
    <span className={cx('inline-flex min-w-0 items-center gap-1.5', className)}>
      <BotAvatar bot={bot || { name: label }} size={size} mood={mood} />
      <span className={cx('truncate', bold && 'font-semibold text-fg')} translate="no">
        {label}
      </span>
    </span>
  );
}

/** Times as bots write them ("2026-11-06 23:06:03", local time) or ISO. */
export function parseTime(s: unknown): Date | null {
  const v = String(s ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const d = new Date(v.length === 10 ? `${v}T00:00:00` : v.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function When({ value, className }: { value: unknown; className?: string }) {
  const d = parseTime(value);
  if (!d) return value ? <span className={className}>{String(value)}</span> : null;
  return (
    <time dateTime={d.toISOString()} title={d.toLocaleString(uiLocale())} className={cx('whitespace-nowrap', className)}>
      {listTime(d.toISOString())}
    </time>
  );
}

export function dateLabel(s: unknown): string {
  const d = parseTime(s);
  return d ? d.toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) : String(s ?? '');
}

const URL_RE = /(https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?])/g;

/** Plain text with clickable web links (opened in a new tab). Everything else stays text. */
export function Linkified({ text, className }: { text: unknown; className?: string }) {
  const s = String(text ?? '');
  const parts = s.split(URL_RE);
  return (
    <span className={cx('whitespace-pre-wrap [overflow-wrap:anywhere]', className)} translate="no">
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p} target="_blank" rel="noreferrer noopener" className="underline decoration-line-strong underline-offset-2 hover:decoration-current">
            {p}
          </a>
        ) : (
          <React.Fragment key={i}>{p}</React.Fragment>
        ),
      )}
    </span>
  );
}

/** Long text, folded to a few lines with "Lees meer". */
export function Fold({ text, lines = 3, className, min = 220 }: { text: unknown; lines?: 2 | 3 | 4 | 6; className?: string; min?: number }) {
  const s = String(text ?? '');
  const [open, setOpen] = useState(false);
  const long = s.length > min || s.split('\n').length > lines;
  const clamp = { 2: 'line-clamp-2', 3: 'line-clamp-3', 4: 'line-clamp-4', 6: 'line-clamp-6' }[lines];
  if (!s.trim()) return null;
  return (
    <div className={className}>
      <div className={cx(!open && long && clamp)}>
        <Linkified text={s} />
      </div>
      {long && (
        <button type="button" className="mt-1 text-xs font-semibold text-muted underline-offset-2 hover:text-fg hover:underline" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Minder' : 'Lees meer'}
        </button>
      )}
    </div>
  );
}

/** Search field that reports after a short pause. */
export function SearchBox({ value, onChange, placeholder = 'Zoeken', label, className }: { value: string; onChange(v: string): void; placeholder?: string; label: string; className?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  useEffect(() => {
    if (v === value) return;
    const t = setTimeout(() => onChange(v), 280);
    return () => clearTimeout(t);
  }, [v]);
  return (
    <div className={cx('relative min-w-0', className)} role="search">
      <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && (setV(''), onChange(''))}
        placeholder={placeholder}
        aria-label={label}
        className="h-9 w-full rounded-[10px] border border-line bg-surface-2 ps-8 pe-8 text-sm outline-none placeholder:text-muted hover:border-line-strong focus:border-muted focus:bg-surface coarse:h-11"
      />
      {v && (
        <button type="button" onClick={() => (setV(''), onChange(''))} className="absolute end-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted hover:text-fg" aria-label="Zoekterm wissen">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/** Small pill filters ("Alles · Open · …"); scrolls sideways on a phone instead of widening the page. */
export function Chips<T extends string>({ value, onChange, items, label }: { value: T; onChange(v: NoInfer<T>): void; items: { id: NoInfer<T>; label: React.ReactNode; count?: number }[]; label: string }) {
  return (
    <div className="scroll-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label={label}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          aria-pressed={value === it.id}
          onClick={() => onChange(it.id)}
          className={cx(
            'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] transition-colors coarse:h-10',
            value === it.id ? 'border-transparent bg-accent font-semibold text-accent-fg' : 'border-line bg-surface font-medium text-muted hover:text-fg',
          )}
        >
          {it.label}
          {it.count !== undefined && <span className={cx('tabular-nums', value === it.id ? 'opacity-80' : 'text-muted')}>{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

const TASK_STATUS: Record<string, { label: string; tone: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' }> = {
  open: { label: 'Open', tone: 'neutral' },
  bezig: { label: 'Bezig', tone: 'accent' },
  klaar: { label: 'Klaar', tone: 'ok' },
  // Written by the one task board (#/tasks) for its column "Geblokkeerd".
  geblokkeerd: { label: 'Geblokkeerd', tone: 'danger' },
  geannuleerd: { label: 'Geannuleerd', tone: 'neutral' },
  vervallen: { label: 'Vervallen', tone: 'neutral' },
  gekozen: { label: 'Gekozen', tone: 'ok' },
  beslist: { label: 'Beslist', tone: 'ok' },
  besloten: { label: 'Besloten', tone: 'ok' },
  loopt: { label: 'Loopt', tone: 'accent' },
  bewezen: { label: 'Bewezen', tone: 'ok' },
  werkt_niet: { label: 'Werkt niet', tone: 'danger' },
  gestopt: { label: 'Gestopt', tone: 'neutral' },
  voorstel: { label: 'Voorstel', tone: 'neutral' },
};

/** Status of a row; any "wacht_op_…" status means: waits for you. */
export function statusInfo(s: unknown) {
  const v = String(s ?? '').trim();
  if (v === 'wacht_op_controle') return { label: 'Te controleren', tone: 'warn' as const };
  if (v === 'kon_niet') return { label: 'Kon niet', tone: 'danger' as const };
  if (v.startsWith('wacht_op')) return { label: 'Wacht op jou', tone: 'warn' as const };
  return TASK_STATUS[v] || { label: v ? v.replace(/_/g, ' ') : '—', tone: 'neutral' as const };
}

export function StatusBadge({ status }: { status: unknown }) {
  const i = statusInfo(status);
  return <Badge tone={i.tone}>{i.label}</Badge>;
}

/** Label + value rows in a detail view (only filled values). */
export function Fields({ items }: { items: [string, React.ReactNode][] }) {
  const list = items.filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false);
  if (!list.length) return null;
  return (
    <dl className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
      {list.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** A block of longer text in a detail view. */
export function Block({ title, text }: { title: string; text: unknown }) {
  if (text === null || text === undefined || !String(text).trim()) return null;
  return (
    <section className="space-y-1">
      <h3 className="text-[12px] font-bold uppercase tracking-wider text-muted">{title}</h3>
      <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm leading-relaxed">
        <Linkified text={text} />
      </div>
    </section>
  );
}

/** Columns a view does not show itself (a bot may have added its own). */
export function extraColumns(row: Record<string, any>, known: string[]): [string, any][] {
  return Object.entries(row).filter(([k, v]) => !known.includes(k) && v !== null && v !== '');
}
