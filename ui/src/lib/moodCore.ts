import type { Mood } from './botface.js';

/** How long a bot shows its happy "done" face after finishing a task. */
export const DONE_MS = 45_000;

/**
 * Everything a bot's mood depends on, as primitives (cheap to compare in a store selector). `limitUntil`: its last run
 * was stopped by the daily budget, which opens again then (ms); 0 when it was not.
 */
export type MoodInputs = { paused: boolean; waiting: boolean; working: boolean; failed: boolean; doneAt: number; limitUntil?: number };

/** The mood from real state (pure; lib/mood.ts reads the inputs from the store). */
export function moodFrom(i: MoodInputs, now = Date.now()): Mood {
  if (i.paused) return 'paused';
  if (i.waiting) return 'waiting';
  if (i.working) return 'working';
  // Stopped by the daily budget: a limit, not a failure (B-70); once the new day has started the bot is ready again.
  if (i.failed && i.limitUntil) return now < i.limitUntil ? 'limit' : 'idle';
  if (i.failed) return 'error';
  if (i.doneAt && now - i.doneAt < DONE_MS) return 'done';
  return 'idle';
}
