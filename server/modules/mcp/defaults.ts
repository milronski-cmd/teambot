import type { Ctx } from '../../core/types.js';
import { now } from '../../core/db.js';
import type { ConnectionRow } from './db.js';

/**
 * "Gekoppeld" means the bots can use the app, without switching anything on per bot:
 *  - a bot made after an app was connected gets that app too (`bindNewBot`), unless the owner narrowed the app to
 *    some bots (then it stays his choice);
 *  - an app the owner of this installation connects is not read-only: its actions are on from the start
 *    (`actionsByDefault`). What a bot may do with them is its own access level (tools/broker.ts): a bot that asks
 *    still asks, a bot on "Volledige toegang" does its work. Paying always asks.
 *  - `upgrade` repairs data that exists, once: bots made after an app was connected get it, and the owner's tested
 *    apps get their actions.
 */
const UPGRADE_KEY = 'mcp.defaultsUpgrade';

/** Actions are on from the start for the owner of this installation; a member's apps start read-only. */
export function actionsByDefault(ctx: Ctx, userId: string): boolean {
  return ctx.store.user(userId)?.role === 'owner';
}

const bind = (ctx: Ctx, userId: string, agentId: string, connId: string) =>
  ctx.store.exec('INSERT OR IGNORE INTO mcp_bindings (agent_id, connection_id, user_id, created_at) VALUES (?, ?, ?, ?)', agentId, connId, userId, now());

/**
 * Bind bots to the owner's apps they miss only because they were made later. An app counts as "for all bots" when
 * every bot that existed when it was connected still has it; an app the owner took away from one of those is narrowed
 * and left alone. `onlyAgentId`: just this (new) bot. Returns how many bindings were added.
 */
export function bindLate(ctx: Ctx, userId: string, onlyAgentId?: string, changed?: (connId: string) => void): number {
  const store = ctx.store;
  const conns = store.find<ConnectionRow>('mcp_connections', { user_id: userId });
  if (!conns.length) return 0;
  const bots = store.agents(userId);
  let n = 0;
  for (const c of conns) {
    const bound = new Set(store.all<{ agent_id: string }>('SELECT agent_id FROM mcp_bindings WHERE connection_id = ?', c.id).map((r) => r.agent_id));
    const early = bots.filter((b) => b.created_at <= c.created_at);
    if (early.some((b) => !bound.has(b.id))) continue;
    for (const b of bots) {
      if (b.created_at <= c.created_at || bound.has(b.id) || (onlyAgentId && b.id !== onlyAgentId)) continue;
      // An app that is "alleen dit team" is not for bots of another team.
      if (ctx.services.teams?.keyAllowed?.(b, 'app', c.id) === false) continue;
      bind(ctx, userId, b.id, c.id);
      n++;
      changed?.(c.id);
    }
  }
  return n;
}

/** A bot that was just made (event agent.updated) gets the owner's apps. Each bot once, while it is new. */
export function newBotBinder(ctx: Ctx, changed?: (userId: string, connId: string) => void) {
  const done = new Set<string>();
  return (a: any) => {
    if (!a?.id || !a.user_id || a.archived || done.has(a.id)) return;
    done.add(a.id);
    if (Date.now() - Date.parse(a.created_at) > 10 * 60_000) return;
    const cur = ctx.store.agent(a.id);
    if (!cur || cur.user_id !== a.user_id) return;
    const n = bindLate(ctx, cur.user_id, cur.id, (id) => changed?.(cur.user_id, id));
    if (n) ctx.audit(cur.user_id, 'mcp.binding.new_bot', { apps: n }, cur.id);
  };
}

/** Once per installation, at start: see the top of this file. */
export function upgradeDefaults(ctx: Ctx): { bound: number; actions: number } {
  const out = { bound: 0, actions: 0 };
  if (ctx.store.getSetting('', UPGRADE_KEY, null)) return out;
  for (const { user_id } of ctx.store.all<{ user_id: string }>('SELECT DISTINCT user_id FROM mcp_connections')) {
    out.bound += bindLate(ctx, user_id);
    if (!actionsByDefault(ctx, user_id)) continue;
    for (const c of ctx.store.find<ConnectionRow>('mcp_connections', { user_id })) {
      if (c.allow_actions || !c.verified_at) continue;
      ctx.store.update('mcp_connections', c.id, { allow_actions: true, updated_at: now() });
      ctx.audit(user_id, 'mcp.actions.enabled', { id: c.id, name: c.name, by: 'upgrade' });
      out.actions++;
    }
  }
  ctx.store.setSetting('', UPGRADE_KEY, { at: now(), ...out });
  return out;
}
