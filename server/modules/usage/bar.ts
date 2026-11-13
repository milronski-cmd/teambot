import type { LimitWindow } from './parse.js';
import { inputLine } from '../../core/util.js';

/**
 * The always-visible usage bar: pure helpers (no ctx), tested on their own.
 *  - window order and the reset until which an engine is blocked;
 *  - free sources (the dots): what another module may report through `ctx.services.usage.reportSource(...)`;
 *  - the weekly reserve that the free-model chain shows on the Claude week (`reportReserve`);
 *  - the start of "deze week" for the per-bot breakdown.
 */

export type SourceStatus = 'available' | 'low' | 'limited' | 'offline' | 'unknown';
const STATUSES = new Set<SourceStatus>(['available', 'low', 'limited', 'offline', 'unknown']);

/** What a module reports for one free source (one dot in the bar). See docs/modules/usage.md. */
export interface SourceReport {
  /** Stable id, e.g. "groq", "openrouter-free", "kilo" (letters, digits, `.` `:` `_` `-`; up to 60). */
  id: string;
  /** Name in the bar ("Groq", "OpenRouter gratis"); a product name, not translated. */
  label: string;
  /** available = can be used; low = nearly used up; limited = used up until `resetsAt`; offline = not reachable. */
  status: SourceStatus;
  /** When it is available again (epoch ms or s, or an ISO date); null/absent = unknown. */
  resetsAt?: number | string | null;
  /** 0–100 when known (e.g. 45 of 50 requests today = 90). */
  usedPercent?: number | null;
  /** TeamBot counted or derived it (the provider gives no exact figure): shown as "schatting". */
  estimated?: boolean;
  /** One short Dutch sentence for the expanded view ("50 verzoeken per dag, telt TeamBot zelf."). */
  note?: string | null;
  /** Whose source this is; absent = every user on this server (e.g. a free service without a key). */
  userId?: string | null;
  /** The TeamBot provider it belongs to: its report then replaces the dot TeamBot derives from that provider. */
  providerId?: string | null;
  /** free (a free tier of an online service) or local (own hardware). Default free. */
  kind?: 'free' | 'local';
}

export interface SourceView {
  id: string;
  label: string;
  status: SourceStatus;
  resetsAt: number | null;
  usedPercent: number | null;
  estimated: boolean;
  note: string | null;
  providerId: string | null;
  kind: 'free' | 'local';
  /** engine = derived from a provider TeamBot knows; reported = from reportSource(). */
  origin: 'engine' | 'reported';
  at: number;
}

export type StoredSource = SourceView & { userId: string };

/** Epoch seconds, epoch ms or an ISO date → epoch ms; anything else → null. */
export function toMs(v: unknown): number | null {
  if (typeof v === 'string' && v.trim() && !/^\d+$/.test(v.trim())) {
    const t = Date.parse(v);
    return Number.isFinite(t) && t > 0 ? t : null;
  }
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}


/** A report from another module → a clean source, or null when it cannot be shown (no id or label). */
export function cleanSource(r: any, now = Date.now()): StoredSource | null {
  if (!r || typeof r !== 'object') return null;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const label = inputLine(r.label, 40);
  if (!/^[\w.:-]{1,60}$/.test(id) || !label) return null;
  const pct = typeof r.usedPercent === 'number' && Number.isFinite(r.usedPercent) ? Math.max(0, Math.min(100, Math.round(r.usedPercent * 10) / 10)) : null;
  const providerId = typeof r.providerId === 'string' && /^[\w-]{1,80}$/.test(r.providerId) ? r.providerId : null;
  const userId = typeof r.userId === 'string' && /^[\w-]{1,80}$/.test(r.userId) ? r.userId : '*';
  return {
    id,
    label,
    status: STATUSES.has(r.status) ? r.status : 'unknown',
    resetsAt: toMs(r.resetsAt),
    usedPercent: pct,
    estimated: r.estimated === true,
    note: inputLine(r.note, 200) || null,
    providerId,
    kind: r.kind === 'local' ? 'local' : 'free',
    origin: 'reported',
    at: now,
    userId,
  };
}

/** Same content (ignoring when it was said): no need to tell the UI again. */
export function sameSource(a: SourceView | undefined, b: SourceView): boolean {
  return !!a && a.label === b.label && a.status === b.status && a.resetsAt === b.resetsAt && a.usedPercent === b.usedPercent && a.estimated === b.estimated && a.note === b.note && a.providerId === b.providerId && a.kind === b.kind;
}

/** A used-up source whose reset has passed counts as available again (until it is told otherwise). */
export function effectiveSource<T extends { status: SourceStatus; resetsAt: number | null }>(s: T, now = Date.now()): T {
  if ((s.status === 'limited' || s.status === 'low') && s.resetsAt && s.resetsAt <= now) return { ...s, status: 'available', resetsAt: null };
  return s;
}

/** Length of a window in minutes, for the order in the bar (5 hours, week, model weeks, longer periods). */
export function windowMinutes(w: Pick<LimitWindow, 'id'>): number {
  if (w.id === 'five_hour') return 300;
  if (w.id === 'seven_day') return 10080;
  if (w.id.startsWith('seven_day_')) return 10080.5;
  const m = w.id.match(/^([\w.-]+):(\d+)$/);
  // Codex: "codex:300", "codex:10080"; another limit of the same account ("gpt-5-codex-spark:300") after the main one.
  if (m) return Number(m[2]) + (m[1] === 'codex' ? 0 : 1e6);
  if (w.id === 'overage') return 1e9;
  return 1e8;
}

export function sortWindows<T extends Pick<LimitWindow, 'id'>>(ws: T[]): T[] {
  return [...ws].sort((a, b) => windowMinutes(a) - windowMinutes(b) || a.id.localeCompare(b.id));
}

/**
 * Until when an engine at its limit stays blocked: when one or more windows are full (100%), the engine works again
 * only after all of them reset (the latest); otherwise (the engine refused, percentages unknown) the earliest reset.
 */
export function blockedUntil(atLimit: LimitWindow[]): { until: number | null; label?: string } {
  if (!atLimit.length) return { until: null };
  const full = atLimit.filter((w) => (w.usedPercent ?? 0) >= 100);
  const pool = (full.length ? full : atLimit).filter((w) => !!w.resetsAt);
  if (!pool.length) return { until: null, label: (full[0] || atLimit[0]).label };
  const pick = pool.reduce((a, b) => (full.length ? (b.resetsAt! > a.resetsAt! ? b : a) : b.resetsAt! < a.resetsAt! ? b : a));
  return { until: pick.resetsAt, label: pick.label };
}

/** The weekly reserve as the free-model chain reports it (shown as a mark on the week bar). */
export interface ReserveReport {
  /** Whose reserve; absent = every user. */
  userId?: string | null;
  /** Only this provider; absent = every Claude Code account. */
  providerId?: string | null;
  /** The window it watches; default "seven_day" (Claude: week, all models). */
  windowId?: string;
  /** From this percentage on, ordinary work goes to free models. */
  atPercent: number;
  /** The reserve is in force right now (the window is past atPercent). */
  active?: boolean;
}

export interface ReserveView {
  providerId: string | null;
  windowId: string;
  atPercent: number;
  active: boolean;
  at: number;
}

export function cleanReserve(r: any, now = Date.now()): (ReserveView & { userId: string }) | null {
  const pct = Number(r?.atPercent);
  if (!r || typeof r !== 'object' || !Number.isFinite(pct) || pct <= 0 || pct > 100) return null;
  const windowId = typeof r.windowId === 'string' && /^[\w.:-]{1,60}$/.test(r.windowId) ? r.windowId : 'seven_day';
  return {
    userId: typeof r.userId === 'string' && /^[\w-]{1,80}$/.test(r.userId) ? r.userId : '*',
    providerId: typeof r.providerId === 'string' && /^[\w-]{1,80}$/.test(r.providerId) ? r.providerId : null,
    windowId,
    atPercent: Math.round(pct * 10) / 10,
    active: r.active === true,
    at: now,
  };
}

/** Monday 00:00 on the server's clock (the same clock as the daily budget): the start of "deze week". */
export function weekStart(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}
