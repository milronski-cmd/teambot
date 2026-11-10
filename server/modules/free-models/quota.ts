import { resetTimeFrom } from '../../agent/fallback.js';
import { safeJson } from '../../providers/common.js';
import type { FreeSourceDef } from './sources.js';

/**
 * Quota signals of the free sources, as pure functions (tested on their own):
 *  - Groq: `x-ratelimit-*` headers on every answer (requests = per day, tokens = per minute; reset as "2m59.56s");
 *  - OpenRouter: `GET /api/v1/key` → `free_model_daily_requests` and, on a 429, `metadata.headers.X-RateLimit-Reset`;
 *  - Cloudflare: error 4006 "daily free allocation" → the next 00:00 UTC;
 *  - everything else: Retry-After, a reset in the message, or a short cooldown that doubles while it keeps failing.
 */

const MIN = 60_000;
const HOUR = 3600_000;

/** "2m59.56s", "7.66s", "1h2m", "450ms" → milliseconds (null when it is no duration). */
export function parseDuration(s: string | null | undefined): number | null {
  const t = String(s ?? '').trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000);
  let ms = 0;
  let hit = false;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi)) {
    hit = true;
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    ms += u === 'ms' ? n : u === 'h' ? n * HOUR : u === 'm' ? n * MIN : n * 1000;
  }
  return hit ? Math.round(ms) : null;
}

export interface Window {
  limit: number | null;
  remaining: number | null;
  resetAt: number | null;
}

const num = (v: string | null) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Groq rate-limit headers: requests = per day (RPD), tokens = per minute (TPM). */
export function groqLimits(h: Headers, now = Date.now()): { requests: Window | null; tokens: Window | null } {
  const win = (what: 'requests' | 'tokens'): Window | null => {
    const limit = num(h.get(`x-ratelimit-limit-${what}`));
    const remaining = num(h.get(`x-ratelimit-remaining-${what}`));
    const reset = parseDuration(h.get(`x-ratelimit-reset-${what}`));
    if (limit === null && remaining === null) return null;
    return { limit, remaining, resetAt: reset !== null ? now + reset : null };
  };
  return { requests: win('requests'), tokens: win('tokens') };
}

/** OpenRouter puts the reset of a 429 inside the error body (epoch ms). */
export function openrouterReset(body: string): number | null {
  const j = safeJson(body || '');
  const hdr = j?.error?.metadata?.headers || {};
  const v = Number(hdr['X-RateLimit-Reset'] ?? hdr['x-ratelimit-reset']);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v < 1e12 ? v * 1000 : v;
}

/** OpenRouter `/api/v1/key` → today's free requests. */
export function openrouterFree(j: any): { used: number | null; limit: number | null; remaining: number | null } | null {
  const f = j?.data?.free_model_daily_requests;
  if (!f || typeof f !== 'object') return null;
  const n = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return { used: n(f.used), limit: n(f.limit), remaining: n(f.remaining) };
}

/** The next 00:00 UTC after `now`. */
export function nextUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Which window a limit message is about. */
export function limitWindow(text: string): 'day' | 'hour' | 'minute' | null {
  const t = String(text || '');
  // OpenRouter names the window it hit; its advice text ("… 1000 free model requests per day") says nothing.
  if (/free-models-per-min/i.test(t)) return 'minute';
  if (/free-models-per-day/i.test(t)) return 'day';
  if (/per[-_ ]?day|daily|free-models-per-day|requests per day|tokens per day|\bRPD\b|\bTPD\b|neurons|today/i.test(t)) return 'day';
  if (/per[-_ ]?hour|hourly|an hour/i.test(t)) return 'hour';
  if (/per[-_ ]?min|free-models-per-min|requests per minute|tokens per minute|\bRPM\b|\bTPM\b|concurren/i.test(t)) return 'minute';
  return null;
}

export interface Cooldown {
  until: number;
  scope: 'account' | 'model';
  /** The reset is known from the provider (header, body, published daily reset), not a guess. */
  known: boolean;
  reason: string;
}

/**
 * How long a source (or one model of it) waits after a 429 / no-credit answer. `hits` = earlier limit answers in a row
 * without a known reset (the guess doubles: 1, 2, 4 … minutes, at most one hour or until the daily reset).
 */
export function limitCooldown(def: Pick<FreeSourceDef, 'quotaScope' | 'dailyReset' | 'hourlyAnon'>, o: { message: string; body?: string; retryAfter?: number; groq?: { requests: Window | null; tokens: Window | null } | null; hits?: number; keyless?: boolean; now?: number }): Cooldown {
  const now = o.now ?? Date.now();
  const text = `${o.message || ''} ${o.body || ''}`;
  const win = limitWindow(text);
  const scope = def.quotaScope;
  // Groq tells exactly which window is empty.
  if (o.groq) {
    const r = o.groq.requests;
    const t = o.groq.tokens;
    if (r && r.remaining === 0 && r.resetAt) return { until: r.resetAt, scope, known: true, reason: 'Daglimiet van dit model bereikt' };
    if (t && t.remaining === 0 && t.resetAt) return { until: t.resetAt, scope, known: true, reason: 'Limiet per minuut bereikt' };
  }
  const orReset = openrouterReset(o.body || '');
  if (orReset && orReset > now) return { until: orReset, scope, known: true, reason: win === 'day' ? 'Daglimiet bereikt' : 'Limiet bereikt' };
  if (win === 'day' && def.dailyReset === 'utc') return { until: nextUtcMidnight(now), scope, known: true, reason: 'Daglimiet bereikt' };
  if (o.retryAfter && o.retryAfter > 0) return { until: now + o.retryAfter * 1000, scope, known: true, reason: win === 'day' ? 'Daglimiet bereikt' : 'Limiet bereikt' };
  const said = resetTimeFrom(o.message || '', now);
  if (said && said > now) return { until: said, scope, known: true, reason: win === 'day' ? 'Daglimiet bereikt' : 'Limiet bereikt' };
  if (win === 'hour' || (o.keyless && def.hourlyAnon)) return { until: now + HOUR, scope: 'account', known: false, reason: 'Uurlimiet bereikt' };
  if (win === 'day') return { until: now + 6 * HOUR, scope, known: false, reason: 'Daglimiet bereikt' };
  const hits = Math.max(0, o.hits || 0);
  const guess = Math.min(HOUR, MIN * 2 ** Math.min(hits, 6));
  const cap = def.dailyReset === 'utc' ? Math.min(now + guess, nextUtcMidnight(now)) : now + guess;
  return { until: cap, scope, known: false, reason: 'Limiet bereikt' };
}
