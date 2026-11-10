import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Ctx, Message, Thread } from '../../core/types.js';
import { ah, bad, forbidden, notFound, str, user } from '../../core/http.js';
import { canSeeThread } from '../../api/threads.js';
import { mimeOf } from '../../tools/builtin/files.js';
import { MODE_LABEL } from './routing.js';
import { DELEGATION_LABEL } from './orchestration.js';
import { TASK_LABEL, type Board, type Task } from './board.js';
import type { RoomService } from './service.js';
import type { Delegation, Room } from './types.js';
import { exportTeam, installTeam, normalizeTeam, previewTeam } from './packages.js';
import { TEAM_TEMPLATES, teamTemplate } from './team-templates.js';

const p = (req: Request, k: string) => String((req.params as any)[k] ?? '');

export function roomRoutes(ctx: Ctx, s: RoomService, board: Board) {
  const api = ctx.api;
  const actorOf = (req: Request) => {
    const u = user(req);
    return { type: 'user' as const, id: u.id, name: u.name };
  };

  // ---------------------------------------------------------------- guards on core thread/message routes
  // Registered before the core routes, so they run first and can refuse or pass on (next()).
  const guard = (fn: (req: Request) => void | 'handled', res?: (req: Request, r: Response) => void) => (req: Request, r: Response, next: NextFunction) => {
    try {
      const out = fn(req);
      if (out === 'handled') return res ? res(req, r) : r.json({ ok: true });
      next();
    } catch (e) {
      next(e);
    }
  };
  const roomOfThread = (id: string) => {
    const t = ctx.store.thread(id);
    return { t, room: s.roomForThread(t) };
  };
  api.patch(
    '/threads/:id',
    guard((req) => {
      const { t, room } = roomOfThread(p(req, 'id'));
      if (!room || !t) return;
      const u = user(req);
      if (room.user_id !== u.id) throw forbidden('Alleen de eigenaar van de groep kan dit gesprek wijzigen');
      if (t.id === room.thread_id && (req.body?.title !== undefined || req.body?.archived !== undefined)) {
        const patch: any = {};
        if (req.body?.title !== undefined && String(req.body.title).trim()) patch.name = str(req.body.title, 80);
        if (req.body?.archived !== undefined) patch.archived = !!req.body.archived;
        if (Object.keys(patch).length) s.update(room, patch, u.id);
      }
    }),
  );
  api.delete(
    '/threads/:id',
    guard((req) => {
      const { t, room } = roomOfThread(p(req, 'id'));
      if (!room || !t) return;
      if (room.user_id !== user(req).id) throw forbidden('Alleen de eigenaar van de groep kan dit verwijderen');
      if (t.id !== room.thread_id) return;
      s.remove(room, user(req).id);
      return 'handled';
    }),
  );
  const noGuests = (what: string) =>
    guard((req) => {
      const { room } = roomOfThread(p(req, 'id'));
      if (!room) return;
      const acc = s.access(room, user(req).id);
      if (acc === 'guest') throw forbidden(`Gasten kunnen niet ${what}`);
      if ((req.path.endsWith('/resume') || req.path.endsWith('/retry')) && (room.status === 'paused' || room.archived)) throw bad('De groep is gepauzeerd of gearchiveerd; hervat de groep eerst via Groepen.');
    });
  api.post('/threads/:id/stop', noGuests('bots stoppen'));
  api.post('/threads/:id/resume', noGuests('bots hervatten'));
  api.post('/threads/:id/retry', noGuests('opnieuw proberen'));
  api.post(
    '/threads/:id/messages',
    guard((req) => {
      const t = ctx.store.thread(p(req, 'id'));
      if (t?.kind === 'delegation' && t.meta?.dm && canSeeThread(user(req).id, t)) throw bad('Dit is een bot-tot-botgesprek (alleen-lezen). Schrijf in de groep of in een chat met de bot.');
    }),
  );
  const msgGuard = (what: 'delete' | 'pin') =>
    guard((req) => {
      const m = ctx.store.message(p(req, 'id'));
      if (!m) return;
      const room = s.roomForThread(ctx.store.thread(m.thread_id));
      if (!room) return;
      const u = user(req);
      const acc = s.access(room, u.id);
      if (!acc) return;
      if (what === 'pin' && acc === 'guest') throw forbidden('Gasten kunnen geen berichten vastpinnen');
      if (what === 'delete' && acc !== 'owner' && !(m.author_type === 'user' && m.author_id === u.id)) throw forbidden('Je kunt in een groep alleen je eigen berichten verwijderen');
    });
  api.delete('/messages/:id', msgGuard('delete'));
  api.post('/messages/:id/pin', msgGuard('pin'));

  // ---------------------------------------------------------------- fixed sub-paths (before /rooms/:id)

  api.get(
    '/rooms/people',
    ah(async (req) => {
      const u = user(req);
      const q = str(req.query.q, 100).toLowerCase();
      const admin = u.role !== 'member';
      return ctx.store
        .users()
        .filter((x) => x.id !== u.id && !x.disabled)
        .filter((x) => !q || x.name.toLowerCase().includes(q) || (x.email || '').toLowerCase() === q)
        .slice(0, 100)
        .map((x) => ({ id: x.id, name: x.name, email: admin ? x.email : null }));
    }),
  );

  api.get('/rooms/defaults', ah(async (req) => s.userDefaults(user(req).id)));
  api.put('/rooms/defaults', ah(async (req) => s.setUserDefaults(user(req).id, req.body || {})));

  api.get(
    '/rooms/inbox',
    ah(async (req) => {
      const u = user(req);
      const rows = ctx.store.all<any>('SELECT * FROM room_inbox WHERE user_id = ? ORDER BY read, created_at DESC LIMIT 200', u.id).map((r) => ctx.store.decode('room_inbox', r));
      return { items: rows, unread: rows.filter((r: any) => !r.read).length };
    }),
  );
  api.post(
    '/rooms/inbox/read-all',
    ah(async (req) => {
      ctx.store.exec('UPDATE room_inbox SET read = 1 WHERE user_id = ?', user(req).id);
      ctx.events.emit(user(req).id, 'rooms.inbox', {});
      return { ok: true };
    }),
  );
  api.post(
    '/rooms/inbox/:id/read',
    ah(async (req) => {
      ctx.store.exec('UPDATE room_inbox SET read = 1 WHERE id = ? AND user_id = ?', p(req, 'id'), user(req).id);
      ctx.events.emit(user(req).id, 'rooms.inbox', {});
      return { ok: true };
    }),
  );

  // ---- hire proposals ----
  api.get('/rooms/proposals', ah(async (req) => board.proposals(user(req).id)));
  api.get('/rooms/proposals/:id', ah(async (req) => board.proposal(p(req, 'id'), user(req).id)));
  api.post(
    '/rooms/proposals/:id',
    ah(async (req) => {
      const d = req.body?.decision;
      if (d !== 'approve' && d !== 'deny') throw bad('Kies goedkeuren of afwijzen');
      return board.decide(user(req).id, p(req, 'id'), d === 'approve');
    }),
  );

  // ---- delegations ----
  const delegationFor = (req: Request, d: Delegation | null) => {
    const u = user(req);
    if (!d) throw notFound('Taak niet gevonden');
    const parent = ctx.store.thread(d.parent_thread_id);
    if (!canSeeThread(u.id, parent) && d.user_id !== u.id) throw notFound('Taak niet gevonden');
    const v = s.orch.view(d);
    const sub = ctx.store.thread(d.thread_id);
    return { ...v, threadExists: canSeeThread(u.id, sub) };
  };
  api.get('/rooms/delegations/by-call/:callId', ah(async (req) => ctx.store.find<Delegation>('room_delegations', { tool_call_id: p(req, 'callId') }, { order: 'created_at' }).map((d) => delegationFor(req, d))));
  api.get(
    '/rooms/delegations',
    ah(async (req) => {
      const tid = str(req.query.threadId, 80);
      if (!tid) throw bad('threadId ontbreekt');
      const t = ctx.store.thread(tid);
      if (!canSeeThread(user(req).id, t)) throw notFound('Gesprek niet gevonden');
      const room = s.roomForThread(t);
      const list = room && t!.id === room.thread_id && s.access(room, user(req).id) !== 'guest' ? s.orch.forRoom(room.id) : s.orch.forThread(t!.id);
      return list.map((d) => delegationFor(req, d));
    }),
  );
  api.get('/rooms/delegations/:id', ah(async (req) => delegationFor(req, s.orch.get(p(req, 'id')))));
  api.post(
    '/rooms/delegations/:id/cancel',
    ah(async (req) => {
      const d = s.orch.get(p(req, 'id'));
      delegationFor(req, d);
      const room = s.room(d!.room_id);
      if (room && s.access(room, user(req).id) === 'guest') throw forbidden('Gasten kunnen geen taken stoppen');
      if (d!.kind === 'ask') {
        // Withdrawn by a person: the sender is not woken, but finds a note in its conversation.
        const ok = s.orch.cancel(d!, `Ingetrokken door ${user(req).name}`);
        const parent = ctx.store.thread(d!.parent_thread_id);
        if (ok && parent) s.systemMessage(parent, `${user(req).name} trok het bericht van ${s.agentName(d!.from_agent_id)} aan ${s.agentName(d!.to_agent_id)} in; daar komt geen antwoord meer op.`, { kind: 'delegation_cancelled', delegationId: d!.id });
        return { ok };
      }
      // A running turn is cancelled; a subtask that waits for bots it passed the work on to is stopped with them.
      if (d!.run_id) s.orch.stop(d!, `Subtaak gestopt door ${user(req).name}`);
      return { ok: true };
    }),
  );

  // ---- teams ----
  api.get('/rooms/teams', ah(async (req) => board.teams(user(req).id)));
  api.post('/rooms/teams', ah(async (req) => board.createTeam(user(req).id, req.body || {})));
  api.patch('/rooms/teams/:id', ah(async (req) => board.updateTeam(user(req).id, p(req, 'id'), req.body || {})));
  api.delete(
    '/rooms/teams/:id',
    ah(async (req) => {
      board.deleteTeam(user(req).id, p(req, 'id'));
      return { ok: true };
    }),
  );
  api.put(
    '/rooms/teams/:id/members',
    ah(async (req) => {
      board.setTeamMember(user(req).id, p(req, 'id'), req.body || {});
      return board.teamView(s.ownTeam(user(req).id, p(req, 'id')));
    }),
  );
  api.delete(
    '/rooms/teams/:id/members/:agentId',
    ah(async (req) => {
      board.removeTeamMember(user(req).id, p(req, 'id'), p(req, 'agentId'));
      return board.teamView(s.ownTeam(user(req).id, p(req, 'id')));
    }),
  );
  api.post(
    '/rooms/teams/:id/room',
    ah(async (req) => {
      const u = user(req);
      const team = board.teamView(s.ownTeam(u.id, p(req, 'id')));
      const agentIds = team.members.map((m: any) => m.agent_id).filter((id: string) => ctx.store.agent(id));
      const room = s.create(u.id, { name: str(req.body?.name, 80) || team.name, agentIds, mode: req.body?.mode || 'lead', leadAgentId: team.chief_agent_id, teamId: team.id, instructions: req.body?.instructions || '', crossTeam: req.body?.crossTeam === true });
      return { room: s.view(room, u.id), threadId: room.thread_id };
    }),
  );

  // ---- tasks ----
  const taskFor = (req: Request): Task => {
    const t = board.task(p(req, 'id'));
    if (!t || !board.canEditTask(user(req).id, t)) throw notFound('Taak niet gevonden');
    return t;
  };
  api.get(
    '/rooms/tasks',
    ah(async (req) => {
      const u = user(req);
      const roomId = str(req.query.roomId, 80) || undefined;
      if (roomId) s.require(roomId, u.id, 'member');
      return board.tasksFor(u.id, { roomId, teamId: str(req.query.teamId, 80) || undefined, status: str(req.query.status, 20) || undefined }).map((t) => board.taskView(t));
    }),
  );
  api.post(
    '/rooms/tasks',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      const room = b.roomId ? s.require(String(b.roomId), u.id, 'member').room : null;
      const teamId = b.teamId ? s.ownTeam(room?.user_id || u.id, String(b.teamId)).id : null;
      return board.taskView(board.createTask({ userId: u.id, room, teamId, data: b, actor: actorOf(req), sourceThreadId: b.sourceThreadId || null, sourceMessageId: b.sourceMessageId || null }));
    }),
  );
  api.patch('/rooms/tasks/:id', ah(async (req) => board.taskView(board.updateTask(taskFor(req), req.body || {}, actorOf(req)))));
  // A person decides about a task that waits ("te controleren", "kon niet"): approve it, or send it back to the bot.
  api.post('/rooms/tasks/:id/approve', ah(async (req) => board.taskView(board.updateTask(taskFor(req), { status: 'done' }, actorOf(req)))));
  api.post(
    '/rooms/tasks/:id/reopen',
    ah(async (req) => {
      const u = user(req);
      const t = taskFor(req);
      const q = board.quality;
      const before = q?.view(t.user_id, 'room', t.id);
      const worker = q?.workerOf(t.user_id, 'room', t.id) || (t.owner_type === 'agent' ? ctx.store.agent(t.owner_id) : null);
      const upd = board.updateTask(t, { status: 'doing' }, actorOf(req));
      q?.reopen(t.user_id, 'room', t.id);
      let told: any = null;
      // Only the bot's own owner can send it a message in its own chat.
      if (worker && worker.user_id === u.id && q) {
        const note = str(req.body?.note, 2000).trim();
        const why = note || before?.check.reason || '';
        const text = `De taak “${t.title}” is nog niet klaar.${why ? ` ${why}` : ''}\n\nMaak hem af en meld hem opnieuw af met task_done, met bewijs. Lukt het niet, meld dan "kon niet" met de reden.`;
        told = await q.tellBot(u, worker, text, { kind: 'task_reopened', taskId: t.id });
      }
      return { task: board.taskView(upd), told };
    }),
  );
  /**
   * "Start na de reset om …" (package P3): the bot doing this task gets it at that moment (the reset the cost estimate
   * gave), as a one-time routine in its own chat. Body { at: epoch ms | ISO }.
   */
  api.post(
    '/rooms/tasks/:id/start-after',
    ah(async (req) => {
      const u = user(req);
      const t = taskFor(req);
      const engine = ctx.services.routines?.engine;
      if (typeof engine?.createOnceAt !== 'function') throw bad('Later starten kan alleen als Routines aan staat.');
      const agent = t.owner_type === 'agent' && t.owner_id ? ctx.store.agent(t.owner_id) : undefined;
      if (!agent || agent.user_id !== u.id) throw bad('Kies eerst welke van je bots deze taak doet.');
      const raw = req.body?.at;
      const at = typeof raw === 'number' ? raw : Date.parse(String(raw || ''));
      if (!Number.isFinite(at) || at <= Date.now() || at > Date.now() + 8 * 86_400_000) throw bad('Kies een tijdstip in de komende 8 dagen.');
      const doneWhen = String(board.taskView(t).quality?.doneWhen || '').trim();
      const prompt = `Begin aan de taak “${t.title}” op het takenbord (taak ${t.id}).${doneWhen ? ` Klaar als: ${doneWhen}` : ''}

Zet de taak op Bezig, werk hem af en meld hem af met bewijs. Lukt het niet, meld dan "kon niet" met de reden.`;
      let r: any;
      try {
        r = engine.createOnceAt(u.id, agent.id, { name: `Taak: ${t.title}`.slice(0, 80), prompt, at, important: !!t.important });
      } catch (e: any) {
        throw bad(e?.message || 'Inplannen lukte niet.');
      }
      ctx.audit(u.id, 'task.start_after', { task: t.id, routine: r.id, at: new Date(at).toISOString() }, agent.id);
      return { routineId: r.id, at, agentName: agent.name };
    }),
  );
  api.post(
    '/rooms/tasks/:id/release',
    ah(async (req) => {
      // "Vrijgeven": nobody works on it now, any bot may pick it up (the bot that held it is no longer its owner).
      const t = taskFor(req);
      const holder = board.quality?.holder(t.user_id, 'room', t.id);
      board.quality?.release(t.user_id, 'room', t.id, null);
      const patch: any = {};
      if (holder && t.owner_type === 'agent' && t.owner_id === holder) patch.ownerId = null;
      if (t.status === 'doing') patch.status = 'todo';
      const upd = Object.keys(patch).length ? board.updateTask(t, patch, actorOf(req)) : board.task(t.id)!;
      return board.taskView(upd);
    }),
  );
  api.delete(
    '/rooms/tasks/:id',
    ah(async (req) => {
      board.deleteTask(taskFor(req), actorOf(req));
      return { ok: true };
    }),
  );

  // ---- by thread (used by chat header, composer and inspector) ----
  api.get(
    '/rooms/by-thread/:threadId',
    ah(async (req) => {
      const u = user(req);
      const t = ctx.store.thread(p(req, 'threadId'));
      if (!canSeeThread(u.id, t)) throw notFound('Gesprek niet gevonden');
      const room = s.roomForThread(t);
      const access = s.access(room, u.id);
      const d = t!.kind === 'delegation' ? s.orch.get(t!.meta?.delegation?.id) || ctx.store.one<any>('SELECT * FROM room_delegations WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1', t!.id) : null;
      const delegation = d ? s.orch.view(ctx.store.decode('room_delegations', d)) : null;
      return {
        room: room && access ? s.view(room, u.id) : null,
        isMain: !!room && room.thread_id === t!.id,
        thread: { id: t!.id, kind: t!.kind, parent_id: t!.parent_id, dm: !!t!.meta?.dm },
        delegation,
        parentVisible: t!.parent_id ? canSeeThread(u.id, ctx.store.thread(t!.parent_id)) : false,
      };
    }),
  );

  // ---------------------------------------------------------------- rooms

  api.get('/rooms', ah(async (req) => s.list(user(req).id, { archived: req.query.archived === '1', team: str(req.query.team, 80) || null })));
  api.post(
    '/rooms',
    ah(async (req) => {
      const u = user(req);
      const room = s.create(u.id, req.body || {});
      return { room: s.view(room, u.id), threadId: room.thread_id };
    }),
  );
  api.get('/rooms/modes', ah(async () => MODE_LABEL));

  // ---- team templates (A-14) and team packages (A-63) ----
  api.get(
    '/rooms/templates',
    ah(async () =>
      TEAM_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, mode: t.mode, bots: t.bots.map((b) => ({ name: b.template.name, role: b.template.role, avatar: b.template.avatar, groupRole: b.role })) })),
    ),
  );
  const teamFrom = (b: any) => {
    if (b?.templateId) {
      const t = teamTemplate(str(b.templateId, 80));
      if (!t) throw notFound('Onbekend teamsjabloon');
      return normalizeTeam(t);
    }
    return normalizeTeam(b?.package);
  };
  api.post(
    '/rooms/packages/preview',
    ah(async (req) => previewTeam(ctx, user(req).id, teamFrom(req.body))),
  );
  api.post(
    '/rooms/packages/install',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      const r = await installTeam(ctx, s, u.id, teamFrom(b), { provider_id: b.provider_id ? str(b.provider_id, 100) : null, model: str(b.model, 200), name: str(b.name, 80), acknowledge: b.acknowledge === true });
      return { room: s.view(r.room, u.id), threadId: r.room.thread_id, agents: r.agents, warnings: r.warnings };
    }),
  );

  const R = (req: Request, min: 'guest' | 'member' | 'owner' = 'guest') => s.require(p(req, 'id'), user(req).id, min);

  api.get(
    '/rooms/:id',
    ah(async (req) => {
      const { room, access } = R(req);
      const v: any = s.view(room, user(req).id);
      if (access === 'owner') v.proposals = board.proposals(room.user_id, room.id).filter((x: any) => x.status === 'pending');
      return v;
    }),
  );
  api.patch('/rooms/:id', ah(async (req) => s.view(s.update(R(req, 'owner').room, req.body || {}, user(req).id), user(req).id)));
  api.delete(
    '/rooms/:id',
    ah(async (req) => {
      s.remove(R(req, 'owner').room, user(req).id);
      return { ok: true };
    }),
  );
  api.post(
    '/rooms/:id/stop',
    ah(async (req) => {
      const { room } = R(req, 'member');
      const agentId = str(req.body?.agentId, 80);
      if (agentId) return { stopped: s.stopBot(room, agentId, user(req).id) };
      return { stopped: s.stopRoom(room, user(req).id, `gestopt door ${user(req).name}`) };
    }),
  );
  api.post(
    '/rooms/:id/resume',
    ah(async (req) => {
      const { room } = R(req, 'member');
      const agentId = str(req.body?.agentId, 80);
      const cont = req.body?.continue === true;
      if (agentId) {
        const r = s.resumeBot(room, agentId, user(req).id, cont);
        return { ok: true, runId: r.run?.id ?? null };
      }
      return { ok: true, ...s.resumeRoom(room, user(req).id, cont) };
    }),
  );

  // ---- bots ----
  api.post(
    '/rooms/:id/bots',
    ah(async (req) => {
      const { room } = R(req, 'owner');
      s.addBot(room, str(req.body?.agentId, 80), { role: req.body?.role, perms: req.body?.perms, crossTeam: req.body?.crossTeam === true }, { type: 'user', id: user(req).id });
      return s.view(s.room(room.id)!, user(req).id);
    }),
  );
  api.patch(
    '/rooms/:id/bots/:agentId',
    ah(async (req) => {
      const { room } = R(req, 'owner');
      s.updateBot(room, p(req, 'agentId'), req.body || {});
      return s.view(s.room(room.id)!, user(req).id);
    }),
  );
  api.delete(
    '/rooms/:id/bots/:agentId',
    ah(async (req) => {
      const { room } = R(req, 'owner');
      if (!s.botMember(room, p(req, 'agentId'))) throw notFound('Bot is geen lid');
      s.removeBot(room, p(req, 'agentId'));
      return s.view(s.room(room.id)!, user(req).id);
    }),
  );

  // ---- people ----
  api.post(
    '/rooms/:id/people',
    ah(async (req) => {
      const { room } = R(req, 'owner');
      let uid = str(req.body?.userId, 80);
      if (!uid && req.body?.email) uid = ctx.store.one<any>('SELECT id FROM users WHERE email = ?', str(req.body.email, 200).trim().toLowerCase())?.id || '';
      if (!uid) throw bad('Onbekende gebruiker. Wie nog geen account heeft, kan via een uitnodigingscode (Instellingen › Gebruikers) lid worden van deze server.');
      s.invite(room, user(req).id, uid, req.body?.role === 'guest' ? 'guest' : 'member');
      return s.view(s.room(room.id)!, user(req).id);
    }),
  );
  api.patch(
    '/rooms/:id/people/:userId',
    ah(async (req) => {
      const { room } = R(req, 'owner');
      s.setPersonRole(room, p(req, 'userId'), req.body?.role === 'guest' ? 'guest' : 'member');
      return s.view(s.room(room.id)!, user(req).id);
    }),
  );
  api.delete(
    '/rooms/:id/people/:userId',
    ah(async (req) => {
      const u = user(req);
      const target = p(req, 'userId');
      const room = s.room(p(req, 'id'));
      if (!room) throw notFound('Groep niet gevonden');
      if (target === u.id) {
        if (room.user_id === u.id) throw bad('De eigenaar kan de groep niet verlaten; verwijder of archiveer hem.');
        if (!ctx.store.one("SELECT id FROM room_members WHERE room_id = ? AND kind = 'user' AND ref_id = ?", room.id, u.id)) throw notFound('Groep niet gevonden');
      } else s.require(room.id, u.id, 'owner');
      s.removePerson(room, target, u.id);
      return { ok: true };
    }),
  );
  const invitation = (accept: boolean) =>
    ah(async (req) => {
      const room = s.room(p(req, 'id'));
      if (!room) throw notFound('Groep niet gevonden');
      s.respondInvite(room, user(req).id, accept);
      return accept ? { ok: true, threadId: room.thread_id } : { ok: true };
    });
  api.post('/rooms/:id/accept', invitation(true));
  api.post('/rooms/:id/decline', invitation(false));

  // ---- ledger, activity, delegations ----
  // The whole group as a team package: bots, roles, settings and skills; no conversations, people or secrets.
  api.get(
    '/rooms/:id/package',
    ah(async (req, res) => {
      const { room } = R(req, 'owner');
      const { pkg, warnings } = await exportTeam(ctx, room);
      ctx.audit(user(req).id, 'team.exported', { roomId: room.id, bots: pkg.bots.length, skills: pkg.skills.length, removedSecrets: warnings.some((w) => /geheim/.test(w)) });
      if (req.query.preview === '1') return { package: pkg, warnings };
      res.setHeader('content-disposition', `attachment; filename="${(room.name || 'team').replace(/[^\w-]+/g, '_')}.teambot-team.json"`);
      res.json(pkg);
    }),
  );
  api.get('/rooms/:id/ledger', ah(async (req) => s.ledger(R(req, 'member').room)));
  api.get(
    '/rooms/:id/activity',
    ah(async (req) => {
      const { room } = R(req, 'member');
      const agentId = str(req.query.agentId, 80);
      const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
      const rows = ctx.store
        .all<any>(`SELECT * FROM room_activity WHERE room_id = ? AND id < ? ${agentId ? "AND actor_type = 'agent' AND actor_id = ?" : ''} ORDER BY id DESC LIMIT 200`, ...(agentId ? [room.id, before, agentId] : [room.id, before]))
        .map((r) => ctx.store.decode('room_activity', r));
      return { items: rows, turns: agentId ? turnsOf(room, agentId) : [] };
    }),
  );

  /** What one bot saw and changed per turn: visible transcript range, tool calls with status, usage. */
  const turnsOf = (room: Room, agentId: string) => {
    const ids = s.threadIds(room);
    const runs = ctx.store.all<any>(`SELECT * FROM runs WHERE agent_id = ? AND thread_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 50`, agentId, ...ids).map((r) => ctx.store.decode<any>('runs', r));
    return runs.map((r) => {
      const seen = ctx.store.one<any>("SELECT COUNT(*) AS n, MAX(seq) AS maxSeq FROM messages WHERE thread_id = ? AND created_at <= ? AND (run_id IS NULL OR run_id != ?) AND role IN ('user','assistant','system') AND deleted = 0", r.thread_id, r.started_at || r.created_at, r.id);
      const own = ctx.store.all<any>("SELECT parts FROM messages WHERE run_id = ? AND role = 'assistant'", r.id).map((m) => JSON.parse(m.parts || '{}'));
      const tools = own.flatMap((x) => (x.toolCalls || []).map((c: any) => ({ name: c.name, summary: c.summary || '', status: c.status })));
      const th = ctx.store.thread(r.thread_id);
      return {
        runId: r.id,
        threadId: r.thread_id,
        threadTitle: r.thread_id === room.thread_id ? room.name : th?.title || 'Subgesprek',
        status: r.status,
        kind: r.meta?.team?.kind || r.trigger,
        path: (r.meta?.team?.path || []).map((a: string) => s.agentName(a)),
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        usage: r.usage,
        error: r.error,
        saw: { messages: seen?.n || 0, untilSeq: seen?.maxSeq || 0 },
        tools,
      };
    });
  };

  // ---- search & export ----
  api.get(
    '/rooms/:id/search',
    ah(async (req) => {
      const { room, access } = R(req);
      const q = str(req.query.q, 200)
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => '"' + w.replace(/"/g, '""') + '"')
        .join(' ');
      if (!q) return [];
      const ids = access === 'guest' ? [room.thread_id] : s.threadIds(room);
      return ctx.store.all(
        `SELECT f.message_id, f.thread_id, snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet, m.author_name, m.author_type, m.created_at, t.title
           FROM messages_fts f JOIN messages m ON m.id = f.message_id JOIN threads t ON t.id = f.thread_id
          WHERE messages_fts MATCH ? AND f.thread_id IN (${ids.map(() => '?').join(',')}) ORDER BY rank LIMIT 60`,
        q,
        ...ids,
      );
    }),
  );
  api.get(
    '/rooms/:id/export',
    ah(async (req, res) => {
      const { room, access } = R(req);
      const u = user(req);
      const full = access !== 'guest';
      const main = ctx.store.messages(room.thread_id, { limit: 100_000 });
      const delegations = full ? s.orch.forRoom(room.id) : [];
      const subs = full ? s.threadIds(room).filter((x) => x !== room.thread_id).map((id) => ctx.store.thread(id)).filter((x): x is Thread => !!x) : [];
      const tasks = full ? board.tasksFor(room.user_id, { roomId: room.id }) : [];
      const name = room.name.replace(/[^\w-]+/g, '_').slice(0, 60) || 'groep';
      const view: any = s.view(room, u.id);
      if (req.query.format === 'json') {
        res.setHeader('content-disposition', `attachment; filename="${name}.json"`);
        const strip = (m: Message) => ({ ...m, parts: { ...m.parts, raw: undefined, context: undefined, contexts: undefined, contextByAgent: undefined } });
        res.json({
          format: 'teambot.room/v1',
          exported_at: new Date().toISOString(),
          room: view,
          messages: main.map(strip),
          subthreads: subs.map((t) => ({ thread: t, messages: ctx.store.messages(t.id, { limit: 100_000 }).map(strip) })),
          delegations,
          tasks,
          ledger: full ? s.ledger(room) : undefined,
        });
        return;
      }
      res.setHeader('content-type', 'text/markdown; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="${name}.md"`);
      res.send(roomMarkdown(ctx, s, room, view, main, subs, delegations, tasks, full));
    }),
  );

  // ---- shared room files ----
  api.get('/rooms/:id/files', ah(async (req) => board.listFiles(R(req, 'member').room.id)));
  api.get(
    '/rooms/:id/files/raw',
    ah(async (req, res) => {
      const { room } = R(req, 'member');
      const rel = str(req.query.path, 500);
      const f = board.resolveFile(room.id, rel, true);
      if (fs.statSync(f).isDirectory()) throw bad('Dit is een map');
      const mime = mimeOf(f) || 'application/octet-stream';
      res.setHeader('content-type', mime);
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('content-disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(path.basename(f))}"`);
      if (/html|svg|xml/.test(mime)) res.setHeader('content-security-policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
      fs.createReadStream(f).pipe(res);
    }),
  );
  api.post(
    '/rooms/:id/files',
    express.raw({ type: () => true, limit: '50mb' }),
    ah(async (req) => {
      const { room } = R(req, 'member');
      const buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '');
      if (!buf.length) throw bad('Leeg bestand');
      return board.writeFile(room, str(req.query.path, 500), buf, actorOf(req));
    }),
  );
  api.delete(
    '/rooms/:id/files',
    ah(async (req) => {
      const { room } = R(req, 'member');
      board.deleteFile(room, str(req.query.path, 500), actorOf(req));
      return { ok: true };
    }),
  );
}

function who(m: Message) {
  return m.author_type === 'agent' ? `${m.author_name} (bot)` : m.author_type === 'user' ? `${m.author_name} (mens)` : m.author_type === 'external' ? `${m.author_name} (extern)` : 'TeamBot';
}

function transcript(lines: string[], msgs: Message[]) {
  for (const m of msgs) {
    if (m.deleted) continue;
    if (m.role === 'tool') {
      lines.push(`> 🔧 **${m.parts?.toolResult?.name}** (${m.author_name}) → ${m.content.slice(0, 400).replace(/\n/g, '\n> ')}`, '');
      continue;
    }
    if (m.role === 'event' || m.role === 'system') {
      lines.push(`_${m.content.replace(/\n/g, ' ').slice(0, 2000)}_`, '');
      continue;
    }
    lines.push(`**${who(m)}** · ${new Date(m.created_at).toLocaleString('nl-NL')}${m.reply_to ? ' · antwoord op een eerder bericht' : ''}`, '', m.content || '', '');
    for (const c of m.parts?.toolCalls || []) lines.push(`- 🔧 ${c.name}: ${c.summary || JSON.stringify(c.args).slice(0, 200)} (${c.status})`);
    if (m.parts?.toolCalls?.length) lines.push('');
  }
}

function roomMarkdown(ctx: Ctx, s: RoomService, room: Room, view: any, main: Message[], subs: Thread[], delegations: Delegation[], tasks: Task[], full: boolean): string {
  const lines = [
    `# ${room.name}`,
    '',
    `_Groepsgesprek geëxporteerd uit ${ctx.config.appName} op ${new Date().toLocaleString('nl-NL')} · modus: ${view.modeLabel} · eigenaar: ${view.owner.name}_`,
    '',
    '## Leden',
    '',
    ...view.bots.map((b: any) => `- ${b.name} (bot${b.lead ? ', lead' : ''}${b.owner ? ', taakeigenaar' : ''}) — ${b.title || 'geen rol'} · model ${b.model || 'standaard'} · toegang ${b.accessMode}`),
    ...view.people.map((x: any) => `- ${x.name} (mens, ${x.role === 'guest' ? 'gast' : 'lid'}${x.accepted ? '' : ', uitgenodigd'})`),
    '',
  ];
  if (full && room.instructions.trim()) lines.push('## Groepsinstructies', '', room.instructions.trim(), '');
  lines.push('## Gesprek', '');
  transcript(lines, main);
  if (full && delegations.length) {
    lines.push('## Gedelegeerde taken', '');
    for (const d of delegations) lines.push(`- ${s.agentName(d.from_agent_id)} → ${s.agentName(d.to_agent_id)} (${d.kind}, ${DELEGATION_LABEL[d.status]}): ${d.task.replace(/\s+/g, ' ').slice(0, 200)}`);
    lines.push('');
  }
  for (const t of subs) {
    lines.push(`## Subgesprek: ${t.title}`, '');
    transcript(lines, ctx.store.messages(t.id, { limit: 100_000 }));
  }
  if (full && tasks.length) {
    lines.push('## Takenbord', '');
    for (const t of tasks) lines.push(`- [${TASK_LABEL[t.status]}] ${t.title}${t.owner_id ? ` · eigenaar ${t.owner_type === 'agent' ? s.agentName(t.owner_id) : s.userName(t.owner_id)}` : ''}${t.deadline ? ` · deadline ${t.deadline}` : ''}${t.result ? ` · resultaat: ${t.result.slice(0, 200)}` : ''}`);
    lines.push('');
  }
  if (full) {
    const l = s.ledger(room);
    lines.push('## Kosten per bot', '', '| Bot | Beurten | Tokens | Kosten (USD) |', '|---|---:|---:|---:|');
    for (const b of l.bots) lines.push(`| ${b.name} | ${b.runs} | ${b.tokens} | ${b.cost.toFixed(4)} |`);
    lines.push(`| **Totaal** | ${l.total.runs} | ${l.total.tokens} | ${l.total.cost.toFixed(4)} |`, '');
  }
  return lines.join('\n');
}
