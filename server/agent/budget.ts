import type { Agent, Ctx, ProviderConfig, Run, Usage } from '../core/types.js';
import { now } from '../core/db.js';
import { estimateTokens } from '../core/tokens.js';
import { estimateCost } from '../providers/pricing.js';
import { userTz } from './prompt.js';
import { sharedRunOf } from './shared.js';
import { usdText } from '../core/i18n.js';
import { effectiveBudget, isRestricted, memberBudgets, memberPolicy } from '../api/member-policy.js';
import { PLACE } from '../../shared/places.js';

/**
 * The daily budget (PLACE.costs; the field itself is in Standaarden voor nieuwe bots): what paid engines may spend per
 * day, as an estimate from the usage log.
 *
 * A day starts at midnight on the server's clock. The cost of a model call is only known once it is done, so a check
 * before a run alone let one long run (many tool steps) go far past the budget (acceptance round 6, B-70). The runner
 * therefore checks before every model call, and reserves what the previous call of this bot in this conversation cost:
 * a call that would most likely not fit any more does not start. What is left over is at most one call that cost more
 * than the one before it.
 *
 * Reaching the budget is a limit, not a failure: the run stops with `BudgetError`, the chat shows when the budget
 * opens again and where to raise it, and the bot's face says "daglimiet bereikt" instead of "er ging iets mis".
 */

export interface BudgetStop {
  /** The budget that applies (USD). */
  limit: number;
  /** Spent today, all features (USD). */
  spent: number;
  /** What the next call would cost by estimate (the previous call); absent when the budget was simply used up. */
  estimate?: number;
  /** When a new day starts (ISO). */
  resetAt: string;
  /** The limit is the admin's cap for this member (a member cannot raise it himself). */
  byAdmin?: boolean;
  /** The run had already done steps when it stopped. */
  midRun?: boolean;
}

export class BudgetError extends Error {
  readonly code = 'budget';
  constructor(
    message: string,
    public budget: BudgetStop,
  ) {
    super(message);
  }
}

export const isBudgetError = (e: any): e is BudgetError => !!e && e.code === 'budget' && !!e.budget;

/** Midnight on the server's clock: where today's spend starts counting. */
export function dayStart(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** The next midnight on the server's clock: when the daily budget opens again. */
export function nextDay(now = new Date()): Date {
  const d = dayStart(now);
  d.setDate(d.getDate() + 1);
  return d;
}

/** Spent today by this user, all features (chat, voice, memory …), from the usage log. */
export function spentToday(ctx: Pick<Ctx, 'store'>, userId: string, now = new Date()): number {
  return ctx.store.one<{ c: number }>('SELECT COALESCE(SUM(cost),0) AS c FROM usage_log WHERE user_id = ? AND created_at >= ?', userId, dayStart(now).toISOString())?.c ?? 0;
}

/** The budget that applies to this user, and whether it is the admin's cap (then only the admin can raise it). */
export function budgetOf(ctx: Ctx, userId: string): { limit: number; byAdmin: boolean } {
  const limit = effectiveBudget(ctx, userId);
  if (!limit || !isRestricted(ctx, ctx.store.user(userId))) return { limit, byAdmin: false };
  // Same rule as effectiveBudget: the admin's cap applies unless the member set a lower budget himself.
  const own = Number(ctx.store.getSetting(userId, 'dailyBudgetUsd', 0)) || 0;
  const personal = memberBudgets(ctx)[userId];
  const cap = personal !== undefined ? personal : memberPolicy(ctx).dailyBudgetUsd;
  return { limit, byAdmin: !!cap && !(own > 0 && own <= cap) };
}

/** "00:00" in the reader's time zone (the server's midnight). */
function resetClock(resetAt: string, tz?: string): string {
  try {
    return new Date(resetAt).toLocaleTimeString('nl-NL', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(resetAt).toISOString().slice(11, 16);
  }
}

/**
 * The stop in whole sentences (each one translatable on its own): what was reached, when it opens again, and where to
 * raise it. Starts with "Daglimiet van …" (routines recognise that as our own budget, not an engine limit).
 */
export function budgetText(b: BudgetStop, tz?: string): string {
  const first =
    b.estimate !== undefined && b.spent < b.limit
      ? `Daglimiet van ${usdText(b.limit)} bereikt: vandaag is ${usdText(b.spent)} gebruikt en de volgende stap kost naar schatting ${usdText(b.estimate)} (zoveel kostte de vorige).`
      : `Daglimiet van ${usdText(b.limit)} bereikt (vandaag ${usdText(b.spent)} gebruikt).`;
  const when = `Om ${resetClock(b.resetAt, tz)} begint een nieuwe dag en werkt de bot weer.`;
  const raise = b.byAdmin ? 'Wil je vandaag verder, vraag de beheerder dan om een hoger dagbudget.' : `Wil je vandaag verder, verhoog de limiet dan in ${PLACE.costs}.`;
  return `${first} ${when} ${raise}`;
}

/** Our own daily budget in a stored error text (old and new wording; "$1.00" and "US$ 1,00"). */
export const BUDGET_TEXT = /Daglimiet van (?:US)?\$/i;

/**
 * Check before a model call. `estimate`: what the previous call of this bot here cost (reserved for the next one);
 * null or 0 when unknown. Throws BudgetError when the budget is used up, or when the next call would most likely not
 * fit any more.
 */
export function assertBudget(ctx: Ctx, userId: string, o: { estimate?: number | null; midRun?: boolean; tz?: string; now?: Date } = {}): void {
  const { limit, byAdmin } = budgetOf(ctx, userId);
  if (!limit) return;
  const now = o.now || new Date();
  const spent = spentToday(ctx, userId, now);
  const estimate = o.estimate && o.estimate > 0 ? o.estimate : 0;
  // A small rounding margin: an estimate that fits to the cent is not a reason to stop.
  const over = spent >= limit || (estimate > 0 && spent + estimate > limit + 1e-9);
  if (!over) return;
  const b: BudgetStop = { limit, spent, resetAt: nextDay(now).toISOString(), ...(byAdmin ? { byAdmin } : {}), ...(o.midRun ? { midRun: true } : {}) };
  if (spent < limit) b.estimate = estimate;
  throw new BudgetError(budgetText(b, o.tz), b);
}

// ------------------------------------------------------------------ per model call (agent/chat-loop.ts, cli-loop.ts)

/**
 * The daily budget (agent/budget.ts), before every model call: used up, or the next call would most likely not fit
 * (`estimate`: what the previous call cost) → BudgetError. Free, local and subscription engines are never stopped by
 * it; only by a bot's own usage cap (hook beforeAnyModelCall), which the owner sets per bot.
 * `cfg`: the engine that would make the call (a reserve can differ from the bot's main engine).
 */
export function checkBudget(ctx: Ctx, userId: string, agent: Agent, o: { cfg?: ProviderConfig; estimate?: number | null; midRun?: boolean } = {}) {
  // A bot's own usage cap (usage module, also in tokens): on every engine, before the daily budgets.
  for (const h of ctx.hooks.beforeAnyModelCall || []) h({ agent, userId, midRun: !!o.midRun, tz: userTz(ctx, userId) });
  const extra = ctx.hooks.beforeModelCall || [];
  if (!effectiveBudget(ctx, userId) && !extra.length) return;
  if (!canCost(ctx, agent, userId, o.cfg)) return;
  if (effectiveBudget(ctx, userId)) assertBudget(ctx, userId, { estimate: o.estimate, midRun: o.midRun, tz: userTz(ctx, userId) });
  // Extra daily limits of modules (a team's daily budget): each throws a BudgetError when it is reached.
  for (const h of extra) h({ agent, userId, estimate: o.estimate ?? null, midRun: !!o.midRun, tz: userTz(ctx, userId) });
}

/**
 * What the last model call of this bot in this conversation cost on this engine (null: none, or free): the estimate
 * for the next one. A conversation only grows, so the next call is rarely cheaper.
 */
export function lastCallCost(ctx: Ctx, threadId: string, agentId: string, providerId: string | null | undefined): number | null {
  if (!providerId) return null;
  const row = ctx.store.one<{ c: number | null }>(
    "SELECT json_extract(usage, '$.cost') AS c FROM messages WHERE thread_id = ? AND author_id = ? AND role = 'assistant' AND usage IS NOT NULL AND json_extract(parts, '$.providerId') = ? ORDER BY seq DESC LIMIT 1",
    threadId,
    agentId,
    providerId,
  );
  const c = Number(row?.c);
  return c > 0 ? c : null;
}

/**
 * Can a run of this bot add to the daily budget? Not on a local or free engine, and not on a CLI that never reported
 * a cost (its own subscription: Claude Code, Codex …); a CLI on a pay-per-use key reports its cost and stays limited.
 * Before this, a paid API bot that reached the budget also stopped the owner's free and subscription bots.
 */
function canCost(ctx: Ctx, agent: Agent, userId: string, engine?: ProviderConfig): boolean {
  const providerId = engine?.id || agent.provider_id || ctx.store.getSetting<string | null>(sharedRunOf(agent)?.ownerId || userId, 'defaultProvider', null);
  const cfg = engine || ctx.providers.config(providerId);
  const kind = cfg ? ctx.providers.kind(cfg.kind) : undefined;
  if (!cfg || !kind) return true;
  if (kind.billing === 'local' || kind.billing === 'free') return false;
  if (kind.type !== 'cli') return true;
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  return !!ctx.store.one('SELECT 1 FROM usage_log WHERE provider_id = ? AND cost > 0 AND created_at >= ? LIMIT 1', cfg.id, since);
}

export function recordUsage(ctx: Ctx, run: Run, agent: Agent, cfg: ProviderConfig, model: string, u: Usage): Usage {
  // CLI agents report their own cost (0 when the run is covered by the user's subscription).
  const cost = ctx.providers.kind(cfg.kind)?.type === 'cli' ? (u.cost ?? null) : estimateCost(cfg.kind, model, u.input, u.output, u.cacheRead || 0, cfg.config);
  const usage = { ...u, cost: cost ?? undefined };
  const value = typeof u.value === 'number' ? u.value : cost;
  ctx.store.insert('usage_log', { user_id: run.user_id, agent_id: agent.id, provider_id: cfg.id, model, input: u.input, output: u.output, cost: cost ?? 0, value: value ?? null, ...(u.estimated ? { estimated: 1 } : {}), created_at: now() });
  const cur = ctx.store.run(run.id)!;
  const estimated = cur.usage?.estimated || u.estimated;
  ctx.store.updateRun(run.id, { usage: { input: (cur.usage?.input || 0) + u.input, output: (cur.usage?.output || 0) + u.output, cost: (cur.usage?.cost || 0) + (cost || 0), ...(estimated ? { estimated: true } : {}) } });
  return usage;
}

// ------------------------------------------------------------------ a call that ends without its result

/**
 * An engine that stops before its end (the owner's stop, a loop guard) throws its usual error with what it used so
 * far on it: `throw withUsage(new Error('Gestopt'), usage)`. A CLI engine counts per step, so it knows.
 */
export function withUsage<E extends Error>(e: E, usage: Usage, model?: string | null): E {
  return Object.assign(e, { usage, ...(model ? { model } : {}) });
}

/** What an engine said it used before it stopped (see withUsage); null when it said nothing. */
export function usageOf(e: unknown): Usage | null {
  const u = (e as { usage?: Usage } | null)?.usage;
  return u && typeof u === 'object' && (Number(u.input) > 0 || Number(u.output) > 0) ? u : null;
}

/** The model an engine said it used (a CLI resolves "opus" or its default to a full id), when it is a model id. */
export function modelSaid(said: unknown, asked: string): string {
  return typeof said === 'string' && /^[\w.:/@+[\]-]{1,120}$/.test(said) ? said : asked;
}

/**
 * A model call or CLI turn that ended without its result (stopped, steered, failed, a loop guard) used tokens too, and
 * is counted like any other in the usage log, the daily budget and the bot's cap. On every kind of AI the same rule:
 * the engine's own numbers when it gave them (a CLI engine reports per step: `reported`); otherwise, once the engine
 * sent anything back, TeamBot's estimate from what it sent (`sent`, tokens) and what came back (`received`), marked
 * as an estimate. An engine that sent nothing back (refused the call, stopped before it began) used nothing.
 */
export function recordUnfinished(ctx: Ctx, run: Run, agent: Agent, cfg: ProviderConfig, model: string, o: { reported?: Usage | null; sent?: number; received?: string }): Usage | null {
  try {
    if (!ctx.store.run(run.id)) return null; // the conversation was deleted meanwhile
    const cli = ctx.providers.kind(cfg.kind)?.type === 'cli';
    const said = o.reported && (o.reported.input > 0 || o.reported.output > 0) ? o.reported : null;
    const u: Usage | null = said ? { ...said } : o.received?.trim() ? { input: Math.max(0, Math.round(o.sent || 0)), output: estimateTokens(o.received), estimated: true } : null;
    if (!u) return null;
    // An engine counts the output of a call when the call ends (Claude Code: message_delta); of the call it was in the
    // middle of, it said almost nothing yet. At least what came back counts, then as an estimate.
    const back = estimateTokens(o.received || '');
    if (said && back > u.output) Object.assign(u, { output: back, estimated: true });
    if (cli) {
      // A CLI says its money only at the end of a turn. Its adapter knows the billing: 0 on the owner's subscription,
      // `undefined` on a pay-per-use key (then the list price). Without a word from the adapter: the list price only
      // for a CLI that reported a cost before (canCost). Its value is always the list price (an estimate).
      const list = estimateCost(cfg.kind, model, u.input, u.output, u.cacheRead || 0, cfg.config);
      const billing = o.reported ? o.reported.cost : canCost(ctx, agent, run.user_id, cfg) ? undefined : 0;
      u.cost = billing === undefined ? (list ?? 0) : billing;
      if (u.value === undefined && list !== null) u.value = list;
    }
    return recordUsage(ctx, run, agent, cfg, model, u);
  } catch (e) {
    ctx.log.warn('[usage] a stopped call was not counted', String(e));
    return null;
  }
}
