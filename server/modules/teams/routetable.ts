import type { Agent, Ctx } from '../../core/types.js';
import type { TeamsService } from './service.js';
import { writeRefusal as coreWriteRefusal } from '../memory/living.js';
import { PLACE } from '../../../shared/places.js';

/**
 * What a call of TeamBot's own API is about, per route, and who decides when an ordinary bot makes it through
 * teambot_do (manage.ts) in an installation with two or more teams. The main bot works TeamBot as the owner, and with
 * one team there is nothing to keep from anyone: then none of this applies (reach.ts `reachOf`).
 *
 * Every route has one kind (`kindOf`); a route without one is a gap (tests/teams-reach.test.ts builds the list from
 * the routes that are registered, so a new route fails that test until it has a kind here):
 *  - team    something of one team (a bot, a routine, a task, a conversation, a channel …). The ids in the call say
 *            which (reach.ts); the bot's access to that team decides: meekijken to look, aansturen or its own team to
 *            change. What is of a team it cannot look into is not there for it.
 *  - shared  TeamBot itself or something every team shares (settings, AI connections for all teams, workflows, apps and
 *            skills for all teams, the shared browser profiles and desktop, the memory's blocks and reports …). Every bot
 *            may look; a change goes on the owner's word only (his own chain, or his Ja on the card), as every change.
 *  - totals  an answer over all teams (spend, counts, the briefing). A bot that cannot look into every team gets the
 *            answer for the teams it can look into, its own team only, or a plain refusal; never a number that
 *            includes a team it cannot look into.
 *  - home    a call that names a team or falls back to one: without a team named it is the bot's own home team, never
 *            the default team.
 *  - memory  a dossier, a note, a team's knowledge. Looking as for a team; writing only in the bot's own team, by the
 *            same checks as its memory tools (the memory module's `dossierWriteRefusal`, `itemWriteRefusal`,
 *            `teamWriteRefusal` and, for the core dossiers, `writeRefusal`).
 *  - whole   all of memory at once (delete all, empty the trash, tidy up, import). The owner's alone: only in a chain he
 *            started himself (a card is not enough), only within the bot's own team where the route can say so;
 *            otherwise refused.
 *  - newbot  makes one or more bots: they land in the bot's own team (or a team it may aansturen), never in a team it
 *            may not aansturen.
 *  - list    a full list of bots (who may use an app or a skill): what the bot cannot see is kept, not dropped.
 * A route manage.ts never lets through (keys, sessions, back-up restore …) has no kind: `refusal` there decides.
 */
export type Kind = 'team' | 'shared' | 'totals' | 'home' | 'memory' | 'whole' | 'newbot' | 'list';

/** Who decides, per kind, in one line (for the table and its test). */
export const DECIDES: Record<Kind, string> = {
  team: 'de toegang van de bot tot het team waar het bij hoort: meekijken om te kijken, aansturen of eigen team om te veranderen',
  shared: 'iedere bot mag kijken; veranderen alleen op het woord van de eigenaar',
  totals: 'alleen over de teams waar de bot in mag kijken, anders zijn eigen team of geweigerd',
  home: 'het team dat genoemd wordt (met de toegang van de bot); zonder team het eigen team van de bot',
  memory: 'kijken als bij een team; schrijven alleen in het eigen team van de bot (de muren van het geheugen)',
  whole: 'alleen de eigenaar zelf, in een keten die hij begon; alleen binnen het eigen team van de bot, anders geweigerd',
  newbot: 'de nieuwe bot komt in het eigen team van de bot, of een team dat hij aanstuurt; nooit elders',
  list: 'de bot past alleen aan wat hij ziet; bots van teams die hij niet ziet blijven staan',
};

/** One call as a rule sees it. `query` and `body` are the bot's own copy: a rule may change them. */
export interface RuleCall {
  method: string;
  path: string;
  /** The values of the route's :params. */
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
}

export interface RuleEnv {
  ctx: Ctx;
  svc: TeamsService;
  agent: Agent;
  /** The bot's home team. */
  home: string;
  /** There is a team the bot cannot look into (a total over all teams is not for it). */
  walls: boolean;
  /** The memory service (null when memory is off). */
  memory: any | null;
  /** The sentence for something behind a wall (a team without access is never named). */
  closed: string;
  canRead(teamId: string | null | undefined): boolean;
  canDirect(teamId: string | null | undefined): boolean;
}

export interface Rule {
  kind: Kind;
  /** Before the call: why this bot may not make it (one sentence), or nothing. May change `c.query` and `c.body`. */
  before?(c: RuleCall, e: RuleEnv): string | null | void;
  /**
   * After the walls of the ids in the call: what the bot does not decide is added (a full list keeps the bots of teams
   * it may not aansturen). Runs only when the call may go.
   */
  merge?(c: RuleCall, e: RuleEnv): void;
  /** Only on the owner's own word in a chain he started himself: refused otherwise, also with a card. */
  ownerChain?: boolean;
  /** The answer as this bot may see it. */
  after?(json: any, c: RuleCall, e: RuleEnv): any;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const ALL = '*';

// ---------- new bots ----------

/** The team a new bot lands in when a route takes `settings.homeTeam`: the bot's own team unless it names one it may aansturen. */
function homeTeamIn(settingsOf: (b: any) => any, e: RuleEnv, b: any): string | null {
  const s = settingsOf(b);
  const named = text(s?.homeTeam);
  if (!named) {
    if (isObj(s)) s.homeTeam = e.home;
    return null;
  }
  const t = e.svc.team(named);
  if (!t || t.user_id !== e.agent.user_id || !e.canDirect(named)) return newBotRefusal(e);
  return null;
}
const newBotRefusal = (e: RuleEnv) =>
  `Geweigerd door TeamBot: ${e.agent.name} maakt alleen bots in zijn eigen team of in een team dat hij aanstuurt. Laat het team weg (settings.homeTeam of teamId); dan komt de bot in je eigen team.`;
/** A route that cannot say where its bots go: they land in `landing`; only when the bot may aansturen that team. */
const landsIn = (e: RuleEnv, landing: string | null | undefined, what: string) =>
  landing && e.canDirect(landing) ? null : `Geweigerd door TeamBot: ${what} komt in een team dat ${e.agent.name} niet aanstuurt, en deze actie kan geen ander team kiezen. Maak de bot met POST /agents; dan komt hij in je eigen team.`;
const defaultTeam = (e: RuleEnv) => e.svc.defaultTeam(e.agent.user_id)?.id ?? null;
/** A skills install takes `teamId`: the bot's own team unless it names one it may aansturen; never "alle teams". */
function teamIdOfInstall(c: RuleCall, e: RuleEnv): string | null {
  if (!isObj(c.body)) c.body = {};
  const named = text(c.body.teamId);
  if (!named) {
    c.body.teamId = e.home;
    return null;
  }
  if (named === ALL) return `Geweigerd door TeamBot: iets voor alle teams installeert alleen de eigenaar. Laat teamId weg; dan komt het in het team van ${e.agent.name}.`;
  return e.canDirect(named) ? null : newBotRefusal(e);
}

// ---------- no team named: the bot's own team ----------

/**
 * A route that falls back to the default team when no team is named: for this bot it is its own team. `query` and
 * `body` are the names of the field that says the team there (the routes read one or the other, some both); "all"
 * falls back to the default team too. A named team stays: its id is walled like any id (reach.ts).
 */
function homeTeam(fields: { query?: string; body?: string }, o: { unless?: (c: RuleCall) => boolean; allTeams?: 'refuse' } = {}) {
  return (c: RuleCall, e: RuleEnv): string | null => {
    if (o.unless?.(c)) return null;
    const inBody = fields.body && isObj(c.body) ? c.body[fields.body] : undefined;
    const named = text(inBody) || (fields.query ? text(c.query.get(fields.query)) : '');
    if (named === ALL && o.allTeams === 'refuse') return `Geweigerd door TeamBot: iets voor alle teams regelt alleen de eigenaar. Laat het team weg; dan is het voor het team van ${e.agent.name}.`;
    if (named && named !== 'all') return null;
    if (fields.query && (c.method === 'GET' || c.method === 'DELETE' || !fields.body)) c.query.set(fields.query, e.home);
    if (fields.body && c.method !== 'GET' && c.method !== 'DELETE') {
      if (!isObj(c.body)) c.body = {};
      c.body[fields.body] = e.home;
    }
    return null;
  };
}
/** A team's task by "<team>:<n>": the team is in the id itself. */
const ownTeamInId = (c: RuleCall) => /:/.test(c.params.id || c.params.ref || '');
const teamdata = homeTeam({ query: 'team', body: 'teamId' }, { unless: ownTeamInId });
const folders = homeTeam({ query: 'teamId' }, { unless: (c) => !!c.query.get('agentId') });
const skills = homeTeam({ query: 'teamId', body: 'teamId' }, { allTeams: 'refuse' });

// ---------- totals over all teams ----------

const ACROSS = 'Getallen over alle teams samen krijgt alleen de eigenaar; dit zijn de gegevens van de teams waar jij in mag kijken.';
/** A route that can be asked per team: a bot that cannot look into every team asks it for its own team. */
const ownTeamTotals = (key: string) => (c: RuleCall, e: RuleEnv) => {
  if (!e.walls) return null;
  const named = text(c.query.get(key));
  if (!named || named === 'all' || named === ALL) c.query.set(key, e.home);
  return null;
};
/** A route that can only answer for all teams: for a bot that cannot look into every team, a plain refusal. */
const allTeamsOnly = (what: string) => (_c: RuleCall, e: RuleEnv) =>
  e.walls ? `Geweigerd door TeamBot: ${what} gaat over alle teams samen, ook teams waar ${e.agent.name} niet in mag kijken; dat bekijkt alleen de eigenaar.` : null;
/** Leave out the parts of an answer that add up all teams (for a bot that cannot look into every team). */
const without = (keys: string[], keep: (json: any, e: RuleEnv) => Record<string, any> = () => ({})) => (json: any, _c: RuleCall, e: RuleEnv) => {
  if (!e.walls || !isObj(json)) return json;
  const out: Record<string, any> = Object.fromEntries(Object.entries(json).filter(([k]) => !keys.includes(k)));
  return { ...out, ...keep(json, e), alleenEigenaar: ACROSS };
};
/** A bot of a team this bot may look into (not work without a bot, not a bot that is gone). */
const readableBot = (e: RuleEnv, id: unknown) => typeof id === 'string' && !!id && e.canRead(e.svc.teamOf(id));
type Spend = { calls: number; tokens: number; cost: number; value: number | null };
const sum = (list: Spend[]): Spend =>
  list.reduce<Spend>((s, x) => ({ calls: s.calls + (x?.calls || 0), tokens: s.tokens + (x?.tokens || 0), cost: s.cost + (x?.cost || 0), value: x?.value == null ? s.value : (s.value || 0) + x.value }), { calls: 0, tokens: 0, cost: 0, value: null });
/** Spend per bot or per team: only the rows this bot may look into, and the total of those rows. */
function breakdown(json: any, _c: RuleCall, e: RuleEnv) {
  if (!e.walls || !isObj(json) || !Array.isArray(json.rows)) return json;
  const rows = json.rows.filter((row: any) => (row?.kind === 'team' ? e.canRead(row.id) : row?.kind === 'bot' && readableBot(e, row.id)));
  return { ...json, rows, total: { today: sum(rows.map((x: any) => x.today)), week: sum(rows.map((x: any) => x.week)) }, alleenEigenaar: ACROSS };
}

// ---------- a full list of bots ----------

/**
 * A full list of bots (who may use an app, a skill, a shared browser profile): the route takes away what is not on it.
 * The bot decides only for the bots it may aansturen: the bots of other teams that are on it now stay on it.
 */
function keepOthers(field: string, current: (c: RuleCall, e: RuleEnv) => string[]) {
  return (c: RuleCall, e: RuleEnv): void => {
    if (!isObj(c.body) || !Array.isArray(c.body[field])) return;
    const keep = current(c, e).filter((id) => !e.canDirect(e.svc.teamOf(id)));
    c.body[field] = [...new Set([...c.body[field].map(String), ...keep])];
  };
}
const ids = (e: RuleEnv, sql: string, ...p: unknown[]): string[] => {
  try {
    return e.ctx.store.all<{ id: string }>(sql, ...p).map((x) => x.id);
  } catch {
    return [];
  }
};
const appBots = (c: RuleCall, e: RuleEnv) => ids(e, 'SELECT agent_id AS id FROM mcp_bindings WHERE connection_id = ? AND user_id = ?', c.params.id, e.agent.user_id);
const skillBots = (c: RuleCall, e: RuleEnv) => {
  const lib = e.ctx.services.skills?.library;
  if (!lib) return [];
  return e.ctx.store.agents(e.agent.user_id).filter((a) => !a.archived && lib.enabledFor(a).some((s: { id: string }) => s.id === c.params.id)).map((a) => a.id);
};
const profileBots = (c: RuleCall, e: RuleEnv) => {
  const p = e.ctx.store.get<any>('browser_profiles', c.params.id);
  if (!p || p.user_id !== e.agent.user_id) return [];
  return p.shared ? ids(e, 'SELECT agent_id AS id FROM computer_configs WHERE profile_id = ? AND user_id = ?', p.id, e.agent.user_id) : p.agent_id ? [p.agent_id] : [];
};

// ---------- a bot named by its name (or role) instead of its id ----------

const nameKey = (s: unknown) =>
  String(s ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
/** The ways a route reads a name ("@Bo", "Bo (Inkoper)", "Bo - inkoper", "de bot Bo"). */
const variants = (ref: string) =>
  [...new Set([ref, ref.replace(/\s*\([^()]*\)\s*$/, ''), ref.split(/\s+[-–—:]\s+|,\s*/)[0], ref.replace(/^(de\s+)?bot\s+/i, '')].map((x) => x.trim().replace(/^@/, '')).filter(Boolean))];
/**
 * Every bot of the owner a route could take this text for: by id or name, and (`role`) by role, (`loose`) by the start
 * or a part of its name as a spoken name is matched. More than one is possible: then each of them must be in reach.
 */
function botsNamed(e: RuleEnv, ref: unknown, o: { role?: boolean; loose?: boolean } = {}): Agent[] {
  const r = typeof ref === 'string' ? ref.trim().replace(/^@/, '') : '';
  if (!r) return [];
  const bots = e.ctx.store.agents(e.agent.user_id);
  const tries = variants(r);
  const keys = tries.map(nameKey);
  return bots.filter((b) => {
    const n = nameKey(b.name);
    if (tries.includes(b.id) || keys.includes(n)) return true;
    if (o.role && b.role && keys.some((k) => nameKey(b.role) === k.replace(/^de\s+/, ''))) return true;
    return !!o.loose && keys.some((k) => k.length >= 2 && (n.startsWith(k) || k.startsWith(n) || n.includes(k)));
  });
}
/** A bot named by name: the same wall as by its id (looking needs meekijken, `write` needs aansturen or its own team). */
function nameWall(e: RuleEnv, ref: unknown, write: boolean, o: { role?: boolean; loose?: boolean } = {}): string | null {
  for (const b of botsNamed(e, ref, o)) {
    const team = e.svc.teamOf(b.id);
    if (!e.canRead(team)) return e.closed;
    if (write && !e.canDirect(team)) return `Geweigerd door TeamBot: ${b.name} hoort bij een team waar ${e.agent.name} alleen mag meekijken; daar zet hij niemand aan het werk. Vraag je eigenaar om toegang (${PLACE.teams}).`;
  }
  return null;
}
/** A field that takes an id or a name: a name becomes the bot's id, so the walls of ids apply (reach.ts). */
function nameToId(e: RuleEnv, ref: unknown): unknown {
  if (typeof ref !== 'string' || !ref.trim()) return ref;
  const hit = botsNamed(e, ref);
  return hit.length === 1 ? hit[0].id : ref;
}
/** Every object in a body, a few levels deep (workflow steps, project tasks). */
function objects(v: unknown, out: Record<string, any>[] = [], depth = 0): Record<string, any>[] {
  if (depth > 6 || !v || typeof v !== 'object') return out;
  if (!Array.isArray(v)) out.push(v as Record<string, any>);
  for (const x of Array.isArray(v) ? v : Object.values(v)) objects(x, out, depth + 1);
  return out;
}
/** Workflow steps name their bot by id or name (`agentId` or `bot`): the name becomes the id. */
function stepBots(c: RuleCall, e: RuleEnv): string | null {
  for (const s of objects(c.body)) {
    if (s.kind !== 'bot' && s.bot === undefined) continue;
    const want = s.agentId ?? s.bot;
    const id = nameToId(e, want);
    if (id !== want) {
      s.agentId = id;
      delete s.bot;
      continue;
    }
    // Two bots with this name: each of them must be one this bot may set to work.
    const no = nameWall(e, want, true);
    if (no) return no;
  }
  return null;
}

// ---------- what belongs to no team ----------

/**
 * A workflow belongs to no team, but its steps set bots to work: changing, starting or stopping it is for a bot that
 * may aansturen every bot in it (else the owner's). Looking is free; a step of a team the bot cannot look into is left
 * out of what it sees (reach.ts).
 */
function workflowBots(from: 'workflows' | 'workflow_runs') {
  return (c: RuleCall, e: RuleEnv): string | null => {
    if (c.method === 'GET') return null;
    let steps: unknown = [];
    try {
      steps = JSON.parse(e.ctx.store.one<{ steps: string }>(`SELECT steps FROM ${from} WHERE id = ? AND user_id = ?`, c.params.id, e.agent.user_id)?.steps || '[]');
    } catch {
      steps = [];
    }
    for (const s of objects(steps)) {
      if (typeof s.agentId !== 'string' || !s.agentId) continue;
      if (!e.canDirect(e.svc.teamOf(s.agentId))) return `Geweigerd door TeamBot: deze workflow zet ook een bot aan het werk van een team dat ${e.agent.name} niet aanstuurt; hem veranderen, starten of stoppen doet de eigenaar. Maak voor je eigen team een eigen workflow.`;
    }
    return null;
  };
}

// ---------- memory ----------

/** The memory module's own wall for one write, or null (memory off: nothing to wall). */
const mem = (e: RuleEnv) => e.memory;
function teamWrite(e: RuleEnv, teamId: string | null | undefined): string | null {
  return mem(e)?.teamWriteRefusal?.(e.agent, teamId ?? null) ?? null;
}
/** A dossier: its core rule (the owner's dossier is every bot's, another bot's notes never), else its team. */
function dossierWrite(e: RuleEnv, id: unknown): string | null {
  const m = mem(e);
  if (!m || typeof id !== 'string' || !id) return null;
  const d = m.store?.get?.('memory_dossiers', id) ?? e.ctx.store.get<any>('memory_dossiers', id);
  if (!d || d.user_id !== e.agent.user_id) return null;
  return coreWriteRefusal(m, e.agent, d);
}
function itemWrite(e: RuleEnv, id: unknown): string | null {
  const m = mem(e);
  if (!m || typeof id !== 'string' || !id) return null;
  const row = m.itemRow?.(id);
  return row ? (m.itemWriteRefusal(e.agent, row) ?? null) : null;
}
const botTeam = (e: RuleEnv, agentId: unknown) => (typeof agentId === 'string' && agentId ? e.svc.teamOf(agentId) : null);
/** The row of a table that hangs on a dossier (a record, a source): its dossier decides. */
function dossierOfRow(e: RuleEnv, table: string, id: string): string | null {
  try {
    return e.ctx.store.one<{ dossier_id: string | null }>(`SELECT dossier_id FROM ${table} WHERE id = ?`, id)?.dossier_id ?? null;
  } catch {
    return null;
  }
}
const MEMORY_SCOPES = ['about_you', 'agent', 'dossier', 'shared'];
/**
 * Where a new note goes (POST /memory/items, a capture, an import): shared knowledge in the bot's own team unless it
 * names its own team; a bot's note in that bot's team; a dossier note by the dossier. "Over jou" has no team.
 */
function placeWrite(e: RuleEnv, b: Record<string, any>, o: { scope: string; agentId?: unknown; dossierId?: unknown }): string | null {
  if (o.scope === 'shared') {
    if (!text(b.teamId)) b.teamId = e.home;
    return teamWrite(e, b.teamId);
  }
  if (o.scope === 'agent') return teamWrite(e, botTeam(e, o.agentId) ?? e.home);
  if (o.scope === 'dossier') return dossierWrite(e, o.dossierId);
  return null;
}
const WHOLE = (e: RuleEnv, what: string) =>
  `Geweigerd door TeamBot: ${what} gaat over het geheugen van alle teams; dat doet alleen je eigenaar zelf, in TeamBot (Geheugen). ${e.agent.name} kan het geheugen van zijn eigen team wel per dossier of herinnering bijwerken.`;
const NOT_ABOUT_YOU = (e: RuleEnv) => `Geweigerd door TeamBot: ${e.agent.name} importeert alleen in het geheugen van zijn eigen team (scope "shared"), niet in "Over jou" van de eigenaar.`;

// ---------- the rules ----------

const r = (kind: Kind, rest: Omit<Rule, 'kind'> = {}): Rule => ({ kind, ...rest });

/** Routes with a rule of their own. The kind of every other route is in TABLE. */
export const RULES: Record<string, Rule> = {
  // --- new bots: in the bot's own team, or a team it may aansturen (gap: they landed in the default team).
  'POST /agents': r('newbot', { before: (c, e) => (isObj(c.body) ? homeTeamIn((b) => (isObj(b.settings) ? b.settings : (b.settings = {})), e, c.body) : null) }),
  'POST /agents/import': r('newbot', { before: (c, e) => (isObj(c.body) ? homeTeamIn((b) => (isObj(b.settings) ? b.settings : (b.settings = {})), e, c.body) : null) }),
  'POST /import/agents': r('newbot', {
    before: (c, e) => {
      const list = isObj(c.body) && Array.isArray(c.body.agents) ? c.body.agents : [];
      for (const a of list) {
        if (!isObj(a)) continue;
        const no = homeTeamIn((b) => (isObj(b.settings) ? b.settings : (b.settings = {})), e, a);
        if (no) return no;
      }
      return null;
    },
  }),
  'POST /agents/:id/duplicate': r('newbot', {
    before: (c, e) => {
      const src = e.ctx.store.agent(c.params.id);
      if (!src || src.user_id !== e.agent.user_id) return null;
      const named = text(src.settings?.homeTeam);
      const landing = named && e.svc.team(named)?.user_id === e.agent.user_id ? named : defaultTeam(e);
      return landsIn(e, landing, 'een kopie van deze bot');
    },
  }),
  'POST /rooms/packages/install': r('newbot', { before: (_c, e) => landsIn(e, defaultTeam(e), 'een team uit een pakket') }),
  'POST /rooms/proposals/:id': r('newbot', {
    before: (c, e) => {
      if (!isObj(c.body) || c.body.decision !== 'approve') return null;
      let p: any;
      try {
        p = e.ctx.store.get<any>('room_proposals', c.params.id);
      } catch {
        p = null;
      }
      return p && p.kind !== 'existing' ? landsIn(e, defaultTeam(e), 'een nieuwe bot uit dit voorstel') : null;
    },
  }),
  'POST /skills/templates/install': r('newbot', { before: teamIdOfInstall }),
  'POST /skills/market/bots/:catalogId/:itemId/install': r('newbot', { before: teamIdOfInstall }),

  // --- a bot named by its name (or role) instead of its id: the same wall as by its id.
  'GET /usage/estimate': r('team', {
    before: (c, e) => {
      const want = c.query.get('agentId');
      if (!want) return null;
      const id = nameToId(e, want);
      if (id !== want) c.query.set('agentId', String(id));
      return id !== want ? null : nameWall(e, want, false);
    },
  }),
  // A task's owner by name, or by role when one bot has it: whoever it could be must be one this bot may set to work.
  'POST /rooms/tasks': r('team', { before: (c, e) => (isObj(c.body) ? nameWall(e, c.body.owner, true, { role: true }) : null) }),
  'POST /workflows': r('shared', { before: stepBots }),
  'PATCH /workflows/:id': r('shared', { before: (c, e) => workflowBots('workflows')(c, e) || stepBots(c, e) }),
  'DELETE /workflows/:id': r('shared', { before: workflowBots('workflows') }),
  'POST /workflows/:id/run': r('shared', { before: workflowBots('workflows') }),
  'POST /workflows/:id/versions/:v/restore': r('shared', { before: workflowBots('workflows') }),
  'POST /workflows/:id/webhook': r('shared', { before: workflowBots('workflows') }),
  'POST /workflow-runs/:id/stop': r('shared', { before: workflowBots('workflow_runs') }),
  'POST /workflow-runs/:id/resume': r('shared', { before: workflowBots('workflow_runs') }),
  // The memory's blocks and maintenance reports are of no team, but say what was forgotten or changed in every team.
  'GET /memory/blocks': r('totals', { before: allTeamsOnly('wat er in het geheugen geblokkeerd is') }),
  'GET /memory/reports': r('totals', { before: allTeamsOnly('een opruimverslag van het geheugen') }),
  'GET /teamdata/log': r('home', { before: (c, e) => nameWall(e, c.query.get('agent'), false) || teamdata(c, e) }),
  // A spoken name is matched loosely (the start or a part of it): every bot it could be must be in reach.
  'POST /voice/calls/:id/tool': r('team', {
    before: (c, e) => (isObj(c.body) && c.body.name === 'ask_bot' && isObj(c.body.args) ? nameWall(e, c.body.args.bot || c.body.args.name, true, { loose: true }) : null),
  }),
  'POST /proactive/projects': r('home', {
    before: (c, e) => {
      for (const o of objects(c.body)) {
        const no = o.eigenaar !== undefined ? nameWall(e, o.eigenaar, true) : null;
        if (no) return no;
      }
      return homeTeam({ body: 'teamId' })(c, e);
    },
  }),

  // --- a full list of bots: what the bot may not aansturen stays as it is.
  'PUT /mcp/connections/:id/agents': r('list', { merge: keepOthers('agentIds', appBots) }),
  'PUT /skills/:id/agents': r('list', { merge: keepOthers('agentIds', skillBots) }),
  'PUT /computers/profiles/:id/members': r('list', { merge: keepOthers('agent_ids', profileBots) }),

  // --- totals over all teams: per team where the route can say so, else without the totals, else refused.
  'GET /usage': r('totals', {
    after: without(['byDay', 'byModel', 'byAgent', 'today'], (json, e) => ({
      byAgent: (Array.isArray(json.byAgent) ? json.byAgent : []).filter((x: any) => readableBot(e, x?.agent_id)),
      today: isObj(json.today) ? { limit: json.today.limit, byAdmin: json.today.byAdmin, resetAt: json.today.resetAt } : undefined,
    })),
  }),
  'GET /usage/breakdown': r('totals', { after: breakdown }),
  'GET /usage/limits': r('totals', {
    after: without(['engines'], (json) => ({ engines: (Array.isArray(json.engines) ? json.engines : []).map((x: any) => (isObj(x) ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'spend')) : x)) })),
  }),
  'GET /system': r('totals', {
    after: without(['stats'], (_json, e) => ({ stats: { agents: e.ctx.store.agents(e.agent.user_id, { archived: true }).filter((a) => readableBot(e, a.id)).length } })),
  }),
  'GET /privacy/overview': r('totals', {
    after: without(['outgoing'], (json) => ({ outgoing: isObj(json.outgoing) ? Object.fromEntries(Object.entries(json.outgoing).filter(([k]) => !['channels', 'appsRemote', 'appsLocal', 'push', 'sites'].includes(k))) : undefined })),
  }),
  'GET /routines/runs/summary': r('totals', { before: ownTeamTotals('teamId') }),
  'GET /teamdata/summary': r('totals', { before: ownTeamTotals('team') }),
  'GET /teamdata/decisions': r('totals', { before: ownTeamTotals('team') }),
  'GET /proactive/projects': r('totals', { before: ownTeamTotals('team') }),
  'GET /proactive/kansen': r('totals', { before: ownTeamTotals('team') }),
  // Search: the team database's tasks come from one team only (without a team: the default team's).
  'GET /search/all': r('totals', { before: ownTeamTotals('team') }),
  'GET /memory/overview': r('totals', { after: without(['byScope', 'review', 'proposals', 'due', 'dossiers', 'sharedWithMe', 'openActions', 'episodes']) }),
  'GET /memory/storage': r('totals', { after: without(['scopes', 'dossiers', 'episodes', 'proposals', 'trash', 'blocks', 'index', 'stale', 'totalBytes']) }),
  'GET /proactive/briefing': r('totals', { before: allTeamsOnly('het overzicht van de hoofdbot') }),
  'POST /proactive/briefing': r('totals', { before: allTeamsOnly('het overzicht van de hoofdbot') }),
  'GET /power': r('totals', { after: without(['reason']) }),
  'POST /stop-all': r('totals', { before: allTeamsOnly('alle bots stoppen') }),
  'POST /folders/trash/empty': r('totals', { before: allTeamsOnly('de prullenbak van alle mappen legen') }),
  'GET /health': r('totals', { before: allTeamsOnly('hoe het met TeamBot gaat') }),
  'GET /health/history': r('totals', { before: allTeamsOnly('hoe het met TeamBot ging') }),

  // --- no team named: the bot's own team, not the default team.
  'GET /teamdata/tables': r('home', { before: teamdata }),
  'GET /teamdata/tables/:name': r('home', { before: teamdata }),
  'GET /teamdata/audit': r('home', { before: teamdata }),
  'POST /teamdata/decisions/:id/answer': r('home', { before: teamdata }),
  'GET /teamdata/tasks': r('home', { before: teamdata }),
  'PATCH /teamdata/tasks/:id': r('home', { before: teamdata }),
  'POST /teamdata/tasks/:id/reopen': r('home', { before: teamdata }),
  'GET /teamdata/events': r('home', { before: teamdata }),
  'GET /teamdata/experiments': r('home', { before: teamdata }),
  'POST /teamdata/import': r('home', { before: teamdata }),
  'POST /teamdata/import/undo': r('home', { before: teamdata }),
  'POST /proactive/projects/:id/stop': r('home', { before: homeTeam({ body: 'teamId' }) }),
  'POST /proactive/kansen/:id/decide': r('home', { before: homeTeam({ body: 'teamId' }) }),
  'GET /folders/roots': r('home', { before: folders }),
  'GET /folders/browse': r('home', { before: folders }),
  'GET /folders/raw': r('home', { before: folders }),
  'GET /folders/file': r('home', { before: folders }),
  'GET /folders/team': r('home', { before: homeTeam({ query: 'teamId' }) }),
  'PUT /folders/team': r('home', { before: homeTeam({ query: 'teamId', body: 'teamId' }) }),
  'DELETE /folders/team': r('home', { before: homeTeam({ query: 'teamId' }) }),
  'POST /skills/import/preview': r('home', { before: skills }),
  'POST /skills/import/zip': r('home', { before: skills }),
  'POST /skills/import/commit': r('home', { before: skills }),
  'POST /skills/curated/install': r('home', { before: skills }),
  // Moving a skill to "alle teams" (teamId null or "*") is the owner's.
  'PATCH /skills/:id': r('home', {
    before: (c, e) => (isObj(c.body) && 'teamId' in c.body && (c.body.teamId === null || c.body.teamId === ALL) ? `Geweigerd door TeamBot: een vaardigheid voor alle teams maken doet alleen de eigenaar. ${e.agent.name} kan hem in zijn eigen team zetten.` : null),
  }),
  'POST /chat-folders': r('home', { before: (c, e) => (isObj(c.body) && c.body.item ? null : homeTeam({ body: 'teamId' })(c, e)) }),
  // A department (a room team) belongs to a team: the one named, its parent's, its chief's, else the bot's own.
  'POST /rooms/teams': r('home', {
    before: (c, e) => (isObj(c.body) && (c.body.parentId || c.body.chiefAgentId) ? null : homeTeam({ body: 'workspaceId' })(c, e)),
  }),

  // --- memory: writing only in the bot's own team, by the memory module's own checks.
  'POST /memory/items': r('memory', {
    before: (c, e) => {
      const b = isObj(c.body) ? c.body : (c.body = {});
      if (b.liftBlock === true) return `Geweigerd door TeamBot: een blokkade in het geheugen opheffen doet alleen de eigenaar zelf.`;
      const scope = MEMORY_SCOPES.includes(b.scope) ? b.scope : 'about_you';
      return placeWrite(e, b, { scope, agentId: b.agentId, dossierId: b.dossierId });
    },
  }),
  'PATCH /memory/items/:id': r('memory', {
    before: (c, e) => {
      const b = isObj(c.body) ? c.body : {};
      const target = text(b.teamId) ? teamWrite(e, text(b.teamId)) : null;
      const bot = text(b.agentId) ? teamWrite(e, botTeam(e, b.agentId)) : null;
      const dossier = b.scope === 'dossier' && text(b.dossierId) ? dossierWrite(e, b.dossierId) : null;
      return itemWrite(e, c.params.id) || target || bot || dossier;
    },
  }),
  'POST /memory/items/:id/forget': r('memory', { before: (c, e) => itemWrite(e, c.params.id) }),
  'POST /memory/items/:id/:action': r('memory', { before: (c, e) => itemWrite(e, c.params.id) }),
  'POST /memory/items/bulk': r('memory', {
    before: (c, e) => {
      for (const id of isObj(c.body) && Array.isArray(c.body.ids) ? c.body.ids.slice(0, 200) : []) {
        const no = itemWrite(e, String(id));
        if (no) return no;
      }
      return null;
    },
  }),
  'POST /memory/changes/:id/undo': r('memory', {
    before: (c, e) => {
      let ch: any;
      try {
        ch = e.ctx.store.one<any>('SELECT record_kind, record_id, dossier_id FROM memory_changes WHERE id = ?', c.params.id);
      } catch {
        ch = null;
      }
      if (!ch) return null;
      return (ch.record_kind === 'item' ? itemWrite(e, ch.record_id) : null) || (ch.dossier_id ? dossierWrite(e, ch.dossier_id) : null);
    },
  }),
  'POST /memory/teams/copy': r('memory', { before: (c, e) => teamWrite(e, isObj(c.body) ? text(c.body.toTeamId) || null : null) }),
  'POST /memory/dossier-proposals/:id/accept': r('memory', {
    before: (c, e) => {
      const s = e.ctx.store.get<any>('memory_subjects', c.params.id);
      return s && s.user_id === e.agent.user_id ? teamWrite(e, s.team_id ?? null) : null;
    },
  }),
  'POST /memory/dossier-proposals/:id/dismiss': r('memory', {
    before: (c, e) => {
      const s = e.ctx.store.get<any>('memory_subjects', c.params.id);
      return s && s.user_id === e.agent.user_id ? teamWrite(e, s.team_id ?? null) : null;
    },
  }),
  'POST /memory/thread/:threadId/capture': r('memory', {
    before: (c, e) => {
      const b = isObj(c.body) ? c.body : (c.body = {});
      const t = e.ctx.store.thread(c.params.threadId);
      if (!t) return null;
      const scope = MEMORY_SCOPES.includes(b.scope) ? b.scope : t.agent_id ? 'agent' : 'about_you';
      const agentId = b.agentId || t.agent_id;
      if (scope === 'shared' && !text(b.teamId)) return teamWrite(e, botTeam(e, agentId) ?? e.home);
      const linked = () => e.ctx.store.one<{ dossier_id: string }>('SELECT dossier_id FROM memory_links WHERE thread_id = ?', t.id)?.dossier_id;
      return placeWrite(e, b, { scope, agentId, dossierId: scope === 'dossier' ? b.dossierId || linked() : null });
    },
  }),
  'PUT /memory/thread/:threadId/link': r('memory', { before: (c, e) => (isObj(c.body) && text(c.body.dossierId) ? dossierWrite(e, c.body.dossierId) : null) }),
  'POST /memory/thread/:threadId/episode/rebuild': r('memory', { before: (c, e) => teamWrite(e, botTeam(e, e.ctx.store.thread(c.params.threadId)?.agent_id) ?? e.home) }),
  'POST /memory/thread/:threadId/learn': r('memory', {
    before: (c, e) => teamWrite(e, botTeam(e, (isObj(c.body) && c.body.agentId) || e.ctx.store.thread(c.params.threadId)?.agent_id) ?? e.home),
  }),
  'POST /memory/dossiers': r('memory', {
    before: (c, e) => {
      const b = isObj(c.body) ? c.body : (c.body = {});
      if (!text(b.teamId)) b.teamId = e.home;
      return teamWrite(e, b.teamId);
    },
  }),
  // Markdown files as dossiers land in the default team (the route cannot say another): only for a bot of that team.
  'POST /memory/dossiers/import': r('memory', { before: (c, e) => (isObj(c.body) && c.body.dryRun ? null : teamWrite(e, null)) }),
  'PATCH /memory/dossiers/:id': r('memory', {
    before: (c, e) => dossierWrite(e, c.params.id) || (isObj(c.body) && text(c.body.teamId) ? teamWrite(e, text(c.body.teamId)) : null),
  }),
  'POST /memory/dossiers/:id/forget': r('memory', { before: (c, e) => dossierWrite(e, c.params.id) }),
  'POST /memory/dossiers/:id/records': r('memory', { before: (c, e) => dossierWrite(e, c.params.id) }),
  'POST /memory/dossiers/:id/sources': r('memory', { before: (c, e) => dossierWrite(e, c.params.id) }),
  'POST /memory/dossiers/:id/share': r('memory', { before: (c, e) => dossierWrite(e, c.params.id) }),
  'POST /memory/dossiers/:id/leave': r('memory', { before: (c, e) => dossierWrite(e, c.params.id) }),
  'POST /memory/customers/:identityId/link': r('memory', { before: (c, e) => dossierWrite(e, isObj(c.body) ? c.body.dossierId : null) }),
  'PATCH /memory/records/:id': r('memory', { before: (c, e) => dossierWrite(e, dossierOfRow(e, 'memory_records', c.params.id)) }),
  'POST /memory/records/:id/forget': r('memory', { before: (c, e) => dossierWrite(e, dossierOfRow(e, 'memory_records', c.params.id)) }),
  'POST /memory/sources/:id/forget': r('memory', { before: (c, e) => dossierWrite(e, dossierOfRow(e, 'memory_sources', c.params.id)) }),
  'POST /memory/episodes/:id/forget': r('memory', {
    before: (c, e) => {
      const ep = e.ctx.store.get<any>('memory_episodes', c.params.id);
      return ep && ep.user_id === e.agent.user_id ? teamWrite(e, ep.team_id ?? null) : null;
    },
  }),

  // --- all of memory at once: the owner's own word, within the bot's own team where the route can say so.
  'POST /memory/import': r('whole', {
    ownerChain: true,
    before: (c, e) => {
      const b = isObj(c.body) ? c.body : (c.body = {});
      const scope = MEMORY_SCOPES.includes(b.scope) ? b.scope : 'about_you';
      if (scope === 'about_you') return NOT_ABOUT_YOU(e);
      return placeWrite(e, b, { scope, agentId: b.agentId, dossierId: b.dossierId });
    },
  }),
  'POST /memory/import/assistant': r('whole', {
    ownerChain: true,
    before: (c, e) => {
      const b = isObj(c.body) ? c.body : (c.body = {});
      if (b.scope !== 'shared') return NOT_ABOUT_YOU(e);
      return placeWrite(e, b, { scope: 'shared' });
    },
  }),
  'POST /memory/import/:batch/undo': r('whole', { before: (_c, e) => WHOLE(e, 'een import ongedaan maken') }),
  'POST /memory/delete-all': r('whole', { before: (_c, e) => WHOLE(e, 'al het geheugen wissen') }),
  'POST /memory/trash/empty': r('whole', { before: (_c, e) => WHOLE(e, 'de prullenbak van het geheugen legen') }),
  'POST /memory/consolidate': r('whole', { before: (_c, e) => WHOLE(e, 'dubbele herinneringen samenvoegen') }),
  'POST /memory/reconcile': r('whole', { before: (_c, e) => WHOLE(e, 'het geheugen opruimen') }),
  'POST /memory/maintenance': r('whole', { before: (_c, e) => WHOLE(e, 'het onderhoud van het geheugen') }),
  'POST /memory/reports/:id/undo': r('whole', { before: (_c, e) => WHOLE(e, 'een opruimverslag ongedaan maken') }),
  'DELETE /memory/blocks/:id': r('whole', { before: (_c, e) => WHOLE(e, 'een blokkade opheffen') }),
};

export const routeKey = (method: string, pattern: string) => `${method.toUpperCase()} ${pattern}`;

/**
 * Every other route: method, pattern, kind (one per line, in the order the routes are registered). A route that
 * only looks or changes something of one team is 'team' (the ids in the call decide); 'memory' is reading memory
 * (as a team; the memory module says which team a note without one belongs to).
 */
const TABLE_TEXT = `
GET    /privacy/agents/:id                                     team
POST   /privacy/engines                                        shared
POST   /providers                                              shared
PATCH  /providers/:id                                          shared
GET    /cli-agents/versions                                    shared
POST   /cli-agents/versions/:id/check                          shared
POST   /cli-agents/versions/:id/accept                         shared
GET    /cli-agents/status                                      shared
GET    /cli-agents/read-access/:providerId                     shared
GET    /cli-agents/hard-blocks/:providerId                     shared
PUT    /cli-agents/safety/:id                                  shared
POST   /cli-agents/:id/install                                 shared
PUT    /cli-agents/paths/:id                                   shared
POST   /cli-agents/:id/connect                                 shared
GET    /cli-agents/runtimes                                    shared
GET    /cli-agents/subscriptions                               shared
POST   /cli-agents/runtimes/:id/install                        shared
DELETE /cli-agents/runtimes/:id                                shared
POST   /cli-agents/free-start                                  shared
GET    /cli-agents/threads/:id/sessions                        team
POST   /cli-agents/threads/:id/sessions/reset                  team
GET    /cli-agents/agents/:id/apps                             team
PUT    /cli-agents/agents/:id/apps/:app                        team
POST   /memory/import/preview                                  shared
GET    /memory/import/recent                                   shared
GET    /memory/place                                           memory
GET    /memory/items                                           memory
GET    /memory/items/:id                                       memory
GET    /memory/review                                          memory
GET    /memory/changes                                         memory
GET    /memory/settings                                        shared
PUT    /memory/settings                                        shared
GET    /memory/sizes                                           memory
GET    /memory/agents                                          memory
GET    /memory/teams                                           team
POST   /memory/reindex                                         shared
GET    /memory/semantic                                        shared
POST   /memory/semantic/builtin                                shared
GET    /memory/dossier-proposals                               memory
POST   /memory/semantic/pull                                   shared
GET    /memory/search                                          memory
GET    /memory/thread/:threadId                                memory
GET    /memory/message/:messageId                              memory
GET    /memory/refs                                            memory
GET    /memory/by-call/:callId                                 memory
GET    /memory/dossiers                                        memory
GET    /memory/dossiers/:id                                    memory
GET    /memory/dossiers/:id/export                             memory
GET    /memory/episodes                                        memory
GET    /memory/learned                                         memory
GET    /memory/thread/:threadId/learned-map                    memory
GET    /memory/thread/:threadId/answer-sources                 memory
GET    /memory/profile                                         memory
GET    /memory/engine                                          shared
POST   /memory/reports/:id/seen                                shared
GET    /skills/menu                                            shared
GET    /skills/publishers                                      shared
PUT    /skills/publishers/policy                               shared
POST   /skills/publishers/trusted                              shared
DELETE /skills/publishers/trusted/:fp                          shared
GET    /skills/web/sources                                     shared
GET    /skills/web/search                                      shared
GET    /skills/web/repo                                        shared
POST   /skills/web/check-updates                               shared
GET    /skills/curated                                         shared
GET    /skills/curated/item                                    shared
GET    /skills/curated/pin-updates                             shared
POST   /skills/curated/check-updates                           shared
GET    /skills/curated/diff                                    shared
POST   /skills/curated/update                                  shared
POST   /skills/from-chat/draft                                 shared
POST   /skills/from-chat/save                                  team
POST   /skills/from-document/draft                             shared
POST   /skills/from-document/save                              team
GET    /skills/:id/tests                                       team
PUT    /skills/:id/tests                                       team
GET    /skills/:id/tests/estimate                              team
POST   /skills/:id/tests/run                                   team
GET    /skills/:id/tests/runs/:runId                           team
GET    /skills/import/:stagingId                               shared
GET    /skills/discover/dirs                                   shared
GET    /skills/agents/:agentId                                 team
PUT    /skills/agents/:agentId                                 team
POST   /skills/check-updates                                   shared
GET    /skills/templates/export/:agentId                       team
POST   /skills/templates/preview                               shared
POST   /skills/packages/unzip                                  shared
GET    /skills/market/sources                                  shared
GET    /skills/market/skills                                   shared
GET    /skills/market/bots                                     shared
GET    /skills/market/apps                                     shared
GET    /skills/market/apps/:catalogId/:itemId/package          shared
POST   /skills/market/apps/:appId/install                      shared
GET    /skills/market/skills/:catalogId/:itemId                shared
POST   /skills/market/skills/:catalogId/:itemId/preview        shared
GET    /skills/market/bots/:catalogId/:itemId                  shared
POST   /skills/market/bots/:catalogId/:itemId/preview          shared
POST   /skills/market/report                                   shared
GET    /skills/market/reports                                  shared
POST   /skills/market/reports/:id                              shared
GET    /skills/market/blocks                                   shared
POST   /skills/market/blocks                                   shared
DELETE /skills/market/blocks/:type/:catalogId/:itemId          shared
GET    /skills/catalogs                                        shared
POST   /skills/catalogs                                        shared
POST   /skills/catalogs/:id/refresh                            shared
PATCH  /skills/catalogs/:id                                    shared
DELETE /skills/catalogs/:id                                    shared
GET    /skills/shares                                          shared
POST   /skills/shares                                          shared
GET    /skills/shares/review                                   shared
POST   /skills/shares/:id/review                               shared
DELETE /skills/shares/:id                                      shared
GET    /skills                                                 team
GET    /skills/:id                                             team
GET    /skills/:id/file                                        team
GET    /skills/:id/download                                    team
GET    /skills/:id/versions/:rev                               team
POST   /skills/:id/versions/:rev/activate                      team
PUT    /skills/:id/content                                     team
POST   /skills/:id/trust                                       team
POST   /skills/:id/publish                                     team
DELETE /skills/:id                                             team
GET    /mcp/catalog                                            shared
POST   /mcp/packages/preview                                   shared
GET    /mcp/info                                               shared
GET    /mcp/registry/servers                                   shared
GET    /mcp/registry/icon                                      shared
GET    /mcp/registry/server                                    shared
POST   /mcp/registry/entry                                     shared
POST   /mcp/registry/check-updates                             shared
POST   /mcp/connections/:id/registry-update                    team
GET    /mcp/connections                                        team
POST   /mcp/connections                                        shared
POST   /mcp/quick                                              shared
GET    /mcp/runtimes/:id                                       shared
POST   /mcp/runtimes/:id                                       shared
GET    /mcp/google                                             shared
PUT    /mcp/google/client                                      shared
POST   /mcp/google/start                                       shared
POST   /mcp/google/test                                        shared
PUT    /mcp/google/ads                                         shared
GET    /mcp/import/local                                       shared
GET    /mcp/connections/:id                                    team
PATCH  /mcp/connections/:id                                    team
POST   /mcp/connections/:id/package                            team
DELETE /mcp/connections/:id                                    team
POST   /mcp/connections/:id/restart                            team
POST   /mcp/connections/:id/stop                               team
POST   /mcp/connections/:id/test                               team
POST   /mcp/connections/:id/actions                            team
PATCH  /mcp/connections/:id/tools/:name                        team
POST   /mcp/connections/:id/tools/approve                      team
GET    /mcp/connections/:id/calls                              team
GET    /mcp/agents/:agentId                                    team
PUT    /mcp/agents/:agentId/:id                                team
GET    /mcp/tool-index                                         shared
GET    /proactive/settings                                     shared
PUT    /proactive/settings                                     shared
GET    /proactive/duties                                       team
GET    /proactive/archived                                     team
POST   /proactive/archived/:id/restore                         team
GET    /proactive/work                                         team
POST   /proactive/work/:agentId/park                           team
GET    /proactive/presets                                      shared
PUT    /proactive/presets                                      shared
POST   /proactive/duties                                       team
GET    /routines/meta                                          shared
GET    /routines/settings                                      shared
GET    /routines/calendar                                      shared
GET    /routines/planned                                       team
PUT    /routines/settings                                      shared
POST   /routines/preview                                       shared
POST   /routines/chat-match                                    shared
GET    /routines/channel-targets                               shared
GET    /routines/missed                                        team
POST   /routines/missed/seen                                   shared
GET    /routines/attention                                     team
POST   /routines/attention/seen                                shared
GET    /routines/runs/:id                                      team
POST   /routines/runs/:id/cancel                               team
GET    /routines/runs                                          team
GET    /routines/triggers/:id                                  team
PATCH  /routines/triggers/:id                                  team
DELETE /routines/triggers/:id                                  team
POST   /routines/triggers/:id/test                             team
GET    /routines/triggers/:id/events                           team
GET    /routines                                               team
POST   /routines                                               team
GET    /routines/:id                                           team
PATCH  /routines/:id                                           team
DELETE /routines/:id                                           team
POST   /routines/:id/duplicate                                 team
POST   /routines/:id/pause                                     team
POST   /routines/:id/resume                                    team
POST   /routines/:id/confirm                                   team
POST   /routines/:id/run                                       team
POST   /routines/:id/run-after                                 team
GET    /routines/:id/runs                                      team
GET    /routines/:id/triggers                                  team
POST   /routines/:id/triggers                                  team
GET    /teams                                                  team
POST   /teams                                                  shared
GET    /teams/main                                             shared
GET    /teams/overview                                         team
GET    /teams/bots/:agentId                                    team
GET    /teams/:id                                              team
PATCH  /teams/:id                                              team
DELETE /teams/:id                                              team
POST   /teams/:id/duplicate                                    team
PUT    /teams/:id/bots/:agentId                                team
PUT    /teams/:id/access/:agentId                              team
GET    /proactive/checkin                                      shared
PUT    /proactive/checkin                                      shared
POST   /teams/stuck/retry                                      team
PATCH  /threads/:id                                            team
DELETE /threads/:id                                            team
POST   /threads/:id/stop                                       team
POST   /threads/:id/resume                                     team
POST   /threads/:id/retry                                      team
POST   /threads/:id/messages                                   team
DELETE /messages/:id                                           team
POST   /messages/:id/pin                                       team
GET    /rooms/people                                           shared
GET    /rooms/defaults                                         shared
PUT    /rooms/defaults                                         shared
GET    /rooms/proposals                                        team
GET    /rooms/proposals/:id                                    team
GET    /rooms/delegations/by-call/:callId                      team
GET    /rooms/delegations                                      team
GET    /rooms/delegations/:id                                  team
POST   /rooms/delegations/:id/cancel                           team
GET    /rooms/teams                                            team
PATCH  /rooms/teams/:id                                        team
DELETE /rooms/teams/:id                                        team
PUT    /rooms/teams/:id/members                                team
DELETE /rooms/teams/:id/members/:agentId                       team
POST   /rooms/teams/:id/room                                   team
GET    /rooms/tasks                                            team
PATCH  /rooms/tasks/:id                                        team
POST   /rooms/tasks/:id/approve                                team
POST   /rooms/tasks/:id/reopen                                 team
POST   /rooms/tasks/:id/start-after                            team
POST   /rooms/tasks/:id/release                                team
DELETE /rooms/tasks/:id                                        team
GET    /rooms/by-thread/:threadId                              team
GET    /rooms                                                  team
POST   /rooms                                                  team
GET    /rooms/modes                                            shared
GET    /rooms/templates                                        shared
POST   /rooms/packages/preview                                 shared
GET    /rooms/:id                                              team
PATCH  /rooms/:id                                              team
DELETE /rooms/:id                                              team
POST   /rooms/:id/stop                                         team
POST   /rooms/:id/resume                                       team
POST   /rooms/:id/bots                                         team
PATCH  /rooms/:id/bots/:agentId                                team
DELETE /rooms/:id/bots/:agentId                                team
POST   /rooms/:id/people                                       team
PATCH  /rooms/:id/people/:userId                               team
DELETE /rooms/:id/people/:userId                               team
POST   /rooms/:id/accept                                       team
POST   /rooms/:id/decline                                      team
GET    /rooms/:id/package                                      team
GET    /rooms/:id/ledger                                       team
GET    /rooms/:id/activity                                     team
GET    /rooms/:id/search                                       team
GET    /rooms/:id/export                                       team
GET    /rooms/:id/files                                        team
GET    /rooms/:id/files/raw                                    team
POST   /rooms/:id/files                                        team
DELETE /rooms/:id/files                                        team
GET    /voice/settings                                         shared
GET    /voice/local                                            shared
POST   /voice/local/models/:id/install                         shared
POST   /voice/local/models/:id/cancel                          shared
DELETE /voice/local/models/:id                                 shared
POST   /voice/stt/stream                                       shared
POST   /voice/stt/stream/:id                                   shared
POST   /voice/stt/stream/:id/end                               shared
DELETE /voice/stt/stream/:id                                   shared
PUT    /voice/settings                                         shared
POST   /voice/transcribe                                       shared
GET    /voice/clips                                            team
GET    /voice/clips/:id                                        team
GET    /voice/clips/:id/vtt                                    team
GET    /voice/clips/:id/audio                                  team
DELETE /voice/clips/:id                                        team
POST   /voice/speak                                            shared
POST   /voice/speak/run                                        shared
GET    /voice/tts/:id/pcm                                      shared
GET    /voice/tts/:id                                          shared
GET    /voice/tts-cache                                        shared
DELETE /voice/tts-cache                                        shared
POST   /voice/cleanup                                          shared
GET    /voice/calls/:id/tasks                                  team
POST   /voice/calls                                            team
GET    /voice/calls                                            team
GET    /voice/calls/:id                                        team
POST   /voice/calls/:id/events                                 team
POST   /voice/calls/:id/ask                                    team
POST   /voice/calls/:id/turn                                   team
GET    /voice/calls/:id/runs/:runId                            team
POST   /voice/calls/:id/end                                    team
DELETE /voice/calls/:id                                        team
GET    /voice/duplex                                           shared
POST   /voice/duplex/install                                   shared
POST   /voice/duplex/calls                                     team
GET    /channels/adapters                                      shared
GET    /channels/rooms                                         team
GET    /channels/bindings                                      team
POST   /channels/bindings                                      team
GET    /channels/bindings/:id                                  team
PATCH  /channels/bindings/:id                                  team
DELETE /channels/bindings/:id                                  team
POST   /channels/bindings/:id/connect                          team
POST   /channels/bindings/:id/disconnect                       team
POST   /channels/bindings/:id/test                             team
POST   /channels/bindings/:id/health-test                      team
DELETE /channels/bindings/:id/health-test                      team
GET    /channels/bindings/:id/outbox                           team
GET    /channels/inbox                                         team
POST   /channels/outbox/:id/approve                            team
POST   /channels/outbox/:id/reject                             team
POST   /channels/conversations/:id/release                     team
GET    /channels/bindings/:id/log                              team
POST   /channels/bindings/:id/senders                          team
PATCH  /channels/bindings/:id/senders/:sid                     team
DELETE /channels/bindings/:id/senders/:sid                     team
GET    /channels/bindings/:id/conversations                    team
PATCH  /channels/conversations/:id                             team
POST   /channels/conversations/:id/send                        team
GET    /channels/threads/:threadId                             team
POST   /channels/messages/:id/resend                           team
GET    /channels/slack-manifest                                shared
GET    /channels/discord-invite                                shared
GET    /channels/bindings/:id/whatsapp                         team
POST   /channels/bindings/:id/whatsapp/link                    team
POST   /channels/bindings/:id/whatsapp/logout                  team
GET    /channels/agents/:agentId/send-rules                    team
PUT    /channels/agents/:agentId/send-rules/owner              team
POST   /channels/agents/:agentId/send-rules                    team
DELETE /channels/agents/:agentId/send-rules/:ruleId            team
GET    /computers/cloud/providers                              shared
GET    /computers/cloud/:provider/options                      shared
GET    /computers/cloud/:provider/estimate                     shared
GET    /computers/cloud/vms                                    shared
POST   /computers/cloud/vms/:id/poweroff                       shared
POST   /computers/cloud/vms/:id/poweron                        shared
POST   /computers/cloud/vms/:id/refresh                        shared
POST   /computers/cloud/vms/:id/delete                         shared
GET    /computers/:agentId/cloud                               team
POST   /computers/:agentId/cloud                               team
GET    /computers/desktop/state                                shared
POST   /computers/desktop/stop                                 shared
POST   /computers/desktop/resume                               shared
GET    /computers/:agentId/screen                              team
GET    /computers/:agentId/screen/stream                       team
GET    /computers/:agentId/screen/frame.jpg                    team
GET    /computers/:agentId/screen/preview/:callId              team
GET    /computers/:agentId/screen/preview/:callId/image        team
POST   /computers/:agentId/screen/pause                        team
POST   /computers/:agentId/screen/resume                       team
DELETE /computers/:agentId/screen/grant                        team
GET    /computers/capabilities                                 shared
PUT    /computers/engine                                       shared
GET    /computers/profiles                                     shared
POST   /computers/profiles                                     shared
POST   /computers/profiles/:id/wipe                            shared
GET    /computers/profiles/:id/sites                           shared
POST   /computers/profiles/:id/logout                          shared
DELETE /computers/profiles/:id                                 shared
GET    /computers/rehearsals/:id                               team
GET    /computers/rehearsals/:id/diff                          team
GET    /computers/rehearsals/:id/compare                       team
POST   /computers/rehearsals/:id/apply                         team
POST   /computers/rehearsals/:id/revert                        team
POST   /computers/rehearsals/:id/end                           team
GET    /computers/snapshots/:id/preview                        team
POST   /computers/snapshots/:id/restore                        team
DELETE /computers/snapshots/:id                                team
GET    /computers                                              team
GET    /computers/:agentId                                     team
PUT    /computers/:agentId/config                              team
POST   /computers/:agentId/remote/test                         team
PUT    /computers/:agentId/remote/trust                        team
GET    /computers/:agentId/actions                             team
GET    /computers/:agentId/actions/:actionId/frame             team
POST   /computers/:agentId/browser/start                       team
POST   /computers/:agentId/browser/logout-site                 team
POST   /computers/:agentId/browser/close                       team
GET    /computers/:agentId/frame.jpg                           team
GET    /computers/:agentId/stream                              team
GET    /computers/:agentId/element                             team
POST   /computers/:agentId/takeover                            team
POST   /computers/:agentId/release                             team
POST   /computers/:agentId/heartbeat                           team
POST   /computers/:agentId/stop                                team
POST   /computers/:agentId/resume-host                         team
POST   /computers/:agentId/input                               team
GET    /computers/:agentId/rehearsal                           team
POST   /computers/:agentId/rehearsal                           team
GET    /computers/:agentId/rehearsal/compare                   team
GET    /computers/:agentId/snapshots                           team
POST   /computers/:agentId/snapshots                           team
GET    /computers/:agentId/desktop/windows                     team
GET    /computers/:agentId/desktop/preview/:sid                team
GET    /computers/:agentId/desktop/ref                         team
GET    /ocr                                                    shared
POST   /ocr/download                                           shared
DELETE /ocr                                                    shared
GET    /folders/trash                                          team
GET    /folders/trash/runs/:runId                              team
POST   /folders/trash/runs/:runId/restore                      team
POST   /folders/trash/:id/restore                              team
GET    /folders/trash/:id/raw                                  team
DELETE /folders/trash/:id                                      team
POST   /folders/werkplek/:agentId/follow-name                  team
POST   /folders/check                                          shared
GET    /openbot-import/openclaw/detect                         shared
GET    /openbot-import/openclaw/undo                           shared
GET    /openbot-import/detect                                  shared
GET    /openbot-import/last                                    shared
GET    /openbot-import/cutover                                 shared
GET    /openbot-import/undo                                    shared
GET    /openbot-import/hermes/detect                           shared
GET    /openbot-import/hermes/undo                             shared
GET    /usage/limits/:id                                       shared
POST   /usage/limits/:id/refresh                               shared
PUT    /usage/alerts                                           shared
GET    /usage/context/:threadId                                team
GET    /usage/status                                           team
GET    /usage/bar                                              shared
GET    /usage/bots/:id/cap                                     team
GET    /notifications                                          team
POST   /notifications/read                                     shared
DELETE /notifications                                          shared
GET    /notifications/prefs                                    shared
PUT    /notifications/prefs                                    shared
GET    /sites                                                  team
GET    /sites/preview/:approvalId                              team
POST   /sites/:id/republish                                    team
POST   /sites/:id/stop                                         team
DELETE /sites/:id                                              team
GET    /agents/:id/seen                                        team
PUT    /power                                                  shared
GET    /agents/:id/history                                     team
DELETE /agents/:id/history                                     team
GET    /rooms/:id/history                                      team
DELETE /rooms/:id/history                                      team
GET    /model-catalog                                          shared
GET    /model-catalog/choices                                  shared
PUT    /model-catalog                                          shared
POST   /model-catalog/refresh                                  shared
GET    /free-models                                            shared
PUT    /free-models/sources/:kind                              shared
POST   /free-models/refresh                                    shared
GET    /free-models/candidates                                 shared
GET    /engine-chain/settings                                  shared
PUT    /engine-chain/settings/teams/:teamId                    team
DELETE /engine-chain/settings/teams/:teamId                    team
PUT    /engine-chain/settings                                  shared
GET    /engine-chain/preview                                   shared
POST   /engine-chain/paused/:runId                             shared
GET    /local-models                                           shared
GET    /local-models/install                                   shared
POST   /local-models/install                                   shared
POST   /local-models/pull                                      shared
POST   /local-models/pull/cancel                               shared
POST   /local-models/probe                                     shared
POST   /local-models/use                                       shared
GET    /quality/inbox                                          team
GET    /quality/task/:kind/:ref                                team
PATCH  /quality/task/teamdata/:ref                             team
GET    /quality/suggestions                                    team
POST   /quality/suggestions/:id                                team
GET    /quality/lessons                                        team
GET    /team-templates                                         shared
GET    /team-templates/profile/:roomId                         team
GET    /team-templates/:id                                     shared
POST   /team-templates/:id/preview                             shared
POST   /team-templates/:id/install                             shared
GET    /specialists/meta                                       shared
GET    /specialists                                            team
POST   /specialists/rounds/:id/undo                            team
POST   /specialists/reports/:id/undo                           team
POST   /specialists/reports/:id/seen                           team
PATCH  /specialists/goals/:id                                  team
DELETE /specialists/goals/:id                                  team
GET    /specialists/:agentId                                   team
PUT    /specialists/:agentId                                   team
POST   /specialists/:agentId/learn                             team
GET    /specialists/:agentId/knowledge                         team
POST   /specialists/:agentId/knowledge                         team
POST   /specialists/:agentId/knowledge/:ref/retire             team
GET    /specialists/:agentId/goals                             team
POST   /specialists/:agentId/goals                             team
GET    /specialists/:agentId/reports                           team
POST   /specialists/:agentId/report                            team
PUT    /health/watchdog                                        shared
GET    /chat-folders                                           team
PUT    /chat-folders/items                                     team
PATCH  /chat-folders/:id                                       team
DELETE /chat-folders/:id                                       team
GET    /bot-rules                                              shared
POST   /bot-rules/preview                                      shared
GET    /backups                                                shared
PUT    /backups/settings                                       shared
POST   /backups                                                shared
GET    /backups/updates                                        shared
POST   /backups/updates/seen                                   shared
GET    /app-update                                             shared
GET    /workflows                                              shared
GET    /workflows/templates                                    shared
GET    /workflows/:id                                          shared
GET    /workflows/:id/runs                                     shared
GET    /workflows/:id/versions                                 shared
GET    /workflow-runs                                          shared
GET    /workflow-runs/:id                                      shared
GET    /images/status                                          shared
PUT    /images/settings                                        shared
POST   /images/test                                            shared
GET    /me                                                     shared
GET    /agents                                                 team
GET    /agents/shared                                          shared
GET    /agents/last-models                                     shared
GET    /agents/:id                                             team
PATCH  /agents/:id                                             team
POST   /agents/order                                           team
GET    /agents/:id/delete-preview                              team
DELETE /agents/:id                                             team
GET    /agents/:id/export                                      team
POST   /agents/generate                                        shared
GET    /threads                                                team
POST   /threads                                                team
GET    /threads/:id                                            team
PATCH  /threads/:id                                            team
DELETE /threads/:id                                            team
POST   /threads/:id/messages                                   team
POST   /threads/:id/stop                                       team
POST   /threads/:id/resume                                     team
POST   /threads/:id/retry                                      team
POST   /threads/:id/switch-engine                              team
GET    /threads/:id/export                                     team
PATCH  /messages/:id                                           team
POST   /messages/:id/rerun                                     team
POST   /threads/:id/regenerate                                 team
DELETE /messages/:id                                           team
POST   /messages/:id/react                                     team
POST   /messages/:id/pin                                       team
POST   /messages/:id/forward                                   team
POST   /attachments                                            shared
GET    /attachments/:id                                        team
GET    /search                                                 team
GET    /provider-kinds                                         shared
POST   /provider-kinds/:id/check                               shared
GET    /providers                                              shared
POST   /providers                                              shared
PATCH  /providers/:id                                          shared
DELETE /providers/:id                                          shared
POST   /providers/:id/test                                     shared
GET    /providers/:id/models                                   shared
GET    /providers/:id/model-info                               shared
PUT    /providers/:id/context-window                           shared
POST   /providers/free-reserve                                 shared
POST   /providers/autodetect                                   shared
GET    /approvals                                              team
GET    /runs                                                   team
POST   /runs/:id/cancel                                        team
GET    /settings                                               shared
PUT    /settings                                               shared
GET    /web-search/status                                      shared
GET    /tools                                                  shared
GET    /audit                                                  team
GET    /agents/:id/versions                                    team
POST   /agents/:id/versions/:vid/restore                       team
POST   /attachments/:id/preview                                team
GET    /my-limits                                              shared
POST   /threads/:id/fork                                       team
GET    /link-preview                                           shared
POST   /threads/:id/compact                                    team
GET    /threads/:id/queue                                      team
POST   /threads/:id/queue                                      team
POST   /threads/:id/steer                                      team
POST   /threads/:id/queue/pause                                team
POST   /threads/:id/queue/resume                               team
PATCH  /threads/:id/queue/:itemId                              team
POST   /threads/:id/queue/:itemId/move                         team
POST   /threads/:id/queue/:itemId/steer                        team
DELETE /threads/:id/queue/:itemId                              team
`;

/** "METHOD /pattern" → its kind, for every route that has no rule of its own. */
const TABLE: Record<string, Kind> = Object.fromEntries(
  TABLE_TEXT.split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((x) => x.length === 3)
    .map(([method, path, kind]) => [routeKey(method, path), kind as Kind]),
);

/** The rule for a route (by its registered pattern), or null when it has no kind yet (then: the ids in the call decide). */
export function ruleOf(method: string, pattern: string): Rule | null {
  const key = routeKey(method, pattern);
  if (RULES[key]) return RULES[key];
  const kind = TABLE[key];
  return kind ? { kind } : null;
}

/** The kind of every route that has one (for the test that every registered route has a decision). */
export function kindOf(method: string, pattern: string): Kind | null {
  return ruleOf(method, pattern)?.kind ?? null;
}

/** The values of a route's :params in a concrete path (same number of segments). */
export function paramsOf(pattern: string, path: string): Record<string, string> {
  const out: Record<string, string> = {};
  const ps = pattern.split('/');
  const xs = path.split('/');
  if (ps.length !== xs.length) return out;
  ps.forEach((p, i) => {
    if (p.startsWith(':')) out[p.slice(1)] = xs[i];
  });
  return out;
}
