import { priceInfo, type PriceSource } from '../../providers/pricing.js';

/**
 * The one place the cost estimate (estimate.ts) reads a model price, and the same source as every other cost in
 * TeamBot (`estimateCost`): `priceInfo` from providers/pricing.ts. Order of trust there: the owner's own prices → free
 * (own hardware, free models) → the provider's live model list → the few dated overrides in pricing.ts (only where
 * models.dev lacks a price or states it differently from the provider's price page) → the models.dev catalogue
 * (providers/models-dev.ts: dated snapshot, optionally refreshed daily). Unknown stays null: never a guess.
 */

export interface ModelPrice {
  /** USD per 1M tokens. */
  input: number;
  output: number;
  /** USD per 1M cached input tokens: the listed cache price (models.dev: none listed = the input price), else 10 % of input. */
  cacheRead: number;
  source: PriceSource | string;
  checked?: string;
}

export function modelPrice(kind: string, model: string, config?: Record<string, any>): ModelPrice | null {
  const p = priceInfo(kind, model, config);
  if (!p) return null;
  return { input: p.price[0], output: p.price[1], cacheRead: p.cache ?? p.price[0] * 0.1, source: p.source, checked: p.checked };
}

/** USD for this many tokens at this price (cacheRead is part of input). */
export function costAt(price: ModelPrice, t: { input: number; output: number; cacheRead?: number }): number {
  const cached = Math.min(t.input, Math.max(0, t.cacheRead || 0));
  return ((t.input - cached) * price.input + cached * price.cacheRead + t.output * price.output) / 1e6;
}
