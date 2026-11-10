/**
 * Are you at the computer? (0.4.4, P8) The desktop app tells the server every few seconds how long the keyboard and
 * mouse have been still (Electron `powerMonitor.getSystemIdleTime()`) and whether the screen is locked
 * (desktop/presence.ts). From that the phone push decides where an alert goes:
 *  - at the pc (input in the last AWAY_AFTER_S seconds, screen not locked): only the Windows notification;
 *  - away (AWAY_AFTER_S without input, or the screen locked): a push to the phone;
 *  - "Altijd ook op de telefoon" on, or no desktop app that reports (server mode, the app closed, a report older
 *    than STALE_MS): as before 0.4.4 — questions and approvals always to the phone, the rest when TeamBot is not open.
 * An approval held back while you sat at the pc is pushed after all once you walk away (if it still waits).
 * Nothing of this leaves the computer: only "at the pc / away" is used, never what you type. The idea comes from
 * OpenBot (not open for commercial use): only the idea, no code.
 */

/**
 * 0.4.5: three minutes without keyboard or mouse (was 30 seconds). Reading a long answer or thinking for a minute is
 * still "at the pc"; the phone only buzzes once you have really walked away, or right away with the screen locked.
 */
export const AWAY_AFTER_S = 180;
/** A report older than this means no desktop app is reporting (it quit or hangs): back to the old rule. */
export const STALE_MS = 60_000;

export interface PresenceFacts {
  /** Seconds since the last keyboard or mouse input on this computer. */
  idleSeconds: number;
  locked: boolean;
  /** When the desktop app reported this (ms). */
  at: number;
}

export type Where = 'pc' | 'away' | 'unknown';

export function whereIs(f: PresenceFacts | null | undefined, nowMs = Date.now()): Where {
  if (!f || !Number.isFinite(f.at) || nowMs - f.at > STALE_MS) return 'unknown';
  if (f.locked) return 'away';
  // The report is a few seconds old: count that time as idle too.
  const idle = f.idleSeconds + Math.max(0, (nowMs - f.at) / 1000);
  return idle >= AWAY_AFTER_S ? 'away' : 'pc';
}

/** Does this alert go to the phone? `online` = TeamBot is open somewhere (a page or app connected). */
export function phoneGets(o: { where: Where; alwaysPhone: boolean; approval: boolean; online: boolean }): boolean {
  if (o.alwaysPhone || o.where === 'unknown') return o.approval || !o.online;
  return o.where === 'away';
}

export class Presence {
  private facts = new Map<string, PresenceFacts>();
  private listeners: ((userId: string) => void)[] = [];
  /** Test seam. */
  clock = () => Date.now();

  report(userId: string, f: { idleSeconds: unknown; locked: unknown }): Where {
    const before = this.where(userId);
    const idle = Number(f.idleSeconds);
    this.facts.set(userId, { idleSeconds: Number.isFinite(idle) && idle >= 0 ? Math.min(idle, 7 * 86400) : 0, locked: f.locked === true, at: this.clock() });
    const after = this.where(userId);
    if (after === 'away' && before !== 'away') for (const cb of this.listeners) cb(userId);
    return after;
  }

  where(userId: string): Where {
    return whereIs(this.facts.get(userId), this.clock());
  }

  view(userId: string) {
    const f = this.facts.get(userId);
    return { where: this.where(userId), locked: !!f?.locked, awayAfterSeconds: AWAY_AFTER_S };
  }

  /** Called when someone goes from "at the pc" (or unknown) to "away". */
  onAway(cb: (userId: string) => void) {
    this.listeners.push(cb);
  }
}
