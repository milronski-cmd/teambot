import { useEffect, useState } from 'react';
import { ArrowUpRight, BarChart3, Inbox } from 'lucide-react';
import { Card, EmptyState, Page, PageHeader, SectionTitle, timeAgo } from '../components/ui';
import { t } from '../lib/i18n';
import { useApp } from '../lib/store';
import { teamApi, useTeamChanged } from '../modules/teamdata/api';
import { BotName } from '../modules/teamdata/parts';
import { TeamFilterNote } from '../modules/teams/FilterNote';
import { useTeamView } from '../modules/teams/scope';
import { uiModules, useInboxExtraCount } from '../modules';
import { ApprovalCard } from '../shell/ApprovalCard';
import { MailSection } from './dashboard/Mail';
import { MoneySection } from './dashboard/Money';
import { TeamSection } from './dashboard/Team';

type Tile = { id: number; sleutel: string; groep?: string | null; titel: string; waarde?: string | null; eenheid?: string | null; toelichting?: string | null; link?: string | null; bot?: string | null; bijgewerkt?: string | null; team?: string };

/**
 * What waits for the owner, right on the dashboard: the same cards as the page "Wacht op jou" (approvals, questions,
 * decisions, held customer answers), answered here.
 */
function WaitingSection() {
  const pending = useApp((s) => s.approvals);
  const extra = useInboxExtraCount();
  const n = pending.length + extra;
  return (
    <section className="space-y-2" data-testid="dashboard-waiting">
      <SectionTitle
        icon={Inbox}
        tone="orange"
        action={
          n > 0 && (
            <a href="#/inbox" className="text-sm text-muted hover:text-fg hover:underline">
              {t('Alles bekijken ({0})', n)}
            </a>
          )
        }
      >
        Wacht op jou
      </SectionTitle>
      {n === 0 ? (
        <Card className="p-4 text-sm text-muted">Niets dat op je wacht.</Card>
      ) : (
        <div className="space-y-3">
          {pending.slice(0, 5).map((a) => (
            <ApprovalCard key={a.id} a={a} showThreadLink />
          ))}
          {uiModules.map((m) => {
            const Section = m.inbox?.component;
            return Section ? <Section key={m.id} /> : null;
          })}
        </div>
      )}
    </section>
  );
}

/**
 * Dashboard: the owner's own workplace (20 nov 2026: "Ik heb geen inbox en zo erin. Ik moet er zelf ook in kunnen
 * werken"). From top to bottom: what waits for him (answered here), his mail (read, answer, or hand to a bot), his
 * money (the bank app), the team right now, and the numbers the bots keep (the tiles: rows of the standard team table
 * "dashboard", server/modules/teamdata/schema.ts). A part that is not connected yet says how to connect it.
 */
export function DashboardPage() {
  // The team chosen in the sidebar, or every team (each tile then names its team).
  const { activeId, multi } = useTeamView();
  const [rows, setRows] = useState<Tile[] | null>(null);
  const [err, setErr] = useState('');
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
      <PageHeader width="5xl" title="Dashboard" subtitle="Je werkplek: wat op je wacht, je post, je geld, je team en de cijfers die je bots bijhouden." />
      <div className="mx-auto max-w-5xl space-y-6 px-4 pb-10 sm:px-6">
        <TeamFilterNote />
        <WaitingSection />
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <MailSection />
          <div className="space-y-6">
            <MoneySection />
            <TeamSection />
          </div>
        </div>
        <section className="space-y-3" data-testid="dashboard-numbers">
          <SectionTitle icon={BarChart3} tone="amber">
            Cijfers
          </SectionTitle>
          {err && <EmptyState title="De cijfers laden niet">{err}</EmptyState>}
          {rows && !rows.length && !err && <Card className="p-4 text-sm text-muted">Vraag een bot om zijn cijfers hier bij te houden, bijvoorbeeld: “houd op het dashboard bij hoeveel klantmails er openstaan”.</Card>}
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
