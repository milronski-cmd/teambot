import type { Agent, Ctx } from '../../core/types.js';

/**
 * Feature detection for the 0.4 parts the import lands in. Each bridge is null when that part is not in this TeamBot,
 * and the import then says what it did instead. Only the public services (`ctx.services.teams`, `specialists`,
 * `teamdata`); the parts and the names used are listed in docs/modules/openbot-import.md under "Afhankelijkheden".
 */

type Fn = (...a: any[]) => any;
function pick(objs: any[], ...names: string[]): Fn | null {
  for (const o of objs) {
    if (!o) continue;
    for (const n of names) if (typeof o[n] === 'function') return o[n].bind(o);
  }
  return null;
}

export interface TeamFolderLike {
  path: string;
  label: string;
  mode: 'rw' | 'ro';
  agents: 'all' | string[];
}
export interface TeamLike {
  id: string;
  user_id: string;
  name: string;
  lead_agent_id: string | null;
  folder: TeamFolderLike | null;
}

/** Teams as workspaces (package B, `ctx.services.teams`). */
export interface TeamsBridge {
  list(userId: string): TeamLike[];
  team(teamId: string): TeamLike | null;
  botsOf(teamId: string): string[];
  teamOf(agentId: string): string | null;
  create(userId: string, data: { name: string }): TeamLike;
  /** Team lead (a bot of this team) or null. */
  setLead(userId: string, teamId: string, agentId: string | null): void;
  setHome(userId: string, teamId: string, agentId: string): void;
  /** Only an empty team (no bots, no keys only for it). */
  remove(userId: string, teamId: string): void;
  teamFolder(teamId: string): TeamFolderLike | null;
  setFolder(userId: string, teamId: string, folder: TeamFolderLike | null): TeamFolderLike | null;
}

export function teamsBridge(ctx: Ctx): TeamsBridge | null {
  const t = ctx.services.teams;
  if (!t) return null;
  const objs = [t];
  const list = pick(objs, 'list');
  const team = pick(objs, 'team');
  const botsOf = pick(objs, 'botsOf');
  const teamOf = pick(objs, 'teamOf');
  const create = pick(objs, 'create', 'createTeam');
  const update = pick(objs, 'update', 'updateTeam');
  const setHome = pick(objs, 'setHome', 'moveBot');
  const remove = pick(objs, 'remove', 'removeTeam', 'deleteTeam');
  const teamFolder = pick(objs, 'teamFolder');
  const setFolder = pick(objs, 'setFolder');
  if (!list || !team || !botsOf || !teamOf || !create || !update || !setHome || !remove || !teamFolder || !setFolder) return null;
  return {
    list: (u) => list(u),
    team: (id) => team(id),
    botsOf: (id) => botsOf(id),
    teamOf: (id) => teamOf(id),
    create: (u, d) => create(u, d),
    setLead: (u, id, a) => void update(u, id, { leadAgentId: a }),
    setHome: (u, id, a) => void setHome(u, id, a),
    remove: (u, id) => void remove(u, id),
    teamFolder: (id) => teamFolder(id),
    setFolder: (u, id, f) => setFolder(u, id, f),
  };
}

/** The main bot (hoofdbot, package C): at most one per owner. */
export interface MainBotBridge {
  /** Id of the owner's main bot, or null. */
  current(userId: string): string | null;
  /** Make a bot the main bot (refused when there is one already); notes in Dutch. */
  set(userId: string, agentId: string): { notes: string[] };
  /** The main bot becomes a normal bot again (for undo), when the module offers it. */
  clear: ((userId: string) => void) | null;
}

export function mainBotBridge(ctx: Ctx): MainBotBridge | null {
  const t = ctx.services.teams;
  const objs = [t];
  const set = pick(objs, 'setMain', 'setMainBot');
  if (!set) return null;
  const cur = pick(objs, 'mainOf', 'mainBot', 'currentMain');
  const clear = pick(objs, 'clearMain', 'clearMainBot');
  return {
    clear: clear ? (u) => void clear(u) : null,
    current: (u) => {
      const v = cur ? cur(u) : null;
      return (typeof v === 'string' ? v : v?.id) || settingsMain(ctx, u);
    },
    set: (u, a) => {
      const r = set(u, a);
      return { notes: Array.isArray(r?.notes) ? r.notes.map(String) : [] };
    },
  };
}

/** A bot that carries the main role in its settings (`settings.role === 'main'`), whatever module put it there. */
export function settingsMain(ctx: Ctx, userId: string): string | null {
  return ctx.store.agents(userId, { archived: true }).find((a) => a.settings?.role === 'main')?.id ?? null;
}

/** The owner's current main bot, also without the main-bot module (by its settings). */
export function currentMain(ctx: Ctx, userId: string): Agent | null {
  const id = mainBotBridge(ctx)?.current(userId) ?? settingsMain(ctx, userId);
  const a = id ? ctx.store.agent(id) : null;
  return a && a.user_id === userId ? a : null;
}

export interface SpecialistSpec {
  field: string;
  sources: { label: string; url?: string }[];
  /** The learning round stays off: the owner switches it on. */
  learning: 'off';
  from: 'openbot';
}

/** Specialists that learn (package S, `ctx.services.specialists`). */
export interface SpecialistsBridge {
  make(userId: string, agent: Agent, spec: SpecialistSpec): void;
}

export function specialistsBridge(ctx: Ctx): SpecialistsBridge | null {
  const s = ctx.services.specialists;
  if (typeof s?.importForAgent !== 'function') return null;
  return {
    // S's own entry for a field with suggested sources (they stay "voorgesteld"; the learning round stays off).
    make: (u, agent, spec) => {
      const suggestedSources = spec.sources.filter((x) => x.url).map((x) => ({ url: x.url!, label: x.label }));
      const ok = s.importForAgent(u, agent.id, { field: spec.field, suggestedSources });
      if (!ok && !s.profile?.(agent.id)?.enabled) throw new Error('het vakgebied werd niet aangenomen');
    },
  };
}

/** The team database (package teamdata; B2 adds a team per table/row). */
export interface TeamDataBridge {
  /** True when the team database keeps data per team (the import then passes the team id). */
  perTeam: boolean;
  importTables(userId: string, teamId: string | null, tables: { name: string; sql: string; rows: Record<string, any>[] }[], owner: (table: string) => any): Promise<{ name: string; created: boolean; inserted: number; skipped: number; renumbered: number; error?: string }[]>;
  importedCounts(userId: string, teamId: string | null): Record<string, number>;
  svc: any;
}

export function teamDataBridge(ctx: Ctx): TeamDataBridge | null {
  const td = ctx.services.teamdata;
  if (!td || typeof td.importTables !== 'function') return null;
  // Per team when the service says so, or when importTables takes the options argument ({ teamId }).
  const perTeam = td.perTeam === true || td.teams === true || typeof td.forTeam === 'function' || td.importTables.length >= 5;
  return {
    perTeam,
    svc: td,
    importTables: (u, teamId, tables, owner) => (perTeam && teamId ? td.importTables(u, 'openbot', tables, owner, { teamId }) : td.importTables(u, 'openbot', tables, owner)),
    importedCounts: (u, teamId) => (typeof td.importedCounts === 'function' ? (perTeam && teamId ? td.importedCounts(u, 'openbot', { teamId }) : td.importedCounts(u, 'openbot')) || {} : {}),
  };
}
