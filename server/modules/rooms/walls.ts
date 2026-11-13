import type { Agent } from '../../core/types.js';
import { bad } from '../../core/http.js';
import type { RoomService } from './service.js';
import type { BotPerms, Member, Room } from './types.js';
import { PLACE } from '../../../shared/places.js';

/**
 * Team walls for groups (0.4, package B2). A group belongs to one team (`rooms.workspace_id`, module teams):
 *  - a bot of that team takes part as always;
 *  - a bot of another team can only join with meekijken or aansturen on the group's team, and only when the owner
 *    chose "Bots van andere teams toestaan" for the group (`settings.crossTeam`, shown on the group and in the chat);
 *  - such a bot gets what its access allows: the group files read-only, the task board only with aansturen;
 *  - a member that loses its access (or whose group no longer allows other teams) stops taking turns: the group says
 *    why. Delegating from a group to a bot of another team still needs aansturen (Orchestrator, B-core).
 * Groups from before teams belong to the team of their bots (the lead's, else most bots'), else the default team; a
 * group whose bots already came from several teams gets "Bots van andere teams toestaan" on, so nothing changes
 * silently for what the owner set up himself.
 */

export type Reach = 'home' | 'direct' | 'read' | 'none';

const teamsOf = (s: RoomService): any => s.ctx.services.teams;

export const crossTeamOn = (room: Room) => room.settings?.crossTeam === true;

/** The team a new group belongs to: the one asked for, the org-chart department's, the lead's, the first bot's, or the default team. */
export function startTeam(s: RoomService, userId: string, o: { workspaceId?: unknown; departmentId?: string | null; agentIds: string[]; leadId?: string | null }): string | null {
  const svc = teamsOf(s);
  if (!svc?.teamOf) return null;
  const want = typeof o.workspaceId === 'string' && o.workspaceId ? svc.team(o.workspaceId) : null;
  if (want && want.user_id === userId) return want.id;
  const dept = o.departmentId ? s.ctx.store.get<any>('room_teams', o.departmentId) : null;
  if (dept?.workspace_id && svc.team(dept.workspace_id)?.user_id === userId) return dept.workspace_id;
  for (const id of [o.leadId, ...o.agentIds]) {
    const t = id ? svc.teamOf(id) : null;
    if (t) return t;
  }
  return svc.defaultTeam(userId)?.id ?? null;
}

/** The team of a group from before teams: its lead's, else the one most of its bots belong to. */
function guessTeam(s: RoomService, room: Room): { teamId: string | null; mixed: boolean } {
  const svc = teamsOf(s);
  const bots = s.botMembers(room).map((m) => m.ref_id);
  const homes = bots.map((id) => svc.teamOf(id) as string | null).filter((x): x is string => !!x);
  const mixed = new Set(homes).size > 1;
  const lead = room.lead_agent_id && bots.includes(room.lead_agent_id) ? svc.teamOf(room.lead_agent_id) : null;
  if (lead) return { teamId: lead, mixed };
  const count = new Map<string, number>();
  for (const h of homes) count.set(h, (count.get(h) || 0) + 1);
  const best = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { teamId: best || svc.defaultTeam(room.user_id)?.id || null, mixed };
}

/** The team a group belongs to (filled in the first time for a group from before teams, or whose team was removed). */
export function roomTeam(s: RoomService, room: Room): string | null {
  const svc = teamsOf(s);
  if (!svc?.teamOf) return room.workspace_id ?? null;
  if (room.workspace_id && svc.team(room.workspace_id)) return room.workspace_id;
  const { teamId, mixed } = guessTeam(s, room);
  if (!teamId) return null;
  const patch: Partial<Room> = { workspace_id: teamId };
  if (mixed && !crossTeamOn(room)) patch.settings = { ...(room.settings || {}), crossTeam: true };
  s.ctx.store.update('rooms', room.id, patch);
  Object.assign(room, patch);
  return teamId;
}

/** Start of the app: every group from before teams gets its team. */
export function backfillRooms(s: RoomService) {
  if (!teamsOf(s)?.teamOf) return;
  for (const r of s.ctx.store.all<any>('SELECT * FROM rooms WHERE workspace_id IS NULL')) roomTeam(s, s.ctx.store.decode<Room>('rooms', r));
}

/** A bot's reach in the team of a group ('home' when teams are not in play). */
export function reachIn(s: RoomService, room: Room, agentId: string): Reach {
  const svc = teamsOf(s);
  const team = roomTeam(s, room);
  if (!svc?.access || !team) return 'home';
  return svc.access(agentId, team) as Reach;
}

function names(s: RoomService, teamId: string, agentId: string) {
  const svc = teamsOf(s);
  return {
    bot: s.ctx.store.agent(agentId)?.name || 'Deze bot',
    team: svc.team(teamId)?.name || 'dit team',
    home: svc.team(svc.teamOf(agentId))?.name || 'een ander team',
  };
}

/** Why a bot may not join a group of team `teamId` (null = it may). */
export function joinRefusal(s: RoomService, teamId: string | null, agentId: string, crossTeam: boolean): string | null {
  const svc = teamsOf(s);
  if (!svc?.access || !teamId) return null;
  const r = svc.access(agentId, teamId) as Reach;
  if (r === 'home') return null;
  const n = names(s, teamId, agentId);
  if (r === 'none') return `${n.bot} hoort bij team “${n.home}” en heeft geen toegang tot team “${n.team}”, waar deze groep bij hoort. Geef ${n.bot} eerst meekijken of aansturen voor “${n.team}” (${PLACE.teams}).`;
  if (!crossTeam) return `${n.bot} hoort bij team “${n.home}”, en deze groep hoort bij team “${n.team}”. Zet eerst “Bots van andere teams toestaan” aan voor deze groep.`;
  return null;
}

/** Why a member may not take a turn in the group (null = it may): it lost its access, or the group no longer allows other teams. */
export function memberRefusal(s: RoomService, room: Room, agentId: string): string | null {
  const team = roomTeam(s, room);
  if (!team) return null;
  const r = reachIn(s, room, agentId);
  if (r === 'home') return null;
  const n = names(s, team, agentId);
  if (r === 'none') return `${n.bot} hoort bij team “${n.home}” en heeft geen toegang (meer) tot team “${n.team}”, waar deze groep bij hoort. ${n.bot} doet hier niet mee tot de eigenaar weer toegang geeft (${PLACE.teams}).`;
  if (!crossTeamOn(room)) return `${n.bot} hoort bij team “${n.home}”, en deze groep staat geen bots van andere teams toe. Zet “Bots van andere teams toestaan” aan om ${n.bot} mee te laten doen.`;
  return null;
}

/**
 * A change to a group's team (`workspaceId`) or to "Bots van andere teams toestaan" (`crossTeam`), checked against
 * its bots: never a member left behind that may not be there. `notes`: what the group chat says about it.
 */
export function wallPatch(s: RoomService, room: Room, patch: any): { set: Partial<Room>; notes: string[] } {
  const set: Partial<Room> = {};
  const notes: string[] = [];
  const svc = teamsOf(s);
  if (!svc?.team || (patch?.workspaceId === undefined && patch?.crossTeam === undefined)) return { set, notes };
  let team = roomTeam(s, room);
  if (patch.workspaceId !== undefined) {
    const t = svc.team(String(patch.workspaceId || ''));
    if (!t || t.user_id !== room.user_id) throw bad('Onbekend team');
    if (t.id !== team) {
      team = t.id;
      set.workspace_id = t.id;
      notes.push(`Deze groep hoort nu bij team “${t.name}”.`);
    }
  }
  const cross = patch.crossTeam === undefined ? crossTeamOn(room) : patch.crossTeam === true;
  if (!team) return { set, notes };
  const others = s.botMembers(room).filter((m) => svc.access(m.ref_id, team) !== 'home');
  if (!cross && others.length)
    throw bad(`Er doen nog bots van andere teams mee (${others.map((m) => s.agentName(m.ref_id)).join(', ')}). Haal ze eerst uit de groep, of laat bots van andere teams toe.`);
  for (const m of others) {
    const why = joinRefusal(s, team, m.ref_id, cross);
    if (why) throw bad(why);
  }
  if (cross !== crossTeamOn(room)) {
    set.settings = { ...(room.settings || {}), crossTeam: cross };
    notes.push(cross ? 'Deze groep staat nu bots van andere teams toe. Zij zien wat hier gebeurt, binnen wat hun toegang toestaat.' : 'Deze groep staat geen bots van andere teams meer toe.');
  }
  return { set, notes };
}

/** What a member of another team may do in the group: files read-only, the task board only with aansturen. */
export function capPerms(s: RoomService, m: Member, p: BotPerms): BotPerms {
  if (m.kind !== 'agent') return p;
  const room = s.room(m.room_id);
  if (!room) return p;
  const r = reachIn(s, room, m.ref_id);
  if (r === 'home') return p;
  return {
    ...p,
    files: r === 'none' ? 'none' : p.files === 'write' ? 'read' : p.files,
    tasks: r === 'direct' ? p.tasks : false,
    delegate: r === 'none' ? false : p.delegate,
  };
}

/** "Ada (team “A”, meekijken) is aan de groep toegevoegd." for a bot of another team; null for the group's own. */
export function guestLine(s: RoomService, room: Room, agentId: string): string | null {
  const team = roomTeam(s, room);
  const r = team ? reachIn(s, room, agentId) : 'home';
  if (!team || r === 'home') return null;
  const n = names(s, team, agentId);
  return `${n.bot} (team “${n.home}”, ${r === 'direct' ? 'aansturen' : 'meekijken'}) is aan de groep van team “${n.team}” toegevoegd. ${n.bot} ziet wat hier gebeurt en leest de groepsbestanden, maar schrijft ze niet.`;
}

/** The bots of a group that are not of its team. */
export function foreignBots(s: RoomService, room: Room): string[] {
  return s.botMembers(room).filter((m) => reachIn(s, room, m.ref_id) !== 'home').map((m) => m.ref_id);
}

/** The team part of a group's view (owner and members): its team, whether other teams are allowed, and how many take part. */
export function roomTeamView(s: RoomService, room: Room) {
  const svc = teamsOf(s);
  const team = roomTeam(s, room);
  return { workspaceId: team, workspaceName: team ? svc?.team(team)?.name || null : null, crossTeam: crossTeamOn(room), foreignBots: team ? foreignBots(s, room).length : 0 };
}

/** The team part of a bot member's view: its home team and its reach in the group's team. */
export function memberTeamView(s: RoomService, room: Room, agentId: string) {
  const svc = teamsOf(s);
  if (!svc?.teamOf) return {};
  const home = svc.teamOf(agentId);
  return { homeTeamId: home, homeTeamName: home ? svc.team(home)?.name || '' : '', teamReach: reachIn(s, room, agentId) };
}

/** One stable line for the group's system prompt (two or more teams only): whose group this is, and the bot's place in it. */
export function wallPrompt(s: RoomService, room: Room, agent: Agent): string | null {
  const svc = teamsOf(s);
  const team = roomTeam(s, room);
  if (!team || !svc?.multi?.(room.user_id)) return null;
  const n = names(s, team, agent.id);
  const r = reachIn(s, room, agent.id);
  if (r === 'home') return `Deze groep hoort bij team “${n.team}”${crossTeamOn(room) ? '; er doen ook bots van andere teams mee (ze zien wat hier gebeurt)' : ''}.`;
  return `Deze groep hoort bij team “${n.team}”. Jij hoort bij team “${n.home}” en mag hier ${r === 'direct' ? 'aansturen' : 'meekijken'}: de groepsbestanden alleen lezen${r === 'read' ? ', geen taken op het takenbord' : ''}. Neem niets uit dit team mee naar je eigen team, tenzij de eigenaar daarom vraagt.`;
}
