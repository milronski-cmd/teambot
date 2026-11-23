import { useEffect } from 'react';
import { AlertTriangle, Gauge, Info, OctagonAlert, Receipt } from 'lucide-react';
import { Card, SectionTitle, cx, timeAgo } from '../../components/ui';
import { t } from '../../lib/i18n';
import { fmtUsd, useUsage, type EngineView } from '../../modules/usage/api';
import { Ring, WindowBar } from '../../modules/usage/parts';
import { BotName } from '../../modules/teamdata/parts';
import { OpenApp } from './parts';

/**
 * Verbruik (4.17.0: everything in one place). The owner could not see how much he was over, and much was missing
 * ("lang niet alles staat erin"). Now, in this order: every AI service (a subscription with its windows and whether
 * extra usage costs money, a paid key with what it cost today, this week and this month, a free one as free), every
 * budget or quota a bot keeps as a tile with a limit (over the limit: by how much), and every other cost a bot keeps
 * in the group "Verbruik" (a tile without a limit, e.g. "GitHub Actions boven het gratis tegoed").
 */

/** A tile a bot keeps: with a limit it is a meter, in the group "Verbruik" without one a cost. */
export interface MeterTile {
  id: number;
  titel: string;
  groep?: string | null;
  waarde?: string | null;
  eenheid?: string | null;
  maximum?: string | null;
  toelichting?: string | null;
  bot?: string | null;
  bijgewerkt?: string | null;
  team?: string;
  meter?: { value: number; max: number } | null;
}

/** A tile that is about usage: the group "Verbruik" (any spelling). */
export const isUsageTile = (r: { groep?: string | null }) => /^\s*(verbruik|usage|kosten)\s*$/i.test(String(r.groep || ''));

const when = (s?: string | null) => {
  const d = s ? new Date(String(s).replace(' ', 'T')) : null;
  return d && Number.isFinite(d.getTime()) ? d.toISOString() : null;
};
const percent = (part: number) => new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 }).format(part);
const amount = (n: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n);
/** "19,55 van 23 dollar", as the bot wrote the numbers. */
const usedOf = (r: MeterTile) => `${t('{0} van {1}', String(r.waarde ?? ''), String(r.maximum ?? ''))}${r.eenheid ? ` ${r.eenheid}` : ''}`;
/** A cost tile is "over" something free or included when its title says so ("boven gratis tegoed", "betaald boven …"). */
const overFree = (r: MeterTile) => /\b(boven|over|extra|meer dan)\b/i.test(r.titel);

function Who({ r }: { r: MeterTile }) {
  const at = when(r.bijgewerkt);
  return (
    <span className="inline-flex min-w-0 items-center gap-2 text-[12px] text-muted">
      {r.bot ? <BotName name={r.bot} size={16} bold={false} /> : null}
      {at && <span>{t('{0} geleden', timeAgo(at))}</span>}
    </span>
  );
}

/** One budget or quota: what is used of what, as a bar, the state in words, and over the limit by how much. */
function MeterRow({ r }: { r: MeterTile }) {
  const m = r.meter!;
  const part = m.max > 0 ? m.value / m.max : 0;
  const full = part >= 1;
  const near = !full && part >= 0.8;
  const over = m.value - m.max;
  return (
    <li className="space-y-1.5 p-4" data-testid="dashboard-meter">
      <div className="line-clamp-2 text-[13px] font-semibold" translate="no" title={r.titel}>
        {r.titel}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-1.5" translate="no">
        <span className="text-xl font-bold leading-tight tracking-tight">{String(r.waarde ?? '')}</span>
        <span className="text-[13px] text-muted">
          {t('van {0}', String(r.maximum ?? ''))}
          {r.eenheid ? ` ${r.eenheid}` : ''}
        </span>
        {over > 0 && (
          <span className="ms-auto rounded-full bg-danger-soft px-2 py-0.5 text-[12px] font-bold text-danger" data-testid="dashboard-meter-over">
            {t('{0} boven je limiet', `${amount(over)}${r.eenheid ? ` ${r.eenheid}` : ''}`)}
          </span>
        )}
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="meter" aria-label={r.titel} aria-valuemin={0} aria-valuemax={m.max} aria-valuenow={m.value}>
        <div className={cx('h-full rounded-full transition-[width] duration-500', full ? 'bg-danger' : near ? 'bg-warn-strong' : 'bg-accent')} style={{ width: `${Math.max(2, Math.min(100, part * 100))}%` }} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
        <span className="inline-flex items-center gap-1 font-semibold text-fg">
          {full ? <OctagonAlert className="h-3.5 w-3.5 text-danger" aria-hidden /> : near ? <AlertTriangle className="h-3.5 w-3.5 text-warn" aria-hidden /> : null}
          {full ? t('Op: {0} gebruikt', percent(part)) : near ? t('Bijna op: {0} gebruikt', percent(part)) : t('{0} gebruikt', percent(part))}
        </span>
        <Who r={r} />
      </div>
    </li>
  );
}

/** A cost a bot keeps without a limit: the amount, what it is over (when the title says so), the bot's note. */
function CostRow({ r }: { r: MeterTile }) {
  return (
    <li className="space-y-1 p-4" data-testid="dashboard-cost">
      <div className="flex items-start justify-between gap-3">
        <span className="line-clamp-2 text-[13px] font-semibold" translate="no" title={r.titel}>
          {r.titel}
        </span>
        {overFree(r) && <span className="shrink-0 rounded-full bg-warn-soft px-2 py-0.5 text-[11.5px] font-bold text-warn">{t('kost extra')}</span>}
      </div>
      <div className="flex items-baseline gap-1.5" translate="no">
        <span className="text-xl font-bold leading-tight tracking-tight">{String(r.waarde ?? '–')}</span>
        {r.eenheid ? <span className="text-[13px] text-muted">{r.eenheid}</span> : null}
      </div>
      {r.toelichting ? (
        <div className="line-clamp-1 text-[12px] text-muted [overflow-wrap:anywhere]" translate="no" title={String(r.toelichting)}>
          {r.toelichting}
        </div>
      ) : null}
      <Who r={r} />
    </li>
  );
}

/** What a service is paid with, in words. */
const paidWith = (e: EngineView) => (e.billing === 'subscription' ? t('Abonnement') : e.billing === 'paid' ? t('Betaald per gebruik') : e.billing === 'free' || e.billing === 'local' ? t('Gratis') : '');

/** One AI service, whole: its windows and what extra usage costs, or its costs, or that it is free. */
function EngineRow({ e }: { e: EngineView }) {
  const month = e.spend.month;
  return (
    <li className="space-y-2.5 p-4" data-testid="dashboard-usage-engine">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[13.5px] font-bold" translate="no">
          {e.name}
        </span>
        <span className="shrink-0 text-[12px] text-muted">{[paidWith(e), e.plan].filter(Boolean).join(' · ')}</span>
      </div>
      {e.windows.slice(0, 6).map((w) => (
        <WindowBar key={w.id} w={w} />
      ))}
      {e.billing === 'paid' && (
        <dl className="grid grid-cols-3 gap-2 text-[12px]" data-testid="dashboard-usage-spend">
          {(
            [
              [t('Vandaag'), e.spend.today.cost],
              [t('Deze week'), e.spend.week.cost],
              [t('Deze maand'), month?.cost ?? e.spend.week.cost],
            ] as const
          ).map(([label, cost]) => (
            <div key={label} className="rounded-xl bg-surface-2 px-3 py-2">
              <dt className="text-muted">{label}</dt>
              <dd className="text-[15px] font-bold">{fmtUsd(cost)}</dd>
            </div>
          ))}
        </dl>
      )}
      {!e.windows.length && e.billing !== 'paid' && <div className="text-[12.5px] text-muted">{e.unsupported ? t(e.unsupported) : t('Geen limieten doorgegeven')}</div>}
      {e.note && (
        <div className="flex items-start gap-1.5 rounded-xl bg-surface-2 px-3 py-2 text-[12.5px]" data-testid="dashboard-usage-note">
          <Info className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
          <span>{t(e.note)}</span>
        </div>
      )}
    </li>
  );
}

export function UsageSection({ meters, costs = [], compact }: { meters: MeterTile[]; costs?: MeterTile[]; compact?: boolean }) {
  const engines = useUsage((s) => s.engines);
  const load = useUsage((s) => s.load);
  useEffect(() => {
    void load().catch(() => {});
  }, []);
  const services = (engines || []).filter((e) => e.enabled);
  const limited = services.filter((e) => e.windows.length > 0);
  const empty = !services.length && !meters.length && !costs.length;
  return (
    <section className="space-y-2" data-testid="dashboard-usage">
      <SectionTitle
        icon={Gauge}
        tone="teal"
        action={
          compact ? (
            <OpenApp href="#/dashboard/verbruik" />
          ) : (
            <a href="#/m/usage/" className="text-sm text-muted hover:text-fg">
              Alles over verbruik
            </a>
          )
        }
      >
        Verbruik
      </SectionTitle>
      <Card className="p-0">
        {empty ? (
          <div className="p-4 text-sm text-muted">Hier zie je hoeveel er van je abonnementen en budgetten gebruikt is. Je AI-abonnement verschijnt vanzelf; een budget of limiet van een andere dienst (hosting, bouwminuten) houdt een bot bij als tegel met een maximum in de groep Verbruik.</div>
        ) : compact ? (
          // On the start screen: each subscription and budget as a ring (how full); a paid key and another cost as an amount.
          <div className="grid grid-cols-1 gap-1 p-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            {limited.map((e) => {
              const w = e.worst || e.windows[0];
              return (
                <a key={e.providerId} href="#/dashboard/verbruik" className="flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-surface-2" data-testid="dashboard-usage-engine">
                  <Ring value={w.usedPercent} size={46} stroke={5} level={w.level}>
                    <span className="text-[11px] font-bold">{typeof w.usedPercent === 'number' ? percent(w.usedPercent / 100) : '?'}</span>
                  </Ring>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold" translate="no">
                      {e.name}
                    </span>
                    <span className="block truncate text-[12px] text-muted">{t(w.label)}</span>
                  </span>
                </a>
              );
            })}
            {meters.slice(0, 4).map((r) => {
              const part = r.meter!.max > 0 ? r.meter!.value / r.meter!.max : 0;
              return (
                <a key={`${r.team || ''}:${r.id}`} href="#/dashboard/verbruik" className="flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-surface-2" data-testid="dashboard-meter">
                  <Ring value={Math.min(100, part * 100)} size={46} stroke={5} level={part >= 1 ? 'limit' : part >= 0.8 ? 'warn' : 'ok'}>
                    <span className="text-[11px] font-bold">{percent(part)}</span>
                  </Ring>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold" translate="no" title={r.titel}>
                      {r.titel}
                    </span>
                    <span className="block truncate text-[12px] text-muted" translate="no">
                      {usedOf(r)}
                    </span>
                  </span>
                </a>
              );
            })}
            {[...services.filter((e) => e.billing === 'paid' && (e.spend.month ?? e.spend.week).cost > 0).map((e) => ({ key: e.providerId, name: e.name, value: fmtUsd((e.spend.month ?? e.spend.week).cost), note: t('deze maand') })), ...costs.slice(0, 3).map((r) => ({ key: `${r.team || ''}:${r.id}`, name: r.titel, value: `${String(r.waarde ?? '–')}${r.eenheid ? ` ${r.eenheid}` : ''}`, note: overFree(r) ? t('kost extra') : '' }))].map((x) => (
              <a key={x.key} href="#/dashboard/verbruik" className="flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-surface-2" data-testid="dashboard-cost">
                <span className="flex size-[46px] shrink-0 items-center justify-center rounded-full bg-surface-2">
                  <Receipt className="size-5 text-muted" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold" translate="no" title={x.name}>
                    {x.name}
                  </span>
                  <span className="block truncate text-[12px] text-muted" translate="no">
                    {x.value}
                    {x.note ? ` · ${x.note}` : ''}
                  </span>
                </span>
              </a>
            ))}
          </div>
        ) : (
          <div className="divide-y divide-line">
            {services.length > 0 && (
              <div>
                <h3 className="px-4 pt-3 text-[11.5px] font-bold uppercase tracking-wide text-muted">{t('AI-diensten')}</h3>
                <ul className="divide-y divide-line">
                  {services.map((e) => (
                    <EngineRow key={e.providerId} e={e} />
                  ))}
                </ul>
              </div>
            )}
            {meters.length > 0 && (
              <div>
                <h3 className="px-4 pt-3 text-[11.5px] font-bold uppercase tracking-wide text-muted">{t('Budgetten en limieten')}</h3>
                <ul className="divide-y divide-line">
                  {meters.map((r) => (
                    <MeterRow key={`${r.team || ''}:${r.id}`} r={r} />
                  ))}
                </ul>
              </div>
            )}
            {costs.length > 0 && (
              <div>
                <h3 className="px-4 pt-3 text-[11.5px] font-bold uppercase tracking-wide text-muted">{t('Kosten van andere diensten')}</h3>
                <ul className="divide-y divide-line">
                  {costs.map((r) => (
                    <CostRow key={`${r.team || ''}:${r.id}`} r={r} />
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Card>
    </section>
  );
}
