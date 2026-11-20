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
import { appsWorking, botsBusy } from './dashboard/text';
import { MailSection } from './dashboard/Mail';
import { MoneySection } from './dashboard/Money';
import { TeamSection } from './dashboard/Team';

type Tile = { id: number; sleutel: string; groep?: string | null; titel: string; waarde?: string | null; eenheid?: string | null; toelichting?: string | null; link?: string | null; bot?: string | null; bijgewerkt?: string | null; team?: string };

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
    const g = String(r.groep || '').trim() || 'Overig';
    groups.set(g, [...(groups.get(g) || []), r]);
  }
  return (
    <Page>
      <PageHeader width="5xl" title="Dashboard" subtitle="Je hele zaak in één overzicht: je geld, je cijfers, je apps en je team." />
      <div className="mx-auto max-w-5xl space-y-6 px-4 pb-10 sm:px-6">
        <TeamFilterNote />
        <StatusRow apps={apps} />
        <MoneySection />
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
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {list.map((r) => (
                  <TileCard key={`${r.team || ''}:${r.id}`} r={r} team={several ? r.team : undefined} />
                ))}
              </div>
            </div>
          ))}
        </section>
        <AppsSection apps={apps} />
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <TeamSection />
          <MailSection />
        </div>
      </div>
    </Page>
  );
}

/** "2026-11-15 03:10:00" (local time, as SQLite writes it) as an ISO time, or null. */
function when(s?: string | null): string | null {
  const d = s ? new Date(String(s).replace(' ', 'T')) : null;
  return d && Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function TileCard({ r, team }: { r: Tile; team?: string }) {
  const at = when(r.bijgewerkt);
  const link = String(r.link || '');
  const linked = /^https?:\/\//i.test(link) || link.startsWith('#/');
  const card = (
    <Card className={`flex h-full flex-col gap-1 p-4${linked ? ' transition-colors group-hover:border-fg/30' : ''}`} data-testid="dashboard-tile">
      <div className="flex items-start justify-between gap-2 text-[13px] font-medium text-muted">
        <span translate="no">
          {r.titel}
          {team ? <span className="font-normal"> · {team}</span> : null}
        </span>
        {linked && <ArrowUpRight className="h-4 w-4 shrink-0 transition-colors group-hover:text-fg" aria-label={t('Openen')} />}
      </div>
      <div className="text-2xl font-bold tracking-tight" translate="no">
        {r.waarde ?? '–'}
        {r.eenheid ? <span className="ms-1 text-base font-semibold text-muted">{r.eenheid}</span> : null}
      </div>
      {r.toelichting && (
        <div className="text-[13px] text-muted" translate="no">
          {r.toelichting}
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
