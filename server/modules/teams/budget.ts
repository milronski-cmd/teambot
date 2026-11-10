import type { Agent, Ctx } from '../../core/types.js';
import { usdText } from '../../core/i18n.js';
import { BudgetError, type BudgetStop, dayStart, nextDay } from '../../agent/budget.js';
import type { TeamsService } from './service.js';

/**
 * A team's daily budget (package B2): optional, in USD, on top of the owner's own daily budget (Instellingen ›
 * Kosten). It counts what the team's bots spent today (all their model calls in the usage log, since midnight on the
 * server's clock) and is checked by the runner before every model call that can cost money (hook `beforeModelCall`),
 * with the same estimate as the owner's budget: what the previous call of this bot here cost. A bot that moved to
 * another team brings its spend of today along to its new team.
 */

export interface TeamBudgetStop extends BudgetStop {
  team: { id: string; name: string };
}

/** What the bots of a team spent today (USD, estimate from the usage log). */
export function teamSpentToday(ctx: Pick<Ctx, 'store'>, svc: TeamsService, teamId: string, now = new Date()): number {
  const bots = svc.botsOf(teamId);
  if (!bots.length) return 0;
  return (
    ctx.store.one<{ c: number }>(`SELECT COALESCE(SUM(cost), 0) AS c FROM usage_log WHERE created_at >= ? AND agent_id IN (${bots.map(() => '?').join(',')})`, dayStart(now).toISOString(), ...bots)?.c ?? 0
  );
}

function clock(iso: string, tz?: string): string {
  try {
    return new Date(iso).toLocaleTimeString('nl-NL', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(iso).toISOString().slice(11, 16);
  }
}

/** The stop in whole sentences: what was reached, when it opens again and where to raise it. */
export function teamBudgetText(b: TeamBudgetStop, tz?: string): string {
  const first =
    b.estimate !== undefined && b.spent < b.limit
      ? `Daglimiet van het team “${b.team.name}” bereikt: het dagbudget is ${usdText(b.limit)}, vandaag is ${usdText(b.spent)} gebruikt en de volgende stap kost naar schatting ${usdText(b.estimate)} (zoveel kostte de vorige).`
      : `Daglimiet van het team “${b.team.name}” bereikt: vandaag is ${usdText(b.spent)} van ${usdText(b.limit)} gebruikt.`;
  return `${first} Om ${clock(b.resetAt, tz)} begint een nieuwe dag en werkt de bot weer. Wil je vandaag verder, verhoog het dagbudget van het team dan in Instellingen › Teams.`;
}

/** The runner hook: throws a BudgetError when the bot's home team reached its daily budget (or the next step would). */
export function teamBudgetCheck(ctx: Pick<Ctx, 'store'>, svc: TeamsService) {
  return (a: { agent: Agent; estimate: number | null; midRun: boolean; tz?: string }) => {
    const teamId = svc.teamOf(a.agent.id);
    const team = teamId ? svc.team(teamId) : null;
    const limit = Number(team?.daily_budget_usd) || 0;
    if (!team || !(limit > 0)) return;
    const now = new Date();
    const spent = teamSpentToday(ctx, svc, team.id, now);
    const estimate = a.estimate && a.estimate > 0 ? a.estimate : 0;
    // The same small rounding margin as the owner's budget: an estimate that fits to the cent is no reason to stop.
    if (!(spent >= limit || (estimate > 0 && spent + estimate > limit + 1e-9))) return;
    const b: TeamBudgetStop = { limit, spent, resetAt: nextDay(now).toISOString(), team: { id: team.id, name: team.name }, ...(a.midRun ? { midRun: true } : {}) };
    if (spent < limit) b.estimate = estimate;
    throw new BudgetError(teamBudgetText(b, a.tz), b);
  };
}
