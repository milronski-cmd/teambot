import { parseLimitReset } from '../routines/limits.js';

/**
 * Usage limits and context fill as the engines report them. Pure functions (no ctx), tested with recorded fixtures.
 *
 * What the engines really expose (verified with Claude Code 2.1.319, Codex CLI 0.167, OpenCode 2.2.5):
 *  - Claude Code: a `rate_limit_event` in stream-json (per request: the window that matters, utilisation 0..1,
 *    reset as epoch seconds, status allowed / allowed_warning / rejected) and the local `/usage` command in print
 *    mode (all windows as text: "Current week (all models): 44% used · resets Nov 13, 5:59am (Europe/Amsterdam)").
 *    The result line has `total_cost_usd` at list price (`costBasis: "list"`) and `modelUsage[m].contextWindow`.
 *  - Codex: app-server `account/rateLimits/read` (+ `account/rateLimits/updated`): primary/secondary windows with
 *    usedPercent, windowDurationMins and resetsAt, plus the plan. `thread/tokenUsage/updated` has the context window.
 *  - OpenCode (ACP): `usage_update` with used/size of the context; `opencode stats --json` for tokens/cost. No limits.
 * Anything an engine does not report stays null ("onbekend"); nothing is guessed.
 */

export type LimitLevel = 'ok' | 'warn' | 'limit' | 'unknown';

export interface LimitWindow {
  /** Stable id per account: "five_hour", "seven_day", "seven_day_opus", "codex:10080" … */
  id: string;
  label: string;
  /** 0–100; null = the engine did not say. */
  usedPercent: number | null;
  /** Epoch ms; null = unknown. */
  resetsAt: number | null;
  level: LimitLevel;
  /** When this window was last reported (epoch ms). */
  at: number;
  /** TeamBot derived the number itself (no exact figure from the provider): shown as "schatting". */
  estimated?: boolean;
}

export interface LimitReport {
  windows: LimitWindow[];
  plan?: string;
  billing?: 'subscription' | 'api' | 'unknown';
  /** Short Dutch note from the engine (e.g. "extra gebruik staat uit"). */
  note?: string;
  /** The engine refused work right now (rejected / usage limit reached). */
  blocked?: boolean;
  source: 'stream' | 'usage-command' | 'app-server' | 'error' | 'stats';
  at: number;
}

export interface ContextFill {
  used: number;
  /** Size of the context window in tokens; null when the engine does not say. */
  window: number | null;
}

export const WARN_AT = 80;

export function levelOf(pct: number | null, status?: string): LimitLevel {
  if (status === 'rejected') return 'limit';
  if (pct === null || !Number.isFinite(pct)) return status === 'allowed' || status === 'allowed_warning' ? 'ok' : 'unknown';
  if (pct >= 100) return 'limit';
  if (pct >= WARN_AT) return 'warn';
  return 'ok';
}

const pct01 = (u: unknown): number | null => (typeof u === 'number' && Number.isFinite(u) ? Math.max(0, Math.min(100, Math.round(u * 1000) / 10)) : null);
const epochMs = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "five_hour" → "Sessie (5 uur)", "seven_day" → "Week · alle modellen", "seven_day_opus" → "Week · Opus". */
export function claudeWindowLabel(id: string): string {
  if (id === 'five_hour') return 'Sessie (5 uur)';
  if (id === 'seven_day') return 'Week · alle modellen';
  const m = id.match(/^seven_day_(.+)$/);
  if (m) return `Week · ${m[1].split('_').map(cap).join(' ')}`;
  if (id === 'overage') return 'Extra gebruik';
  return id.replace(/_/g, ' ');
}

/**
 * Claude Code stream-json `rate_limit_event`:
 * {"rate_limit_info":{"status":"allowed_warning","resetsAt":1794546000,"rateLimitType":"seven_day","utilization":0.44,
 *  "overageStatus":"rejected","unifiedWindows":{"seven_day":{"utilization":0.44,"resetsAt":1794546000,"status":"allowed"}}}}
 */
export function parseClaudeRateLimitEvent(m: any, now = Date.now()): LimitReport | null {
  const info = m?.rate_limit_info;
  if (!info || typeof info !== 'object') return null;
  const windows: LimitWindow[] = [];
  const add = (id: string, w: any) => {
    if (!id || !/^[a-z0-9_]{1,40}$/.test(id) || windows.some((x) => x.id === id)) return;
    const usedPercent = pct01(w?.utilization);
    windows.push({ id, label: claudeWindowLabel(id), usedPercent, resetsAt: epochMs(w?.resetsAt), level: levelOf(usedPercent, typeof w?.status === 'string' ? w.status : undefined), at: now });
  };
  const unified = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : {};
  for (const [id, w] of Object.entries(unified)) add(id, w);
  // The top-level window: its "allowed_warning" is Claude's own early warning, not a limit; the percentage decides.
  if (typeof info.rateLimitType === 'string') add(info.rateLimitType, { ...info, status: info.status === 'rejected' ? 'rejected' : 'allowed' });
  const overageOff = info.overageStatus === 'rejected' || info.overageEnabled === false;
  return {
    windows,
    blocked: info.status === 'rejected',
    note: overageOff ? 'Extra gebruik (overage) staat uit: bij de limiet stopt Claude tot de reset.' : info.isUsingOverage ? 'Claude gebruikt nu extra gebruik (overage).' : undefined,
    source: 'stream',
    at: now,
  };
}

/**
 * Output of Claude Code's `/usage` in print mode, e.g.
 *   You are currently using your subscription to power your Claude Code usage
 *   Current session: 12% used · resets 3:59pm (Europe/Amsterdam)
 *   Current week (all models): 44% used · resets Nov 13, 5:59am (Europe/Amsterdam)
 *   Current week (Fable): 0% used · resets Nov 13, 5:59am (Europe/Amsterdam)
 */
export function parseClaudeUsageText(text: string, now = Date.now(), tz = 'UTC'): LimitReport | null {
  const t = String(text || '');
  if (!t.trim()) return null;
  const windows: LimitWindow[] = [];
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^Current (session|week)(?:\s*\(([^)]{1,40})\))?\s*:\s*(\d{1,3}(?:\.\d+)?)\s*%\s*used(?:\s*[·•|-]\s*(.+))?$/i);
    if (!m) continue;
    const scope = (m[2] || '').trim().toLowerCase();
    const id = m[1].toLowerCase() === 'session' ? 'five_hour' : !scope || /^all/.test(scope) ? 'seven_day' : `seven_day_${scope.replace(/\s+only$/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
    if (windows.some((w) => w.id === id)) continue;
    const usedPercent = Math.min(100, Number(m[3]));
    const resetsAt = m[4] ? parseLimitReset(m[4], now, tz) : null;
    windows.push({ id, label: claudeWindowLabel(id), usedPercent, resetsAt, level: levelOf(usedPercent), at: now });
  }
  const billing = /using your subscription/i.test(t) ? 'subscription' : /api (?:usage|key|billing)|pay[- ]as[- ]you[- ]go/i.test(t) ? 'api' : undefined;
  if (!windows.length && !billing) return null;
  return { windows, billing, source: 'usage-command', at: now, blocked: windows.some((w) => w.level === 'limit') || undefined };
}

/** 300 → "5 uur", 10080 → "Week", 43200 → "30 dagen". */
export function durationLabel(mins: number | null | undefined): string {
  const m = Number(mins);
  if (!Number.isFinite(m) || m <= 0) return 'Limiet';
  if (m === 10080) return 'Week';
  if (m % 1440 === 0) return m === 1440 ? '1 dag' : `${m / 1440} dagen`;
  if (m % 60 === 0) return `${m / 60} uur`;
  return `${m} min`;
}

const PLAN_LABEL: Record<string, string> = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', promax: 'Pro Max', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };

/**
 * Codex app-server `account/rateLimits/read` result (or the `rateLimits` of `account/rateLimits/updated`):
 * { ordinaryUsageAllowed, rateLimits: { limitId, primary: { usedPercent, windowDurationMins, resetsAt }, secondary, planType,
 *   credits, rateLimitReachedType }, rateLimitsByLimitId: { codex: … } }
 */
export function parseCodexRateLimits(r: any, now = Date.now()): LimitReport | null {
  if (!r || typeof r !== 'object') return null;
  const snaps: any[] = [];
  const byId = r.rateLimitsByLimitId && typeof r.rateLimitsByLimitId === 'object' ? Object.values(r.rateLimitsByLimitId).filter(Boolean) : [];
  if (byId.length) snaps.push(...byId);
  else if (r.rateLimits) snaps.push(r.rateLimits);
  else if (r.primary !== undefined || r.secondary !== undefined) snaps.push(r);
  if (!snaps.length) return null;
  const windows: LimitWindow[] = [];
  let plan: string | undefined;
  let reached = false;
  let note: string | undefined;
  for (const s of snaps) {
    const limit = typeof s.limitId === 'string' && s.limitId ? s.limitId.replace(/[^\w.-]/g, '').slice(0, 40) : 'codex';
    const prefix = limit === 'codex' ? '' : `${String(s.limitName || limit).slice(0, 30)} · `;
    for (const w of [s.primary, s.secondary]) {
      if (!w || typeof w !== 'object') continue;
      const mins = Number(w.windowDurationMins) || null;
      const usedPercent = typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) ? Math.max(0, Math.min(100, w.usedPercent)) : null;
      const id = `${limit}:${mins ?? (w === s.primary ? 'primary' : 'secondary')}`;
      if (windows.some((x) => x.id === id)) continue;
      windows.push({ id, label: prefix + durationLabel(mins), usedPercent, resetsAt: epochMs(w.resetsAt), level: levelOf(usedPercent, s.rateLimitReachedType ? 'rejected' : undefined), at: now });
    }
    if (typeof s.planType === 'string' && s.planType !== 'unknown') plan = `ChatGPT ${PLAN_LABEL[s.planType] || s.planType}`;
    if (s.rateLimitReachedType) reached = true;
    if (s.credits?.hasCredits && s.credits.balance) note = `Tegoed: ${String(s.credits.balance).slice(0, 20)}`;
    else if (s.credits?.unlimited) note = 'Onbeperkt tegoed';
  }
  if (r.ordinaryUsageAllowed === false) reached = true;
  return { windows, plan, billing: plan ? 'subscription' : undefined, blocked: reached || undefined, note, source: 'app-server', at: now };
}

/** OpenCode `stats --json` (today): tokens and cost of everything OpenCode did on this computer. */
export function parseOpencodeStats(j: any): { input: number; output: number; cost: number; sessions: number } | null {
  if (!j || typeof j !== 'object' || !j.tokens) return null;
  const t = j.tokens;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { input: n(t.input) + n(t.cache?.read) + n(t.cache?.write), output: n(t.output) + n(t.reasoning), cost: n(j.cost), sessions: n(j.sessions) };
}

/** Context fill of a Claude Code turn: the last top-level request's prompt (incl. cache) plus its output. */
export function claudeContextFromUsage(u: any): number | null {
  if (!u || typeof u !== 'object') return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const used = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens) + n(u.output_tokens);
  return used > 0 ? used : null;
}

/** Claude's token counts of one model call (`usage` of a message or of the result line). */
type ClaudeCounts = { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; output_tokens: number };
const COUNT_KEYS = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'] as const;

/**
 * What one model call of a Claude Code turn reported on the way (`message_start`, `message_delta`, an `assistant`
 * line), by message id: the highest count per field, as each later line of the same call repeats or raises it. A turn
 * that is stopped never writes its result line; this is then what it used (`claudeUsage`).
 */
export function noteClaudeCall(calls: Map<string, ClaudeCounts>, id: unknown, u: any) {
  if (typeof id !== 'string' || !id || !u || typeof u !== 'object') return;
  const cur = calls.get(id) || { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
  for (const k of COUNT_KEYS) cur[k] = Math.max(cur[k], Number(u[k]) || 0);
  calls.set(id, cur);
}

/** TeamBot's usage from Claude's counts (the result line, or the sum of the calls noted so far). */
export function claudeUsage(counts: Iterable<Partial<ClaudeCounts> | null | undefined>): { input: number; output: number; cacheRead: number } {
  const out = { input: 0, output: 0, cacheRead: 0 };
  for (const u of counts) {
    if (!u) continue;
    const cache = Number(u.cache_read_input_tokens) || 0;
    out.cacheRead += cache;
    out.input += (Number(u.input_tokens) || 0) + cache + (Number(u.cache_creation_input_tokens) || 0);
    out.output += Number(u.output_tokens) || 0;
  }
  return out;
}

/** Context window of the model from Claude Code's result line (`modelUsage[model].contextWindow`). */
export function claudeContextWindow(result: any, model?: string): number | null {
  const mu = result?.modelUsage;
  if (!mu || typeof mu !== 'object') return null;
  const pick = (model && mu[model]) || Object.values(mu).find((x: any) => x?.contextWindow) || null;
  const w = Number((pick as any)?.contextWindow);
  return Number.isFinite(w) && w > 0 ? w : null;
}

/** Codex `thread/tokenUsage/updated`: { tokenUsage: { last: { totalTokens, inputTokens, outputTokens }, modelContextWindow } }. */
export function codexContext(p: any): ContextFill | null {
  const tu = p?.tokenUsage;
  const last = tu?.last;
  if (!last) return null;
  const used = Number(last.totalTokens) || (Number(last.inputTokens) || 0) + (Number(last.outputTokens) || 0);
  if (!used) return null;
  const w = Number(tu.modelContextWindow);
  return { used, window: Number.isFinite(w) && w > 0 ? w : null };
}

/** ACP `usage_update`: { used, size, cost? }. */
export function acpContext(u: any): ContextFill | null {
  const used = Number(u?.used);
  if (!Number.isFinite(used) || used <= 0) return null;
  const size = Number(u?.size);
  return { used, window: Number.isFinite(size) && size > 0 ? size : null };
}

/**
 * Merge a new report into the stored windows: a window the report mentions is replaced, others are kept, and a
 * window whose reset has passed drops its percentage (the engine has not said the new value yet).
 */
export function mergeWindows(prev: LimitWindow[], next: LimitWindow[], now = Date.now()): LimitWindow[] {
  const out = new Map<string, LimitWindow>();
  for (const w of prev) out.set(w.id, w);
  for (const w of next) out.set(w.id, w);
  return [...out.values()].map((w) => (w.resetsAt && w.resetsAt <= now && w.usedPercent !== null && w.at < w.resetsAt ? { ...w, usedPercent: null, level: 'unknown' as const, resetsAt: null } : w));
}

/** The most urgent window (limit > warn > highest percentage). */
export function worstWindow(ws: LimitWindow[]): LimitWindow | null {
  const rank = (l: LimitLevel) => (l === 'limit' ? 3 : l === 'warn' ? 2 : l === 'ok' ? 1 : 0);
  return [...ws].sort((a, b) => rank(b.level) - rank(a.level) || (b.usedPercent ?? -1) - (a.usedPercent ?? -1))[0] || null;
}
