import { validTimezone, wallTime, zonedToUtc } from './schedule.js';

/**
 * Engine limits (rate limits, subscription usage windows): recognise them in error texts of API providers and CLI
 * engines (Claude Code, Codex, OpenCode, Gemini …) and find out when the limit resets, so work can wait for the reset
 * instead of failing. Pure functions; no ctx.
 */

/** Our own budgets and billing problems are not limits that reset by waiting. */
const NOT_A_RESET = /Daglimiet van (?:US)?\$|Kostenlimiet|kostenplafond|Tokenplafond|insufficient[_ ]quota|check your plan and billing|billing details|credit balance is too low/i;

const LIMIT = /usage limit|rate[ _-]?limit|limit reached|hit your (?:usage )?limit|out of extra usage|gebruikslimiet|limiet (?:bereikt|van je)|too many requests|\b429\b|quota exceeded|exceeded (?:your|the) (?:quota|limit)|resets? (?:at|in|on)\b|try again (?:in|at|after)\b|session limit|weekly limit|5-hour limit/i;

export function isUsageLimit(msg: string | null | undefined): boolean {
  const m = String(msg || '');
  if (!m || (NOT_A_RESET.test(m) && !/reset|try again/i.test(m))) return false;
  return LIMIT.test(m);
}

/** A usage window of a subscription/account (Claude 5-hour or weekly limit, Codex usage limit …), not a short rate limit. */
export function isQuotaWindow(msg: string | null | undefined): boolean {
  return isUsageLimit(msg) && /usage limit|hit your (?:usage )?limit|out of extra usage|gebruikslimiet|session limit|weekly limit|5-hour limit|limit reached\|\d|quota exceeded|exceeded (?:your|the) (?:quota|limit)/i.test(String(msg));
}

const UNIT = /(\d+(?:[.,]\d+)?)\s*(milliseconds?|ms|minutes?|minuten|mins?|m|seconds?|secs?|sec|s|hours?|hrs?|h|uur|days?|dagen|dag|d)(?![a-z])/gi;

/** "2 hours 13 minutes", "6m12.5s", "45 min", "30 s", "4 days 3 hours", "2 uur" â†’ milliseconds (0 = none found). */
export function parseDuration(s: string): number {
  let total = 0;
  let found = false;
  for (const m of String(s).matchAll(UNIT)) {
    found = true;
    const n = parseFloat(m[1].replace(',', '.'));
    const u = m[2].toLowerCase();
    const f = u === 'ms' || u.startsWith('milli') ? 1 : u === 'm' || u.startsWith('min') ? 60_000 : u.startsWith('s') ? 1000 : u.startsWith('h') || u === 'uur' ? 3_600_000 : 86_400_000;
    total += n * f;
  }
  return found ? Math.round(total) : 0;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, mrt: 3, apr: 4, may: 5, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12 };

/**
 * When does the limit in this error reset? Returns a UTC instant (ms) after nowMs, or null when the text does not say.
 * Understands: "limit reached|1762534800" (epoch), ISO timestamps, "try again in 2 hours 13 minutes", "Please try again
 * in 6m12.5s", "Retry-After: 120", "(opnieuw mogelijk over 30 s)", "resets 5pm (Europe/Amsterdam)", "resets at 17:30",
 * "try again at 5:30 PM", "resets Nov 10, 5pm" / "try again at Nov 10th, 2026 3:25 PM". Clock times without a zone
 * are read in `tz`.
 */
export function parseLimitReset(msg: string | null | undefined, nowMs: number, tz = 'UTC'): number | null {
  const s = String(msg || '');
  if (!s) return null;
  // 1. Epoch seconds/ms (Claude Code: "Claude AI usage limit reached|1762534800"; JSON "resetsAt": 1762534800).
  let m = s.match(/limit reached\|(\d{10,13})\b/i) || s.match(/reset(?:s|_at|At|sAt|_time)?["':=\s]{1,4}(\d{10,13})\b/i);
  if (m) {
    const n = Number(m[1]);
    const ms = n < 1e12 ? n * 1000 : n;
    if (ms > nowMs) return ms;
  }
  // 2. ISO timestamp near "reset"/"again"/"until".
  m = s.match(/(?:reset|again|until|tot|available)[^0-9]{0,24}(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i);
  if (m) {
    const iso = /Z|[+-]\d{2}:?\d{2}$/.test(m[1]) ? m[1] : null;
    const t = iso ? Date.parse(iso.replace(' ', 'T')) : (() => {
      const p = m![1].match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)!;
      return zonedToUtc(+p[1], +p[2], +p[3], +p[4], +p[5], validTimezone(tz) ? tz : 'UTC');
    })();
    if (Number.isFinite(t) && t > nowMs) return t;
  }
  // 3. Relative: "Retry-After: 120", "try again in …", "retry after …", "resets in …", "opnieuw mogelijk over …".
  m = s.match(/retry-after["':\s]+(\d+(?:\.\d+)?)\b(?!\s*[a-z])/i);
  if (m) return nowMs + Math.max(1, Number(m[1])) * 1000;
  m = s.match(/(?:try again|retry|opnieuw(?: mogelijk)?|resets?|wait)\s+(?:in|after|over|for)\s+([^\n]{1,80})/i);
  if (m) {
    const part = m[1].split(/\.\s|\.$|;|\)| or | of | and try| en /i)[0];
    const d = parseDuration(part);
    if (d > 0) return nowMs + d;
  }
  // 4. Clock time, optionally with a date and a zone: "resets 5pm (Europe/Amsterdam)", "try again at Nov 10th, 2026 3:25 PM".
  m = s.match(
    /\b(?:resets?|reset at|try again at|again at|available (?:again )?at|until)\b\s*(?:at\s+|on\s+)?(?:(jan|feb|mar|mrt|apr|may|mei|jun|jul|aug|sep|oct|okt|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(?:at\s+|om\s+)?)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?:\s*\(([^)]{2,40})\))?/i,
  );
  if (m && (m[5] !== undefined || m[6] || m[1])) {
    const zone = m[7] && validTimezone(m[7].trim()) ? m[7].trim() : validTimezone(tz) ? tz : 'UTC';
    let h = Number(m[4]);
    const mi = m[5] !== undefined ? Number(m[5]) : 0;
    const ap = (m[6] || '').toLowerCase().replace(/\./g, '');
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || mi > 59) return null;
    const w = wallTime(nowMs, zone);
    if (m[1]) {
      const mon = MONTHS[m[1].slice(0, 3).toLowerCase()] || MONTHS[m[1].toLowerCase()];
      const day = Number(m[2]);
      let y = m[3] ? Number(m[3]) : w.y;
      let t = zonedToUtc(y, mon, day, h, mi, zone);
      if (t <= nowMs && !m[3]) t = zonedToUtc(++y, mon, day, h, mi, zone);
      return t > nowMs ? t : null;
    }
    let t = zonedToUtc(w.y, w.m, w.d, h, mi, zone);
    if (t <= nowMs) {
      const tomorrow = wallTime(nowMs + 86_400_000, zone);
      t = zonedToUtc(tomorrow.y, tomorrow.m, tomorrow.d, h, mi, zone);
    }
    return t;
  }
  return null;
}

/** Waiting time when the error does not say when the limit resets: 15, 30, 60, 60 … minutes. */
export function fallbackLimitWait(previousWaits: number): number {
  return Math.min(60, 15 * 2 ** Math.max(0, previousWaits)) * 60_000;
}
