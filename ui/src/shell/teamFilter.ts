/**
 * The team switcher's rules, without React or imports, so they are unit-tested (tests/team-switcher.test.ts).
 *
 * - With one team there is no choice: the view is "Alle teams" and nothing is filtered or shown.
 * - From two teams the owner picks *Alle teams* ('') or one team; the choice is kept per device and falls back to
 *   *Alle teams* when that team is gone.
 * - A view only hides things it knows belong to another team. Whatever has no team yet (a bot that was just made, a
 *   task of the owner himself, a group without bots) stays visible, like the server does (`room_tasks` without a team
 *   are visible to all). This is about what you see; the walls between teams are enforced by the server.
 * - The main bot (hoofdbot, package C2) stands above all teams: always in view, first among the pinned bots.
 */

/** What the switcher needs of a team (GET /api/teams). `main`: the owner's main bot (package C2's server sets it). */
export interface TeamLite {
  id: string;
  name: string;
  color: string;
  bots: { id: string; name: string; main?: boolean }[];
}

/** "Alle teams". */
export const ALL_TEAMS = '';

/**
 * The owner's main bot ("hoofdbot", package C2), or null. Feature-detected from GET /api/teams, where C2's server marks
 * it with `main: true` among the bots of its home team (the role itself lives in the teams module, table `team_main`;
 * C2's `GET /api/teams/main` gives the same). An older server has no main bot. Archived bots are not in the list.
 */
export function mainIdOf(teams: TeamLite[]): string | null {
  for (const t of teams) for (const b of t.bots || []) if (b.main === true) return b.id;
  return null;
}

/** The team the view shows: the stored choice while that team exists and there are two or more teams, else ''. */
export function effectiveTeam(stored: string | null | undefined, teams: { id: string }[]): string {
  if (teams.length < 2 || !stored) return ALL_TEAMS;
  return teams.some((t) => t.id === stored) ? stored : ALL_TEAMS;
}

/** Bot id → home team id. */
export function homeMap(teams: TeamLite[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of teams) for (const b of t.bots || []) m.set(b.id, t.id);
  return m;
}

/** Bot name (lowercase, trimmed) → bot id, for tasks that name their owner instead of an id (the team database). */
export function botIdsByName(teams: TeamLite[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of teams) for (const b of t.bots || []) if (b.name) m.set(b.name.trim().toLowerCase(), b.id);
  return m;
}

/** Does a bot belong in the view? A bot of no known team (just made, or shared) stays visible. */
export function botInView(agentId: string, team: string, home: Map<string, string>): boolean {
  if (!team) return true;
  const h = home.get(agentId);
  return !h || h === team;
}

/** A team id a record carries itself (a newer server may add one to groups and tasks). */
function ownTeam(r: Record<string, any> | null | undefined): string | null {
  if (!r) return null;
  for (const k of ['teamId', 'team_id', 'workspace_id', 'workspaceId']) if (typeof r[k] === 'string' && r[k]) return r[k];
  return null;
}

/**
 * Does a group belong in the view? Its own team when the server gives one (`teamId`); otherwise when one of its bots
 * has this team as home team, or when it has no bots of a known team at all.
 */
export function roomInView(room: { bots?: { agentId: string }[] } & Record<string, any>, team: string, home: Map<string, string>): boolean {
  if (!team) return true;
  const own = ownTeam(room);
  if (own) return own === team;
  const homes = (room.bots || []).map((b) => home.get(b.agentId)).filter(Boolean);
  return !homes.length || homes.includes(team);
}

/**
 * The team of a task, or null for a task without a team (the owner's own: shown in every team).
 * - TeamBot's own board (`room_tasks`): its `workspace_id`, else the home team of the bot that owns it;
 * - the team database (`taken`): a team column when the server adds one, else the home team of the bot named in
 *   `eigenaar`.
 */
export function taskTeamOf(raw: Record<string, any>, source: 'board' | 'team', home: Map<string, string>, idByName: Map<string, string>): string | null {
  const own = source === 'board' ? (typeof raw.workspace_id === 'string' && raw.workspace_id) || null : ownTeam(raw) || (typeof raw.team === 'string' && raw.team) || null;
  if (own) return own;
  if (source === 'board') return raw.owner_type === 'agent' && raw.owner_id ? home.get(raw.owner_id) || null : null;
  const owner = String(raw.eigenaar ?? '').trim().toLowerCase();
  const id = owner ? idByName.get(owner) : undefined;
  return id ? home.get(id) || null : null;
}

/** Keys of the task board (`b:<id>`, `t:<id>`, see pages/tasks/model.ts) that are hidden in this team's view. */
export function hiddenTaskKeys(board: Record<string, any>[], teamRows: Record<string, any>[], team: string, teams: TeamLite[]): Set<string> {
  const out = new Set<string>();
  if (!team) return out;
  const home = homeMap(teams);
  const names = botIdsByName(teams);
  for (const t of board) {
    const k = taskTeamOf(t, 'board', home, names);
    if (k && k !== team) out.add(`b:${t.id}`);
  }
  for (const r of teamRows) {
    const k = taskTeamOf(r, 'team', home, names);
    if (k && k !== team) out.add(`t:${r.id}`);
  }
  return out;
}

/** The pinned tiles: the main bot first (always, whatever the team), then the other pinned bots; at most `max`. */
export function tilesWithMain<A extends { id: string }>(main: A | undefined, pinned: A[], max = 3): A[] {
  if (!main) return pinned.slice(0, max);
  return [main, ...pinned.filter((a) => a.id !== main.id)].slice(0, max);
}
