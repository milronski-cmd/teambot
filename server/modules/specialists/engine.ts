/** The engine of a learning round (agent/short-call.ts runs and logs the call); see `choose` for the order. */
import type { Agent, Ctx } from '../../core/types.js';
import { judgeEngine, ownEngineRef, pickShortEngine, runShortCall, ShortCallError, type PickOptions, type ShortEngine } from '../../agent/short-call.js';

export interface EngineInfo {
  /** 'free' = the free model service; 'own' = the bot's own engine; 'none' = nothing to learn with. */
  kind: 'free' | 'own' | 'none';
  label: string;
  /** subscription | free | local | paid | unknown */
  billing: string;
  providerId?: string;
  model?: string;
  problem?: string;
}

export interface CallResult {
  text: string;
  usage: { input: number; output: number; cost: number };
  engine: string;
}

const BILLING_LABEL: Record<string, string> = { subscription: 'via je abonnement, geen extra kosten', free: 'gratis', local: 'lokaal, gratis', paid: 'kost geld per ronde' };
const NO_ENGINE: EngineInfo = { kind: 'none', label: 'Geen engine', billing: 'unknown' };

/** A free model of the catalogue that can answer now (an online source this bot may use). */
function freeEngine(ctx: Ctx, rules: PickOptions): { info: EngineInfo; engine: ShortEngine } | null {
  const free = pickShortEngine(ctx, { ...rules, catalogue: true, own: false });
  return free ? { engine: free, info: { kind: 'free', label: `${free.name}${free.model ? ` · ${free.modelLabel || free.model}` : ''} (gratis)`.slice(0, 160), billing: 'free', providerId: free.providerId, model: free.model } } : null;
}

/**
 * The engine of a learning round. By default the specialist's own configured model (a free model only when its own
 * engine cannot answer). With "goedkoper model" (`cheap`): a free model of the catalogue first, else the bot's own
 * engine when that is free or local, else nothing — the round then waits.
 */
function choose(ctx: Ctx, agent: Agent, cheap = false): { info: EngineInfo; engine?: ShortEngine } {
  const rules: PickOptions = { userId: agent.user_id, agent, privacy: agent.settings?.private === true ? 'no-store' : 'any' };
  const free = cheap ? freeEngine(ctx, rules) : null;
  if (free) return free;
  const ref = ownEngineRef(ctx, agent.user_id, agent);
  if (!ref) return freeEngine(ctx, rules) || { info: { ...NO_ENGINE, problem: 'Deze bot heeft nog geen AI-engine. Kies er een bij de bot.' } };
  const v = judgeEngine(ctx, rules, ref, 'own');
  const cfg = ctx.providers.config(v.engine?.providerId ?? v.cfg?.id);
  if (!cfg) return freeEngine(ctx, rules) || { info: { ...NO_ENGINE, problem: 'De engine van deze bot bestaat niet meer.' } };
  const model = v.engine?.model ?? v.model ?? '';
  // In words what a round costs, as the engine's kind states it (a CLI's own login decides in the end).
  const billing = ctx.providers.kind(cfg.kind)?.billing || 'unknown';
  const shown = { label: `${cfg.name}${model ? ` · ${model}` : ''}${BILLING_LABEL[billing] ? ` (${BILLING_LABEL[billing]})` : ''}`, billing, providerId: cfg.id, model };
  if (cheap && !['free', 'local'].includes(billing)) return { info: { kind: 'none', ...shown, problem: 'Er is nu geen gratis of lokaal model om mee te leren; de leerronde wacht daarop. Kies “eigen model” om altijd te leren.' } };
  if (v.engine) return { engine: v.engine, info: { kind: 'own', ...shown } };
  const other = cheap ? null : freeEngine(ctx, rules);
  if (other) return other;
  const problem = v.problem === 'refused' ? v.detail! : v.problem === 'off' ? `${cfg.name} staat uit.` : v.problem === 'model' ? `Kies eerst een model voor ${cfg.name}.` : v.detail || `${cfg.name} kan geen losse vraag beantwoorden; kies een andere engine voor deze bot.`;
  return { info: { kind: 'none', ...shown, problem } };
}

/** Which engine a learning round of this bot uses (no network). */
export function engineFor(ctx: Ctx, agent: Agent, cheap = false): EngineInfo {
  return choose(ctx, agent, cheap).info;
}

/** One answer from the learning engine. Throws a Dutch reason when there is no engine or it fails. */
export async function callEngine(ctx: Ctx, agent: Agent, req: { system: string; prompt: string; maxTokens: number; signal?: AbortSignal; cheap?: boolean }): Promise<CallResult> {
  const { info, engine } = choose(ctx, agent, req.cheap);
  if (!engine) throw new Error(info.problem || 'Geen engine om mee te leren.');
  // Engines that are not local keep the bot's own thinking level.
  const r = await runShortCall(ctx, engine, { ...req, userId: agent.user_id, agentId: agent.id, reasoning: agent.reasoning || undefined }).catch((e) => {
    throw e instanceof ShortCallError && e.code === 'unsupported' ? new Error(`${engine.name} kan geen losse vraag beantwoorden; kies een andere engine voor deze bot.`) : e;
  });
  if (!r.text.trim() && r.stop === 'max_tokens') throw new Error(`${engine.name} dacht te lang na en gaf binnen de limiet geen antwoord.`);
  return { text: r.text, usage: { input: r.usage.input, output: r.usage.output, cost: r.cost }, engine: info.label };
}
