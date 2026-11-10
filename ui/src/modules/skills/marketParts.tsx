import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Check, Flag, Puzzle, Search, SlidersHorizontal, Store } from 'lucide-react';
import { Button, Card, Field, Input, Modal, Select, Spinner, Textarea, cx, useAsync } from '../../components/ui';
import { Dropdown } from '../../components/SettingControls';
import { Menu, PageLinks, SkeletonCards, type MenuEntry } from '../../components/overview';
import { api } from '../../lib/api';
import { REPORT_REASONS } from './api';
import { isComplete, mergeStable } from './merge';

/** Small building blocks shared by the marketplace tabs (catalog, internet skills, MCP Registry apps). */

// While sources load the page asks again; the server then answers as soon as the next source is in (`early`), or
// after POLL_BUDGET_MS, so new cards show right away without a busy loop.
const POLL_MS = 300;
const POLL_BUDGET_MS = 1500;
const MAX_POLLS = 150;

/**
 * A marketplace list that fills itself in. The first answer comes fast (the cache, plus whatever arrived within the
 * server's short budget); while sources are still loading (`pending`) or being checked (`refreshing`) it asks again,
 * and merges each answer into the cards already shown (same order, new cards at the end), so nothing jumps around.
 * A new `path` (other search or filter) starts over. `reload()` asks again for the same path (merged as well).
 */
export function useFillingList<I, T extends { items: I[]; pending?: string[]; refreshing?: string[]; total?: number }>(path: string, idOf: (i: I) => string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const shownFor = useRef('');
  const idRef = useRef(idOf);
  idRef.current = idOf;
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    setError('');
    const load = (budget?: number) =>
      api
        .get<T>(budget === undefined ? path : `${path}${path.includes('?') ? '&' : '?'}budget=${budget}&early=1`)
        .then((d) => {
          if (!alive) return;
          const same = shownFor.current === path;
          shownFor.current = path;
          setData((prev) => (same && prev ? { ...d, items: mergeStable(prev.items, d.items, (i) => idRef.current(i), isComplete(d)) } : d));
          if ((d.pending?.length || d.refreshing?.length) && polls++ < MAX_POLLS) timer = setTimeout(() => load(POLL_BUDGET_MS), POLL_MS);
        })
        .catch((e) => alive && setError(e.message));
    load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [path, tick]);
  const reload = useCallback(() => setTick((x) => x + 1), []);
  return { data, error, reload };
}

/**
 * The small "bijwerken…" indicator of a filling list. Once it was shown it stays as "Bijgewerkt" (until another
 * search or filter, `resetKey`), so the line never disappears and the cards below never move up.
 */
export function RefreshNote({ label, resetKey, className }: { label: string; resetKey: string; className?: string }) {
  const [seen, setSeen] = useState<string | null>(null);
  useEffect(() => {
    if (label) setSeen(resetKey);
  }, [label, resetKey]);
  const done = !label && seen === resetKey;
  return (
    <span className={cx('inline-flex min-h-4 items-center gap-1.5 text-xs text-muted', className)} role="status" aria-live="polite">
      {label ? (
        <>
          <Spinner className="h-3 w-3" />
          {label}
        </>
      ) : done ? (
        <>
          <Check className="h-3 w-3 text-ok" aria-hidden />
          Bijgewerkt
        </>
      ) : null}
    </span>
  );
}

/** Placeholder cards while the first answer is on its way, in the height of the real cards (so nothing jumps). */
export function LoadingCards({ n = 6 }: { n?: number }) {
  return <SkeletonCards n={n} className="[&>div]:h-[9.25rem]" />;
}

/**
 * The one row of the Marktplaats: what fits your bots, everything there is, and what you already have (the page that
 * was "Mijn skills"). The same row on all three, so it reads as one place.
 */
export function SkillsLinks({ current }: { current: 'recommended' | 'all' | 'installed' }) {
  return (
    <PageLinks
      label="Marktplaats"
      items={[
        { href: '#/m/skills/', label: 'Aanbevolen', icon: <Store aria-hidden />, current: current === 'recommended' },
        { href: '#/m/skills/skills', label: 'Alles', icon: <Search aria-hidden />, current: current === 'all' },
        { href: '#/m/skills/mine', label: 'Geïnstalleerd', icon: <Puzzle aria-hidden />, current: current === 'installed' },
      ]}
    />
  );
}

/** The one signal of a card or row: a small icon and a few words, in the colour of its meaning. */
export function Signal({ tone = 'muted', icon, children, className }: { tone?: 'ok' | 'warn' | 'danger' | 'muted'; icon?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex min-w-0 items-center gap-1 text-start text-xs font-medium [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0', tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : 'text-muted', className)}>
      {icon}
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}

/** A card of the Marktplaats: the whole card opens the details (the title is the button, stretched over the card). */
export const CARD = 'tb-in relative flex h-full min-w-0 flex-col rounded-card border border-line bg-surface p-4 transition-colors hover:border-line-strong';
export const CARD_OPEN = 'min-w-0 text-start font-semibold outline-none after:absolute after:inset-0 after:rounded-card focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-accent';

// The page's one "Meer opties" menu: the tab that is shown adds what is rarely needed there.
const MenuSlot = createContext<(key: string, items: MenuEntry[] | null) => void>(() => {});
export const MarketMenuProvider = MenuSlot.Provider;
export function useMarketMenu(key: string, items: MenuEntry[], deps: unknown[]) {
  const set = useContext(MenuSlot);
  useEffect(() => {
    set(key, items);
    return () => set(key, null);
  }, deps);
}

/** Search plus what narrows a catalogue list: the category, and (only with extra catalogues) a filter menu. */
export function ListTools({ q, setQ, label, category, setCategory, categories, filter, children }: { q: string; setQ(v: string): void; label: string; category: string; setCategory(v: string): void; categories: string[]; filter?: MenuEntry[]; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SearchBox value={q} onChange={setQ} label={label} />
      {children}
      {(categories.length > 1 || !!category) && <Dropdown className="w-full sm:w-auto" label="Categorie" value={category} onChange={setCategory} options={[{ value: '', label: 'Alle categorieën' }, ...categories.map((c) => ({ value: c, label: c }))]} />}
      {!!filter?.length && (
        <Menu label="Filter" variant="secondary" align="start" icon={<SlidersHorizontal className="h-4 w-4" aria-hidden />} items={filter}>
          Filter
        </Menu>
      )}
    </div>
  );
}

export function SearchBox({ value, onChange, label }: { value: string; onChange(v: string): void; label: string }) {
  return (
    <div className="relative min-w-0 basis-full sm:max-w-md sm:flex-1 sm:basis-auto">
      <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
      <Input type="search" className="ps-9" value={value} onChange={(e) => onChange(e.target.value)} placeholder={label} aria-label={label} />
    </div>
  );
}

export function useList<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    if (!path) return;
    api
      .get<T>(path)
      .then((d) => (setData(d), setError('')))
      .catch((e) => setError(e.message));
  }, [path]);
  useEffect(load, [load]);
  return { data, error, reload: load };
}

export function qs(o: Record<string, string>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
}

export function ErrorCard({ error, retry }: { error: string; retry(): void }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-danger">Laden mislukt: {error}</p>
      <Button className="mt-2" size="sm" onClick={retry}>
        Opnieuw proberen
      </Button>
    </Card>
  );
}

export function ReportButton({ type, catalogId, itemId, itemName }: { type: 'skill' | 'bot' | 'app'; catalogId: string; itemId: string; itemName: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const { busy, run } = useAsync();
  return (
    <>
      <Button size="sm" variant="ghost" icon={<Flag className="h-4 w-4" />} onClick={() => setOpen(true)}>
        Melden
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`${itemName} melden`}
        footer={
          <Button variant="primary" loading={busy} disabled={!reason} onClick={() => run(() => api.post('/skills/market/report', { type, catalogId, itemId, itemName, reason, details }).then(() => setOpen(false)), 'Melding verstuurd naar de beheerder')}>
            Versturen
          </Button>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted">De beheerder van deze installatie ziet je melding en kan het item voor iedereen blokkeren.</p>
          <Field label="Reden">
            <Select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">Kies een reden</option>
              {REPORT_REASONS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Toelichting (optioneel)">
            <Textarea rows={3} value={details} onChange={(e) => setDetails(e.target.value)} />
          </Field>
        </div>
      </Modal>
    </>
  );
}

export function Changelog({ items }: { items: { version: string; date: string; notes: string }[] }) {
  if (!items.length) return <p className="text-sm text-muted">Geen wijzigingslog opgegeven.</p>;
  return (
    <ul className="space-y-1 text-sm">
      {items.map((c, i) => (
        <li key={i}>
          <span className="font-medium">{c.version}</span> {c.date && <span className="text-muted">({c.date})</span>} — {c.notes}
        </li>
      ))}
    </ul>
  );
}

export function Meta({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v || '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
