import { Cron } from 'croner';
import { tr } from '../../core/i18n.js';
import { localeOf } from '../../../shared/languages.js';
import { formatList } from '../../../shared/format.js';

/**
 * Schedules are stored as small JSON objects. Wall-clock times are always
 * interpreted in the routine's IANA timezone, so DST transitions are handled
 * per zone (croner for recurring patterns, Intl for one-off dates).
 */
export type Schedule =
  | { kind: 'none' }
  | { kind: 'once'; at: string } // local wall time 'YYYY-MM-DDTHH:mm' in the routine timezone
  | { kind: 'interval'; everyMinutes: number; anchor: string } // anchor = ISO UTC instant
  | { kind: 'weekly'; days: number[]; times: string[] } // days 0 = zondag … 6 = zaterdag
  | { kind: 'monthly'; days: MonthDay[]; times: string[]; months?: number[] }
  | { kind: 'cron'; expr: string };

/**
 * A day in a month: 1–31 (a day that does not exist in a short month falls on its last day), 'L' (last day),
 * 'FW' / 'LW' (first / last workday, Monday–Friday) or an nth weekday like '1MO' (first Monday), '3WE' (third
 * Wednesday), '-1FR' (last Friday). A month without such a day (a fifth Monday) is skipped.
 */
export type MonthDay = number | string;

export const DEFAULT_TZ = 'Europe/Amsterdam';

export function validTimezone(tz: string): boolean {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function systemTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return validTimezone(tz) ? tz : DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

// ---------- timezone arithmetic ----------

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    dtfCache.set(tz, f);
  }
  return f;
}
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface WallTime {
  y: number;
  m: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
  dow: number; // 0 = Sunday
}

export function wallTime(ms: number, tz: string): WallTime {
  const p: Record<string, string> = {};
  for (const x of dtf(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, dow: WD[p.weekday] ?? 0 };
}

function offsetAt(ms: number, tz: string): number {
  const w = wallTime(ms, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * Convert a wall-clock time in `tz` to a UTC instant. Ambiguous times (DST fall-back)
 * resolve to the first occurrence; non-existent times (spring-forward gap) move forward
 * by the size of the gap (02:30 → 03:30 in Europe/Amsterdam).
 */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const before = offsetAt(guess - 86_400_000, tz);
  const after = offsetAt(guess + 86_400_000, tz);
  const candidates = [...new Set([guess - before, guess - after])].sort((a, b) => a - b);
  for (const c of candidates) {
    const w = wallTime(c, tz);
    if (w.y === y && w.m === m && w.d === d && w.h === h && w.mi === mi) return c;
  }
  return guess - before;
}

/** UTC instant of local midnight (start of the calendar day) in `tz`. */
export function startOfDay(ms: number, tz: string): number {
  const w = wallTime(ms, tz);
  return zonedToUtc(w.y, w.m, w.d, 0, 0, tz);
}

// ---------- validation ----------

const DAY_NAMES: Record<string, number> = {
  zo: 0, zon: 0, zondag: 0, su: 0, sun: 0, sunday: 0,
  ma: 1, maa: 1, maandag: 1, mo: 1, mon: 1, monday: 1,
  di: 2, din: 2, dinsdag: 2, tu: 2, tue: 2, tuesday: 2,
  wo: 3, woe: 3, woensdag: 3, we: 3, wed: 3, wednesday: 3,
  do: 4, don: 4, donderdag: 4, th: 4, thu: 4, thursday: 4,
  vr: 5, vrij: 5, vrijdag: 5, fr: 5, fri: 5, friday: 5,
  za: 6, zat: 6, zaterdag: 6, sa: 6, sat: 6, saturday: 6,
};

export function parseDay(v: any): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v === 7 ? 0 : v >= 0 && v <= 6 ? v : null;
  const s = String(v ?? '').trim().toLowerCase();
  if (/^[0-7]$/.test(s)) return Number(s) % 7;
  return DAY_NAMES[s] ?? null;
}

function parseTime(v: any): string | null {
  const m = String(v ?? '').trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function parseLocalDateTime(v: any): { y: number; m: number; d: number; h: number; mi: number } | null {
  const m = String(v ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  if (!m) return null;
  const r = { y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
  if (r.m < 1 || r.m > 12 || r.d < 1 || r.d > 31 || r.h > 23 || r.mi > 59) return null;
  return r;
}

// ---------- monthly ----------

const WD_CODE = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WD_NL: Record<string, number> = { zo: 0, ma: 1, di: 2, wo: 3, do: 4, vr: 5, za: 6 };

/** Canonical month-day token, or null. Accepts 1–31, L/laatste, FW/LW, '1MO'…'5SU', '-1FR', 'LFR', '1ma', 'laatste vr'. */
export function parseMonthDay(v: any): MonthDay | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 31 ? v : null;
  const s = String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (/^\d{1,2}$/.test(s)) return parseMonthDay(Number(s));
  if (s === 'L' || s === 'LAST' || s === 'LAATSTE' || s === 'LAATSTE DAG') return 'L';
  if (s === 'FW' || s === 'EERSTE WERKDAG' || s === 'FIRST WORKDAY') return 'FW';
  if (s === 'LW' || s === 'LAATSTE WERKDAG' || s === 'LAST WORKDAY') return 'LW';
  const m = s.match(/^(-1|L|LAATSTE |[1-5])\s?([A-Z]{2})$/);
  if (!m) return null;
  const code = m[2];
  const wd = WD_CODE.includes(code) ? code : WD_NL[code.toLowerCase()] !== undefined ? WD_CODE[WD_NL[code.toLowerCase()]] : null;
  if (!wd) return null;
  const n = m[1].trim() === 'L' || m[1].trim() === 'LAATSTE' || m[1] === '-1' ? '-1' : m[1];
  return `${n}${wd}`;
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const weekday = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/** Calendar days (1-based, sorted, unique) of month m in year y that match the tokens. */
export function monthDays(y: number, m: number, tokens: MonthDay[]): number[] {
  const n = daysInMonth(y, m);
  const out = new Set<number>();
  const isWork = (d: number) => weekday(y, m, d) >= 1 && weekday(y, m, d) <= 5;
  for (const t of tokens) {
    if (typeof t === 'number') out.add(Math.min(t, n));
    else if (t === 'L') out.add(n);
    else if (t === 'FW') {
      let d = 1;
      while (!isWork(d)) d++;
      out.add(d);
    } else if (t === 'LW') {
      let d = n;
      while (!isWork(d)) d--;
      out.add(d);
    } else {
      const mm = String(t).match(/^(-1|[1-5])([A-Z]{2})$/);
      if (!mm) continue;
      const wd = WD_CODE.indexOf(mm[2]);
      if (mm[1] === '-1') {
        let d = n;
        while (weekday(y, m, d) !== wd) d--;
        out.add(d);
      } else {
        let d = 1;
        while (weekday(y, m, d) !== wd) d++;
        d += (Number(mm[1]) - 1) * 7;
        if (d <= n) out.add(d);
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

function nextMonthly(s: { days: MonthDay[]; times: string[]; months?: number[] }, tz: string, afterMs: number): number | null {
  const w = wallTime(afterMs, tz);
  const times = s.times.map((t) => t.split(':').map(Number));
  // Up to 5 years ahead (covers sparse cases such as "the 31st, only in February" → never, and quarterly schedules).
  for (let i = 0; i < 60; i++) {
    const y = w.y + Math.floor((w.m - 1 + i) / 12);
    const m = ((w.m - 1 + i) % 12) + 1;
    if (s.months?.length && !s.months.includes(m)) continue;
    const candidates: number[] = [];
    for (const d of monthDays(y, m, s.days)) for (const [h, mi] of times) candidates.push(zonedToUtc(y, m, d, h, mi, tz));
    candidates.sort((a, b) => a - b);
    const hit = candidates.find((c) => c > afterMs);
    if (hit !== undefined) return hit;
  }
  return null;
}

const NICK: Record<string, string> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };

export function normalizeCron(expr: string): string {
  const e = String(expr || '').trim().replace(/\s+/g, ' ');
  return NICK[e.toLowerCase()] || e;
}

const cronCache = new Map<string, Cron>();
function cron(expr: string, tz: string): Cron {
  const key = `${expr}|${tz}`;
  let c = cronCache.get(key);
  if (!c) {
    c = new Cron(expr, { timezone: tz, paused: true, mode: '5-part' });
    if (cronCache.size > 500) cronCache.clear();
    cronCache.set(key, c);
  }
  return c;
}

export class ScheduleError extends Error {}

/** Validate user/agent input into a canonical Schedule. Throws ScheduleError (Dutch message). */
export function normalizeSchedule(input: any, tz: string, nowMs: number, opts: { allowPast?: boolean } = {}): Schedule {
  const kind = String(input?.kind || 'none');
  if (!validTimezone(tz)) throw new ScheduleError(`Onbekende tijdzone: ${tz}`);
  switch (kind) {
    case 'none':
      return { kind: 'none' };
    case 'once': {
      const p = parseLocalDateTime(input.at);
      if (!p) throw new ScheduleError('Geef datum en tijd als JJJJ-MM-DDTUU:MM (bijv. 2026-11-12T09:00).');
      const at = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}T${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
      const ms = zonedToUtc(p.y, p.m, p.d, p.h, p.mi, tz);
      if (!opts.allowPast && ms <= nowMs) throw new ScheduleError('Dit tijdstip ligt in het verleden.');
      return { kind: 'once', at };
    }
    case 'interval': {
      const n = Math.round(Number(input.everyMinutes));
      if (!Number.isFinite(n) || n < 1) throw new ScheduleError('Het interval moet minstens 1 minuut zijn.');
      if (n > 60 * 24 * 366) throw new ScheduleError('Het interval mag maximaal een jaar zijn.');
      let anchor = input.anchor ? Date.parse(input.anchor) : NaN;
      if (!Number.isFinite(anchor)) anchor = nowMs;
      return { kind: 'interval', everyMinutes: n, anchor: new Date(anchor).toISOString() };
    }
    case 'weekly': {
      const rawDays: any[] = Array.isArray(input.days) ? input.days : [];
      const days: number[] = [...new Set(rawDays.map(parseDay).filter((d): d is number => d !== null))].sort((a, b) => a - b);
      if (!days.length) throw new ScheduleError('Kies minstens één dag.');
      const rawTimes: any[] = Array.isArray(input.times) ? input.times : [input.time];
      const times: string[] = [...new Set(rawTimes.map(parseTime).filter((t): t is string => !!t))].sort();
      if (!times.length) throw new ScheduleError('Kies minstens één tijd (UU:MM).');
      if (times.length > 24) throw new ScheduleError('Maximaal 24 tijden per dag.');
      return { kind: 'weekly', days, times };
    }
    case 'monthly': {
      const rawDays: any[] = Array.isArray(input.days) ? input.days : input.days !== undefined ? [input.days] : [];
      const parsed = rawDays.map(parseMonthDay);
      if (!rawDays.length || parsed.some((d) => d === null)) throw new ScheduleError('Kies minstens één dag van de maand: 1–31, “laatste dag”, “eerste/laatste werkdag” of bijv. “eerste maandag”.');
      const days = [...new Set(parsed as MonthDay[])].slice(0, 31);
      const rawTimes: any[] = Array.isArray(input.times) ? input.times : [input.time];
      const times: string[] = [...new Set(rawTimes.map(parseTime).filter((t): t is string => !!t))].sort();
      if (!times.length) throw new ScheduleError('Kies minstens één tijd (UU:MM).');
      if (times.length > 24) throw new ScheduleError('Maximaal 24 tijden per dag.');
      const months = Array.isArray(input.months) ? [...new Set(input.months.map(Number).filter((m: number) => Number.isInteger(m) && m >= 1 && m <= 12))].sort((a: any, b: any) => a - b) : [];
      const out: Schedule = { kind: 'monthly', days, times, ...(months.length && months.length < 12 ? { months: months as number[] } : {}) };
      if (nextRunAfter(out, tz, nowMs) === null) throw new ScheduleError('Dit maandschema valt nooit (bijv. de 31e in een maand die geen 31 dagen heeft).');
      return out;
    }
    case 'cron': {
      const expr = normalizeCron(input.expr);
      if (expr.split(' ').length !== 5) throw new ScheduleError('Een cron-schema heeft precies 5 velden: minuut uur dag maand weekdag (bijv. "0 9 * * 1-5").');
      try {
        const c = new Cron(expr, { timezone: tz, paused: true, mode: '5-part' });
        if (!c.nextRun(new Date(nowMs))) throw new Error('nooit');
      } catch (e: any) {
        throw new ScheduleError(`Ongeldig cron-schema: ${String(e?.message || e).replace(/^CronPattern:\s*/, '').slice(0, 160)}`);
      }
      return { kind: 'cron', expr };
    }
    default:
      throw new ScheduleError(`Onbekend schematype: ${kind}`);
  }
}

/**
 * The flat way a bot gives a schedule (routine_create, and a change through my_routines or the API): schedule_kind
 * (once, interval, weekly, daily, monthly, cron) with at, every_minutes, days, times (or time), month_days, months, cron.
 * As tool parameters (JSON schema), the same for making a routine and for changing one.
 */
export const FLAT_SCHEDULE_PROPS = {
  schedule_kind: { type: 'string', enum: ['once', 'interval', 'weekly', 'daily', 'monthly', 'cron'] },
  month_days: { type: 'array', items: { type: 'string' }, description: 'Voor monthly: 1–31, "L", "LW", "FW", "1MO", "-1FR" …' },
  months: { type: 'array', items: { type: 'number' }, description: 'Voor monthly (optioneel): alleen deze maanden 1–12, bijv. [1,4,7,10] voor elk kwartaal' },
  at: { type: 'string', description: "Voor once: lokale datum en tijd 'JJJJ-MM-DDTUU:MM'" },
  every_minutes: { type: 'number', description: 'Voor interval: aantal minuten (minimaal 1)' },
  days: { type: 'array', items: { type: 'string' }, description: 'Voor weekly: dagen als ma, di, wo, do, vr, za, zo' },
  times: { type: 'array', items: { type: 'string' }, description: "Voor weekly/daily/monthly: tijden 'UU:MM'" },
  cron: { type: 'string', description: 'Voor cron: 5-veld cron-expressie, bijv. "0 9 * * 1-5"' },
};
export const FLAT_SCHEDULE_FIELDS = [...Object.keys(FLAT_SCHEDULE_PROPS), 'time'];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
/** A list from one value or many; nothing (also an empty list) is undefined. */
const list = (v: any): any[] | undefined => {
  const l = v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v];
  return l.length ? l : undefined;
};

/**
 * The schedule those flat fields describe (still to be checked by normalizeSchedule), or null when none is given.
 * `base` is the schedule a routine has now: without schedule_kind the fields change only what they name, so `times`
 * alone moves the time and keeps the days (a one-time routine keeps its date), and `days` alone keeps the times.
 */
export function scheduleFromFlat(a: any, base?: Schedule | null): any | null {
  if (!a || typeof a !== 'object' || !FLAT_SCHEDULE_FIELDS.some((k) => a[k] !== undefined)) return null;
  const times = list(a.times) ?? list(a.time);
  const days = list(a.days);
  const kind = String(a.schedule_kind || '').toLowerCase() || (a.at !== undefined ? 'once' : a.every_minutes !== undefined ? 'interval' : a.cron !== undefined ? 'cron' : a.month_days !== undefined || a.months !== undefined ? 'monthly' : base?.kind === 'monthly' ? 'monthly' : base?.kind === 'once' && times && !days ? 'once' : 'weekly');
  if (kind === 'once') return { kind, at: a.at ?? (base?.kind === 'once' && times ? `${base.at.slice(0, 10)}T${times[0]}` : undefined) };
  if (kind === 'interval') return { kind, everyMinutes: Number(a.every_minutes) };
  if (kind === 'cron') return { kind, expr: a.cron };
  if (kind === 'weekly' || kind === 'daily')
    return { kind: 'weekly', days: kind === 'daily' ? EVERY_DAY : (days ?? (base?.kind === 'weekly' ? base.days : EVERY_DAY)), times: times ?? (base?.kind === 'weekly' || base?.kind === 'monthly' ? base.times : []) };
  if (kind === 'monthly') {
    const was = base?.kind === 'monthly' ? base : null;
    return { kind, days: list(a.month_days) ?? was?.days ?? [1], times: times ?? was?.times ?? (base?.kind === 'weekly' ? base.times : []), months: list(a.months) ?? was?.months };
  }
  return { kind };
}

function weeklyPatterns(s: { days: number[]; times: string[] }): string[] {
  return s.times.map((t) => {
    const [h, mi] = t.split(':').map(Number);
    return `${mi} ${h} * * ${s.days.join(',')}`;
  });
}

/** First scheduled instant strictly after `afterMs`, or null when the schedule never fires again. */
export function nextRunAfter(s: Schedule, tz: string, afterMs: number): number | null {
  switch (s.kind) {
    case 'none':
      return null;
    case 'once': {
      const p = parseLocalDateTime(s.at);
      if (!p) return null;
      const ms = zonedToUtc(p.y, p.m, p.d, p.h, p.mi, tz);
      return ms > afterMs ? ms : null;
    }
    case 'interval': {
      const step = s.everyMinutes * 60_000;
      const anchor = Date.parse(s.anchor);
      if (afterMs < anchor) return anchor;
      return anchor + (Math.floor((afterMs - anchor) / step) + 1) * step;
    }
    case 'monthly':
      return nextMonthly(s, tz, afterMs);
    case 'weekly':
    case 'cron': {
      const patterns = s.kind === 'weekly' ? weeklyPatterns(s) : [s.expr];
      let best: number | null = null;
      for (const p of patterns) {
        const d = cron(p, tz).nextRun(new Date(afterMs));
        if (d && (best === null || d.getTime() < best)) best = d.getTime();
      }
      return best;
    }
  }
}

/** Occurrences in [fromMs, toMs] (inclusive), capped. Returns count and the last occurrence. */
export function occurrencesBetween(s: Schedule, tz: string, fromMs: number, toMs: number, cap = 5000): { count: number; last: number | null; capped: boolean } {
  let count = 0;
  let last: number | null = null;
  if (s.kind === 'interval') {
    const step = s.everyMinutes * 60_000;
    const anchor = Date.parse(s.anchor);
    const first = fromMs <= anchor ? anchor : anchor + Math.ceil((fromMs - anchor) / step) * step;
    if (first > toMs) return { count: 0, last: null, capped: false };
    count = Math.floor((toMs - first) / step) + 1;
    last = first + (count - 1) * step;
    return { count, last, capped: false };
  }
  let t = nextRunAfter(s, tz, fromMs - 1);
  while (t !== null && t <= toMs) {
    count++;
    last = t;
    if (count >= cap) return { count, last, capped: true };
    t = nextRunAfter(s, tz, t);
  }
  return { count, last, capped: false };
}

export function nextRuns(s: Schedule, tz: string, afterMs: number, n: number): number[] {
  const out: number[] = [];
  let t: number | null = afterMs;
  for (let i = 0; i < n; i++) {
    t = nextRunAfter(s, tz, t!);
    if (t === null) break;
    out.push(t);
  }
  return out;
}

/** Average runs per day over the next week (for limit warnings). */
export function runsPerDay(s: Schedule, tz: string, nowMs: number): number {
  if (s.kind === 'none' || s.kind === 'once') return s.kind === 'once' ? 1 : 0;
  if (s.kind === 'interval') return Math.round((1440 / s.everyMinutes) * 10) / 10;
  return Math.round((occurrencesBetween(s, tz, nowMs, nowMs + 7 * 86_400_000, 20_000).count / 7) * 10) / 10;
}

// ---------- human readable (Dutch, or the language of the person who reads it) ----------
// `lang` 'nl' (the default; the bots read Dutch) gives the Dutch sentences; another language gives the same sentence
// from the dictionary (tr) with weekday and month names and lists from Intl ("Every Monday, Wednesday and Friday").

const DAY_LONG = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];

/** "a, b en c" in the reader's language. */
const joinIn = (items: string[], lang: string) => formatList(items, localeOf(lang));
/** A weekday's name (0 = Sunday) in the reader's language. */
const dayIn = (d: number, lang: string) => (lang === 'nl' ? DAY_LONG[d] : new Intl.DateTimeFormat(localeOf(lang), { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + d))));

function describeDays(days: number[], lang = 'nl'): string {
  const set = [...new Set(days)].sort((a, b) => a - b);
  if (set.length === 7) return tr(lang, 'Elke dag');
  if (set.join(',') === '1,2,3,4,5') return tr(lang, 'Elke werkdag (ma–vr)');
  if (set.join(',') === '0,6') return tr(lang, 'Elk weekend (za en zo)');
  // Monday-first ordering for display
  const ordered = [...set.filter((d) => d !== 0), ...set.filter((d) => d === 0)];
  return tr(lang, 'Elke {0}', joinIn(ordered.map((d) => dayIn(d, lang)), lang));
}

function describeInterval(n: number, lang = 'nl'): string {
  if (n === 1) return tr(lang, 'Elke minuut');
  if (n % 1440 === 0) return n === 1440 ? tr(lang, 'Elke 24 uur') : tr(lang, 'Elke {0} dagen', n / 1440);
  if (n % 60 === 0) return n === 60 ? tr(lang, 'Elk uur') : tr(lang, 'Elke {0} uur', n / 60);
  return tr(lang, 'Elke {0} minuten', n);
}

function expandCronField(f: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of f.split(',')) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : a;
    if (a < min || b > max || a > b) return null;
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out];
}

export function describeCron(expr: string, lang = 'nl'): string {
  const [mi, h, dom, mon, dow] = expr.split(' ');
  const two = (x: string) => x.padStart(2, '0');
  if (/^\*\/(\d+)$/.test(mi) && h === '*' && dom === '*' && mon === '*' && dow === '*') return describeInterval(Number(mi.slice(2)), lang);
  if (/^\d+$/.test(mi) && h === '*' && dom === '*' && mon === '*' && dow === '*') return mi === '0' ? tr(lang, 'Elk heel uur') : tr(lang, 'Elk uur om :{0}', two(mi));
  if (/^\d+$/.test(mi) && /^[\d,]+$/.test(h) && mon === '*') {
    const times = joinIn(h.split(',').map((x) => `${two(x)}:${two(mi)}`), lang);
    if (dom === '*' && dow === '*') return tr(lang, 'Elke dag om {0}', times);
    if (dom === '*') {
      const days = expandCronField(dow.replace(/7/g, '0'), 0, 6);
      if (days) return tr(lang, '{0} om {1}', describeDays(days, lang), times);
    }
    if (/^\d+$/.test(dom) && dow === '*') return tr(lang, 'Elke maand op de {0}e om {1}', dom, times);
  }
  return tr(lang, 'Cron-schema: {0}', expr);
}

const ORD = ['', 'eerste', 'tweede', 'derde', 'vierde', 'vijfde'];
const MONTH_SHORT = ['', 'jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const monthIn = (m: number, lang: string) => (lang === 'nl' ? MONTH_SHORT[m] : new Intl.DateTimeFormat(localeOf(lang), { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, m - 1, 15))));

export function describeMonthDay(t: MonthDay, lang = 'nl'): string {
  if (typeof t === 'number') return tr(lang, 'de {0}e', t);
  if (t === 'L') return tr(lang, 'de laatste dag');
  if (t === 'FW') return tr(lang, 'de eerste werkdag');
  if (t === 'LW') return tr(lang, 'de laatste werkdag');
  const m = String(t).match(/^(-1|[1-5])([A-Z]{2})$/);
  if (!m) return String(t);
  return tr(lang, 'de {0} {1}', tr(lang, m[1] === '-1' ? 'laatste' : ORD[Number(m[1])]), dayIn(WD_CODE.indexOf(m[2]), lang));
}

function describeMonthly(s: { days: MonthDay[]; times: string[]; months?: number[] }, lang = 'nl'): string {
  const days = joinIn(s.days.map((d) => describeMonthDay(d, lang)), lang);
  const times = joinIn(s.times, lang);
  return s.months?.length ? tr(lang, 'In {0} op {1} om {2}', joinIn(s.months.map((m) => monthIn(m, lang)), lang), days, times) : tr(lang, 'Elke maand op {0} om {1}', days, times);
}

export function formatLocal(ms: number, tz: string, withYear = false, locale = 'nl-NL'): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}

/** The schedule in words: Dutch by default (also what the bots read), or in the reader's language (`lang`). */
export function describeSchedule(s: Schedule, tz: string, lang = 'nl'): string {
  switch (s.kind) {
    case 'none':
      return tr(lang, 'Alleen handmatig of via een trigger');
    case 'once': {
      const p = parseLocalDateTime(s.at);
      return p ? tr(lang, 'Eenmalig op {0}', formatLocal(zonedToUtc(p.y, p.m, p.d, p.h, p.mi, tz), tz, true, localeOf(lang))) : tr(lang, 'Eenmalig');
    }
    case 'interval':
      return describeInterval(s.everyMinutes, lang);
    case 'weekly':
      return tr(lang, '{0} om {1}', describeDays(s.days, lang), joinIn(s.times, lang));
    case 'monthly':
      return describeMonthly(s, lang);
    case 'cron':
      return describeCron(s.expr, lang);
  }
}
