/**
 * Deleting the conversations of one bot or one group ("Geschiedenis wissen"): the messages, their attachments and
 * everything TeamBot derived from those conversations, while the setup (bot, group, members, instructions), memories,
 * routines and tasks stay.
 *
 * What goes, per conversation:
 * - messages (with the search index), runs, queued messages, approval cards and question cards of the conversation;
 * - attachments (files the user sent, files and pages the bot showed) on disk and in the database, their copies in
 *   the bots' `uploads` folders, voice-memo transcripts, spoken versions of messages and live-call transcripts;
 * - engine sessions (Claude Code, Codex, ACP), so a bot never resumes a session that still remembers the conversation;
 * - finished subtasks between bots, the conversation summaries in memory (episodes, via `thread.deleted` /
 *   `thread.cleared`) and the context-usage numbers.
 * What stays: memories (also when their source was one of these messages), dossiers and their sources, routines and
 * their run log, tasks on the board, the group's shared files, the bots' workspaces, the audit log and step logs, costs.
 * An attachment that is still used elsewhere (forwarded into a conversation that stays, or a dossier source) stays.
 *
 * A group keeps its own conversation (the room needs it): that one is emptied instead of deleted. Afterwards the freed
 * text is made physically gone (secure_delete + FTS optimize + WAL checkpoint, like forgetting memory).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../../core/types.js';
import { now, purgeDeleted } from '../../core/db.js';

export interface PurgeScope {
  /** Owner of the conversations (whose attachments and bots are involved). */
  ownerId: string;
  /** Conversations to delete completely. */
  threadIds: string[];
  /** A conversation that stays but is emptied (the group's own conversation). */
  keepThreadId?: string | null;
  /** Only what existed at this moment (ISO); used when a deletion is applied again after restoring a backup. */
  before?: string;
}

export interface PurgeCounts {
  threads: number;
  messages: number;
  files: number;
  bytes: number;
  running: number;
  summaries: number;
}

const chunks = <T>(list: T[], n = 400): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};
const marks = (list: unknown[]) => list.map(() => '?').join(',');

/** Module tables may be absent (module switched off): no rows / no change then. */
function safeAll<T = any>(ctx: Ctx, sql: string, ...p: any[]): T[] {
  try {
    return ctx.store.all<T>(sql, ...p);
  } catch {
    return [];
  }
}
function safeExec(ctx: Ctx, sql: string, ...p: any[]): number {
  try {
    return Number(ctx.store.exec(sql, ...p).changes || 0);
  } catch {
    return 0;
  }
}
/** `sql` with `#` for an id list (every `#` gets the same chunk), run per chunk of ids. */
function allIn<T = any>(ctx: Ctx, sql: string, ids: string[], ...extra: any[]): T[] {
  const out: T[] = [];
  const times = sql.split('#').length - 1;
  for (const c of chunks(ids)) out.push(...safeAll<T>(ctx, sql.replaceAll('#', marks(c)), ...Array.from({ length: times }, () => c).flat(), ...extra));
  return out;
}
function execIn(ctx: Ctx, sql: string, ids: string[], ...extra: any[]): number {
  let n = 0;
  const times = sql.split('#').length - 1;
  for (const c of chunks(ids)) n += safeExec(ctx, sql.replaceAll('#', marks(c)), ...Array.from({ length: times }, () => c).flat(), ...extra);
  return n;
}

const allIds = (s: PurgeScope) => [...s.threadIds, ...(s.keepThreadId ? [s.keepThreadId] : [])];
/** Everything up to `before` (or simply everything). */
const until = (s: PurgeScope) => s.before || '9999';

/**
 * The attachments that go: those of the deleted conversations (and of the emptied one, up to `before`), except files
 * that are still used elsewhere: forwarded into a conversation that stays, or a source of a dossier in memory.
 */
function attachmentsToDelete(ctx: Ctx, s: PurgeScope): { id: string; name: string; path: string; size: number }[] {
  const rows = [
    ...allIn<any>(ctx, 'SELECT id, name, path, size FROM attachments WHERE thread_id IN (#)', s.threadIds),
    ...(s.keepThreadId ? safeAll<any>(ctx, 'SELECT id, name, path, size FROM attachments WHERE thread_id = ? AND created_at <= ?', s.keepThreadId, until(s)) : []),
  ];
  if (!rows.length) return [];
  const gone = new Set(s.threadIds);
  const used = new Set<string>();
  // One pass over the owner's messages that stay and carry attachments (a forwarded message reuses the same file).
  for (const m of safeAll<{ thread_id: string; parts: string; created_at: string }>(ctx, "SELECT m.thread_id, m.parts, m.created_at FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.user_id = ? AND m.parts LIKE '%att\\_%' ESCAPE '\\'", s.ownerId)) {
    if (gone.has(m.thread_id) || (m.thread_id === s.keepThreadId && m.created_at <= until(s))) continue;
    try {
      for (const a of JSON.parse(m.parts || '{}')?.attachments || []) if (a?.id) used.add(String(a.id));
    } catch {
      /* unreadable parts: nothing referenced */
    }
  }
  for (const r of safeAll<{ target: string }>(ctx, "SELECT target FROM memory_sources WHERE user_id = ? AND kind = 'attachment' AND status != 'forgotten'", s.ownerId)) used.add(r.target);
  return rows.filter((r) => !used.has(r.id));
}

/** Counts for the confirmation dialog (what goes); nothing is changed. */
export function previewPurge(ctx: Ctx, s: PurgeScope): PurgeCounts {
  const ids = allIds(s);
  const files = attachmentsToDelete(ctx, s);
  const count = (sql: string, list: string[], ...extra: any[]) => allIn<{ n: number }>(ctx, sql, list, ...extra).reduce((a, r) => a + Number(r.n || 0), 0);
  return {
    threads: s.threadIds.length,
    messages: count("SELECT COUNT(*) n FROM messages WHERE thread_id IN (#) AND deleted = 0 AND role IN ('user','assistant') AND created_at <= ?", ids, until(s)),
    files: files.length,
    bytes: files.reduce((a, f) => a + (Number(f.size) || 0), 0),
    running: count("SELECT COUNT(*) n FROM runs WHERE thread_id IN (#) AND status IN ('queued','running','waiting')", ids),
    summaries: count('SELECT COUNT(*) n FROM memory_episodes WHERE thread_id IN (#)', ids),
  };
}

/** Thread meta that belongs to the conversation itself (summaries, compaction marks): cleared when it is emptied. */
const CONVERSATION_META = ['summary', 'summaryUpTo', 'summaryAt', 'cliCompactedAt', 'contextFromSeq', 'queuePaused', 'queuePausedReason'];

/**
 * Delete the conversations. Queued messages go first (nothing starts anew), running work is stopped and given up to
 * five seconds to stop, so no answer lands in a conversation that is being deleted. `audience`: who gets the live
 * events (the owner, and the members of a group).
 */
export async function purgeConversations(ctx: Ctx, s: PurgeScope, audience: string[] = [s.ownerId], reason = 'Geschiedenis gewist'): Promise<PurgeCounts> {
  const ids = allIds(s);
  const counts = previewPurge(ctx, s);
  // 1. nothing new starts, and what runs stops
  execIn(ctx, 'DELETE FROM chat_queue WHERE thread_id IN (#)', ids);
  const active = allIn<{ id: string }>(ctx, "SELECT id FROM runs WHERE thread_id IN (#) AND status IN ('queued','running','waiting')", ids);
  for (const r of active) ctx.runs.cancel(r.id, reason);
  if (active.length) {
    const limit = new Promise((r) => setTimeout(r, 5000).unref?.());
    await Promise.race([Promise.allSettled(active.map((r) => ctx.runs.waitFor(r.id, 5000))), limit]);
  }

  const files = attachmentsToDelete(ctx, s);
  const root = path.resolve(ctx.config.dataDir) + path.sep;
  const inside = (p: string) => !!p && path.resolve(p).startsWith(root);
  const workspaces = ctx.store.agents(s.ownerId, { archived: true }).map((a) => a.workspace).filter(Boolean);
  const tts = allIn<{ id: string; path: string }>(ctx, 'SELECT v.id, v.path FROM voice_tts v JOIN messages m ON m.id = v.message_id WHERE m.thread_id IN (#) AND m.created_at <= ?', ids, until(s));

  ctx.store.tx(() => {
    // 2. what hangs off the conversations
    for (const t of tts) safeExec(ctx, 'DELETE FROM voice_tts WHERE id = ?', t.id);
    if (files.length) {
      execIn(ctx, 'DELETE FROM voice_clips WHERE attachment_id IN (#)', files.map((f) => f.id));
      execIn(ctx, 'DELETE FROM attachments WHERE id IN (#)', files.map((f) => f.id));
    }
    for (const [table, time] of [
      ['approvals', 'created_at'],
      ['voice_calls', 'started_at'],
      ['voice_clips', 'created_at'],
    ] as const) {
      execIn(ctx, `DELETE FROM ${table} WHERE thread_id IN (#)`, s.threadIds);
      if (s.keepThreadId) safeExec(ctx, `DELETE FROM ${table} WHERE thread_id = ? AND ${time} <= ?`, s.keepThreadId, until(s));
    }
    // Engine sessions and context numbers would still carry the old conversation: always gone.
    for (const table of ['cli_sessions', 'usage_context']) execIn(ctx, `DELETE FROM ${table} WHERE thread_id IN (#)`, ids);
    // Finished subtasks and questions between bots (their task and answer are part of the conversation).
    execIn(ctx, "DELETE FROM room_delegations WHERE (thread_id IN (#) OR parent_thread_id IN (#)) AND status IN ('done','error','cancelled','timeout')", ids);
    // 3. the conversations themselves
    for (const id of s.threadIds) if (ctx.store.thread(id)) ctx.store.deleteThread(id);
    const k = s.keepThreadId;
    if (k) {
      const c = until(s);
      ctx.store.exec('DELETE FROM messages_fts WHERE rowid IN (SELECT f.rid FROM messages_fts_map f JOIN messages m ON m.id = f.message_id WHERE f.thread_id = ? AND m.created_at <= ?)', k, c);
      ctx.store.exec('DELETE FROM messages_fts_map WHERE thread_id = ? AND message_id IN (SELECT id FROM messages WHERE thread_id = ? AND created_at <= ?)', k, k, c);
      ctx.store.exec('DELETE FROM messages WHERE thread_id = ? AND created_at <= ?', k, c);
      ctx.store.exec("DELETE FROM runs WHERE thread_id = ? AND created_at <= ? AND status NOT IN ('queued','running','waiting')", k, c);
      const t = ctx.store.thread(k);
      if (t) {
        const meta = { ...(t.meta || {}) };
        for (const key of CONVERSATION_META) delete meta[key];
        ctx.store.update('threads', k, { meta, provider_state: {}, updated_at: now() });
      }
    }
  });

  // 4. files on disk (after the commit: a failed transaction never leaves rows without their files)
  const rm = (p: string) => {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* locked or gone: the row is gone, the file is unreachable */
    }
  };
  for (const f of files) {
    if (inside(f.path)) rm(f.path);
    const copy = `${f.id.slice(-6)}-${String(f.name).replace(/[^\w.\- ]+/g, '_')}`;
    for (const ws of workspaces) rm(path.join(ws, 'uploads', copy));
  }
  for (const t of tts) if (inside(t.path)) rm(t.path);

  // 5. live updates; the memory module drops its summaries of these conversations on the same events
  for (const id of s.threadIds) for (const uid of audience) ctx.events.emit(uid, 'thread.deleted', { id });
  if (s.keepThreadId) {
    const t = ctx.store.thread(s.keepThreadId);
    for (const uid of audience) ctx.events.emit(uid, 'thread.cleared', { id: s.keepThreadId, thread: t });
  }
  // 6. physically gone, like forgetting memory (no VACUUM: secure_delete already zeroes the freed pages)
  purgeDeleted(ctx.db, { fts: ['messages_fts'], file: path.join(ctx.config.dataDir, 'teambot.db') });
  return { ...counts, files: files.length, bytes: files.reduce((a, f) => a + (Number(f.size) || 0), 0) };
}
