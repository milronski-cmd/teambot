import { useEffect, useState } from 'react';
import { Clock, Coins } from 'lucide-react';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { formatPercent, formatTime, formatUsd } from '../../lib/format';
import { Button, toastError } from '../../components/ui';
import { resetLong, windowName } from './bar';

/** GET /usage/estimate (server/modules/usage/estimate.ts). */
export interface EstimateView {
  estimated: true;
  basis: { runs: number; source: 'routine' | 'bot' | 'none' };
  tokens: { input: number; output: number } | null;
  engine: { providerId: string; name: string; kind: string; model: string; billing: string } | null;
  cost: { usd: number | null; how: 'price' | 'measured' | 'covered' | 'free' | 'unknown' };
  windows: { id: string; label: string; usedPercent: number | null; share: number | null; left: number | null; resetsAt: number | null; fits: boolean | null }[];
  startAfter: { at: number; windowId: string; label: string; known: boolean } | null;
  show: boolean;
  reason: 'important' | 'cost' | 'window' | 'nofit' | null;
  important: boolean;
}

/** "Start na de reset om 14:05" today; "Start na de reset: morgen 05:59" later. */
function startText(at: number): string {
  const d = new Date(at);
  const n = new Date();
  const today = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return today ? t('Start na de reset om {0}', formatTime(d)) : t('Start na de reset: {0}', resetLong(at));
}

const pct = (n: number) => (n < 1 ? t('minder dan 1%') : formatPercent(Math.round(n)));

/** The money line: "Kost ongeveer $0,40 per keer.", "Kost geen geld: valt onder je abonnement." … */
function moneyLine(e: EstimateView): string {
  const c = e.cost;
  if (c.how === 'covered') return t('Kost geen geld: valt onder je abonnement.');
  if (c.how === 'free') return t('Kost geen geld: gratis model of op je eigen computer.');
  if (c.usd !== null && (c.how === 'price' || c.how === 'measured')) return t('Kost ongeveer {0} per keer.', formatUsd(c.usd, { min: 2, max: 2 }));
  return t('Wat het kost is nog onbekend: de prijs van dit model is niet bekend.');
}

/** "Op basis van de laatste 4 runs van deze routine." */
function basisLine(e: EstimateView): string {
  if (e.basis.source === 'none') return t('Nog geen eerdere runs om op te schatten. Na de eerste keer weet TeamBot meer.');
  return e.basis.source === 'routine'
    ? t('{0, plural, one {Op basis van de laatste run van deze routine.} other {Op basis van de laatste # runs van deze routine (de middelste waarde).}}', e.basis.runs)
    : t('{0, plural, one {Op basis van de laatste run van deze bot.} other {Op basis van de laatste # runs van deze bot (de middelste waarde).}}', e.basis.runs);
}

/**
 * "Kosten vooraf" (package P3): before a big task or routine, what it roughly costs (money, or a share of the 5-hour
 * and weekly window on a subscription), always labelled as an estimate. When it does not fit in what is left of a
 * window it offers "Start na de reset om …" (`onStartAfter`). Renders nothing when the work is small and not important.
 */
export function CostEstimate({ agentId, routineId, important, onStartAfter, startLabel }: { agentId?: string | null; routineId?: string | null; important?: boolean; onStartAfter?(at: number): Promise<void>; startLabel?: string }) {
  const [e, setE] = useState<EstimateView | null>(null);
  const [busy, setBusy] = useState(false);
  const [planned, setPlanned] = useState<number | null>(null);
  useEffect(() => {
    if (!agentId && !routineId) return setE(null);
    let live = true;
    const q = routineId ? `routineId=${encodeURIComponent(routineId)}` : `agentId=${encodeURIComponent(agentId!)}`;
    api
      .get<EstimateView>(`/usage/estimate?${q}${important ? '&important=1' : ''}`)
      .then((r) => live && setE(r))
      .catch(() => live && setE(null));
    return () => {
      live = false;
    };
  }, [agentId, routineId, important]);
  if (!e?.show) return null;
  const shares = e.windows.filter((w) => w.share !== null || w.fits === false);
  const start = async () => {
    if (!e.startAfter || !onStartAfter) return;
    setBusy(true);
    try {
      await onStartAfter(e.startAfter.at);
      setPlanned(e.startAfter.at);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label={t('Kosten vooraf')} className="space-y-1.5 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm" data-testid="cost-estimate">
      <div className="flex items-center gap-1.5 font-semibold">
        <Coins className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        {t('Kosten vooraf')}
        <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-muted">{t('schatting')}</span>
      </div>
      <p>{moneyLine(e)}</p>
      {shares.map((w) => (
        <p key={w.id} className={w.fits === false ? 'text-warn' : ''}>
          {w.share !== null
            ? w.fits === false
              ? t('Neemt ongeveer {0} van je venster “{1}”, en er is nog {2} over.', pct(w.share), windowName(w), pct(w.left ?? 0))
              : t('Neemt ongeveer {0} van je venster “{1}”.', pct(w.share), windowName(w))
            : t('Je venster “{0}” is vol.', windowName(w))}
        </p>
      ))}
      <p className="text-xs text-muted">{basisLine(e)}</p>
      {e.startAfter && onStartAfter && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {planned ? (
            <p className="flex items-center gap-1.5 text-ok" role="status">
              <Clock className="h-4 w-4 shrink-0" aria-hidden />
              {t('Ingepland: start {0}.', resetLong(planned))}
            </p>
          ) : (
            <>
              <Button size="sm" variant="soft" icon={<Clock className="h-4 w-4" />} loading={busy} onClick={start}>
                {startText(e.startAfter.at)}
              </Button>
              {startLabel && <span className="text-xs text-muted">{startLabel}</span>}
            </>
          )}
        </div>
      )}
    </section>
  );
}
