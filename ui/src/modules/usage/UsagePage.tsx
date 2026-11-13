import { useEffect, useState } from 'react';
import { Bell, Cog, Coins, Gauge, Layers, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { Button, Card, EmptyState, IconTile, Page, PageHeader, SectionTitle, cx, toastError, useAsync } from '../../components/ui';
import type { LucideIcon } from 'lucide-react';
import { Fold, Skeleton } from '../../components/overview';
import { BotAvatar } from '../../components/BotFace';
import { t } from '../../lib/i18n';
import { formatDate, formatPercent } from '../../lib/format';
import { fmtTokens, fmtUsd, useBreakdown, useLiveUsageBar, useUsage, useUsageBar, type BarView, type BreakdownRow, type Spend } from './api';
import { effectiveStatus, sharedWith } from './bar';
import { EngineCard } from './parts';
import { meterItems, type MeterItem } from './meter';
import { LineSentence, MeterRing, SlimBar } from './UsageMeter';
import { updatedText } from './UsageBar';
import { useTeams } from '../teams/api';
import { useFollowTeam } from '../teams/follow';
import { TeamFilterNote } from '../teams/FilterNote';
import { desktopBridge, type StatusMode } from './StatusPage';
import { MoreInfo } from '../../components/MoreInfo';
import { Segmented, SettingRow, SwitchRow, useSave } from '../../components/SettingControls';
import { settingOptions } from '../../../../shared/settings.js';

/** How many rows "Verbruik per bot" shows before "Alle N tonen". */
const TOP_ROWS = 5;

/** The title of a fold with the same icon tile as the cards above it. */
function FoldTitle({ icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <IconTile icon={icon} tone="amber" size="sm" />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

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
    <Fold title={<FoldTitle icon={Bell}>Meldingen</FoldTitle>} hint={alerts.enabled ? t('vanaf {0}', formatPercent(alerts.warnAt)) : 'uit'} testId="usage-alerts">
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
      <SwitchRow checked={alerts.enabled} onChange={(v) => void save(setAlerts({ enabled: v }))} setting="usage.alerts" />
      <SettingRow setting="usage.warnAt" info="Op de pc en op je telefoon, bij de grens en bij de limiet.">
        <Segmented
          value={String(alerts.warnAt)}
          disabled={!alerts.enabled}
          onChange={(v) => void save(setAlerts({ warnAt: Number(v) }))}
          options={[70, 80, 90, 95].map((n) => ({ value: String(n), label: formatPercent(n) }))}
        />
      </SettingRow>
      {d?.statusWindow && mode && (
        <SettingRow setting="usage.statusWindow" info="Een klein venster dat boven alles blijft: welke bots werken en wat op jou wacht.">
          <Segmented
            value={mode}
            onChange={(v: StatusMode) => void save(d.statusWindow!.set(v).then((r) => setMode(r.mode)))}
            options={settingOptions<StatusMode>('usage.statusWindow')}
          />
        </SettingRow>
      )}
    </>
  );
}

/**
 * One subscription or source that has a limit, as one compact row: its ring and name, then per window one line with
 * the name, a slim bar and the sentence ("Nog 97%, weer vol om do 04:00."). `updated`: when it was last read (tooltip).
 */
function LimitRow({ item, updated }: { item: MeterItem; updated?: string }) {
  return (
    <li className="flex flex-col gap-x-4 gap-y-1.5 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start">
      <div className="flex min-w-0 items-center gap-2.5 sm:w-48 sm:shrink-0" title={updated}>
        <MeterRing item={item} size={28} />
        <h3 className="min-w-0 truncate text-sm font-semibold" translate="no">
          {item.name}
        </h3>
        {item.sub && (
          <span className="shrink-0 text-xs text-muted" translate="no">
            {item.sub}
          </span>
        )}
      </div>
      <ul className="min-w-0 flex-1 space-y-1.5 sm:pt-1">
        {item.lines.map((l) => (
          <li key={l.key} className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
            {l.name && <span className="w-14 shrink-0 truncate text-xs text-muted">{l.name}</span>}
            {/* No number (nothing reported yet): the sentence alone, never an empty bar. */}
            {(l.part.value !== null || l.part.dashed) && <SlimBar part={l.part} />}
            <LineSentence line={l} estimated={item.estimated} className="sm:w-64 sm:shrink-0" />
          </li>
        ))}
      </ul>
    </li>
  );
}

/** What has a limit gets a row; a free or local source that is simply available is only named in one quiet line. */
function splitLimits(bar: BarView, now: number) {
  const free = bar.sources.filter((s) => effectiveStatus(s, now) === 'available' && typeof s.usedPercent !== 'number');
  const quiet = new Set(free.map((s) => 'src:' + s.id));
  return { limited: meterItems(bar, now).filter((i) => !quiet.has(i.key)), free };
}

/** "Limieten nu": how much can still be done, one compact row per subscription; the same numbers as the rings in the sidebar. */
function LimitsNow() {
  const bar = useLiveUsageBar();
  const refreshAll = useUsageBar((s) => s.refreshAll);
  const { busy, run } = useAsync();
  if (!bar)
    return (
      <Card className="space-y-4 p-5" role="status" aria-label="Laden">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-3 w-full max-w-md" />
        <Skeleton className="h-3 w-full max-w-md" />
        <Skeleton className="h-4 w-48" />
      </Card>
    );
  if (!bar.engines.length && !bar.sources.length)
    return (
      <Card className="p-5">
        <EmptyState
          compact
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
  const now = Date.now();
  const { limited, free } = splitLimits(bar, now);
  const pot = sharedWith(bar.engines.map((e) => e.family));
  const reading = busy || bar.engines.some((e) => e.reading);
  const refresh = () => run(refreshAll);
  return (
    <Card className="space-y-4 p-5">
      <SectionTitle
        icon={Gauge}
        tone="amber"
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
      {limited.length > 0 && (
        <ul className="divide-y divide-line">
          {limited.map((item) => {
            const e = bar.engines.find((x) => x.providerId === item.key);
            return <LimitRow key={item.key} item={item} updated={e ? updatedText(e) : undefined} />;
          })}
        </ul>
      )}
      {free.length > 0 && (
        <p className="text-[12.5px] leading-relaxed text-muted">
          Altijd beschikbaar:{' '}
          {free.map((s, i) => (
            <span key={s.id}>
              {i > 0 && ', '}
              <span translate="no" title={s.note || undefined}>
                {s.label}
              </span>
            </span>
          ))}
        </p>
      )}
      <div className="text-[12.5px] leading-relaxed text-muted">
        <MoreInfo block>
          {pot && <p>{t('Gedeelde pot: je eigen gebruik van {0} buiten TeamBot (app, website, terminal) telt mee in dezelfde limieten.', pot)}</p>}
          <p>Weekreserve: boven die grens gaat gewoon werk naar een ander model, zodat er genoeg overblijft voor belangrijk werk.</p>
          <p>Schatting: de aanbieder geeft daar geen exact cijfer en TeamBot leidt het af, bijvoorbeeld uit een foutmelding. Wat een engine helemaal niet meldt, staat er als "nog niet gemeld".</p>
          {free.map(
            (s) =>
              s.note && (
                <p key={s.id}>
                  <span translate="no">{s.label}</span>: {s.note}
                </p>
              ),
          )}
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

/** The short name in the row; `full` for the detail under it. */
function botName(r: BreakdownRow, byTeam = false, full = false): string {
  if (r.kind === 'team') return r.name || 'Team';
  if (r.kind === 'bot') return r.name || 'Bot';
  if (r.kind === 'deleted') return t('Verwijderde bots');
  if (byTeam) return full ? t('Zonder team (geheugen, spraak, onderhoud, verwijderde bots)') : t('Zonder team');
  return full ? t('Zonder bot (geheugen, spraak, onderhoud)') : t('Zonder bot');
}

const addSpend = (a: Spend, b: Spend): Spend => ({ calls: a.calls + b.calls, tokens: a.tokens + b.tokens, cost: a.cost + b.cost, value: a.value === null && b.value === null ? null : (a.value ?? 0) + (b.value ?? 0) });

/** Every deleted bot in one row "Verwijderde bots": their usage and engines added up. */
function mergeDeleted(rows: BreakdownRow[]): BreakdownRow[] {
  const gone = rows.filter((r) => r.kind === 'deleted');
  if (gone.length < 2) return rows;
  const engines = new Map<string, BreakdownRow['engines'][number]>();
  for (const r of gone)
    for (const e of r.engines) {
      const k = e.providerId || '';
      const m = engines.get(k);
      engines.set(k, m ? { ...m, today: addSpend(m.today, e.today), week: addSpend(m.week, e.week) } : e);
    }
  const one: BreakdownRow = { ...gone[0], key: 'deleted', id: null, today: gone.map((r) => r.today).reduce(addSpend), week: gone.map((r) => r.week).reduce(addSpend), engines: [...engines.values()] };
  return [...rows.filter((r) => r.kind !== 'deleted'), one];
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
  /** Past the top five. */
  const [all, setAll] = useState(false);
  /** The row whose detail is open (its key). */
  const [open, setOpen] = useState<string | null>(null);
  const head = (
    <SectionTitle
      icon={Coins}
      tone="amber"
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
  const used = mergeDeleted(one ? teamRow?.children || [] : data.rows).filter((r) => r[period].calls > 0);
  // Per bot: the biggest user of this period first (teams keep their own order).
  const rows = byTeam ? used : [...used].sort((a, b) => b[period].tokens - a[period].tokens);
  const shown = all ? rows : rows.slice(0, TOP_ROWS);
  const max = Math.max(1, ...rows.map((r) => r[period].tokens));
  const sub = (r: BreakdownRow) => r.engines.some((e) => e.billing === 'subscription' && e[period].calls > 0);
  const total = one ? teamRow?.[period] || ({ tokens: 0, calls: 0, cost: 0, value: null } as Spend) : data.total[period];
  const anySub = rows.some(sub);
  /** What the row itself leaves out: calls, the engines and who pays, money; per team the bots that did the work. */
  const detailOf = (r: BreakdownRow): string[] => {
    const s = r[period];
    const engines = r.engines
      .filter((e) => e[period].calls > 0)
      .map((e) => [e.name || t('verwijderde provider'), translateBilling(e.billing)].filter(Boolean).join(': '))
      .join(' · ');
    const bots = (r.children || [])
      .filter((c) => c.kind === 'bot' && c[period].calls > 0)
      .sort((a, b) => b[period].tokens - a[period].tokens)
      .map((c) => c.name)
      .join(', ');
    const first = [r.kind === 'none' ? botName(r, byTeam, true) : '', t('{0, plural, one {# aanroep} other {# aanroepen}}', s.calls), engines, moneyText(s, sub(r))].filter(Boolean).join(' · ');
    return bots ? [first, bots] : [first];
  };
  return (
    <Card className="space-y-3 p-5">
      {head}
      <TeamFilterNote>Je ziet het verbruik van de bots van dit team.</TeamFilterNote>
      {rows.length === 0 ? (
        <p className="py-4 text-[13.5px] text-muted">{period === 'today' ? 'Vandaag nog geen verbruik.' : 'Deze week nog geen verbruik.'}</p>
      ) : (
        <ul>
          {shown.map((r) => {
            const s = r[period];
            const detail = detailOf(r);
            const isOpen = open === r.key;
            return (
              <li key={r.key}>
                {/* One line: face, name, bar, tokens. The rest (calls, engines, money) in the tooltip and behind a click. */}
                <button
                  type="button"
                  aria-expanded={isOpen}
                  title={detail.join('\n')}
                  onClick={() => setOpen(isOpen ? null : r.key)}
                  className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-control px-2 py-1.5 text-start transition-colors hover:bg-surface-2 active:bg-surface-3 coarse:min-h-11"
                >
                  {r.kind === 'team' ? (
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-3" aria-hidden>
                      <span className="h-3 w-3 rounded-full" style={{ background: r.color || 'currentColor' }} />
                    </span>
                  ) : r.kind === 'bot' ? (
                    <BotAvatar bot={{ id: r.id, name: r.name || '?', avatar: r.avatar }} size={28} />
                  ) : (
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-muted" aria-hidden>
                      {r.kind === 'deleted' ? <Trash2 className="h-3.5 w-3.5" /> : <Cog className="h-4 w-4" />}
                    </span>
                  )}
                  <span className="w-24 shrink-0 truncate text-[13.5px] font-semibold sm:w-44" translate={r.kind === 'bot' || r.kind === 'team' ? 'no' : undefined}>
                    {botName(r, byTeam)}
                  </span>
                  <span aria-hidden className="h-1.5 min-w-4 flex-1 overflow-hidden rounded-full bg-surface-3">
                    <span className="block h-full rounded-full bg-fg/35" style={{ width: `${Math.max(2, Math.round((s.tokens / max) * 100))}%` }} />
                  </span>
                  <span className="w-16 shrink-0 text-end text-[13px] tabular-nums sm:w-36">
                    {fmtTokens(s.tokens)}
                    <span className="hidden sm:inline"> tokens</span>
                  </span>
                </button>
                {isOpen && (
                  <div className="pb-1.5 ps-10 text-[12.5px] leading-relaxed text-muted">
                    {detail.map((line, i) => (
                      <p key={i} translate={i > 0 ? 'no' : undefined}>
                        {line}
                      </p>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > TOP_ROWS && (
        <Button size="sm" variant="ghost" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Minder tonen' : t('Alle {0} tonen', rows.length)}
        </Button>
      )}
      {rows.length > 1 && (
        <p className="border-t border-line pt-2 text-[13px]">
          <span className="font-semibold">Samen:</span> {fmtTokens(total.tokens)} tokens
        </p>
      )}
      <div className="text-[12.5px] text-muted">
        <MoreInfo block>
          {rows.length > 1 && <p>{[t('{0, plural, one {# aanroep} other {# aanroepen}}', total.calls), moneyText(total, anySub)].filter(Boolean).join(' · ')}</p>}
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
    <Fold title={<FoldTitle icon={Layers}>Alle accounts in detail</FoldTitle>} testId="usage-details" onOpen={() => void load(true).catch(toastError)}>
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

/** Everything about usage in one calm overview: how much can still be done, who used what; details and notifications folded. */
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
      <PageHeader icon={Gauge} tone="amber" title="Gebruik en limieten" subtitle="Hoeveel je abonnementen nog kunnen, en welke bots wat gebruiken." width="5xl" />
      <div className="mx-auto max-w-5xl px-4 py-4 sm:px-6">
        <UsageLimits />
      </div>
    </Page>
  );
}
