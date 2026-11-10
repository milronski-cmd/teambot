
import type { ModelInfo } from '../core/types.js';
import { catalogInfo } from './models-dev.js';

/**
 * Cost estimates (USD per 1M tokens, [input, output]).
 *
 * Order of trust: prices the user entered for the provider → free (own hardware, ":free", the free models below) →
 * prices from the provider's own live model list (OpenRouter, Together, DeepInfra, Hugging Face, Cloudflare, ...;
 * refreshed whenever the list is fetched) → the few overrides below (each with the date it was checked against the
 * provider's price page) → the models.dev catalogue (models-dev.ts: a dated snapshot, optionally refreshed daily) →
 * null, shown as "onbekend" — never a guess.
 */

interface PriceRow {
  p: [number, number];
  /** Price for cached input, when it differs from the default 10 % of the input price. */
  cache?: number;
  checked: string;
  src: string;
}

const ANTHROPIC = 'https://platform.claude.com/docs/en/about-claude/pricing';
const OPENAI = 'https://developers.openai.com/api/docs/pricing';
// Anthropic first-party list prices (also Microsoft Foundry); Bedrock/Vertex bill their own partner prices.
const A = '2026-10-06';
/**
 * Overrides: only what models.dev lacks or states differently from the provider's own price page (compared on
 * 2026-11-09 with the snapshot of that day; the other 49 rows of the old table matched models.dev and were removed).
 */
const BUILTIN: Record<string, PriceRow> = {
  // Not in models.dev.
  'claude-mythos-5-1': { p: [10, 50], cache: 0.25, checked: A, src: ANTHROPIC },
  'chat-latest': { p: [5, 30], checked: '2026-11-07', src: OPENAI },
  // models.dev: cache read 0.1; Anthropic's price page: 0.2.
  'claude-sonnet-5-5': { p: [2, 10], cache: 0.2, checked: A, src: ANTHROPIC },
};

/** The maker of a model by its plain id: its first-party catalogue prices it on every provider kind (as the old table did). */
function vendorOf(id: string): string | null {
  if (/^claude-/.test(id)) return 'anthropic';
  if (/^(gpt-|o[1-9]|chatgpt-)/.test(id)) return 'openai';
  if (/^grok-/.test(id)) return 'xai';
  if (/^gemini-/.test(id)) return 'google';
  if (/^glm-/.test(id)) return 'zai';
  return null;
}

/** Models that are free on a paid provider (checked 2026-11-07 on the provider's price page). */
const FREE_MODELS: Record<string, RegExp> = {
  zai: /^glm-(4\.7|4\.5|4\.6v)-flash$/i,
};

/**
 * Kinds whose usual plan is free (Groq's free plan: every model free within its limits, free-models/sources.ts):
 * models.dev lists the paid plan's prices, which would count as spend against a daily budget that costs nothing.
 */
const NO_CATALOGUE_PRICE = new Set(['groq']);

/** Kinds that never cost money (own hardware). */
const FREE_KINDS = new Set(['ollama', 'lmstudio', 'llamacpp', 'vllm', 'jan', 'localai', 'koboldcpp', 'textgen-webui', 'gpt4all', 'lemonade']);
/** Kinds whose models are all free within the provider's limits (GitHub Models, until it stopped on 2026-07-30). */
const FREE_WITHIN_LIMITS = new Set<string>([]);

/** Live list prices per provider kind, from the provider's own /models answer. */
const LIVE = new Map<string, { at: string; prices: Map<string, [number, number]> }>();

/** Called by adapters after every model-list fetch: keeps per-model prices current without a hard-coded table. */
export function rememberListPrices(kind: string, models: ModelInfo[]) {
  const prices = new Map<string, [number, number]>();
  for (const m of models) {
    if (m.price && m.price.every((x) => typeof x === 'number' && x >= 0 && x < 10_000)) prices.set(m.id, [m.price[0], m.price[1]]);
    else if (m.free) prices.set(m.id, [0, 0]);
  }
  if (prices.size) LIVE.set(kind, { at: new Date().toISOString(), prices });
}

export function hasListPrices(kind: string): boolean {
  return LIVE.has(kind);
}

/** Test hook. */
export function clearListPrices() {
  LIVE.clear();
}

/**
 * Prices the user entered for a provider (USD per 1M tokens): `config.prices = { "<model>": [in, out], "*": [in, out] }`.
 * They take precedence over the built-in table, so the daily budget also works for models we have no price for.
 */
export function userPrice(config: Record<string, any> | undefined, model: string): [number, number] | null {
  const p = config?.prices;
  if (!p || typeof p !== 'object') return null;
  const v = p[model] ?? p['*'];
  return Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && x >= 0 && x < 10_000) ? [v[0], v[1]] : null;
}

/** Bedrock/Vertex/OpenRouter style ids → the plain model id of the built-in table. */
function plainId(model: string): string {
  return model
    .replace(/^(us|eu|apac|global|jp|au)\./, '')
    .replace(/^(anthropic[./])/, '')
    .replace(/-v\d+:\d+$/, '')
    .replace(/@\d{8}$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, ''); // OpenAI snapshots: gpt-6-luna-2026-10-01
}

export type PriceSource = 'eigen' | 'lijst' | 'tabel' | 'catalogus' | 'gratis';

/** Price + where it came from (shown in the UI next to the model). */
export function priceInfo(kind: string, model: string, config?: Record<string, any>): { price: [number, number]; source: PriceSource; checked?: string; cache?: number } | null {
  const own = userPrice(config, model);
  if (own) return { price: own, source: 'eigen' };
  if (FREE_KINDS.has(kind) || FREE_WITHIN_LIMITS.has(kind) || /:free$/.test(model) || FREE_MODELS[kind]?.test(model)) return { price: [0, 0], source: 'gratis' };
  const live = LIVE.get(kind)?.prices.get(model);
  if (live) return { price: live, source: live[0] === 0 && live[1] === 0 ? 'gratis' : 'lijst', checked: LIVE.get(kind)!.at.slice(0, 10) };
  const plain = plainId(model);
  const row = BUILTIN[model] || BUILTIN[plain];
  if (row) return { price: row.p, source: 'tabel', checked: row.checked, cache: row.cache };
  // models.dev: the provider's own entry, else the maker's first-party price. No cache-read price listed there means
  // cached input is not cheaper (cache = the input price).
  if (NO_CATALOGUE_PRICE.has(kind)) return null;
  const vendor = vendorOf(plain);
  const cat = catalogInfo(kind, model) ?? (vendor ? catalogInfo(vendor, plain) : null);
  if (cat?.p) return { price: cat.p, source: 'catalogus', checked: cat.checked, cache: cat.cr ?? cat.p[0] };
  return null;
}

export function estimateCost(kind: string, model: string, input: number, output: number, cacheRead = 0, config?: Record<string, any>): number | null {
  const info = priceInfo(kind, model, config);
  if (!info) return null;
  const [pin, pout] = info.price;
  if (pin === 0 && pout === 0) return 0;
  const uncached = Math.max(0, input - cacheRead);
  const cachePrice = info.cache ?? pin * 0.1;
  return (uncached * pin + cacheRead * cachePrice + output * pout) / 1e6;
}

/** The dated table, for the UI ("prijzen gecontroleerd op ..."). */
export function builtinPriceTable(): { model: string; input: number; output: number; checked: string; src: string }[] {
  return Object.entries(BUILTIN).map(([model, r]) => ({ model, input: r.p[0], output: r.p[1], checked: r.checked, src: r.src }));
}
