import fs from 'node:fs';
import path from 'node:path';
import { newId, now } from '../../core/db.js';
import { bad, notFound } from '../../core/http.js';
import { sanitizeNewAgentFor } from '../../api/member-policy.js';
import { nameKey } from './routing.js';
import type { Room } from './types.js';
import type { RoomService } from './service.js';
import { bytesText } from '../../core/i18n.js';
import type { QualityView, Verdict } from '../quality/types.js';

export const TASK_STATUS = ['todo', 'doing', 'review', 'done', 'blocked'] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];
export const TASK_LABEL: Record<TaskStatus, string> = { todo: 'Te doen', doing: 'Bezig', review: 'Te controleren', done: 'Klaar', blocked: 'Geblokkeerd' };

export interface Task {
  id: string;
  user_id: string;
  room_id: string | null;
  team_id: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  owner_type: 'agent' | 'user' | null;
  owner_id: string | null;
  deadline: string | null;
  source_thread_id: string | null;
  source_message_id: string | null;
  result: string;
  created_by_type: 'agent' | 'user';
  created_by_id: string | null;
  created_by_name: string;
  sort: number;
  /** 1 = Belangrijk (package D: never below the minimum level; pauses instead). Stored as 0/1, shown as a boolean. */
  important?: number;
  created_at: string;
  updated_at: string;
}

type Actor = { type: 'agent' | 'user'; id: string; name: string };

/** The quality module's service (klaar als, claim, second look), when it is loaded. */
export type QualityApi = {
  view(userId: string, kind: 'room', ref: string): QualityView;
  setDoneWhen(userId: string, kind: 'room', ref: string, text: any, by: 'agent' | 'user', title?: string): string | null;
  setSkip(userId: string, kind: 'room', ref: string, skip: boolean, title?: string): void;
  claim(userId: string, kind: 'room', ref: string, agentId: string, title?: string): { ok: true; already: boolean } | { ok: false; holder: string; holderName: string; since: string };
  release(userId: string, kind: 'room', ref: string, agentId?: string | null): boolean;
  holder(userId: string, kind: 'room', ref: string): string | null;
  ownerDecided(userId: string, kind: 'room', ref: string, done: boolean): void;
  reopen(userId: string, kind: 'room', ref: string): void;
  remove(userId: string, kind: 'room', ref: string): void;
  report(i: any): Promise<{ verdict: Verdict }>;
  workerOf(userId: string, kind: 'room', ref: string): any;
  tellBot(u: { id: string; name: string }, agent: any, text: string, parts?: Record<string, any>): Promise<any>;
};

const MAX_FILE_WRITE = 5_000_000;

/** Words a bot uses for the person it works for ("eigenaar", "de gebruiker"), compared with nameKey. */
const OWNER_WORDS = new Set(['eigenaar', 'deeigenaar', 'owner', 'theowner', 'gebruiker', 'degebruiker', 'user', 'theuser', 'baas', 'debaas', 'mens', 'demens']);

/** Task board, teams/departments, hire proposals and shared room files. */
export class Board {
  constructor(private s: RoomService) {}

  private get ctx() {
    return this.s.ctx;
  }

  get quality(): QualityApi | undefined {
    return this.ctx.services.quality;
  }

  // ------------------------------------------------------------------ tasks

  task(id: string): Task | null {
    return this.ctx.store.get<Task>('room_tasks', id);
  }

  taskView(t: Task) {
    const ownerName = t.owner_type === 'agent' ? this.s.agentName(t.owner_id) : t.owner_type === 'user' ? this.s.userName(t.owner_id) : '';
    const room = this.s.room(t.room_id);
    return { ...t, important: !!t.important, ownerName, roomName: room?.name || null, roomThreadId: room?.thread_id || null, statusLabel: TASK_LABEL[t.status] || t.status, quality: this.quality?.view(t.user_id, 'room', t.id) ?? null };
  }

  /** Tasks the user may see: own (personal + own rooms) plus rooms where they are a full member. */
  tasksFor(userId: string, f: { roomId?: string; teamId?: string; status?: string } = {}): Task[] {
    const roomIds = new Set<string>();
    for (const r of this.ctx.store.all<any>("SELECT r.id FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.kind = 'user' AND m.ref_id = ? AND m.accepted = 1 AND m.role != 'guest'", userId)) roomIds.add(r.id);
    const rows = this.ctx.store
      .all<any>(`SELECT * FROM room_tasks WHERE user_id = ? ${roomIds.size ? `OR room_id IN (${[...roomIds].map(() => '?').join(',')})` : ''} ORDER BY sort, created_at DESC LIMIT 1000`, userId, ...roomIds)
      .map((r) => this.ctx.store.decode<Task>('room_tasks', r));
    return rows.filter((t) => (!f.roomId || t.room_id === f.roomId) && (!f.teamId || t.team_id === f.teamId) && (!f.status || t.status === f.status));
  }

  canEditTask(userId: string, t: Task): boolean {
    if (t.user_id === userId) return true;
    const room = this.s.room(t.room_id);
    const acc = this.s.access(room, userId);
    return acc === 'owner' || acc === 'member';
  }

  /** People who can own a task here: the room's owner and its members (no guests), or the user himself. */
  private ownerPeople(userId: string, room: Room | null): string[] {
    return [room?.user_id || userId, ...(room ? this.s.humanMembers(room).filter((m) => m.role !== 'guest').map((m) => m.ref_id) : [])];
  }

  /**
   * Resolve "owner" text from a bot tool call: bot name, human name, "me"/"mij". Models add things to a name ("@Bo",
   * "Bo (Inkoper zonnepanelen)", "Bo - inkoper") or name the role ("Inkoper zonnepanelen"); those resolve too, a role
   * only when one bot has it (acceptance round 5, A-60: a task for Bo came out without an owner).
   */
  resolveOwner(userId: string, room: Room | null, ref: any, self?: Actor): { type: 'agent' | 'user'; id: string } | null {
    const r = String(ref ?? '').trim().replace(/^@/, '');
    if (!r) return null;
    if (self && ['me', 'mij', 'ik', 'zelf', 'self'].includes(r.toLowerCase())) return { type: self.type, id: self.id };
    const agents = this.ctx.store.agents(userId);
    const people = this.ownerPeople(userId, room)
      .map((uid) => this.ctx.store.user(uid))
      .filter((u): u is NonNullable<typeof u> => !!u);
    const tries = [r, r.replace(/\s*\([^()]*\)\s*$/, ''), r.split(/\s+[-–—:]\s+|,\s*/)[0], r.replace(/^(de\s+)?bot\s+/i, '')].map((x) => x.trim().replace(/^@/, '')).filter(Boolean);
    for (const x of [...new Set(tries)]) {
      const key = nameKey(x);
      const a = agents.find((b) => b.id === x || nameKey(b.name) === key);
      if (a) return { type: 'agent', id: a.id };
      // A person by name, by first name ("Sam" for "Sam de Vries") or by the name before the @ of the e-mail.
      const u = people.find((p) => p.id === x || nameKey(p.name) === key || nameKey(String(p.name).split(/\s+/)[0]) === key || (!!p.email && nameKey(String(p.email).split('@')[0]) === key));
      if (u) return { type: 'user', id: u.id };
    }
    // "eigenaar", "de gebruiker": the person the bots work for (live, 10 nov: the account was called "Eigenaar" while
    // the bot knew him by his first name; three task_update calls failed on "Onbekende eigenaar").
    if (people[0] && tries.some((x) => OWNER_WORDS.has(nameKey(x)))) return { type: 'user', id: people[0].id };
    const inRoom = room ? new Set(this.s.botMembers(room).map((m) => m.ref_id)) : null;
    const byRole = agents.filter((b) => (!inRoom || inRoom.has(b.id)) && b.role && tries.some((x) => nameKey(b.role) === nameKey(x.replace(/^de\s+/i, ''))));
    return byRole.length === 1 ? { type: 'agent', id: byRole[0].id } : null;
  }

  /** "Onbekende eigenaar: X. Kies een van: Bo, Ada, Sanne of "mij"." — so the bot can try again with a real name. */
  unknownOwner(userId: string, room: Room | null, ref: any): string {
    const bots = room ? this.s.botMembers(room).map((m) => this.s.agentName(m.ref_id)) : this.ctx.store.agents(userId).map((a) => a.name);
    const people = this.ownerPeople(userId, room).map((uid) => this.ctx.store.user(uid)?.name || '');
    const names = [...new Set([...bots, ...people].filter(Boolean))].slice(0, 20);
    const owner = this.ctx.store.user(room?.user_id || userId)?.name || 'de eigenaar';
    return names.length ? `Onbekende eigenaar: ${ref}. Kies een van: ${names.join(', ')}, of "mij". "mij" ben jij zelf (de bot); "eigenaar" is ${owner}, de mens voor wie je werkt.` : `Onbekende eigenaar: ${ref}`;
  }

  // ------------------------------------------------------------------ teams (module teams) on the task board

  private get teamsSvc(): any {
    return this.ctx.services.teams;
  }

  /** A bot that gives a task to a bot of another team needs aansturen on that team (like delegate_task). */
  private checkTeamOwner(actor: Actor, owner: { type: 'agent' | 'user'; id: string } | null) {
    if (actor.type !== 'agent' || owner?.type !== 'agent' || owner.id === actor.id) return;
    const why = this.teamsSvc?.delegateError?.(actor.id, owner.id);
    if (why) throw bad(why);
  }

  /** The team a task belongs to: its bot owner's home team, else the creating bot's, else none (the owner's own). */
  private taskTeam(owner: { type: string; id: string } | null, actor: Actor): string | null {
    const svc = this.teamsSvc;
    if (!svc) return null;
    if (owner?.type === 'agent') return svc.teamOf(owner.id) ?? null;
    if (actor.type === 'agent') return svc.teamOf(actor.id) ?? null;
    return null;
  }

  /** Can this bot see a task of the personal board? Tasks without a team are the owner's own and visible to all. */
  botSees(agentId: string, t: Task & { workspace_id?: string | null }): boolean {
    const svc = this.teamsSvc;
    return !svc || !t.workspace_id || !!svc.canRead?.(agentId, t.workspace_id);
  }

  /** Can this bot change a task? Only in its own team or a team it may aansturen. */
  botMayChange(agentId: string, t: Task & { workspace_id?: string | null }): boolean {
    const svc = this.teamsSvc;
    return !svc || !t.workspace_id || !!svc.canDirect?.(agentId, t.workspace_id);
  }

  createTask(o: { userId: string; room: Room | null; teamId?: string | null; data: any; actor: Actor; sourceThreadId?: string | null; sourceMessageId?: string | null }): Task {
    const whole = String(o.data?.title ?? '').trim();
    const title = whole.slice(0, 200);
    if (!title) throw bad('Een taak heeft een titel nodig');
    // A long title (someone typed the whole job in it): nothing is lost, the full text is the description the bot reads.
    const overflow = whole.length > 200 && !String(o.data?.description ?? '').trim() ? whole : '';
    const status: TaskStatus = TASK_STATUS.includes(o.data?.status) ? o.data.status : 'todo';
    let owner: { type: 'agent' | 'user'; id: string } | null = null;
    if (o.data?.ownerType && o.data?.ownerId) owner = this.checkOwner(o.userId, o.room, o.data.ownerType, o.data.ownerId);
    else if (o.data?.owner) {
      owner = this.resolveOwner(o.userId, o.room, o.data.owner, o.actor);
      if (!owner) throw bad(this.unknownOwner(o.userId, o.room, o.data.owner));
    }
    this.checkTeamOwner(o.actor, owner);
    const ts = now();
    const t: Task = {
      id: newId('task_'),
      user_id: o.room?.user_id || o.userId,
      room_id: o.room?.id ?? null,
      team_id: o.teamId ?? o.room?.team_id ?? null,
      title,
      description: (overflow || String(o.data?.description ?? '')).slice(0, 10_000),
      status,
      owner_type: owner?.type ?? null,
      owner_id: owner?.id ?? null,
      deadline: cleanDate(o.data?.deadline),
      source_thread_id: o.sourceThreadId ?? null,
      source_message_id: o.sourceMessageId ?? null,
      result: String(o.data?.result ?? '').slice(0, 10_000),
      created_by_type: o.actor.type,
      created_by_id: o.actor.id,
      created_by_name: o.actor.name,
      sort: 0,
      important: o.data?.important === true ? 1 : 0,
      created_at: ts,
      updated_at: ts,
    };
    this.ctx.store.insert('room_tasks', { ...t, workspace_id: this.taskTeam(owner, o.actor) });
    // "Klaar als": the bot proposes it, the owner can set it (then a bot can no longer change it).
    const doneWhen = o.data?.doneWhen ?? o.data?.done_when;
    if (doneWhen !== undefined && String(doneWhen).trim()) this.quality?.setDoneWhen(t.user_id, 'room', t.id, doneWhen, o.actor.type === 'user' ? 'user' : 'agent', title);
    if (o.actor.type === 'user' && o.data?.skipCheck === true) this.quality?.setSkip(t.user_id, 'room', t.id, true, title);
    this.s.activity(t.room_id, { type: o.actor.type, id: o.actor.id, name: o.actor.name }, 'task.created', `Taak aangemaakt: ${title}`, { taskId: t.id });
    this.taskNotify(t, o.actor, true);
    this.emitTask(t);
    return t;
  }

  private checkOwner(userId: string, room: Room | null, type: string, id: string): { type: 'agent' | 'user'; id: string } {
    if (type === 'agent') {
      const a = this.ctx.store.agent(id);
      if (!a || a.user_id !== (room?.user_id || userId)) throw bad('Onbekende bot als eigenaar');
      return { type: 'agent', id };
    }
    if (type === 'user') {
      const ok = id === (room?.user_id || userId) || (room && ['member', 'owner'].includes(this.s.access(room, id) || ''));
      if (!ok) throw bad('Deze persoon is geen lid van de groep');
      return { type: 'user', id };
    }
    throw bad('Ongeldig eigenaarstype');
  }

  /**
   * `verified`: the status comes from the done path (task_done: evidence and the second look). Without it, a bot can
   * never set a task to "klaar" directly: that becomes "te controleren" (the rule lives in the code, not the prompt).
   */
  updateTask(t: Task, patch: any, actor: Actor, opts: { verified?: boolean } = {}): Task {
    const p: any = { updated_at: now() };
    if (patch.title !== undefined) {
      const v = String(patch.title).trim().slice(0, 200);
      if (!v) throw bad('Titel mag niet leeg zijn');
      p.title = v;
    }
    if (patch.description !== undefined) p.description = String(patch.description).slice(0, 10_000);
    if (patch.status !== undefined) {
      if (!TASK_STATUS.includes(patch.status)) throw bad('Onbekende status');
      p.status = patch.status === 'done' && actor.type === 'agent' && !opts.verified ? 'review' : patch.status;
    }
    const q = this.quality;
    const doneWhen = patch.doneWhen ?? patch.done_when;
    if (doneWhen !== undefined && q) {
      const refused = q.setDoneWhen(t.user_id, 'room', t.id, doneWhen, actor.type === 'user' ? 'user' : 'agent', patch.title || t.title);
      if (refused) throw bad(refused);
    }
    if (patch.skipCheck !== undefined && actor.type === 'user') q?.setSkip(t.user_id, 'room', t.id, patch.skipCheck === true, t.title);
    if (patch.result !== undefined) p.result = String(patch.result).slice(0, 10_000);
    if (patch.deadline !== undefined) p.deadline = cleanDate(patch.deadline);
    if (patch.sort !== undefined) p.sort = Number(patch.sort) || 0;
    if (patch.important !== undefined) p.important = patch.important === true ? 1 : 0;
    const room = this.s.room(t.room_id);
    if (patch.ownerType !== undefined || patch.ownerId !== undefined) {
      if (!patch.ownerId) (p.owner_type = null), (p.owner_id = null);
      else {
        const o = this.checkOwner(t.user_id, room, patch.ownerType, patch.ownerId);
        this.checkTeamOwner(actor, o);
        p.owner_type = o.type;
        p.owner_id = o.id;
        if (o.type === 'agent') p.workspace_id = this.taskTeam(o, actor) ?? undefined;
      }
    } else if (patch.owner !== undefined) {
      if (!patch.owner) (p.owner_type = null), (p.owner_id = null);
      else {
        const o = this.resolveOwner(t.user_id, room, patch.owner, actor);
        if (!o) throw bad(this.unknownOwner(t.user_id, room, patch.owner));
        this.checkTeamOwner(actor, o);
        p.owner_type = o.type;
        p.owner_id = o.id;
        if (o.type === 'agent') p.workspace_id = this.taskTeam(o, actor) ?? undefined;
      }
    }
    this.ctx.store.update('room_tasks', t.id, p);
    const upd = this.task(t.id)!;
    if (q) {
      // A person changed the status: he decided; it no longer waits for him. Another owner: the old claim ends.
      if (actor.type === 'user' && p.status && (p.status !== t.status || q.view(t.user_id, 'room', t.id).open)) q.ownerDecided(t.user_id, 'room', t.id, p.status === 'done');
      const holder = q.holder(t.user_id, 'room', t.id);
      if (holder && p.owner_id !== undefined && p.owner_id !== holder) q.release(t.user_id, 'room', t.id, null);
    }
    const what = [p.status && `status → ${TASK_LABEL[p.status as TaskStatus]}`, p.owner_id !== undefined && 'eigenaar', p.result !== undefined && 'resultaat', p.title && 'titel', p.deadline !== undefined && 'deadline', p.important !== undefined && (p.important ? 'belangrijk' : 'niet meer belangrijk')].filter(Boolean).join(', ');
    this.s.activity(t.room_id, { type: actor.type, id: actor.id, name: actor.name }, 'task.updated', `Taak “${upd.title}” bijgewerkt${what ? `: ${what}` : ''}`, { taskId: t.id });
    if (p.owner_id && p.owner_id !== t.owner_id) this.taskNotify(upd, actor, false);
    this.emitTask(upd);
    return upd;
  }

  /**
   * The owner stopped this bot: a task it had on "Bezig" is not being worked on any more. It goes back to "Te doen",
   * without the claim ("… werkt eraan"), and stays the bot's own, so starting it again is one step: "Hervatten" in the
   * bot's chat, or the bot that gave the task gives it again (live, 12 nov: after "Alles stoppen" a task stayed on
   * "Bezig" with nobody working). `taskId`: the task this turn was started for. While the bot still works in another
   * conversation only that task is touched: its other tasks may belong to that work.
   */
  parkStopped(run: { user_id: string; agent_id: string; id: string }, taskId?: string | null) {
    const q = this.quality;
    const busyElsewhere = !!this.ctx.store.one("SELECT id FROM runs WHERE agent_id = ? AND id != ? AND status IN ('queued','running','waiting') LIMIT 1", run.agent_id, run.id);
    const userId = this.ctx.store.agent(run.agent_id)?.user_id || run.user_id;
    const rows = this.ctx.store.all<any>("SELECT * FROM room_tasks WHERE user_id = ? AND status = 'doing'", userId).map((r) => this.ctx.store.decode<Task>('room_tasks', r));
    const actor: Actor = { type: 'user', id: userId, name: this.s.userName(userId) };
    for (const t of rows) {
      const holder = q?.holder(t.user_id, 'room', t.id) ?? null;
      const its = holder ? holder === run.agent_id : t.owner_type === 'agent' && t.owner_id === run.agent_id;
      if (!its || (busyElsewhere && t.id !== taskId)) continue;
      q?.release(t.user_id, 'room', t.id, null);
      this.updateTask(t, { status: 'todo' }, actor);
    }
  }

  deleteTask(t: Task, actor: Actor) {
    this.ctx.store.remove('room_tasks', t.id);
    this.quality?.remove(t.user_id, 'room', t.id);
    this.s.activity(t.room_id, actor, 'task.deleted', `Taak verwijderd: ${t.title}`, { taskId: t.id });
    this.emitTask(t, true);
  }

  /**
   * A person gave a task to one of his own bots: the bot starts on it now (a message from him in the bot's own chat,
   * queued when the bot is busy), so a task with a bot as owner never just sits as "te doen". Null: nothing to start.
   */
  async startForUser(t: Task, u: { id: string; name: string }): Promise<{ agentName: string; mode: string } | null> {
    if (t.owner_type !== 'agent' || !t.owner_id || t.status !== 'todo') return null;
    const agent = this.ctx.store.agent(t.owner_id);
    if (!agent || agent.archived || agent.user_id !== u.id) return null;
    const text = this.taskBrief(t, null);
    const thread = this.ctx.chat.threadForAgent(u.id, agent.id);
    const parts = { kind: 'task_assigned', taskId: t.id };
    const queue = this.ctx.services.queue;
    let mode = 'sent';
    if (queue?.submit) mode = (await queue.submit(thread, { id: u.id, name: u.name }, { content: text, parts }, 'queue'))?.mode || 'sent';
    else await this.ctx.chat.postUserMessage({ thread, user: { id: u.id, name: u.name }, content: text, parts });
    this.s.activity(t.room_id, { type: 'user', id: u.id, name: u.name }, 'task.started', `${agent.name} gestart met taak: ${t.title}`, { taskId: t.id, agentId: agent.id });
    return { agentName: agent.name, mode };
  }

  /** The task as the bot that has to do it reads it: title, description, "klaar als", deadline and what to do with it. */
  taskBrief(t: Task, fromBot: string | null): string {
    const doneWhen = String(this.quality?.view(t.user_id, 'room', t.id).doneWhen || '').trim();
    return [
      `${fromBot ? `Taak van ${fromBot} voor jou` : 'Taak voor jou'} op het takenbord: “${t.title}” (taak ${t.id}).`,
      t.description.trim() ? `\n${t.description.trim()}` : '',
      doneWhen ? `\nKlaar als: ${doneWhen}` : '',
      t.deadline ? `Deadline: ${t.deadline}` : '',
      `\nBegin er nu aan: claim de taak met task_claim, doe het werk en meld hem af met task_done (met bewijs). Lukt het niet, meld hem dan af met outcome "cannot" en de reden.${fromBot ? ` Sluit af met een kort antwoord voor ${fromBot}: wat je deed, het bewijs en wat er nog openstaat.` : ''}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private taskNotify(t: Task, actor: Actor, created: boolean) {
    if (t.owner_type !== 'user' || !t.owner_id || t.owner_id === actor.id) return;
    this.s.notify(t.owner_id, { roomId: t.room_id, kind: 'task', title: `${created ? 'Nieuwe taak' : 'Taak'} voor jou: ${t.title}`, body: `Van ${actor.name}${t.deadline ? ` · deadline ${t.deadline}` : ''}`, link: '#/tasks', refId: t.id });
  }

  private emitTask(t: Task, deleted = false) {
    const room = this.s.room(t.room_id);
    const users = room ? this.s.audienceUsers(room, false) : [t.user_id];
    for (const uid of users) this.ctx.events.emit(uid, 'rooms.task', { id: t.id, roomId: t.room_id, deleted });
  }

  // ------------------------------------------------------------------ teams (departments, chief of staff, hierarchy)

  teams(userId: string) {
    const teams = this.ctx.store.find<any>('room_teams', { user_id: userId }, { order: 'created_at' });
    return teams.map((t) => this.teamView(t));
  }

  teamView(t: any) {
    const members = this.ctx.store.find<any>('room_team_members', { team_id: t.id }, { order: 'created_at' }).map((m) => {
      const a = this.ctx.store.agent(m.agent_id);
      return { ...m, name: a?.name || 'Verwijderde bot', avatar: a?.avatar || '', color: a?.color || '#6366f1', title: m.title || a?.role || '', reportsToName: m.reports_to ? this.s.agentName(m.reports_to) : null };
    });
    const rooms = this.ctx.store.all<any>('SELECT id, name, thread_id, archived FROM rooms WHERE team_id = ? ORDER BY updated_at DESC', t.id);
    return { ...t, chiefName: t.chief_agent_id ? this.s.agentName(t.chief_agent_id) : null, members, rooms };
  }

  createTeam(userId: string, data: any) {
    const name = String(data?.name ?? '').trim().slice(0, 80);
    if (!name) throw bad('Geef het team een naam');
    if (data?.parentId) this.s.ownTeam(userId, data.parentId);
    const chief = data?.chiefAgentId ? this.ownAgent(userId, data.chiefAgentId).id : null;
    const ts = now();
    // The department belongs to a team (module teams): the one asked for, the parent's, the chief's, or the default team.
    const svc = this.teamsSvc;
    const parent = data?.parentId ? this.ctx.store.get<any>('room_teams', data.parentId) : null;
    const wanted = data?.workspaceId && svc?.team?.(String(data.workspaceId))?.user_id === userId ? String(data.workspaceId) : null;
    const workspace = svc ? wanted || parent?.workspace_id || (chief ? svc.teamOf(chief) : null) || svc.ensureDefault(userId)?.id || null : null;
    const t = { id: newId('team_'), user_id: userId, parent_id: data?.parentId || null, name, description: String(data?.description ?? '').slice(0, 2000), chief_agent_id: chief, workspace_id: workspace, created_at: ts, updated_at: ts };
    this.ctx.store.insert('room_teams', t);
    if (chief) this.setTeamMember(userId, t.id, { agentId: chief, role: 'chief', title: data?.chiefTitle || 'Chief of staff' });
    for (const aid of Array.isArray(data?.agentIds) ? data.agentIds : []) if (aid !== chief) this.setTeamMember(userId, t.id, { agentId: aid, role: 'member', reportsTo: chief });
    this.ctx.audit(userId, 'team.created', { teamId: t.id, name });
    this.ctx.events.emit(userId, 'rooms.team', { id: t.id });
    return this.teamView(this.ctx.store.get('room_teams', t.id));
  }

  updateTeam(userId: string, id: string, data: any) {
    const t = this.s.ownTeam(userId, id);
    const p: any = { updated_at: now() };
    if (data?.name !== undefined) {
      const n = String(data.name).trim().slice(0, 80);
      if (!n) throw bad('Naam mag niet leeg zijn');
      p.name = n;
    }
    if (data?.description !== undefined) p.description = String(data.description).slice(0, 2000);
    if (data?.parentId !== undefined) {
      if (data.parentId) {
        this.s.ownTeam(userId, data.parentId);
        // No cycles in the department tree.
        let cur: any = this.ctx.store.get('room_teams', data.parentId);
        for (let i = 0; cur && i < 20; i++) {
          if (cur.id === id) throw bad('Een team kan niet onder zichzelf hangen');
          cur = cur.parent_id ? this.ctx.store.get('room_teams', cur.parent_id) : null;
        }
      }
      p.parent_id = data.parentId || null;
    }
    if (data?.chiefAgentId !== undefined) {
      p.chief_agent_id = data.chiefAgentId ? this.ownAgent(userId, data.chiefAgentId).id : null;
      if (p.chief_agent_id) this.setTeamMember(userId, id, { agentId: p.chief_agent_id, role: 'chief', title: 'Chief of staff' });
      for (const m of this.ctx.store.find<any>('room_team_members', { team_id: id, role: 'chief' })) if (m.agent_id !== p.chief_agent_id) this.ctx.store.update('room_team_members', m.id, { role: 'member' });
    }
    this.ctx.store.update('room_teams', t.id, p);
    this.ctx.events.emit(userId, 'rooms.team', { id });
    return this.teamView(this.ctx.store.get('room_teams', id));
  }

  deleteTeam(userId: string, id: string) {
    this.s.ownTeam(userId, id);
    this.ctx.store.tx(() => {
      this.ctx.store.exec('DELETE FROM room_team_members WHERE team_id = ?', id);
      this.ctx.store.exec('UPDATE room_teams SET parent_id = NULL WHERE parent_id = ?', id);
      this.ctx.store.exec('UPDATE rooms SET team_id = NULL WHERE team_id = ?', id);
      this.ctx.store.exec('UPDATE room_tasks SET team_id = NULL WHERE team_id = ?', id);
      this.ctx.store.remove('room_teams', id);
    });
    this.ctx.audit(userId, 'team.deleted', { teamId: id });
    this.ctx.events.emit(userId, 'rooms.team', { id, deleted: true });
  }

  setTeamMember(userId: string, teamId: string, data: any) {
    this.s.ownTeam(userId, teamId);
    const a = this.ownAgent(userId, data?.agentId);
    const role = ['chief', 'lead', 'member'].includes(data?.role) ? data.role : 'member';
    const reportsTo = data?.reportsTo ? this.ownAgent(userId, data.reportsTo).id : null;
    if (reportsTo === a.id) throw bad('Een bot kan niet aan zichzelf rapporteren');
    const existing = this.ctx.store.one<any>('SELECT * FROM room_team_members WHERE team_id = ? AND agent_id = ?', teamId, a.id);
    const title = data?.title !== undefined ? String(data.title).slice(0, 80) : existing?.title || '';
    if (existing) this.ctx.store.update('room_team_members', existing.id, { role, title, reports_to: reportsTo });
    else this.ctx.store.insert('room_team_members', { id: newId('tm_'), team_id: teamId, agent_id: a.id, role, title, reports_to: reportsTo, created_at: now() });
    if (role === 'chief') this.ctx.store.update('room_teams', teamId, { chief_agent_id: a.id, updated_at: now() });
    this.ctx.events.emit(userId, 'rooms.team', { id: teamId });
  }

  removeTeamMember(userId: string, teamId: string, agentId: string) {
    const t = this.s.ownTeam(userId, teamId);
    this.ctx.store.exec('DELETE FROM room_team_members WHERE team_id = ? AND agent_id = ?', teamId, agentId);
    this.ctx.store.exec('UPDATE room_team_members SET reports_to = NULL WHERE team_id = ? AND reports_to = ?', teamId, agentId);
    if (t.chief_agent_id === agentId) this.ctx.store.update('room_teams', teamId, { chief_agent_id: null, updated_at: now() });
    this.ctx.events.emit(userId, 'rooms.team', { id: teamId });
  }

  private ownAgent(userId: string, id: any) {
    const a = this.ctx.store.agent(String(id || ''));
    if (!a || a.user_id !== userId) throw bad('Onbekende bot');
    return a;
  }

  /** Stable org-chart text for the system prompt of bots in a team room. */
  orgChart(teamId: string | null): string {
    if (!teamId) return '';
    const t = this.ctx.store.get<any>('room_teams', teamId);
    if (!t) return '';
    const v = this.teamView(t);
    const parent = t.parent_id ? this.ctx.store.get<any>('room_teams', t.parent_id) : null;
    const lines = [`Team: ${t.name}${parent ? ` (afdeling van ${parent.name})` : ''}${t.description ? ` — ${t.description}` : ''}`];
    for (const m of v.members) lines.push(`- ${m.name}: ${m.role === 'chief' ? 'chief of staff' : m.role === 'lead' ? 'lead' : 'lid'}${m.title ? ` (${m.title})` : ''}${m.reportsToName ? `, rapporteert aan ${m.reportsToName}` : ''}`);
    return lines.join('\n');
  }

  // ------------------------------------------------------------------ hire proposals (lead suggests, human decides)

  propose(room: Room, proposerId: string, data: any): any {
    const lead = room.lead_agent_id === proposerId || (room.team_id && this.ctx.store.get<any>('room_teams', room.team_id)?.chief_agent_id === proposerId);
    if (!lead) throw bad('Alleen de lead (of chief of staff) van de groep kan een nieuw lid voorstellen.');
    const reason = String(data?.reason ?? '').slice(0, 2000);
    const existing = data?.bot ? this.ctx.store.agents(room.user_id).find((a) => a.id === data.bot || nameKey(a.name) === nameKey(String(data.bot))) : null;
    let row: any;
    if (existing) {
      if (this.s.botMember(room, existing.id)) throw bad(`${existing.name} is al lid van de groep.`);
      row = { kind: 'existing', agent_id: existing.id, profile: { name: existing.name, role: existing.role } };
    } else {
      const name = String(data?.name || data?.bot || '').trim().slice(0, 60);
      if (!name) throw bad('Geef een naam voor het voorgestelde lid.');
      row = { kind: 'new', agent_id: null, profile: { name, role: String(data?.role ?? '').slice(0, 80), description: String(data?.description ?? '').slice(0, 300), instructions: String(data?.instructions ?? '').slice(0, 6000) } };
    }
    const pending = this.ctx.store.one<any>("SELECT id FROM room_proposals WHERE room_id = ? AND status = 'pending' AND json_extract(profile,'$.name') = ?", room.id, row.profile.name);
    if (pending) throw bad('Er staat al een voorstel voor dit lid open.');
    const p = { id: newId('prop_'), user_id: room.user_id, room_id: room.id, team_id: room.team_id, proposer_agent_id: proposerId, ...row, reason, status: 'pending', created_at: now() };
    this.ctx.store.insert('room_proposals', p);
    const th = this.ctx.store.thread(room.thread_id);
    if (th) this.s.event(th, `${this.s.agentName(proposerId)} stelt voor om ${row.profile.name}${row.kind === 'new' ? ' (nieuwe bot)' : ''} aan de groep toe te voegen. Wacht op goedkeuring van ${this.s.userName(room.user_id)}.`, { kind: 'proposal', proposalId: p.id });
    // The card waits in "Wacht op jou" and in the group chat; the notification opens the group chat with the card.
    this.s.notify(room.user_id, { roomId: room.id, kind: 'proposal', title: `Voorstel: ${row.profile.name} toevoegen aan “${room.name}”`, body: `${this.s.agentName(proposerId)}: ${reason || 'geen reden opgegeven'}`, link: `#/t/${room.thread_id}`, refId: p.id });
    this.s.activity(room.id, { type: 'agent', id: proposerId }, 'proposal', `Stelt ${row.profile.name} voor als nieuw lid`, { proposalId: p.id });
    this.s.emitChanged(room);
    this.emitProposal(room, p.id);
    return p;
  }

  /** Live update for the proposal cards (Wacht op jou, the group chat, Groepen) of everyone who can see the room. */
  private emitProposal(room: Room | null, id: string) {
    const users = room ? this.s.audienceUsers(room) : [];
    const p = this.ctx.store.get<any>('room_proposals', id);
    if (p && !users.includes(p.user_id)) users.push(p.user_id);
    for (const uid of users) this.ctx.events.emit(uid, 'rooms.proposal', { id, status: p?.status || null });
  }

  /** A proposal as the cards show it: names instead of ids, the room's chat, the result (new bot) after a decision. */
  proposalView(p: any, viewerId: string) {
    const room = this.s.room(p.room_id);
    const result = p.result_agent_id ? this.ctx.store.agent(p.result_agent_id) : null;
    const proposer = this.ctx.store.agent(p.proposer_agent_id);
    return {
      id: p.id,
      room_id: p.room_id,
      roomName: room?.name || null,
      roomThreadId: room?.thread_id || null,
      kind: p.kind as 'new' | 'existing',
      agent_id: p.agent_id,
      profile: { name: String(p.profile?.name || ''), role: String(p.profile?.role || ''), description: String(p.profile?.description || ''), instructions: String(p.profile?.instructions || '') },
      reason: p.reason || '',
      status: p.status as 'pending' | 'approved' | 'denied',
      proposer_agent_id: p.proposer_agent_id,
      proposerName: proposer?.name || 'Een bot',
      proposerAvatar: proposer?.avatar || '',
      ownerName: this.s.userName(p.user_id),
      canDecide: p.user_id === viewerId && p.status === 'pending' && !!room,
      decidedByName: p.decided_by ? this.s.userName(p.decided_by) : null,
      decided_at: p.decided_at || null,
      result_agent_id: result ? result.id : null,
      resultName: result?.name || null,
      created_at: p.created_at,
    };
  }

  /** One proposal for its owner or someone who can see its room (read-only); 404 for everyone else. */
  proposal(id: string, viewerId: string) {
    const r = this.ctx.store.get<any>('room_proposals', id);
    if (!r) throw notFound('Voorstel niet gevonden');
    const room = this.s.room(r.room_id);
    if (r.user_id !== viewerId && !this.s.access(room, viewerId)) throw notFound('Voorstel niet gevonden');
    return this.proposalView(r, viewerId);
  }

  proposals(userId: string, roomId?: string) {
    return this.ctx.store
      .all<any>(`SELECT * FROM room_proposals WHERE user_id = ? ${roomId ? 'AND room_id = ?' : ''} ORDER BY created_at DESC LIMIT 200`, ...(roomId ? [userId, roomId] : [userId]))
      .map((r) => {
        const p = this.ctx.store.decode<any>('room_proposals', r);
        return { ...p, ...this.proposalView(p, userId) };
      });
  }

  decide(userId: string, id: string, approve: boolean) {
    const p = this.ctx.store.get<any>('room_proposals', id);
    if (!p || p.user_id !== userId) throw notFound('Voorstel niet gevonden');
    if (p.status !== 'pending') throw bad('Dit voorstel is al afgehandeld');
    const room = this.s.room(p.room_id);
    let agentId: string | null = null;
    if (approve && room) {
      if (p.kind === 'existing') agentId = p.agent_id;
      else {
        const proposer = this.ctx.store.agent(p.proposer_agent_id);
        const a = this.ctx.store.createAgent(userId, sanitizeNewAgentFor(this.ctx, userId, {
          name: p.profile.name,
          role: p.profile.role || '',
          description: p.profile.description || '',
          instructions: p.profile.instructions || '',
          provider_id: proposer?.provider_id ?? null,
          model: proposer?.model || '',
        }));
        agentId = a.id;
        this.ctx.audit(userId, 'agent.created', { name: a.name, via: 'hire_proposal' }, a.id);
        this.ctx.events.emit(userId, 'agent.updated', a);
      }
      if (agentId && !this.s.botMember(room, agentId)) this.s.addBot(room, agentId, {}, { type: 'user', id: userId });
      if (agentId && room.team_id && !this.ctx.store.one('SELECT id FROM room_team_members WHERE team_id = ? AND agent_id = ?', room.team_id, agentId))
        this.setTeamMember(userId, room.team_id, { agentId, role: 'member', reportsTo: p.proposer_agent_id });
    }
    this.ctx.store.update('room_proposals', id, { status: approve ? 'approved' : 'denied', decided_by: userId, decided_at: now(), result_agent_id: agentId });
    if (room) {
      const th = this.ctx.store.thread(room.thread_id);
      if (th) this.s.event(th, approve ? `${this.s.userName(userId)} heeft het voorstel goedgekeurd: ${p.profile.name} is toegevoegd.` : `${this.s.userName(userId)} heeft het voorstel om ${p.profile.name} toe te voegen afgewezen.`, { kind: 'proposal_decided', proposalId: id });
      this.s.activity(room.id, { type: 'user', id: userId }, 'proposal.decided', `${approve ? 'Goedgekeurd' : 'Afgewezen'}: ${p.profile.name}`, { proposalId: id });
      this.s.emitChanged(room);
    }
    this.ctx.audit(userId, approve ? 'team.hire_approved' : 'team.hire_denied', { proposalId: id, name: p.profile.name });
    this.emitProposal(room, id);
    return { ...p, ...this.proposalView(this.ctx.store.get<any>('room_proposals', id), userId) };
  }

  // ------------------------------------------------------------------ shared room files

  /** Resolve a relative path inside the room folder; refuses escapes, absolute paths and symlinks. */
  resolveFile(roomId: string, rel: string, mustExist = false): string {
    const root = this.s.filesDir(roomId);
    fs.mkdirSync(root, { recursive: true });
    const clean = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean || clean.split('/').some((p) => p === '..' || p === '') || path.isAbsolute(String(rel)) || /^[a-zA-Z]:/.test(clean)) throw bad('Ongeldig pad (alleen relatieve paden binnen de groepsmap)');
    if (/(^|\/)\.env(\.|$)|\.key$|\.pem$/i.test(clean)) throw bad('Dit bestandstype is beschermd');
    const full = path.resolve(root, clean);
    const relCheck = path.relative(root, full);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) throw bad('Pad valt buiten de groepsmap');
    // Refuse symlinks anywhere on the way.
    let cur = root;
    for (const part of relCheck.split(path.sep)) {
      cur = path.join(cur, part);
      if (fs.existsSync(cur) && fs.lstatSync(cur).isSymbolicLink()) throw bad('Symbolische koppelingen zijn niet toegestaan in de groepsmap');
    }
    if (mustExist && !fs.existsSync(full)) throw notFound('Bestand niet gevonden');
    return full;
  }

  listFiles(roomId: string) {
    const root = this.s.filesDir(roomId);
    const out: { path: string; size: number; modified: string }[] = [];
    if (!fs.existsSync(root)) return out;
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= 1000) return;
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(full);
        else {
          const st = fs.statSync(full);
          out.push({ path: path.relative(root, full).split(path.sep).join('/'), size: st.size, modified: st.mtime.toISOString() });
        }
      }
    };
    walk(root);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  writeFile(room: Room, rel: string, data: Buffer, actor: Actor) {
    const f = this.resolveFile(room.id, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const existed = fs.existsSync(f);
    if (existed && fs.statSync(f).isDirectory()) throw bad('Er staat al een map met deze naam');
    fs.writeFileSync(f, data);
    this.s.activity(room.id, actor, 'file.write', `${existed ? 'Bijgewerkt' : 'Toegevoegd'}: ${rel} (${bytesText(data.length)})`, { path: rel, bytes: data.length });
    this.ctx.audit(room.user_id, 'room.file_write', { roomId: room.id, path: rel, bytes: data.length, by: actor.name }, actor.type === 'agent' ? actor.id : null);
    for (const uid of this.s.audienceUsers(room, false)) this.ctx.events.emit(uid, 'rooms.files', { roomId: room.id });
    return { path: rel, size: data.length, existed };
  }

  deleteFile(room: Room, rel: string, actor: Actor) {
    const f = this.resolveFile(room.id, rel, true);
    if (fs.statSync(f).isDirectory()) throw bad('Alleen bestanden kunnen worden verwijderd');
    fs.rmSync(f);
    this.s.activity(room.id, actor, 'file.delete', `Verwijderd: ${rel}`, { path: rel });
    this.ctx.audit(room.user_id, 'room.file_delete', { roomId: room.id, path: rel, by: actor.name });
    for (const uid of this.s.audienceUsers(room, false)) this.ctx.events.emit(uid, 'rooms.files', { roomId: room.id });
  }

  static maxToolWrite = MAX_FILE_WRITE;
}

function cleanDate(v: any): string | null {
  if (!v) return null;
  const s = String(v).trim();
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : d.toISOString();
}
