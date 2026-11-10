import type { Ctx } from '../../core/types.js';
import { newId } from '../../core/db.js';
import * as S from './schedule.js';
import type { Routine, RoutineRun } from './schema.js';

/**
 * What did NOT happen (plan 0.4 §G): a routine that should have run is reported, also when nothing failed.
 *
 * - **Downtime**: TeamBot keeps a heartbeat. A gap (TeamBot was closed, the pc was off or asleep) is recorded as a
 *   period; the missed-run receipts the scheduler makes for it (catch up once / skip, per routine) carry its id, so the
 *   list "Gemist terwijl je pc uit stond" shows per period exactly which routines missed how many runs, and what was
 *   done about it. One notification per period, not one per routine.
 * - **Watchdog**: while TeamBot runs, every active schedule is checked against what actually happened. An occurrence
 *   more than 5 minutes ago without any receipt (the planner skipped or got stuck on it) gets a receipt "Verwacht om
 *   08:00, niet gedraaid" and a notification. It never starts the run itself (that could repeat side effects).
 */

export interface Downtime {
  id: string;
  from: string;
  to: string;
  /** off = TeamBot did not run (pc off, app closed); sleep = TeamBot ran but the pc slept (or the process froze). */
  kind: 'off' | 'sleep';
}

const HEARTBEAT_KEY = 'routines.heartbeat';
const DOWNTIME_KEY = 'routines.downtime';
const MIN_GAP_MS = 2 * 60_000;
export const LATE_MS = 5 * 60_000;
const KEEP_PERIODS = 60;

/** What the watchdog needs from the engine (kept small on purpose). */
export interface WatchHost {
  now(): number;
  readonly tickMs: number;
  routinesOf(userId: string): Routine[];
  globalPaused(userId: string): boolean;
  claimNotRun(r: Routine, at: number, why: string): RoutineRun | null;
  alert(r: Routine | null, userId: string, title: string, body: string, link: string, extra?: Record<string, any>): void;
}

/** "08:00 (ma 9 nov)" in the routine's timezone. */
export function timeAndDay(ms: number, tz: string): { time: string; day: string } {
  const w = S.wallTime(ms, tz);
  const time = `${String(w.h).padStart(2, '0')}:${String(w.mi).padStart(2, '0')}`;
  const day = new Intl.DateTimeFormat('nl-NL', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms));
  return { time, day };
}

export class RoutineWatch {
  private lastTick: number | null = null;
  private lastBeat = 0;
  private lastWatch = 0;
  /** Per routine: watched since (ms) and the schedule it was watched with (an edit starts watching anew). */
  private watched = new Map<string, { from: number; sig: string; seen: number }>();
  /** The gap the scheduler is catching up on in this tick (its missed receipts carry the id). */
  current: Downtime | null = null;

  constructor(private ctx: Ctx, private host: WatchHost) {}

  periods(): Downtime[] {
    const v = this.ctx.store.getSetting<any>('', DOWNTIME_KEY, []);
    return Array.isArray(v) ? v.filter((p) => p && typeof p.id === 'string') : [];
  }

  private record(fromMs: number, toMs: number, kind: Downtime['kind']): Downtime {
    const d: Downtime = { id: newId('gap_'), from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), kind };
    this.ctx.store.setSetting('', DOWNTIME_KEY, [d, ...this.periods()].slice(0, KEEP_PERIODS));
    return d;
  }

  private beat(now: number, force = false) {
    if (!force && now - this.lastBeat < 60_000) return;
    this.lastBeat = now;
    this.ctx.store.setSetting('', HEARTBEAT_KEY, new Date(now).toISOString());
  }

  /** At start: the time since the last heartbeat is a period in which TeamBot did not run. */
  onStart() {
    const now = this.host.now();
    const hb = Date.parse(this.ctx.store.getSetting<string>('', HEARTBEAT_KEY, '') || '');
    if (Number.isFinite(hb) && now - hb > MIN_GAP_MS) this.current = this.record(hb, now, 'off');
    this.beat(now, true);
    this.lastTick = now;
    // Watch every schedule from now on; what happened before is the scheduler's missed-run policy.
    this.lastWatch = now;
  }

  /** Before the scheduler runs: a jump since the last tick means the pc slept (timers do not fire then). */
  beforeTick(now: number) {
    const prev = this.lastTick;
    this.lastTick = now;
    const gap = Math.max(MIN_GAP_MS, 4 * (this.host.tickMs || 15_000));
    if (prev !== null && now - prev > gap && !this.current) this.current = this.record(prev, now, 'sleep');
    this.beat(now);
  }

  /** After the scheduler ran: tell the owner once per period which routines missed runs (if any). */
  afterSchedules() {
    const gap = this.current;
    this.current = null;
    if (!gap) return;
    const rows = this.ctx.store.all<any>("SELECT * FROM routine_runs WHERE json_extract(meta, '$.gap') = ?", gap.id);
    const byUser = new Map<string, RoutineRun[]>();
    for (const raw of rows) {
      const rr = this.ctx.store.decode<RoutineRun>('routine_runs', raw);
      byUser.set(rr.user_id, [...(byUser.get(rr.user_id) || []), rr]);
    }
    for (const [userId, list] of byUser) {
      const runs = list.reduce((n, rr) => n + (Number(rr.meta?.missed) || 1), 0);
      const caught = list.filter((rr) => rr.trigger === 'catchup').length;
      const skipped = list.length - caught;
      const routines = list.length === 1 ? '1 routine' : `${list.length} routines`;
      const missed = runs === 1 ? '1 geplande run gemist' : `${runs} geplande runs gemist`;
      const what = [caught ? (caught === 1 ? '1 wordt nu ingehaald' : `${caught} worden nu ingehaald`) : '', skipped ? (skipped === 1 ? '1 overgeslagen' : `${skipped} overgeslagen`) : ''].filter(Boolean).join(', ');
      const tz = list[0] ? this.host.routinesOf(userId).find((r) => r.id === list[0].routine_id)?.timezone || 'Europe/Amsterdam' : 'Europe/Amsterdam';
      const since = S.formatLocal(Date.parse(gap.from), tz);
      this.host.alert(null, userId, 'Gemist terwijl je pc uit stond', `${routines}: ${missed} sinds ${since} (${gap.kind === 'sleep' ? 'pc in slaapstand' : 'TeamBot draaide niet'}). ${what}.`, '#/m/routines?gemist=1', { level: 'warn', gapId: gap.id });
    }
  }

  /**
   * The watchdog (at most once a minute): every occurrence of an active schedule that is more than 5 minutes late and
   * has no receipt at all gets one ("niet gedraaid") and a notification.
   */
  check(now: number, force = false) {
    if (!force && now - this.lastWatch < 60_000) return;
    const until = now - LATE_MS;
    const users = new Set(this.ctx.store.all<{ user_id: string }>("SELECT DISTINCT user_id FROM routines WHERE status = 'active'").map((x) => x.user_id));
    const found = new Map<string, { r: Routine; at: number }[]>();
    for (const userId of users) {
      // Under the noodrem nothing is watched; afterwards watching starts anew (a pause is no "niet gedraaid").
      if (this.host.globalPaused(userId)) continue;
      for (const r of this.host.routinesOf(userId)) {
        if (r.status !== 'active' || r.schedule.kind === 'none' || r.options.waitpoint) continue;
        const sig = JSON.stringify([r.schedule, r.timezone]);
        const w = this.watched.get(r.id);
        if (!w || w.sig !== sig || w.seen !== this.lastWatch) {
          // New, changed, or not watched in the previous check (paused, noodrem, completed): watch from the latest of
          // the previous check, its creation and its last change (resuming sets that); a changed schedule from now on.
          const from = w && w.sig !== sig ? now : Math.max(this.lastWatch || now, Date.parse(r.created_at) || 0, Date.parse(r.updated_at) || 0);
          this.watched.set(r.id, { from, sig, seen: now });
          if (w && w.sig !== sig) continue;
        }
        const cur = this.watched.get(r.id)!;
        cur.seen = now;
        if (until <= cur.from) continue;
        let t = S.nextRunAfter(r.schedule, r.timezone, cur.from);
        let n = 0;
        let last = cur.from;
        while (t !== null && t <= until && n < 50) {
          if (!this.covered(r.id, t)) {
            const why = r.next_run_at && Date.parse(r.next_run_at) <= t ? 'De planner bleef op deze run hangen.' : 'De planner sloeg deze run over.';
            const rr = this.host.claimNotRun(r, t, why);
            if (rr) found.set(userId, [...(found.get(userId) || []), { r, at: t }]);
          }
          last = t;
          t = S.nextRunAfter(r.schedule, r.timezone, t);
          n++;
        }
        // At most 50 per check; the rest the next minute.
        cur.from = n >= 50 && t !== null && t <= until ? last : until;
      }
    }
    this.lastWatch = now;
    for (const [userId, list] of found) {
      const first = list[0];
      const { time, day } = timeAndDay(first.at, first.r.timezone);
      if (list.length === 1) this.host.alert(first.r, userId, `Routine “${first.r.name}” niet gedraaid`, `Verwacht om ${time} (${day}), niet gedraaid.`, `#/m/routines/r/${first.r.id}?tab=history`, { level: 'error' });
      else this.host.alert(null, userId, `${list.length} routine-runs niet gedraaid`, `Onder andere “${first.r.name}”: verwacht om ${time} (${day}), niet gedraaid.`, '#/m/routines', { level: 'error' });
    }
  }

  /** Is there any receipt for this occurrence (a run, a skip, a missed or caught-up run that covers it)? */
  private covered(routineId: string, at: number): boolean {
    const t = new Date(at).toISOString();
    return !!this.ctx.store.one(
      "SELECT id FROM routine_runs WHERE routine_id = ? AND (scheduled_for = ? OR (json_extract(meta, '$.missedFrom') <= ? AND COALESCE(json_extract(meta, '$.missedTo'), scheduled_for) >= ?)) LIMIT 1",
      routineId,
      t,
      t,
      t,
    );
  }

  /**
   * "Gemist terwijl je pc uit stond" for one user: per period (newest first) the routines that missed runs, how many
   * (first and last), and what happened: caught up once at start (with that run's status) or skipped.
   */
  /** `only`: the routine ids of one team (package B4); null = every routine of the owner. */
  missedList(userId: string, sinceMs: number, only: Set<string> | null = null) {
    const names = new Map(this.host.routinesOf(userId).map((r) => [r.id, r]));
    const out: any[] = [];
    for (const p of this.periods()) {
      if (Date.parse(p.to) < sinceMs) continue;
      const rows = this.ctx.store.all<any>("SELECT * FROM routine_runs WHERE user_id = ? AND json_extract(meta, '$.gap') = ? ORDER BY created_at", userId, p.id).filter((x) => !only || only.has(x.routine_id));
      if (!rows.length) continue;
      const items = rows.map((raw) => {
        const rr = this.ctx.store.decode<RoutineRun>('routine_runs', raw);
        const r = names.get(rr.routine_id);
        const missedTo = rr.meta?.missedTo || rr.scheduled_for;
        return {
          routineId: rr.routine_id,
          name: r?.name || 'Verwijderde routine',
          timezone: r?.timezone || 'Europe/Amsterdam',
          count: Number(rr.meta?.missed) || 1,
          capped: !!rr.meta?.capped,
          first: rr.meta?.missedFrom || rr.scheduled_for,
          last: missedTo,
          outcome: rr.trigger === 'catchup' ? 'caught_up' : 'skipped',
          runId: rr.id,
          status: rr.status,
          result: rr.meta?.proof?.result || null,
        };
      });
      out.push({ ...p, routines: items.length, runs: items.reduce((n, i) => n + i.count, 0), items });
    }
    return { periods: out, seenAt: this.ctx.store.getSetting<string | null>(userId, 'routines.missedSeenAt', null) };
  }
}
