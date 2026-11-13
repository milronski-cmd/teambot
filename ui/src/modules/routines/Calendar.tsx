import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Hourglass, Plus } from 'lucide-react';
import { api, on } from '../../lib/api';
import { t, uiLocale } from '../../lib/i18n';
import { capFirst } from '../../lib/format';
import { useIsDesktop } from '../../lib/media';
import { navigate } from '../../lib/router';
import { Badge, Button, Card, EmptyState, Page, PageHeader, cx, CardHead } from '../../components/ui';
import { Skeleton, SkeletonRows } from '../../components/overview';
import { Segmented } from '../../components/SettingControls';
import { RUN_STATUS } from './lib';

/**
 * #/m/routines/kalender (A-78): the routines per week or month. Planned runs come from each active routine's schedule
 * (a waitpoint shows its moment or deadline); what already happened shows as dots with the status in words. On a
 * computer a grid with a few readable entries per day (the day itself lists everything); on a phone an agenda.
 */
interface Planned {
  routineId: string;
  name: string;
  agentId: string;
  at: string;
  waitpoint: boolean;
}
interface PastRun {
  id: string;
  routineId: string;
  name: string;
  status: string;
  trigger: string;
  at: string;
  summary: string;
}
interface CalendarData {
  from: string;
  to: string;
  timezone: string;
  planned: Planned[];
  runs: PastRun[];
  capped: string[];
}
interface DayEntries {
  planned: Planned[];
  runs: PastRun[];
}

type Mode = 'week' | 'month';
const pad = (n: number) => String(n).padStart(2, '0');
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** Monday of the week of `d`. */
const weekStart = (d: Date) => {
  const s = startOfDay(d);
  return new Date(s.getFullYear(), s.getMonth(), s.getDate() - ((s.getDay() + 6) % 7));
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function range(mode: Mode, anchor: Date): { from: Date; to: Date; days: Date[] } {
  const from = mode === 'week' ? weekStart(anchor) : weekStart(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  const last = mode === 'week' ? addDays(from, 6) : (() => {
    const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    return addDays(weekStart(end), 6);
  })();
  const days: Date[] = [];
  for (let d = from; d <= last; d = addDays(d, 1)) days.push(d);
  return { from, to: addDays(last, 1), days };
}

/** Status dot colour; the status is always also in words (title, screen reader, day list). */
const DOT: Record<string, string> = { ok: 'bg-ok', danger: 'bg-danger', warn: 'bg-warn', accent: 'bg-fg', neutral: 'bg-line-strong' };
const time = (iso: string) => new Date(iso).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' });
const runTone = (status: string) => (RUN_STATUS[status]?.tone === 'accent' ? 'neutral' : RUN_STATUS[status]?.tone || 'neutral');
const NONE: DayEntries = { planned: [], runs: [] };

/**
 * A routine that runs three times or more on one day (every hour, every two hours) is ONE line for that day
 * ("12× Inbox nalopen") instead of twelve, so a month stays readable; fewer runs keep their own time.
 */
interface PlanLine {
  first: Planned;
  last: Planned;
  n: number;
}
function planLines(planned: Planned[]): PlanLine[] {
  const by = new Map<string, Planned[]>();
  for (const p of planned) by.set(p.routineId, [...(by.get(p.routineId) || []), p]);
  const out: PlanLine[] = [];
  for (const list of by.values()) {
    if (list.length >= 3) out.push({ first: list[0], last: list[list.length - 1], n: list.length });
    else for (const p of list) out.push({ first: p, last: p, n: 1 });
  }
  return out.sort((a, b) => a.first.at.localeCompare(b.first.at));
}

/** What already happened on a day, as dots; in words for a screen reader and on hover. */
function Dots({ runs }: { runs: PastRun[] }) {
  if (!runs.length) return null;
  const words = Object.entries(runs.reduce<Record<string, number>>((acc, x) => ((acc[RUN_STATUS[x.status]?.label || x.status] = (acc[RUN_STATUS[x.status]?.label || x.status] || 0) + 1), acc), {}))
    .map(([k, n]) => `${n}× ${k.toLowerCase()}`)
    .join(', ');
  return (
    <span className="mt-auto flex flex-wrap items-center gap-1 pt-1" title={words}>
      {runs.slice(0, 8).map((x) => (
        <span key={x.id} className={cx('h-1.5 w-1.5 rounded-full', DOT[RUN_STATUS[x.status]?.tone || 'neutral'])} aria-hidden />
      ))}
      {runs.length > 8 && <span className="text-[11px] text-muted" aria-hidden>+{runs.length - 8}</span>}
      <span className="sr-only">Gebeurd: {words}</span>
    </span>
  );
}

/** Everything of one day: what is planned and what happened, each a link to its routine. */
function DayList({ e }: { e: DayEntries }) {
  if (!e.planned.length && !e.runs.length) return <p className="text-sm text-muted">Niets gepland en niets gebeurd.</p>;
  return (
    <ul className="space-y-2">
      {e.runs.slice(0, 50).map((x) => (
        <li key={x.id} className="flex items-baseline gap-2.5 text-sm">
          <span className="w-11 shrink-0 tabular-nums text-muted">{time(x.at)}</span>
          <span className="min-w-0 flex-1">
            <a className="font-medium [overflow-wrap:anywhere] hover:underline" href={`#/m/routines/r/${x.routineId}?tab=history`} title={x.summary} translate="no">
              {x.name}
            </a>{' '}
            <Badge tone={runTone(x.status)}>{RUN_STATUS[x.status]?.label || x.status}</Badge>
          </span>
        </li>
      ))}
      {planLines(e.planned).map(({ first: p, last, n }) => (
        <li key={p.routineId + p.at} className="flex items-baseline gap-2.5 text-sm">
          <span className="w-11 shrink-0 tabular-nums text-muted">{time(p.at)}</span>
          <span className="min-w-0 flex-1">
            <a className="font-medium [overflow-wrap:anywhere] hover:underline" href={`#/m/routines/r/${p.routineId}`} translate="no">
              {p.name}
            </a>
            {n > 1 && <span className="text-muted"> · {t('{0}×, tot {1}', n, time(last.at))}</span>}
            {p.waitpoint && (
              <>
                {' '}
                <Badge>wachtpunt</Badge>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function CalendarPage() {
  const desktop = useIsDesktop();
  const [mode, setMode] = useState<Mode>('month');
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [data, setData] = useState<CalendarData | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(() => keyOf(new Date()));
  const [tick, setTick] = useState(0);
  const r = useMemo(() => range(mode, anchor), [mode, anchor]);
  useEffect(() => {
    let live = true;
    setError('');
    api
      .get<CalendarData>(`/routines/calendar?from=${encodeURIComponent(r.from.toISOString())}&to=${encodeURIComponent(r.to.toISOString())}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e?.message || String(e)));
    return () => {
      live = false;
    };
  }, [r.from.getTime(), r.to.getTime(), tick]);
  useEffect(() => on('routine.updated', () => setTick((x) => x + 1)), []);

  const byDay = useMemo(() => {
    const m = new Map<string, DayEntries>();
    const get = (k: string) => m.get(k) || (m.set(k, { planned: [], runs: [] }), m.get(k)!);
    for (const p of data?.planned || []) get(keyOf(new Date(p.at))).planned.push(p);
    for (const x of data?.runs || []) get(keyOf(new Date(x.at))).runs.push(x);
    return m;
  }, [data]);

  const today = keyOf(new Date());
  const move = (dir: number) => setAnchor((a) => (mode === 'week' ? addDays(a, 7 * dir) : new Date(a.getFullYear(), a.getMonth() + dir, 1)));
  const title =
    mode === 'month'
      ? anchor.toLocaleDateString(uiLocale(), { month: 'long', year: 'numeric' })
      : `${r.days[0].toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short' })} – ${r.days[6].toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const empty = data && !data.planned.length && !data.runs.length;
  // How many planned runs a cell names before it says "+2 meer" (the day itself lists them all).
  const perCell = mode === 'week' ? 6 : 2;
  // The agenda (phone): in a month only the days of that month with something on them, today and later first in view.
  const inMonth = r.days.filter((d) => d.getMonth() === anchor.getMonth() && byDay.has(keyOf(d)));
  const agenda = mode === 'week' ? r.days : inMonth.length ? inMonth : r.days.filter((d) => byDay.has(keyOf(d)));

  return (
    <Page>
      <PageHeader
        width="5xl"
        title="Kalender"
        back={{ href: '#/m/routines/', label: 'Automatisch' }}
        actions={
        <div className="flex items-center gap-1">
          <Segmented<Mode>
            label="Periode"
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'week', label: 'Week' },
              { value: 'month', label: 'Maand' },
            ]}
          />
          <Button size="icon" variant="ghost" aria-label={mode === 'week' ? 'Vorige week' : 'Vorige maand'} onClick={() => move(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button size="sm" onClick={() => (setAnchor(startOfDay(new Date())), setSelected(today))}>
            Vandaag
          </Button>
          <Button size="icon" variant="ghost" aria-label={mode === 'week' ? 'Volgende week' : 'Volgende maand'} onClick={() => move(1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        }
      />
      <div className="mx-auto max-w-5xl space-y-3 px-4 pb-8 pt-4 sm:px-6">
        <h2 className="text-[15px] font-bold tracking-tight" aria-live="polite">
          {capFirst(title)}
        </h2>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : !data ? (
          desktop ? (
            <Skeleton className="h-[30rem] rounded-card" />
          ) : (
            <SkeletonRows n={5} avatar={false} />
          )
        ) : empty ? (
          <EmptyState
            icon={<CalendarDays />}
            title="Niets in deze periode"
            action={
              <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/m/routines/r/new')}>
                Nieuwe routine
              </Button>
            }
          >
            Er is niets gepland en er is niets gebeurd.
          </EmptyState>
        ) : desktop ? (
          <>
            <Card className="tb-in overflow-hidden p-0">
              <div className="grid grid-cols-7 border-b border-line bg-surface-2 text-center text-[12px] font-semibold text-muted" aria-hidden>
                {r.days.slice(0, 7).map((d) => (
                  <div key={d.getDay()} className="py-2">
                    {d.toLocaleDateString(uiLocale(), { weekday: 'short' })}
                  </div>
                ))}
              </div>
              <div className="-mb-px grid grid-cols-7">
                {r.days.map((d) => {
                  const k = keyOf(d);
                  const e = byDay.get(k) || NONE;
                  const lines = planLines(e.planned);
                  const out = mode === 'month' && d.getMonth() !== anchor.getMonth();
                  const label = `${d.toLocaleDateString(uiLocale(), { weekday: 'long', day: 'numeric', month: 'long' })}: ${e.planned.length} gepland, ${e.runs.length} gebeurd`;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setSelected(k)}
                      aria-pressed={selected === k}
                      aria-label={label}
                      className={cx(
                        'flex min-w-0 flex-col items-stretch gap-1 border-b border-r border-line p-2 text-start transition-colors hover:bg-surface-2 [&:nth-child(7n)]:border-r-0',
                        mode === 'week' ? 'min-h-56' : 'min-h-[7.5rem]',
                        out && 'bg-canvas text-muted',
                        selected === k && 'bg-surface-3 hover:bg-surface-3',
                      )}
                    >
                      <span className={cx('flex h-6 w-6 items-center justify-center rounded-full text-[12.5px] font-semibold', k === today && 'bg-accent text-accent-fg')}>{d.getDate()}</span>
                      {lines.slice(0, perCell).map(({ first: p, n }) => (
                        <span key={p.routineId + p.at} className="block text-[12px] leading-[1.35] [overflow-wrap:anywhere]">
                          <span className="tabular-nums text-muted">{n > 1 ? `${n}×` : time(p.at)}</span> {p.waitpoint && <Hourglass className="inline h-3 w-3 align-[-1px] text-muted" aria-label="wachtpunt" />} <span translate="no">{p.name}</span>
                        </span>
                      ))}
                      {lines.length > perCell && <span className="text-[12px] font-medium text-muted">{t('+{0} meer', lines.length - perCell)}</span>}
                      <Dots runs={e.runs} />
                    </button>
                  );
                })}
              </div>
            </Card>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted" aria-hidden>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-ok" /> klaar
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-danger" /> mislukt
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-warn" /> gemist, overgeslagen of limiet
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-line-strong" /> niets nieuws of gestopt
              </span>
              <span className="flex items-center gap-1.5">
                <Hourglass className="h-3 w-3" /> wachtpunt
              </span>
            </div>
            <Card className="space-y-3 p-4" aria-live="polite">
              <CardHead as="h3" icon={CalendarDays} tone="orange" title={capFirst(new Date(selected + 'T12:00').toLocaleDateString(uiLocale(), { weekday: 'long', day: 'numeric', month: 'long' }))} />
              <DayList e={byDay.get(selected) || NONE} />
            </Card>
          </>
        ) : (
          <Card className="tb-in divide-y divide-line p-0">
            {agenda.map((d) => {
              const k = keyOf(d);
              return (
                <section key={k} className="flex gap-3 px-4 py-3" aria-label={d.toLocaleDateString(uiLocale(), { weekday: 'long', day: 'numeric', month: 'long' })}>
                  <div className="w-10 shrink-0 text-center" aria-hidden>
                    <div className="text-[11.5px] font-semibold text-muted">{d.toLocaleDateString(uiLocale(), { weekday: 'short' })}</div>
                    <div className={cx('mx-auto mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-[14px] font-bold', k === today && 'bg-accent text-accent-fg')}>{d.getDate()}</div>
                  </div>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <DayList e={byDay.get(k) || NONE} />
                  </div>
                </section>
              );
            })}
          </Card>
        )}
        {data && data.capped.length > 0 && <p className="text-xs text-muted">Van een routine die heel vaak loopt, staan de eerste 500 runs erin.</p>}
      </div>
    </Page>
  );
}
