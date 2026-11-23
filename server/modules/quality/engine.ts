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
  // A second look is worth most from another model than the one that did the work: a model is mild about what it made
  // itself, and another family sees other mistakes. So when the owner has such a model connected at no extra cost
  // (a subscription, a free or a local engine), the check runs there. A paid engine is only used when he picked it.
  const other = own ? otherFamily(ctx, agent, own.providerId) : null;
  return other || (own && { providerId: own.providerId, model: own.model || '' });
}

/** The maker a kind of engine belongs to: "claude-code" and "anthropic" are one family, "codex" and "openai" another. */
export function familyOf(kind: string | undefined): string {
  const k = String(kind || '').toLowerCase();
  if (/claude|anthropic/.test(k)) return 'anthropic';
  if (/openai|codex|gpt/.test(k)) return 'openai';
  if (/gemini|google|vertex/.test(k)) return 'google';
  return k.replace(/[-_](?:cli|code|api)$/, '');
}

/** An engine of another family than the bot's own that costs nothing extra and can do a short call (or null). */
export function otherFamily(ctx: Ctx, agent: Agent, ownProviderId: string): { providerId: string; model: string } | null {
  try {
    const own = ctx.providers.config(ownProviderId);
    if (!own) return null;
    for (const cfg of ctx.providers.list(agent.user_id)) {
      if (cfg.id === own.id || !cfg.enabled || familyOf(cfg.kind) === familyOf(own.kind)) continue;
      const v = judgeEngine(ctx, { userId: agent.user_id, agent, allowPaid: false } as any, { providerId: cfg.id, model: '' }, 'other');
      if (v.engine && v.engine.billing !== 'paid') return { providerId: cfg.id, model: '' };
    }
  } catch {
    /* no other engine: the bot's own */
  }
  return null;
}

/** The owner's choice for all his bots at once: the check of every bot runs on this engine (empty: each bot's default). */
export function setCheckEngineForAll(ctx: Ctx, userId: string, providerId: string | null, model: string | null): number {
  let n = 0;
  for (const a of ctx.store.agents(userId)) {
    if (a.archived) continue;
    const q = { ...(a.settings?.quality || {}) };
    if (providerId) {
      q.checkProviderId = providerId;
      if (model) q.checkModel = model;
      else delete q.checkModel;
    } else {
      delete q.checkProviderId;
      delete q.checkModel;
    }
    ctx.store.updateAgent(a.id, { settings: { ...a.settings, quality: q } });
    n++;
  }
  return n;
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
export async function quickCall(ctx: Ctx, agent: Agent, req: { system: string; prompt: string; maxTokens?: number; timeoutMs?: number; engine?: EngineRef; ownLimit?: boolean }): Promise<QuickResult> {
  const pick = req.engine || checkEngineOf(ctx, agent);
  if (!pick) throw new NoEngine('deze bot heeft geen engine voor de controle');
  const { engine, problem, cfg } = judgeEngine(ctx, { userId: agent.user_id, agent }, pick, 'explicit');
  if (!engine) throw new NoEngine(problem === 'unsupported' ? `${cfg!.name} kan geen losse controle doen` : WHY[problem]);
  // `ownLimit`: a caller with a limit of its own (the look back for skills) does not use up the checks of the day.
  const counted = !req.ownLimit;
  if (counted && !countCall(agent.user_id)) throw new NoEngine(`de controlelimiet van ${DAILY_CALLS} per dag is bereikt`);
  try {
    const r = await runShortCall(ctx, engine, { userId: agent.user_id, agentId: agent.id, system: req.system, prompt: req.prompt, maxTokens: req.maxTokens ?? CHECK_MAX_TOKENS, timeoutMs: req.timeoutMs ?? 60_000 });
    return { text: r.text, engine: r.engine, tokens: r.usage.input + r.usage.output };
  } catch (e) {
    if (isBudgetError(e)) {
      // No call was made: it does not count towards the daily number of checks.
      if (counted) counts.get(agent.user_id)!.n--;
      throw new NoEngine('het dagbudget is op');
    }
    if (e instanceof ShortCallError && e.code === 'unsupported') throw new NoEngine(`${engine.name} kan geen losse controle doen`);
    throw e;
  }
}
