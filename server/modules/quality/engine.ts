import type { Agent, Ctx } from '../../core/types.js';
import { isBudgetError } from '../../agent/budget.js';
import { judgeEngine, ownEngineRef, runShortCall, ShortCallError, type EngineProblem, type EngineRef } from '../../agent/short-call.js';

/**
 * The short model call of the quality module (the second look before "klaar", turning an owner's correction into a
 * lesson; agent/short-call.ts runs and logs it). It runs on the bot's own engine, or on the engine the owner picked for
 * checks in the bot editor (Werk dat af is › Controle-engine), which may be a cheaper one. API engines get a hard token
 * cap; CLI engines (Claude Code, Codex, OpenCode) answer once without tools through their `complete`.
 *
 * Bounded: max. tokens per call, a time-out, a daily count per owner, and the daily budget for paid engines.
 */

export const CHECK_MAX_TOKENS = 220;
export const DAILY_CALLS = 300;

export class NoEngine extends Error {}

export interface QuickResult {
  text: string;
  engine: string;
  tokens: number;
}

/** Calls per owner per day (in memory: a restart simply starts counting again). */
const counts = new Map<string, { day: string; n: number }>();

function countCall(userId: string): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const c = counts.get(userId);
  if (!c || c.day !== day) {
    counts.set(userId, { day, n: 1 });
    return true;
  }
  if (c.n >= DAILY_CALLS) return false;
  c.n++;
  return true;
}

/** The engine and model a bot's checks run on (null: none configured). */
export function checkEngineOf(ctx: Ctx, agent: Agent): { providerId: string; model: string } | null {
  const q = agent.settings?.quality || {};
  if (typeof q.checkProviderId === 'string' && q.checkProviderId) return { providerId: q.checkProviderId, model: typeof q.checkModel === 'string' ? q.checkModel : '' };
  const own = ownEngineRef(ctx, agent.user_id, agent);
  return own && { providerId: own.providerId, model: own.model || '' };
}

const WHY: Record<Exclude<EngineProblem, 'unsupported'>, string> = {
  missing: 'de engine voor de controle bestaat niet meer',
  off: 'de engine voor de controle is niet beschikbaar',
  refused: 'de engine voor de controle is niet beschikbaar',
  paid: 'de engine voor de controle is niet beschikbaar',
  model: 'er is geen model gekozen voor de controle',
};

/**
 * One bounded call. Throws NoEngine (with a reason in words) when no call could be made. `engine`: another engine than
 * the bot's check engine (the next one of the chain when that one is at its limit).
 */
export async function quickCall(ctx: Ctx, agent: Agent, req: { system: string; prompt: string; maxTokens?: number; timeoutMs?: number; engine?: EngineRef }): Promise<QuickResult> {
  const pick = req.engine || checkEngineOf(ctx, agent);
  if (!pick) throw new NoEngine('deze bot heeft geen engine voor de controle');
  const { engine, problem, cfg } = judgeEngine(ctx, { userId: agent.user_id, agent }, pick, 'explicit');
  if (!engine) throw new NoEngine(problem === 'unsupported' ? `${cfg!.name} kan geen losse controle doen` : WHY[problem]);
  if (!countCall(agent.user_id)) throw new NoEngine(`de controlelimiet van ${DAILY_CALLS} per dag is bereikt`);
  try {
    const r = await runShortCall(ctx, engine, { userId: agent.user_id, agentId: agent.id, system: req.system, prompt: req.prompt, maxTokens: req.maxTokens ?? CHECK_MAX_TOKENS, timeoutMs: req.timeoutMs ?? 60_000 });
    return { text: r.text, engine: r.engine, tokens: r.usage.input + r.usage.output };
  } catch (e) {
    if (isBudgetError(e)) {
      // No call was made: it does not count towards the daily number of checks.
      counts.get(agent.user_id)!.n--;
      throw new NoEngine('het dagbudget is op');
    }
    if (e instanceof ShortCallError && e.code === 'unsupported') throw new NoEngine(`${engine.name} kan geen losse controle doen`);
    throw e;
  }
}
