import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx, Message, MessageParts, Run, Thread } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import { bad, forbidden, notFound } from '../../core/http.js';
import { usdText, userLocale } from '../../core/i18n.js';
import { DEFAULT_LIMITS, MODES, cleanLimits, effectiveLimits, findMentions, type Limits, type Named, type RoomMode } from './routing.js';
import {
  ACTIVE_RUN,
  DEFAULT_BOT_PERMS,
  TERMINAL_RUN,
  type Access,
  type BotPerms,
  type HumanRole,
  type Member,
  type MemberState,
  type Room,
  type TeamMeta,
} from './types.js';
import type { Orchestrator } from './orchestration.js';
import { capPerms, crossTeamOn, guestLine, joinRefusal, memberRefusal, memberTeamView, roomTeam, roomTeamView, startTeam, wallPatch } from './walls.js';

const SETTINGS_KEY = 'rooms:defaults';

/** Small bounded set for de-duplicating events that are emitted once per audience member. */
class Seen<V = true> {
  private m = new Map<string, V>();
  constructor(private max = 5000) {}
  get(k: string) {
    return this.m.get(k);
  }
  has(k: string) {
    return this.m.has(k);
  }
  set(k: string, v: V) {
    this.m.delete(k);
    this.m.set(k, v);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
  }
  delete(k: string) {
    this.m.delete(k);
  }
}

export interface DispatchResult {
  run?: Run;
  refused?: string;
}

/**
 * Rooms: shared transcripts with several bots and people. Owns membership + ACL, routing of new messages,
 * the per-participant state machine, limits (turns, depth, handoffs, steps, time-outs, spend) and stop/resume.
 */
export class RoomService {
  orch!: Orchestrator;
  private seenRun = new Seen<string>();
  private seenMsg = new Seen();
  private timers = new Map<string, NodeJS.Timeout>();
  /** Runs cancelled by our own time-out (so the state machine shows "time-out", not "gestopt"). */
  timedOut = new Seen();
  /** Runs cancelled by "stop this bot" (an "om de beurt" sequence continues with the next bot). */
  memberStopped = new Seen();
  private unsub: (() => void)[] = [];

  constructor(public ctx: Ctx) {}

  // ------------------------------------------------------------------ basics

  room(id: string | null | undefined): Room | null {
    return id ? this.ctx.store.get<Room>('rooms', id) : null;
  }

  /** The room a thread belongs to (main transcript or one of its delegation subthreads). */
  roomForThread(t: Thread | null | undefined): Room | null {
    if (!t) return null;
    if (t.room_id) return this.room(t.room_id);
    if (t.kind === 'room') {
      const r = this.ctx.store.one<any>('SELECT * FROM rooms WHERE thread_id = ?', t.id);
      return r ? this.ctx.store.decode<Room>('rooms', r) : null;
    }
    return null;
  }

  members(roomId: string): Member[] {
    return this.ctx.store.find<Member>('room_members', { room_id: roomId }, { order: 'sort, created_at' });
  }

  botMembers(room: Room): Member[] {
    return this.members(room.id).filter((m) => m.kind === 'agent' && this.ctx.store.agent(m.ref_id) && !this.ctx.store.agent(m.ref_id)!.archived);
  }

  botMember(room: Room, agentId: string): Member | null {
    const r = this.ctx.store.one<any>("SELECT * FROM room_members WHERE room_id = ? AND kind = 'agent' AND ref_id = ?", room.id, agentId);
    return r ? this.ctx.store.decode<Member>('room_members', r) : null;
  }

  humanMembers(room: Room, opts: { includePending?: boolean } = {}): Member[] {
    return this.members(room.id).filter((m) => m.kind === 'user' && (opts.includePending || m.accepted));
  }

  perms(m: Member | null): BotPerms {
    const p = { ...DEFAULT_BOT_PERMS, ...(m?.perms || {}) };
    // Teams (walls.ts): a bot of another team gets what its access to the group's team allows.
    return m ? capPerms(this, m, p) : p;
  }

  agentName(id: string | null | undefined) {
    return this.ctx.store.agent(id)?.name || 'Onbekende bot';
  }

  userName(id: string | null | undefined) {
    return (id && this.ctx.store.user(id)?.name) || 'Onbekend';
  }

  /** What the given human may do in a room. Guests see only the room transcript. */
  access(room: Room | null, userId: string): Access | null {
    if (!room) return null;
    if (room.user_id === userId) return 'owner';
    const m = this.ctx.store.one<any>("SELECT role, accepted FROM room_members WHERE room_id = ? AND kind = 'user' AND ref_id = ?", room.id, userId);
    if (!m || !m.accepted) return null;
    return m.role === 'guest' ? 'guest' : 'member';
  }

  /** Throws 404 when the user may not see the room, 403 when the role is too low. */
  require(roomId: string, userId: string, min: Access = 'guest'): { room: Room; access: Access } {
    const room = this.room(roomId);
    const access = this.access(room, userId);
    if (!room || !access) throw notFound('Groep niet gevonden');
    const rank = { guest: 1, member: 2, owner: 3 } as const;
    if (rank[access] < rank[min]) throw forbidden(min === 'owner' ? 'Alleen de eigenaar van de groep kan dit' : 'Gasten hebben hier geen toegang toe');
    return { room, access };
  }

  limits(room: Room | null, userId?: string): Limits {
    const uid = room?.user_id || userId || '';
    return effectiveLimits(this.ctx.store.getSetting<Partial<Limits>>(uid, SETTINGS_KEY, {}), room?.limits);
  }

  userDefaults(userId: string): Limits {
    return effectiveLimits(this.ctx.store.getSetting<Partial<Limits>>(userId, SETTINGS_KEY, {}));
  }

  setUserDefaults(userId: string, l: any): Limits {
    this.ctx.store.setSetting(userId, SETTINGS_KEY, cleanLimits(l));
    return this.userDefaults(userId);
  }

  /** Main thread + delegation subthreads of a room. */
  threadIds(room: Room): string[] {
    return this.ctx.store.all<{ id: string }>('SELECT id FROM threads WHERE id = ? OR room_id = ?', room.thread_id, room.id).map((r) => r.id);
  }

  // ------------------------------------------------------------------ events & audit helpers

  /** Users that may see the room (owner + accepted people; guests optional). */
  audienceUsers(room: Room, includeGuests = true): string[] {
    const ids = new Set<string>([room.user_id]);
    for (const m of this.humanMembers(room)) if (includeGuests || m.role !== 'guest') ids.add(m.ref_id);
    return [...ids];
  }

  emitChanged(room: Room, extraUsers: string[] = []) {
    for (const uid of new Set([...this.audienceUsers(room), ...extraUsers])) this.ctx.events.emit(uid, 'rooms.changed', { roomId: room.id });
  }

  activity(roomId: string | null | undefined, actor: { type: 'agent' | 'user' | 'system'; id?: string | null; name?: string }, kind: string, summary: string, data: any = {}) {
    if (!roomId) return;
    this.ctx.store.insert('room_activity', {
      room_id: roomId,
      actor_type: actor.type,
      actor_id: actor.id ?? null,
      actor_name: actor.name || (actor.type === 'agent' ? this.agentName(actor.id) : actor.type === 'user' ? this.userName(actor.id) : 'TeamBot'),
      kind,
      summary: summary.slice(0, 500),
      data,
      created_at: now(),
    });
  }

  /** Team inbox entry + push notification for one person. */
  notify(userId: string, o: { roomId?: string | null; kind: string; title: string; body?: string; link?: string; refId?: string | null }) {
    const id = newId('rin_');
    this.ctx.store.insert('room_inbox', { id, user_id: userId, room_id: o.roomId ?? null, kind: o.kind, title: o.title.slice(0, 200), body: (o.body || '').slice(0, 500), link: o.link || '', ref_id: o.refId ?? null, read: false, created_at: now() });
    this.ctx.events.emit(userId, 'notification', { title: o.title, body: (o.body || '').slice(0, 200), link: o.link || '#/m/rooms', kind: 'team' });
    this.ctx.events.emit(userId, 'rooms.inbox', { id });
  }

  event(thread: Thread, text: string, parts: MessageParts = {}) {
    return this.ctx.chat.addEvent(this.ctx.store.thread(thread.id) || thread, text, parts);
  }

  systemMessage(thread: Thread, content: string, parts: MessageParts = {}): Message {
    const m = this.ctx.store.createMessage({ thread_id: thread.id, role: 'system', author_type: 'system', author_name: 'TeamBot', content, parts });
    this.ctx.chat.emitMessage(this.ctx.store.thread(thread.id) || thread, m);
    return m;
  }

  // ------------------------------------------------------------------ rooms CRUD

  create(userId: string, data: any): Room {
    const name = String(data?.name || '').trim().slice(0, 80);
    if (!name) throw bad('Geef de groep een naam');
    const mode: RoomMode = MODES.includes(data?.mode) ? data.mode : 'lead';
    const agentIds: string[] = [...new Set<string>((Array.isArray(data?.agentIds) ? data.agentIds : []).map(String))];
    for (const id of agentIds) {
      const a = this.ctx.store.agent(id);
      if (!a || a.user_id !== userId) throw bad('Onbekende bot in de selectie');
    }
    if (!agentIds.length) throw bad('Kies minstens één bot');
    const lead = data?.leadAgentId && agentIds.includes(data.leadAgentId) ? data.leadAgentId : mode === 'lead' ? agentIds[0] : null;
    const teamId = data?.teamId ? this.ownTeam(userId, data.teamId).id : null;
    // Teams (walls.ts): the group belongs to one team; bots of another team only with access and when allowed.
    const workspace = startTeam(this, userId, { workspaceId: data?.workspaceId, departmentId: teamId, agentIds, leadId: lead });
    const crossTeam = data?.crossTeam === true;
    for (const aid of agentIds) {
      const why = joinRefusal(this, workspace, aid, crossTeam);
      if (why) throw bad(why);
    }
    const id = newId('room_');
    const ts = now();
    const thread = this.ctx.store.createThread({ user_id: userId, agent_id: null, room_id: id, kind: 'room', title: name, meta: { roomId: id, memberUserIds: [] } });
    const room: Room = {
      id,
      user_id: userId,
      thread_id: thread.id,
      team_id: teamId,
      name,
      mode,
      lead_agent_id: lead,
      owner_agent_id: null,
      instructions: String(data?.instructions || '').slice(0, 20_000),
      limits: cleanLimits(data?.limits),
      status: 'active',
      status_reason: '',
      state: {},
      settings: crossTeam ? { crossTeam: true } : {},
      archived: false,
      created_at: ts,
      updated_at: ts,
      workspace_id: workspace,
    };
    this.ctx.store.tx(() => {
      this.ctx.store.insert('rooms', room);
      agentIds.forEach((aid, i) => this.insertBot(room, aid, aid === lead ? 'lead' : 'member', aid === lead ? { files: 'write' } : {}, i));
    });
    const names = agentIds.map((a) => this.agentName(a)).join(', ');
    this.event(thread, `Groep “${name}” aangemaakt met ${names}. Modus: ${modeLabel(mode)}.`, { kind: 'room_created' });
    this.activity(id, { type: 'user', id: userId }, 'room.created', `Groep aangemaakt (${modeLabel(mode)})`, { agentIds, mode });
    this.ctx.audit(userId, 'room.created', { roomId: id, name, agents: agentIds.length, mode });
    this.ctx.events.emit(userId, 'thread.updated', this.ctx.store.thread(thread.id));
    this.emitChanged(room);
    return this.room(id)!;
  }

  private insertBot(room: Room, agentId: string, role: string, perms: Partial<BotPerms>, sort: number) {
    const ts = now();
    this.ctx.store.insert('room_members', { id: newId('rm_'), room_id: room.id, kind: 'agent', ref_id: agentId, role, perms, state: 'idle', state_detail: '', last_run_id: null, paused: false, accepted: true, invited_by: room.user_id, sort, created_at: ts, updated_at: ts });
  }

  update(room: Room, patch: any, byUserId: string): Room {
    const p: Partial<Room> & Record<string, any> = {};
    if (patch.name !== undefined) {
      const n = String(patch.name).trim().slice(0, 80);
      if (!n) throw bad('Naam mag niet leeg zijn');
      p.name = n;
    }
    if (patch.mode !== undefined) {
      if (!MODES.includes(patch.mode)) throw bad('Onbekende modus');
      p.mode = patch.mode;
    }
    if (patch.instructions !== undefined) p.instructions = String(patch.instructions).slice(0, 20_000);
    if (patch.limits !== undefined) p.limits = cleanLimits(patch.limits);
    if (patch.leadAgentId !== undefined) {
      if (patch.leadAgentId && !this.botMember(room, patch.leadAgentId)) throw bad('De lead moet lid van de groep zijn');
      p.lead_agent_id = patch.leadAgentId || null;
      for (const m of this.botMembers(room)) {
        const role = m.ref_id === p.lead_agent_id ? 'lead' : m.role === 'lead' ? 'member' : m.role;
        if (role !== m.role) this.ctx.store.update('room_members', m.id, { role, updated_at: now() });
      }
    }
    if (patch.ownerAgentId !== undefined) {
      if (patch.ownerAgentId && !this.botMember(room, patch.ownerAgentId)) throw bad('De taakeigenaar moet lid van de groep zijn');
      p.owner_agent_id = patch.ownerAgentId || null;
    }
    if (patch.teamId !== undefined) p.team_id = patch.teamId ? this.ownTeam(room.user_id, patch.teamId).id : null;
    if (patch.archived !== undefined) p.archived = !!patch.archived;
    // Teams (walls.ts): the group's team and "Bots van andere teams toestaan", checked against its members.
    const wall = wallPatch(this, room, patch);
    Object.assign(p, wall.set);
    p.updated_at = now();
    this.ctx.store.update('rooms', room.id, p);
    const upd = this.room(room.id)!;
    const tpatch: Partial<Thread> = {};
    if (p.name) tpatch.title = p.name;
    if (p.archived !== undefined) tpatch.archived = p.archived;
    if (Object.keys(tpatch).length) {
      const t = this.ctx.store.updateThread(room.thread_id, tpatch);
      this.ctx.chat.emit(t, 'thread.updated', t);
    }
    if (p.archived) for (const r of this.activeRuns(upd)) this.ctx.runs.cancel(r.id, 'Groep gearchiveerd');
    const th = this.ctx.store.thread(room.thread_id);
    if (th && (p.mode || p.lead_agent_id !== undefined)) this.event(th, `Instellingen gewijzigd: ${modeLabel(upd.mode)}${upd.lead_agent_id ? ` · lead: ${this.agentName(upd.lead_agent_id)}` : ''}.`, { kind: 'room_settings' });
    if (th) for (const n of wall.notes) this.event(th, n, { kind: 'room_team' });
    this.activity(room.id, { type: 'user', id: byUserId }, 'room.updated', `Instellingen gewijzigd: ${Object.keys(patch).join(', ')}`);
    this.ctx.audit(byUserId, 'room.updated', { roomId: room.id, fields: Object.keys(patch) });
    this.emitChanged(upd);
    return upd;
  }

  remove(room: Room, byUserId: string) {
    for (const r of this.activeRuns(room)) this.ctx.runs.cancel(r.id, 'Groep verwijderd');
    const humans = this.audienceUsers(room);
    this.ctx.store.tx(() => {
      for (const tid of this.threadIds(room)) if (tid !== room.thread_id) this.ctx.store.deleteThread(tid);
      if (this.ctx.store.thread(room.thread_id)) this.ctx.store.deleteThread(room.thread_id);
      for (const t of ['room_members', 'room_delegations', 'room_tasks', 'room_proposals', 'room_activity', 'room_inbox']) this.ctx.store.exec(`DELETE FROM ${t} WHERE room_id = ?`, room.id);
      this.ctx.store.remove('rooms', room.id);
    });
    fs.rmSync(this.filesDir(room.id), { recursive: true, force: true });
    this.ctx.audit(byUserId, 'room.deleted', { roomId: room.id, name: room.name });
    for (const uid of humans) {
      this.ctx.events.emit(uid, 'rooms.changed', { roomId: room.id, deleted: true });
      this.ctx.events.emit(uid, 'thread.deleted', { id: room.thread_id });
    }
  }

  filesDir(roomId: string) {
    return path.join(this.ctx.config.dataDir, 'rooms', roomId, 'files');
  }

  // ------------------------------------------------------------------ bots in a room

  addBot(room: Room, agentId: string, o: { role?: string; perms?: any; crossTeam?: boolean } = {}, by?: { type: 'user' | 'agent'; id: string }) {
    const a = this.ctx.store.agent(agentId);
    if (!a || a.user_id !== room.user_id) throw bad('Onbekende bot');
    if (this.botMember(room, agentId)) throw bad(`${a.name} is al lid`);
    // Teams (walls.ts): a bot of another team only with access to the group's team, and only when the owner allows
    // bots of other teams here (`crossTeam` turns that on, visibly, in the same step).
    const why = joinRefusal(this, roomTeam(this, room), agentId, crossTeamOn(room) || o.crossTeam === true);
    if (why) throw bad(why);
    if (o.crossTeam === true && !crossTeamOn(room)) room = this.update(room, { crossTeam: true }, by?.type === 'user' ? by.id : room.user_id);
    const sort = (this.ctx.store.one<{ s: number }>('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM room_members WHERE room_id = ?', room.id)?.s ?? 0) as number;
    this.insertBot(room, agentId, o.role === 'lead' ? 'lead' : 'member', cleanPerms(o.perms), sort);
    if (o.role === 'lead') this.update(room, { leadAgentId: agentId }, room.user_id);
    const th = this.ctx.store.thread(room.thread_id);
    if (th) this.event(th, guestLine(this, room, agentId) || `${a.name} is aan de groep toegevoegd.`, { kind: 'member_added', agentId });
    this.activity(room.id, by ? { type: by.type, id: by.id } : { type: 'user', id: room.user_id }, 'member.added', `${a.name} toegevoegd`, { agentId });
    this.emitChanged(room);
  }

  updateBot(room: Room, agentId: string, patch: any) {
    const m = this.botMember(room, agentId);
    if (!m) throw notFound('Bot is geen lid van deze groep');
    const p: any = { updated_at: now() };
    if (patch.perms !== undefined) p.perms = { ...m.perms, ...cleanPerms(patch.perms) };
    if (patch.sort !== undefined) p.sort = Number(patch.sort) || 0;
    this.ctx.store.update('room_members', m.id, p);
    if (patch.role === 'lead') this.update(room, { leadAgentId: agentId }, room.user_id);
    else if (patch.role === 'member' && room.lead_agent_id === agentId) this.update(room, { leadAgentId: null }, room.user_id);
    this.emitChanged(room);
    return this.botMember(room, agentId)!;
  }

  removeBot(room: Room, agentId: string, reason = 'verwijderd uit de groep') {
    const m = this.botMember(room, agentId);
    if (!m) return;
    for (const r of this.activeRuns(room).filter((r) => r.agent_id === agentId)) this.ctx.runs.cancel(r.id, `Bot ${reason}`);
    this.ctx.store.remove('room_members', m.id);
    const patch: any = {};
    if (room.lead_agent_id === agentId) patch.lead_agent_id = null;
    if (room.owner_agent_id === agentId) patch.owner_agent_id = null;
    if (Object.keys(patch).length) this.ctx.store.update('rooms', room.id, { ...patch, updated_at: now() });
    const th = this.ctx.store.thread(room.thread_id);
    if (th) this.event(th, `${this.agentName(agentId)} is ${reason}.`, { kind: 'member_removed', agentId });
    this.emitChanged(room);
  }

  // ------------------------------------------------------------------ people (human members)

  invite(room: Room, byUserId: string, targetUserId: string, role: HumanRole) {
    const u = this.ctx.store.user(targetUserId);
    if (!u || u.disabled) throw bad('Onbekende gebruiker');
    if (u.id === room.user_id) throw bad('De eigenaar is al lid');
    const existing = this.ctx.store.one<any>("SELECT id FROM room_members WHERE room_id = ? AND kind = 'user' AND ref_id = ?", room.id, u.id);
    if (existing) throw bad(`${u.name} is al uitgenodigd`);
    const ts = now();
    this.ctx.store.insert('room_members', { id: newId('rm_'), room_id: room.id, kind: 'user', ref_id: u.id, role: role === 'guest' ? 'guest' : 'member', perms: {}, state: 'idle', state_detail: '', paused: false, accepted: false, invited_by: byUserId, sort: 0, created_at: ts, updated_at: ts });
    this.notify(u.id, { roomId: room.id, kind: 'invite', title: `${this.userName(byUserId)} nodigt je uit voor “${room.name}”`, body: role === 'guest' ? 'Als gast zie je alleen dit groepsgesprek.' : 'Als lid zie je het gesprek, de taken, bestanden en kosten van deze groep.', link: '#/m/rooms', refId: room.id });
    this.activity(room.id, { type: 'user', id: byUserId }, 'person.invited', `${u.name} uitgenodigd als ${role === 'guest' ? 'gast' : 'lid'}`, { userId: u.id, role });
    this.ctx.audit(byUserId, 'room.invite', { roomId: room.id, userId: u.id, role });
    this.emitChanged(room, [u.id]);
  }

  respondInvite(room: Room, userId: string, accept: boolean) {
    const m = this.ctx.store.one<any>("SELECT * FROM room_members WHERE room_id = ? AND kind = 'user' AND ref_id = ?", room.id, userId);
    if (!m) throw notFound('Geen uitnodiging gevonden');
    if (accept) {
      this.ctx.store.update('room_members', m.id, { accepted: true, updated_at: now() });
      this.syncAudience(room);
      const th = this.ctx.store.thread(room.thread_id);
      if (th) this.event(th, `${this.userName(userId)} doet mee als ${m.role === 'guest' ? 'gast' : 'lid'}.`, { kind: 'person_joined', userId });
      this.notify(room.user_id, { roomId: room.id, kind: 'joined', title: `${this.userName(userId)} doet mee in “${room.name}”`, link: `#/t/${room.thread_id}` });
    } else {
      this.ctx.store.remove('room_members', m.id);
      this.syncAudience(room);
    }
    this.activity(room.id, { type: 'user', id: userId }, accept ? 'person.joined' : 'person.declined', accept ? 'Uitnodiging geaccepteerd' : 'Uitnodiging afgewezen');
    this.emitChanged(room, [userId]);
  }

  setPersonRole(room: Room, userId: string, role: HumanRole) {
    const m = this.ctx.store.one<any>("SELECT * FROM room_members WHERE room_id = ? AND kind = 'user' AND ref_id = ?", room.id, userId);
    if (!m) throw notFound('Persoon is geen lid');
    this.ctx.store.update('room_members', m.id, { role: role === 'guest' ? 'guest' : 'member', updated_at: now() });
    this.syncAudience(room);
    this.ctx.audit(room.user_id, 'room.person_role', { roomId: room.id, userId, role });
    this.emitChanged(room, [userId]);
  }

  removePerson(room: Room, userId: string, by: string) {
    const m = this.ctx.store.one<any>("SELECT * FROM room_members WHERE room_id = ? AND kind = 'user' AND ref_id = ?", room.id, userId);
    if (!m) throw notFound('Persoon is geen lid');
    this.ctx.store.remove('room_members', m.id);
    this.syncAudience(room);
    const th = this.ctx.store.thread(room.thread_id);
    if (th && m.accepted) this.event(th, by === userId ? `${this.userName(userId)} heeft de groep verlaten.` : `${this.userName(userId)} heeft geen toegang meer tot de groep.`, { kind: 'person_left', userId });
    this.ctx.audit(by, by === userId ? 'room.left' : 'room.revoke', { roomId: room.id, userId });
    this.ctx.events.emit(userId, 'rooms.changed', { roomId: room.id, removed: true });
    this.ctx.events.emit(userId, 'thread.deleted', { id: room.thread_id });
    this.emitChanged(room);
  }

  /**
   * Add a person straight away as an accepted member (no invite step) — used when the room owner's directory
   * decides membership, e.g. a SCIM group mapped to this room. A pending invite is accepted instead.
   */
  grantPerson(room: Room, byUserId: string, userId: string): 'added' | 'accepted' | 'already' {
    const u = this.ctx.store.user(userId);
    if (!u || u.disabled) throw bad('Onbekende gebruiker');
    if (u.id === room.user_id) return 'already';
    const m = this.ctx.store.one<any>("SELECT * FROM room_members WHERE room_id = ? AND kind = 'user' AND ref_id = ?", room.id, u.id);
    if (m?.accepted) return 'already';
    if (m) {
      this.respondInvite(room, u.id, true);
      return 'accepted';
    }
    const ts = now();
    this.ctx.store.insert('room_members', { id: newId('rm_'), room_id: room.id, kind: 'user', ref_id: u.id, role: 'member', perms: {}, state: 'idle', state_detail: '', paused: false, accepted: true, invited_by: byUserId, sort: 0, created_at: ts, updated_at: ts });
    this.syncAudience(room);
    const th = this.ctx.store.thread(room.thread_id);
    if (th) this.event(th, `${u.name} doet mee als lid.`, { kind: 'person_joined', userId: u.id });
    this.notify(u.id, { roomId: room.id, kind: 'joined', title: `Je bent toegevoegd aan “${room.name}”`, body: 'Als lid zie je het gesprek, de taken, bestanden en kosten van deze groep.', link: `#/t/${room.thread_id}`, refId: room.id });
    this.activity(room.id, { type: 'user', id: byUserId }, 'person.added', `${u.name} toegevoegd als lid`, { userId: u.id });
    this.ctx.audit(byUserId, 'room.person_added', { roomId: room.id, userId: u.id });
    this.emitChanged(room, [u.id]);
    return 'added';
  }

  /** Keep thread.meta.memberUserIds (the core visibility + live-event list) in sync with the ACL. */
  syncAudience(room: Room) {
    const all = this.humanMembers(room).map((m) => m.ref_id);
    const full = this.humanMembers(room).filter((m) => m.role !== 'guest').map((m) => m.ref_id);
    for (const tid of this.threadIds(room)) {
      const t = this.ctx.store.thread(tid);
      if (!t) continue;
      this.ctx.store.update('threads', t.id, { meta: { ...t.meta, memberUserIds: tid === room.thread_id ? all : full } });
    }
  }

  // ------------------------------------------------------------------ ledger & limits

  activeRuns(room: Room): Run[] {
    const ids = this.threadIds(room);
    if (!ids.length) return [];
    return this.ctx.store
      .all<any>(`SELECT * FROM runs WHERE thread_id IN (${ids.map(() => '?').join(',')}) AND status IN ('queued','running','waiting') ORDER BY created_at`, ...ids)
      .map((r) => this.ctx.store.decode<Run>('runs', r));
  }

  /** Tokens and cost per bot for everything that ran in the room (incl. delegated subtasks). */
  ledger(room: Room) {
    const rows = this.ctx.store.all<any>(
      `SELECT r.agent_id, COUNT(*) AS runs,
              COALESCE(SUM(json_extract(r.usage,'$.input')),0) AS input, COALESCE(SUM(json_extract(r.usage,'$.output')),0) AS output,
              COALESCE(SUM(json_extract(r.usage,'$.cost')),0) AS cost,
              SUM(CASE WHEN r.status = 'error' THEN 1 ELSE 0 END) AS errors
         FROM runs r JOIN threads t ON t.id = r.thread_id WHERE t.room_id = ? GROUP BY r.agent_id ORDER BY cost DESC, input DESC`,
      room.id,
    );
    const bots = rows.map((r) => ({ agentId: r.agent_id, name: this.agentName(r.agent_id), member: !!this.botMember(room, r.agent_id), runs: r.runs, input: r.input, output: r.output, tokens: r.input + r.output, cost: Math.round(r.cost * 1e6) / 1e6, errors: r.errors }));
    const total = bots.reduce((a, b) => ({ input: a.input + b.input, output: a.output + b.output, tokens: a.tokens + b.tokens, cost: a.cost + b.cost, runs: a.runs + b.runs }), { input: 0, output: 0, tokens: 0, cost: 0, runs: 0 });
    const l = this.limits(room);
    return { bots, total: { ...total, cost: Math.round(total.cost * 1e6) / 1e6 }, caps: { maxCostUsd: l.maxCostUsd, maxTokens: l.maxTokens } };
  }

  overBudget(room: Room): string | null {
    const l = this.limits(room);
    if (!l.maxCostUsd && !l.maxTokens) return null;
    const t = this.ledger(room).total;
    const locale = userLocale(this.ctx.store, room.user_id);
    if (l.maxCostUsd && t.cost >= l.maxCostUsd) return `Kostenplafond van de groep bereikt (${usdText(t.cost)} van ${usdText(l.maxCostUsd)}). Verhoog het plafond in de groepsinstellingen om verder te gaan.`;
    if (l.maxTokens && t.tokens >= l.maxTokens) return `Tokenplafond van de groep bereikt (${t.tokens.toLocaleString(locale)} van ${l.maxTokens.toLocaleString(locale)} tokens). Verhoog het plafond in de groepsinstellingen om verder te gaan.`;
    return null;
  }

  /** Runs that already belong to a chain (turn cap per human message). */
  turnsUsed(userId: string, chain: TeamMeta): number {
    const n = this.ctx.store.one<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE user_id = ? AND json_extract(meta, '$.team.chainId') = ?", userId, chain.chainId)?.n ?? 0;
    return n + (chain.untracked ? 1 : 0);
  }

  /** Why a new bot turn may not start right now (null = allowed). */
  gate(o: { room: Room | null; userId: string; agentId: string; chain: TeamMeta; needMember: boolean; extra?: number; turnCap?: number }): string | null {
    const { room } = o;
    const a = this.ctx.store.agent(o.agentId);
    if (!a || a.archived) return 'Deze bot bestaat niet (meer) of is gearchiveerd.';
    if (room) {
      if (room.archived) return 'Deze groep is gearchiveerd.';
      if (room.status === 'paused') return `De groep is gepauzeerd${room.status_reason ? ` (${room.status_reason})` : ''}. Hervat de groep om verder te gaan.`;
      const m = this.botMember(room, o.agentId);
      if (o.needMember && !m) return `${a.name} is geen lid van deze groep.`;
      if (m?.paused) return `${a.name} is gepauzeerd in deze groep.`;
      const b = this.overBudget(room);
      if (b) return b;
    }
    const l = this.limits(room, o.userId);
    const used = this.turnsUsed(o.userId, o.chain);
    const cap = this.turnCap(l, o.chain, o.turnCap);
    if (used + (o.extra ?? 1) > cap) return `Maximum van ${cap} botbeurten voor dit bericht bereikt. Stuur een nieuw bericht om verder te gaan (of verhoog de limiet).`;
    return null;
  }

  /** Turn cap of a chain: chains with asynchronous bot messages (ask_bot) get their own, larger cap. */
  turnCap(l: Limits, chain: TeamMeta | undefined, explicit?: number): number {
    return explicit ?? (chain?.async ? Math.max(l.maxAskTurns, l.maxTurnsPerMessage) : l.maxTurnsPerMessage);
  }

  /** Start one bot turn in a room thread (or subthread) after checking every limit. */
  dispatch(room: Room | null, thread: Thread, agentId: string, o: { inputMessageId: string | null; meta: TeamMeta; viaChat?: boolean; trigger?: string; silent?: boolean }): DispatchResult {
    const needMember = !!room && thread.id === room.thread_id;
    // Teams (walls.ts): a member that may no longer be in this team's group sits out (not for delegation subthreads:
    // those see only their task, and giving that task already needed aansturen).
    const wall = room && thread.kind !== 'delegation' ? memberRefusal(this, room, agentId) : null;
    const refused = wall || this.gate({ room, userId: thread.user_id, agentId, chain: o.meta, needMember });
    if (refused) {
      if (!o.silent) this.event(thread, refused, { kind: 'room_limit', agentId });
      if (room) this.activity(room.id, { type: 'system' }, 'limit', refused, { agentId, chainId: o.meta.chainId });
      return { refused };
    }
    const meta = { team: { ...o.meta, roomId: room?.id ?? null } };
    const trigger = o.trigger || `team:${o.meta.kind}`;
    const run = o.viaChat ? this.ctx.chat.startAgent(thread, agentId, o.inputMessageId, trigger, meta) : this.ctx.runs.enqueue({ threadId: thread.id, agentId, userId: thread.user_id, trigger, inputMessageId: o.inputMessageId, meta });
    if (!run) return { refused: 'Bot niet gevonden' };
    if (room) this.refreshState(room, agentId);
    return { run };
  }

  /** Dispatch the first available bot of an "om de beurt" queue; the rest follows when it finishes. */
  sequence(room: Room, thread: Thread, queue: string[], inputMessageId: string | null, base: Omit<TeamMeta, 'path' | 'next'>, prefix: string[], viaChat = false) {
    const skipped: string[] = [];
    let q = [...queue];
    while (q.length) {
      const [agentId, ...rest] = q;
      const m = this.botMember(room, agentId);
      if (!m || m.paused) {
        skipped.push(agentId);
        q = rest;
        continue;
      }
      if (skipped.length) this.event(thread, `Overgeslagen (gepauzeerd): ${skipped.map((s) => this.agentName(s)).join(', ')}.`, { kind: 'room_skip' });
      this.dispatch(room, thread, agentId, { inputMessageId, meta: { ...base, path: [...prefix, agentId], next: rest }, viaChat });
      return;
    }
    if (skipped.length) this.event(thread, `Overgeslagen (gepauzeerd): ${skipped.map((s) => this.agentName(s)).join(', ')}.`, { kind: 'room_skip' });
  }

  // ------------------------------------------------------------------ routing of a new human message

  onHumanMessage(room: Room, thread: Thread, m: Message) {
    if (room.archived) {
      this.event(thread, 'Deze groep is gearchiveerd; bots reageren niet meer. Haal hem uit het archief om verder te gaan.', { kind: 'room_archived' });
      return;
    }
    if (room.status === 'paused') {
      this.event(thread, `De groep is gepauzeerd${room.status_reason ? ` (${room.status_reason})` : ''}. Je bericht is opgeslagen; hervat de groep om de bots te laten reageren.`, { kind: 'room_paused' });
      return;
    }
    const bots = this.botMembers(room);
    const humans = this.humanMembers(room);
    const people: Named[] = [
      ...bots.map((b) => ({ id: b.ref_id, name: this.agentName(b.ref_id) })),
      ...humans.map((h) => ({ id: 'user:' + h.ref_id, name: this.userName(h.ref_id) })),
      { id: 'user:' + room.user_id, name: this.userName(room.user_id) },
    ];
    const men = findMentions(m.content, people, { leading: true });
    this.notifyMentionedHumans(room, thread, m, men.ids.filter((x) => x.startsWith('user:')).map((x) => x.slice(5)), m.author_id);
    const botIds = bots.map((b) => b.ref_id);
    const auto = bots.filter((b) => this.perms(b).respond === 'auto').map((b) => b.ref_id);
    let targets: string[] = [];
    let sequential = false;
    let reason: TeamMeta['kind'] = 'turn';
    if (men.all) {
      targets = botIds;
      sequential = room.mode === 'round_robin';
    } else if (men.ids.some((x) => botIds.includes(x))) {
      targets = men.ids.filter((x) => botIds.includes(x));
      sequential = room.mode === 'round_robin';
    } else if (m.reply_to) {
      const parent = this.ctx.store.message(m.reply_to);
      if (parent && parent.thread_id === thread.id && parent.author_type === 'agent' && parent.author_id && botIds.includes(parent.author_id)) targets = [parent.author_id];
    }
    if (!targets.length && !men.ids.length) {
      switch (room.mode) {
        case 'lead': {
          const lead = [room.owner_agent_id, room.lead_agent_id].find((x) => x && botIds.includes(x)) || auto[0] || botIds[0];
          targets = lead ? [lead] : [];
          break;
        }
        case 'round_robin':
          targets = auto;
          sequential = true;
          break;
        case 'everyone':
          targets = auto;
          break;
        case 'mention':
          this.event(thread, 'Niemand aangesproken. Gebruik @naam, @iedereen of beantwoord een bericht van een bot.', { kind: 'room_hint' });
          return;
      }
    }
    if (!targets.length) {
      if (!men.ids.length) this.event(thread, 'Er is geen actieve bot in deze groep om te antwoorden.', { kind: 'room_hint' });
      return;
    }
    const base = { chainId: m.id, handoffs: 0, kind: reason, requestedBy: m.author_type === 'user' ? m.author_id : null } as const;
    if (sequential) this.sequence(room, thread, targets, m.id, base, [], true);
    else
      for (const t of targets) {
        const mem = this.botMember(room, t);
        if (mem?.paused) {
          this.event(thread, `${this.agentName(t)} is gepauzeerd en reageert niet.`, { kind: 'room_skip', agentId: t });
          continue;
        }
        const r = this.dispatch(room, thread, t, { inputMessageId: m.id, meta: { ...base, path: [t] }, viaChat: true });
        if (r.refused && /Maximum|plafond|gepauzeerd/.test(r.refused)) break;
      }
  }

  private notifyMentionedHumans(room: Room, thread: Thread, m: Message, userIds: string[], authorId: string | null) {
    for (const uid of new Set(userIds)) {
      if (uid === authorId) continue;
      if (uid !== room.user_id && !this.access(room, uid)) continue;
      this.notify(uid, { roomId: room.id, kind: 'mention', title: `${m.author_name} noemde je in “${room.name}”`, body: m.content.slice(0, 300), link: `#/t/${thread.id}`, refId: m.id });
    }
  }

  /** After a bot finished in the room: wake bots it @mentioned (bounded by caps and cycle detection). */
  private chainMentions(room: Room, thread: Thread, run: Run, team: TeamMeta | undefined) {
    const l = this.limits(room);
    if (!l.allowBotMentions) return;
    const msgs = this.ctx.store.all<any>("SELECT id, content FROM messages WHERE run_id = ? AND role = 'assistant' AND deleted = 0 AND content != '' ORDER BY seq", run.id);
    if (!msgs.length) return;
    const text = msgs.map((x) => x.content).join('\n');
    const bots = this.botMembers(room).filter((b) => b.ref_id !== run.agent_id);
    const humans = this.humanMembers(room);
    const people: Named[] = [
      ...bots.map((b) => ({ id: b.ref_id, name: this.agentName(b.ref_id) })),
      ...humans.map((h) => ({ id: 'user:' + h.ref_id, name: this.userName(h.ref_id) })),
      { id: 'user:' + room.user_id, name: this.userName(room.user_id) },
    ];
    const men = findMentions(text, people);
    const fake = { ...(msgs.at(-1) as any), author_name: this.agentName(run.agent_id), content: text } as Message;
    this.notifyMentionedHumans(room, thread, fake, men.ids.filter((x) => x.startsWith('user:')).map((x) => x.slice(5)), null);
    let targets = men.all ? bots.map((b) => b.ref_id) : men.ids.filter((x) => !x.startsWith('user:'));
    targets = targets.filter((x) => x !== run.agent_id);
    if (!targets.length) return;
    const path = team?.path?.length ? team.path : [run.agent_id];
    const blocked = targets.filter((x) => path.includes(x));
    if (blocked.length)
      this.event(thread, `Lus voorkomen: ${blocked.map((b) => this.agentName(b)).join(', ')} wordt niet opnieuw geactiveerd door ${this.agentName(run.agent_id)} (keten ${path.map((p) => this.agentName(p)).join(' → ')}).`, { kind: 'room_cycle' });
    targets = targets.filter((x) => !path.includes(x));
    if (!targets.length) return;
    const base = { chainId: team?.chainId || run.input_message_id || run.id, handoffs: team?.handoffs ?? 0, kind: 'mention' as const, requestedBy: team?.requestedBy ?? null };
    const input = msgs.at(-1)!.id;
    if (room.mode === 'round_robin') this.sequence(room, thread, targets, input, base, path);
    else for (const t of targets) this.dispatch(room, thread, t, { inputMessageId: input, meta: { ...base, path: [...path, t] } });
  }

  // ------------------------------------------------------------------ participant state machine

  /**
   * idle → queued → running ⇄ waiting → idle | error | timeout; paused overrides everything until resumed.
   * Derived from the durable runs table, so it is correct after restarts and for runs started elsewhere.
   */
  refreshState(room: Room, agentId: string) {
    const m = this.botMember(room, agentId);
    if (!m) return;
    const ids = this.threadIds(room);
    const q = ids.map(() => '?').join(',');
    const active = this.ctx.store.all<any>(`SELECT id, status FROM runs WHERE agent_id = ? AND thread_id IN (${q}) AND status IN ('queued','running','waiting') ORDER BY created_at DESC`, agentId, ...ids);
    let state: MemberState = 'idle';
    let detail = '';
    let lastRun = m.last_run_id;
    if (m.paused) state = 'paused';
    else if (active.some((r) => r.status === 'waiting')) (state = 'waiting'), (detail = 'Wacht op een mens (goedkeuring of vraag)');
    else if (active.some((r) => r.status === 'running')) state = 'running';
    else if (active.length) state = 'queued';
    if (active.length) lastRun = active[0].id;
    if (!m.paused && !active.length) {
      const last = this.ctx.store.one<any>(`SELECT id, status, error, json_extract(meta, '$.budget.resetAt') AS budget_until FROM runs WHERE agent_id = ? AND thread_id IN (${q}) ORDER BY created_at DESC LIMIT 1`, agentId, ...ids);
      if (last) {
        lastRun = last.id;
        // Stopped by the daily budget: "daglimiet bereikt" with the stop text (when, where to raise it), until the new day.
        if (last.status === 'error' && last.budget_until) {
          if (Date.parse(last.budget_until) > Date.now()) (state = 'limit'), (detail = String(last.error || '').slice(0, 300));
        } else if (last.status === 'error' || last.status === 'interrupted') (state = 'error'), (detail = String(last.error || 'Fout').slice(0, 300));
        else if (last.status === 'cancelled' && (this.timedOut.has(last.id) || /^Time-out/.test(last.error || ''))) (state = 'timeout'), (detail = String(last.error || 'Time-out'));
      }
    }
    if (state !== m.state || detail !== m.state_detail || lastRun !== m.last_run_id) {
      this.ctx.store.update('room_members', m.id, { state, state_detail: detail, last_run_id: lastRun, updated_at: now() });
      const payload = { roomId: room.id, agentId, state, detail, runId: lastRun };
      for (const uid of this.audienceUsers(room)) this.ctx.events.emit(uid, 'rooms.member', payload);
    }
  }

  private armTimeout(run: Run, room: Room | null) {
    if (this.timers.has(run.id)) return;
    const team = run.meta?.team as TeamMeta | undefined;
    // A bot message answered in the recipient's own chat is a normal turn of that bot (no room time-out).
    if (team?.kind === 'ask' && !room) return;
    const l = this.limits(room, run.user_id);
    const sec = team?.delegationId ? l.delegationTimeoutSec : l.turnTimeoutSec;
    const fire = () => {
      const cur = this.ctx.store.run(run.id);
      if (!cur || TERMINAL_RUN.has(cur.status)) return void this.timers.delete(run.id);
      if (cur.status === 'waiting') {
        // Time spent waiting for a human does not count: the clock restarts.
        this.timers.set(run.id, setTimeout(fire, sec * 1000).unref());
        return;
      }
      this.timers.delete(run.id);
      this.timedOut.set(run.id, true);
      this.ctx.runs.cancel(run.id, `Time-out: ${this.agentName(cur.agent_id)} gaf binnen ${sec} s geen resultaat`);
    };
    this.timers.set(run.id, setTimeout(fire, sec * 1000).unref());
  }

  // ------------------------------------------------------------------ live event handlers

  subscribe() {
    const ev = this.ctx.events;
    this.unsub.push(ev.on('run.updated', (e) => this.safe(() => this.onRunEvent(e.data as Run))));
    this.unsub.push(ev.on('message.created', (e) => this.safe(() => this.onMessageEvent(e.data as Message, 'created'))));
    this.unsub.push(ev.on('message.updated', (e) => this.safe(() => this.onMessageEvent(e.data as Message, 'updated'))));
    this.unsub.push(ev.on('approval.created', (e) => this.safe(() => this.onApproval(e.data))));
  }

  unsubscribe() {
    for (const u of this.unsub) u();
    this.unsub = [];
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private safe(fn: () => void) {
    try {
      fn();
    } catch (e) {
      this.ctx.log.error('[rooms]', e);
    }
  }

  private onRunEvent(r: Run) {
    if (!r?.id || this.seenRun.get(r.id) === r.status) return;
    this.seenRun.set(r.id, r.status);
    const run = this.ctx.store.run(r.id);
    if (!run) return;
    const thread = this.ctx.store.thread(run.thread_id);
    if (!thread) return;
    const team = run.meta?.team as TeamMeta | undefined;
    const room = this.roomForThread(thread);
    if (!room && !team) {
      // Any bot that finishes a turn may have held answers (ask_bot), incoming bot messages, or (when stopped) bot
      // messages it sent in that turn to withdraw.
      if (!ACTIVE_RUN.has(run.status)) setImmediate(() => this.onTerminal(run.id).catch((e) => this.ctx.log.error('[rooms] terminal', e)));
      return;
    }
    if (ACTIVE_RUN.has(run.status)) {
      if (room && run.status !== 'waiting') {
        const why = this.enforce(room, thread, run);
        if (why) {
          queueMicrotask(() => this.ctx.runs.cancel(run.id, why));
          return;
        }
      }
      if (run.status === 'running') this.armTimeout(run, room);
      if (room) this.refreshState(room, run.agent_id);
      if (team?.delegationId) this.orch.markRunning(team.delegationId, run);
      return;
    }
    const t = this.timers.get(run.id);
    if (t) clearTimeout(t), this.timers.delete(run.id);
    setImmediate(() => this.onTerminal(run.id).catch((e) => this.ctx.log.error('[rooms] terminal', e)));
  }

  /** Safety net for runs started outside our dispatcher (retry/resume buttons, other modules). */
  private enforce(room: Room, thread: Thread, run: Run): string | null {
    if (room.archived) return 'Gestopt: de groep is gearchiveerd';
    if (room.status === 'paused') return 'Gestopt: de groep is gepauzeerd';
    const m = this.botMember(room, run.agent_id);
    if (thread.id === room.thread_id && !m) return `Gestopt: ${this.agentName(run.agent_id)} is geen lid van deze groep`;
    if (m?.paused) return `Gestopt: ${this.agentName(run.agent_id)} is gepauzeerd in deze groep`;
    const b = this.overBudget(room);
    if (b) {
      queueMicrotask(() => this.stopRoom(room, null, 'kostenplafond bereikt', b));
      return 'Gestopt: kostenplafond van de groep bereikt';
    }
    return null;
  }

  private async onTerminal(runId: string) {
    const run = this.ctx.store.run(runId);
    if (!run) return;
    const thread = this.ctx.store.thread(run.thread_id);
    if (!thread) return;
    const room = this.roomForThread(thread);
    const team = run.meta?.team as TeamMeta | undefined;
    if (room) {
      this.refreshState(room, run.agent_id);
      const label = run.status === 'done' ? 'klaar' : run.status === 'cancelled' ? (this.timedOut.has(run.id) ? 'time-out' : 'gestopt') : 'fout';
      this.activity(room.id, { type: 'agent', id: run.agent_id }, 'turn.end', `Beurt ${label}${thread.id !== room.thread_id ? ` (subtaak: ${thread.title})` : ''}`, { runId: run.id, threadId: thread.id, status: run.status, usage: run.usage, error: run.error });
    }
    await this.orch.onRunTerminal(run, thread, room);
    if (room && thread.id === room.thread_id) {
      const fresh = this.room(room.id)!;
      if (run.status === 'done' && !fresh.archived && fresh.status === 'active') this.chainMentions(fresh, thread, run, team);
      if (team?.next?.length) {
        const timedOut = this.timedOut.has(run.id) || /^Time-out/.test(run.error || '');
        const halted = fresh.archived || fresh.status === 'paused' || (run.status === 'cancelled' && !timedOut && !this.memberStopped.has(run.id));
        if (halted) {
          if (fresh.status === 'active' && !fresh.archived) this.event(thread, team.next.length === 1 ? `Beurtvolgorde gestopt; ${this.agentName(team.next[0])} komt niet meer aan de beurt.` : `Beurtvolgorde gestopt; ${team.next.map((n) => this.agentName(n)).join(', ')} komen niet meer aan de beurt.`, { kind: 'room_sequence_stopped' });
        } else {
          if (run.status === 'error' || run.status === 'interrupted' || timedOut)
            this.event(thread, `${this.agentName(run.agent_id)} ${timedOut ? 'reageerde niet op tijd' : 'liep tegen een fout aan'}; de volgende bot is aan de beurt.`, { kind: 'room_turn_failed', agentId: run.agent_id });
          this.sequence(fresh, thread, team.next, run.input_message_id, { chainId: team.chainId, handoffs: team.handoffs, kind: 'sequence', requestedBy: team.requestedBy }, []);
        }
      }
    }
    this.orch.onIdle(run.thread_id, run.agent_id);
  }

  private onMessageEvent(m: Message, type: 'created' | 'updated') {
    if (!m?.run_id || m.role !== 'assistant') return;
    const key = `${type}:${m.id}:${m.status}`;
    if (this.seenMsg.has(key)) return;
    this.seenMsg.set(key, true);
    const thread = this.ctx.store.thread(m.thread_id);
    const room = this.roomForThread(thread);
    if (!room || !thread) return;
    if (type === 'created') {
      const l = this.limits(room);
      const steps = this.ctx.store.one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE run_id = ? AND role = 'assistant'", m.run_id)?.n ?? 0;
      if (steps > l.maxStepsPerTurn) {
        const run = this.ctx.store.run(m.run_id);
        if (run && ACTIVE_RUN.has(run.status)) {
          this.ctx.runs.cancel(run.id, l.maxStepsPerTurn === 1 ? 'Maximum van 1 stap per beurt in deze groep bereikt' : `Maximum van ${l.maxStepsPerTurn} stappen per beurt in deze groep bereikt`);
          this.event(thread, l.maxStepsPerTurn === 1 ? `${this.agentName(run.agent_id)} is gestopt: maximum van 1 stap per beurt bereikt.` : `${this.agentName(run.agent_id)} is gestopt: maximum van ${l.maxStepsPerTurn} stappen per beurt bereikt.`, { kind: 'room_limit', agentId: run.agent_id });
        }
      }
    } else if (m.status === 'done' && m.usage) {
      const fresh = this.room(room.id)!;
      if (fresh.status !== 'active') return;
      const b = this.overBudget(fresh);
      if (b) this.stopRoom(fresh, null, 'kostenplafond bereikt', b);
    }
  }

  /** Approvals always go to the bot owner; tell the person who asked that the bot is waiting for them. */
  private onApproval(a: any) {
    if (!a?.thread_id || !a.run_id) return;
    const thread = this.ctx.store.thread(a.thread_id);
    const room = this.roomForThread(thread);
    if (!room) return;
    const run = this.ctx.store.run(a.run_id);
    const team = run?.meta?.team as TeamMeta | undefined;
    const who = team?.requestedBy;
    this.activity(room.id, { type: 'agent', id: a.agent_id }, a.kind === 'question' ? 'question' : 'approval', `${a.kind === 'question' ? 'Vraag' : 'Toestemming gevraagd'}: ${a.summary}`, { approvalId: a.id });
    if (who && who !== room.user_id && this.access(room, who)) {
      this.notify(who, {
        roomId: room.id,
        kind: 'approval_wait',
        title: `${this.agentName(a.agent_id)} wacht op ${this.userName(room.user_id)}`,
        body: `${a.kind === 'question' ? 'Vraag' : 'Goedkeuring nodig'}: ${String(a.summary).slice(0, 200)} — alleen de eigenaar van de bot kan dit beantwoorden.`,
        link: `#/t/${room.thread_id}`,
        refId: a.id,
      });
    }
  }

  // ------------------------------------------------------------------ stop / resume

  stopRoom(room: Room, byUserId: string | null, reason: string, detail?: string): number {
    const runs = this.activeRuns(room);
    const stoppedAgents = [...new Set(runs.filter((r) => r.thread_id === room.thread_id).map((r) => r.agent_id))];
    this.ctx.store.update('rooms', room.id, { status: 'paused', status_reason: reason, state: { ...(room.state || {}), stoppedAgents }, updated_at: now() });
    for (const r of runs) this.ctx.runs.cancel(r.id, `Groep gestopt: ${reason}`);
    const th = this.ctx.store.thread(room.thread_id);
    const stopped = runs.length === 1 ? '1 lopende beurt afgebroken. ' : runs.length ? `${runs.length} lopende beurten afgebroken. ` : '';
    const line = byUserId ? `Groep gestopt door ${this.userName(byUserId)} (${reason}). ${stopped}Hervat de groep om verder te gaan.` : `Groep gestopt (${reason}). ${stopped}Hervat de groep om verder te gaan.`;
    if (th) this.event(th, detail || line, { kind: 'room_stopped' });
    this.activity(room.id, byUserId ? { type: 'user', id: byUserId } : { type: 'system' }, 'room.stopped', `Groep gestopt: ${reason}`, { runs: runs.length });
    this.ctx.audit(byUserId || room.user_id, 'room.stopped', { roomId: room.id, reason, runs: runs.length });
    if (!byUserId) this.notify(room.user_id, { roomId: room.id, kind: 'stopped', title: `Groep “${room.name}” is gestopt`, body: detail || reason, link: `#/m/rooms/room/${room.id}` });
    for (const b of this.botMembers(room)) this.refreshState(this.room(room.id)!, b.ref_id);
    this.emitChanged(room);
    return runs.length;
  }

  resumeRoom(room: Room, byUserId: string, cont: boolean) {
    const stopped = room.state?.stoppedAgents || [];
    this.ctx.store.update('rooms', room.id, { status: 'active', status_reason: '', state: { ...(room.state || {}), stoppedAgents: [] }, updated_at: now() });
    const fresh = this.room(room.id)!;
    const th = this.ctx.store.thread(room.thread_id)!;
    const over = this.overBudget(fresh);
    this.event(th, `Groep hervat door ${this.userName(byUserId)}.${over ? ' Let op: ' + over : ''}`, { kind: 'room_resumed' });
    this.activity(room.id, { type: 'user', id: byUserId }, 'room.resumed', 'Groep hervat');
    let started = 0;
    if (cont && stopped.length && !over) {
      const sys = this.systemMessage(th, 'De groep is hervat. Ga verder waar je gebleven was; controleer eerst wat al gedaan is voordat je acties herhaalt.', { kind: 'room_resume' });
      for (const a of stopped) if (this.dispatch(fresh, th, a, { inputMessageId: sys.id, meta: { chainId: sys.id, path: [a], handoffs: 0, kind: 'resume', requestedBy: byUserId } }).run) started++;
    }
    for (const b of this.botMembers(fresh)) this.refreshState(fresh, b.ref_id);
    this.emitChanged(fresh);
    return { started };
  }

  stopBot(room: Room, agentId: string, byUserId: string) {
    const m = this.botMember(room, agentId);
    if (!m) throw notFound('Bot is geen lid van deze groep');
    this.ctx.store.update('room_members', m.id, { paused: true, updated_at: now() });
    let n = 0;
    for (const r of this.activeRuns(room).filter((r) => r.agent_id === agentId)) {
      this.memberStopped.set(r.id, true);
      if (this.ctx.runs.cancel(r.id, `${this.agentName(agentId)} gepauzeerd door ${this.userName(byUserId)}`)) n++;
    }
    const th = this.ctx.store.thread(room.thread_id);
    if (th) this.event(th, `${this.agentName(agentId)} is gepauzeerd door ${this.userName(byUserId)}${n ? ' (lopende beurt afgebroken)' : ''}.`, { kind: 'member_paused', agentId });
    this.activity(room.id, { type: 'user', id: byUserId }, 'member.paused', `${this.agentName(agentId)} gepauzeerd`, { agentId, runs: n });
    this.refreshState(room, agentId);
    this.emitChanged(room);
    return n;
  }

  resumeBot(room: Room, agentId: string, byUserId: string, cont: boolean) {
    const m = this.botMember(room, agentId);
    if (!m) throw notFound('Bot is geen lid van deze groep');
    this.ctx.store.update('room_members', m.id, { paused: false, updated_at: now() });
    const th = this.ctx.store.thread(room.thread_id)!;
    this.event(th, `${this.agentName(agentId)} is hervat door ${this.userName(byUserId)}.`, { kind: 'member_resumed', agentId });
    this.activity(room.id, { type: 'user', id: byUserId }, 'member.resumed', `${this.agentName(agentId)} hervat`, { agentId });
    let run: Run | undefined;
    if (cont) {
      const sys = this.systemMessage(th, `${this.agentName(agentId)}, je bent hervat. Ga verder waar je gebleven was; controleer eerst wat al gedaan is.`, { kind: 'member_resume', agentId });
      run = this.dispatch(this.room(room.id)!, th, agentId, { inputMessageId: sys.id, meta: { chainId: sys.id, path: [agentId], handoffs: 0, kind: 'resume', requestedBy: byUserId } }).run;
    }
    this.refreshState(this.room(room.id)!, agentId);
    this.emitChanged(room);
    return { run };
  }

  /** After a restart: member states and open delegations are reconciled with the durable run table. */
  reconcile() {
    for (const r of this.ctx.store.all<any>("SELECT * FROM rooms WHERE archived = 0")) {
      const room = this.ctx.store.decode<Room>('rooms', r);
      for (const b of this.botMembers(room)) this.refreshState(room, b.ref_id);
    }
    this.orch.reconcile();
  }

  // ------------------------------------------------------------------ teams helper used by rooms

  ownTeam(userId: string, teamId: string) {
    const t = this.ctx.store.get<any>('room_teams', teamId);
    if (!t || t.user_id !== userId) throw bad('Onbekend team');
    return t;
  }

  // ------------------------------------------------------------------ views

  memberView(room: Room, m: Member) {
    if (m.kind === 'agent') {
      const a = this.ctx.store.agent(m.ref_id);
      return {
        id: m.id,
        kind: 'agent' as const,
        agentId: m.ref_id,
        name: a?.name || 'Verwijderde bot',
        avatar: a?.avatar || '',
        color: a?.color || '#6366f1',
        title: a?.role || '',
        model: a?.model || '',
        accessMode: a?.access_mode || 'chat',
        role: m.role,
        lead: room.lead_agent_id === m.ref_id,
        owner: room.owner_agent_id === m.ref_id,
        perms: this.perms(m),
        state: m.state,
        stateDetail: m.state_detail,
        lastRunId: m.last_run_id,
        paused: m.paused,
        // Teams: home team and reach in the group's team (home / direct / read / none).
        ...memberTeamView(this, room, m.ref_id),
      };
    }
    const u = this.ctx.store.user(m.ref_id);
    return { id: m.id, kind: 'user' as const, userId: m.ref_id, name: u?.name || 'Onbekend', role: m.role, accepted: m.accepted, invitedBy: m.invited_by };
  }

  view(room: Room, userId: string) {
    const access = this.access(room, userId);
    const members = this.members(room.id).filter((m) => m.kind === 'agent' || access !== 'guest' || m.accepted);
    const last = this.ctx.store.lastMessage(room.thread_id);
    const base = {
      id: room.id,
      thread_id: room.thread_id,
      name: room.name,
      mode: room.mode,
      modeLabel: modeLabel(room.mode),
      status: room.status,
      status_reason: room.status_reason,
      archived: room.archived,
      lead_agent_id: room.lead_agent_id,
      owner_agent_id: room.owner_agent_id,
      team_id: access === 'guest' ? null : room.team_id,
      // Teams: the team this group belongs to and whether bots of other teams take part (visible, never silent).
      ...(access === 'guest' ? {} : roomTeamView(this, room)),
      owner: { id: room.user_id, name: this.userName(room.user_id) },
      access,
      bots: members.filter((m) => m.kind === 'agent').map((m) => this.memberView(room, m)),
      people: members.filter((m) => m.kind === 'user').map((m) => this.memberView(room, m)),
      last: last ? { content: last.content.slice(0, 140), author_name: last.author_name, created_at: last.created_at } : null,
      created_at: room.created_at,
      updated_at: room.updated_at,
    };
    if (access === 'guest') return base;
    return {
      ...base,
      instructions: room.instructions,
      limits: this.limits(room),
      roomLimits: room.limits,
      defaults: DEFAULT_LIMITS,
      ledger: this.ledger(room),
      activeRuns: this.activeRuns(room).map((r) => ({ id: r.id, agentId: r.agent_id, threadId: r.thread_id, status: r.status, kind: r.meta?.team?.kind || r.trigger })),
    };
  }

  list(userId: string, opts: { archived?: boolean; team?: string | null } = {}) {
    let own = this.ctx.store.all<any>(`SELECT * FROM rooms WHERE user_id = ? ${opts.archived ? '' : 'AND archived = 0'} ORDER BY updated_at DESC`, userId);
    // Teams: only the groups of one team (the owner's team filter).
    if (opts.team) own = own.filter((r) => roomTeam(this, this.ctx.store.decode<Room>('rooms', r)) === opts.team);
    const shared = this.ctx.store.all<any>(
      `SELECT r.*, m.accepted AS _accepted, m.role AS _role FROM rooms r JOIN room_members m ON m.room_id = r.id AND m.kind = 'user' AND m.ref_id = ? ${opts.archived ? '' : 'AND r.archived = 0'} ORDER BY r.updated_at DESC`,
      userId,
    );
    const out: any[] = own.map((r) => this.view(this.ctx.store.decode<Room>('rooms', r), userId));
    for (const r of shared) {
      const room = this.ctx.store.decode<Room>('rooms', r);
      if (r._accepted) out.push(this.view(room, userId));
      else out.push({ id: room.id, name: room.name, invited: true, role: r._role, owner: { id: room.user_id, name: this.userName(room.user_id) }, access: null, bots: [], people: [], updated_at: room.updated_at });
    }
    return out;
  }
}

export function modeLabel(m: RoomMode): string {
  return { lead: 'lead verdeelt het werk', round_robin: 'om de beurt', everyone: 'iedereen tegelijk', mention: 'alleen op vermelding' }[m] || m;
}

export function cleanPerms(p: any): Partial<BotPerms> {
  const out: Partial<BotPerms> = {};
  if (!p || typeof p !== 'object') return out;
  if (p.respond === 'auto' || p.respond === 'mention') out.respond = p.respond;
  if (['none', 'read', 'write'].includes(p.files)) out.files = p.files;
  if (p.tasks !== undefined) out.tasks = !!p.tasks;
  if (p.delegate !== undefined) out.delegate = !!p.delegate;
  return out;
}

export type { Agent };
