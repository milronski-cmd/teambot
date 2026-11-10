import type { Agent, Ctx } from '../../core/types.js';
import type { Routine } from './schema.js';

/**
 * Check before a routine starts (0.4.4, P2): do the connections it needs still work? Without this a routine with an
 * expired app login or a channel that broke runs anyway, costs a model call and fails afterwards with an engine error.
 * Now it does not start: the run gets "Kon niet: koppeling verlopen" with the list below as its receipt, and the owner
 * gets one notification.
 *
 * What is checked (all read from TeamBot's own records, nothing is called):
 *  - the channel the result goes to (options.deliver): it must still exist, be on, and not be in error or unable to send;
 *  - the apps (MCP) of the bot, when the routine may use apps: an app whose login expired or was revoked
 *    (status auth_required, OAuth status expired, or an access token past its expiry without a refresh token).
 * Vault logins have no expiry in TeamBot (a username and password do not run out), so there is nothing to check there.
 * Every source is feature-detected: a module that is not loaded is simply not checked.
 */

export interface Blocker {
  kind: 'channel' | 'app';
  id: string;
  name: string;
  /** One plain sentence: what does not work. */
  text: string;
  /** Where the owner fixes it. */
  link: string;
}

const CHANNEL_LINK = '#/m/channels';
const APP_LINK = '#/m/mcp';

function hasTable(ctx: Ctx, name: string): boolean {
  return !!ctx.store.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name);
}

export function channelBlockers(ctx: Ctx, r: Pick<Routine, 'user_id' | 'options'>): Blocker[] {
  const d = r.options?.deliver;
  if (!d?.bindingId) return [];
  const list = ctx.services.channels?.bindings;
  if (typeof list !== 'function') return [];
  const b = (list(r.user_id) as any[]).find((x) => x.id === d.bindingId);
  if (!b) return [{ kind: 'channel', id: d.bindingId, name: 'Kanaal', text: 'Het kanaal waar het resultaat heen gaat, bestaat niet meer.', link: CHANNEL_LINK }];
  const name = String(b.name || b.adapterLabel || 'Kanaal');
  if (!b.enabled) return [{ kind: 'channel', id: b.id, name, text: `Het kanaal ${name} staat uit.`, link: CHANNEL_LINK }];
  const state = b.health?.state;
  if (b.status === 'error' || state === 'error') return [{ kind: 'channel', id: b.id, name, text: `Het kanaal ${name} werkt niet: ${String(b.last_error || b.health?.reason || 'onbekende fout').slice(0, 200)}`, link: CHANNEL_LINK }];
  if (state === 'send_failed') return [{ kind: 'channel', id: b.id, name, text: `Het kanaal ${name} kan nu niets versturen: ${String(b.health?.reason || '').slice(0, 200)}`.trim(), link: CHANNEL_LINK }];
  return [];
}

export function appBlockers(ctx: Ctx, r: Pick<Routine, 'user_id' | 'options'>, agent: Pick<Agent, 'id' | 'user_id'>, at = Date.now()): Blocker[] {
  // A routine limited to other tool groups never uses the bot's apps.
  const groups = r.options?.override?.tool_groups;
  if (Array.isArray(groups) && !groups.includes('mcp')) return [];
  if (!hasTable(ctx, 'mcp_bindings') || !hasTable(ctx, 'mcp_connections')) return [];
  const rows = ctx.store.all<any>(
    `SELECT c.* FROM mcp_bindings b JOIN mcp_connections c ON c.id = b.connection_id
     WHERE b.agent_id = ? AND b.user_id = ? AND c.user_id = ? AND c.enabled = 1 AND c.verified_at IS NOT NULL`,
    agent.id,
    agent.user_id,
    agent.user_id,
  );
  const out: Blocker[] = [];
  for (const raw of rows) {
    const c = ctx.store.decode<any>('mcp_connections', raw);
    const name = String(c.label || c.name || 'App');
    const o = c.oauth || {};
    const exp = o.expires_at ? Date.parse(o.expires_at) : NaN;
    const expired = c.status === 'auth_required' || o.status === 'expired' || (o.status === 'connected' && Number.isFinite(exp) && exp < at && !o.has_refresh);
    if (expired) out.push({ kind: 'app', id: c.id, name, text: `De login van ${name} is verlopen. Log opnieuw in bij Apps.`, link: APP_LINK });
  }
  return out;
}

/** Everything that would make this routine fail because a connection no longer works. */
export function preflight(ctx: Ctx, r: Routine, agent: Agent): Blocker[] {
  try {
    return [...channelBlockers(ctx, r), ...appBlockers(ctx, r, agent)];
  } catch (e) {
    ctx.log.warn('[routines] controle vooraf', String(e));
    return [];
  }
}

/** The run's error line: short, and the same start every time so the history reads as one kind of failure. */
export function blockedError(list: Blocker[]): string {
  return `Kon niet: koppeling verlopen. ${list.map((b) => b.text).join(' ')}`.slice(0, 500);
}
