/**
 * Short calls: one short, tool-less model call outside the chat (memory learns from a conversation, a specialist reads
 * a source, the second look before "klaar", a lesson from a correction). Every feature that needs such a call uses this
 * file, so they all choose an engine, guard the budget, count tokens and write the usage log the same way.
 *
 * Choosing (`pickShortEngine`, or `judgeEngine` for one given engine), in this fixed order; a caller switches on the
 * sources it wants:
 *   1. `explicit`: the engine the owner picked for this purpose;
 *   2. `catalogue`: the first free model of the free-model catalogue that can answer now (`ctx.services.freeModels`),
 *      by default only a source that keeps nothing;
 *   3. `own`: the bot's own engine (or the owner's default engine);
 *   4. `others`: any other connected engine that costs nothing extra: subscription CLIs first, then a free CLI, a local
 *      model and free API tiers.
 * An engine that costs money is only chosen with `allowPaid` (never from `others`), and a bot is never given an engine
 * its team rules refuse (`providers.refuseFor`).
 *
 * Running (`runShortCall`): no tools, a cap on the answer, a time-out, thinking off on a local model, the owner's daily
 * budget before an engine that costs money, and exactly one `usage_log` row per call (cost 0 for subscription, free and
 * local engines, with the list price as `value`).
 */
import type { Agent, ChatResult, Ctx, ProviderAdapter, ProviderConfig, ProviderKind } from '../core/types.js';
import { now } from '../core/db.js';
import { estimateTokens } from '../core/tokens.js';
import { estimateCost } from '../providers/pricing.js';
import { assertBudget } from './budget.js';

export { estimateTokens };

export type ShortBilling = 'subscription' | 'free' | 'local' | 'paid';
export type ShortSource = 'explicit' | 'catalogue' | 'own' | 'other';
/** Why an engine cannot be used: gone (or not the user's), switched off or resting, refused by the team rules, costs
 *  money without `allowPaid`, no model to call, or it cannot answer a single question. */
export type EngineProblem = 'missing' | 'off' | 'refused' | 'paid' | 'model' | 'unsupported';

export interface EngineRef {
  providerId: string;
  model?: string | null;
}

export interface ShortEngine {
  providerId: string;
  providerKind: string;
  /** 'cli': answers through the CLI's own one-shot (`complete`, or the caller's `transport`). */
  type: 'api' | 'cli';
  /** The engine's name as the owner knows it. */
  name: string;
  model: string;
  /** The catalogue's own name for the model, when it has one. */
  modelLabel?: string;
  billing: ShortBilling;
  source: ShortSource;
  /** "Name · model". */
  label: string;
  /** The program of a CLI engine, when the caller's `cli` judge found it. */
  bin?: string;
}

export interface PickOptions {
  userId: string;
  /** The bot the call is for: its own engine, and its team rules for keys. */
  agent?: Agent | null;
  /** 1. The owner's own choice for this purpose. */
  explicit?: EngineRef | null;
  /** 2. A free model of the catalogue (default off). */
  catalogue?: boolean;
  /** 3. The bot's own engine, or the owner's default (default on). */
  own?: boolean;
  /** 4. Any other connected engine without extra cost (default off). */
  others?: boolean;
  /** May the explicit or own engine cost money (default yes)? `others` never does. */
  allowPaid?: boolean;
  /** Which free sources may read the text: only ones that keep nothing (default), or any. The owner's explicit choice is always allowed. */
  privacy?: 'no-store' | 'any';
  /** A free API tier only with a model the catalogue lists as free and available now (it also sells paid models). */
  checkFreeTier?: boolean;
  /** An extra filter of the caller (an engine that is resting after a limit). */
  usable?: (cfg: ProviderConfig) => boolean;
  /** The caller's own way to run a CLI engine: how it is billed, with which model and program; null = not usable. */
  cli?: (cfg: ProviderConfig, model: string | null, source: ShortSource) => { billing: ShortBilling; model: string; bin?: string } | null;
}

/** The engine, or why not (with the engine's configuration and model when it exists, for the caller's own words). */
export type EngineVerdict = { engine: ShortEngine; problem?: undefined; detail?: undefined; cfg?: undefined; model?: undefined } | { engine?: undefined; problem: EngineProblem; detail?: string; cfg?: ProviderConfig; model?: string };

/** Who pays for an engine of this kind. Unknown counts as paid: then the daily budget applies. */
export function billingOf(kind: ProviderKind | undefined): ShortBilling {
  if (!kind) return 'paid';
  if (kind.billing === 'local' || kind.group === 'local' || kind.section === 'local') return 'local';
  if (kind.billing === 'free' || kind.group === 'free') return 'free';
  if (kind.type === 'cli') return kind.billing === 'paid' ? 'paid' : 'subscription';
  return 'paid';
}

/** The bot's own engine and model; without one the owner's default engine. */
export function ownEngineRef(ctx: Pick<Ctx, 'store'>, userId: string, agent?: Agent | null): EngineRef | null {
  const providerId = agent?.provider_id || ctx.store.getSetting<string | null>(userId, 'defaultProvider', null);
  if (!providerId) return null;
  return { providerId, model: agent?.model || (agent?.provider_id ? '' : ctx.store.getSetting<string>(userId, 'defaultModel', '')) || '' };
}

/** Can this one engine do a short call for this user (and bot), and how? No network. */
export function judgeEngine(ctx: Ctx, o: PickOptions, ref: EngineRef, source: ShortSource): EngineVerdict {
  const cfg = ctx.providers.config(ref.providerId);
  if (!cfg || !ctx.providers.canUse(o.userId, cfg)) return { problem: 'missing' };
  const kind = ctx.providers.kind(cfg.kind);
  let model = ref.model || cfg.config?.defaultModel || kind?.defaultModel || kind?.models?.[0] || '';
  const fail = (problem: EngineProblem, detail?: string): EngineVerdict => ({ problem, detail, cfg, model });
  const refused = o.agent ? ctx.providers.refuseFor(o.agent, cfg) : null;
  if (refused) return fail('refused', refused);
  if (!cfg.enabled || (o.usable && !o.usable(cfg))) return fail('off');
  if (!kind) return fail('unsupported');
  const name = cfg.name || kind.label;
  const allowPaid = source === 'other' ? false : o.allowPaid !== false;
  let billing = source === 'catalogue' ? 'free' : billingOf(kind);
  let bin: string | undefined;
  if (kind.type === 'cli' && o.cli) {
    const own = o.cli(cfg, ref.model || null, source);
    if (!own) return fail('unsupported');
    ({ billing, model, bin } = own);
  } else {
    let adapter: ProviderAdapter;
    try {
      adapter = ctx.providers.adapterFor(cfg);
    } catch (e: any) {
      return fail('unsupported', String(e?.message || e));
    }
    if (!adapter.chat && !adapter.complete) return fail('unsupported');
  }
  if (billing === 'paid' && !allowPaid) return fail('paid');
  if (kind.type === 'api') {
    // A "free" source (Groq, OpenRouter, Kilo, Z.ai …) also offers models that cost money, and some keep or train on
    // what is sent: only a model the catalogue lists as free and available, from a source the privacy level allows.
    if (billing === 'free' && o.checkFreeTier && source !== 'catalogue') {
      const fm = ctx.services.freeModels;
      if (typeof fm?.candidates === 'function') {
        const cands = (fm.candidates({ userId: o.userId, privacy: source === 'explicit' ? 'any' : o.privacy || 'no-store', includeLocal: false }) as any[]).filter((c) => c.providerId === cfg.id && c.engine === 'api');
        const pick = cands.find((c) => c.model === model && c.available) || cands.find((c) => c.available);
        if (!pick) return fail('unsupported');
        model = pick.model;
      } else if (/^(openrouter|kilo)$/.test(cfg.kind) && !/:free$/i.test(model)) return fail('paid');
    }
    if (!model) return fail('model');
  }
  return { engine: { providerId: cfg.id, providerKind: cfg.kind, type: kind.type, name, model, billing, source, label: model && model !== 'default' ? `${name} · ${model}` : name, ...(bin ? { bin } : {}) } };
}

/** The first free model of the catalogue that can answer now, from a source this user (and bot) may use. */
function catalogueEngine(ctx: Ctx, o: PickOptions): ShortEngine | null {
  const fm = ctx.services.freeModels;
  if (typeof fm?.candidates !== 'function') return null;
  let list: any[];
  try {
    const r = fm.candidates({ userId: o.userId, privacy: o.privacy || 'no-store', includeLocal: false, limit: 20 });
    list = Array.isArray(r) ? r : [];
  } catch {
    return null;
  }
  for (const c of list) {
    if (!c?.available || c.engine !== 'api' || typeof c.providerId !== 'string') continue;
    const v = judgeEngine(ctx, o, { providerId: c.providerId, model: String(c.model || '') }, 'catalogue');
    if (v.engine) return { ...v.engine, name: c.providerLabel || v.engine.name, ...(c.modelLabel ? { modelLabel: String(c.modelLabel) } : {}) };
  }
  return null;
}

/** Other engines, best first: subscription CLIs, a free CLI, local models, then free API tiers. */
const OTHERS_RANK: Record<string, number> = { 'claude-code': 0, 'codex-cli': 1, opencode: 2 };

/** The engine for a short call, or null when the sources the caller switched on have none (see the top of this file). */
export function pickShortEngine(ctx: Ctx, o: PickOptions): ShortEngine | null {
  if (o.explicit?.providerId) {
    const v = judgeEngine(ctx, o, o.explicit, 'explicit');
    if (v.engine) return v.engine;
  }
  if (o.catalogue) {
    const e = catalogueEngine(ctx, o);
    if (e) return e;
  }
  const own = ownEngineRef(ctx, o.userId, o.agent);
  if (o.own !== false && own) {
    const v = judgeEngine(ctx, o, own, 'own');
    if (v.engine) return v.engine;
  }
  if (o.others) {
    const rank = (p: ProviderConfig) => OTHERS_RANK[p.kind] ?? (billingOf(ctx.providers.kind(p.kind)) === 'local' ? 5 : 8);
    const rest = ctx.providers
      .list(o.userId)
      .filter((p) => p.id !== own?.providerId && p.enabled)
      .sort((a, b) => rank(a) - rank(b));
    for (const cfg of rest) {
      const v = judgeEngine(ctx, o, { providerId: cfg.id }, 'other');
      if (v.engine) return v.engine;
    }
  }
  return null;
}

// ------------------------------------------------------------------ running one call

/** What one answer came back with, before it is priced and logged. */
export interface RawAnswer {
  text: string;
  /** As the engine reported it; absent = estimated from the texts. */
  usage?: { input: number; output: number; cacheRead?: number };
  model?: string;
  /** What the engine says it cost the owner (USD); null or absent = from the price list. */
  cost?: number | null;
  /** The list price of a call a subscription covered. */
  value?: number;
  stop?: ChatResult['stop'];
}

export interface ShortRequest {
  userId: string;
  agentId?: string | null;
  system: string;
  prompt: string;
  /** Cap on the answer (default 1500 tokens). Only API engines can enforce it. */
  maxTokens?: number;
  /** Also read the answer as one JSON object (`result.json`, null when it has none). */
  json?: boolean;
  signal?: AbortSignal;
  /** Default: two minutes, five for a local model. */
  timeoutMs?: number;
  /** Thinking level for engines that are not local (a local model never thinks here). */
  reasoning?: string;
  /** The caller's own way to get the answer (a CLI it runs itself); budget, pricing and the usage log stay here. */
  transport?: (o: { timeoutMs: number; signal?: AbortSignal }) => Promise<RawAnswer>;
}

export interface ShortResult {
  text: string;
  /** With `json: true`: the JSON object in the answer, or null. */
  json?: any | null;
  usage: { input: number; output: number; cacheRead?: number };
  /** Extra cost for the owner (USD): 0 for subscription, free and local engines. */
  cost: number;
  /** What the call costs at list price (null = unknown). */
  value: number | null;
  model: string;
  /** The engine's label. */
  engine: string;
  latencyMs: number;
  stop?: ChatResult['stop'];
}

/** The call could not be made or gave nothing: the engine cannot answer a single question, or it took too long. */
export class ShortCallError extends Error {
  constructor(
    public code: 'unsupported' | 'timeout',
    message: string,
  ) {
    super(message);
    if (code === 'timeout') this.name = 'TimeoutError';
  }
}

/** Test hook: a fake answer replaces every real engine (unit tests never spawn CLIs or call a provider). */
let fake: ((system: string, prompt: string) => Promise<string> | string) | null = null;
export function setShortCallFake(fn: typeof fake) {
  fake = fn;
}

/** The one place a short call is written to the usage log. Never fails the call. */
function logUsage(ctx: Pick<Ctx, 'store' | 'log'>, row: { userId: string; agentId?: string | null; providerId: string | null; model: string; input: number; output: number; cost: number; value?: number | null }) {
  try {
    ctx.store.insert('usage_log', { user_id: row.userId, agent_id: row.agentId ?? null, provider_id: row.providerId, model: row.model, input: row.input || 0, output: row.output || 0, cost: row.cost || 0, value: row.value ?? null, created_at: now() });
  } catch (e) {
    ctx.log.warn('[short-call] usage not logged', String(e));
  }
}

async function answer(ctx: Ctx, engine: ShortEngine, req: ShortRequest, timeoutMs: number): Promise<RawAnswer> {
  if (fake) return { text: String((await fake(req.system, req.prompt)) ?? ''), cost: 0 };
  if (req.transport) return req.transport({ timeoutMs, signal: req.signal });
  const { adapter } = ctx.providers.adapter(engine.providerId);
  const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  if (adapter.chat) {
    // Ollama lists its models as "name:latest"; only under that exact name can thinking be switched off (live: a bare
    // "qwen3.6-uncensored-snel" thought through all 1500 tokens and answered nothing).
    const model = engine.providerKind === 'ollama' && engine.model && !engine.model.includes(':') ? `${engine.model}:latest` : engine.model;
    // A local model that "thinks" spends the whole answer budget on thinking (seen with Qwen on Ollama): off there.
    const reasoning = engine.billing === 'local' ? 'none' : req.reasoning;
    const r = await adapter.chat({ model, system: req.system, messages: [{ role: 'user', content: req.prompt }], tools: [], maxTokens: req.maxTokens ?? 1500, ...(reasoning ? { reasoning } : {}) }, signal, () => {});
    return { text: r.text || '', usage: r.usage, model: r.model, stop: r.stop };
  }
  if (!adapter.complete) throw new ShortCallError('unsupported', `${engine.name} kan geen losse vraag beantwoorden.`);
  let onAbort: (() => void) | undefined;
  const text = await Promise.race([
    adapter.complete({ model: engine.model || undefined, system: req.system, prompt: req.prompt }),
    new Promise<null>((_, rej) => {
      onAbort = () => rej(req.signal?.aborted ? req.signal.reason : new ShortCallError('timeout', 'het antwoord duurde te lang'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }),
  ]).finally(() => onAbort && signal.removeEventListener('abort', onAbort));
  if (text === null) throw new ShortCallError('unsupported', `${engine.name} kan geen losse vraag beantwoorden.`);
  return { text: String(text), cost: 0 };
}

/**
 * One tool-less call on the chosen engine, logged once. Throws a `BudgetError` (agent/budget.ts) when the engine costs
 * money and the owner's daily budget is used up, a `ShortCallError`, or the engine's own error.
 */
export async function runShortCall(ctx: Ctx, engine: ShortEngine, req: ShortRequest): Promise<ShortResult> {
  if (engine.billing === 'paid') assertBudget(ctx, req.userId);
  const started = Date.now();
  const raw = await answer(ctx, engine, req, req.timeoutMs ?? (engine.billing === 'local' ? 300_000 : 120_000));
  const text = raw.text || '';
  const usage = raw.usage ? { input: raw.usage.input || 0, output: raw.usage.output || 0, ...(raw.usage.cacheRead ? { cacheRead: raw.usage.cacheRead } : {}) } : { input: estimateTokens(req.system.length + req.prompt.length), output: estimateTokens(text) };
  const model = raw.model || engine.model || 'default';
  const listPrice = estimateCost(engine.providerKind, model, usage.input, usage.output, usage.cacheRead || 0, ctx.providers.config(engine.providerId)?.config);
  const cost = engine.billing === 'paid' ? (raw.cost ?? listPrice ?? 0) : raw.cost || 0;
  const value = raw.value ?? listPrice ?? (cost > 0 ? cost : null);
  logUsage(ctx, { userId: req.userId, agentId: req.agentId, providerId: engine.providerId, model, input: usage.input, output: usage.output, cost, value });
  return { text, ...(req.json ? { json: parseJsonObject(text) } : {}), usage, cost, value, model, engine: engine.label, latencyMs: Date.now() - started, ...(raw.stop ? { stop: raw.stop } : {}) };
}

// ------------------------------------------------------------------ reading the answer

/** From an opening brace to its matching closing brace (strings respected); -1 when it never closes. */
function closingBrace(t: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

function firstObject(t: string): any | null {
  for (let start = t.indexOf('{'), tries = 0; start >= 0 && tries < 20; tries++) {
    const end = closingBrace(t, start);
    // Never closed: the answer was cut off. Nothing inside it is taken for the answer.
    if (end < 0) return null;
    try {
      const v = JSON.parse(t.slice(start, end + 1));
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      /* braces in the chatter before the answer ("{x}"): look further */
    }
    start = t.indexOf('{', end + 1);
  }
  return null;
}

/**
 * The first JSON object in a model answer; null when there is none. A fenced block is read first (chatter before it
 * may hold a stray brace), then the whole text; chatter and braces around the object are ignored, an object that was
 * cut off is never read in part, and an array or a bare value is not an object.
 */
export function parseJsonObject(text: string): any | null {
  const s = String(text || '');
  for (const m of s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const v = firstObject(m[1]);
    if (v) return v;
  }
  return firstObject(s.replace(/```(?:json)?/gi, ''));
}
