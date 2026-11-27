import type { Ctx } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import type { ConnectionRow } from './db.js';
import type { McpManager } from './runtime.js';
import { getConn } from './oauth.js';

/**
 * TeamBot's own apps that are set up with one key (TransIP, Forward Email): the owner pastes the key once, TeamBot
 * checks it with one real read, and then there is a built-in connection (transport "builtin") bound to all his bots,
 * its tools usable at once. What a bot may do is still its access level and each tool's risk.
 */
export interface KeyAppHelpers {
  uniqueSlug(userId: string, wanted: string): string;
  emit(userId: string, c: ConnectionRow | null, id?: string): void;
  view(c: ConnectionRow): any;
  setBindings(userId: string, connId: string, agentIds: string[]): void;
  /** Bots that may use a new connection without asking (the owner's default for new apps). */
  actionsByDefault(userId: string): boolean;
}

export function keyAppConn(ctx: Ctx, userId: string, catalogId: string): ConnectionRow | null {
  return ctx.store.find<ConnectionRow>('mcp_connections', { user_id: userId, catalog_id: catalogId })[0] || null;
}

/** The connection of this app (made when there is none yet), its tools listed and approved, and marked verified. */
export async function ensureKeyAppConn(ctx: Ctx, mgr: McpManager, h: KeyAppHelpers, userId: string, app: { id: string; name: string; slug: string }): Promise<ConnectionRow> {
  let c = keyAppConn(ctx, userId, app.id);
  const ts = now();
  if (!c) {
    const id = newId('mcp_');
    ctx.store.insert('mcp_connections', {
      id, user_id: userId, catalog_id: app.id, package: null, registry: null, name: app.name, label: '', slug: h.uniqueSlug(userId, app.slug), transport: 'builtin', command: '', args: [], cwd: '', env: [], url: '', headers: [], auth: 'none', oauth: {}, trusted_at: ts, allow_private: false, enabled: true,
      allow_actions: h.actionsByDefault(userId), verified_at: null, verify_result: null, status: 'new', last_error: null, server_info: null, idle_minutes: 10, timeout_sec: 90, created_at: ts, updated_at: ts,
    } as ConnectionRow);
    c = getConn(ctx, id)!;
    // As with every app: "gekoppeld" means the bots can use it; narrowing per bot is one click away.
    h.setBindings(userId, id, ctx.store.agents(userId).map((a) => a.id));
    ctx.audit(userId, 'mcp.connection.created', { id, name: app.name, transport: 'builtin', catalog: app.id });
  }
  // A new key: the server starts again with it.
  await mgr.stop(c.id, 'nieuwe sleutel').catch(() => {});
  try {
    const client = await mgr.client(getConn(ctx, c.id)!, { force: true });
    mgr.syncTools(c.id, (await client.listTools()).tools || []);
    ctx.store.exec('UPDATE mcp_tools SET approved = 1, changed = 0 WHERE connection_id = ? AND present = 1', c.id);
    ctx.store.update('mcp_connections', c.id, { verified_at: ts, verify_result: { ok: true, at: ts }, last_error: null, status: 'connected', updated_at: ts });
  } catch (e: any) {
    ctx.log.warn(`[mcp] ${app.id}: tools not listed`, e?.message || e);
  }
  const fresh = getConn(ctx, c.id)!;
  h.emit(userId, fresh);
  return fresh;
}

/** Forget the key of an app (the connection itself is removed through Apps like any other). */
export function forgetSecret(ctx: Ctx, userId: string, name: string) {
  for (const s of ctx.secrets.list(userId)) if (s.name === name) ctx.secrets.delete(s.id);
}
