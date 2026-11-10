import type { Ctx, Module } from '../../core/types.js';
import { roomMigrations } from './schema.js';
import { RoomService } from './service.js';
import { Orchestrator } from './orchestration.js';
import { Board } from './board.js';
import { roomTools, teamTools } from './tools.js';
import { roomRoutes } from './routes.js';
import { systemPromptFor, turnContextFor } from './prompt.js';
import { installTeam, normalizeTeam } from './packages.js';
import { backfillRooms, memberRefusal, roomTeam } from './walls.js';

/** One service per app instance (tests start several apps in one process). */
const instances = new WeakMap<Ctx, RoomService>();

/**
 * Groepen & teams: group chats (rooms) with several bots and people, modes (lead / om de beurt / iedereen /
 * alleen op vermelding), delegation/broadcast/handoff/bot-to-bot tools with caps and cycle detection,
 * stop/resume per bot or room, cost ledger, teams with hierarchy, task board, hire proposals, shared files.
 */
const mod: Module = {
  id: 'rooms',
  label: 'Groepen & teams',
  migrations: roomMigrations,
  init(ctx: Ctx) {
    const s = new RoomService(ctx);
    s.orch = new Orchestrator(s);
    const board = new Board(s);
    instances.set(ctx, s);

    ctx.tools.registerGroup({ id: 'team', label: 'Team & samenwerking', description: 'Werk delegeren, overdragen, andere bots berichten, takenbord en groepsbestanden', defaultOn: true });
    for (const t of teamTools(s, board)) ctx.tools.register(t);
    ctx.tools.addProvider((agent, thread) => roomTools(s, board, agent, thread));

    // A second look that waited for a usage limit ran later (quality module): the task follows its outcome, as on
    // task_done (klaar, or geblokkeerd for "kon niet"). Only a task that still waits as "te controleren".
    (ctx.services.qualityRechecked ||= {}).room = ({ ref, agent, verdict }: { ref: string; agent: { id: string; name: string }; verdict: { state: string } }) => {
      const t = board.task(ref);
      if (!t || t.status !== 'review') return;
      const status = verdict.state === 'passed' || verdict.state === 'skipped' ? 'done' : verdict.state === 'cant' ? 'blocked' : null;
      if (status) board.updateTask(t, { status }, { type: 'agent', id: agent.id, name: agent.name }, { verified: true });
    };

    ctx.hooks.route.push(async ({ message, thread }) => {
      // Only the owner may write in a sub-task (delegation) thread; room members can read along but not steer the
      // owner's delegated bot from there.
      if (thread.kind === 'delegation' && message.author_type === 'user' && message.author_id !== thread.user_id) {
        s.event(thread, 'Alleen de eigenaar van de groep kan in een subtaak schrijven. Reageer in het groepsgesprek.', { kind: 'room_hint' });
        return true;
      }
      if (thread.kind === 'delegation' && thread.meta?.dm) {
        s.event(thread, 'Dit is een bot-tot-botgesprek (alleen-lezen).', { kind: 'room_hint' });
        return true;
      }
      // A chat-app conversation (channels module) bound to a group is answered by the group, in that conversation.
      if (thread.kind === 'channel' && thread.room_id) {
        const room = s.room(thread.room_id);
        if (!room || room.user_id !== thread.user_id) return false;
        s.onHumanMessage(room, ctx.store.thread(thread.id) || thread, message);
        return true;
      }
      if (thread.kind !== 'room') return false;
      const room = s.roomForThread(thread);
      if (!room || room.thread_id !== thread.id) return false;
      s.onHumanMessage(room, ctx.store.thread(thread.id) || thread, message);
      return true;
    });
    ctx.hooks.systemPrompt.push(({ agent, thread }) => systemPromptFor(s, board, agent, thread));
    ctx.hooks.turnContext.push(({ agent, thread, input }) => turnContextFor(s, agent, thread, input));
    ctx.hooks.agentDeleted.push(({ agentId }) => {
      for (const r of ctx.store.all<any>("SELECT room_id FROM room_members WHERE kind = 'agent' AND ref_id = ?", agentId)) {
        const room = s.room(r.room_id);
        if (room) s.removeBot(room, agentId, 'verwijderd (bot bestaat niet meer)');
      }
      ctx.store.exec('DELETE FROM room_team_members WHERE agent_id = ?', agentId);
      ctx.store.exec('UPDATE room_team_members SET reports_to = NULL WHERE reports_to = ?', agentId);
      ctx.store.exec('UPDATE room_teams SET chief_agent_id = NULL WHERE chief_agent_id = ?', agentId);
      ctx.store.exec("UPDATE room_tasks SET owner_type = NULL, owner_id = NULL WHERE owner_type = 'agent' AND owner_id = ?", agentId);
    });

    roomRoutes(ctx, s, board);

    ctx.services.rooms = {
      roomForThread: (t: any) => s.roomForThread(t),
      /** The team (module teams) a group belongs to, or null. */
      teamOf: (roomId: string) => {
        const r = s.room(roomId);
        return r ? roomTeam(s, r) : null;
      },
      /** Is this bot a member of the group, and may it still take part (its access to the group's team)? */
      botTakesPart: (roomId: string, agentId: string) => {
        const r = s.room(roomId);
        return !!r && !!s.botMember(r, agentId) && !memberRefusal(s, r, agentId);
      },
      access: (roomId: string, userId: string) => s.access(s.room(roomId), userId),
      ledger: (roomId: string) => {
        const r = s.room(roomId);
        return r ? s.ledger(r) : null;
      },
      stopRoom: (roomId: string, reason: string) => {
        const r = s.room(roomId);
        return r ? s.stopRoom(r, null, reason) : 0;
      },
      /** Active rooms of a user (pickers, e.g. the SCIM group mapping). */
      roomsOf: (userId: string) =>
        ctx.store
          .find<any>('rooms', { user_id: userId }, { order: 'name' })
          .filter((r) => !r.archived)
          .map((r) => ({ id: r.id as string, name: r.name as string })),
      /** Add a person to a room as accepted member; `byUserId` must own the room. */
      addPerson: (roomId: string, userId: string, byUserId: string) => {
        const r = s.room(roomId);
        if (!r || r.archived || r.user_id !== byUserId) return 'skipped' as const;
        return s.grantPerson(r, byUserId, userId);
      },
      /** Remove a person from a room (no-op when not a member). */
      removePerson: (roomId: string, userId: string, byUserId: string) => {
        const r = s.room(roomId);
        if (!r || !ctx.store.one("SELECT id FROM room_members WHERE room_id = ? AND kind = 'user' AND ref_id = ?", r.id, userId)) return false;
        s.removePerson(r, userId, byUserId);
        return true;
      },
      /** Remove a person from every room they joined (account removal). */
      removePersonEverywhere: (userId: string) => {
        const ids = ctx.store.all<{ room_id: string }>("SELECT room_id FROM room_members WHERE kind = 'user' AND ref_id = ?", userId).map((x) => x.room_id);
        for (const id of ids) {
          const r = s.room(id);
          if (r) s.removePerson(r, userId, r.user_id);
        }
        return ids.length;
      },
      /** Install a team package (bots + group) for a user, as POST /rooms/packages/install does (team templates). */
      installTeam: (userId: string, pkg: any, o?: { provider_id?: string | null; model?: string; name?: string; acknowledge?: boolean }) => installTeam(ctx, s, userId, normalizeTeam(pkg), o),
      /** Included in the full user export (GET /api/export). */
      exportUser(userId: string) {
        const rooms = ctx.store.find<any>('rooms', { user_id: userId });
        const ids = rooms.map((r) => r.id);
        const q = ids.map(() => '?').join(',');
        return {
          rooms: {
            rooms,
            members: ids.length ? ctx.store.all(`SELECT * FROM room_members WHERE room_id IN (${q})`, ...ids) : [],
            delegations: ctx.store.find('room_delegations', { user_id: userId }),
            tasks: ctx.store.find('room_tasks', { user_id: userId }),
            teams: ctx.store.find('room_teams', { user_id: userId }),
            teamMembers: ctx.store.all('SELECT tm.* FROM room_team_members tm JOIN room_teams t ON t.id = tm.team_id WHERE t.user_id = ?', userId),
            proposals: ctx.store.find('room_proposals', { user_id: userId }),
          },
        };
      },
    };
  },
  start(ctx: Ctx) {
    const s = instances.get(ctx);
    if (!s) return;
    // Teams (walls.ts): every group from before teams belongs to the team of its bots.
    try {
      backfillRooms(s);
    } catch (e) {
      ctx.log.error('[rooms] team backfill failed', e);
    }
    s.subscribe();
    s.reconcile();
  },
  stop(ctx: Ctx) {
    instances.get(ctx)?.unsubscribe();
  },
};
export default mod;
