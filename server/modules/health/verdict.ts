import type { HealthSample, MeterTotals, StallEvent } from './meter.js';

/**
 * "Hoe gaat het met TeamBot?" in one colour, from the meter's numbers. Pure, so it is unit-tested.
 *
 * Looks at the last hour of this process, after the first two minutes (starting up loads modules and the database
 * once; that is reported in the numbers but never colours the line):
 *  - red    3+ stalls over 1 s, one stall of 5 s or more, or the server process uses 3 GB or more;
 *  - orange a stall over 1 s, 20+ stalls over 100 ms, the slowest minute's p99 delay ≥ 250 ms, or 1.5 GB or more;
 *  - green  otherwise.
 * The reasons carry numbers, not sentences: the page words them in the reader's language.
 */

export type HealthLevel = 'ok' | 'warn' | 'bad';
export type HealthReason =
  | { code: 'stalls1s'; n: number; longestMs: number }
  | { code: 'stalls100'; n: number }
  | { code: 'longStall'; ms: number }
  | { code: 'slow'; p99: number }
  | { code: 'memory'; mb: number };

export const WINDOW_MS = 60 * 60_000;
export const WARMUP_MS = 2 * 60_000;
export const LIMITS = {
  bad: { stalls1s: 3, stallMs: 5000, rssMb: 3072 },
  warn: { stalls1s: 1, stalls100: 20, p99: 250, rssMb: 1536 },
};

export interface HourSummary {
  /** Samples (closed minutes) in the hour plus the open one. */
  minutes: number;
  stalls100: number;
  stalls1s: number;
  longestMs: number;
  totalStallMs: number;
  /** p99 delay of the slowest minute, and the longest delay seen. */
  p99: number;
  maxLoopMs: number;
  rssMaxMb: number;
  cpuAvg: number;
}

/** The last hour from the samples (closed minutes) and the open window. */
export function lastHour(samples: HealthSample[], live: HealthSample | null, nowMs = Date.now()): HourSummary {
  const from = new Date(nowMs - WINDOW_MS).toISOString();
  const list = [...samples.filter((s) => s.at > from), ...(live ? [live] : [])];
  const out: HourSummary = { minutes: list.length, stalls100: 0, stalls1s: 0, longestMs: 0, totalStallMs: 0, p99: 0, maxLoopMs: 0, rssMaxMb: 0, cpuAvg: 0 };
  let cpu = 0;
  let secs = 0;
  for (const s of list) {
    out.stalls100 += s.stalls.over100ms;
    out.stalls1s += s.stalls.over1s;
    out.longestMs = Math.max(out.longestMs, s.stalls.longestMs);
    out.totalStallMs += s.stalls.totalMs;
    out.p99 = Math.max(out.p99, s.loop.p99);
    out.maxLoopMs = Math.max(out.maxLoopMs, s.loop.max);
    out.rssMaxMb = Math.max(out.rssMaxMb, s.mem.rssMb);
    cpu += s.cpu * s.windowS;
    secs += s.windowS;
  }
  out.cpuAvg = secs ? Math.round((cpu / secs) * 10) / 10 : 0;
  return out;
}

export function healthVerdict(o: { stalls: StallEvent[]; samples: HealthSample[]; live: HealthSample | null; totals: Pick<MeterTotals, 'startedAt'>; nowMs?: number }): { level: HealthLevel; reasons: HealthReason[] } {
  const nowMs = o.nowMs ?? Date.now();
  const since = Math.max(nowMs - WINDOW_MS, Date.parse(o.totals.startedAt) + WARMUP_MS);
  const counted = o.stalls.filter((e) => Date.parse(e.at) >= since);
  const long = counted.filter((e) => e.ms >= 1000);
  const longest = counted.reduce((m, e) => Math.max(m, e.ms), 0);
  const fromIso = new Date(since).toISOString();
  const minutes = [...o.samples.filter((s) => s.at > fromIso && s.boot === o.totals.startedAt), ...(o.live && nowMs - Date.parse(o.totals.startedAt) >= WARMUP_MS ? [o.live] : [])];
  const p99 = minutes.reduce((m, s) => Math.max(m, s.loop.p99), 0);
  const rss = o.live?.mem.rssMb ?? 0;

  const reasons: HealthReason[] = [];
  let level: HealthLevel = 'ok';
  const raise = (l: HealthLevel) => {
    if (l === 'bad' || (l === 'warn' && level === 'ok')) level = l;
  };
  if (long.length >= LIMITS.warn.stalls1s) {
    reasons.push({ code: 'stalls1s', n: long.length, longestMs: longest });
    raise(long.length >= LIMITS.bad.stalls1s ? 'bad' : 'warn');
  } else if (counted.length >= LIMITS.warn.stalls100) {
    reasons.push({ code: 'stalls100', n: counted.length });
    raise('warn');
  }
  if (longest >= LIMITS.bad.stallMs) {
    reasons.push({ code: 'longStall', ms: longest });
    raise('bad');
  }
  if (p99 >= LIMITS.warn.p99 && !reasons.length) {
    reasons.push({ code: 'slow', p99 });
    raise('warn');
  }
  if (rss >= LIMITS.warn.rssMb) {
    reasons.push({ code: 'memory', mb: rss });
    raise(rss >= LIMITS.bad.rssMb ? 'bad' : 'warn');
  }
  return { level, reasons };
}
