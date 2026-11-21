import { useEffect } from 'react';
import { AlertTriangle, Gauge, OctagonAlert } from 'lucide-react';
import { Card, SectionTitle, cx, timeAgo } from '../../components/ui';
import { t } from '../../lib/i18n';
import { fmtUsd, useUsage } from '../../modules/usage/api';
import { Ring, WindowBar } from '../../modules/usage/parts';
import { BotName } from '../../modules/teamdata/parts';
import { OpenApp } from './parts';

/** A tile with a limit: what is used of a budget, a subscription or a quota (the bots keep it, as every tile). */
export interface MeterTile {
  id: number;
  titel: string;
  waarde?: string | null;
  eenheid?: string | null;
  maximum?: string | null;
  toelichting?: string | null;
  bot?: string | null;
  bijgewerkt?: string | null;
  team?: string;
  meter?: { value: number; max: number } | null;
}

const when = (s?: string | null) => {
  const d = s ? new Date(String(s).replace(' ', 'T')) : null;
  return d && Number.isFinite(d.getTime()) ? d.toISOString() : null;
};
const percent = (part: number) => new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 }).format(part);
/** "19,55 van 23 dollar", as the bot wrote the numbers. */
const usedOf = (r: MeterTile) => `${t('{0} van {1}', String(r.waarde ?? ''), String(r.maximum ?? ''))}${r.eenheid ? ` ${r.eenheid}` : ''}`;

/** One budget or quota: what is used of what, as a bar, with the state in words when it runs out (never colour alone). */
function MeterRow({ r }: { r: MeterTile }) {
  const m = r.meter!;
  const part = m.max > 0 ? m.value / m.max : 0;
  const full = part >= 1;
  const near = !full && part >= 0.8;
  const at = when(r.bijgewerkt);
  return (
    <li className="space-y-1.5 p-4" data-testid="dashboard-meter">
      <div className="line-clamp-2 text-[13px] font-semibold" translate="no" title={r.titel}>
        {r.titel}
      </div>
      <div className="flex items-baseline gap-1.5" translate="no">
        <span className="text-xl font-bold leading-tight tracking-tight tabular-nums">{String(r.waarde ?? '')}</span>
        <span className="text-[13px] tabular-nums text-muted">
          {t('van {0}', String(r.maximum ?? ''))}
          {r.eenheid ? ` ${r.eenheid}` : ''}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="meter" aria-label={r.titel} aria-valuemin={0} aria-valuemax={m.max} aria-valuenow={m.value}>
        <div className={cx('h-full rounded-full transition-[width] duration-500', full ? 'bg-danger' : near ? 'bg-warn-strong' : 'bg-accent')} style={{ width: `${Math.max(2, Math.min(100, part * 100))}%` }} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
        <span className="inline-flex items-center gap-1 font-semibold text-fg">
          {full ? <OctagonAlert className="h-3.5 w-3.5 text-danger" aria-hidden /> : near ? <AlertTriangle className="h-3.5 w-3.5 text-warn" aria-hidden /> : null}
          {full ? t('Op: {0} gebruikt', percent(part)) : near ? t('Bijna op: {0} gebruikt', percent(part)) : t('{0} gebruikt', percent(part))}
        </span>
        <span className="inline-flex min-w-0 items-center gap-2">
          {r.bot ? <BotName name={r.bot} size={16} bold={false} /> : null}
          {at && <span>{t('{0} geleden', timeAgo(at))}</span>}
        </span>
      </div>
    </li>
  );
}

/**
 * What is used of what the owner pays for or may use: his AI subscriptions (TeamBot reads those itself, live) and every
 * budget or quota a bot keeps as a tile with a limit (hosting, build minutes, an API's quota …).
 */
export function UsageSection({ meters, compact }: { meters: MeterTile[]; compact?: boolean }) {
  const engines = useUsage((s) => s.engines);
  const load = useUsage((s) => s.load);
  useEffect(() => {
    void load().catch(() => {});
  }, []);
  const limited = (engines || []).filter((e) => e.enabled && e.windows.length > 0);
  const paid = (engines || []).filter((e) => e.enabled && !e.windows.length && e.billing === 'paid' && e.spend && (e.spend.week?.cost || 0) > 0);
  const empty = !limited.length && !paid.length && !meters.length;
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
          <div className="p-4 text-sm text-muted">Hier zie je hoeveel er van je abonnementen en budgetten gebruikt is. Je AI-abonnement verschijnt vanzelf; een budget of limiet van een andere dienst (hosting, bouwminuten) houdt een bot hier bij als je dat vraagt.</div>
        ) : compact ? (
          // On the start screen: each as a ring (how full), with its name and what is used of what.
          <div className="grid grid-cols-1 gap-1 p-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            {limited.map((e) => {
              const w = e.worst || e.windows[0];
              return (
                <a key={e.providerId} href="#/dashboard/verbruik" className="flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-surface-2" data-testid="dashboard-usage-engine">
                  <Ring value={w.usedPercent} size={50} stroke={6} level={w.level}>
                    <span className="text-[11px] font-bold tabular-nums">{typeof w.usedPercent === 'number' ? percent(w.usedPercent / 100) : '?'}</span>
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
                  <Ring value={Math.min(100, part * 100)} size={50} stroke={6} level={part >= 1 ? 'limit' : part >= 0.8 ? 'warn' : 'ok'}>
                    <span className="text-[11px] font-bold tabular-nums">{percent(part)}</span>
                  </Ring>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold" translate="no" title={r.titel}>
                      {r.titel}
                    </span>
                    <span className="block truncate text-[12px] tabular-nums text-muted" translate="no">
                      {usedOf(r)}
                    </span>
                  </span>
                </a>
              );
            })}
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {limited.map((e) => (
              <li key={e.providerId} className="space-y-2.5 p-4" data-testid="dashboard-usage-engine">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[13px] font-semibold" translate="no">
                    {e.name}
                  </span>
                  <span className="shrink-0 text-[12px] text-muted">{e.billingPath || ''}</span>
                </div>
                {(compact ? (e.worst ? [e.worst] : e.windows.slice(0, 1)) : e.windows.slice(0, 4)).map((w) => (
                  <WindowBar key={w.id} w={w} compact={compact} />
                ))}
              </li>
            ))}
            {paid.map((e) => (
              <li key={e.providerId} className="flex items-baseline justify-between gap-3 p-4 text-[13px]">
                <span className="truncate font-semibold" translate="no">
                  {e.name}
                </span>
                <span className="shrink-0 tabular-nums text-muted">{t('{0} deze week', fmtUsd(e.spend!.week.cost))}</span>
              </li>
            ))}
            {(compact ? meters.slice(0, 4) : meters).map((r) => (
              <MeterRow key={`${r.team || ''}:${r.id}`} r={r} />
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
