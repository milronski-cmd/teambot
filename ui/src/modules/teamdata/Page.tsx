import { useEffect, useState } from 'react';
import { FlaskConical, ListChecks, Scale, ScrollText, Table2, Waypoints } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Page, PageHeader, Select, Tabs } from '../../components/ui';
import { useAdvanced } from '../../shell/advanced';
import { useTeams } from '../teams/api';
import { usePickedSummary, useTeamPick, useTeamSummary } from './api';
import { DecisionsTab } from './Decisions';
import { TasksTab } from './Tasks';
import { EventsTab, ExperimentsTab, LogTab } from './Lists';
import { TablesTab } from './Tables';

type TabId = 'taken' | 'beslissingen' | 'logboek' | 'gebeurtenissen' | 'experimenten' | 'tabellen';
/** `advanced`: only with Instellingen › Geavanceerd tonen (or when a link opens that tab); decisions also wait in Wacht op jou. */
const TABS: { id: TabId; label: string; icon: LucideIcon; advanced?: boolean }[] = [
  { id: 'taken', label: 'Taken', icon: ListChecks },
  { id: 'beslissingen', label: 'Beslissingen', icon: Scale, advanced: true },
  { id: 'logboek', label: 'Logboek', icon: ScrollText },
  { id: 'gebeurtenissen', label: 'Gebeurtenissen', icon: Waypoints, advanced: true },
  { id: 'experimenten', label: 'Experimenten', icon: FlaskConical, advanced: true },
  { id: 'tabellen', label: 'Tabellen', icon: Table2, advanced: true },
];


/**
 * Teams (0.4, B2): every team has its own team database. From the second team on the page shows one team at a time
 * (a picker next to the title); "Wacht op jou" and the badge keep counting every team.
 */
function useTeamPicker() {
  const { teams } = useTeams();
  const team = useTeamPick((x) => x.team);
  useEffect(() => {
    if (!teams) return;
    const set = useTeamPick.getState().set;
    if (teams.length > 1 && !teams.some((t) => t.id === team)) set(teams[0].id);
    else if (teams.length <= 1 && team) set('');
  }, [teams, team]);
  return { teams: teams && teams.length > 1 ? teams : null, team };
}

/**
 * Teamwerk: what the bots keep together in the team database. Tabs per standard table, plus every table raw.
 * The tab is part of the link (#/m/teamdata/logboek) without remounting the page when you switch.
 */
export function TeamworkPage({ params }: { params: string[] }) {
  const first = (TABS.find((t) => t.id === params[0])?.id || 'taken') as TabId;
  const [tab, setTab] = useState<TabId>(first);
  const { teams, team } = useTeamPicker();
  const s = usePickedSummary();
  useEffect(() => void useTeamSummary.getState().load(), []);
  const go = (id: TabId) => {
    setTab(id);
    try {
      history.replaceState(null, '', `#/m/teamdata/${id}`);
    } catch {
      /* ignore */
    }
  };
  // Simple by default: the expert tabs only with "Geavanceerd tonen"; a tab opened by a link stays visible.
  const advanced = useAdvanced();
  const shown = TABS.filter((t) => advanced || !t.advanced || t.id === tab);
  return (
    <Page>
      <PageHeader
        width="full"
        title="Teamwerk"
        subtitle="Wat je bots samen bijhouden."
        back={{ href: '#/tasks', label: 'Taken' }}
        actions={
          // Every team has its own team database: from the second team on you pick which one you look at.
          teams && (
            <Select aria-label="Team" className="w-auto min-w-[10rem]" value={team} onChange={(e) => useTeamPick.getState().set(e.target.value)}>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          )
        }
      />
      <div className="space-y-4 px-4 pb-8 pt-2 sm:px-6">
        <Tabs
          value={tab}
          onChange={go}
          tabs={shown.map((t) => ({
            id: t.id,
            label: (
              <span className="inline-flex items-center gap-1.5">
                <t.icon className="h-3.5 w-3.5" aria-hidden />
                {t.label}
                {t.id === 'beslissingen' && !!s?.openDecisions && <span className="rounded-full bg-warn-strong px-1.5 text-[11px] font-bold text-warn-fg">{s.openDecisions}</span>}
              </span>
            ),
          }))}
        />
        {/* Another team: the tabs start fresh on that team's database. */}
        <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)!.label} key={`${team}:${tab}`} className="tb-in">

          {tab === 'taken' && <TasksTab />}
          {tab === 'beslissingen' && <DecisionsTab />}
          {tab === 'logboek' && <LogTab />}
          {tab === 'gebeurtenissen' && <EventsTab />}
          {tab === 'experimenten' && <ExperimentsTab />}
          {tab === 'tabellen' && <TablesTab />}
        </div>
      </div>
    </Page>
  );
}
