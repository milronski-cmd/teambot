import React, { useEffect, useState } from 'react';
import { ArrowUpRight, BarChart3, TrendingDown, TrendingUp } from 'lucide-react';
import { Card, EmptyState, Page, PageHeader, SectionTitle, cx, timeAgo } from '../components/ui';
import { t } from '../lib/i18n';
import { useIsDesktop } from '../lib/media';
import { useRoute } from '../lib/router';
import { useApp } from '../lib/store';
import { teamApi, useTeamChanged } from '../modules/teamdata/api';
import { BotName } from '../modules/teamdata/parts';
import { TeamFilterNote } from '../modules/teams/FilterNote';
import { useTeamView } from '../modules/teams/scope';
import { useBusy, useClock, useWaiting, useWorstUsage } from '../shell/status';
import { AppsSection, appState, useApps, type AppRow } from './dashboard/Apps';
import { RatioBar, TrendLine, courseOf, ratioOf, trendNote } from './dashboard/Trend';
import { MailSection } from './dashboard/Mail';
import { BusinessSection } from './dashboard/Business';
import { MoneySection } from './dashboard/Money';
import { OpenApp, TasksBlock } from './dashboard/parts';
import { TeamSection } from './dashboard/Team';
import { UsageSection, isUsageTile, type MeterTile } from './dashboard/Usage';

type Tile = { id: number; sleutel: string; groep?: string | null; titel: string; waarde?: string | null; eenheid?: string | null; toelichting?: string | null; link?: string | null; bot?: string | null; history?: { v: number; at: string }[]; bijgewerkt?: string | null; team?: string; maximum?: string | null; meter?: { value: number; max: number } | null };

/**
 * The parts of the dashboard. The first is the overview; each of the others is one part, whole. 24 Nov 2026, the owner:
 * the home screen of an "OS" (wallpaper, dock with coloured app icons, widgets of glass) was "onoverzichtelijk en druk";
 * now plain tabs at the top, one row of numbers, and only cards that show something.
 */
type AppId = '' | 'cijfers' | 'geld' | 'post' | 'verbruik' | 'team' | 'apps';
const APPS: { id: AppId; label: string }[] = [
  { id: '', label: 'Overzicht' },
  { id: 'cijfers', label: 'Cijfers' },
  { id: 'geld', label: 'Geld' },
  { id: 'post', label: 'Post' },
  { id: 'verbruik', label: 'Verbruik' },
  { id: 'team', label: 'Team' },
  { id: 'apps', label: 'Apps' },
];

/** The parts as sleek flat segmented tabs. */
function Tabs({ active }: { active: AppId }) {
  return (
    <nav aria-label={t('Onderdelen van het dashboard')} className="scroll-thin inline-flex max-w-full gap-1 overflow-x-auto rounded-lg border border-line bg-surface-2/70 p-0.5" data-testid="dashboard-dock">
      {APPS.map((a) => {
        const on = a.id === active;
        return (
          <a key={a.id || 'home'} href={a.id ? `#/dashboard/${a.id}` : '#/dashboard'} aria-current={on ? 'page' : undefined} className={cx('shrink-0 rounded-md px-3 py-1.5 text-[13px] transition-colors', on ? 'bg-surface font-semibold text-fg' : 'font-medium text-muted hover:text-fg')} data-testid={`dashboard-app-${a.id || 'home'}`}>
            {t(a.label)}
          </a>
        );
      })}
    </nav>
  );
}

/** A card on the overview. */
function Widget({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cx('tb-glass tb-widget', className)}>{children}</div>;
}

/** One number on the overview: a label, the number, and where it leads. */
function Stat({ label, value, href, tone, testid }: { label: string; value: string; href: string; tone?: 'warn'; testid: string }) {
  return (
    <a href={href} className="tb-glass group block rounded-[20px] px-5 py-4 transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md" data-testid={testid}>
      <div className="flex items-center justify-between gap-2 text-[13px] text-muted">
        <span>{label}</span>
        <ArrowUpRight className="size-3.5 opacity-0 transition-opacity duration-150 group-hover:opacity-70" aria-hidden />
      </div>
      <div className={cx('mt-1.5 text-[34px] font-bold leading-none tabular-nums tracking-tight', tone === 'warn' && 'text-brand')}>{value}</div>
    </a>
  );
}

/** The top of the overview: the greeting, and one row of the numbers that matter. Nothing else. */
function Greeting({ apps }: { apps: AppRow[] | null }) {
  const me = useApp((s) => s.me);
  const { agents, busy } = useBusy();
  const waiting = useWaiting();
  const worst = useWorstUsage();
  const now = useClock();
  const hour = now.getHours();
  const hello = hour < 6 ? t('Goedenacht') : hour < 12 ? t('Goedemorgen') : hour < 18 ? t('Goedemiddag') : t('Goedenavond');
  const first = String(me?.name || '').trim().split(/\s+/)[0];
  const ok = (apps || []).filter((a) => appState(a).tone === 'ok').length;
  const used = worst ? new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 }).format((worst.usedPercent || 0) / 100) : '–';
  return (
    <div className="tb-hero space-y-5 rounded-[28px] border border-line p-6 sm:p-8" data-testid="dashboard-hero">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-[32px] font-bold leading-tight tracking-tight" translate="no">
          {first ? `${hello}, ${first}` : hello}
        </h1>
        <span className="text-xs font-medium text-muted">
          {now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="dashboard-status">
        <Stat label={t('Wacht op jou')} value={String(waiting)} href="#/inbox" tone={waiting ? 'warn' : undefined} testid="dashboard-stat-waiting" />
        <Stat label={t('Aan het werk')} value={t('{0} van {1}', busy.length, agents.length)} href="#/dashboard/team" testid="dashboard-stat-team" />
        <Stat label={t('Verbruik')} value={used} href="#/dashboard/verbruik" testid="dashboard-stat-usage" />
        <Stat label={t('Apps werken')} value={apps === null ? '…' : t('{0} van {1}', ok, apps.length)} href="#/m/mcp/" testid="dashboard-stat-apps" />
      </div>
    </div>
  );
}

/** What is not connected yet, on one line: no card per part with a paragraph each. */
function NotConnected({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-line px-4 py-3 text-sm" data-testid="dashboard-not-connected">
      <span className="text-muted">{t('Nog niet gekoppeld: {0}', items.join(', '))}</span>
      <a href="#/m/mcp/" className="font-medium text-fg hover:underline">
        {t('Koppelen')}
      </a>
    </div>
  );
}

/**
 * Dashboard: the start screen of the owner's business, built as the home screen of an operating system (20–21 nov
 * 2026: "een overzicht van mijn financiële status en bestellingen … gekoppelde apps en alles zien. Een soort OS",
 * "ik kan ook niet alles erin", "moet echt 10x beter, echt een OS moet het zijn"). Over the whole window (the list of
 * bots makes room, shell/Sidebar.tsx): a wallpaper, a menu bar with the state of the whole thing, and a dock with the
 * apps. The home screen shows every part as a widget: the time and who is at work, what waits for him, the numbers
 * the bots keep, his money, what is used of what he pays for, his mail, the team and its tasks, the connected apps.
 * A widget or an icon in the dock opens the app: that part whole, in a window (every number with its course, the
 * bank's transactions, the mailbox to read and write in, every meter). What waits for him is one number with the way
 * to "Wacht op jou": the cards themselves are there and nowhere else. A part that is not connected says how.
 */
export function DashboardPage() {
  const route = useRoute();
  const desktop = useIsDesktop();
  const app = (APPS.some((a) => a.id === route[1]) ? route[1] : '') as AppId;
  // The team chosen in the sidebar, or every team (each tile then names its team).
  const { activeId, multi } = useTeamView();
  const [rows, setRows] = useState<Tile[] | null>(null);
  const [err, setErr] = useState('');
  const apps = useApps();
  const load = () =>
    teamApi.dashboard(activeId).then(
      (r) => (setRows(r as Tile[]), setErr('')),
      (e) => setErr(String(e?.message || e)),
    );
  useEffect(() => {
    void load();
  }, [activeId]);
  useTeamChanged(['dashboard'], () => void load());
  const several = multi && new Set((rows || []).map((r) => r.team || '')).size > 1;
  // A tile with a limit is a meter (Verbruik); the others are the numbers of the business, by group.
  // A tile with a limit is a meter, a tile in the group Verbruik without one a cost: both are Verbruik, not Cijfers.
  const meters = (rows || []).filter((r) => r.meter) as MeterTile[];
  const costs = (rows || []).filter((r) => !r.meter && isUsageTile(r)) as MeterTile[];
  const numbers = (rows || []).filter((r) => !r.meter && !isUsageTile(r));
  // The team card only with a team (a new install has no bots yet: no empty card).
  const hasBots = useBusy().agents.some((a) => !a.archived);
  // What is not connected, named once on the overview (each part tells when it has loaded).
  const [off, setOff] = useState<Record<string, boolean>>({});
  const mark = (k: string) => (v: boolean) => setOff((o) => (o[k] === v ? o : { ...o, [k]: v }));
  const missing = [off.bank && t('bank'), off.mail && t('mail'), apps && !apps.length && t('apps')].filter(Boolean) as string[];
  // One app, whole.
  let one: React.ReactNode = null;
  if (app === 'cijfers')
    one = (
      <div className="space-y-6">
        <BusinessSection />
        <NumbersApp rows={rows} numbers={numbers} err={err} several={several} />
      </div>
    );
  else if (app === 'geld') one = <MoneySection />;
  else if (app === 'post') one = <MailSection />;
  else if (app === 'verbruik') one = <UsageSection meters={meters} costs={costs} />;
  else if (app === 'apps') one = <AppsSection apps={apps} />;
  else if (app === 'team')
    one = (
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <TeamSection />
        <TasksBlock />
      </div>
    );
  return (
    <Page className="tb-os flex flex-col">
      {/* On the phone the way back (to "Meer") is the page's own. */}
      {!desktop && <PageHeader width="full" title="Dashboard" back={app ? { href: '#/dashboard', label: 'Dashboard' } : undefined} />}
      <div className="mx-auto w-full max-w-[1200px] shrink-0 space-y-5 px-4 pb-8 pt-3 sm:px-6">
        <Tabs active={app} />
        <TeamFilterNote />
        {app === '' ? (
          <div className="space-y-5" data-testid="dashboard-home">
            <Greeting apps={apps} />
            <BusinessSection />
            {numbers.length > 0 && (
              <Widget>
                <NumbersBlock rows={rows} numbers={numbers} err={err} />
              </Widget>
            )}
            <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
              <Widget>
                <TasksBlock />
              </Widget>
              {hasBots && (
                <Widget>
                  <TeamSection />
                </Widget>
              )}
              <MoneySection compact quiet onOff={mark('bank')} />
              <MailSection compact quiet onOff={mark('mail')} />
            </div>
            <NotConnected items={missing} />
          </div>
        ) : (
          <div className="min-h-[62vh]" data-testid="dashboard-window">
            {one}
          </div>
        )}
      </div>
    </Page>
  );
}

const EMPTY_NUMBERS = 'Hier komen je omzet, je bestellingen en je aanvragen te staan zodra een bot ze bijhoudt. Vraag het een bot, bijvoorbeeld: “houd op het dashboard bij hoeveel bestellingen en hoeveel omzet er vandaag en deze week zijn”.';

/** The numbers on the home screen: the first six, each as its number with its course behind it. All of them: the app. */
function NumbersBlock({ rows, numbers, err }: { rows: Tile[] | null; numbers: Tile[]; err: string }) {
  // The numbers that moved come first: that is where there is something to see.
  const first = [...numbers].sort((a, b) => Number(courseOf(b.history).course) - Number(courseOf(a.history).course)).slice(0, 6);
  const allLabel = numbers.length > first.length ? t('Alle {0} cijfers', numbers.length) : undefined;
  return (
    <section className="space-y-2" data-testid="dashboard-numbers">
      <SectionTitle icon={BarChart3} tone="amber" action={<OpenApp href="#/dashboard/cijfers" label={allLabel} />}>
        Cijfers
      </SectionTitle>
      {err && <EmptyState title="De cijfers laden niet">{err}</EmptyState>}
      {rows && !numbers.length && !err && <div className="p-4 pt-2 text-sm text-muted">{t(EMPTY_NUMBERS)}</div>}
      {first.length > 0 && (
        <div className="grid grid-cols-1 gap-3 p-4 pt-1 min-[460px]:grid-cols-2 sm:grid-cols-3">
          {first.map((r) => (
            <a key={`${r.team || ''}:${r.id}`} href="#/dashboard/cijfers" className="group flex flex-col rounded-2xl bg-fg/[0.05] p-3 transition-colors hover:bg-fg/[0.09]" data-testid="dashboard-kpi">
              <div className="line-clamp-2 min-h-8 text-[12px] font-medium leading-4 text-muted" translate="no" title={r.titel}>
                {r.titel}
              </div>
              <div className="mt-1 flex min-w-0 items-baseline gap-1.5" translate="no">
                <span className="truncate text-2xl font-bold leading-tight tracking-tight">{r.waarde ?? '–'}</span>
                {r.eenheid ? <span className="truncate text-xs text-muted">{r.eenheid}</span> : null}
              </div>
              <TileCourse r={r} small />
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

/** Every number the bots keep, by group, each with its course, its explanation and who keeps it. */
function NumbersApp({ rows, numbers, err, several }: { rows: Tile[] | null; numbers: Tile[]; err: string; several: boolean }) {
  const groups = new Map<string, Tile[]>();
  for (const r of numbers) {
    const raw = String(r.groep || '').trim() || 'Overig';
    const g = [...groups.keys()].find((k) => k.toLowerCase() === raw.toLowerCase()) || raw.charAt(0).toUpperCase() + raw.slice(1);
    groups.set(g, [...(groups.get(g) || []), r]);
  }
  return (
    <section className="space-y-3" data-testid="dashboard-numbers">
      {err && <EmptyState title="De cijfers laden niet">{err}</EmptyState>}
      {rows && !numbers.length && !err && <Card className="tb-widget-card p-4 text-sm text-muted">{t(EMPTY_NUMBERS)}</Card>}
      {[...groups].map(([g, list]) => (
        <div key={g} className="space-y-2" data-testid="dashboard-group">
          <h3 className="flex items-center gap-2 px-1 text-[13px] font-semibold uppercase tracking-wide text-muted" translate="no">
            <span aria-hidden className="size-1.5 rounded-full bg-accent" />
            {g}
            <span className="font-normal normal-case tracking-normal">{list.length}</span>
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {list.map((r) => (
              <TileCard key={`${r.team || ''}:${r.id}`} r={r} team={several ? r.team : undefined} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

/** "2026-11-15 03:10:00" (local time, as SQLite writes it) as an ISO time, or null. */
function when(s?: string | null): string | null {
  const d = s ? new Date(String(s).replace(' ', 'T')) : null;
  return d && Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * Under the number of a tile, always the same height (rows line up): a part of a whole as a bar ("6 van 9"), else the
 * course when there is a real one (pages/dashboard/Trend.tsx), and one line on the change or when it was measured.
 */
function TileCourse({ r, small }: { r: Tile; small?: boolean }) {
  const { points, course } = courseOf(r.history);
  const ratio = ratioOf(r.waarde);
  const note = trendNote(points, course);
  return (
    <div className={cx('mt-auto flex flex-col justify-end gap-1.5 pt-2', small ? 'min-h-[52px]' : 'min-h-[68px]')} data-testid="dashboard-course">
      {ratio ? <RatioBar part={ratio.part} whole={ratio.whole} /> : course ? <TrendLine points={points} height={small ? 28 : 40} /> : null}
      {note && <div className="truncate text-[12px] text-muted">{note}</div>}
    </div>
  );
}

function TileCard({ r, team }: { r: Tile; team?: string }) {
  const at = when(r.bijgewerkt);
  // The number is what the tile is for: the explanation stays two lines until the owner asks for all of it.
  const [more, setMore] = useState(false);
  const long = String(r.toelichting || '').length > 110;
  const link = String(r.link || '');
  const linked = /^https?:\/\//i.test(link) || link.startsWith('#/');
  // Up or down over the course, next to the number (only for a real course: two points say little).
  const { points, course } = courseOf(r.history);
  const diff = course ? points[points.length - 1].v - points[0].v : 0;
  const card = (
    <Card className={`tb-widget-card relative flex h-full flex-col gap-1 overflow-hidden p-4${linked ? ' transition-colors group-hover:border-fg/30' : ''}`} data-testid="dashboard-tile">
      <div className="flex items-start justify-between gap-2 text-[13px] font-medium text-muted">
        <span className="line-clamp-2" translate="no" title={r.titel}>
          {r.titel}
          {team ? <span className="font-normal"> · {team}</span> : null}
        </span>
        {linked && <ArrowUpRight className="h-4 w-4 shrink-0 transition-colors group-hover:text-fg" aria-label={t('Openen')} />}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1" translate="no">
        <span className="text-3xl font-bold leading-tight tracking-tight">{r.waarde ?? '–'}</span>
        {r.eenheid ? <span className="text-sm font-semibold text-muted">{r.eenheid}</span> : null}
        {diff !== 0 && (
          <span className="ms-auto inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[12px] font-semibold tabular-nums text-fg" data-testid="dashboard-trend">
            {diff > 0 ? <TrendingUp className="h-3.5 w-3.5" aria-hidden /> : <TrendingDown className="h-3.5 w-3.5" aria-hidden />}
            {`${diff > 0 ? '+' : ''}${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(diff)}`}
          </span>
        )}
      </div>
      <TileCourse r={r} />
      {r.toelichting && (
        <div className="text-[13px] text-muted">
          <span className={more ? 'block [overflow-wrap:anywhere]' : 'line-clamp-2 [overflow-wrap:anywhere]'} translate="no" data-testid="dashboard-tile-note">
            {r.toelichting}
          </span>
          {long && (
            <button
              type="button"
              className="mt-0.5 font-medium text-fg underline-offset-2 hover:underline"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMore(!more);
              }}
              data-testid="dashboard-tile-more"
            >
              {more ? t('Minder') : t('Meer lezen')}
            </button>
          )}
        </div>
      )}
      <div className="mt-auto flex items-center justify-between gap-2 pt-2 text-[12px] text-muted">
        {r.bot ? <BotName name={r.bot} size={18} bold={false} /> : <span />}
        {at && <span>{t('{0} geleden', timeAgo(at))}</span>}
      </div>
    </Card>
  );
  if (/^https?:\/\//i.test(link))
    return (
      <a href={link} target="_blank" rel="noreferrer" className="group block rounded-card transition-transform hover:-translate-y-0.5">
        {card}
      </a>
    );
  if (link.startsWith('#/'))
    return (
      <a href={link} className="group block rounded-card transition-transform hover:-translate-y-0.5">
        {card}
      </a>
    );
  return card;
}
