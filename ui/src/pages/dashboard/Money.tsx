import { useEffect, useMemo, useState } from 'react';
import { Landmark, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import { Button, Card, SectionTitle, Spinner } from '../../components/ui';
import { OpenApp } from './parts';

interface Overview {
  status: 'off' | 'on' | 'expired';
  from?: string;
  to?: string;
  accounts: { bank: string; name: string; iban: string; currency: string; balances?: { name: string; amount: number; currency: string }[]; at?: string; error?: string }[];
  transactions: { date: string | null; amount: number | null; currency: string; counterparty: string | null; description: string; status: string; account: string }[];
}

export const money = (n: number, currency = 'EUR') => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'EUR' }).format(n);
  } catch {
    // An unknown currency code: the amount as the browser writes a number, with the code behind it.
    return `${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ${currency}`;
  }
};

type Tx = Overview['transactions'][number];
const PER_ACCOUNT = 50;

/**
 * The balance per day over the period, worked back from what is on the accounts now with what came in and went out.
 * An account the bank gave its full page of transactions for (more may exist) shortens the period to what is known
 * of it, so the line never shows a day it has no numbers for.
 */
export function balanceCourse(total: number, txs: Tx[], from: string, to: string): { day: string; balance: number; in: number; out: number }[] {
  const dated = txs.filter((x) => x.date && x.amount !== null && x.status !== 'in behandeling');
  let start = from;
  const perAccount = new Map<string, string[]>();
  for (const x of dated) perAccount.set(x.account, [...(perAccount.get(x.account) || []), String(x.date).slice(0, 10)]);
  for (const days of perAccount.values()) if (days.length >= PER_ACCOUNT) start = [start, [...days].sort()[0]].sort()[1];
  const days: string[] = [];
  for (let d = new Date(`${start}T12:00:00Z`); days.length < 120 && d.toISOString().slice(0, 10) <= to; d = new Date(d.getTime() + 86400_000)) days.push(d.toISOString().slice(0, 10));
  if (days.length < 2) return [];
  const sum = new Map<string, { in: number; out: number }>();
  for (const x of dated) {
    const k = String(x.date).slice(0, 10);
    const v = sum.get(k) || { in: 0, out: 0 };
    if ((x.amount as number) >= 0) v.in += x.amount as number;
    else v.out += x.amount as number;
    sum.set(k, v);
  }
  const out: { day: string; balance: number; in: number; out: number }[] = [];
  let balance = total;
  for (let i = days.length - 1; i >= 0; i--) {
    const v = sum.get(days[i]) || { in: 0, out: 0 };
    out.unshift({ day: days[i], balance, in: v.in, out: v.out });
    balance -= v.in + v.out;
  }
  return out;
}

const dayLabel = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** One line: the money on the accounts per day. Hover (or the arrow keys) reads a day: its balance, what came in and went out. */
function MoneyCourse({ points, currency }: { points: ReturnType<typeof balanceCourse>; currency: string }) {
  const [at, setAt] = useState<number | null>(null);
  const W = 600;
  const H = 120;
  const vs = points.map((p) => p.balance);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const x = (i: number) => (i / (points.length - 1)) * (W - 8) + 4;
  const y = (v: number) => (hi === lo ? H / 2 : H - 8 - ((v - lo) / (hi - lo)) * (H - 20));
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${r1(x(i))},${r1(y(p.balance))}`).join(' ');
  const pick = (clientX: number, box: DOMRect) => setAt(Math.max(0, Math.min(points.length - 1, Math.round(((clientX - box.left) / box.width) * (points.length - 1)))));
  const p = at === null ? null : points[at];
  const totalIn = points.reduce((n, q) => n + q.in, 0);
  const totalOut = points.reduce((n, q) => n + q.out, 0);
  const diff = vs[vs.length - 1] - vs[0];
  return (
    <div className="space-y-3 p-4" data-testid="dashboard-money-course">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[13px] font-medium text-muted">{t('Saldo per dag, {0} tot {1}', dayLabel(points[0].day), dayLabel(points[points.length - 1].day))}</div>
        <div className="text-[13px] tabular-nums text-muted">{diff === 0 ? t('gelijk gebleven') : t('{0} in deze periode', `${diff > 0 ? '+' : ''}${money(diff, currency)}`)}</div>
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-32 w-full touch-none text-accent outline-none focus-visible:ring-2 focus-visible:ring-accent"
          preserveAspectRatio="none"
          role="img"
          tabIndex={0}
          aria-label={t('Het saldo per dag als lijn. Met de pijltjestoetsen lees je een dag.')}
          onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerDown={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerLeave={() => setAt(null)}
          onBlur={() => setAt(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setAt((i) => Math.max(0, (i ?? points.length - 1) - 1));
            else if (e.key === 'ArrowRight') setAt((i) => Math.min(points.length - 1, (i ?? 0) + 1));
            else if (e.key === 'Escape') setAt(null);
          }}
        >
          <path d={`${line} L${r1(x(points.length - 1))},${H} L${r1(x(0))},${H} Z`} fill="currentColor" opacity="0.12" />
          <path d={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          {at !== null && <line x1={x(at)} x2={x(at)} y1={0} y2={H} stroke="currentColor" strokeWidth="1" opacity="0.5" vectorEffect="non-scaling-stroke" />}
        </svg>
        {p && at !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-44 rounded-lg border border-line bg-surface p-2 text-xs shadow-lg"
            style={{ left: `${(at / (points.length - 1)) * 100}%`, transform: `translateX(${at > points.length / 2 ? '-104%' : '4%'})` }}
            data-testid="dashboard-money-tip"
          >
            <div className="font-semibold">{dayLabel(p.day)}</div>
            <div className="flex justify-between gap-2 tabular-nums">
              <span className="text-muted">{t('Saldo')}</span>
              <span className="font-semibold">{money(p.balance, currency)}</span>
            </div>
            {p.in !== 0 && (
              <div className="flex justify-between gap-2 tabular-nums">
                <span className="text-muted">{t('Bij')}</span>
                <span>+{money(p.in, currency)}</span>
              </div>
            )}
            {p.out !== 0 && (
              <div className="flex justify-between gap-2 tabular-nums">
                <span className="text-muted">{t('Af')}</span>
                <span>{money(p.out, currency)}</span>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-surface-2 p-3">
          <div className="text-[13px] font-medium text-muted">{t('Bijgeschreven')}</div>
          <div className="text-lg font-bold tracking-tight tabular-nums">+{money(totalIn, currency)}</div>
        </div>
        <div className="rounded-lg bg-surface-2 p-3">
          <div className="text-[13px] font-medium text-muted">{t('Afgeschreven')}</div>
          <div className="text-lg font-bold tracking-tight tabular-nums">{money(totalOut, currency)}</div>
        </div>
      </div>
    </div>
  );
}

/** The owner's money on the dashboard: balances, their course per day and the latest transactions, straight from the bank app. */
/** `quiet`: on the overview, only when the bank is connected (else `onOff` tells the overview, which names it once). */
export function MoneySection({ compact, quiet, onOff }: { compact?: boolean; quiet?: boolean; onOff?: (off: boolean) => void } = {}) {
  const [o, setO] = useState<Overview | null>(null);
  const [err, setErr] = useState('');
  const load = () =>
    api.get<Overview>('/mcp/bank/overview?days=30').then(
      (r) => (setO(r), setErr('')),
      (e) => (setO({ status: 'off', accounts: [], transactions: [] }), setErr(String(e?.message || e))),
    );
  useEffect(() => {
    void load();
  }, []);

  const total = (o?.accounts || []).reduce((s, a) => s + (a.balances?.[0]?.amount ?? 0), 0);
  const mixed = new Set((o?.accounts || []).map((a) => a.balances?.[0]?.currency).filter(Boolean)).size > 1;
  const known = (o?.accounts || []).length > 0 && (o?.accounts || []).every((a) => a.balances?.length);
  const course = useMemo(() => (o && known && !mixed && o.from && o.to ? balanceCourse(total, o.transactions, o.from, o.to) : []), [o]);
  useEffect(() => {
    if (o) onOff?.(o.status !== 'on');
  }, [o]);
  if (quiet && (!o || o.status !== 'on')) return null;

  return (
    <section className="space-y-2" data-testid="dashboard-money">
      <SectionTitle
        icon={Landmark}
        tone="teal"
        action={
          compact ? (
            <OpenApp href="#/dashboard/geld" />
          ) : (
            o?.status === 'on' && (
              <Button size="sm" variant="ghost" icon={<RefreshCw className="h-4 w-4" />} onClick={() => (setO(null), void load())}>
                Verversen
              </Button>
            )
          )
        }
      >
        Geld
      </SectionTitle>
      <Card className="p-0">
        {o === null ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : o.status !== 'on' ? (
          <div className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
            <span className="min-w-0 flex-1 basis-56 text-muted">{err || (o.status === 'expired' ? 'De toestemming bij je bank is verlopen. Geef hem opnieuw bij Apps › Bank.' : 'Koppel je bank en je ziet hier je saldo en je af- en bijschrijvingen. Alleen lezen, nooit betalen.')}</span>
            <Button size="sm" onClick={() => navigate('/m/mcp')}>
              {o.status === 'expired' ? 'Opnieuw koppelen' : 'Bank koppelen'}
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-line">
            {compact && !mixed && (
              <div className="p-4 pb-1" data-testid="dashboard-money-total">
                <div className="text-[13px] font-medium text-muted" translate="no">
                  {o.accounts.length > 1 ? t('Samen op {0} rekeningen', o.accounts.length) : `${o.accounts[0]?.name || ''} · ${o.accounts[0]?.bank || ''}`}
                </div>
                <div className="text-3xl font-bold leading-tight tracking-tight tabular-nums">{money(total, o.accounts[0]?.balances?.[0]?.currency)}</div>
              </div>
            )}
            <div className={`${compact && !mixed ? 'hidden' : 'grid'} grid-cols-1 gap-3 p-4 sm:grid-cols-2`}>
              {o.accounts.length > 1 && !mixed && (
                <div className="rounded-lg bg-surface-2 p-3">
                  <div className="text-[13px] font-medium text-muted">Samen</div>
                  <div className="text-xl font-bold tracking-tight tabular-nums">{money(total, o.accounts[0].balances?.[0]?.currency)}</div>
                </div>
              )}
              {o.accounts.map((a) => (
                <div key={a.iban} className="rounded-lg bg-surface-2 p-3" data-testid="dashboard-account">
                  <div className="truncate text-[13px] font-medium text-muted" translate="no">
                    {a.name} · {a.bank}
                  </div>
                  {a.balances?.length ? (
                    <div className="text-xl font-bold tracking-tight tabular-nums">{money(a.balances[0].amount, a.balances[0].currency)}</div>
                  ) : (
                    <div className="text-sm text-danger">{a.error || t('Geen saldo ontvangen')}</div>
                  )}
                  <div className="font-mono text-[12px] text-muted">{a.iban}</div>
                </div>
              ))}
            </div>
            {course.length > 1 && <MoneyCourse points={course} currency={o.accounts[0].balances?.[0]?.currency || 'EUR'} />}
            {compact ? null : o.transactions.length > 0 ? (
              <ul className="divide-y divide-line" data-testid="dashboard-transactions">
                {o.transactions.slice(0, 12).map((x, i) => (
                  <li key={i} className="flex items-baseline gap-3 px-4 py-2 text-sm">
                    <span className="w-20 shrink-0 text-xs tabular-nums text-muted">{x.date || ''}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium" translate="no">
                        {x.counterparty || x.description || '–'}
                      </span>
                      {x.counterparty && x.description && (
                        <span className="block truncate text-xs text-muted" translate="no">
                          {x.description}
                        </span>
                      )}
                    </span>
                    <span className={`shrink-0 font-semibold tabular-nums ${(x.amount ?? 0) < 0 ? '' : 'text-ok'}`}>{x.amount === null ? '' : money(x.amount, x.currency)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-4 text-sm text-muted">{t('Geen af- of bijschrijvingen tussen {0} en {1}.', o.from || '', o.to || '')}</div>
            )}
          </div>
        )}
      </Card>
    </section>
  );
}
