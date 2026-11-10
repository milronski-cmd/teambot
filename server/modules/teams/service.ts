import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx, ProviderConfig } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import { bad, notFound } from '../../core/http.js';
import { trUser } from '../../core/i18n.js';
import { type AgentRoot, isInside as inside } from '../../tools/builtin/files.js';
import { teamSpentToday } from './budget.js';
import { cleanSiteUrl } from '../routines/duties/checks.js';

/** What a bot may do in a team that is not its home team. */
export type AccessLevel = 'read' | 'direct';
/** A bot's reach in one team: its home team, aansturen (direct, includes meekijken), meekijken (read) or nothing. */
export type Reach = 'home' | 'direct' | 'read' | 'none';
/** Kinds of keys that can be "alleen dit team" (wave 2 modules may add their own, e.g. channel). */
export type KeyKind = 'provider' | 'app' | 'login' | (string & {});
/** A module's copy of its team data (see TeamsService.copyTeamData); null/undefined = nothing to report. */
export type TeamCopier = (o: { userId: string; fromTeamId: string; toTeamId: string; knowledge: boolean; agentMap: Record<string, string> }) => any;

export interface TeamProfile {
  /** Name of the business (may differ from the team name). */
  company: string;
  /** What the business does. */
  about: string;
  /** Tone of voice. */
  tone: string;
  /** House rules every bot of the team follows. */
  rules: string;
  /** The team's websites (addresses), watched by the standing duties. Absent when there are none. */
  sites?: string[];
}

export interface TeamFolder {
  path: string;
  label: string;
  mode: 'rw' | 'ro';
  /** 'all' = every bot of the team; otherwise the ids of the team's bots that get the folder. */
  agents: 'all' | string[];
}

export interface TeamRow {
  id: string;
  user_id: string;
  name: string;
  color: string;
  profile: Partial<TeamProfile>;
  lead_agent_id: string | null;
  folder: TeamFolder | null;
  sort: number;
  /** Optional daily budget of the team (USD, 0 = none), on top of the owner's own (teams/budget.ts). */
  daily_budget_usd?: number;
  created_at: string;
  updated_at: string;
}

interface Snap {
  teams: TeamRow[];
  byId: Map<string, TeamRow>;
  /** agentId → home team id */
  home: Map<string, string>;
  /** `${agentId}|${teamId}` → level ('none' is only stored for the main bot, whose default is aansturen) */
  access: Map<string, AccessLevel | 'none'>;
  /** The owner's main bot (hoofdbot), or null. */
  main: string | null;
}

/** How long the choice "Hoofdbot" in the new-bot flow stays valid before the bot is created. */
const INTENT_MS = 6 * 3600_000;

export const DEFAULT_TEAM_NAME = 'Mijn team';
export const TEAM_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6'];
const LEGACY_FOLDER_KEY = 'teamFolder';
const ACCESS_LABEL: Record<Reach, string> = { home: 'thuisteam', direct: 'aansturen', read: 'meekijken', none: 'geen toegang' };

/** The real path of p (symlinks followed) for the part that exists, plus the rest as written. */
function realish(p: string): string {
  let check = path.resolve(p);
  const full = check;
  while (!fs.existsSync(check)) {
    const parent = path.dirname(check);
    if (parent === check) return full;
    check = parent;
  }
  try {
    return path.join(fs.realpathSync.native(check), path.relative(check, full));
  } catch {
    return full;
  }
}

function cleanText(v: any, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
export function cleanProfile(p: any): TeamProfile {
  const sites = cleanSites(p?.sites);
  return { company: cleanText(p?.company, 120), about: cleanText(p?.about, 2000), tone: cleanText(p?.tone, 500), rules: cleanText(p?.rules, 4000), ...(sites.length ? { sites } : {}) };
}
/** Web addresses as the owner typed them ("voorbeeld.nl", one per line or separated by commas) → clean, unique https URLs. */
export function cleanSites(raw: any): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,;]+/) : [];
  const out: string[] = [];
  for (const x of list) {
    const u = cleanSiteUrl(x);
    if (u && !out.includes(u)) out.push(u);
    if (out.length >= 20) break;
  }
  return out;
}
/** The websites of a team: what the owner listed, plus addresses written in the profile ("Website: https://…"). */
export function sitesOfProfile(p: Partial<TeamProfile> | null | undefined): string[] {
  const found = `${p?.about || ''}
${p?.company || ''}`.match(/https?:\/\/[^\s)>\]"']+/gi) || [];
  return cleanSites([...(p?.sites || []), ...found.map((u) => u.replace(/[.,;]+$/, ''))]);
}
function cleanColor(v: any, fallback: string): string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim().toLowerCase() : fallback;
}
function cleanFolder(raw: any): TeamFolder | null {
  if (!raw || typeof raw.path !== 'string' || !raw.path.trim()) return null;
  return {
    path: path.resolve(raw.path),
    label: String(raw.label || 'Gedeelde teammap').slice(0, 80),
    mode: raw.mode === 'ro' ? 'ro' : 'rw',
    agents: Array.isArray(raw.agents) ? raw.agents.filter((x: any) => typeof x === 'string') : 'all',
  };
}

/**
 * Teams as walled workspaces of one owner. Every bot has exactly one home team; per bot and per other team the owner
 * grants meekijken (read: the team folder read-only, wave 2 also its knowledge) or aansturen (direct: give tasks to
 * the team's lead and bots; includes meekijken). Keys are usable by every team unless set to "alleen dit team".
 * All checks are synchronous and served from a per-owner snapshot that is dropped on every change.
 */
export class TeamsService {
  private snaps = new Map<string, Snap>();
  private columns = new Map<string, boolean>();
  /** Open "Hoofdbot" choices of the new-bot flow: token → owner and expiry (single use, never in a template). */
  private intents = new Map<string, { userId: string; until: number }>();
  /** Used tokens → the bot they made the main bot (a stale copy of the flag on that bot is then dropped quietly). */
  private usedIntents = new Map<string, string>();

  constructor(public ctx: Ctx) {}

  // ------------------------------------------------------------------ snapshot

  touch(userId: string) {
    this.snaps.delete(userId);
    this.ctx.events.emit(userId, 'teams.changed', {});
  }

  private snap(userId: string): Snap {
    let s = this.snaps.get(userId);
    if (s) return s;
    const store = this.ctx.store;
    const teams = store.find<TeamRow>('teams', { user_id: userId }, { order: 'sort, created_at' });
    s = {
      teams,
      byId: new Map(teams.map((t) => [t.id, t])),
      home: new Map(store.all<{ agent_id: string; team_id: string }>('SELECT agent_id, team_id FROM team_bots WHERE user_id = ?', userId).map((r) => [r.agent_id, r.team_id])),
      access: new Map(store.all<{ agent_id: string; team_id: string; level: AccessLevel | 'none' }>('SELECT agent_id, team_id, level FROM team_access WHERE user_id = ?', userId).map((r) => [`${r.agent_id}|${r.team_id}`, r.level])),
      main: store.one<{ agent_id: string }>('SELECT agent_id FROM team_main WHERE user_id = ?', userId)?.agent_id ?? null,
    };
    this.snaps.set(userId, s);
    return s;
  }

  hasColumn(table: string, col: string): boolean {
    const k = `${table}.${col}`;
    let v = this.columns.get(k);
    if (v === undefined) {
      v = this.ctx.store.all<{ name: string }>(`PRAGMA table_info(${JSON.stringify(table)})`).some((c) => c.name === col);
      this.columns.set(k, v);
    }
    return v;
  }

  /** The agent as stored in this app's database (tests run several apps in one process: never act on another's bot). */
  private local(agent: Pick<Agent, 'id' | 'user_id'> | string | null | undefined): Agent | null {
    if (!agent) return null;
    const a = this.ctx.store.agent(typeof agent === 'string' ? agent : agent.id);
    if (!a) return null;
    // A shared bot in a member's conversation is a copy with the member's user id (agent/shared.ts): it is still the
    // owner's bot in the owner's team (its own folders, apps and logins are already left out of that copy).
    const owner = typeof agent === 'string' ? a.user_id : (agent as Agent).settings?.sharedRun?.ownerId || agent.user_id;
    return a.user_id === owner ? a : null;
  }

  // ------------------------------------------------------------------ teams

  list(userId: string): TeamRow[] {
    return this.snap(userId).teams;
  }

  team(id: string | null | undefined): TeamRow | null {
    return id ? this.ctx.store.get<TeamRow>('teams', id) : null;
  }

  own(userId: string, id: string): TeamRow {
    const t = this.team(id);
    if (!t || t.user_id !== userId) throw notFound('Team niet gevonden');
    return t;
  }

  /** The first team (by order): new bots land here, and so does everything that existed before teams. */
  defaultTeam(userId: string): TeamRow | null {
    return this.snap(userId).teams[0] || null;
  }

  /** Two or more teams: only then do team words show up in prompts and the UI. */
  multi(userId: string): boolean {
    return this.snap(userId).teams.length > 1;
  }

  /**
   * The default team, created when missing ("Mijn team"): the upgrade path (everything that exists moves in) and the
   * first bot on a fresh install. The old shared team folder becomes this team's folder; the existing org chart
   * (room_teams, departments) is filed under it, and a single top-level chief of staff becomes its lead.
   */
  ensureDefault(userId: string): TeamRow {
    const cur = this.defaultTeam(userId);
    if (cur) return cur;
    const store = this.ctx.store;
    const ts = now();
    const legacy = cleanFolder(store.getSetting<any>(userId, LEGACY_FOLDER_KEY, null));
    // The default name in the owner's language ("My team"): it is stored, so the page dictionary never reaches it.
    const t: TeamRow = { id: newId('tm_'), user_id: userId, name: trUser(store, userId, DEFAULT_TEAM_NAME), color: TEAM_COLORS[0], profile: {}, lead_agent_id: null, folder: legacy, sort: 0, created_at: ts, updated_at: ts };
    store.tx(() => {
      store.insert('teams', t);
      if (legacy) store.setSetting(userId, LEGACY_FOLDER_KEY, null);
      for (const a of store.agents(userId, { archived: true }))
        if (!store.one('SELECT 1 FROM team_bots WHERE agent_id = ?', a.id)) store.insert('team_bots', { agent_id: a.id, user_id: userId, team_id: t.id, created_at: ts, updated_at: ts });
      if (this.hasColumn('room_teams', 'workspace_id')) {
        store.exec('UPDATE room_teams SET workspace_id = ? WHERE user_id = ? AND workspace_id IS NULL', t.id, userId);
        const chiefs = store.all<{ c: string }>('SELECT DISTINCT chief_agent_id AS c FROM room_teams WHERE user_id = ? AND parent_id IS NULL AND chief_agent_id IS NOT NULL', userId).filter((r) => store.agent(r.c));
        if (chiefs.length === 1) {
          t.lead_agent_id = chiefs[0].c;
          store.update('teams', t.id, { lead_agent_id: t.lead_agent_id });
        }
      }
      if (this.hasColumn('room_tasks', 'workspace_id')) store.exec('UPDATE room_tasks SET workspace_id = ? WHERE user_id = ? AND workspace_id IS NULL', t.id, userId);
    });
    this.ctx.audit(userId, 'team.created', { teamId: t.id, name: t.name, implicit: true });
    this.touch(userId);
    return this.team(t.id)!;
  }

  create(userId: string, data: any): TeamRow {
    const name = cleanText(data?.name, 60);
    if (!name) throw bad('Geef het team een naam.');
    const s = this.snap(userId);
    if (s.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw bad(`Er is al een team “${name}”.`);
    if (s.teams.length >= 50) throw bad('Je hebt het maximum van 50 teams bereikt.');
    const ts = now();
    const t: TeamRow = {
      id: newId('tm_'),
      user_id: userId,
      name,
      color: cleanColor(data?.color, TEAM_COLORS[s.teams.length % TEAM_COLORS.length]),
      profile: cleanProfile(data?.profile),
      lead_agent_id: null,
      folder: null,
      sort: s.teams.length ? Math.max(...s.teams.map((x) => x.sort)) + 1 : 0,
      created_at: ts,
      updated_at: ts,
    };
    this.ctx.store.insert('teams', t);
    this.ctx.audit(userId, 'team.created', { teamId: t.id, name });
    this.touch(userId);
    return this.team(t.id)!;
  }

  update(userId: string, id: string, data: any): TeamRow {
    const t = this.own(userId, id);
    const p: any = { updated_at: now() };
    if (data?.name !== undefined) {
      const name = cleanText(data.name, 60);
      if (!name) throw bad('De naam van het team mag niet leeg zijn.');
      if (this.snap(userId).teams.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) throw bad(`Er is al een team “${name}”.`);
      p.name = name;
    }
    if (data?.color !== undefined) p.color = cleanColor(data.color, t.color);
    if (data?.profile !== undefined) p.profile = cleanProfile({ ...t.profile, ...(data.profile || {}) });
    if (data?.sort !== undefined) p.sort = Number(data.sort) || 0;
    if (data?.dailyBudgetUsd !== undefined) {
      const v = Number(data.dailyBudgetUsd);
      if (!Number.isFinite(v) || v < 0) throw bad('Het dagbudget van het team is een bedrag van 0 of meer (0 = geen eigen dagbudget).');
      p.daily_budget_usd = Math.min(10_000, Math.round(v * 100) / 100);
    }
    if (data?.leadAgentId !== undefined) {
      if (data.leadAgentId) {
        const a = this.local(String(data.leadAgentId));
        if (!a || a.user_id !== userId) throw bad('Onbekende bot.');
        if (this.homeOf(a) !== id) throw bad(`${a.name} hoort niet bij dit team. Kies een bot van dit team als teamleider.`);
        if (this.snap(userId).main === a.id) throw bad(`${a.name} is je hoofdbot en staat boven de teams. Kies een andere bot als teamleider, of laat het team zonder teamleider.`);
        p.lead_agent_id = a.id;
      } else p.lead_agent_id = null;
    }
    this.ctx.store.update('teams', id, p);
    this.ctx.audit(userId, 'team.updated', { teamId: id, fields: Object.keys(p).filter((k) => k !== 'updated_at') });
    this.touch(userId);
    return this.team(id)!;
  }

  /** Only an empty team can go: no bots and no keys that are only for this team (nothing is moved or widened silently). */
  remove(userId: string, id: string) {
    const t = this.own(userId, id);
    const store = this.ctx.store;
    const bots = store.one<{ n: number }>('SELECT COUNT(*) AS n FROM team_bots WHERE team_id = ?', id)?.n ?? 0;
    if (bots) throw bad(bots === 1 ? 'Dit team heeft nog 1 bot. Verplaats die eerst naar een ander team.' : `Dit team heeft nog ${bots} bots. Verplaats ze eerst naar een ander team.`);
    const keys = store.one<{ n: number }>('SELECT COUNT(*) AS n FROM team_key_scopes WHERE team_id = ?', id)?.n ?? 0;
    if (keys) throw bad(keys === 1 ? 'Er is nog 1 sleutel alleen voor dit team. Zet die eerst op alle teams of op een ander team.' : `Er zijn nog ${keys} sleutels alleen voor dit team. Zet ze eerst op alle teams of op een ander team.`);
    store.tx(() => {
      store.exec('DELETE FROM team_access WHERE team_id = ?', id);
      if (this.hasColumn('room_teams', 'workspace_id')) store.exec('UPDATE room_teams SET workspace_id = NULL WHERE workspace_id = ?', id);
      if (this.hasColumn('room_tasks', 'workspace_id')) store.exec('UPDATE room_tasks SET workspace_id = NULL WHERE workspace_id = ?', id);
      store.remove('teams', id);
    });
    this.ctx.audit(userId, 'team.deleted', { teamId: id, name: t.name });
    this.touch(userId);
  }

  // ------------------------------------------------------------------ bots: home team and access

  /** Home team of a bot (assigned to the default team the first time, which creates "Mijn team" when needed). */
  homeOf(agent: Agent): string {
    const s = this.snap(agent.user_id);
    const h = s.home.get(agent.id);
    if (h && s.byId.has(h)) return h;
    return this.assign(agent).id;
  }

  /** Home team id of a bot in this app, or null for an unknown bot. */
  teamOf(agentId: string | null | undefined): string | null {
    const a = this.local(agentId || null);
    return a ? this.homeOf(a) : null;
  }

  /**
   * A bot was created or changed (event agent.updated): a new bot gets its home team right away, the one named in
   * `settings.homeTeam` when that is one of the owner's teams (the wave-2 team switcher), otherwise the default team.
   */
  onAgent(a: Agent | null | undefined) {
    const local = this.local(a || null);
    if (!local) return;
    const s = this.snap(local.user_id);
    const h = s.home.get(local.id);
    if (!(h && s.byId.has(h))) {
      this.assign(local, typeof local.settings?.homeTeam === 'string' ? local.settings.homeTeam : null);
      this.touch(local.user_id);
    }
    if (local.settings && 'mainBot' in local.settings) this.takeIntent(local);
  }

  /** A bot without a home team gets one: `preferred` when it is one of the owner's teams, otherwise the default. */
  assign(agent: Agent, preferred?: string | null): TeamRow {
    const team = (preferred && this.team(preferred)?.user_id === agent.user_id ? this.team(preferred) : null) || this.ensureDefault(agent.user_id);
    const store = this.ctx.store;
    const ts = now();
    if (store.one('SELECT 1 FROM team_bots WHERE agent_id = ?', agent.id)) store.update('team_bots', agent.id, { team_id: team.id, updated_at: ts }, 'agent_id');
    else store.insert('team_bots', { agent_id: agent.id, user_id: agent.user_id, team_id: team.id, created_at: ts, updated_at: ts });
    this.snaps.delete(agent.user_id);
    return team;
  }

  /** Move a bot to another home team. Access to its new home is dropped; it stops being the lead of the old one. */
  setHome(userId: string, teamId: string, agentId: string) {
    const team = this.own(userId, teamId);
    const a = this.local(agentId);
    if (!a || a.user_id !== userId) throw notFound('Bot niet gevonden');
    const from = this.homeOf(a);
    if (from === team.id) return;
    const store = this.ctx.store;
    store.tx(() => {
      store.update('team_bots', a.id, { team_id: team.id, updated_at: now() }, 'agent_id');
      store.exec('DELETE FROM team_access WHERE agent_id = ? AND team_id = ?', a.id, team.id);
      store.exec('UPDATE teams SET lead_agent_id = NULL WHERE id = ? AND lead_agent_id = ?', from, a.id);
    });
    this.ctx.audit(userId, 'team.bot_moved', { from, to: team.id }, a.id);
    this.touch(userId);
  }

  setAccess(userId: string, teamId: string, agentId: string, level: any) {
    const team = this.own(userId, teamId);
    const a = this.local(agentId);
    if (!a || a.user_id !== userId) throw notFound('Bot niet gevonden');
    if (!['none', 'read', 'direct'].includes(level)) throw bad('Kies een van: geen toegang, meekijken of aansturen.');
    if (this.homeOf(a) === team.id) throw bad(`${team.name} is het thuisteam van ${a.name}; daar heeft hij altijd toegang.`);
    const store = this.ctx.store;
    const cur = store.one<{ id: string }>('SELECT id FROM team_access WHERE agent_id = ? AND team_id = ?', a.id, team.id);
    // Without a row a normal bot has no access and the main bot aansturen: that default is never stored.
    const isDefault = level === (this.snap(userId).main === a.id ? 'direct' : 'none');
    if (isDefault) {
      if (cur) store.remove('team_access', cur.id);
    } else if (cur) store.update('team_access', cur.id, { level, updated_at: now() });
    else store.insert('team_access', { id: newId('tma_'), user_id: userId, agent_id: a.id, team_id: team.id, level, created_at: now(), updated_at: now() });
    this.ctx.audit(userId, 'team.access', { teamId: team.id, level }, a.id);
    this.touch(userId);
  }

  /** The bot's reach in a team. Bots of another owner never reach anything. The main bot directs every team by default. */
  access(agentId: string, teamId: string): Reach {
    const a = this.local(agentId);
    if (!a) return 'none';
    const s = this.snap(a.user_id);
    const t = s.byId.get(teamId);
    if (!t) return 'none';
    if (this.homeOf(a) === teamId) return 'home';
    const set = s.access.get(`${a.id}|${teamId}`);
    if (set) return set;
    return s.main === a.id ? 'direct' : 'none';
  }

  /** Teams a bot may give work to (home team and aansturen), home team first. */
  directableTeams(agentId: string): string[] {
    const a = this.local(agentId);
    if (!a) return [];
    const home = this.homeOf(a);
    return [home, ...this.snap(a.user_id).teams.filter((t) => t.id !== home && this.canDirect(a.id, t.id)).map((t) => t.id)];
  }

  // ------------------------------------------------------------------ main bot (hoofdbot) and leaders

  /** The owner's main bot id (null when there is none, or it no longer exists). */
  mainOf(userId: string): string | null {
    const id = this.snap(userId).main;
    return id && this.ctx.store.agent(id)?.user_id === userId ? id : null;
  }

  isMain(agentId: string | null | undefined): boolean {
    const a = this.local(agentId || null);
    return !!a && this.snap(a.user_id).main === a.id;
  }

  /**
   * A leader: any bot other than the main bot that may give work to more than one team (its home team plus aansturen
   * on at least one other team). It directs the leads (or, in a team without a lead, the bots) of those teams.
   */
  isLeader(agentId: string): boolean {
    return !this.isMain(agentId) && this.directableTeams(agentId).length > 1;
  }

  /**
   * Make a bot the owner's main bot. There is at most one: with another main bot this is refused (make that one a
   * normal bot first). The main bot directs every team (access rows of the bot are dropped, so the default applies),
   * and stops being a team lead (it stands above the teams); the returned notes say so.
   */
  setMain(userId: string, agentId: string): { notes: string[] } {
    const a = this.local(agentId);
    if (!a || a.user_id !== userId) throw notFound('Bot niet gevonden');
    if (a.archived) throw bad(`${a.name} staat in het archief. Haal de bot eerst terug uit het archief.`);
    const cur = this.mainOf(userId);
    if (cur === a.id) return { notes: [] };
    if (cur) {
      const n = this.ctx.store.agent(cur)?.name || 'een andere bot';
      throw bad(`Je hebt al een hoofdbot: ${n}. Er kan er maar één zijn; maak ${n} eerst een gewone bot.`);
    }
    this.homeOf(a);
    const store = this.ctx.store;
    const notes: string[] = [];
    store.tx(() => {
      store.exec('DELETE FROM team_main WHERE user_id = ?', userId);
      store.exec('INSERT INTO team_main (user_id, agent_id, created_at) VALUES (?, ?, ?)', userId, a.id, now());
      store.exec('DELETE FROM team_access WHERE agent_id = ?', a.id);
      for (const t of store.all<{ id: string; name: string }>('SELECT id, name FROM teams WHERE user_id = ? AND lead_agent_id = ?', userId, a.id)) {
        store.exec('UPDATE teams SET lead_agent_id = NULL, updated_at = ? WHERE id = ?', now(), t.id);
        notes.push(`${a.name} is geen teamleider meer van team “${t.name}”: de hoofdbot staat boven de teams.`);
      }
    });
    // Handing work on needs the team tools (delegate_task and the rest); they are switched on, and that is said.
    if (!(a.tool_groups || []).includes('team')) {
      const upd = store.updateAgent(a.id, { tool_groups: [...(a.tool_groups || []), 'team'] });
      this.ctx.events.emit(userId, 'agent.updated', upd);
      notes.push(`De tools ‘Team & samenwerking’ staan nu aan voor ${a.name}, zodat hij werk kan doorgeven.`);
    }
    // Team tools are team-internal (Broker: they run without asking in 'ask' mode); only these two modes block them.
    if (a.access_mode === 'chat' || a.access_mode === 'readonly')
      notes.push(`${a.name} staat op ‘${a.access_mode === 'chat' ? 'Alleen chat' : 'Alleen lezen'}’ en kan zo geen werk doorgeven. Kies in de bot-editor bij Toegang ‘Vraagt toestemming’ of ruimer.`);
    this.ctx.audit(userId, 'team.main_set', { name: a.name, notes }, a.id);
    this.touch(userId);
    return { notes };
  }

  /** The main bot becomes a normal bot: no access to other teams any more (the owner gives it again where wanted). */
  clearMain(userId: string) {
    const cur = this.mainOf(userId);
    const store = this.ctx.store;
    store.tx(() => {
      store.exec('DELETE FROM team_main WHERE user_id = ?', userId);
      if (cur) store.exec("DELETE FROM team_access WHERE agent_id = ? AND level = 'none'", cur);
    });
    if (cur) this.ctx.audit(userId, 'team.main_cleared', { name: this.ctx.store.agent(cur)?.name || '' }, cur);
    this.touch(userId);
  }

  /**
   * The new-bot flow chose "Hoofdbot": a single-use token that the flow puts in `settings.mainBot` of the bot it creates.
   * Only that makes a new bot the main bot, so a bot template or import that carries the flag never does.
   */
  intent(userId: string): string {
    const cur = this.mainOf(userId);
    if (cur) {
      const n = this.ctx.store.agent(cur)?.name || 'een andere bot';
      throw bad(`Je hebt al een hoofdbot: ${n}. Er kan er maar één zijn.`);
    }
    const t = Date.now();
    for (const [k, v] of this.intents) if (v.until < t) this.intents.delete(k);
    const token = newId('mbi_');
    this.intents.set(token, { userId, until: t + INTENT_MS });
    return token;
  }

  /** A bot was saved with `settings.mainBot`: honour a valid token once, always drop the flag from the bot. */
  private takeIntent(a: Agent) {
    const { mainBot: flag, ...rest } = a.settings || {};
    const store = this.ctx.store;
    store.update('agents', a.id, { settings: rest });
    this.ctx.events.emit(a.user_id, 'agent.updated', store.agent(a.id));
    if (typeof flag !== 'string' || !flag) return;
    if (this.usedIntents.get(flag) === a.id || this.snap(a.user_id).main === a.id) return;
    const it = this.intents.get(flag);
    const fresh = Date.now() - Date.parse(a.created_at) < 10 * 60_000;
    const fail = (why: string) => {
      this.ctx.audit(a.user_id, 'team.main_refused', { name: a.name, why }, a.id);
      this.ctx.events.emit(a.user_id, 'notification', { title: `${a.name} is een gewone bot geworden`, body: why, link: '#/m/teams/alle', kind: 'team' });
    };
    if (!it || it.userId !== a.user_id || it.until < Date.now()) {
      // Only a bot that was just made with an expired choice is told so; a stale flag elsewhere is dropped quietly.
      if (fresh) fail(`De keuze “Hoofdbot” was verlopen. Maak ${a.name} hoofdbot via Alle teams › Hoofdbot.`);
      return;
    }
    this.intents.delete(flag);
    this.usedIntents.set(flag, a.id);
    try {
      // What changed on the way (team tools on, asks before handing on …) is said once, as for an existing bot.
      const { notes } = this.setMain(a.user_id, a.id);
      if (notes.length) this.ctx.events.emit(a.user_id, 'notification', { title: `${a.name} is je hoofdbot`, body: notes.join(' '), link: `#/agents/${a.id}`, kind: 'team' });
    } catch (e: any) {
      fail(String(e?.message || e));
    }
  }

  canRead(agentId: string, teamId: string) {
    return this.access(agentId, teamId) !== 'none';
  }
  /** Writing team data (folder, knowledge) is for the team's own bots only. */
  canWrite(agentId: string, teamId: string) {
    return this.access(agentId, teamId) === 'home';
  }
  canDirect(agentId: string, teamId: string) {
    const r = this.access(agentId, teamId);
    return r === 'home' || r === 'direct';
  }
  /** Teams whose shared knowledge a bot may read: its home team first, then meekijken and aansturen. */
  readableTeams(agentId: string): string[] {
    const a = this.local(agentId);
    if (!a) return [];
    const home = this.homeOf(a);
    return [home, ...this.snap(a.user_id).teams.filter((t) => t.id !== home && this.canRead(a.id, t.id)).map((t) => t.id)];
  }

  botsOf(teamId: string): string[] {
    const t = this.team(teamId);
    if (!t) return [];
    const s = this.snap(t.user_id);
    return [...s.home.entries()].filter(([, tid]) => tid === teamId).map(([aid]) => aid).filter((aid) => !!this.ctx.store.agent(aid));
  }

  /**
   * Why `fromId` may not give work to `toId` (delegate, ask, message, broadcast, handoff, a task as owner): null when
   * both are in the same team or the sender may aansturen the target's team.
   */
  delegateError(fromId: string, toId: string): string | null {
    const a = this.local(fromId);
    const b = this.local(toId);
    if (!a || !b || a.user_id !== b.user_id || a.id === b.id) return null;
    const s = this.snap(a.user_id);
    // Work flows down the organisation: the main bot only takes work from the owner. Results still come back up to it.
    if (s.main === b.id) return `Geweigerd door TeamBot: ${b.name} is de hoofdbot en krijgt alleen opdrachten van de eigenaar. Zet wat je nog nodig hebt in je resultaat; dat gaat vanzelf terug naar wie jou het werk gaf.`;
    if (!this.multi(a.user_id)) return null;
    const ta = this.homeOf(a);
    const tb = this.homeOf(b);
    if (ta !== tb) {
      const r = this.access(a.id, tb);
      if (r !== 'direct') {
        const nb = s.byId.get(tb)?.name || 'een ander team';
        return `Geweigerd door TeamBot: ${b.name} hoort bij team “${nb}”, en ${a.name} mag dat team niet aansturen${r === 'read' ? ' (alleen meekijken)' : ''}. Werk het zelf af of vraag de eigenaar om toegang (Instellingen › Teams).`;
      }
    }
    // No way around a team wall through another bot: the target may not direct or look into a team the sender cannot,
    // or the sender would get work done in (or knowledge out of) that team after all.
    for (const t of s.teams) {
      if (t.id === tb) continue;
      const rb = this.access(b.id, t.id);
      if (rb === 'none') continue;
      const ra = this.access(a.id, t.id);
      if (rb === 'direct' && ra !== 'direct' && ra !== 'home')
        return `Geweigerd door TeamBot: ${b.name} mag team “${t.name}” aansturen en ${a.name} niet, dus zou ${a.name} via ${b.name} toch werk aan dat team geven. Werk gaat alleen omlaag in de organisatie: geef het aan een bot die niet meer teams aanstuurt dan jij, of vraag de eigenaar om toegang (Instellingen › Teams).`;
      if (ra === 'none')
        return `Geweigerd door TeamBot: ${b.name} mag meekijken bij team “${t.name}” en ${a.name} niet, dus zou kennis van dat team via ${b.name} bij ${a.name} terechtkomen. Geef het aan een andere bot, of vraag de eigenaar om toegang (Instellingen › Teams).`;
    }
    return null;
  }

  // ------------------------------------------------------------------ keys

  keyScope(kind: KeyKind, refId: string): string | null {
    return this.ctx.store.one<{ team_id: string }>('SELECT team_id FROM team_key_scopes WHERE kind = ? AND ref_id = ?', kind, refId)?.team_id ?? null;
  }

  /** May this bot use this key? Every team may, unless the key is "alleen dit team" for another team. */
  keyAllowed(agent: Pick<Agent, 'id' | 'user_id'> | string, kind: KeyKind, refId: string): boolean {
    const scope = this.keyScope(kind, refId);
    if (!scope) return true;
    const a = this.local(agent);
    return !!a && this.homeOf(a) === scope;
  }

  /** The reason a bot may not run on a provider (ProviderRegistry bot guard), or null. */
  providerRefusal(agent: Agent, cfg: ProviderConfig): string | null {
    const scope = this.keyScope('provider', cfg.id);
    if (!scope) return null;
    const a = this.local(agent);
    if (!a) return `"${cfg.name}" is alleen voor één team.`;
    if (this.homeOf(a) === scope) return null;
    const s = this.snap(a.user_id);
    return `"${cfg.name}" is alleen voor team “${s.byId.get(scope)?.name || 'een ander team'}”, en ${a.name} hoort bij team “${s.byId.get(this.homeOf(a))?.name || ''}”. Kies voor deze bot een andere AI-provider, of zet de sleutel op alle teams (Instellingen › Teams).`;
  }

  setKeyScope(userId: string, kind: string, refId: string, teamId: string | null) {
    const k = this.keys(userId).find((x) => x.kind === kind && x.id === refId);
    if (!k) throw notFound('Sleutel niet gevonden');
    if (teamId) this.own(userId, teamId);
    const store = this.ctx.store;
    store.exec('DELETE FROM team_key_scopes WHERE kind = ? AND ref_id = ?', kind, refId);
    if (teamId) store.insert('team_key_scopes', { id: newId('tmk_'), user_id: userId, kind, ref_id: refId, team_id: teamId, created_at: now() });
    this.ctx.audit(userId, 'team.key_scope', { kind, ref: refId, teamId });
    this.touch(userId);
  }

  /** The owner's keys and logins with their scope: AI providers, connected apps (MCP), website logins and script keys. */
  keys(userId: string): { kind: 'provider' | 'app' | 'login' | 'script'; id: string; name: string; detail: string; teamId: string | null }[] {
    const store = this.ctx.store;
    const scopes = new Map(store.all<{ kind: string; ref_id: string; team_id: string }>('SELECT kind, ref_id, team_id FROM team_key_scopes WHERE user_id = ?', userId).map((r) => [`${r.kind}|${r.ref_id}`, r.team_id]));
    const out: ReturnType<TeamsService['keys']> = [];
    const scope = (kind: string, id: string) => scopes.get(`${kind}|${id}`) ?? null;
    for (const p of store.all<{ id: string; name: string; kind: string }>('SELECT id, name, kind FROM providers WHERE user_id = ? ORDER BY created_at', userId))
      out.push({ kind: 'provider', id: p.id, name: p.name, detail: this.ctx.providers.kind(p.kind)?.label || p.kind, teamId: scope('provider', p.id) });
    if (this.hasTable('mcp_connections'))
      for (const c of store.all<{ id: string; name: string; label: string }>('SELECT id, name, label FROM mcp_connections WHERE user_id = ? ORDER BY name', userId))
        out.push({ kind: 'app', id: c.id, name: c.label ? `${c.name} (${c.label})` : c.name, detail: 'App', teamId: scope('app', c.id) });
    if (this.hasTable('vault_logins'))
      for (const l of store.all<{ id: string; label: string; origins: string }>('SELECT id, label, origins FROM vault_logins WHERE user_id = ? ORDER BY label', userId)) {
        let origin = '';
        try {
          origin = (JSON.parse(l.origins) as string[])[0] || '';
        } catch {
          /* keep empty */
        }
        out.push({ kind: 'login', id: l.id, name: l.label || origin.replace(/^https?:\/\//, '') || 'Login', detail: origin.replace(/^https?:\/\//, ''), teamId: scope('login', l.id) });
      }
    // "Sleutels voor scripts" (module script-keys): environment variables for the scripts of a bot.
    if (this.hasTable('script_keys'))
      for (const k of store.all<{ id: string; name: string; label: string }>('SELECT id, name, label FROM script_keys WHERE user_id = ? ORDER BY name', userId))
        out.push({ kind: 'script', id: k.id, name: k.name, detail: k.label || '', teamId: scope('script', k.id) });
    return out;
  }

  hasTable(name: string): boolean {
    const k = `table:${name}`;
    let v = this.columns.get(k);
    if (v === undefined) {
      v = !!this.ctx.store.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name);
      this.columns.set(k, v);
    }
    return v;
  }

  // ------------------------------------------------------------------ team folders

  /** The old single team folder (a user setting) is an inbox for the default team's folder (OpenBot import, scripts). */
  adoptLegacy(userId: string) {
    const raw = this.ctx.store.getSetting<any>(userId, LEGACY_FOLDER_KEY, null);
    if (!raw) return;
    const def = this.defaultTeam(userId);
    if (!def) return;
    const tf = cleanFolder(raw);
    this.ctx.store.setSetting(userId, LEGACY_FOLDER_KEY, null);
    if (tf) {
      this.ctx.store.update('teams', def.id, { folder: tf, updated_at: now() });
      this.touch(userId);
    }
  }

  teamFolder(teamId: string): TeamFolder | null {
    const t = this.team(teamId);
    if (!t) return null;
    this.adoptLegacy(t.user_id);
    return this.team(teamId)?.folder || null;
  }

  /** Folder of the default team, or the old setting while there is no team yet (legacy callers, search). */
  defaultFolder(userId: string): TeamFolder | null {
    const def = this.defaultTeam(userId);
    if (!def) return cleanFolder(this.ctx.store.getSetting<any>(userId, LEGACY_FOLDER_KEY, null));
    return this.teamFolder(def.id);
  }

  /** Set or clear a team's folder. Team folders never overlap: one folder belongs to one team. */
  setFolder(userId: string, teamId: string, tf: TeamFolder | null) {
    const team = this.own(userId, teamId);
    this.adoptLegacy(userId);
    let clean = tf ? cleanFolder(tf) : null;
    if (clean) {
      const real = realish(clean.path);
      for (const o of this.list(userId))
        if (o.id !== team.id && o.folder && (inside(real, realish(o.folder.path)) || inside(realish(o.folder.path), real)))
          throw bad(`Deze map overlapt met de teammap van “${o.name}”. Kies een aparte map voor elk team.`);
      if (clean.agents !== 'all') {
        const mine = new Set(this.botsOf(team.id));
        clean = { ...clean, agents: clean.agents.filter((id) => mine.has(id) || this.ctx.store.agent(id)?.user_id === userId) };
      }
    }
    this.ctx.store.update('teams', team.id, { folder: clean, updated_at: now() });
    this.touch(userId);
    return clean;
  }

  /** Team folders a bot gets: its home team's (as set, for the chosen bots) and, read-only, those it may look into. */
  foldersFor(agent: Agent): AgentRoot[] {
    const a = this.local(agent);
    if (!a) return [];
    this.adoptLegacy(a.user_id);
    const s = this.snap(a.user_id);
    if (!s.teams.length) return [];
    const home = this.homeOf(a);
    const out: AgentRoot[] = [];
    const ht = s.byId.get(home);
    if (ht?.folder && (ht.folder.agents === 'all' || ht.folder.agents.includes(a.id))) out.push({ path: ht.folder.path, mode: ht.folder.mode, kind: 'team', label: ht.folder.label });
    for (const t of s.teams) {
      if (t.id === home || !t.folder) continue;
      const r = this.access(a.id, t.id);
      if (r === 'read' || r === 'direct') out.push({ path: t.folder.path, mode: 'ro', kind: 'extra', label: `Teammap van ${t.name} (meekijken)` });
    }
    return out;
  }

  /** The folder of another team that contains `real`, with the bot's reach there (null: not in another team's folder). */
  private foreignFolder(a: Agent, real: string): { team: TeamRow; reach: Reach } | null {
    const s = this.snap(a.user_id);
    if (s.teams.length < 2) return null;
    const home = this.homeOf(a);
    for (const t of s.teams) {
      if (t.id === home || !t.folder) continue;
      if (inside(real, realish(t.folder.path))) return { team: t, reach: this.access(a.id, t.id) };
    }
    return null;
  }

  /** Root filter (tools/builtin/files.ts): a folder inside another team's folder only with access, and then read-only. */
  filterRoots(agent: Agent, roots: AgentRoot[]): AgentRoot[] {
    const a = this.local(agent);
    if (!a || this.snap(a.user_id).teams.length < 2) return roots;
    return roots.flatMap((r) => {
      if (r.kind === 'workspace') return [r];
      const f = this.foreignFolder(a, realish(r.path));
      if (!f) return [r];
      if (f.reach === 'none') return [];
      return [{ ...r, mode: 'ro' as const }];
    });
  }

  /** Path guard (resolveInWorkspace): another team's folder is closed without access and read-only with access. */
  pathRefusal(agent: Agent, real: string, write: boolean): string | null {
    const a = this.local(agent);
    if (!a) return null;
    const f = this.foreignFolder(a, real);
    if (!f) return null;
    if (f.reach === 'none') return `Geweigerd door TeamBot: deze map hoort bij team “${f.team.name}”, en ${a.name} heeft geen toegang tot dat team.`;
    if (write) return `Geweigerd door TeamBot: deze map hoort bij team “${f.team.name}”; ${a.name} mag daar alleen meekijken (lezen), niet schrijven.`;
    return null;
  }

  // ------------------------------------------------------------------ views

  view(t: TeamRow, viewerId: string) {
    const s = this.snap(t.user_id);
    const agents = this.ctx.store.agents(t.user_id);
    const bots = agents.filter((a) => this.homeOf(a) === t.id);
    const others = agents.filter((a) => this.homeOf(a) !== t.id);
    const lead = t.lead_agent_id ? this.ctx.store.agent(t.lead_agent_id) : null;
    return {
      id: t.id,
      name: t.name,
      color: t.color,
      profile: cleanProfile(t.profile),
      leadAgentId: lead ? lead.id : null,
      leadName: lead?.name || null,
      folder: t.folder,
      sort: t.sort,
      dailyBudgetUsd: Number(t.daily_budget_usd) || 0,
      spentToday: teamSpentToday(this.ctx, this, t.id),
      isDefault: s.teams[0]?.id === t.id,
      own: t.user_id === viewerId,
      bots: bots.map((a) => ({ id: a.id, name: a.name, avatar: a.avatar, color: a.color, role: a.role, lead: a.id === t.lead_agent_id, main: a.id === s.main })),
      access: others.map((a) => {
        const home = this.homeOf(a);
        const r = this.access(a.id, t.id);
        return { agentId: a.id, name: a.name, avatar: a.avatar, color: a.color, homeTeamId: home, homeTeamName: s.byId.get(home)?.name || '', level: r === 'direct' || r === 'read' ? r : 'none', main: a.id === s.main };
      }),
      created_at: t.created_at,
      updated_at: t.updated_at,
    };
  }

  /** A bot's teams in one view (for the bot editor and wave-2 pickers). */
  botView(agent: Agent) {
    const s = this.snap(agent.user_id);
    const home = this.homeOf(agent);
    return {
      agentId: agent.id,
      homeTeamId: home,
      homeTeamName: s.byId.get(home)?.name || '',
      main: s.main === agent.id,
      leader: this.isLeader(agent.id),
      teams: this.snap(agent.user_id).teams.map((t) => ({ teamId: t.id, name: t.name, color: t.color, reach: this.access(agent.id, t.id), label: ACCESS_LABEL[this.access(agent.id, t.id)] })),
    };
  }

  // ------------------------------------------------------------------ copying a team (duplicate / template)

  private copiers = new Map<string, TeamCopier>();

  /**
   * A module copies its own team data when a team is duplicated (memory: dossiers and shared knowledge, only with
   * "vakkennis meenemen"). Returns a function that removes the copier.
   */
  registerCopier(id: string, fn: TeamCopier): () => void {
    this.copiers.set(id, fn);
    return () => {
      if (this.copiers.get(id) === fn) this.copiers.delete(id);
    };
  }

  /**
   * Copy one team's data into another team of the same owner, module by module (whoever duplicates a team calls
   * this after making the new team and its bots). Copying never copies memory unless `knowledge` is true ("vakkennis
   * meenemen", off by default), and never keys, channels or conversations. Per module: what it copied, or its error.
   */
  copyTeamData(userId: string, fromTeamId: string, toTeamId: string, o: { knowledge?: boolean; agentMap?: Record<string, string> } = {}): Record<string, any> {
    this.own(userId, fromTeamId);
    this.own(userId, toTeamId);
    if (fromTeamId === toTeamId) throw bad('Kies twee verschillende teams.');
    const out: Record<string, any> = {};
    for (const [id, fn] of this.copiers) {
      try {
        const r = fn({ userId, fromTeamId, toTeamId, knowledge: o.knowledge === true, agentMap: o.agentMap || {} });
        if (r) out[id] = r;
      } catch (e: any) {
        out[id] = { error: String(e?.message || e) };
      }
    }
    if (Object.keys(out).length) this.ctx.audit(userId, 'team.copied', { from: fromTeamId, to: toTeamId, knowledge: o.knowledge === true, modules: Object.keys(out) });
    return out;
  }

  // ------------------------------------------------------------------ lifecycle

  /** On start: every owner who has bots but no team yet (an update from 0.3) gets "Mijn team" with everything in it. */
  upgrade() {
    for (const r of this.ctx.store.all<{ user_id: string }>('SELECT DISTINCT user_id FROM agents')) {
      if (!this.ctx.store.one('SELECT 1 FROM teams WHERE user_id = ? LIMIT 1', r.user_id)) this.ensureDefault(r.user_id);
    }
  }

  agentDeleted(agentId: string, userId: string) {
    const store = this.ctx.store;
    store.exec('DELETE FROM team_bots WHERE agent_id = ?', agentId);
    store.exec('DELETE FROM team_access WHERE agent_id = ?', agentId);
    store.exec('UPDATE teams SET lead_agent_id = NULL WHERE lead_agent_id = ?', agentId);
    store.exec('DELETE FROM team_main WHERE agent_id = ?', agentId);
    this.touch(userId);
  }

  exportUser(userId: string) {
    const store = this.ctx.store;
    return {
      teams: {
        teams: store.find('teams', { user_id: userId }),
        bots: store.find('team_bots', { user_id: userId }),
        access: store.find('team_access', { user_id: userId }),
        keyScopes: store.find('team_key_scopes', { user_id: userId }),
        main: store.all('SELECT * FROM team_main WHERE user_id = ?', userId),
      },
    };
  }
}
