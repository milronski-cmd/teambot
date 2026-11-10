import { useEffect, useState } from 'react';
import { api, on } from '../../lib/api';

/** Mirrors server/modules/teams (see docs/modules/teams.md). */
export type AccessLevel = 'none' | 'read' | 'direct';

export interface TeamProfile {
  company: string;
  about: string;
  tone: string;
  rules: string;
}

export interface TeamBot {
  id: string;
  name: string;
  avatar: string;
  color: string;
  role: string;
  lead: boolean;
  /** The owner's main bot (hoofdbot): it stands above the teams. */
  main?: boolean;
}

export interface TeamAccessRow {
  agentId: string;
  name: string;
  avatar: string;
  color: string;
  homeTeamId: string;
  homeTeamName: string;
  level: AccessLevel;
  main?: boolean;
}

/** The owner's main bot (GET /teams/main). */
export interface MainBot {
  id: string;
  name: string;
  avatar: string;
  color: string;
  role: string;
  archived: boolean;
  homeTeamId: string | null;
}

export interface OverviewItem {
  kind: 'approval' | 'question' | 'review' | 'proposal' | 'task' | 'delegation' | 'run' | 'routine' | 'missed';
  id: string;
  title: string;
  detail: string;
  who: string | null;
  at: string;
  link: string;
}

export interface Spend {
  calls: number;
  tokens: number;
  cost: number;
  value: number | null;
}

/** GET /teams/overview ("Alle teams"). */
export interface Overview {
  since: string;
  days: number;
  main:
    | (MainBot & {
        notDirected: { id: string; name: string }[];
        waiting: { count: number; items: OverviewItem[] };
        errors: { count: number; items: OverviewItem[] };
        usage: { today: Spend; week: Spend } | null;
      })
    | null;
  leaders: { id: string; name: string; avatar: string; color: string; teams: string[] }[];
  teams: {
    id: string;
    name: string;
    color: string;
    isDefault: boolean;
    lead: { id: string; name: string; avatar: string; color: string } | null;
    bots: { id: string; name: string; avatar: string; color: string; role: string; lead: boolean }[];
    directedBy: { id: string; name: string; main: boolean }[];
    open: { count: number; items: OverviewItem[] };
    waiting: { count: number; items: OverviewItem[] };
    results: OverviewItem[];
    errors: { count: number; items: OverviewItem[] };
    missed: { count: number; items: OverviewItem[] };
    usage: { today: Spend; week: Spend } | null;
  }[];
  usage: { source: 'team' | 'bots' } | null;
}

export interface Team {
  id: string;
  name: string;
  color: string;
  profile: TeamProfile;
  leadAgentId: string | null;
  leadName: string | null;
  folder: { path: string; label: string; mode: 'rw' | 'ro'; agents: 'all' | string[] } | null;
  sort: number;
  /** The team's own daily budget (USD, 0 = none) and what its bots spent today (package B2). */
  dailyBudgetUsd?: number;
  spentToday?: number;
  isDefault: boolean;
  bots: TeamBot[];
  access: TeamAccessRow[];
}

export interface TeamKey {
  kind: 'provider' | 'app' | 'login' | 'script';
  id: string;
  name: string;
  detail: string;
  teamId: string | null;
}

export const TEAM_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6'];

export const teamsApi = {
  list: () => api.get<Team[]>('/teams'),
  create: (body: { name: string; color?: string; profile?: Partial<TeamProfile> }) => api.post<Team>('/teams', body),
  update: (id: string, body: Partial<{ name: string; color: string; profile: Partial<TeamProfile>; leadAgentId: string | null; sort: number; dailyBudgetUsd: number }>) => api.patch<Team>(`/teams/${id}`, body),
  remove: (id: string) => api.del(`/teams/${id}`),
  /** A new team with copies of this team's bots (routines off); never memory, keys, channels or conversations. */
  duplicate: (id: string) => api.post<{ team: Team; bots: number; mainSkipped: string | null; warnings: string[] }>(`/teams/${id}/duplicate`, {}),
  setHome: (teamId: string, agentId: string) => api.put<Team>(`/teams/${teamId}/bots/${agentId}`, {}),
  setAccess: (teamId: string, agentId: string, level: AccessLevel) => api.put<Team>(`/teams/${teamId}/access/${agentId}`, { level }),
  keys: () => api.get<TeamKey[]>('/teams/keys'),
  setKeyScope: (kind: TeamKey['kind'], id: string, teamId: string | null) => api.put<TeamKey>(`/teams/keys/${kind}/${id}`, { teamId }),
  main: () => api.get<{ main: MainBot | null }>('/teams/main'),
  /** The new-bot flow chose "Hoofdbot": a single-use token for `settings.mainBot` of the new bot. */
  mainIntent: () => api.post<{ token: string }>('/teams/main/intent', {}),
  setMain: (agentId: string) => api.put<{ main: MainBot | null; notes: string[] }>(`/teams/main/${agentId}`, {}),
  clearMain: () => api.del('/teams/main'),
  overview: () => api.get<Overview>('/teams/overview'),
};

// ---- the main bot, shared by every component that shows it (one request, live on teams.changed) ----

let mainCache: MainBot | null | undefined;
let mainLoading: Promise<void> | null = null;
let mainWired = false;
const mainSubs = new Set<() => void>();
function loadMain() {
  mainLoading ??= teamsApi
    .main()
    .then((r) => void (mainCache = r.main))
    .catch(() => void (mainCache = mainCache ?? null))
    .finally(() => {
      mainLoading = null;
      for (const f of mainSubs) f();
    });
  return mainLoading;
}

/**
 * The owner's main bot: undefined while loading, null when there is none. Live: it follows teams.changed and bots that
 * are renamed, archived or deleted.
 */
export function useMainBot(): MainBot | null | undefined {
  const [, setTick] = useState(0);
  useEffect(() => {
    const f = () => setTick((n) => n + 1);
    mainSubs.add(f);
    if (!mainWired) {
      mainWired = true;
      on('teams.changed', () => void loadMain());
      on('agent.updated', (a: any) => mainCache && a?.id === mainCache.id && void loadMain());
      on('agent.deleted', (a: any) => mainCache && a?.id === mainCache.id && void loadMain());
    }
    if (mainCache === undefined) void loadMain();
    return () => void mainSubs.delete(f);
  }, []);
  return mainCache;
}

/** The owner's teams, live (teams.changed, and bots that are created, renamed or deleted). */
export function useTeams() {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [err, setErr] = useState('');
  const load = () =>
    teamsApi
      .list()
      .then((t) => (setTeams(t), setErr('')))
      .catch((e) => setErr(e?.message || String(e)));
  useEffect(() => {
    load();
    const a = on('teams.changed', () => load());
    const b = on('agent.updated', () => load());
    const c = on('agent.deleted', () => load());
    return () => (a(), b(), c());
  }, []);
  return { teams, err, reload: load };
}
