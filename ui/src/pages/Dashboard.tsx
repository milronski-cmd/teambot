import { useEffect, useState } from 'react';
import { ArrowUpRight, BarChart3, Blocks, Inbox, Users } from 'lucide-react';
import { Card, EmptyState, IconTile, Page, PageHeader, SectionTitle, timeAgo } from '../components/ui';
import { t } from '../lib/i18n';
import { useApp } from '../lib/store';
import { teamApi, useTeamChanged } from '../modules/teamdata/api';
import { BotName } from '../modules/teamdata/parts';
import { TeamFilterNote } from '../modules/teams/FilterNote';
import { useTeamView } from '../modules/teams/scope';
import { useInboxExtraCount } from '../modules';
import { AppsSection, appState, useApps, type AppRow } from './dashboard/Apps';
import { appsWorking, botsBusy, courseChange, courseLabel, courseSame } from './dashboard/text';
import { MailSection } from './dashboard/Mail';
import { MoneySection } from './dashboard/Money';
import { TeamSection } from './dashboard/Team';

type Tile = { id: number; sleutel: string; groep?: string | null; titel: string; waarde?: string | null; eenheid?: string | null; toelichting?: string | null; link?: string | null; bot?: string | null; history?: { v: number; at: string }[]; bijgewerkt?: string | null; team?: string };

/**
 * The state of everything at a glance: what waits (a number and the way there, never the cards themselves: those are
 * the page "Wacht op jou"), who is at work, and how the connected apps stand.
 */
function StatusRow({ apps }: { apps: AppRow[] | null }) {
  const pending = useApp((s) => s.approvals);
  const agents = useApp((s) => s.agents);
  const runs = useApp((s) => s.runs);
  const extra = useInboxExtraCount();
  const waiting = pending.length + extra;
  const busy = agents.filter((a) => runs.some((r) => r.agent_id === a.id && (r.status === 'running' || r.status === 'queued'))).length;
  const ok = (apps || []).filter((a) => appState(a).tone === 'ok').length;
  const stats: { key: string; icon: typeof Inbox; tone: 'orange' | 'violet' | 'blue'; title: string; value: string; note: string; href: string }[] = [
    { key: 'waiting', icon: Inbox, tone: 'orange', title: t('Wacht op jou'), value: String(waiting), note: waiting ? t('Bekijken en beslissen') : t('Niets dat op je wacht'), href: '#/inbox' },
    { key: 'team', icon: Users, tone: 'violet', title: t('Team'), value: String(busy), note: botsBusy(busy, agents.length), href: '#/' },
    { key: 'apps', icon: Blocks, tone: 'blue', title: t('Apps'), value: apps === null ? '…' : String(apps.length), note: apps === null ? '' : appsWorking(ok, apps.length), href: '#/m/mcp' },
  ];
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="dashboard-status">
      {stats.map((x) => (
        <a key={x.key} href={x.href} className="group block rounded-card transition-transform hover:-translate-y-0.5" data-testid={`dashboard-stat-${x.key}`}>
          <Card className="flex h-full items-center gap-3 p-4 transition-colors group-hover:border-fg/30">
            <IconTile icon={x.icon} tone={x.tone} />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-muted">{x.title}</div>
              <div className="text-2xl font-bold leading-tight tracking-tight tabular-nums">{x.value}</div>
              <div className="truncate text-xs text-muted">{x.note}</div>
            </div>
            <ArrowUpRight className="h-4 w-4 shrink-0 text-muted transition-colors group-hover:text-fg" aria-hidden />
          </Card>
        </a>
      ))}
    </div>
  );
}

/**
 * Dashboard: the owner's overview of his whole business, like the home screen of an operating system (20 nov 2026:
 * "bij dashboard moet ik gewoon een overzicht hebben van mijn financiële status en bestellingen … gekoppelde apps en
 * alles zien. Een soort OS"). What waits for him is one number with the way to "Wacht op jou": the cards themselves
 * are there and nowhere else. Then his money (the bank app), the numbers the bots keep (turnover, orders, leads: the
 * tiles, rows of the standard team table "dashboard", server/modules/teamdata/schema.ts), every connected app and how
 * it stands, the team right now, and his mail. A part that is not connected yet says how to connect it.
 */
export function DashboardPage() {
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
  const groups = new Map<string, Tile[]>();
  for (const r of rows || []) {
    const raw = String(r.groep || '').trim() || 'Overig';
    const g = [...groups.keys()].find((k) => k.toLowerCase() === raw.toLowerCase()) || raw.charAt(0).toUpperCase() + raw.slice(1);
    groups.set(g, [...(groups.get(g) || []), r]);
  }
  return (
    <Page>
      <PageHeader width="6xl" title="Dashboard" subtitle="Je hele zaak in één overzicht: je geld, je cijfers, je apps en je team." />
      <div className="mx-auto max-w-6xl space-y-6 px-4 pb-10 sm:px-6">
        <TeamFilterNote />
        <StatusRow apps={apps} />
        {/* The business on the left (the numbers and the money), the day's work on the right (mail and team). */}
        <div className="grid items-start gap-6 xl:grid-cols-3">
          <div className="space-y-6 xl:col-span-2">
        <section className="space-y-3" data-testid="dashboard-numbers">
          <SectionTitle icon={BarChart3} tone="amber">
            Cijfers
          </SectionTitle>
          {err && <EmptyState title="De cijfers laden niet">{err}</EmptyState>}
          {rows && !rows.length && !err && <Card className="p-4 text-sm text-muted">Hier komen je omzet, je bestellingen en je aanvragen te staan zodra een bot ze bijhoudt. Vraag het een bot, bijvoorbeeld: “houd op het dashboard bij hoeveel bestellingen en hoeveel omzet er vandaag en deze week zijn”.</Card>}
          {[...groups].map(([g, list]) => (
            <div key={g} className="space-y-2" data-testid="dashboard-group">
              <h3 className="px-1 text-[13px] font-semibold uppercase tracking-wide text-muted" translate="no">
                {g}
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {list.map((r) => (
                  <TileCard key={`${r.team || ''}:${r.id}`} r={r} team={several ? r.team : undefined} />
                ))}
              </div>
            </div>
          ))}
        </section>
            <MoneySection />
          </div>
          <div className="space-y-6">
            <MailSection />
            <TeamSection />
          </div>
        </div>
        <AppsSection apps={apps} />
      </div>
    </Page>
  );
}

/** "2026-11-15 03:10:00" (local time, as SQLite writes it) as an ISO time, or null. */
function when(s?: string | null): string | null {
  const d = s ? new Date(String(s).replace(' ', 'T')) : null;
  return d && Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** The course of a number as a small line: where it came from and where it stands, with the change since the start. */
function Course({ points }: { points: { v: number; at: string }[] }) {
  if (points.length < 2) return null;
  const vs = points.map((p) => p.v);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const W = 240;
  const H = 44;
  const x = (i: number) => (i / (points.length - 1)) * (W - 4) + 2;
  const y = (v: number) => (hi === lo ? H / 2 : H - 4 - ((v - lo) / (hi - lo)) * (H - 8));
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${r1(x(i))},${r1(y(p.v))}`).join(' ');
  const diff = vs[vs.length - 1] - vs[0];
  const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const since = new Date(points[0].at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="mt-1" data-testid="dashboard-course">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-11 w-full text-accent" role="img" aria-label={courseLabel(points.length)} preserveAspectRatio="none">
        <path d={`${line} L${r1(x(points.length - 1))},${H} L${r1(x(0))},${H} Z`} fill="currentColor" opacity="0.12" />
        <path d={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="text-[12px] text-muted">{diff === 0 ? courseSame(since) : courseChange(`${diff > 0 ? '+' : ''}${fmt.format(diff)}`, since)}</div>
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
  const card = (
    <Card className={`flex h-full flex-col gap-1 p-4${linked ? ' transition-colors group-hover:border-fg/30' : ''}`} data-testid="dashboard-tile">
      <div className="flex items-start justify-between gap-2 text-[13px] font-medium text-muted">
        <span className="line-clamp-2" translate="no" title={r.titel}>
          {r.titel}
          {team ? <span className="font-normal"> · {team}</span> : null}
        </span>
        {linked && <ArrowUpRight className="h-4 w-4 shrink-0 transition-colors group-hover:text-fg" aria-label={t('Openen')} />}
      </div>
      <div className="text-2xl font-bold tracking-tight" translate="no">
        {r.waarde ?? '–'}
        {r.eenheid ? <span className="ms-1 text-base font-semibold text-muted">{r.eenheid}</span> : null}
      </div>
      <Course points={r.history || []} />
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
