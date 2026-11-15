import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Card, EmptyState, Page, PageHeader, timeAgo } from '../components/ui';
import { t } from '../lib/i18n';
import { teamApi, useTeamChanged } from '../modules/teamdata/api';
import { BotName } from '../modules/teamdata/parts';
import { TeamFilterNote } from '../modules/teams/FilterNote';
import { useTeamView } from '../modules/teams/scope';

type Tile = { id: number; sleutel: string; groep?: string | null; titel: string; waarde?: string | null; eenheid?: string | null; toelichting?: string | null; link?: string | null; bot?: string | null; bijgewerkt?: string | null; team?: string };

/**
 * Dashboard: the numbers the bots keep for the owner, on one screen (mail, customer questions, WhatsApp, turnover,
 * leads …; owner, 15 nov: "dan is het alles in 1"). Each tile is a row of the standard team table "dashboard"
 * (server/modules/teamdata/schema.ts) that a bot keeps on its own key; nothing here is typed by hand. By group, in the
 * order the bots gave.
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
      <PageHeader width="5xl" title="Dashboard" subtitle="De cijfers die je bots voor je bijhouden: mail, klantvragen, WhatsApp, omzet, leads en meer." />
      <div className="mx-auto max-w-5xl space-y-5 px-4 pb-10 sm:px-6">
        <TeamFilterNote />
        {err && <EmptyState title="Het dashboard laadt niet">{err}</EmptyState>}
        {rows && !rows.length && !err && (
          <EmptyState title="Nog leeg">Vraag een bot om zijn cijfers hier bij te houden, bijvoorbeeld: “houd op het dashboard bij hoeveel klantmails er openstaan”.</EmptyState>
        )}
        {[...groups].map(([g, list]) => (
          <section key={g} className="space-y-2" data-testid="dashboard-group">
            <h2 className="px-1 text-[13px] font-semibold uppercase tracking-wide text-muted" translate="no">
              {g}
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((r) => (
                <TileCard key={`${r.team || ''}:${r.id}`} r={r} team={several ? r.team : undefined} />
              ))}
            </div>
          </section>
        ))}
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
