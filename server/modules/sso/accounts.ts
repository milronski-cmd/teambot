import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../../core/types.js';

/**
 * Block an account: no login (password, SSO, pairing), every session revoked (REST + WebSocket), running bots
 * stopped. The chat service refuses new runs for blocked accounts, so routines and channels stay quiet too.
 */
export function deactivateUser(ctx: Ctx, userId: string): { sessions: number; runs: number } {
  ctx.store.update('users', userId, { disabled: true });
  const sessions = ctx.auth.revokeUserSessions(userId);
  const runs = ctx.runs.stopAll(userId);
  return { sessions, runs };
}

export function reactivateUser(ctx: Ctx, userId: string) {
  ctx.store.update('users', userId, { disabled: false });
}

/** Tables that are never swept on account deletion (the audit trail stays for the admins). */
const KEEP = new Set(['users', 'audit', '_migrations', 'sqlite_sequence', 'sso_settings']);

/**
 * Remove an account with its data: modules that offer `deleteUser` clean up first, then every row that belongs to
 * the user (column user_id) or to one of their bots (agent_id) or conversations (thread_id) is deleted in one
 * transaction, followed by uploaded files and the bots' own work folders. Only for members (callers check).
 */
export async function deleteUserData(ctx: Ctx, userId: string): Promise<{ tables: number; rows: number }> {
  deactivateUser(ctx, userId);
  for (const svc of Object.values(ctx.services)) {
    if (svc && typeof svc.deleteUser === 'function') {
      try {
        await svc.deleteUser(userId);
      } catch (e) {
        ctx.log.warn('[sso] deleteUser van een module mislukt', e);
      }
    }
  }
  // Rooms of other people they joined (membership rows point at the user via ref_id, not user_id).
  try {
    ctx.services.rooms?.removePersonEverywhere?.(userId);
  } catch (e) {
    ctx.log.warn('[sso] uit groepsgesprekken halen mislukt', e);
  }
  const budgets = ctx.store.getSetting<Record<string, number> | null>('', 'memberBudgets', null);
  if (budgets && userId in budgets) {
    const { [userId]: _gone, ...rest } = budgets;
    ctx.store.setSetting('', 'memberBudgets', rest);
  }
  const agentIds = ctx.store.all<{ id: string }>('SELECT id FROM agents WHERE user_id = ?', userId).map((r) => r.id);
  const threadIds = ctx.store.all<{ id: string }>('SELECT id FROM threads WHERE user_id = ?', userId).map((r) => r.id);
  const files = ctx.store.all<{ path: string }>('SELECT path FROM attachments WHERE user_id = ?', userId).map((r) => r.path);

  const master = ctx.store.all<{ name: string; sql: string | null }>("SELECT name, sql FROM sqlite_master WHERE type = 'table'");
  const virtual = master.filter((t) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(t.sql || '')).map((t) => t.name);
  // Shadow tables of FTS indexes (messages_fts_data, …) are maintained by SQLite itself.
  const tables = master.map((t) => t.name).filter((n) => !KEEP.has(n) && !virtual.some((v) => n !== v && n.startsWith(v + '_')));
  let rows = 0;
  let touched = 0;
  const inList = (ids: string[]) => ids.map(() => '?').join(',');
  ctx.store.tx(() => {
    ctx.store.exec('PRAGMA defer_foreign_keys = ON');
    for (const t of tables) {
      const cols = new Set(ctx.store.all<{ name: string }>(`PRAGMA table_info("${t.replace(/"/g, '""')}")`).map((c) => c.name));
      const q = `"${t.replace(/"/g, '""')}"`;
      let n = 0;
      if (cols.has('user_id')) n += Number(ctx.store.exec(`DELETE FROM ${q} WHERE user_id = ?`, userId).changes || 0);
      // Large id lists are chunked to stay below SQLite's parameter limit.
      for (const [col, ids] of [['agent_id', agentIds], ['thread_id', threadIds]] as const) {
        if (!cols.has(col)) continue;
        for (let i = 0; i < ids.length; i += 500) {
          const chunk = ids.slice(i, i + 500);
          n += Number(ctx.store.exec(`DELETE FROM ${q} WHERE ${col} IN (${inList(chunk)})`, ...chunk).changes || 0);
        }
      }
      if (n) touched++;
      rows += n;
    }
    ctx.store.exec('DELETE FROM users WHERE id = ?', userId);
  });

  const root = path.resolve(ctx.config.dataDir);
  const inside = (p: string) => {
    const r = path.resolve(p);
    return r.startsWith(root + path.sep);
  };
  for (const f of files) if (f && inside(f)) fs.rmSync(f, { force: true });
  for (const id of agentIds) {
    const ws = ctx.store.defaultWorkspace(id);
    if (inside(ws)) fs.rmSync(ws, { recursive: true, force: true });
  }
  return { tables: touched, rows };
}
