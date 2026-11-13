import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { CircleCheck, FlaskConical, ScrollText, Undo2, Waypoints } from 'lucide-react';
import { Badge, Button, EmptyState, Select, Spinner, cx, toastError, useAsync } from '../../components/ui';
import { type EventPage, type LogPage, type Row, teamApi, useTeamChanged } from './api';
import { Block, BotName, Chips, Fields, Fold, Linkified, SearchBox, StatusBadge, When, dateLabel, extraColumns, nameKey, parseTime, statusInfo, useBotsByName } from './parts';
import { t, uiLocale } from '../../lib/i18n';
import { formatNumber } from '../../lib/format';

function Loading() {
  return (
    <div className="flex justify-center py-10">
      <Spinner />
    </div>
  );
}

/** Paged list state: first page with filters, "Meer laden" appends (keyset paging on id). */
function usePaged<P extends { rows: Row[]; next: number | null }>(fetch: (before: number) => Promise<P>, deps: any[], tables: string[]) {
  const [page, setPage] = useState<P | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const { busy, run } = useAsync();
  const first = () =>
    fetch(0)
      .then((p) => (setPage(p), setRows(p.rows)))
      .catch((e) => (toastError(e), setRows([]), setPage({ rows: [], next: null } as any)));
  useEffect(() => {
    setPage(null);
    void first();
  }, deps);
  useTeamChanged(tables, () => void first());
  const more = async () => {
    const next = page?.next;
    if (!next) return;
    await run(async () => {
      const p = await fetch(next);
      setRows((r) => [...r, ...p.rows]);
      setPage((cur) => (cur ? { ...cur, next: p.next } : p));
    });
  };
  return { page, rows, more, busy };
}

function MoreButton({ next, busy, onClick, shown, total }: { next: number | null; busy: boolean; onClick(): void; shown: number; total: number | null }) {
  if (!next) return total && shown ? <p className="py-2 text-center text-xs text-muted">Alle {total.toLocaleString(uiLocale())} getoond</p> : null;
  return (
    <div className="flex flex-col items-center gap-1 py-2">
      <Button onClick={onClick} loading={busy}>
        Meer laden
      </Button>
      {total !== null && (
        <span className="text-xs text-muted">
          {t('{0} van {1}', shown.toLocaleString(uiLocale()), total.toLocaleString(uiLocale()))}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Logboek

function LogItem({ r }: { r: Row }) {
  const [open, setOpen] = useState(false);
  const details = !!(r.bewijs || r.terugdraaien || extraColumns(r, ['id', 'agent', 'site', 'wat', 'waarom', 'bewijs', 'terugdraaien', 'tijd']).length);
  return (
    <li className="px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <BotName name={r.agent} size={20} />
        {r.site && (
          <span className="max-w-[14rem] truncate rounded-full bg-surface-3 px-2 py-0.5 text-[11.5px] font-semibold" translate="no">
            {r.site}
          </span>
        )}
        <When value={r.tijd} className="ms-auto" />
      </div>
      <div className="mt-1.5 text-sm font-medium leading-snug">
        <Fold text={r.wat} lines={3} min={260} />
      </div>
      {r.waarom && (
        <div className="mt-0.5 text-[13px] leading-snug text-muted">
          <span className="font-semibold">Waarom: </span>
          <Linkified text={r.waarom} />
        </div>
      )}
      {details && (
        <>
          <button type="button" className="mt-1.5 text-xs font-semibold text-muted hover:text-fg" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Verberg bewijs' : r.terugdraaien ? 'Bewijs en terugdraaien' : 'Bewijs'}
          </button>
          {open && (
            <div className="mt-2 space-y-2">
              <Block title="Bewijs" text={r.bewijs} />
              {r.terugdraaien && (
                <section className="space-y-1">
                  <h3 className="flex items-center gap-1 text-[12px] font-bold uppercase tracking-wider text-muted">
                    <Undo2 className="h-3 w-3" aria-hidden /> Terugdraaien
                  </h3>
                  <div className="rounded-xl bg-surface-2 px-3 py-2.5 font-mono text-[12.5px] leading-relaxed">
                    <Linkified text={r.terugdraaien} />
                  </div>
                </section>
              )}
              <Fields items={extraColumns(r, ['id', 'agent', 'site', 'wat', 'waarom', 'bewijs', 'terugdraaien', 'tijd']).map(([k, v]) => [k, <Linkified text={v} />] as [string, ReactNode])} />
            </div>
          )}
        </>
      )}
    </li>
  );
}

/** Logboek: every real change a bot made — who, where, what, why, evidence and how to undo it. */
export function LogTab() {
  const [q, setQ] = useState('');
  const [agent, setAgent] = useState('');
  const [site, setSite] = useState('');
  const { page, rows, more, busy } = usePaged<LogPage>((before) => teamApi.log({ q, agent, site, before, limit: 50 }), [q, agent, site], ['logboek']);
  const [agents, setAgents] = useState<LogPage['agents']>(null);
  const [sites, setSites] = useState<LogPage['sites']>(null);
  useEffect(() => {
    if (page?.agents && !agent && !site && !q) setAgents(page.agents);
    if (page?.sites && !agent && !site && !q) setSites(page.sites);
  }, [page]);
  if (!page) return <Loading />;
  const empty = !rows.length && !q && !agent && !site;
  if (empty)
    return (
      <EmptyState icon={<ScrollText />} title="Het logboek is nog leeg">
        Elke echte wijziging die een bot doorvoert (een prijs, een feed, code, een verstuurd bericht) komt hier, met waarom, het bewijs en hoe je hem terugdraait.
      </EmptyState>
    );
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <SearchBox value={q} onChange={setQ} label="Logboek doorzoeken" placeholder="Zoek op wat, waarom, bewijs of site" className="md:w-80" />
        <div className="flex min-w-0 gap-2">
          <Select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Filter op bot" className="w-auto min-w-0 max-w-[12rem]">
            <option value="">Alle bots</option>
            {(agents || []).map((a) => (
              <option key={a.v || ''} value={a.v || ''}>
                {a.v} ({a.n})
              </option>
            ))}
          </Select>
          <Select value={site} onChange={(e) => setSite(e.target.value)} aria-label="Filter op site" className="w-auto min-w-0 max-w-[12rem]">
            <option value="">Alle sites</option>
            {(sites || []).map((s) => (
              <option key={s.v || ''} value={s.v || ''}>
                {s.v} ({s.n})
              </option>
            ))}
          </Select>
        </div>
        {page.total !== null && <span className="text-xs text-muted md:ms-auto">{t('{0, plural, one {# wijziging} other {# wijzigingen}}', formatNumber(page.total))}</span>}
      </div>
      {!rows.length ? (
        <EmptyState title="Niets gevonden">Probeer een ander woord of zet een filter uit.</EmptyState>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {rows.map((r) => (
            <LogItem key={r.id} r={r} />
          ))}
        </ul>
      )}
      <MoreButton next={page.next} busy={busy} onClick={more} shown={rows.length} total={page.total} />
    </div>
  );
}

// ---------------------------------------------------------------- Gebeurtenissen

const SOORT: Record<string, string> = { klantbericht: 'Klantbericht', besluit: 'Besluit', wijziging: 'Wijziging', testresultaat: 'Testresultaat', audit: 'Audit', onderzoek: 'Onderzoek' };
const soortLabel = (s: unknown) => {
  const v = String(s ?? '');
  if (v.startsWith('bericht_')) return 'Bericht van jou';
  return SOORT[v] || v.replace(/[_-]/g, ' ');
};

function EventItem({ r }: { r: Row }) {
  const bots = useBotsByName();
  const fromBot = bots.has(nameKey(r.bron));
  return (
    <li className="px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <Badge tone={r.soort === 'klantbericht' ? 'accent' : 'neutral'}>{soortLabel(r.soort)}</Badge>
        {r.dossier && (
          <span className="max-w-[16rem] truncate font-mono text-[11.5px]" translate="no" title={String(r.dossier)}>
            {r.dossier}
          </span>
        )}
        {r.bron && (fromBot ? <BotName name={r.bron} size={18} /> : <span translate="no">{r.bron}</span>)}
        <span className="ms-auto flex items-center gap-2">
          {Number(r.verwerkt) ? (
            <span className="inline-flex items-center gap-1 text-ok">
              <CircleCheck className="h-3.5 w-3.5" aria-hidden /> verwerkt
            </span>
          ) : (
            <Badge tone="warn">nog te verwerken</Badge>
          )}
          <When value={r.tijd} />
        </span>
      </div>
      <div className="mt-1.5 text-sm leading-snug">
        <Fold text={r.samenvatting} lines={3} min={260} />
      </div>
    </li>
  );
}

/** Gebeurtenissen: what came in or happened, per dossier; "verwerkt" once the dossier was updated. */
export function EventsTab() {
  const [q, setQ] = useState('');
  const [soort, setSoort] = useState('');
  const [verwerkt, setVerwerkt] = useState<'' | '0' | '1'>('');
  const { page, rows, more, busy } = usePaged<EventPage>((before) => teamApi.events({ q, soort, verwerkt, before, limit: 50 }), [q, soort, verwerkt], ['gebeurtenissen']);
  const [soorten, setSoorten] = useState<EventPage['soorten']>(null);
  useEffect(() => {
    if (page?.soorten && !soorten) setSoorten(page.soorten);
  }, [page]);
  if (!page) return <Loading />;
  if (!rows.length && !q && !soort && !verwerkt)
    return (
      <EmptyState icon={<Waypoints />} title="Nog geen gebeurtenissen">
        Klantberichten, besluiten, wijzigingen en testresultaten komen hier, per dossier.
      </EmptyState>
    );
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <SearchBox value={q} onChange={setQ} label="Gebeurtenissen doorzoeken" placeholder="Zoek in samenvatting, dossier of bron" className="md:w-80" />
        <Chips
          label="Verwerkt"
          value={verwerkt}
          onChange={setVerwerkt}
          items={[
            { id: '', label: 'Alles' },
            { id: '0', label: 'Nog te verwerken' },
            { id: '1', label: 'Verwerkt' },
          ]}
        />
        {page.total !== null && <span className="text-xs text-muted md:ms-auto">{t('{0, plural, one {# gebeurtenis} other {# gebeurtenissen}}', formatNumber(page.total))}</span>}
      </div>
      {soorten && soorten.length > 1 && <Chips label="Soort" value={soort} onChange={setSoort} items={[{ id: '', label: 'Alle soorten' }, ...soorten.map((s) => ({ id: s.v || '', label: soortLabel(s.v), count: s.n }))]} />}
      {!rows.length ? (
        <EmptyState title="Niets gevonden">Probeer een ander woord of zet een filter uit.</EmptyState>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {rows.map((r) => (
            <EventItem key={r.id} r={r} />
          ))}
        </ul>
      )}
      <MoreButton next={page.next} busy={busy} onClick={more} shown={rows.length} total={page.total} />
    </div>
  );
}

// ---------------------------------------------------------------- Experimenten

const EXP_KNOWN = ['id', 'vak', 'hypothese', 'bron', 'sites', 'controle', 'meting', 'beginwaarde', 'meetdatum', 'terugdraaien', 'eigenaar', 'status', 'uitkomst', 'aangemaakt'];

function MeasureDate({ value, running }: { value: unknown; running: boolean }) {
  const d = parseTime(value);
  if (!d) return value ? <span>Meten: {String(value)}</span> : null;
  const days = Math.round((new Date(d.toDateString()).getTime() - new Date(new Date().toDateString()).getTime()) / 864e5);
  const when = days === 0 ? 'vandaag' : days === 1 ? 'morgen' : days > 1 ? t('over {0, plural, one {# dag} other {# dagen}}', days) : t('{0, plural, =1 {gisteren} one {# dag geleden} other {# dagen geleden}}', -days);
  return (
    <span className={cx(running && days < 0 && 'font-semibold text-warn')}>
      Meten op {dateLabel(value)} ({when})
    </span>
  );
}

function ExperimentCard({ r }: { r: Row }) {
  const [open, setOpen] = useState(false);
  const running = r.status === 'loopt';
  return (
    <article className="min-w-0 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <StatusBadge status={r.status} />
        {r.vak && <Badge>{r.vak}</Badge>}
        <span className="ms-auto tabular-nums">#{r.id}</span>
      </div>
      <h3 className="mt-2 text-sm font-semibold leading-snug">
        <Fold text={r.hypothese} lines={4} min={300} />
      </h3>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        {r.eigenaar && <BotName name={r.eigenaar} size={18} />}
        <MeasureDate value={r.meetdatum} running={running} />
      </div>
      {r.uitkomst && (
        <div className="mt-2 rounded-xl bg-surface-2 px-3 py-2 text-[13px]">
          <span className="font-semibold">Uitkomst: </span>
          <Linkified text={r.uitkomst} />
        </div>
      )}
      <button type="button" className="mt-2 text-xs font-semibold text-muted hover:text-fg" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Minder' : 'Meting, beginwaarde en meer'}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <Fields
            items={[
              ['Sites', r.sites ? <Linkified text={r.sites} /> : null],
              ['Meting', r.meting ? <Linkified text={r.meting} /> : null],
              ['Beginwaarde', r.beginwaarde ? <Linkified text={r.beginwaarde} /> : null],
              ['Controle', r.controle ? <Linkified text={r.controle} /> : null],
              ['Bron', r.bron ? <Linkified text={r.bron} /> : null],
              ['Terugdraaien', r.terugdraaien ? <Linkified text={r.terugdraaien} /> : null],
              ['Gestart', r.aangemaakt ? dateLabel(r.aangemaakt) : null],
              ...extraColumns(r, EXP_KNOWN).map(([k, v]) => [k, <Linkified text={v} />] as [string, ReactNode]),
            ]}
          />
        </div>
      )}
    </article>
  );
}

/** Experimenten: hypotheses with how and when they are measured; running ones first, overdue measurements flagged. */
export function ExperimentsTab() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [status, setStatus] = useState('loopt');
  const load = () =>
    teamApi
      .experiments()
      .then(setRows)
      .catch((e) => (toastError(e), setRows([])));
  useEffect(() => void load(), []);
  useTeamChanged(['experimenten'], () => void load());
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows || []) m.set(String(r.status || ''), (m.get(String(r.status || '')) || 0) + 1);
    return m;
  }, [rows]);
  if (!rows) return <Loading />;
  if (!rows.length)
    return (
      <EmptyState icon={<FlaskConical />} title="Nog geen experimenten">
        Wil een bot iets uitproberen (een titel, een prijs, een campagne), dan legt hij hier de hypothese, de meting en de meetdatum vast, en later de uitkomst.
      </EmptyState>
    );
  const cur = counts.has(status) || status === '' ? status : '';
  const list = rows
    .filter((r) => !cur || String(r.status || '') === cur)
    .sort((a, b) => String(a.meetdatum || '9999').localeCompare(String(b.meetdatum || '9999')));
  const order = ['loopt', 'bewezen', 'werkt_niet', 'gestopt'];
  const keys = [...counts.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  return (
    <div className="space-y-3">
      <Chips
        label="Status"
        value={cur}
        onChange={setStatus}
        items={[...keys.map((k) => ({ id: k, label: statusInfo(k).label, count: counts.get(k) })), { id: '', label: 'Alles', count: rows.length }]}
      />
      <div className="grid items-start gap-3 md:grid-cols-2">
        {list.map((r) => (
          <ExperimentCard key={r.id} r={r} />
        ))}
      </div>
    </div>
  );
}
