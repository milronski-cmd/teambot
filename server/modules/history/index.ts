import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx, Module } from '../../core/types.js';
import { ah, forbidden, notFound, own, user } from '../../core/http.js';
import { defineTable, newId, now } from '../../core/db.js';
import { previewPurge, purgeConversations, type PurgeScope } from './purge.js';

/**
 * "Geschiedenis wissen" for one bot or one group (OpenBot 0.64 parity): the conversations go (messages, their files
 * and what TeamBot derived from them, see purge.ts); the bot or group itself, memories, routines and tasks stay.
 *
 * - GET    /agents/:id/history  and  /rooms/:id/history  → what goes and what stays, with counts (confirm dialog)
 * - DELETE /agents/:id/history  and  /rooms/:id/history  → delete
 *
 * Only for the owner of the bot or group; on a server only for the owner of the installation (it also decides about
 * backups). Every deletion is kept in `history_purges`: after restoring an older backup it is applied again at start,
 * like forgotten memory stays forgotten (modules/backups/restore.ts carries the rows over the restore).
 */

defineTable('history_purges', {});

/** File in the data folder with the deletions from before a restore (written by applyPendingRestore). */
export const RESTORE_FILE = 'restore-history.json';

interface PurgeRow {
  id: string;
  user_id: string;
  scope: 'agent' | 'room';
  ref_id: string;
  label: string;
  before: string;
  created_at: string;
}

const count = (ctx: Ctx, sql: string, ...p: any[]) => {
  try {
    return Number(ctx.store.one<{ n: number }>(sql, ...p)?.n || 0);
  } catch {
    return 0;
  }
};

/** The bot's own conversations (1:1 chats, routine, channel and subtask conversations; never its groups). */
function botScope(ctx: Ctx, a: Agent, before?: string): PurgeScope {
  const rows = ctx.store.all<{ id: string }>(
    `SELECT id FROM threads WHERE agent_id = ? AND user_id = ? AND room_id IS NULL AND kind != 'room'${before ? ' AND created_at <= ?' : ''}`,
    ...(before ? [a.id, a.user_id, before] : [a.id, a.user_id]),
  );
  return { ownerId: a.user_id, threadIds: rows.map((r) => r.id), before };
}

/** A group's conversations: its own conversation (emptied, it stays) and the conversations between its bots. */
function roomScope(ctx: Ctx, room: any, before?: string): PurgeScope {
  const rows = ctx.store.all<{ id: string }>(`SELECT id FROM threads WHERE room_id = ? AND id != ?${before ? ' AND created_at <= ?' : ''}`, ...(before ? [room.id, room.thread_id, before] : [room.id, room.thread_id]));
  return { ownerId: room.user_id, threadIds: rows.map((r) => r.id), keepThreadId: room.thread_id, before };
}

const roomPeople = (ctx: Ctx, roomId: string) => {
  try {
    return ctx.store.all<{ ref_id: string }>("SELECT ref_id FROM room_members WHERE room_id = ? AND kind = 'user' AND accepted = 1", roomId).map((r) => r.ref_id);
  } catch {
    return [];
  }
};

function countFiles(dir: string): number {
  try {
    return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).length;
  } catch {
    return 0;
  }
}

function record(ctx: Ctx, r: Omit<PurgeRow, 'id' | 'created_at'>) {
  ctx.store.insert('history_purges', { id: newId('hp_'), ...r, created_at: now() });
}

/** After a backup restore: the deletions from before it are applied again (and kept for the next restore). */
async function reapplyAfterRestore(ctx: Ctx) {
  const file = path.join(ctx.config.dataDir, RESTORE_FILE);
  if (!fs.existsSync(file)) return;
  try {
    const rows: PurgeRow[] = JSON.parse(fs.readFileSync(file, 'utf8'));
    let threads = 0;
    let messages = 0;
    for (const r of rows) {
      ctx.store.exec('INSERT OR IGNORE INTO history_purges (id, user_id, scope, ref_id, label, before, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', r.id, r.user_id, r.scope, r.ref_id, r.label || '', r.before, r.created_at);
      let scope: PurgeScope | null = null;
      if (r.scope === 'agent') {
        const a = ctx.store.agent(r.ref_id);
        if (a && a.user_id === r.user_id) scope = botScope(ctx, a, r.before);
      } else {
        const room = (() => {
          try {
            return ctx.store.get<any>('rooms', r.ref_id);
          } catch {
            return null;
          }
        })();
        if (room && room.user_id === r.user_id) scope = roomScope(ctx, room, r.before);
      }
      if (!scope) continue;
      const before = previewPurge(ctx, scope);
      if (!before.threads && !before.messages && !before.files) continue;
      const c = await purgeConversations(ctx, scope, [r.user_id, ...(r.scope === 'room' ? roomPeople(ctx, r.ref_id).filter((id) => id !== r.user_id) : [])], 'Geschiedenis opnieuw gewist na terugzetten');
      threads += c.threads;
      messages += c.messages;
      ctx.audit(r.user_id, 'history.reapplied', { scope: r.scope, name: r.label, threads: c.threads, messages: c.messages, files: c.files }, r.scope === 'agent' ? r.ref_id : null);
    }
    fs.rmSync(file, { force: true });
    if (rows.length) ctx.log.info(`[history] na terugzetten: ${rows.length} gewiste geschiedenissen opnieuw toegepast (${threads} gesprekken, ${messages} berichten)`);
  } catch (e) {
    ctx.log.error('[history] gewiste geschiedenis na terugzetten opnieuw toepassen mislukt (bestand blijft staan voor een volgende poging)', e);
  }
}

const mod: Module = {
  id: 'history',
  label: 'Geschiedenis wissen',
  migrations: [
    {
      id: 'history-001',
      sql: `CREATE TABLE history_purges (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, scope TEXT NOT NULL, ref_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
        before TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX history_purges_ref ON history_purges(scope, ref_id);`,
    },
  ],

  init(ctx) {
    const api = ctx.api;
    /** On a server only the owner of the installation; on a desktop the local user is that owner. */
    const ownerOnly = (req: any) => {
      const u = user(req);
      if (ctx.config.mode === 'server' && u.role !== 'owner') throw forbidden('Alleen de eigenaar van deze TeamBot-server kan de geschiedenis van een bot of groep wissen.');
      return u;
    };
    const backups = () => {
      try {
        return ctx.services.backups?.list?.().length || 0;
      } catch {
        return 0;
      }
    };
    const roomOf = (req: any) => {
      const u = user(req);
      let room: any = null;
      try {
        room = ctx.store.get<any>('rooms', String(req.params.id));
      } catch {
        /* groups module off */
      }
      if (!room) throw notFound('Groep niet gevonden');
      if (room.user_id !== u.id) {
        if (roomPeople(ctx, room.id).includes(u.id)) throw forbidden('Alleen de eigenaar van de groep kan de geschiedenis wissen.');
        throw notFound('Groep niet gevonden');
      }
      return room;
    };

    api.get(
      '/agents/:id/history',
      ah(async (req) => {
        ownerOnly(req);
        const a = own(req, ctx.store.agent(String(req.params.id)), 'Bot niet gevonden');
        return {
          name: a.name,
          ...previewPurge(ctx, botScope(ctx, a)),
          stays: {
            memories: count(ctx, "SELECT COUNT(*) n FROM memory_items WHERE user_id = ? AND scope = 'agent' AND agent_id = ? AND status IN ('active','proposed','archived')", a.user_id, a.id),
            routines: count(ctx, 'SELECT COUNT(*) n FROM routines WHERE user_id = ? AND agent_id = ?', a.user_id, a.id),
            tasks: count(ctx, "SELECT COUNT(*) n FROM room_tasks WHERE owner_type = 'agent' AND owner_id = ?", a.id),
            groups: count(ctx, "SELECT COUNT(DISTINCT room_id) n FROM room_members WHERE kind = 'agent' AND ref_id = ?", a.id),
            channels: count(ctx, 'SELECT COUNT(*) n FROM channel_bindings WHERE user_id = ? AND agent_id = ?', a.user_id, a.id),
            // A shared bot (server): the conversations team members had with it are theirs and stay.
            others: count(ctx, 'SELECT COUNT(*) n FROM threads WHERE agent_id = ? AND user_id != ? AND room_id IS NULL', a.id, a.user_id),
            workspace: a.workspace,
          },
          backups: backups(),
        };
      }),
    );

    api.delete(
      '/agents/:id/history',
      ah(async (req) => {
        const u = ownerOnly(req);
        const a = own(req, ctx.store.agent(String(req.params.id)), 'Bot niet gevonden');
        const at = now();
        const c = await purgeConversations(ctx, botScope(ctx, a));
        record(ctx, { user_id: a.user_id, scope: 'agent', ref_id: a.id, label: a.name, before: at });
        ctx.audit(u.id, 'history.deleted', { scope: 'agent', name: a.name, threads: c.threads, messages: c.messages, files: c.files }, a.id);
        return { ok: true, ...c };
      }),
    );

    api.get(
      '/rooms/:id/history',
      ah(async (req) => {
        ownerOnly(req);
        const room = roomOf(req);
        const people = roomPeople(ctx, room.id).filter((id) => id !== room.user_id);
        return {
          name: room.name,
          ...previewPurge(ctx, roomScope(ctx, room)),
          stays: {
            bots: count(ctx, "SELECT COUNT(*) n FROM room_members WHERE room_id = ? AND kind = 'agent'", room.id),
            tasks: count(ctx, 'SELECT COUNT(*) n FROM room_tasks WHERE room_id = ?', room.id),
            files: countFiles(path.join(ctx.config.dataDir, 'rooms', room.id, 'files')),
            people: people.length,
          },
          backups: backups(),
        };
      }),
    );

    api.delete(
      '/rooms/:id/history',
      ah(async (req) => {
        const u = ownerOnly(req);
        const room = roomOf(req);
        const at = now();
        const audience = [room.user_id, ...roomPeople(ctx, room.id).filter((id) => id !== room.user_id)];
        const c = await purgeConversations(ctx, roomScope(ctx, room), audience);
        record(ctx, { user_id: room.user_id, scope: 'room', ref_id: room.id, label: room.name, before: at });
        ctx.audit(u.id, 'history.deleted', { scope: 'room', name: room.name, threads: c.threads, messages: c.messages, files: c.files });
        for (const uid of audience) ctx.events.emit(uid, 'rooms.changed', { roomId: room.id });
        return { ok: true, ...c };
      }),
    );

    // A deleted bot or group needs no restore rule anymore.
    ctx.hooks.agentDeleted.push(({ agentId }) => {
      try {
        ctx.store.exec("DELETE FROM history_purges WHERE scope = 'agent' AND ref_id = ?", agentId);
      } catch {
        /* table missing */
      }
    });
  },

  async start(ctx) {
    await reapplyAfterRestore(ctx);
  },
};

export default mod;
