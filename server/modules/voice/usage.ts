import type { Ctx } from '../../core/types.js';
import { HttpError } from '../../core/http.js';
import { now } from '../../core/db.js';
import { budgetText, nextDay } from '../../agent/budget.js';

/** Today's spend (all features) for the user, from the shared usage log. */
export function spentToday(ctx: Ctx, userId: string): number {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  return ctx.store.one<{ c: number }>('SELECT COALESCE(SUM(cost),0) AS c FROM usage_log WHERE user_id = ? AND created_at >= ?', userId, since.toISOString())?.c ?? 0;
}

/** Same daily budget rule as the agent runner (Instellingen › Kosten). */
export function checkBudget(ctx: Ctx, userId: string) {
  const limit = Number(ctx.store.getSetting(userId, 'dailyBudgetUsd', 0));
  if (!limit) return;
  const spent = spentToday(ctx, userId);
  // The same words as in the chat: what was reached, when it opens again, where to raise it (agent/budget.ts).
  if (spent >= limit) throw new HttpError(402, budgetText({ limit, spent, resetAt: nextDay().toISOString() }, ctx.store.getSetting<string>(userId, 'timezone', '') || undefined), 'budget');
}

/** Voice costs appear in the normal cost overview (/api/usage). */
export function logUsage(ctx: Ctx, o: { userId: string; agentId?: string | null; providerId?: string | null; model: string; input?: number; output?: number; cost: number | null }) {
  try {
    ctx.store.insert('usage_log', {
      user_id: o.userId,
      agent_id: o.agentId ?? null,
      provider_id: o.providerId ?? null,
      model: o.model,
      input: Math.round(o.input || 0),
      output: Math.round(o.output || 0),
      cost: o.cost ?? 0,
      created_at: now(),
    });
  } catch (e) {
    ctx.log.warn('[voice] usage log failed', String(e));
  }
}

const windows = new Map<string, number[]>();

/** Simple per-user sliding-window limit against runaway clients (costs are also capped by the daily budget). */
export function rateLimit(userId: string, key: string, max: number, windowMs = 60_000) {
  const k = `${userId}:${key}`;
  const nowMs = Date.now();
  const list = (windows.get(k) || []).filter((t) => nowMs - t < windowMs);
  if (list.length >= max) throw new HttpError(429, 'Te veel spraakverzoeken achter elkaar. Wacht even en probeer het opnieuw.', 'rate_limited');
  list.push(nowMs);
  windows.set(k, list);
}
