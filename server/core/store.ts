import path from 'node:path';
import fs from 'node:fs';
import { type DB, all, get, run, insert, update, getById, find, remove, newId, now, decodeRow, tx } from './db.js';
import type { Agent, Message, Run, Thread, User } from './types.js';

/** Repository layer over SQLite. Modules may use the generic helpers for their own tables. */
export class Store {
  constructor(public db: DB, private dataDir: string) {}

  // ---- generic ----
  insert<T = any>(table: string, obj: Record<string, any>): T {
    return insert<T>(this.db, table, obj);
  }
  update(table: string, id: string | number, patch: Record<string, any>, idCol = 'id') {
    update(this.db, table, id, patch, idCol);
  }
  get<T = any>(table: string, id: string | number, idCol = 'id'): T | null {
    return getById<T>(this.db, table, id, idCol);
  }
  find<T = any>(table: string, where: Record<string, any> = {}, opts: { order?: string; limit?: number } = {}): T[] {
    return find<T>(this.db, table, where, opts);
  }
  remove(table: string, id: string | number, idCol = 'id') {
    remove(this.db, table, id, idCol);
  }
  all<T = any>(sql: string, ...params: any[]): T[] {
    return all<T>(this.db, sql, ...params);
  }
  one<T = any>(sql: string, ...params: any[]): T | undefined {
    return get<T>(this.db, sql, ...params);
  }
  exec(sql: string, ...params: any[]) {
    return run(this.db, sql, ...params);
  }
  tx<T>(fn: () => T): T {
    return tx(this.db, fn);
  }
  /** Is there a table with this name (a module that is off has none)? */
  hasTable(name: string): boolean {
    return !!this.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name);
  }
  decode<T = any>(table: string, row: any): T {
    return decodeRow<T>(table, row);
  }

  // ---- users & settings ----
  user(id: string): User | null {
    const u = this.get<any>('users', id);
    if (!u) return null;
    delete u.password_hash;
    return u;
  }
  users(): User[] {
    return this.find<any>('users', {}, { order: 'created_at' }).map((u) => {
      delete u.password_hash;
      return u;
    });
  }
  getSetting<T = any>(userId: string, key: string, def: T): T {
    const r = get<{ value: string }>(this.db, 'SELECT value FROM settings WHERE user_id = ? AND key = ?', userId, key);
    if (!r) return def;
    try {
      return JSON.parse(r.value);
    } catch {
      return def;
    }
  }
  setSetting(userId: string, key: string, value: any) {
    run(this.db, 'INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value', userId, key, JSON.stringify(value));
  }
  settings(userId: string): Record<string, any> {
    const out: Record<string, any> = {};
    for (const r of all<{ key: string; value: string }>(this.db, 'SELECT key, value FROM settings WHERE user_id = ?', userId)) {
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  // ---- agents ----
  agent(id: string | null | undefined): Agent | null {
    return id ? this.get<Agent>('agents', id) : null;
  }
  agents(userId: string, opts: { archived?: boolean } = {}): Agent[] {
    const rows = all(this.db, `SELECT * FROM agents WHERE user_id = ? ${opts.archived ? '' : 'AND archived = 0'} ORDER BY pinned DESC, sort, created_at`, userId);
    return rows.map((r) => decodeRow<Agent>('agents', r));
  }
  defaultWorkspace(agentId: string) {
    return path.join(this.dataDir, 'workspaces', agentId);
  }
  /**
   * What a new bot gets where the caller leaves it out (access, parts): set by app.ts to agent/new-bot.ts, the one
   * place for those defaults. Without it (a bare Store in a unit test) the careful fallback below applies.
   */
  agentDefaults: ((userId: string, data: Partial<Agent>) => Partial<Agent>) | null = null;
  /** Called once a bot is stored, with what the caller asked for (app.ts logs a start at "Volledige toegang"). */
  agentCreated: ((agent: Agent, asked: Partial<Agent>) => void) | null = null;
  createAgent(userId: string, input: Partial<Agent>): Agent {
    const data = this.agentDefaults ? this.agentDefaults(userId, input) : input;
    const id = data.id || newId('ag_');
    const ts = now();
    const a: Agent = {
      id,
      user_id: userId,
      name: data.name?.trim() || 'Nieuwe bot',
      avatar: data.avatar || '',
      color: data.color || '#6366f1',
      role: data.role || '',
      description: data.description || '',
      instructions: data.instructions || '',
      provider_id: data.provider_id ?? null,
      model: data.model || '',
      reasoning: data.reasoning || '',
      access_mode: data.access_mode || 'ask',
      workspace: data.workspace || this.defaultWorkspace(id),
      // 'browser': every new bot has its own browser, so the owner can watch along from the first chat (the globe in the chat header).
      tool_groups: data.tool_groups || ['files', 'web', 'browser', 'memory', 'team', 'skills', 'routines'],
      tool_policy: data.tool_policy || {},
      skills: data.skills || [],
      fallback: data.fallback ?? null,
      busy_policy: data.busy_policy || 'queue',
      settings: data.settings || {},
      pinned: !!data.pinned,
      archived: false,
      sort: data.sort ?? 0,
      created_at: ts,
      updated_at: ts,
    };
    fs.mkdirSync(a.workspace, { recursive: true });
    this.insert('agents', a);
    this.agentCreated?.(a, input);
    return a;
  }
  updateAgent(id: string, patch: Partial<Agent>): Agent {
    const p: any = { ...patch, updated_at: now() };
    delete p.id;
    delete p.user_id;
    delete p.created_at;
    this.update('agents', id, p);
    const a = this.agent(id)!;
    if (a.workspace) fs.mkdirSync(a.workspace, { recursive: true });
    return a;
  }
  deleteAgent(id: string) {
    this.tx(() => {
      for (const t of all<{ id: string }>(this.db, "SELECT id FROM threads WHERE agent_id = ? AND room_id IS NULL", id)) this.deleteThread(t.id);
      this.remove('agents', id);
    });
  }

  // ---- threads ----
  thread(id: string | null | undefined): Thread | null {
    return id ? this.get<Thread>('threads', id) : null;
  }
  threads(userId: string, f: { agentId?: string; roomId?: string; kind?: string; archived?: boolean; limit?: number; parentId?: string } = {}): Thread[] {
    const where: string[] = ['user_id = ?'];
    const params: any[] = [userId];
    if (f.agentId) (where.push('agent_id = ?'), params.push(f.agentId));
    if (f.roomId) (where.push('room_id = ?'), params.push(f.roomId));
    if (f.kind) (where.push('kind = ?'), params.push(f.kind));
    if (f.parentId) (where.push('parent_id = ?'), params.push(f.parentId));
    if (!f.archived) where.push('archived = 0');
    const rows = all(this.db, `SELECT * FROM threads WHERE ${where.join(' AND ')} ORDER BY pinned DESC, updated_at DESC LIMIT ${Number(f.limit || 200)}`, ...params);
    return rows.map((r) => decodeRow<Thread>('threads', r));
  }
  createThread(data: Partial<Thread> & { user_id: string }): Thread {
    const ts = now();
    const t: Thread = {
      id: data.id || newId('th_'),
      user_id: data.user_id,
      agent_id: data.agent_id ?? null,
      room_id: data.room_id ?? null,
      kind: data.kind || 'chat',
      title: data.title || '',
      parent_id: data.parent_id ?? null,
      provider_state: data.provider_state || {},
      meta: data.meta || {},
      pinned: !!data.pinned,
      archived: false,
      created_at: ts,
      updated_at: ts,
    };
    this.insert('threads', t);
    return t;
  }
  updateThread(id: string, patch: Partial<Thread>): Thread {
    this.update('threads', id, { ...patch, updated_at: now() });
    return this.thread(id)!;
  }
  deleteThread(id: string) {
    this.tx(() => {
      run(this.db, 'DELETE FROM messages_fts WHERE rowid IN (SELECT rid FROM messages_fts_map WHERE thread_id = ?)', id);
      run(this.db, 'DELETE FROM messages_fts_map WHERE thread_id = ?', id);
      run(this.db, 'DELETE FROM messages WHERE thread_id = ?', id);
      run(this.db, 'DELETE FROM runs WHERE thread_id = ?', id);
      this.remove('threads', id);
    });
  }

  // ---- messages ----
  message(id: string | null | undefined): Message | null {
    return id ? this.get<Message>('messages', id) : null;
  }
  messages(threadId: string, opts: { limit?: number; beforeSeq?: number; includeDeleted?: boolean } = {}): Message[] {
    const limit = Number(opts.limit || 500);
    const rows = all(
      this.db,
      `SELECT * FROM (SELECT * FROM messages WHERE thread_id = ? ${opts.includeDeleted ? '' : 'AND deleted = 0'} ${opts.beforeSeq ? 'AND seq < ' + Number(opts.beforeSeq) : ''} ORDER BY seq DESC LIMIT ${limit}) ORDER BY seq ASC`,
      threadId,
    );
    return rows.map((r) => decodeRow<Message>('messages', r));
  }
  lastMessage(threadId: string): Message | null {
    const r = get(this.db, 'SELECT * FROM messages WHERE thread_id = ? AND deleted = 0 ORDER BY seq DESC LIMIT 1', threadId);
    return r ? decodeRow<Message>('messages', r) : null;
  }
  createMessage(data: Partial<Message> & { thread_id: string; role: Message['role']; author_type: Message['author_type'] }): Message {
    return this.tx(() => {
      const seq = (get<{ s: number }>(this.db, 'SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM messages WHERE thread_id = ?', data.thread_id)?.s ?? 1) as number;
      const m: Message = {
        id: data.id || newId('msg_'),
        thread_id: data.thread_id,
        seq,
        role: data.role,
        author_type: data.author_type,
        author_id: data.author_id ?? null,
        author_name: data.author_name || '',
        content: data.content || '',
        parts: data.parts || {},
        run_id: data.run_id ?? null,
        status: data.status || 'done',
        usage: data.usage ?? null,
        reply_to: data.reply_to ?? null,
        reactions: data.reactions || {},
        pinned: false,
        deleted: false,
        created_at: now(),
        edited_at: null,
      };
      this.insert('messages', m);
      run(this.db, 'UPDATE threads SET updated_at = ? WHERE id = ?', m.created_at, m.thread_id);
      this.indexMessage(m);
      return m;
    });
  }
  updateMessage(id: string, patch: Partial<Message>): Message {
    this.update('messages', id, patch);
    const m = this.message(id)!;
    if (patch.content !== undefined || patch.deleted !== undefined) this.indexMessage(m);
    return m;
  }
  private indexMessage(m: Message) {
    // Via the rowid map: message_id is not indexed inside FTS5 (a lookup by it scans the whole index).
    const old = get<{ rid: number }>(this.db, 'SELECT rid FROM messages_fts_map WHERE message_id = ?', m.id);
    if (old) {
      run(this.db, 'DELETE FROM messages_fts WHERE rowid = ?', old.rid);
      run(this.db, 'DELETE FROM messages_fts_map WHERE message_id = ?', m.id);
    }
    if (m.deleted || !m.content || (m.role !== 'user' && m.role !== 'assistant')) return;
    const t = get<{ user_id: string }>(this.db, 'SELECT user_id FROM threads WHERE id = ?', m.thread_id);
    if (!t) return;
    this.tx(() => {
      run(this.db, 'INSERT INTO messages_fts (content, message_id, thread_id, user_id) VALUES (?, ?, ?, ?)', m.content, m.id, m.thread_id, t.user_id);
      run(this.db, 'INSERT INTO messages_fts_map (message_id, rid, thread_id) VALUES (?, last_insert_rowid(), ?)', m.id, m.thread_id);
    });
  }
  search(userId: string, q: string, limit = 50) {
    const query = q
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => '"' + w.replace(/"/g, '""') + '"')
      .join(' ');
    if (!query) return [];
    return all(
      this.db,
      `SELECT f.message_id, f.thread_id, snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet, t.title, t.agent_id, t.room_id, m.created_at, m.author_name
       FROM messages_fts f JOIN threads t ON t.id = f.thread_id JOIN messages m ON m.id = f.message_id
       WHERE messages_fts MATCH ? AND f.user_id = ? ORDER BY rank LIMIT ?`,
      query,
      userId,
      limit,
    );
  }

  // ---- runs ----
  run(id: string): Run | null {
    return this.get<Run>('runs', id);
  }
  createRun(data: Partial<Run> & { thread_id: string; agent_id: string; user_id: string }): Run {
    const r: Run = {
      id: data.id || newId('run_'),
      thread_id: data.thread_id,
      agent_id: data.agent_id,
      user_id: data.user_id,
      status: data.status || 'queued',
      trigger: data.trigger || 'user',
      input_message_id: data.input_message_id ?? null,
      error: null,
      usage: { input: 0, output: 0 },
      meta: data.meta || {},
      created_at: now(),
      started_at: null,
      finished_at: null,
    };
    this.insert('runs', r);
    return r;
  }
  updateRun(id: string, patch: Partial<Run>): Run {
    this.update('runs', id, patch);
    return this.run(id)!;
  }
  runsByStatus(statuses: string[]): Run[] {
    return all(this.db, `SELECT * FROM runs WHERE status IN (${statuses.map(() => '?').join(',')})`, ...statuses).map((r) => decodeRow<Run>('runs', r));
  }
}
