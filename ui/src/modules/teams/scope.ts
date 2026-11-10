import { useMemo } from 'react';
import { create } from 'zustand';
import { api, on } from '../../lib/api';
import { ALL_TEAMS, effectiveTeam, homeMap, mainIdOf, type TeamLite } from '../../shell/teamFilter';
import { useTeamPick } from '../teamdata/api';

/**
 * The team switcher's state, shared by the sidebar, the phone and every page that filters by team: the owner's teams
 * (GET /api/teams, live) and the team he chose on this device (localStorage; '' = Alle teams).
 *
 * For pages that want to follow the switcher (routines, memory, usage …):
 *   const { activeId, active } = useTeamView();   // '' with one team or with "Alle teams"
 *   api.get(`/routines${teamQuery()}`)            // `?teamId=…` when a team is chosen, else ''
 * and show <TeamFilterNote /> (./FilterNote) so it is clear the page shows one team.
 */

const KEY = 'tb.team';

function readStored(): string {
  try {
    return localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
}

interface TeamState {
  teams: TeamLite[];
  loaded: boolean;
  /** The choice on this device (may name a team that is gone; see effectiveTeam). */
  stored: string;
}

export const useTeamStore = create<TeamState>(() => ({ teams: [], loaded: false, stored: readStored() }));

let inflight: Promise<void> | null = null;
let again = false;

/** (Re)load the teams. Overlapping calls give one extra load at most. */
export function loadTeams(): Promise<void> {
  if (inflight) {
    again = true;
    return inflight;
  }
  inflight = api
    .get<TeamLite[]>('/teams')
    .then((list) => {
      const teams = (Array.isArray(list) ? list : []).map((t) => ({ id: t.id, name: t.name, color: t.color, bots: (t.bots || []).map((b) => ({ id: b.id, name: b.name, ...(b.main === true ? { main: true } : {}) })) }));
      useTeamStore.setState({ teams, loaded: true });
    })
    .catch(() => useTeamStore.setState({ loaded: true })) // no teams module or no access: no switcher
    .finally(() => {
      inflight = null;
      if (again) {
        again = false;
        void loadTeams();
      }
    });
  return inflight;
}

/** Choose a team on this device ('' = Alle teams). */
export function setActiveTeam(id: string) {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the choice lasts until reload */
  }
  useTeamStore.setState({ stored: id || ALL_TEAMS });
}

/** The chosen team id right now ('' with one team or "Alle teams"), outside React (e.g. for a new bot). */
export function activeTeamId(): string {
  const s = useTeamStore.getState();
  return effectiveTeam(s.stored, s.teams);
}

/** `?teamId=<id>` while one team is chosen, else '' (for APIs that can filter by team). */
export function teamQuery(): string {
  const id = activeTeamId();
  return id ? `?teamId=${encodeURIComponent(id)}` : '';
}

/** Two or more teams: only then does anything about teams show. */
export function useMultiTeam(): boolean {
  return useTeamStore((s) => s.teams.length > 1);
}

/** The teams, whether there are several, and the chosen team (null = Alle teams). */
export function useTeamView() {
  const teams = useTeamStore((s) => s.teams);
  const stored = useTeamStore((s) => s.stored);
  const loaded = useTeamStore((s) => s.loaded);
  return useMemo(() => {
    const activeId = effectiveTeam(stored, teams);
    return { teams, loaded, multi: teams.length > 1, activeId, active: teams.find((t) => t.id === activeId) || null };
  }, [teams, stored, loaded]);
}

/**
 * The id of the owner's main bot (hoofdbot), or null: above all teams, first in the sidebar, opened on the desktop
 * start. Read from GET /api/teams (see mainIdOf), so a server without the main-bot role simply has none.
 * After package C2 is merged, its `useMainBot()` (./api) is the same information.
 */
export function useMainBotId(): string | null {
  return useTeamStore((s) => mainIdOf(s.teams));
}

/** Bot id → home team id (for the chat list). */
export function useHomeMap(): Map<string, string> {
  const teams = useTeamStore((s) => s.teams);
  return useMemo(() => homeMap(teams), [teams]);
}

/** Keep the teams live: called once from the teams module's init(). */
export function startTeamScope(): () => void {
  void loadTeams();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void loadTeams(), 250);
  };
  const offs = [on('teams.changed', soon), on('agent.updated', soon), on('agent.deleted', soon)];
  // Another window of this browser chose a team.
  const onStorage = (e: StorageEvent) => e.key === KEY && useTeamStore.setState({ stored: e.newValue || ALL_TEAMS });
  addEventListener('storage', onStorage);
  // Every team has its own team database (B2): a team chosen here is also the one Teamwerk and the team-database rows
  // of the task board show. "Alle teams" leaves Teamwerk on the team it shows (it always shows one).
  let followed = '';
  const offPick = useTeamStore.subscribe((s) => {
    const id = effectiveTeam(s.stored, s.teams);
    if (id === followed) return;
    followed = id;
    if (id && useTeamPick.getState().team !== id) useTeamPick.getState().set(id);
  });
  return () => {
    offPick();
    offs.forEach((f) => f());
    removeEventListener('storage', onStorage);
    if (timer) clearTimeout(timer);
  };
}
