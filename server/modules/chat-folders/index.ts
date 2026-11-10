import type { Ctx, Module } from '../../core/types.js';
import { ah, bad, notFound, str, user } from '../../core/http.js';
import { defineTable, newId, now } from '../../core/db.js';

/**
 * Mappen voor chats (PARITEIT 4.2): the owner files the rows of his chat list (a bot's conversation or a group) into
 * folders he names himself, per team. A folder belongs to one team; a chat only goes into a folder of its own team (a
 * bot by its home team, a group by the home teams of its bots). A chat without a known team fits every folder, as it is
 * visible in every team view. A group with its own team (`rooms.workspace_id`) belongs to that team only. Deleting a folder puts its chats back in the list; it never deletes a chat.
 *
 * A row in the list is one bot (its own conversation, whichever thread is the latest) or one group, so a folder holds
 * bots and groups (`kind` 'agent' | 'room'), not single threads: a new conversation with a bot stays in its folder.
 *
 * Routes (all the owner's own data): GET /chat-folders, POST /chat-folders, PATCH/DELETE /chat-folders/:id,
 * PUT /chat-folders/items. Event to every window and the paired phone: `chatFolders.changed`.
 */

export type ChatKind = 'agent' | 'room';

export interface ChatFolderRow {
  id: string;
  user_id: string;
  team_id: string | null;
  name: string;
  sort: number;
  collapsed: boolean;
  created_at: string;
  updated_at: string;
}

export interface ChatFolderView {
  id: string;
  teamId: string | null;
  name: string;
  sort: number;
  collapsed: boolean;
  items: { kind: ChatKind; id: string }[];
}

const MAX_FOLDERS = 100;

defineTable('chat_folders', { bool: ['collapsed'] });

const cleanName = (v: unknown) =>
  str(v, 200)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

const kindOf = (v: unknown): ChatKind => {
  if (v === 'agent' || v === 'room') return v;
  throw bad('Onbekend soort chat.');
};

export class ChatFolders {
  constructor(private ctx: Ctx) {}

  private teams() {
    return this.ctx.services.teams as undefined | { list(u: string): { id: string }[]; teamOf(a: string): string | null; defaultTeam(u: string): { id: string } | null; own(u: string, t: string): unknown };
  }

  private changed(userId: string) {
    this.ctx.events.emit(userId, 'chatFolders.changed', {});
  }

  private folder(userId: string, id: string): ChatFolderRow {
    const f = this.ctx.store.get<ChatFolderRow>('chat_folders', id);
    if (!f || f.user_id !== userId) throw notFound('Map niet gevonden');
    return f;
  }

  /**
   * The teams a chat belongs to: [] = no known team (fits every folder); null = not the owner's chat. A shared bot of
   * someone else is not yours to file.
   */
  itemTeams(userId: string, kind: ChatKind, id: string): string[] | null {
    const teams = this.teams();
    if (kind === 'agent') {
      const a = this.ctx.store.agent(id);
      if (!a || a.user_id !== userId) return null;
      const t = teams?.teamOf(a.id);
      return t ? [t] : [];
    }
    // A group: its own team (rooms.workspace_id, set by the groups module), else the home teams of its bots.
    let r: { id: string; user_id: string; workspace_id?: string | null } | undefined;
    let bots: { ref_id: string }[] = [];
    try {
      r = this.ctx.store.one<any>('SELECT * FROM rooms WHERE id = ?', id);
      if (r) bots = this.ctx.store.all<{ ref_id: string }>("SELECT ref_id FROM room_members WHERE room_id = ? AND kind = 'agent'", r.id);
    } catch {
      return null; // no groups module
    }
    if (!r || r.user_id !== userId) return null;
    if (!teams) return [];
    if (r.workspace_id && teams.list(userId).some((x) => x.id === r!.workspace_id)) return [r.workspace_id];
    return [...new Set(bots.map((b) => teams.teamOf(b.ref_id)).filter((t): t is string => !!t))];
  }

  private fits(folder: ChatFolderRow, teams: string[]) {
    return !folder.team_id || !teams.length || teams.includes(folder.team_id);
  }

  /** Every folder with its chats, in order. Chats that are gone or moved to another team drop out quietly. */
  list(userId: string): ChatFolderView[] {
    const store = this.ctx.store;
    const teams = this.teams();
    const known = teams ? new Set(teams.list(userId).map((t) => t.id)) : null;
    let folders = store.find<ChatFolderRow>('chat_folders', { user_id: userId }, { order: 'sort, created_at' });
    // A folder of a team that was removed: its chats go back to the list.
    const orphans = known ? folders.filter((f) => f.team_id && !known.has(f.team_id)) : [];
    if (orphans.length) {
      store.tx(() => {
        for (const f of orphans) {
          store.exec('DELETE FROM chat_folder_items WHERE folder_id = ?', f.id);
          store.exec('DELETE FROM chat_folders WHERE id = ?', f.id);
        }
      });
      folders = folders.filter((f) => !orphans.includes(f));
    }
    const byId = new Map(folders.map((f) => [f.id, f]));
    const items = new Map<string, { kind: ChatKind; id: string }[]>();
    const stale: { kind: string; ref_id: string }[] = [];
    for (const r of store.all<{ kind: ChatKind; ref_id: string; folder_id: string }>('SELECT kind, ref_id, folder_id FROM chat_folder_items WHERE user_id = ? ORDER BY created_at', userId)) {
      const f = byId.get(r.folder_id);
      const t = f ? this.itemTeams(userId, r.kind, r.ref_id) : null;
      if (!f || !t || !this.fits(f, t)) {
        stale.push(r);
        continue;
      }
      const list = items.get(f.id) || [];
      list.push({ kind: r.kind, id: r.ref_id });
      items.set(f.id, list);
    }
    for (const s of stale) store.exec('DELETE FROM chat_folder_items WHERE user_id = ? AND kind = ? AND ref_id = ?', userId, s.kind, s.ref_id);
    return folders.map((f) => ({ id: f.id, teamId: f.team_id, name: f.name, sort: f.sort, collapsed: !!f.collapsed, items: items.get(f.id) || [] }));
  }

  /**
   * A new folder. Its team: the team of the chat it is made for (`item`), else the team asked for (`teamId`), else the
   * default team. With `item` the chat moves in at once ("Nieuwe map…" in "Verplaats naar map").
   */
  create(userId: string, data: any): ChatFolderView {
    const name = cleanName(data?.name);
    if (!name) throw bad('Geef de map een naam.');
    const store = this.ctx.store;
    const n = store.one<{ n: number }>('SELECT COUNT(*) n FROM chat_folders WHERE user_id = ?', userId)?.n || 0;
    if (n >= MAX_FOLDERS) throw bad(`Je hebt het maximum van ${MAX_FOLDERS} mappen bereikt.`);
    const teams = this.teams();
    let teamId: string | null = null;
    let item: { kind: ChatKind; id: string } | null = null;
    if (data?.item) {
      item = { kind: kindOf(data.item.kind), id: str(data.item.id, 80) };
      const t = this.itemTeams(userId, item.kind, item.id);
      if (!t) throw notFound('Chat niet gevonden');
      teamId = t.length === 1 ? t[0] : null;
    }
    if (!teamId && typeof data?.teamId === 'string' && data.teamId && teams) {
      teams.own(userId, data.teamId);
      teamId = data.teamId;
    }
    if (!teamId && teams) teamId = teams.defaultTeam(userId)?.id || null;
    if (item) {
      const t = this.itemTeams(userId, item.kind, item.id)!;
      if (teamId && t.length && !t.includes(teamId)) throw bad('Deze chat hoort bij een ander team. Een map hoort bij één team.');
    }
    const same = store.one('SELECT 1 FROM chat_folders WHERE user_id = ? AND team_id IS ? AND lower(name) = lower(?)', userId, teamId, name);
    if (same) throw bad(`Er is al een map “${name}”.`);
    const ts = now();
    const sort = (store.one<{ m: number | null }>('SELECT MAX(sort) m FROM chat_folders WHERE user_id = ?', userId)?.m ?? 0) + 1;
    const row: ChatFolderRow = { id: newId('cf_'), user_id: userId, team_id: teamId, name, sort, collapsed: false, created_at: ts, updated_at: ts };
    store.tx(() => {
      store.insert('chat_folders', row);
      if (item) this.put(userId, item.kind, item.id, row.id);
    });
    this.ctx.audit(userId, 'chatFolder.created', { folderId: row.id, name });
    this.changed(userId);
    return this.list(userId).find((f) => f.id === row.id)!;
  }

  update(userId: string, id: string, data: any): ChatFolderView {
    const f = this.folder(userId, id);
    const patch: Partial<ChatFolderRow> = {};
    if (data?.name !== undefined) {
      const name = cleanName(data.name);
      if (!name) throw bad('Geef de map een naam.');
      if (this.ctx.store.one('SELECT 1 FROM chat_folders WHERE user_id = ? AND team_id IS ? AND lower(name) = lower(?) AND id != ?', userId, f.team_id, name, f.id)) throw bad(`Er is al een map “${name}”.`);
      patch.name = name;
    }
    if (data?.collapsed !== undefined) patch.collapsed = !!data.collapsed;
    if (data?.sort !== undefined && Number.isFinite(Number(data.sort))) patch.sort = Math.max(0, Math.min(1_000_000, Math.round(Number(data.sort))));
    if (Object.keys(patch).length) {
      this.ctx.store.update('chat_folders', f.id, { ...patch, updated_at: now() });
      this.changed(userId);
    }
    return this.list(userId).find((x) => x.id === f.id)!;
  }

  /** Delete a folder: its chats go back to the list (no chat is deleted). */
  remove(userId: string, id: string) {
    const f = this.folder(userId, id);
    const store = this.ctx.store;
    store.tx(() => {
      store.exec('DELETE FROM chat_folder_items WHERE folder_id = ? AND user_id = ?', f.id, userId);
      store.exec('DELETE FROM chat_folders WHERE id = ?', f.id);
    });
    this.ctx.audit(userId, 'chatFolder.deleted', { folderId: f.id, name: f.name });
    this.changed(userId);
    return { ok: true };
  }

  private put(userId: string, kind: ChatKind, refId: string, folderId: string | null) {
    const store = this.ctx.store;
    store.exec('DELETE FROM chat_folder_items WHERE user_id = ? AND kind = ? AND ref_id = ?', userId, kind, refId);
    if (folderId) store.exec('INSERT INTO chat_folder_items (user_id, kind, ref_id, folder_id, created_at) VALUES (?, ?, ?, ?, ?)', userId, kind, refId, folderId, now());
  }

  /** Move a chat into a folder of its own team, or out of its folder (`folderId: null`). */
  move(userId: string, data: any) {
    const kind = kindOf(data?.kind);
    const id = str(data?.id, 80);
    const t = this.itemTeams(userId, kind, id);
    if (!t) throw notFound('Chat niet gevonden');
    const folderId = data?.folderId ? str(data.folderId, 80) : null;
    if (folderId) {
      const f = this.folder(userId, folderId);
      if (!this.fits(f, t)) throw bad('Deze chat hoort bij een ander team. Een map hoort bij één team.');
    }
    this.put(userId, kind, id, folderId);
    this.changed(userId);
    return { ok: true, folderId };
  }

  forget(userId: string, kind: ChatKind, refId: string) {
    const r = this.ctx.store.exec('DELETE FROM chat_folder_items WHERE user_id = ? AND kind = ? AND ref_id = ?', userId, kind, refId) as any;
    if (r?.changes) this.changed(userId);
  }

  exportUser(userId: string) {
    return { folders: this.list(userId) };
  }
}

const mod: Module = {
  id: 'chat-folders',
  label: 'Mappen voor chats',
  migrations: [
    {
      id: 'chat-folders-001',
      sql: `
CREATE TABLE chat_folders (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, team_id TEXT, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
  collapsed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX chat_folders_user ON chat_folders(user_id);
CREATE TABLE chat_folder_items (
  user_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL, folder_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, ref_id)
);
CREATE INDEX chat_folder_items_folder ON chat_folder_items(folder_id);
`,
    },
  ],
  init(ctx: Ctx) {
    const svc = new ChatFolders(ctx);
    ctx.services.chatFolders = { list: (u: string) => svc.list(u), move: (u: string, d: any) => svc.move(u, d), exportUser: (u: string) => svc.exportUser(u) };
    const p = (req: any, k: string) => str(req.params[k], 80);
    ctx.api.get('/chat-folders', ah(async (req) => ({ folders: svc.list(user(req).id) })));
    ctx.api.post('/chat-folders', ah(async (req) => svc.create(user(req).id, req.body || {})));
    ctx.api.put('/chat-folders/items', ah(async (req) => svc.move(user(req).id, req.body || {})));
    ctx.api.patch('/chat-folders/:id', ah(async (req) => svc.update(user(req).id, p(req, 'id'), req.body || {})));
    ctx.api.delete('/chat-folders/:id', ah(async (req) => svc.remove(user(req).id, p(req, 'id'))));
    ctx.hooks.agentDeleted.push(({ agentId, userId }) => svc.forget(userId, 'agent', agentId));
  },
};

export default mod;
