import type { Agent, Ctx, ProviderConfig } from '../../core/types.js';
import { pauseUntil } from '../../agent/fallback.js';
import { mergeWindows, type LimitWindow } from './parse.js';
import { costAt, modelPrice } from './prices.js';
import type { UsageService } from './service.js';

/**
 * "Kosten vooraf" (package P3): before a big task or routine, what it will roughly cost. The basis is the median of
 * the last runs of the same routine (else the same bot): its tokens times the model price (prices.ts), or, on a
 * subscription, the share of the 5-hour and weekly window that many tokens took so far in that window. Always an
 * estimate (the UI says so); unknown stays null. When the estimate is larger than what is left of a window, the
 * answer carries `startAfter`: the reset (+1 minute, like paused important work) to offer "Start na de reset om …".
 */

/** How many earlier runs count. */
export const ESTIMATE_RUNS = 10;
/** Without "Belangrijk" the estimate is shown from this many dollars … */
export const COST_THRESHOLD_USD = 0.5;
/** … or from this share of a usage window (percent). */
export const WINDOW_THRESHOLD_PCT = 10;

export interface PastRun {
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
}

export interface WindowEstimate {
  id: string;
  label: string;
  usedPercent: number | null;
  /** Estimated share of this window for one run (percent); null = not enough data. */
  share: number | null;
  /** What is left of the window (percent); null = unknown. */
  left: number | null;
  resetsAt: number | null;
  /** Does one run fit in what is left? null = unknown. */
  fits: boolean | null;
}

export interface Estimate {
  estimated: true;
  basis: { runs: number; source: 'routine' | 'bot' | 'none' };
  /** Median tokens of one run. */
  tokens: { input: number; output: number } | null;
  engine: { providerId: string; name: string; kind: string; model: string; billing: string } | null;
  /** Money for one run. covered = paid by a subscription or free (usd 0). */
  cost: { usd: number | null; how: 'price' | 'measured' | 'covered' | 'free' | 'unknown'; priceSource?: string; checked?: string };
  windows: WindowEstimate[];
  startAfter: { at: number; windowId: string; label: string; known: boolean } | null;
  /** Show the estimate before starting (important, over a threshold, or it does not fit). */
  show: boolean;
  reason: 'important' | 'cost' | 'window' | 'nofit' | null;
  important: boolean;
}

export function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Length of a usage window from its id ("five_hour", "seven_day…", "codex:300"); null = unknown. */
export function windowMs(id: string): number | null {
  if (id === 'five_hour') return 5 * 3600_000;
  if (/^seven_day/.test(id)) return 7 * 86_400_000;
  const m = id.match(/:(\d+)$/);
  return m ? Number(m[1]) * 60_000 : null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Pure: one run's share of a window. The window says how full it is (usedPercent); TeamBot's own log says how many
 * tokens went through this account since the window began. Work outside TeamBot on the same account also fills the
 * window, so the share comes out on the high side — never lower than it is.
 */
export function windowShare(w: Pick<LimitWindow, 'usedPercent'>, windowTokens: number, runTokens: number): number | null {
  if (w.usedPercent === null || !(w.usedPercent > 0) || !(windowTokens > 0) || !(runTokens > 0)) return null;
  return round1((runTokens * w.usedPercent) / windowTokens);
}

/** Pure: the window estimates and the reset to wait for when one run does not fit. */
export function fitWindows(windows: LimitWindow[], tokensSince: (sinceMs: number) => number, runTokens: number | null, now = Date.now()): { windows: WindowEstimate[]; startAfter: Estimate['startAfter'] } {
  const out: WindowEstimate[] = [];
  let wait: { at: number; windowId: string; label: string } | null = null;
  for (const w of windows) {
    if (w.id === 'overage') continue;
    const live = w.resetsAt !== null && w.resetsAt > now;
    const used = live ? w.usedPercent : null;
    const left = used === null ? null : Math.max(0, round1(100 - used));
    const len = windowMs(w.id);
    const share = live && len && runTokens ? windowShare({ usedPercent: used }, tokensSince(w.resetsAt! - len), runTokens) : null;
    // Full already, or the estimate is larger than what is left.
    const fits = left === null ? null : left <= 0 ? false : share === null ? null : share <= left;
    out.push({ id: w.id, label: w.label, usedPercent: used, share, left, resetsAt: live ? w.resetsAt : null, fits });
    if (fits === false && live && (!wait || w.resetsAt! > wait.at)) wait = { at: w.resetsAt!, windowId: w.id, label: w.label };
  }
  if (!wait) return { windows: out, startAfter: null };
  const p = pauseUntil(wait.at, now);
  return { windows: out, startAfter: { at: p.at, windowId: wait.windowId, label: wait.label, known: p.known } };
}

/** Pure: why the estimate is shown before starting (it does not fit, important, over a threshold), or null. */
export function reasonToShow(o: { startAfter: unknown; important: boolean; usd: number | null; windows: Pick<WindowEstimate, 'share'>[] }): Estimate['reason'] {
  if (o.startAfter) return 'nofit';
  if (o.important) return 'important';
  if ((o.usd ?? 0) >= COST_THRESHOLD_USD) return 'cost';
  if (o.windows.some((w) => (w.share ?? 0) >= WINDOW_THRESHOLD_PCT)) return 'window';
  return null;
}

function usageOf(raw: string | null | undefined): PastRun | null {
  try {
    const u = JSON.parse(raw || '{}');
    const input = Number(u.input) || 0;
    const output = Number(u.output) || 0;
    if (input + output <= 0) return null;
    return { input, output, cacheRead: Number(u.cacheRead) || 0, cost: Number(u.cost) || 0 };
  } catch {
    return null;
  }
}

/** The last runs of a routine (finished ones with usage). */
function routineRuns(ctx: Ctx, routineId: string): PastRun[] {
  try {
    return ctx.store
      .all<{ usage: string }>("SELECT usage FROM routine_runs WHERE routine_id = ? AND status IN ('done','no_update') ORDER BY created_at DESC LIMIT ?", routineId, ESTIMATE_RUNS * 2)
      .map((r) => usageOf(r.usage))
      .filter((x): x is PastRun => !!x)
      .slice(0, ESTIMATE_RUNS);
  } catch {
    return [];
  }
}

function botRuns(ctx: Ctx, agent: Agent): PastRun[] {
  return ctx.store
    .all<{ usage: string }>("SELECT usage FROM runs WHERE agent_id = ? AND user_id = ? AND status = 'done' ORDER BY created_at DESC LIMIT ?", agent.id, agent.user_id, ESTIMATE_RUNS * 2)
    .map((r) => usageOf(r.usage))
    .filter((x): x is PastRun => !!x)
    .slice(0, ESTIMATE_RUNS);
}

export function estimateFor(ctx: Ctx, usage: UsageService, o: { agent: Agent; routine?: { id: string; providerId?: string | null; important?: boolean } | null; important?: boolean; now?: number }): Estimate {
  const now = o.now ?? Date.now();
  const agent = o.agent;
  const important = !!(o.important || o.routine?.important);
  let runs = o.routine ? routineRuns(ctx, o.routine.id) : [];
  let source: Estimate['basis']['source'] = runs.length ? 'routine' : 'none';
  if (!runs.length) {
    runs = botRuns(ctx, agent);
    if (runs.length) source = 'bot';
  }
  const med = runs.length
    ? { input: Math.round(median(runs.map((r) => r.input))!), output: Math.round(median(runs.map((r) => r.output))!), cacheRead: Math.round(median(runs.map((r) => r.cacheRead))!), cost: median(runs.map((r) => r.cost))! }
    : null;

  // The engine the work starts on (the routine's own engine, else the bot's, else the owner's default).
  const providerId = o.routine?.providerId || agent.provider_id || ctx.store.getSetting<string | null>(agent.user_id, 'defaultProvider', null);
  const cfg: ProviderConfig | undefined = (providerId && ctx.providers.config(providerId)) || undefined;
  const kind = cfg ? ctx.providers.kind(cfg.kind) : undefined;
  const model = cfg ? agent.model || (!agent.provider_id ? ctx.store.getSetting<string>(agent.user_id, 'defaultModel', '') : '') || cfg.config?.defaultModel || kind?.defaultModel || kind?.models?.[0] || '' : '';
  const billing = cfg ? usage.billingOf(cfg) : 'unknown';
  const engine = cfg ? { providerId: cfg.id, name: cfg.name, kind: cfg.kind, model, billing } : null;

  let cost: Estimate['cost'] = { usd: null, how: 'unknown' };
  if (billing === 'subscription') cost = { usd: 0, how: 'covered' };
  else if (billing === 'free' || billing === 'local') cost = { usd: 0, how: 'free' };
  else if (cfg && med) {
    const price = modelPrice(cfg.kind, model, cfg.config);
    if (price) cost = { usd: costAt(price, med), how: price.input === 0 && price.output === 0 ? 'free' : 'price', priceSource: String(price.source), checked: price.checked };
    else if (med.cost > 0) cost = { usd: med.cost, how: 'measured' };
  }

  // Subscription windows: the share of one run, and the reset to wait for when it does not fit.
  let windows: WindowEstimate[] = [];
  let startAfter: Estimate['startAfter'] = null;
  if (cfg && billing !== 'free' && billing !== 'local') {
    const st = usage.state(cfg.id, cfg.user_id);
    const ws = mergeWindows(st.windows || [], [], now);
    const runTokens = med ? med.input + med.output : null;
    const tokensSince = (since: number) =>
      Number(ctx.store.one<{ n: number }>('SELECT COALESCE(SUM(input + output), 0) AS n FROM usage_log WHERE provider_id = ? AND created_at >= ?', cfg.id, new Date(since).toISOString())?.n) || 0;
    const fit = fitWindows(ws, tokensSince, runTokens, now);
    windows = fit.windows;
    startAfter = fit.startAfter;
    // The engine refused work until a known moment: that is the reset to wait for.
    const b = st.blocked;
    if (b?.until && b.until > now && (!startAfter || b.until > startAfter.at)) {
      const p = pauseUntil(b.until, now);
      startAfter = { at: p.at, windowId: 'blocked', label: b.label || 'Limiet', known: p.known };
    }
  }

  const reason = reasonToShow({ startAfter, important, usd: cost.usd, windows });
  return {
    estimated: true,
    basis: { runs: runs.length, source },
    tokens: med ? { input: med.input, output: med.output } : null,
    engine,
    cost,
    windows,
    startAfter,
    show: reason !== null,
    reason,
    important,
  };
}
