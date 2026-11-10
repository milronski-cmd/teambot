import type { Agent, Ctx } from '../../core/types.js';
import { usdText } from '../../core/i18n.js';
import { BudgetError, type BudgetStop, dayStart } from '../../agent/budget.js';

/**
 * A bot's own usage cap (0.4.5): at most so much spend (USD, estimate from the usage log) or so many tokens (input +
 * output, every engine: also a subscription or a free model) per day or per week, set per bot in the bot editor
 * (`settings.usageCap = { kind: 'usd' | 'tokens', amount, period: 'day' | 'week' }`). The runner checks it before every
 * model call (hook beforeAnyModelCall); once reached the bot pauses with one plain message in the chat, the same stop
 * as the daily budget (BudgetError: the bot's face says the limit is reached, and when it works again). A day starts at
 * midnight on the server's clock, a week on Monday at midnight. What other modules spend for the bot (memory,
 * checks) counts too: it is all in the usage log under the bot.
 */

export type CapKind = 'usd' | 'tokens';
export type CapPeriod = 'day' | 'week';
export interface BotCap {
  kind: CapKind;
  amount: number;
  period: CapPeriod;
}

export interface BotCapStop extends BudgetStop {
  cap: BotCap & { agentId: string; used: number };
}

/** The cap of a bot as set (null: none or not valid). */
export function capOf(agent: Pick<Agent, 'settings'> | null | undefined): BotCap | null {
  const c = agent?.settings?.usageCap;
  if (!c || typeof c !== 'object') return null;
  const kind: CapKind | null = c.kind === 'tokens' ? 'tokens' : c.kind === 'usd' ? 'usd' : null;
  const amount = Number(c.amount);
  if (!kind || !Number.isFinite(amount) || amount <= 0) return null;
  return { kind, amount: kind === 'tokens' ? Math.round(amount) : Math.round(amount * 100) / 100, period: c.period === 'week' ? 'week' : 'day' };
}

/** Where the period started: today's midnight, or Monday's midnight (server clock). */
export function periodStart(period: CapPeriod, now = new Date()): Date {
  const d = dayStart(now);
  if (period === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/** When the next period starts (the bot works again then). */
export function periodEnd(period: CapPeriod, now = new Date()): Date {
  const d = periodStart(period, now);
  d.setDate(d.getDate() + (period === 'week' ? 7 : 1));
  return d;
}

/** What a bot used in this period, all features, from the usage log. */
export function botUsed(ctx: Pick<Ctx, 'store'>, agentId: string, period: CapPeriod, now = new Date()): { usd: number; tokens: number } {
  const r = ctx.store.one<{ c: number; t: number }>('SELECT COALESCE(SUM(cost), 0) AS c, COALESCE(SUM(input + output), 0) AS t FROM usage_log WHERE agent_id = ? AND created_at >= ?', agentId, periodStart(period, now).toISOString());
  return { usd: r?.c ?? 0, tokens: r?.t ?? 0 };
}

function when(iso: string, period: CapPeriod, tz?: string): string {
  try {
    return new Date(iso).toLocaleString('nl-NL', { timeZone: tz || undefined, ...(period === 'week' ? { weekday: 'long' } : {}), hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(iso).toISOString().slice(11, 16);
  }
}

const tokensText = (n: number) => Math.round(n).toLocaleString('nl-NL');

/** The one message in whole sentences: what was reached, when the bot works again, and where to change it. */
export function capText(name: string, s: BotCapStop, tz?: string): string {
  const c = s.cap;
  const at = when(s.resetAt, c.period, tz);
  const used =
    c.kind === 'usd'
      ? c.period === 'week'
        ? `${name} heeft zijn eigen limiet bereikt: deze week is ${usdText(c.used)} van ${usdText(c.amount)} gebruikt.`
        : `${name} heeft zijn eigen limiet bereikt: vandaag is ${usdText(c.used)} van ${usdText(c.amount)} gebruikt.`
      : c.period === 'week'
        ? `${name} heeft zijn eigen limiet bereikt: deze week zijn ${tokensText(c.used)} van ${tokensText(c.amount)} tokens gebruikt.`
        : `${name} heeft zijn eigen limiet bereikt: vandaag zijn ${tokensText(c.used)} van ${tokensText(c.amount)} tokens gebruikt.`;
  const back = c.period === 'week' ? `Op ${at} begint een nieuwe week en werkt de bot weer.` : `Om ${at} begint een nieuwe dag en werkt de bot weer.`;
  return [used, back, 'Wil je eerder verder, verhoog dan de gebruikslimiet in de instellingen van de bot.'].join(' ');
}

/** The cap as it is now for one bot: what it may use, what it used, when the period starts again. */
export function capStatus(ctx: Pick<Ctx, 'store'>, agent: Agent, now = new Date()) {
  const cap = capOf(agent);
  if (!cap) return { cap: null, used: null, resetAt: null, reached: false };
  const u = botUsed(ctx, agent.id, cap.period, now);
  const used = cap.kind === 'usd' ? u.usd : u.tokens;
  return { cap, used: u, resetAt: periodEnd(cap.period, now).toISOString(), reached: used >= cap.amount };
}

/** The runner hook (beforeAnyModelCall): throws a BudgetError when the bot used its cap for this period. */
export function botCapCheck(ctx: Pick<Ctx, 'store'>) {
  return (a: { agent: Agent; midRun: boolean; tz?: string }) => {
    const cap = capOf(a.agent);
    if (!cap) return;
    const now = new Date();
    const u = botUsed(ctx, a.agent.id, cap.period, now);
    const used = cap.kind === 'usd' ? u.usd : u.tokens;
    if (used < cap.amount) return;
    // limit/spent in USD for what reads a budget stop generically; the cap itself says what it counts.
    const s: BotCapStop = { limit: cap.kind === 'usd' ? cap.amount : 0, spent: u.usd, resetAt: periodEnd(cap.period, now).toISOString(), cap: { ...cap, agentId: a.agent.id, used }, ...(a.midRun ? { midRun: true } : {}) };
    throw new BudgetError(capText(a.agent.name, s, a.tz), s);
  };
}
