import type { Agent, Ctx } from '../../core/types.js';
import type { TeamsService } from './service.js';
import { type Kind, type RuleCall, type RuleEnv, paramsOf, ruleOf } from './routetable.js';
import { PLACE } from '../../../shared/places.js';

/**
 * A bot that works TeamBot's screens (manage.ts: teambot_do) does so with ITS OWN reach, not the owner's. The routes it
 * calls only know the owner, so the walls are kept here, before the call and on its answer:
 *  - the teams (none / meekijken / aansturen): a call that names something of a team (a bot, a routine, a task, a
 *    dossier, a channel, a conversation …) needs the bot's access to that team: looking needs meekijken, changing needs
 *    aansturen or its own team. A team without access does not exist for the bot: reading is refused like writing, and
 *    whatever hangs on that team is left out of every list;
 *  - the keys: a key that is "alleen dit team" (an AI, an app, a login) is for the bots of that team only
 *    (`keyAllowed`): a call that names it is refused, and it is left out of lists;
 *  - what the route is about (routetable.ts): memory is written in the bot's own team only, a new bot lands in its own
 *    team, a total over all teams is not given across a wall, without a team named it is the bot's own team, all of
 *    memory at once is the owner's.
 * What a call is about is read from the ids in it (path, query and body), plus the route's own rule: a bot, a team, a
 * key with a scope, or a row of any table that says whose it is (team_id, agent_id, or the conversation, group,
 * routine, channel or dossier it hangs on).
 *
 * `reachOf` gives null only for the owner's main bot, which works TeamBot as the owner, and in an installation with one
 * team (how most are): there is no other team to keep anything from. Every other bot gets its reach, also one that may
 * aansturen every team: its memory is still only its own team's to write (`walls` is then false: nothing is kept from
 * it to read). The main bot gets its reach too as soon as the owner himself shut it out of a team ("Geen toegang"): that
 * team's wall holds for it on every route, to look as well; the keys of the teams it still reaches stay its to use.
 */
export interface Reach {
  /** There is a team this bot cannot look into, or a key it cannot use: an answer that cannot be looked through is withheld. */
  walls: boolean;
  /** The bot's home team. */
  home: string;
  /** Why this bot may not make this call, or the call as this bot makes it (its query and body, what to do with the answer). */
  check(call: CallIn): Checked;
  /** Why this bot may not make this call (one sentence), or null: the ids in it only. */
  refusal(method: string, path: string, query: string, body: unknown): string | null;
  /** The answer without what belongs to a team the bot cannot look into or a key it cannot use. */
  filter<T>(json: T): T;
  /** The answer is itself one thing (not a list) of a team the bot cannot look into, or a key it cannot use. */
  hides(json: unknown): boolean;
  /** The sentence for something behind a wall. A team without access is never named. */
  closed: string;
}

/** One call: `route` is the pattern it matched (`/routines/:id/pause`). */
export interface CallIn {
  method: string;
  path: string;
  query: string;
  body: unknown;
  route: string;
}
export type Checked =
  | { no: string }
  | {
      no?: undefined;
      query: string;
      body: unknown;
      kind: Kind | null;
      /** Only on the owner's own word in a chain he started himself. */
      ownerChain: boolean;
      /** The answer as this bot may see it (before `filter`). */
      after(json: any): any;
    };

/** TeamBot's own ids: a short prefix, an underscore and hex ("rtn_91dbaabef319471ea9263c"). */
const ID = /^[a-z][a-z0-9]{0,15}_[0-9a-f]{12,}$/i;
const TEAM_COLS = ['team_id', 'workspace_id'];
/** What a row hangs on when it does not say its team or bot itself. */
const UP_COLS = ['thread_id', 'room_id', 'routine_id', 'binding_id', 'dossier_id'];
const MAX_DEPTH = 12;
const KEY_HIDDEN = '[sleutel van een ander team]';

interface Owned {
  table: string;
  cols: string[];
}
const ownedTables = new WeakMap<Ctx, Owned[]>();
/** Per database: the table an id with this prefix was last found in (looked at first). */
const prefixTable = new WeakMap<Ctx, Map<string, string>>();

/** Every table with a text id whose rows say whose they are. Read once from the database itself. */
function owned(ctx: Ctx): Owned[] {
  let list = ownedTables.get(ctx);
  if (list) return list;
  list = [];
  for (const { name } of ctx.store.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")) {
    if (name === 'agents' || name === 'teams' || !/^[a-z][a-z0-9_]*$/i.test(name)) continue;
    let cols: { name: string; type: string }[] = [];
    try {
      cols = ctx.store.all<{ name: string; type: string }>(`PRAGMA table_info(${JSON.stringify(name)})`);
    } catch {
      continue;
    }
    const id = cols.find((c) => c.name === 'id');
    if (!id || /INT/i.test(id.type || '')) continue;
    const link = cols.map((c) => c.name).filter((c) => c === 'agent_id' || TEAM_COLS.includes(c) || UP_COLS.includes(c));
    // Memory says "no team" for "Over jou" by its scope; without a team otherwise it is the default team's.
    if (name.startsWith('memory_') && cols.some((c) => c.name === 'scope')) link.push('scope');
    if (link.length) list.push({ table: name, cols: link });
  }
  ownedTables.set(ctx, list);
  return list;
}

/** Every string in a value (a body, an item of an answer), a few levels deep: the keys of an object too (a map by bot id). */
function strings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (typeof v === 'string') out.push(v);
  else if (v && typeof v === 'object' && depth < 6 && out.length < 400) {
    if (!Array.isArray(v)) out.push(...Object.keys(v));
    for (const x of Array.isArray(v) ? v : Object.values(v)) strings(x, out, depth + 1);
  }
  return out;
}

/** The ids in one string: the string itself, or the parts of an id made of more ("<team>:3", "run:<id>", "a:1,b:2"). */
function idsIn(s: string): string[] {
  if (ID.test(s)) return [s];
  if (s.length > 400 || !/[:,|]/.test(s)) return [];
  return s.split(/[:,|]/).filter((x) => ID.test(x.trim())).map((x) => x.trim());
}

export function reachOf(ctx: Ctx, svc: TeamsService, agent: Agent): Reach | null {
  const userId = agent.user_id;
  const teams = svc.list(userId);
  const main = svc.mainOf(userId) === agent.id;
  if (main && teams.every((t) => svc.canRead(agent.id, t.id))) return null;
  if (teams.length <= 1) return null;
  let scoped: { kind: string; ref_id: string }[] = [];
  try {
    scoped = ctx.store.all<{ kind: string; ref_id: string }>('SELECT kind, ref_id FROM team_key_scopes WHERE user_id = ?', userId);
  } catch {
    scoped = [];
  }
  /** The main bot uses the keys of every team it reaches (as the owner); any other bot only those of its own team. */
  const keyOpen = (k: { kind: string; ref_id: string }) => {
    if (!main) return svc.keyAllowed(agent, k.kind as Parameters<TeamsService['keyAllowed']>[1], k.ref_id);
    const team = svc.keyScope(k.kind as Parameters<TeamsService['keyScope']>[0], k.ref_id);
    return !team || svc.canRead(agent.id, team);
  };
  const closedKeys = new Set(scoped.filter((k) => !keyOpen(k)).map((k) => k.ref_id));
  const walls = closedKeys.size > 0 || teams.some((t) => !svc.canRead(agent.id, t.id));
  const home = svc.teamOf(agent.id) || teams[0].id;
  const defaultTeam = teams[0].id;

  const known = prefixTable.get(ctx) || new Map<string, string>();
  prefixTable.set(ctx, known);
  const memo = new Map<string, string | null>();
  /** The team an id belongs to: a bot's home team, a team itself, or the team of the row with this id. */
  const teamOf = (id: string, depth = 0): string | null => {
    if (memo.has(id)) return memo.get(id)!;
    let team: string | null = null;
    const bot = ctx.store.agent(id);
    if (bot) team = bot.user_id === userId ? svc.teamOf(bot.id) : null;
    else if (svc.team(id)) team = id;
    else {
      const prefix = id.slice(0, id.indexOf('_') + 1);
      const first = known.get(prefix);
      const tables = owned(ctx);
      for (const t of first ? [...tables.filter((x) => x.table === first), ...tables.filter((x) => x.table !== first)] : tables) {
        let row: Record<string, unknown> | undefined;
        try {
          row = ctx.store.one<Record<string, unknown>>(`SELECT ${t.cols.join(', ')} FROM "${t.table}" WHERE id = ?`, id);
        } catch {
          row = undefined;
        }
        if (!row) continue;
        known.set(prefix, t.table);
        for (const c of TEAM_COLS) if (!team && typeof row[c] === 'string' && svc.team(row[c] as string)) team = row[c] as string;
        if (!team && typeof row.agent_id === 'string' && ctx.store.agent(row.agent_id)) team = svc.teamOf(row.agent_id);
        if (!team && depth < 3) for (const c of UP_COLS) if (!team && typeof row[c] === 'string' && row[c]) team = teamOf(row[c] as string, depth + 1);
        // Memory without a team is the default team's ("Over jou" is no team's; "*" is every team's).
        if (!team && t.table.startsWith('memory_') && 'team_id' in row && row.team_id === null && row.scope !== 'about_you') team = defaultTeam;
        break;
      }
    }
    memo.set(id, team);
    return team;
  };
  /** Does this id belong to a team the bot cannot look into? */
  const walled = (v: unknown): boolean => {
    if (typeof v !== 'string') return false;
    return idsIn(v).some((id) => {
      const team = teamOf(id);
      return !!team && !svc.canRead(agent.id, team);
    });
  };
  /**
   * An item of a list that is not for this bot: it is a key the bot cannot use, or one of its own fields names
   * something of a team the bot cannot look into (its bot, its team, the conversation or group it hangs on).
   */
  const gone = (x: unknown): boolean => {
    if (typeof x === 'string') return closedKeys.has(x) || walled(x);
    if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
    const own = (x as { id?: unknown }).id;
    // An item that is the key itself: by its id, or (without an id of its own) by any field (providerId, appId …).
    if (typeof own === 'string' ? closedKeys.has(own) : Object.values(x).some((v) => typeof v === 'string' && closedKeys.has(v))) return true;
    return Object.values(x).some(walled);
  };
  /** A key of another team named by something else (a bot's provider_id): the bot does not see which key it is. */
  const masked = (x: unknown) => (typeof x === 'string' && closedKeys.has(x) ? KEY_HIDDEN : x);
  const walk = (v: any, depth: number): any => {
    if (!v || typeof v !== 'object' || depth > MAX_DEPTH) return v;
    if (Array.isArray(v)) return v.filter((x) => !gone(x)).map((x) => walk(masked(x), depth + 1));
    return Object.fromEntries(Object.entries(v).filter(([k]) => !gone(k)).map(([k, x]) => [k, walk(masked(x), depth + 1)]));
  };

  const closed = `Geweigerd door TeamBot: dit hoort bij een team waar ${agent.name} geen toegang toe heeft. Werk binnen je eigen team, of vraag je eigenaar om toegang (${PLACE.teams}).`;
  const refusal = (method: string, path: string, query: string, body: unknown): string | null => {
    const write = method !== 'GET';
    const ids = new Set([...path.split('/'), ...[...new URLSearchParams(query).values()], ...strings(body)].flatMap(idsIn));
    for (const id of ids) {
      if (closedKeys.has(id)) return `Geweigerd door TeamBot: deze sleutel (een AI, app of login) is alleen voor een ander team dan dat van ${agent.name}. Gebruik een sleutel van je eigen team, of vraag je eigenaar hem voor alle teams te zetten (${PLACE.teams}).`;
      const team = teamOf(id);
      if (!team) continue;
      const r = svc.access(agent.id, team);
      if (r === 'none') return closed;
      if (write && r === 'read') return `Geweigerd door TeamBot: bij team “${svc.team(team)?.name || ''}” mag ${agent.name} alleen meekijken, niets veranderen. Vraag je eigenaar om toegang (${PLACE.teams}).`;
    }
    return null;
  };
  const env: RuleEnv = {
    ctx,
    svc,
    agent,
    home,
    walls: teams.some((t) => !svc.canRead(agent.id, t.id)),
    memory: ctx.services.memory?.svc ?? null,
    closed,
    canRead: (t) => !!t && svc.canRead(agent.id, t),
    canDirect: (t) => !!t && svc.canDirect(agent.id, t),
  };
  return {
    walls,
    home,
    closed,
    refusal,
    check(call) {
      const rule = ruleOf(call.method, call.route);
      const c: RuleCall = {
        method: call.method,
        path: call.path,
        params: paramsOf(call.route, call.path),
        query: new URLSearchParams(call.query),
        body: call.body === undefined ? undefined : structuredClone(call.body),
      };
      const before = rule?.before?.(c, env);
      if (before) return { no: before };
      const no = refusal(c.method, c.path, c.query.toString(), c.body);
      if (no) return { no };
      rule?.merge?.(c, env);
      const query = c.query.toString();
      return { query, body: c.body, kind: rule?.kind ?? null, ownerChain: !!rule?.ownerChain && c.method !== 'GET', after: (json) => (rule?.after ? rule.after(json, c, env) : json) };
    },
    filter: (json) => walk(json, 0),
    hides: (json) => !Array.isArray(json) && gone(json),
  };
}
