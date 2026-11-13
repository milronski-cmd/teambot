import type { Ctx } from '../../core/types.js';
import type { Words } from '../../../shared/i18n-core.js';

/**
 * The one planner. Everything in TeamBot that starts by itself at a time is looked at on one clock, the routine
 * engine's (engine.tick), and says here what it will start and when. No part keeps a timer of its own.
 *
 * A part registers a source: how often it wants a look, what a look does (start what is due), and what it has planned
 * for an owner. The engine runs the sources from its tick and wakes for the soonest one; `kick` asks for a look sooner
 * because something changed. `planned` is the one list of "what starts by itself, and when": the routines (with
 * reminders, wait points and vaste taken) come from the engine itself, the rest from the sources.
 *
 * Every part that does work by itself is a source and lists that work, so the list holds everything that starts:
 * what somebody set up (the owner, or a bot on his word) and what TeamBot itself does for the installation (the
 * automatic backup, a second look that waited for a usage limit, the one download of the search model). Whether
 * that costs model calls is on every planned item (`model`). On a fresh install nothing that costs a model call is
 * planned. Only housekeeping that does no work and calls nothing (a status poll) keeps a timer of its own.
 *
 * "Alles stoppen" goes through here too (`stop`, from the routines module's one stop hook): every source drops what it
 * has queued for that owner that would cost a model call, and until his next turn no source starts work of TeamBot's
 * own for him (`held`). What he planned himself (a routine, the check-in, a learning round) keeps its next time; that
 * first turn after the stop ends the hold.
 */

export type PlannedKind = 'routine' | 'reminder' | 'waitpoint' | 'duty' | 'retry' | 'workflow' | 'work' | 'checkin' | 'briefing' | 'learning' | 'backup' | 'recheck' | 'download';

/** One thing that will start by itself. */
export interface Planned {
  kind: PlannedKind;
  /** Stable for the same planned thing (a routine or workflow id, `work:<bot>`, …). */
  id: string;
  userId: string;
  agentId: string | null;
  /** What it is, in Dutch (for sorting and for a bot that reads the list). */
  title: string;
  /**
   * The title for the screen when TeamBot's words have someone's own words in them (a chat title, a routine's name):
   * the Dutch template and its values, so TeamBot's words are shown in the reader's language and the others as written.
   * Without it the title is a name as a whole (a routine's, a workflow's) or TeamBot's own words.
   */
  words?: Words;
  /** When it starts next (ISO). null: as soon as its event happens or its bot is free. */
  at: string | null;
  /** Does starting it cost model calls? */
  model: boolean;
  /** Where the owner changes or stops it. */
  link?: string;
}

export interface PlannerSource {
  id: string;
  /** A look once per this many ms. */
  everyMs: number;
  /** The first look this long after registering (default: `everyMs`, so a process that lives short starts nothing). */
  firstMs?: number;
  /** Start what is due now. A promise is waited for (no second look meanwhile; engine.idle() waits for it too). */
  look(now: number): void | Promise<unknown>;
  /** What this source will start by itself for this owner. */
  planned?(userId: string, now: number): Planned[] | Promise<Planned[]>;
  /** "Alles stoppen": drop what is queued for this owner that would cost a model call, so it never starts. How many. */
  stop?(userId: string): number;
}

interface Entry {
  source: PlannerSource;
  nextAt: number;
  lastAt: number;
  busy: boolean;
}

export class Planner {
  private entries = new Map<string, Entry>();

  constructor(
    private o: {
      /** The engine's clock (ms). */
      now: () => number;
      /** Keep a look that is still going (the engine's idle() waits for it). */
      track: (p: Promise<unknown>) => void;
      warn: (what: string, e: unknown) => void;
      /** Set the engine's timer again: something is due sooner. */
      wake: () => void;
      /** Where "Alles stoppen" of an owner is written down (it holds across a restart), and whether it still holds. */
      stops?: { mark(userId: string): void; held(userId: string): boolean };
    },
  ) {}

  /** The one clock (ms). */
  now(): number {
    return this.o.now();
  }

  /** Register a source; returns the function that takes it away again. */
  register(source: PlannerSource): () => void {
    const now = this.o.now();
    const e: Entry = { source, nextAt: now + (source.firstMs ?? source.everyMs), lastAt: now, busy: false };
    this.entries.set(source.id, e);
    this.o.wake();
    return () => {
      if (this.entries.get(source.id) === e) this.entries.delete(source.id);
    };
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Something changed: look at this source `afterMs` from now instead of at its regular time. */
  kick(id: string, afterMs = 0) {
    const e = this.entries.get(id);
    if (!e) return;
    const at = this.o.now() + Math.max(0, afterMs);
    if (at >= e.nextAt) return;
    e.nextAt = at;
    this.o.wake();
  }

  /**
   * The first look of this source at or after `atMs` (ms), on its own rhythm; null when it is not registered. What a
   * source plans for "as soon as it is due" starts then.
   */
  lookAt(id: string, atMs = this.o.now()): number | null {
    const e = this.entries.get(id);
    if (!e) return null;
    return atMs <= e.nextAt ? e.nextAt : e.nextAt + Math.ceil((atMs - e.nextAt) / e.source.everyMs) * e.source.everyMs;
  }

  /** When the soonest look is due (ms), or null without sources. */
  soonest(): number | null {
    let t: number | null = null;
    for (const e of this.entries.values()) if (!e.busy && (t === null || e.nextAt < t)) t = e.nextAt;
    return t;
  }

  /** Look at every source whose time has come (called from the engine's tick). */
  run(now: number) {
    for (const e of [...this.entries.values()]) {
      // (A clock that was set back looks again, like a new start.)
      if (e.busy || (now < e.nextAt && now >= e.lastAt)) continue;
      e.lastAt = now;
      e.nextAt = now + e.source.everyMs;
      let r: void | Promise<unknown>;
      try {
        r = e.source.look(now);
      } catch (err) {
        this.o.warn(e.source.id, err);
        continue;
      }
      if (!r || typeof (r as Promise<unknown>).then !== 'function') continue;
      e.busy = true;
      this.o.track(
        Promise.resolve(r)
          .catch((err) => this.o.warn(e.source.id, err))
          .finally(() => {
            e.busy = false;
          }),
      );
    }
  }

  /**
   * "Alles stoppen" of this owner: written down, and every source drops what it has queued for him that would cost a
   * model call (a conversation waiting for its memory review, a second look waiting for a limit, a workflow's next
   * step). Returns how many were dropped.
   */
  stop(userId: string): number {
    this.o.stops?.mark(userId);
    let n = 0;
    for (const e of [...this.entries.values()]) {
      try {
        n += e.source.stop?.(userId) || 0;
      } catch (err) {
        this.o.warn(e.source.id, err);
      }
    }
    return n;
  }

  /**
   * Does this owner's "Alles stoppen" still hold: he pressed it and no turn of his started since? Then a source starts
   * nothing of TeamBot's own for him that costs a model call (the work loop, memory's upkeep).
   */
  held(userId: string): boolean {
    return this.o.stops?.held(userId) ?? false;
  }

  /** What the sources will start by itself for this owner, soonest first ("as soon as …" before a time). */
  async planned(userId: string, now = this.o.now()): Promise<Planned[]> {
    const out: Planned[] = [];
    for (const e of this.entries.values()) {
      if (!e.source.planned) continue;
      try {
        out.push(...(await e.source.planned(userId, now)));
      } catch (err) {
        this.o.warn(e.source.id, err);
      }
    }
    return sortPlanned(out);
  }
}

export function sortPlanned(list: Planned[]): Planned[] {
  return list.sort((a, b) => (a.at || '').localeCompare(b.at || '') || a.title.localeCompare(b.title));
}

/** The planner of this app (null when the routines module is not loaded: then nothing starts by itself). */
export const plannerOf = (ctx: Ctx): Planner | null => ctx.services.routines?.engine?.planner ?? null;
