/**
 * Barge-in pre-roll: when you interrupt the bot, the recording has to start where your speech started, not where the
 * voice detector became sure (that is 350 ms or more later, and much later when you start softly while the bot is
 * still loud). We look back through the last seconds of microphone levels for the start of the current stretch of
 * speech (short pauses between syllables allowed) and keep that much audio, plus a small margin.
 */

export const FRAME_MS = 20;

export interface PreRollOptions {
  /** Level that counts as your voice (below the barge threshold; the echo of the bot is mostly removed). */
  threshold: number;
  /** Quiet gap that still belongs to the same stretch of speech (a pause after a comma is often 300-500 ms). */
  gapMs?: number;
  marginMs?: number;
  minMs?: number;
  maxMs?: number;
}

/**
 * How many ms of audio from before "now" to include. `levels` are RMS levels per 20 ms frame, oldest first; the last
 * one is the frame in which the barge-in was detected.
 */
export function bargePreRollMs(levels: ArrayLike<number>, o: PreRollOptions): number {
  const gap = Math.max(1, Math.round((o.gapMs ?? 600) / FRAME_MS));
  const margin = o.marginMs ?? 300;
  const min = o.minMs ?? 600;
  const max = o.maxMs ?? 2500;
  let onset = -1;
  let quiet = 0;
  for (let i = levels.length - 1; i >= 0; i--) {
    if (levels[i] >= o.threshold) {
      onset = i;
      quiet = 0;
    } else if (onset >= 0 && ++quiet > gap) break;
  }
  if (onset < 0) return min;
  const ms = (levels.length - onset) * FRAME_MS + margin;
  return Math.max(min, Math.min(max, ms));
}

/** The "this is your voice" level for the pre-roll search, from the detector's own thresholds. */
export function voiceLevel(baseThreshold: number, bargeThreshold: number): number {
  return Math.max(baseThreshold, bargeThreshold * 0.35);
}
