import { useEffect, useState } from 'react';
import { Cog, Gauge, RefreshCw, RotateCcw } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Page, PageHeader, SectionTitle, cx, toastError } from '../../components/ui';
import { Fold, Skeleton } from '../../components/overview';
import { BotAvatar } from '../../components/BotFace';
import { t } from '../../lib/i18n';
import { formatDate, formatPercent } from '../../lib/format';
import { fmtLeft, fmtTokens, fmtUsd, useBreakdown, useLiveUsageBar, useUsage, useUsageBar, type BarEngine, type BreakdownRow, type Spend } from './api';
import { effectiveStatus, engineName, percentText, resetLong, sharedWith, sourceSentence, sourceShort } from './bar';
import { EngineCard } from './parts';
import { meterItems } from './meter';
import { Detail as MeterDetail } from './UsageMeter';
import { DOT, SHORT_TONE, TEXT, Track, rowsOf, updatedText } from './UsageBar';
import { useTeams } from '../teams/api';
import { useFollowTeam } from '../teams/follow';
import { TeamFilterNote } from '../teams/FilterNote';
import { desktopBridge, type StatusMode } from './StatusPage';
import { MoreInfo } from '../../components/MoreInfo';
import { Segmented, SettingRow, SwitchRow, useSave } from '../../components/SettingControls';

/** Limit notifications (and on the desktop: the floating status window). Every change saves at once. */
function AlertsCard() {
  const alerts = useUsage((s) => s.alerts);
  const setAlerts = useUsage((s) => s.setAlerts);
  const load = useUsage((s) => s.load);
  const save = useSave();
  useEffect(() => {
    if (!useUsage.getState().alerts) load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!alerts) return null;
  const standard = alerts.enabled && alerts.warnAt === 80;
  return (
    <Fold title="Meldingen" hint={alerts.enabled ? t('vanaf {0}', formatPercent(alerts.warnAt)) : 'uit'} testId="usage-alerts">
      <div className="-my-2 divide-y divide-line">
        <AlertRows />
      </div>
      {!standard && (
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden />} onClick={() => void save(setAlerts({ enabled: true, warnAt: 80 }))}>
            Standaard terugzetten
          </Button>
        </div>
      )}
    </Fold>
  );
}

function AlertRows() {
  const alerts = useUsage((s) => s.alerts)!;
  const setAlerts = useUsage((s) => s.setAlerts);
  const save = useSave();
  const d = desktopBridge();
  const [mode, setMode] = useState<StatusMode | null>(null);
  useEffect(() => {
    d?.statusWindow
      ?.get()
      .then((r) => setMode(r.mode))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <SwitchRow checked={alerts.enabled} onChange={(v) => void save(setAlerts({ enabled: v }))} label="Melden als een limiet bijna op is, op is, en weer beschikbaar is" />
      <SettingRow label="Waarschuwen vanaf" info="Op de pc en op je telefoon, bij de grens en bij de limiet.">
        <Segmented
          value={String(alerts.warnAt)}
          disabled={!alerts.enabled}
          onChange={(v) => void save(setAlerts({ warnAt: Number(v) }))}
          options={[70, 80, 90, 95].map((n) => ({ value: String(n), label: formatPercent(n) }))}
        />
      </SettingRow>
      {d?.statusWindow && mode && (
        <SettingRow label="Zwevend statusvenster" info="Een klein venster dat boven alles blijft: welke bots werken en wat op jou wacht.">
          <Segmented
            value={mode}
            onChange={(v: StatusMode) => void save(d.statusWindow!.set(v).then((r) => setMode(r.mode)))}
            options={[
              { value: 'off', label: 'Uit' },
              { value: 'auto', label: 'Als er iets loopt' },
              { value: 'always', label: 'Altijd' },
            ]}
          />
        </SettingRow>
      )}
    </>
  );
}

/** One account's windows as large bars: how much is used, when it resets, estimate and reserve said in words. */
function EngineLimits({ e, label, now }: { e: BarEngine; label: string; now: number }) {
  const rows = rowsOf(e, label, now);
  return (
    <section aria-label={t('Limieten van {0}', label)} className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="text-[14.5px] font-bold tracking-tight" translate="no">
          {label}
        </h3>
        {e.plan && <Badge>{e.plan}</Badge>}
        <span className="ms-auto text-[12px] text-muted">{updatedText(e)}</span>
      </div>
      <div className="mt-2.5 space-y-3">
        {rows.map((r) => {
          const pct = typeof r.w?.usedPercent === 'number' ? r.w.usedPercent : null;
          return (
            <div key={r.key}>
              <div className="flex items-baseline justify-between gap-2 text-[13.5px]">
                <span className="font-semibold">{r.name}</span>
                <span className={cx('shrink-0 tabular-nums', TEXT[r.tone], r.tone !== 'unknown' && 'font-semibold')}>{pct !== null ? t('{0} gebruikt', percentText(r.w!)) : r.tone === 'danger' ? t('op') : t('nog niet gemeld')}</span>
              </div>
              <div
                className="mt-1 flex"
                role="meter"
                aria-label={t('{0} {1}', label, r.name)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct !== null ? Math.round(pct) : r.tone === 'danger' ? 100 : undefined}
                aria-valuetext={r.sentence}
              >
                <Track row={r} size="lg" />
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12.5px] text-muted">
                {r.w?.resetsAt ? (
                  <span>
                    {t('Reset {0}', resetLong(r.w.resetsAt, now))} · {fmtLeft(r.w.resetsAt)}
                  </span>
                ) : r.key === 'blocked' && e.blocked?.until ? (
                  <span>{t('Weer beschikbaar {0}', resetLong(e.blocked.until, now))}</span>
                ) : r.key === 'none' ? (
                  <span>{r.sentence}</span>
                ) : (
                  <span>Reset onbekend</span>
                )}
                {(r.w?.estimated || (r.key === 'blocked' && e.blocked?.estimated && e.blocked.until)) && <Badge tone="warn">schatting</Badge>}
              </div>
              {r.w?.reserveAt != null && (
                <p className="mt-0.5 text-[12.5px] text-muted">
                  {t('Vanaf {0} alleen nog belangrijk werk.', formatPercent(r.w.reserveAt))}
                  {r.w.reserveActive && <span className="font-semibold text-warn"> {t('Nu actief.')}</span>}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** "Limieten nu": the same numbers as the bar in the sidebar, larger and in words. */
function LimitsNow() {
  const bar = useLiveUsageBar();
  const refreshAll = useUsageBar((s) => s.refreshAll);
  const [busy, setBusy] = useState(false);
  if (!bar)
    return (
      <Card className="space-y-4 p-5" role="status" aria-label="Laden">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-3 w-full max-w-md" />
        <Skeleton className="h-3 w-full max-w-md" />
        <Skeleton className="h-4 w-48" />
      </Card>
    );
  const now = Date.now();
  if (!bar.engines.length && !bar.sources.length)
    return (
      <Card className="p-5">
        <EmptyState
          icon={<Gauge />}
          title="Nog geen limieten om te tonen"
          action={
            <a href="#/settings/providers" className="inline-flex h-9 items-center rounded-control border border-line bg-surface px-4 text-sm font-semibold hover:bg-surface-2">
              Naar AI-diensten
            </a>
          }
        >
          Koppel een abonnement of een gratis bron om hier te zien hoeveel er nog kan.
        </EmptyState>
      </Card>
    );
  const pot = sharedWith(bar.engines.map((e) => e.family));
  const reading = busy || bar.engines.some((e) => e.reading);
  const refresh = async () => {
    setBusy(true);
    try {
      await refreshAll();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-5 p-5">
      <SectionTitle
        action={
          bar.engines.some((e) => e.canRead) && (
            <Button size="sm" variant="ghost" icon={<RefreshCw className={cx('h-3.5 w-3.5', reading && 'animate-spin')} />} disabled={reading} onClick={refresh}>
              Vernieuwen
            </Button>
          )
        }
      >
        Limieten nu
      </SectionTitle>
      {/* One small card per subscription or source, the same picture as the ring in the sidebar: mark, bars, one sentence. */}
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {meterItems(bar).map((item) => (
          <li key={item.key} className="rounded-card bg-surface-2 p-4">
            <MeterDetail item={item} titleId={`limiet-${item.key}`} reading={reading} />
          </li>
        ))}
      </ul>
      <div className="border-t border-line pt-3 text-[12.5px] leading-relaxed text-muted">
        <MoreInfo block>
          {pot && <p>{t('Gedeelde pot: je eigen gebruik van {0} buiten TeamBot (app, website, terminal) telt mee in dezelfde limieten.', pot)}</p>}
          <p>Weekreserve: boven die grens gaat gewoon werk naar een ander model, zodat er genoeg overblijft voor belangrijk werk.</p>
          <p>Schatting: de aanbieder geeft daar geen exact cijfer en TeamBot leidt het af, bijvoorbeeld uit een foutmelding. Wat een engine helemaal niet meldt, staat er als "nog niet gemeld".</p>
        </MoreInfo>
      </div>
    </Card>
  );
}

/** Money for a period: real cost (API keys) and the estimated value of subscription work, in words. */
function moneyText(s: Spend, sub: boolean): string {
  const parts: string[] = [];
  if (s.cost > 0) parts.push(t('{0} kosten', fmtUsd(s.cost)));
  if (sub && s.value) parts.push(t('≈ {0} waarde via abonnement', fmtUsd(s.value)));
  return parts.join(' · ');
}

function botName(r: BreakdownRow, byTeam = false): string {
  if (r.kind === 'team') return r.name || 'Team';
  if (byTeam && r.kind === 'none') return t('Zonder team (geheugen, spraak, onderhoud, verwijderde bots)');
  return r.kind === 'bot' ? r.name || 'Bot' : r.kind === 'deleted' ? t('Verwijderde bot') : t('Zonder bot (geheugen, spraak, onderhoud)');
}

/** "Verbruik per bot" (from the second team on also per team): today or this week, via TeamBot. */
function PerBot() {
  const { teams } = useTeams();
  const multi = (teams?.length || 0) > 1;
  const [by, setBy] = useState<'bot' | 'team'>('bot');
  // Package B4: with a team chosen in the team switcher, the bots of that team only (from the per-team numbers).
  const one = useFollowTeam().activeId;
  const byTeam = multi && by === 'team' && !one;
  const { data, error, reload } = useBreakdown(byTeam || one ? 'team' : 'bot');
  const [period, setPeriod] = useState<'today' | 'week'>('today');
  const head = (
    <SectionTitle
      className="flex-wrap gap-y-2"
      action={
        <div className="flex flex-wrap items-center gap-2">
          {multi && !one && (
            <Segmented<'bot' | 'team'>
              label="Verdeling"
              size="sm"
              options={[
                { value: 'bot', label: 'Per bot' },
                { value: 'team', label: 'Per team' },
              ]}
              value={by}
              onChange={setBy}
            />
          )}
          <Segmented<'today' | 'week'>
            label="Periode"
            size="sm"
            options={[
              { value: 'today', label: 'Vandaag' },
              { value: 'week', label: 'Deze week' },
            ]}
            value={period}
            onChange={setPeriod}
          />
        </div>
      }
    >
      {byTeam ? 'Verbruik per team' : 'Verbruik per bot'}
    </SectionTitle>
  );
  if (error && !data)
    return (
      <Card className="space-y-3 p-5">
        {head}
        <p className="text-[13px] text-danger">{t('Laden lukte niet: {0}', error)}</p>
        <Button size="sm" onClick={reload}>
          Opnieuw proberen
        </Button>
      </Card>
    );
  if (!data)
    return (
      <Card className="space-y-3 p-5">
        {head}
        <div className="space-y-3 py-2" role="status" aria-label="Laden">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-1.5 w-full" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </Card>
    );
  const teamRow = one ? data.rows.find((r) => r.kind === 'team' && r.id === one) || null : null;
  const rows = (one ? teamRow?.children || [] : data.rows).filter((r) => r[period].calls > 0);
  const max = Math.max(1, ...rows.map((r) => r[period].tokens));
  const sub = (r: BreakdownRow) => r.engines.some((e) => e.billing === 'subscription' && e[period].calls > 0);
  const total = one ? teamRow?.[period] || ({ tokens: 0, calls: 0, cost: 0, value: null } as Spend) : data.total[period];
  const anySub = rows.some(sub);
  return (
    <Card className="space-y-3 p-5">
      {head}
      <TeamFilterNote>Je ziet het verbruik van de bots van dit team.</TeamFilterNote>
      {rows.length === 0 ? (
        <p className="py-4 text-[13.5px] text-muted">{period === 'today' ? 'Vandaag nog geen verbruik.' : 'Deze week nog geen verbruik.'}</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((r) => {
            const s = r[period];
            const engines = r.engines
              .filter((e) => e[period].calls > 0)
              .map((e) => [e.name || t('verwijderde provider'), translateBilling(e.billing)].filter(Boolean).join(': '))
              .join(' · ');
            const money = moneyText(s, sub(r));
            // Per team: the bots that did the work, busiest first.
            const bots = (r.children || [])
              .filter((c) => c.kind === 'bot' && c[period].calls > 0)
              .sort((a, b) => b[period].tokens - a[period].tokens)
              .map((c) => c.name)
              .join(', ');
            return (
              <li key={r.key} className="flex items-center gap-3 py-2.5">
                {r.kind === 'team' ? (
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-3" aria-hidden>
                    <span className="h-3 w-3 rounded-full" style={{ background: r.color || 'currentColor' }} />
                  </span>
                ) : r.kind === 'none' ? (
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-muted" aria-hidden>
                    <Cog className="h-4 w-4" />
                  </span>
                ) : (
                  <BotAvatar bot={{ id: r.id, name: r.name || '?', avatar: r.avatar }} size={32} />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3 text-[13.5px]">
                    <span className="min-w-0 truncate font-semibold" translate={r.kind === 'bot' || r.kind === 'team' ? 'no' : undefined}>
                      {botName(r, byTeam)}
                    </span>
                    <span className="shrink-0 tabular-nums">{fmtTokens(s.tokens)} tokens</span>
                  </div>
                  <div aria-hidden className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
                    <div className="h-full rounded-full bg-fg/35" style={{ width: `${Math.max(2, Math.round((s.tokens / max) * 100))}%` }} />
                  </div>
                  <div className="mt-0.5 text-[12.5px] text-muted">{[t('{0, plural, one {# aanroep} other {# aanroepen}}', s.calls), engines, money].filter(Boolean).join(' · ')}</div>
                  {bots && (
                    <div className="mt-0.5 truncate text-[12.5px] text-muted" translate="no">
                      {bots}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > 1 && (
        <p className="border-t border-line pt-2 text-[13px]">
          <span className="font-semibold">Samen:</span> {fmtTokens(total.tokens)} tokens · {[t('{0, plural, one {# aanroep} other {# aanroepen}}', total.calls), moneyText(total, anySub)].filter(Boolean).join(' · ')}
        </p>
      )}
      <div className="text-[12.5px] text-muted">
        <MoreInfo block>
          <p>{period === 'week' ? t('Sinds {0}, alleen werk via TeamBot.', formatDate(data.since.week, { weekday: 'long', day: 'numeric', month: 'long' })) : 'Sinds middernacht, alleen werk via TeamBot.'}</p>
          {anySub && <p>Waarde via abonnement: wat dezelfde tokens tegen de lijstprijs zouden kosten. Met een abonnement betaal je dat niet apart.</p>}
        </MoreInfo>
      </div>
    </Card>
  );
}

/** Who pays for an engine, in one word (whole literals, so the extractor finds each). */
function translateBilling(b: BreakdownRow['engines'][number]['billing']): string {
  if (b === 'subscription') return t('abonnement');
  if (b === 'paid') return t('betaald');
  if (b === 'free') return t('gratis');
  if (b === 'local') return t('lokaal, gratis');
  return '';
}

/** The detailed cards per account (spend, where the numbers come from, errors), loaded when opened. */
function Details() {
  const engines = useUsage((s) => s.engines);
  const load = useUsage((s) => s.load);
  const active = (engines || []).filter((e) => e.enabled);
  return (
    <Fold title="Alle accounts in detail" testId="usage-details" onOpen={() => void load(true).catch(toastError)}>
      {!engines ? (
        <div className="grid gap-3 lg:grid-cols-2" role="status" aria-label="Laden">
          <Skeleton className="h-40 rounded-card" />
          <Skeleton className="h-40 rounded-card" />
        </div>
      ) : active.length === 0 ? (
        <p className="text-[13px] text-muted">Nog geen AI gekoppeld. Koppel er een via Instellingen › AI-diensten.</p>
      ) : (
        <div className="grid gap-x-8 gap-y-5 lg:grid-cols-2">
          {active.map((e) => (
            <EngineCard key={e.providerId} e={e} />
          ))}
        </div>
      )}
    </Fold>
  );
}

/** Everything about usage in one calm overview: limits now, usage per bot, details, notifications. */
export function UsageLimits() {
  return (
    <div className="space-y-4">
      <LimitsNow />
      <PerBot />
      <Details />
      <AlertsCard />
    </div>
  );
}

/** #/m/usage — opened from the usage bar (sidebar) and from Meer on the phone. */
export function UsagePage() {
  return (
    <Page>
      <PageHeader title="Gebruik en limieten" subtitle="Hoeveel je abonnementen nog kunnen, en welke bots wat gebruiken." width="5xl" />
      <div className="mx-auto max-w-5xl px-4 py-4 sm:px-6">
        <UsageLimits />
      </div>
    </Page>
  );
}
