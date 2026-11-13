/**
 * When may TeamBot install a downloaded update by itself (parity 16.2)? Never in the middle of a task: only when no bot
 * is at work, no routine runs or is about to start, no backup is being made, and the owner is away (no keyboard or
 * mouse on this computer for a while, or the screen is locked, and nobody wrote to a bot a moment ago — also not from
 * the phone). Otherwise it waits, and it always installs at the next quit. Pure, so it is tested without Electron
 * (tests/update-auto.test.ts). The facts come from the server (server/modules/backups/app-update.ts updateBlockers)
 * and Electron's powerMonitor (desktop/updater.ts); desktop/update-flow.ts asks every minute while an update is ready.
 */
import type { AutoMode, WaitReason } from '../shared/appUpdate.js';

export type { AutoMode, WaitReason };

/** The owner counts as away after this long without keyboard or mouse on this computer. */
export const USER_IDLE_SECONDS = 15 * 60;
/** How often a waiting update looks again. */
export const IDLE_POLL_MS = 60_000;
/** How often TeamBot looks for a new version (once a day; an hourly tick catches a pc that slept). */
export const CHECK_EVERY_MS = 24 * 3600_000;
/** After a failed check (offline, the channel did not answer) TeamBot tries again after this long. */
export const RETRY_AFTER_MS = 3600_000;

export interface IdleFacts {
  /** What runs or is about to start (server/modules/backups/app-update.ts updateBlockers). */
  busy: WaitReason[];
  /** Seconds since the last keyboard or mouse input on this computer (Electron powerMonitor). */
  userIdleSeconds: number;
  /** The screen is locked: the owner is away whatever the idle time says. */
  locked?: boolean;
}

export interface Decision {
  install: boolean;
  /** Why not yet (empty when it installs, or when it does not install by itself at all). */
  waitingFor: WaitReason[];
}

/**
 * `mode` "on" installs by itself when everything is quiet. `soon` is the owner's own "Nu bijwerken": then the owner's
 * presence does not matter (they asked), but a running task still does. Any other case installs only at quit.
 */
export function installDecision(o: { mode: AutoMode; ready: boolean; soon?: boolean; facts: IdleFacts | null; idleSeconds?: number }): Decision {
  if (!o.ready || (o.mode !== 'on' && !o.soon)) return { install: false, waitingFor: [] };
  if (!o.facts) return { install: false, waitingFor: [{ kind: 'unknown' }] };
  const waitingFor = o.facts.busy.filter((r) => !(o.soon && r.kind === 'chatting'));
  if (!o.soon && !o.facts.locked && !(o.facts.userIdleSeconds >= (o.idleSeconds ?? USER_IDLE_SECONDS))) waitingFor.push({ kind: 'user' });
  return { install: waitingFor.length === 0, waitingFor };
}

/** Is a check due? Once a day after the last good one; after a failed try, again an hour later. */
export function checkDue(o: { lastCheckAt?: string; lastTryAt?: string; now?: number }): boolean {
  const now = o.now ?? Date.now();
  const ago = (iso?: string) => (iso && Number.isFinite(Date.parse(iso)) ? now - Date.parse(iso) : Infinity);
  // A minute of slack: the hourly tick may fire just before the day is full.
  return ago(o.lastCheckAt) >= CHECK_EVERY_MS - 60_000 && ago(o.lastTryAt) >= RETRY_AFTER_MS - 60_000;
}

/** Same reasons (in the same order)? Then the page and tray need no refresh. */
export function sameReasons(a: WaitReason[] | undefined, b: WaitReason[] | undefined): boolean {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

/** A reason in plain words, for the tray and notifications of the desktop shell (the page has its own texts). */
export function reasonText(r: WaitReason, t: (text: string, ...v: (string | number)[]) => string): string {
  switch (r.kind) {
    case 'runs':
      return r.count === 1 ? t('1 taak loopt') : t('{0} taken lopen', r.count);
    case 'routines':
      return r.count === 1 ? t('een routine loopt') : t('{0} routines lopen', r.count);
    case 'routine-soon':
      return t('routine “{0}” start zo', r.name);
    case 'backup':
      return t('er wordt een back-up gemaakt');
    case 'chatting':
      return t('je schreef net nog aan een bot');
    case 'user':
      return t('je gebruikt de computer');
    default:
      return t('TeamBot start nog');
  }
}
