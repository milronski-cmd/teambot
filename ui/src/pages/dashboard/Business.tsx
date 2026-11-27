import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ArrowDownRight, ArrowUpRight, RefreshCw } from 'lucide-react';
import { api, on } from '../../lib/api';
import { cx } from '../../components/ui';
import { t } from '../../lib/i18n';
import { BarChart, Legend, LineChart, Spark, fmt, useTicker, type ChartSeries, type Unit } from './charts';

/**
 * The business at a glance (24 Nov 2026, the owner: "altijd actueel en mooie grafieken, duidelijke onderscheiding"):
 * one row of headline numbers, each against the period before, then a chart per part of the business, each in its own
 * fixed colour. The server keeps the numbers fresh (server/modules/mcp/business.ts, every 30 minutes); this page asks
 * again every 5 minutes, follows the server's "dashboard.business" event, and says how old what it shows is.
 */

interface Point {
  d: string;
  v: number;
}
interface Series {
  key: string;
  label: string;
  unit: Unit;
  now: Point[];
  before: Point[];
  total: number;
  totalBefore: number;
}
interface Part {
  id: 'omzet' | 'ads' | 'bezoekers' | 'zoeken' | 'bank';
  state: 'ok' | 'off' | 'error';
  note?: string;
  href?: string;
  series: Series[];
  rows?: { label: string; value: number; before?: number; unit: Unit }[];
  extra?: Record<string, number | string>;
}
interface Business {
  days: number;
  from: string;
  to: string;
  at: string;
  parts: Part[];
}

/** "30 dagen", with the plural the language needs. */
const dagen = (n: number) => t('{0, plural, one {# dag} other {# dagen}}', n);

/** Each part of the business keeps one colour everywhere: tile, line and legend. */
const COLOR: Record<Part['id'], string> = { omzet: 'var(--viz-1)', ads: 'var(--viz-2)', bezoekers: 'var(--viz-3)', zoeken: 'var(--viz-4)', bank: 'var(--viz-5)' };
const TITLE: Record<Part['id'], string> = { omzet: 'Omzet', ads: 'Advertenties', bezoekers: 'Bezoekers', zoeken: 'Gevonden in Google', bank: 'Geld in en uit' };

function change(now: number, before: number) {
  if (!before) return null;
  return ((now - before) / Math.abs(before)) * 100;
}

/** Up or down against the period before, in words and an arrow; for costs "up" is not good news, so no green/red. */
function Delta({ now, before, days }: { now: number; before: number; days: number }) {
  const c = change(now, before);
  if (c === null) return <span className="text-[12.5px] text-muted">{now ? 'nieuw deze periode' : 'nog niets'}</span>;
  const up = c >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[12.5px] text-muted" title={`${up ? 'Meer' : 'Minder'} dan de ${dagen(days)} ervoor`}>
      <Icon className="size-3.5" aria-hidden />
      <span className="font-semibold text-fg tabular-nums">
        {up ? '+' : '−'}
        {Math.abs(c) >= 1000 ? '999+' : Math.round(Math.abs(c))}%
      </span>
      <span>vs. {dagen(days)} ervoor</span>
    </span>
  );
}

function Tile({ label, value, color, points, children, testid }: { label: string; value: string; color: string; points?: Point[]; children?: React.ReactNode; testid: string }) {
  return (
    <div className="tb-glass flex min-w-0 flex-col rounded-2xl px-4 pb-3 pt-3.5" data-testid={testid}>
      <div className="flex items-center gap-2 text-[13px] font-medium text-muted">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
        {label}
      </div>
      <div className="mt-1 truncate text-[26px] font-semibold leading-tight tracking-tight tabular-nums">{value}</div>
      <div className="mt-0.5 min-h-[18px]">{children}</div>
      {points && points.length > 1 && <Spark points={points} color={color} className="mt-2" />}
    </div>
  );
}

function Card({ title, color, right, children, testid }: { title: string; color: string; right?: React.ReactNode; children: React.ReactNode; testid: string }) {
  return (
    <section className="tb-glass min-w-0 rounded-2xl p-4" data-testid={testid}>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold">
          <span className="size-2.5 rounded-full" style={{ background: color }} aria-hidden />
          {title}
        </h3>
        <div className="ms-auto">{right}</div>
      </div>
      {children}
    </section>
  );
}

/** A part that shows nothing says why, and where to fix it. */
function Missing({ part }: { part: Part }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl bg-surface-2 px-3.5 py-3 text-[13.5px]">
      <AlertCircle className={cx('mt-0.5 size-4 shrink-0', part.state === 'error' ? 'text-warn' : 'text-muted')} aria-hidden />
      <div className="min-w-0 flex-1">
        <span>{part.note || 'Nog geen cijfers.'}</span>{' '}
        {part.href && (
          <a href={part.href} className="font-semibold underline-offset-2 hover:underline">
            Openen
          </a>
        )}
      </div>
    </div>
  );
}

/** The biggest few rows of a part (sites, ad accounts, accounts) with their number. */
function Rows({ rows, color, max = 5 }: { rows: NonNullable<Part['rows']>; color: string; max?: number }) {
  const top = rows.slice(0, max);
  const big = Math.max(1e-9, ...top.map((r) => Math.abs(r.value)));
  if (!top.length) return null;
  return (
    <ul className="mt-4 space-y-2 border-t border-line pt-3">
      {top.map((r) => (
        <li key={r.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-[13px]">
          <span className="truncate">{r.label}</span>
          <span className="font-semibold tabular-nums">{fmt(r.value, r.unit)}</span>
          <span className="col-span-2 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            <span className="block h-full rounded-full" style={{ width: `${(Math.abs(r.value) / big) * 100}%`, background: color }} />
          </span>
        </li>
      ))}
      {rows.length > max && <li className="text-[12.5px] text-muted">en nog {rows.length - max}</li>}
    </ul>
  );
}

const serie = (p: Part | undefined, key: string) => p?.series.find((s) => s.key === key);
const ago = (at: string) => {
  const m = Math.round((Date.now() - new Date(at).getTime()) / 60_000);
  return m < 1 ? 'zojuist' : m === 1 ? '1 minuut geleden' : m < 60 ? `${m} minuten geleden` : new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

export function BusinessSection() {
  const [days, setDays] = useState<7 | 30 | 90>(() => (Number(localStorage.getItem('tb_dash_days')) as 7 | 30 | 90) || 30);
  const [data, setData] = useState<Business | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useTicker(30_000);

  const load = useCallback(
    async (refresh = false) => {
      setBusy(true);
      try {
        setData(await api.get<Business>(`/dashboard/business?days=${days}${refresh ? '&refresh=1' : ''}`));
        setError('');
      } catch (e: any) {
        setError(e?.message || String(e));
      } finally {
        setBusy(false);
      }
    },
    [days],
  );
  useEffect(() => {
    localStorage.setItem('tb_dash_days', String(days));
    load();
    const t = setInterval(() => load(), 5 * 60_000);
    const off = on('dashboard.business', (d: any) => d?.days === days && load());
    return () => (clearInterval(t), off());
  }, [days, load]);

  const part = (id: Part['id']) => data?.parts.find((p) => p.id === id);
  const omzet = part('omzet');
  const ads = part('ads');
  const bez = part('bezoekers');
  const zoek = part('zoeken');
  const bank = part('bank');
  const s = {
    omzet: serie(omzet, 'omzet'),
    orders: serie(omzet, 'orders'),
    kosten: serie(ads, 'kosten'),
    klikAds: serie(ads, 'klikken'),
    conv: serie(ads, 'conversies'),
    bez: serie(bez, 'bezoekers'),
    klik: serie(zoek, 'klikken'),
    vert: serie(zoek, 'vertoningen'),
    in: serie(bank, 'in'),
    uit: serie(bank, 'uit'),
  };
  const line = (x: Series | undefined, color: string): ChartSeries[] => (x ? [{ key: x.key, label: x.label, color, points: x.now, ghost: x.before }] : []);
  const dash = <span className="text-muted">–</span>;

  return (
    <div className="viz space-y-4" data-testid="dashboard-business">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Je bedrijf</h2>
        <div role="group" aria-label="Periode" className="inline-flex rounded-full bg-surface-2 p-0.5 text-[13px]">
          {([7, 30, 90] as const).map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)} aria-pressed={days === d} className={cx('rounded-full px-3 py-1 font-medium transition-colors', days === d ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg')}>
              {dagen(d)}
            </button>
          ))}
        </div>
        <div className="ms-auto flex items-center gap-2 text-[12.5px] text-muted" aria-live="polite">
          {data && <span>Bijgewerkt {ago(data.at)}</span>}
          <button type="button" onClick={() => load(true)} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 font-medium text-fg/80 transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-60">
            <RefreshCw className={cx('size-3.5', busy && 'animate-spin')} aria-hidden />
            {busy ? 'Ophalen…' : 'Nu verversen'}
          </button>
        </div>
      </div>

      {error && !data && (
        <div className="rounded-xl bg-surface-2 px-4 py-3 text-sm">
          De cijfers konden niet worden opgehaald: {error}
        </div>
      )}

      {!data && !error && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" aria-busy>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="tb-glass h-[132px] animate-pulse rounded-2xl" />
          ))}
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="dashboard-business-tiles">
            <Tile label="Omzet" value={s.omzet ? fmt(s.omzet.total, 'eur') : '–'} color={COLOR.omzet} points={s.omzet?.now} testid="tile-omzet">
              {s.omzet ? <Delta now={s.omzet.total} before={s.omzet.totalBefore} days={days} /> : dash}
            </Tile>
            <Tile label="Advertentiekosten" value={s.kosten ? fmt(s.kosten.total, 'eur') : '–'} color={COLOR.ads} points={s.kosten?.now} testid="tile-ads">
              {s.kosten ? <Delta now={s.kosten.total} before={s.kosten.totalBefore} days={days} /> : <span className="text-[12.5px] text-warn">token nodig</span>}
            </Tile>
            <Tile label="Bezoekers" value={s.bez ? fmt(s.bez.total, 'count') : '–'} color={COLOR.bezoekers} points={s.bez?.now} testid="tile-bezoekers">
              {s.bez ? <Delta now={s.bez.total} before={s.bez.totalBefore} days={days} /> : dash}
            </Tile>
            <Tile label="Klikken uit Google" value={s.klik ? fmt(s.klik.total, 'count') : '–'} color={COLOR.zoeken} points={s.vert?.now} testid="tile-zoeken">
              {s.vert ? <span className="text-[12.5px] text-muted">{fmt(s.vert.total, 'count')} keer getoond</span> : dash}
            </Tile>
            <Tile label="Saldo" value={bank?.extra?.saldo !== undefined ? fmt(Number(bank.extra.saldo), 'eur') : '–'} color="var(--viz-5)" testid="tile-saldo">
              {s.in && s.uit ? (
                <span className="text-[12.5px] text-muted">
                  +{fmt(s.in.total, 'eur', true)} / −{fmt(s.uit.total, 'eur', true)} in {dagen(days)}
                </span>
              ) : (
                dash
              )}
            </Tile>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card title={TITLE.omzet} color={COLOR.omzet} testid="chart-omzet" right={s.omzet && <Legend items={[{ label: `${dagen(days)}`, color: COLOR.omzet }, { label: 'periode ervoor', dashed: true }]} />}>
              {omzet?.state === 'ok' && s.omzet ? (
                <>
                  <LineChart series={line(s.omzet, COLOR.omzet)} unit="eur" label={`Omzet per dag, ${dagen(days)}`} />
                  {s.orders && <p className="mt-2 text-[13px] text-muted">{fmt(s.orders.total, 'count')} betalingen, gemiddeld {fmt(s.orders.total ? s.omzet.total / s.orders.total : 0, 'eur')} per betaling.</p>}
                </>
              ) : (
                omzet && <Missing part={omzet} />
              )}
            </Card>

            <Card title={TITLE.ads} color={COLOR.ads} testid="chart-ads" right={s.kosten && <Legend items={[{ label: `${dagen(days)}`, color: COLOR.ads }, { label: 'periode ervoor', dashed: true }]} />}>
              {ads?.state === 'ok' && s.kosten ? (
                <>
                  <LineChart series={line(s.kosten, COLOR.ads)} unit="eur" label={`Advertentiekosten per dag, ${dagen(days)}`} />
                  <p className="mt-2 text-[13px] text-muted">
                    {fmt(s.klikAds?.total || 0, 'count')} klikken · {fmt(s.conv?.total || 0, 'count')} conversies
                    {s.klikAds?.total ? ` · ${fmt(s.kosten.total / s.klikAds.total, 'eur')} per klik` : ''}
                  </p>
                  <Rows rows={ads.rows || []} color={COLOR.ads} />
                </>
              ) : (
                ads && <Missing part={ads} />
              )}
            </Card>

            <Card title={TITLE.bezoekers} color={COLOR.bezoekers} testid="chart-bezoekers" right={s.bez && <Legend items={[{ label: `${dagen(days)}`, color: COLOR.bezoekers }, { label: 'periode ervoor', dashed: true }]} />}>
              {bez?.state === 'ok' && s.bez ? (
                <>
                  <LineChart series={line(s.bez, COLOR.bezoekers)} unit="count" label={`Bezoekers per dag, ${dagen(days)}`} />
                  <Rows rows={bez.rows || []} color={COLOR.bezoekers} />
                </>
              ) : (
                bez && <Missing part={bez} />
              )}
            </Card>

            <Card title={TITLE.zoeken} color={COLOR.zoeken} testid="chart-zoeken" right={s.vert && <Legend items={[{ label: 'keer getoond', color: COLOR.zoeken }, { label: 'periode ervoor', dashed: true }]} />}>
              {zoek?.state === 'ok' && s.vert ? (
                <>
                  <LineChart series={line(s.vert, COLOR.zoeken)} unit="count" label={`Vertoningen in Google per dag, ${dagen(days)}`} />
                  <p className="mt-2 text-[13px] text-muted">
                    {fmt(s.klik?.total || 0, 'count')} klikken naar je sites. Google loopt 3 dagen achter: dit is tot en met {zoek.extra?.tot ? new Date(String(zoek.extra.tot) + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'long' }) : 'eergisteren'}.
                  </p>
                  <Rows rows={zoek.rows || []} color={COLOR.zoeken} />
                </>
              ) : (
                zoek && <Missing part={zoek} />
              )}
            </Card>

            <Card title={TITLE.bank} color={COLOR.bank} testid="chart-bank" right={s.in && <Legend items={[{ label: 'Ontvangen', color: 'var(--viz-1)' }, { label: 'Uitgegeven', color: 'var(--viz-2)' }]} />}>
              {bank?.state === 'ok' && s.in && s.uit ? (
                <>
                  <BarChart
                    series={[
                      { key: 'in', label: 'Ontvangen', color: 'var(--viz-1)', points: s.in.now },
                      { key: 'uit', label: 'Uitgegeven', color: 'var(--viz-2)', points: s.uit.now },
                    ]}
                    unit="eur"
                    label={`Ontvangen en uitgegeven per dag, ${dagen(days)}`}
                  />
                  <Rows rows={bank.rows || []} color="var(--viz-5)" />
                </>
              ) : (
                bank && <Missing part={bank} />
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
