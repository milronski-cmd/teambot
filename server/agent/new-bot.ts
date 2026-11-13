import type { Agent, Ctx } from '../core/types.js';
import { isRestricted, memberPolicy } from '../api/member-policy.js';

/**
 * What a new bot starts with, in ONE place: every path that makes a bot (the new-bot screen, the first bot, the main
 * bot's team_add_bot, a hired bot, a template, an import, a copy) goes through `Store.createAgent`, which fills in
 * whatever the caller left out with these defaults (app.ts sets `store.agentDefaults`).
 *
 * The owner of this installation: "Volledige toegang", also for sending to others, and every part a bot can use plus
 * its own browser. It works right after it is made; nothing to switch on. Paying always asks (tools/broker.ts) and his
 * own rules, secret files and closed folders stay as they are.
 * Anyone else (a member on a shared server): "Automatisch", the same parts minus what the member policy takes away
 * (api/member-policy.ts runs on top of this).
 *
 * A value the caller gives is kept: an owner who picks "Vraagt toestemming" gets that.
 */

/** Parts that follow from where the bot works (Computer & bestanden), not from the default; only the browser comes along. */
const COMPUTER_GROUPS = new Set(['browser', 'desktop', 'rehearsal', 'container', 'remote']);
/** When the list of parts cannot be read (no module registered one yet). */
const FALLBACK_GROUPS = ['files', 'web', 'browser', 'shell', 'memory', 'team', 'skills', 'routines', 'channels'];

/** Every part a bot can use (not the always-on ones, not the other computers) plus its own browser. */
export function defaultToolGroups(ctx: Ctx): string[] {
  const parts = [...ctx.tools.groups.values()].filter((g) => !g.always && !COMPUTER_GROUPS.has(g.id.split(':')[0])).map((g) => g.id);
  if (!parts.length) return [...FALLBACK_GROUPS];
  return [...new Set([...parts, ...(ctx.tools.groups.has('browser') ? ['browser'] : [])])];
}

/** The owner of this installation: his bots start at "Volledige toegang". */
export function startsFull(ctx: Ctx, userId: string): boolean {
  return ctx.store.user(userId)?.role === 'owner';
}

/** Fill in what `data` leaves out for a new bot of this user. Never changes a value that was given. */
export function newBotDefaults(ctx: Ctx, userId: string, data: Partial<Agent>): Partial<Agent> {
  const out: Partial<Agent> = { ...data };
  if (!out.tool_groups) {
    out.tool_groups = defaultToolGroups(ctx);
    // A member on a shared server never gets the terminal by default (the same rule as api/member-policy.ts, which
    // only sees the parts a caller gives).
    if (isRestricted(ctx, ctx.store.user(userId)) && !memberPolicy(ctx).allowShell) out.tool_groups = out.tool_groups.filter((g) => g !== 'shell');
  }
  if (!out.access_mode) {
    const full = startsFull(ctx, userId);
    out.access_mode = full ? 'full' : 'auto';
    if (full && out.settings?.fullAccessExternal === undefined) out.settings = { ...(out.settings || {}), fullAccessExternal: true };
  }
  return out;
}
