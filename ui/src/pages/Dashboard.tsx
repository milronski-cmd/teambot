import React, { useEffect, useState } from 'react';
import { ArrowUpRight, BarChart3, Blocks, Gauge, Inbox, Landmark, LayoutGrid, ListChecks, Mail, TrendingDown, TrendingUp, Users, X, type LucideIcon } from 'lucide-react';
import { Card, EmptyState, Page, PageHeader, SectionTitle, cx, timeAgo } from '../components/ui';
import { BotAvatar } from '../components/BotFace';
import { t } from '../lib/i18n';
import { useIsDesktop } from '../lib/media';
import { useRoute } from '../lib/router';
import { useApp } from '../lib/store';
import { teamApi, useTeamChanged } from '../modules/teamdata/api';
import { BotName } from '../modules/teamdata/parts';
import { TeamFilterNote } from '../modules/teams/FilterNote';
import { useTeamView } from '../modules/teams/scope';
import { useBusy, useClock, useWaiting } from '../shell/status';
import { AppsSection, appState, useApps, type AppRow } from './dashboard/Apps';
import { botsBusy } from './dashboard/text';
import { RatioBar, TrendLine, courseOf, ratioOf, trendNote } from './dashboard/Trend';
import { MailSection } from './dashboard/Mail';
import { MoneySection } from './dashboard/Money';
import { OpenApp, TasksBlock } from './dashboard/parts';
import { TeamSection } from './dashboard/Team';
import { UsageSection, isUsageTile, type MeterTile } from './dashboard/Usage';

type Tile = { id: number; sleutel: string; groep?: string | null; titel: string; waarde?: string | null; eenheid?: string | null; toelichting?: string | null; link?: string | null; bot?: string | null; history?: { v: number; at: string }[]; bijgewerkt?: string | null; team?: string; maximum?: string | null; meter?: { value: number; max: number } | null };

/**
 * The apps of the start screen. The first is the home screen (every part as a widget); each of the others is one part,
 * whole, in a window. Their order is the order of the dock; the two colours are the icon's own (as on a phone's home
 * screen: an app is found by its colour before its name).
 */
type AppId = '' | 'cijfers' | 'geld' | 'post' | 'verbruik' | 'team' | 'apps';
const APPS: { id: AppId; label: string; icon: LucideIcon; from: string; to: string }[] = [
  { id: '', label: 'Overzicht', icon: LayoutGrid, from: '#64748b', to: '#334155' },
  { id: 'cijfers', label: 'Cijfers', icon: BarChart3, from: '#f59e0b', to: '#ea580c' },
  { id: 'geld', label: 'Geld', icon: Landmark, from: '#10b981', to: '#047857' },
  { id: 'post', label: 'Post', icon: Mail, from: '#3b82f6', to: '#1d4ed8' },
  { id: 'verbruik', label: 'Verbruik', icon: Gauge, from: '#8b5cf6', to: '#6d28d9' },
  { id: 'team', label: 'Team', icon: Users, from: '#ec4899', to: '#be185d' },
  { id: 'apps', label: 'Apps', icon: Blocks, from: '#06b6d4', to: '#0e7490' },
];
/** Two places outside the dashboard that belong in the dock: what waits for him, and the task board. */
const PLACES: { id: string; label: string; icon: LucideIcon; from: string; to: string; href: string }[] = [
  { id: 'wacht', label: 'Wacht op jou', icon: Inbox, from: '#f97316', to: '#c2410c', href: '#/inbox' },
  { id: 'taken', label: 'Taken', icon: ListChecks, from: '#14b8a6', to: '#0f766e', href: '#/tasks' },
];

/** An app's icon: a rounded tile in its own two colours, the sign in white. */
function AppIcon({ icon: Icon, from, to, size = 48 }: { icon: LucideIcon; from: string; to: string; size?: number }) {
  return (
    <span className="tb-app-icon flex shrink-0 items-center justify-center text-white" style={{ width: size, height: size, borderRadius: size * 0.3, background: `linear-gradient(145deg, ${from}, ${to})` }} aria-hidden>
      <Icon style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={2} />
    </span>
  );
}

/** The dock: every app as its icon, the one that is open marked. Always at the foot of the screen. */
function Dock({ active, inline }: { active: AppId; inline?: boolean }) {
  const waiting = useWaiting();
  return (
    <nav aria-label={t('Onderdelen van het dashboard')} className={inline ? 'flex shrink-0 px-3 pt-1' : 'pointer-events-none sticky bottom-3 z-30 mt-auto flex shrink-0 justify-center px-2 pt-6'} data-testid="dashboard-dock">
      <div className={cx('tb-glass tb-dock scroll-thin pointer-events-auto flex max-w-full items-end gap-1.5 overflow-x-auto px-2.5 pb-1.5 pt-2.5 sm:gap-2.5', inline && 'w-full')}>
        {APPS.map((a) => {
          const on = a.id === active;
          return (
            <a key={a.id || 'home'} href={a.id ? `#/dashboard/${a.id}` : '#/dashboard'} aria-current={on ? 'page' : undefined} className="tb-dock-item group flex w-[4.5rem] shrink-0 flex-col items-center gap-1 rounded-xl outline-none" data-testid={`dashboard-app-${a.id || 'home'}`}>
              <AppIcon icon={a.icon} from={a.from} to={a.to} size={44} />
              <span className={cx('max-w-full truncate text-[10.5px] leading-3', on ? 'font-semibold text-fg' : 'text-muted')}>{t(a.label)}</span>
              <span className={cx('size-1 rounded-full', on ? 'bg-fg' : 'bg-transparent')} aria-hidden />
            </a>
          );
        })}
        {inline && <span className="mx-0.5 mb-5 h-9 w-px shrink-0 bg-fg/15" aria-hidden />}
        {(inline ? PLACES : []).map((p) => (
          <a key={p.id} href={p.href} className="tb-dock-item group relative flex w-[4.5rem] shrink-0 flex-col items-center gap-1 rounded-xl outline-none" data-testid={`dashboard-place-${p.id}`}>
            <AppIcon icon={p.icon} from={p.from} to={p.to} size={44} />
            {p.id === 'wacht' && waiting > 0 && <span className="absolute -top-1 end-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1 text-[11px] font-bold tabular-nums text-danger-fg">{waiting}</span>}
            <span className="max-w-full truncate text-[10.5px] leading-3 text-muted">{t(p.label)}</span>
            <span className="size-1" aria-hidden />
          </a>
        ))}
      </div>
    </nav>
  );
}

/** A widget on the home screen: one pane of glass around a part. */
function Widget({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cx('tb-glass tb-widget', className)}>{children}</div>;
}

/**
 * The top of the home screen, one strip (4.17.0; was a big clock and three tall cards that were mostly empty): the
 * greeting and the day, the bots at work by their faces, and three counts that are each a way somewhere — what waits
 * for you, who works, which apps work. The time itself is in the menu bar.
 */
function Greeting({ apps }: { apps: AppRow[] | null }) {
  const me = useApp((s) => s.me);
  const { agents, busy } = useBusy();
  const waiting = useWaiting();
  const now = useClock();
  const hour = now.getHours();
  const hello = hour < 6 ? t('Goedenacht') : hour < 12 ? t('Goedemorgen') : hour < 18 ? t('Goedemiddag') : t('Goedenavond');
  const first = String(me?.name || '').trim().split(/\s+/)[0];
  const day = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const ok = (apps || []).filter((a) => appState(a).tone === 'ok').length;
  const stats: { key: string; icon: LucideIcon; from: string; to: string; title: string; value: string; href: string }[] = [
    { key: 'waiting', icon: Inbox, from: '#f97316', to: '#c2410c', title: t('Wacht op jou'), value: String(waiting), href: '#/inbox' },
    { key: 'team', icon: Users, from: '#ec4899', to: '#be185d', title: t('Aan het werk'), value: t('{0} van {1}', busy.length, agents.length), href: '#/dashboard/team' },
    { key: 'apps', icon: Blocks, from: '#06b6d4', to: '#0e7490', title: t('Apps werken'), value: apps === null ? '…' : t('{0} van {1}', ok, apps.length), href: '#/m/mcp/' },
  ];
  return (
    <div className="tb-glass tb-widget flex flex-wrap items-center gap-x-6 gap-y-4 px-5 py-4 sm:px-6" data-testid="dashboard-hero">
      <div className="min-w-0 flex-1">
        <div className="text-2xl font-bold tracking-tight sm:text-[28px]" translate="no">
          {first ? `${hello}, ${first}` : hello}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted">
          <span className="first-letter:uppercase">{day}</span>
          {agents.length > 0 && (
            <a href="#/dashboard/team" className="flex items-center gap-2 rounded-full pe-2 transition-colors hover:text-fg" title={botsBusy(busy.length, agents.length)}>
              <span className="flex -space-x-1.5">
                {(busy.length ? busy : agents).slice(0, 6).map((a) => (
                  <span key={a.id} className="rounded-full ring-2 ring-surface">
                    <BotAvatar bot={a} size={22} mood={busy.length ? 'working' : 'idle'} />
                  </span>
                ))}
              </span>
              {botsBusy(busy.length, agents.length)}
            </a>
          )}
        </div>
      </div>
      <div className="grid w-full grid-cols-3 gap-2 sm:w-auto" data-testid="dashboard-status">
        {stats.map((x) => (
          <a key={x.key} href={x.href} className="group flex flex-col items-start gap-2 rounded-2xl bg-fg/[0.05] px-3 py-2.5 transition-colors hover:bg-fg/[0.09] sm:min-w-[180px] sm:flex-row sm:items-center sm:gap-3" data-testid={`dashboard-stat-${x.key}`}>
            <AppIcon icon={x.icon} from={x.from} to={x.to} size={34} />
            <div className="min-w-0">
              <div className="text-[12px] font-medium leading-4 text-muted sm:truncate">{x.title}</div>
              <div className="text-lg font-bold leading-tight tracking-tight">{x.value}</div>
            </div>
          </a>
        ))}
      </div>
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
  const here = APPS.find((a) => a.id === app)!;
  // One app, whole.
  let one: React.ReactNode = null;
  if (app === 'cijfers') one = <NumbersApp rows={rows} numbers={numbers} err={err} several={several} />;
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
      {!desktop && <Dock active={app} inline />}
      <div className="mx-auto w-full max-w-[1500px] shrink-0 space-y-4 px-3 pb-4 pt-2 sm:px-4">
        <TeamFilterNote />
        {app === '' ? (
          <div className={cx('grid grid-cols-1 items-stretch gap-4 xl:grid-cols-12', desktop && 'pb-28')} data-testid="dashboard-home">
            <div className="xl:col-span-12">
              <Greeting apps={apps} />
            </div>
            <Widget className="xl:col-span-8">
              <NumbersBlock rows={rows} numbers={numbers} err={err} />
            </Widget>
            <Widget className="xl:col-span-4">
              <UsageSection meters={meters} costs={costs} compact />
            </Widget>
            <Widget className="xl:col-span-6">
              <MoneySection compact />
            </Widget>
            <Widget className="xl:col-span-6">
              <MailSection compact />
            </Widget>
            <Widget className="xl:col-span-4">
              <TasksBlock />
            </Widget>
            <Widget className="xl:col-span-4">
              <TeamSection />
            </Widget>
            <Widget className="xl:col-span-4">
              <AppsSection apps={apps} compact />
            </Widget>
          </div>
        ) : (
          <div className={cx('tb-glass tb-window min-h-[62vh]', desktop && 'mb-28')} data-testid="dashboard-window">
            <div className="flex h-12 items-center justify-between gap-3 border-b border-fg/10 px-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <AppIcon icon={here.icon} from={here.from} to={here.to} size={28} />
                <h1 className="truncate text-[15px] font-bold tracking-tight">{t(here.label)}</h1>
              </div>
              <a href="#/dashboard" aria-label={t('Sluiten')} className="flex size-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-fg/10 hover:text-fg" data-testid="dashboard-window-close">
                <X className="h-4 w-4" aria-hidden />
              </a>
            </div>
            <div className="tb-window-body p-4 sm:p-5">{one}</div>
          </div>
        )}
      </div>
      {desktop && <Dock active={app} />}
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
