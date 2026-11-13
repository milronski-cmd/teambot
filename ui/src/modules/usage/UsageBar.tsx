import { useId, useState } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { cx, useAsync } from '../../components/ui';
import { useIsDesktop } from '../../lib/media';
import { t } from '../../lib/i18n';
import { capFirst, formatPercent } from '../../lib/format';
import { fmtAgo, fmtLeft, useLiveUsageBar, useUsageBar, type BarEngine, type BarSource, type BarWindow } from './api';
import { barTone, effectiveStatus, engineName, percentText, resetLong, resetShort, sharedWith, sourceSentence, sourceShort, windowName, windowSentence, type BarTone } from './bar';

export const FILL: Record<BarTone, string> = { ok: 'bg-ok', warn: 'bg-warn-strong', danger: 'bg-danger', unknown: '' };
export const TEXT: Record<BarTone, string> = { ok: 'text-fg', warn: 'text-warn', danger: 'text-danger', unknown: 'text-muted' };
// The dot's shape differs too (filled / ring / dashed ring), and every state but "beschikbaar" has words next to it.
export const DOT: Record<BarSource['status'], string> = {
  available: 'bg-ok',
  low: 'bg-warn-strong',
  limited: 'bg-danger',
  offline: 'border-[1.5px] border-muted',
  unknown: 'border-[1.5px] border-dashed border-muted',
};
export const SHORT_TONE: Record<BarSource['status'], string> = { available: 'text-muted', low: 'text-warn', limited: 'text-danger', offline: 'text-muted', unknown: 'text-muted' };

/** Open or closed per place (sidebar / phone), only on this device; the bar works without it. */
// (A plain string, not a template: the text extractor took the template for interface text.)
const openKey = (where: string) => 'tb.usageBar.open.' + where;
function readOpen(where: string): boolean {
  try {
    return localStorage.getItem(openKey(where)) === '1';
  } catch {
    return false;
  }
}
function saveOpen(where: string, v: boolean) {
  try {
    localStorage.setItem(openKey(where), v ? '1' : '0');
  } catch {
    /* private window: stays open for this visit only */
  }
}

/** One line of the table: a window, or a stand-in while the engine has none to show. */
export interface Row {
  key: string;
  name: string;
  w: BarWindow | null;
  tone: BarTone;
  pct: string;
  reset: string;
  sentence: string;
  reserve: number | null;
}

export function rowsOf(e: BarEngine, label: string, now: number): Row[] {
  const rows: Row[] = [];
  // Blocked although no window says so (the run hit a limit the engine did not put in numbers): said first.
  if (e.blocked && !e.windows.some((w) => barTone(w) === 'danger')) {
    const until = e.blocked.until;
    rows.push({
      key: 'blocked',
      name: t('Limiet'),
      w: null,
      tone: 'danger',
      pct: t('op'),
      reset: until ? (e.blocked.estimated ? '≈ ' : '') + resetShort(until, now) : '',
      sentence: (until ? t('{0}: limiet bereikt, weer beschikbaar {1}.', label, resetLong(until, now)) : t('{0}: limiet bereikt.', label)) + (until && e.blocked.estimated ? ` ${t('Schatting.')}` : ''),
      reserve: null,
    });
  }
  for (const w of e.windows) rows.push({ key: w.id, name: windowName(w), w, tone: barTone(w), pct: percentText(w), reset: resetShort(w.resetsAt, now), sentence: windowSentence(label, w, now), reserve: w.reserveAt });
  if (!rows.length) rows.push({ key: 'none', name: t('Limieten'), w: null, tone: 'unknown', pct: '–', reset: '', sentence: e.reading ? t('{0}: limieten worden opgevraagd.', label) : t('{0}: limieten nog niet gemeld.', label), reserve: null });
  return rows;
}

/** The bar itself: decorative (the percentage next to it and the sentence for screen readers carry the meaning). */
export function Track({ row, size = 'sm' }: { row: Row; size?: 'sm' | 'md' | 'lg' }) {
  const pct = row.tone === 'danger' ? 100 : typeof row.w?.usedPercent === 'number' ? row.w.usedPercent : null;
  return (
    <span aria-hidden className={cx('relative block min-w-6 flex-1 overflow-hidden rounded-full', size === 'lg' ? 'h-2.5' : size === 'md' ? 'h-2' : 'h-1.5', pct === null ? 'border border-dashed border-line-strong' : 'bg-line')}>
      {pct !== null && pct > 0 && <span className={cx('block h-full rounded-full transition-[width] duration-500', FILL[row.tone])} style={{ width: `${Math.max(3, Math.min(100, pct))}%` }} />}
      {row.reserve !== null && <span className="absolute inset-y-0 w-0.5 bg-fg/70" style={{ insetInlineStart: `${Math.min(99, row.reserve)}%` }} />}
    </span>
  );
}

function statusWord(r: Row): string {
  if (r.pct === '–') return r.sentence;
  const est = r.w?.estimated ? t('schatting') : '';
  const word = r.tone === 'danger' ? t('limiet bereikt') : r.tone === 'warn' ? t('bijna op') : '';
  return [word, est].filter(Boolean).join(', ');
}

export function updatedText(e: BarEngine): string {
  if (e.reading) return t('Wordt opgevraagd…');
  if (!e.windows.length && e.error) return t('Opvragen lukte niet: {0}', e.error);
  if (e.updatedAt) return t('Bijgewerkt {0}', fmtAgo(e.updatedAt));
  return t('Nog niet opgevraagd.');
}

function Bar({ where }: { where: 'sidebar' | 'phone' }) {
  const bar = useLiveUsageBar();
  const refreshAll = useUsageBar((s) => s.refreshAll);
  const [open, setOpenState] = useState(() => readOpen(where));
  const { busy, run } = useAsync();
  const titleId = useId();
  const moreId = useId();
  if (!bar || (!bar.engines.length && !bar.sources.length)) return null;
  const now = Date.now();
  const phone = where === 'phone';
  const groups = bar.engines.map((e) => {
    const label = engineName(e, bar.engines);
    return { e, label, rows: rowsOf(e, label, now) };
  });
  const estimated = bar.engines.some((e) => e.windows.some((w) => w.estimated) || (e.blocked?.estimated && e.blocked.until)) || bar.sources.some((s) => s.estimated && s.resetsAt && effectiveStatus(s, now) !== 'available');
  const pot = sharedWith(bar.engines.map((e) => e.family));
  const reading = busy || bar.engines.some((e) => e.reading);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    saveOpen(where, v);
  };
  const refresh = () => run(refreshAll);
  const text = phone ? 'text-[13px] leading-6' : 'text-[11.5px] leading-[18px]';

  return (
    <section aria-labelledby={titleId} className={cx(phone ? 'rounded-2xl border border-line bg-surface px-3.5 pb-3 pt-2' : 'my-1.5 rounded-xl bg-surface-2 px-2.5 pb-2 pt-1')}>
      <div className="flex items-center gap-1">
        <h2 id={titleId} className={cx('min-w-0 flex-1 truncate font-bold uppercase tracking-wider text-muted', phone ? 'text-[12px]' : 'text-[11px]')}>
          Gebruik
        </h2>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={moreId}
          aria-label={open ? 'Minder over het gebruik tonen' : 'Meer over het gebruik tonen'}
          title={open ? 'Minder tonen' : 'Resettijden en uitleg'}
          className={cx('relative z-10 -me-1 flex items-center justify-center rounded-md text-muted hover:bg-surface-3 hover:text-fg coarse:h-11 coarse:w-11', phone ? 'h-9 w-9' : 'h-6 w-6')}
        >
          <ChevronDown className={cx('h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
      </div>

      {/* The whole summary opens the usage page (one link over it; the expanded part below has its own links). */}
      <div className={cx('relative', text)}>
        {groups.length > 0 && (
          <table className="w-full border-collapse">
            <caption className="sr-only">Limieten van je abonnementen</caption>
            <thead className="sr-only">
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Periode</th>
                <th scope="col">Gebruikt</th>
                <th scope="col">Reset</th>
              </tr>
            </thead>
            {groups.map(({ e, label, rows }, gi) => (
              <tbody key={e.providerId} className={cx(gi > 0 && '[&>tr:first-child>*]:pt-1')}>
                {rows.map((r, i) => (
                  <tr key={r.key}>
                    {i === 0 && (
                      <th scope="rowgroup" rowSpan={rows.length} className="whitespace-nowrap pe-2 text-start align-top font-semibold text-fg" translate="no">
                        {label}
                      </th>
                    )}
                    <td className="whitespace-nowrap pe-2 text-muted">{r.name}</td>
                    <td className="w-full">
                      <span className="flex items-center gap-1.5">
                        <Track row={r} size={phone ? 'md' : 'sm'} />
                        <span className={cx('min-w-[4.5ch] whitespace-nowrap text-end tabular-nums', TEXT[r.tone], r.tone !== 'ok' && r.tone !== 'unknown' && 'font-semibold')}>
                          <span aria-hidden={r.pct === '–' || undefined}>{r.pct}</span>
                          {/* Never colour alone: the state in words for screen readers (the expanded view says it in full). */}
                          {statusWord(r) && <span className="sr-only"> {statusWord(r)}</span>}
                        </span>
                      </span>
                    </td>
                    <td className={cx('whitespace-nowrap ps-2 text-end tabular-nums', r.tone === 'danger' ? 'text-danger' : 'text-muted')}>{r.reset}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        )}
        {bar.sources.length > 0 && (
          <div className={cx('flex items-start gap-2', groups.length > 0 && 'mt-1')}>
            <span className="shrink-0 font-semibold text-fg">Gratis</span>
            <ul className="flex min-w-0 flex-wrap items-center gap-x-2.5" aria-label="Gratis bronnen">
              {bar.sources.map((s) => {
                const st = effectiveStatus(s, now);
                const short = sourceShort(s, now);
                return (
                  <li key={s.id} className="inline-flex min-w-0 items-center gap-1">
                    <span aria-hidden className={cx('h-2 w-2 shrink-0 rounded-full', DOT[st])} />
                    <span className="truncate" translate="no">
                      {s.label}
                    </span>
                    {short ? <span className={cx('whitespace-nowrap', SHORT_TONE[st])}>{short}</span> : <span className="sr-only">beschikbaar</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <a href="#/m/usage/" className="absolute inset-0 rounded-md hover:bg-fg/[0.04]" aria-label="Gebruik per bot en alle limieten openen" />
      </div>

      <div id={moreId} hidden={!open} className={cx('scroll-thin mt-2 space-y-2.5 overflow-y-auto border-t border-line pt-2 leading-snug text-muted', phone ? 'text-[13px]' : 'max-h-[40vh] text-[12px]')}>
        {groups.map(({ e, label, rows }) => (
          <div key={e.providerId}>
            <div className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="font-semibold text-fg" translate="no">
                {label}
              </span>
              {e.plan && <span translate="no">{e.plan}</span>}
            </div>
            <ul className="mt-0.5 space-y-0.5">
              {rows.map((r) => (
                <li key={r.key}>
                  {r.sentence}
                  {r.w?.resetsAt && r.tone !== 'danger' ? ` ${capFirst(fmtLeft(r.w.resetsAt))}.` : ''}
                  {r.w?.reserveAt != null && (
                    <span className="block">
                      {t('Weekreserve vanaf {0}: daarboven gaat gewoon werk naar een ander model.', formatPercent(r.w.reserveAt))}
                      {r.w.reserveActive ? ` ${t('Nu actief.')}` : ''}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <div className="text-[11.5px]">{updatedText(e)}</div>
          </div>
        ))}
        {bar.sources.length > 0 && (
          <div>
            <div className="font-semibold text-fg">Gratis</div>
            <ul className="mt-0.5 space-y-1">
              {bar.sources.map((s) => (
                <li key={s.id}>
                  {sourceSentence(s, now)}
                  {s.note && <span className="block text-[11.5px]">{s.note}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {pot && <p>{t('Gedeelde pot: je eigen gebruik van {0} buiten TeamBot (app, website, terminal) telt mee in dezelfde limieten.', pot)}</p>}
        {estimated && <p>{t('≈ is een schatting: de aanbieder geeft daar geen exact cijfer, TeamBot leidt het af.')}</p>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <a href="#/m/usage/" className="font-semibold text-fg hover:underline">
            Verbruik per bot
          </a>
          {bar.engines.some((e) => e.canRead) && (
            <button type="button" onClick={refresh} disabled={reading} className="inline-flex items-center gap-1 font-semibold hover:text-fg disabled:opacity-60 coarse:min-h-11">
              <RefreshCw className={cx('h-3 w-3', reading && 'animate-spin')} aria-hidden /> Vernieuwen
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Always-visible usage bar, like OpenBot's: a bar per window (Claude 5 uur / week / model weeks, Codex 5 uur / week),
 * green, orange from 80%, red at the limit, with the reset; one dot per free source (beschikbaar / op tot …). The
 * summary opens the usage page; the arrow shows reset times in full, what is an estimate and that the pot is shared.
 * `where`: "sidebar" (desktop, bottom of the sidebar) or "phone" (top of Meer; renders nothing on a wide screen,
 * where the sidebar has it already).
 */
export function UsageBar({ where = 'sidebar' }: { where?: 'sidebar' | 'phone' }) {
  const desktop = useIsDesktop();
  if (where === 'phone' && desktop) return null;
  return <Bar where={where} />;
}
