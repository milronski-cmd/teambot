import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { BILLING_LABEL, type ModelInfo } from '../lib/types';
import { Input, Spinner, cx } from './ui';
import { Listbox } from './Listbox';
import { t, translate } from '../lib/i18n';
import { Segmented } from './SettingControls';
import { filterSections, isCurrent, modelSections, rowCount, type ModelGroup, type ModelPick } from '../shell/modelSwitch';

/**
 * The model, simple first (0.4.5): "Automatisch" (the engine or provider picks its default model, nothing stored) or
 * "Zelf kiezen", which shows the list (ModelPicker). A stored model opens on "Zelf kiezen".
 */
export function ModelChoice({ models, value, onChange, loading, label = 'Model' }: { models: ModelInfo[]; value: string; onChange(v: string): void; loading?: boolean; label?: string }) {
  const chosen = !!value && value !== 'default';
  const [own, setOwn] = useState(chosen);
  useEffect(() => {
    if (chosen) setOwn(true);
  }, [chosen]);
  return (
    <div className="space-y-2">
      <Segmented
        label={label}
        value={own ? 'own' : 'auto'}
        testId="model-choice"
        options={[
          { value: 'auto', label: 'Automatisch' },
          { value: 'own', label: 'Zelf kiezen' },
        ]}
        onChange={(v) => {
          setOwn(v === 'own');
          if (v === 'auto' && value) onChange('');
        }}
      />
      {own && <ModelPicker models={models} loading={loading} value={value} onChange={onChange} />}
    </div>
  );
}

const CUSTOM = '__custom__';

/** "Opus: altijd de nieuwste (nu Opus 5.5 · claude-opus-5-5) · abonnement" — the billing only when the label lacks it. */
export function modelOptionLabel(m: ModelInfo): string {
  const base = m.label || m.id;
  return m.billing && !base.includes(BILLING_LABEL[m.billing]) ? `${base} · ${BILLING_LABEL[m.billing]}` : base;
}

/**
 * The model of a bot: a real list from the engine (Claude Code: "standaard", the aliases and the full ids it reports;
 * Codex, OpenCode and API providers: their model lists), plus "Ander model" for an id that is not listed. Without a
 * list (still loading, or the engine gives none) it is a plain text field.
 */
export function ModelPicker({ models, value, onChange, loading, placeholder = 'bijv. gpt-5.4-mini' }: { models: ModelInfo[]; value: string; onChange(v: string): void; loading?: boolean; placeholder?: string }) {
  const hasDefault = models.some((m) => m.id === 'default');
  const shown = !value && hasDefault ? 'default' : value;
  const known = !shown || models.some((m) => m.id === shown);
  const [custom, setCustom] = useState(!known);
  useEffect(() => {
    if (known) setCustom(false);
    else if (models.length) setCustom(true);
  }, [known, models.length]);
  if (!models.length) {
    return <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={loading ? 'Modellen laden…' : placeholder} aria-label="Model" translate="no" />;
  }
  return (
    <div className="space-y-2">
      <Listbox
        value={custom ? CUSTOM : shown}
        aria-label="Model"
        onChange={(v) => {
          if (v === CUSTOM) return setCustom(true);
          setCustom(false);
          onChange(v);
        }}
        options={[
          ...(!hasDefault ? [{ value: '', label: translate('Standaard van de engine') }] : []),
          ...models.map((m) => ({ value: m.id, label: modelOptionLabel(m) })),
          { value: CUSTOM, label: translate('Ander model (zelf invullen)…') },
        ]}
      />
      {custom && <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Model-id, precies zoals de engine het noemt" aria-label="Eigen model-id" autoFocus translate="no" />}
    </div>
  );
}

/** From this many rows the list gets a search field. */
const SEARCH_FROM = 9;

/**
 * Every model of every connected AI in one list (the model switcher on top of a chat): grouped per AI with the short
 * label of what it costs, "Automatisch" (the AI picks its model) as the first row of an AI, the AI the bot is on now
 * first, and a search field when the list is long. A pick is the AI and the model together. `groups` comes from
 * GET /api/model-catalog/choices; null = still loading. The list scrolls inside the room its parent gives it (a
 * popover or a sheet); the rows, their order and the search are in shell/modelSwitch.ts.
 */
export function ModelMenu({
  groups,
  value,
  onPick,
  more,
  error,
  autoFocus,
}: {
  groups: ModelGroup[] | null;
  value: { provider_id: string | null; model: string };
  onPick(pick: ModelPick): void;
  /** One quiet line under the list, e.g. to the page where an AI is connected. */
  more?: { href: string; label: string; onClick?(): void };
  /** The list could not be fetched. */
  error?: string;
  /** When the list opens, the focus goes to the search field, or without one to the current row (not on a phone: the keyboard would cover the list). */
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const all = useMemo(() => (groups ? modelSections(groups, value) : []), [groups, value.provider_id, value.model]);
  const search = rowCount(all) >= SEARCH_FROM;
  const shown = useMemo(() => (search ? filterSections(all, query, (b) => `${BILLING_LABEL[b]} ${translate(BILLING_LABEL[b])}`) : all), [all, query, search]);
  const rows = () => [...(root.current?.querySelectorAll<HTMLElement>('[data-model-row]') || [])];
  // Opened: the current choice is in view, and has the focus when there is no search field to type in.
  const ready = !!groups;
  useLayoutEffect(() => {
    if (!ready) return;
    const cur = root.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    cur?.scrollIntoView({ block: 'nearest' });
    if (autoFocus && !search) (cur || rows()[0])?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const inField = e.target instanceof HTMLInputElement;
    const list = rows();
    if (e.key === 'Enter' && inField && query.trim() && list.length) return (e.preventDefault(), list[0].click());
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || (inField && (e.key === 'Home' || e.key === 'End')) || !list.length) return;
    e.preventDefault();
    const i = list.indexOf(document.activeElement as HTMLElement);
    // Up from the first row: back to the search field.
    if (e.key === 'ArrowUp' && i === 0 && search) return root.current?.querySelector<HTMLElement>('input')?.focus();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : e.key === 'ArrowDown' ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1);
    list[next].focus();
  };
  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown} data-testid="model-menu">
      {search && (
        <div className="relative shrink-0 px-1 pb-1.5 pt-1">
          <Search className="pointer-events-none absolute start-3.5 top-1/2 size-icon -translate-y-1/2 text-muted" aria-hidden />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Zoek een model" aria-label="Zoek een model" className="ps-9" autoFocus={autoFocus} autoComplete="off" spellCheck={false} />
        </div>
      )}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Model">
        {!groups && !error && (
          <div className="flex items-center gap-2 px-2.5 py-3 text-sm text-muted" role="status">
            <Spinner /> Modellen laden…
          </div>
        )}
        {error && !groups && <p className="px-2.5 py-3 text-sm text-danger">{error}</p>}
        {groups && !all.length && <p className="px-2.5 py-3 text-sm text-muted">Nog geen AI gekoppeld.</p>}
        {groups && all.length > 0 && !shown.length && <p className="px-2.5 py-3 text-sm text-muted">Geen model gevonden.</p>}
        {shown.map((s) => (
          <div key={s.provider.id} role="group" aria-label={s.provider.name} data-provider={s.provider.id}>
            <div className="flex items-baseline gap-1.5 px-2.5 pb-1 pt-2.5 text-[12px] font-semibold text-muted">
              <span className="min-w-0 truncate" translate="no">
                {s.provider.name}
              </span>
              {s.billing && (
                <>
                  <span aria-hidden>·</span>
                  <span className="shrink-0 font-normal">{BILLING_LABEL[s.billing]}</span>
                </>
              )}
            </div>
            {/* An AI whose list is still being read (the first time a CLI takes seconds); "Automatisch" works meanwhile. */}
            {s.pending && !error && (
              <p className="flex items-center gap-2 px-2.5 pb-1 text-xs text-muted" role="status">
                <Spinner /> Modellen laden…
              </p>
            )}
            {(s.error || (s.pending && !!error)) && <p className="px-2.5 pb-1 text-xs text-muted">Niet bereikbaar</p>}
            {s.rows.map((r) => {
              const cur = isCurrent(s, r, value);
              return (
                <button
                  key={r.model}
                  type="button"
                  role="option"
                  aria-selected={cur}
                  data-model-row
                  data-model={r.model}
                  onClick={() => onPick({ provider_id: s.provider.id, model: r.model })}
                  className={cx(
                    'flex min-h-9 w-full items-center gap-2 rounded-control px-2.5 py-1.5 text-start text-sm outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 active:bg-surface-3 coarse:min-h-11',
                    cur && 'font-semibold',
                  )}
                >
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    <span translate={r.model ? 'no' : undefined}>{r.name}</span>
                    {(r.hint || r.now) && <span className="ms-1.5 text-xs font-normal text-muted">{r.hint || t('nu {0}', r.now!)}</span>}
                  </span>
                  {r.billing && <span className="shrink-0 text-xs font-normal text-muted">{BILLING_LABEL[r.billing]}</span>}
                  {cur && <Check className="size-icon shrink-0" aria-hidden />}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {more && groups && (
        <div className="mt-1 shrink-0 border-t border-line pt-1">
          <a href={more.href} onClick={more.onClick} className="block rounded-control px-2.5 py-1.5 text-[13px] text-muted outline-none transition-colors hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:text-fg coarse:py-3">
            {more.label}
          </a>
        </div>
      )}
    </div>
  );
}
