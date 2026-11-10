import { useState } from 'react';
import { AlertTriangle, PauseCircle, RefreshCw } from 'lucide-react';
import { Badge, Button, cx, toastError } from '../../components/ui';
import { t, translate } from '../../lib/i18n';
import { BILLING_TEXT, SOURCE_TEXT, fmtAgo, fmtLeft, fmtPct, fmtTokens, fmtUsd, fmtWhen, toneOf, useUsage, type EngineView, type LimitWindow } from './api';

const TONE_TEXT = { muted: 'text-muted', fg: 'text-fg', warn: 'text-warn', danger: 'text-danger' } as const;
const TONE_BG = { muted: 'bg-line-strong', fg: 'bg-fg', warn: 'bg-warn-strong', danger: 'bg-danger' } as const;

/**
 * A progress ring. `value` null = unknown: only the dashed track, never a fake fill.
 * The number is always also given as text by the caller (colour alone never carries the meaning).
 */
export function Ring({ value, size = 22, stroke = 3, level, className, children }: { value: number | null | undefined; size?: number; stroke?: number; level?: LimitWindow['level']; className?: string; children?: React.ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const known = typeof value === 'number';
  const v = known ? Math.max(0, Math.min(100, value!)) : 0;
  const tone = toneOf(known ? v : null, level);
  return (
    <span className={cx('relative inline-flex shrink-0 items-center justify-center', className)} style={{ width: size, height: size }} aria-hidden>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-line-strong" strokeDasharray={known ? undefined : `${Math.max(1.5, stroke)} ${Math.max(2, stroke)}`} opacity={known ? 0.55 : 1} />
        {known && v > 0 && <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round" stroke="currentColor" className={cx(TONE_TEXT[tone], 'transition-[stroke-dashoffset] duration-500')} strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} />}
      </svg>
      {children && <span className="absolute inset-0 flex items-center justify-center">{children}</span>}
    </span>
  );
}

/** One usage window: label, bar, percentage, reset. */
export function WindowBar({ w, compact }: { w: LimitWindow; compact?: boolean }) {
  const known = typeof w.usedPercent === 'number';
  const tone = toneOf(w.usedPercent, w.level);
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className="truncate font-semibold">{w.label}</span>
        <span className={cx('shrink-0 tabular-nums', known ? TONE_TEXT[tone] : 'text-muted', known && tone !== 'fg' && 'font-semibold')}>{known ? t('{0} gebruikt', fmtPct(w.usedPercent)) : 'onbekend'}</span>
      </div>
      <div
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3"
        role="meter"
        aria-label={known ? t('{0}: {1} gebruikt', translate(w.label), fmtPct(w.usedPercent)) : t('{0}: onbekend', translate(w.label))}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? Math.round(w.usedPercent!) : undefined}
        aria-valuetext={known ? undefined : 'onbekend'}
      >
        {known && <div className={cx('h-full rounded-full transition-[width] duration-500', TONE_BG[tone])} style={{ width: `${Math.max(2, Math.min(100, w.usedPercent!))}%` }} />}
      </div>
      {!compact && (
        <div className="mt-0.5 text-[12px] text-muted">
          {w.resetsAt ? (
            <>
              Reset {fmtWhen(w.resetsAt)} <span className="text-muted/80">· {fmtLeft(w.resetsAt)}</span>
            </>
          ) : (
            'Reset onbekend'
          )}
        </div>
      )}
    </div>
  );
}

/** Spend of one engine in a period: tokens, and either the real cost (API) or "via abonnement · geschatte waarde". */
export function SpendLine({ e, period, label }: { e: EngineView; period: 'today' | 'week'; label: string }) {
  const s = e.spend[period];
  const sub = e.billing === 'subscription';
  const free = e.billing === 'free' || e.billing === 'local';
  return (
    <div className="text-[13px]">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-muted">{label}</span>
        {sub ? (
          <span className="shrink-0 font-semibold tabular-nums" title="Wat dezelfde tokens tegen de lijstprijs zouden kosten">
            {s.value === null ? 'waarde onbekend' : `≈ ${fmtUsd(s.value)}`}
          </span>
        ) : free ? (
          <span className="shrink-0 font-semibold text-ok">gratis</span>
        ) : (
          <span className="shrink-0 font-semibold tabular-nums">{fmtUsd(s.cost)}</span>
        )}
      </div>
      <div className="text-[12px] text-muted">
        {fmtTokens(s.tokens)} tokens · {sub ? 'via abonnement, geschatte waarde (niet apart betaald)' : free ? 'geen kosten' : 'kosten (schatting)'}
      </div>
    </div>
  );
}

function whyUnknown(e: EngineView): string {
  if (e.unsupported) return e.unsupported;
  if (e.error) return `Opvragen lukte niet: ${e.error}`;
  if (e.type === 'api') return e.billing === 'free' || e.billing === 'local' ? 'Lokale modellen hebben geen limiet.' : 'Een API-sleutel heeft geen abonnementsvenster; de provider meldt alleen een korte limiet als je die raakt.';
  if (e.canRead && !e.checkedAt) return 'Nog niet opgevraagd.';
  return `${e.name} meldt geen limieten aan TeamBot.`;
}

/** Limits of one account: windows, block/pause, spend and where the numbers come from. */
export function EngineCard({ e, compact, showSpend = true }: { e: EngineView; compact?: boolean; showSpend?: boolean }) {
  const refreshOne = useUsage((s) => s.refreshOne);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try {
      await refreshOne(e.providerId);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const blockedUntil = e.blocked?.until || e.pausedUntil;
  return (
    <section aria-label={`Limieten van ${e.name}`} className="space-y-2.5">
      {!compact && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="min-w-0 truncate text-[14.5px] font-bold tracking-tight">{e.name}</h3>
          {e.plan && <Badge>{e.plan}</Badge>}
          <span className={cx('text-[12.5px]', e.billing === 'subscription' || e.billing === 'free' || e.billing === 'local' ? 'text-ok' : 'text-muted')}>{e.billingPath || BILLING_TEXT[e.billing]}</span>
          {!e.enabled && <Badge tone="warn">uit</Badge>}
        </div>
      )}
      {(e.blocked || e.pausedUntil) && (
        <div className="flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger" role="status">
          {e.blocked ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
          <span>
            {blockedUntil
              ? e.blocked
                ? t('Limiet bereikt · weer beschikbaar {0}. Bots met een reserve-engine schakelen vanzelf over.', fmtWhen(blockedUntil))
                : t('Even overgeslagen na een limiet · weer beschikbaar {0}. Bots met een reserve-engine schakelen vanzelf over.', fmtWhen(blockedUntil))
              : e.blocked
                ? 'Limiet bereikt · wanneer hij weer kan is onbekend. Bots met een reserve-engine schakelen vanzelf over.'
                : 'Even overgeslagen na een limiet; bots met een reserve schakelen vanzelf over.'}
          </span>
        </div>
      )}
      {e.windows.length ? (
        <div className="space-y-2.5">
          {e.windows.map((w) => (
            <WindowBar key={w.id} w={w} />
          ))}
        </div>
      ) : (
        <p className="text-[13px] text-muted">
          <span className="font-semibold text-fg">Limieten: onbekend.</span> {whyUnknown(e)}
        </p>
      )}
      {e.note && <p className="text-[12.5px] text-muted">{e.note}</p>}
      {e.stats && (
        <p className="text-[12.5px] text-muted">
          Vandaag in OpenCode op deze computer: {fmtTokens(e.stats.input + e.stats.output)} tokens · {fmtUsd(e.stats.cost)}
        </p>
      )}
      {showSpend && (
        <div className="space-y-1 border-t border-line pt-2">
          <SpendLine e={e} period="today" label="Vandaag via TeamBot" />
          {!compact && <SpendLine e={e} period="week" label="Afgelopen 7 dagen" />}
        </div>
      )}
      {(e.canRead || e.updatedAt) && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
          <span>
            {e.updatedAt ? [t('Bijgewerkt {0}', fmtAgo(e.updatedAt)), e.source ? translate(SOURCE_TEXT[e.source]) : ''].filter(Boolean).join(' · ') : 'Nog geen cijfers ontvangen'}
            {e.error && e.windows.length ? ` · ${translate('laatste poging mislukt')}` : ''}
          </span>
          {e.canRead && (
            <Button size="sm" variant="ghost" icon={<RefreshCw className={cx('h-3.5 w-3.5', (busy || e.reading) && 'animate-spin')} />} disabled={busy || e.reading} onClick={refresh} aria-label={t('Limieten van {0} opnieuw opvragen', e.name)}>
              Vernieuwen
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
