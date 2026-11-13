/**
 * Channel health as the server works it out (server/modules/channels/health.ts) and the Kanalen page puts it in
 * words (ui/src/modules/channels/health.ts). "Verbonden" only when TeamBot really received a message on the channel
 * and really sent one. Types only.
 */

export interface HealthEvent {
  at: string;
  text: string;
}

export type HealthState = 'off' | 'connecting' | 'error' | 'untested' | 'receive_failed' | 'send_failed' | 'ok';

export interface HealthView {
  state: HealthState;
  /** Exact reason for error / receive_failed / send_failed (plain Dutch). */
  reason: string | null;
  receiveOk: boolean;
  sendOk: boolean;
  /** False for a webhook without replies: receiving alone is enough. */
  sendNeeded: boolean;
  inAt: string | null;
  outAt: string | null;
  platformAt: string | null;
  lastError: HealthEvent | null;
  testing: { expiresAt: string } | null;
  lastTest: { at: string; ok: boolean; text: string } | null;
  /** Last 24 hours, from the channel log. */
  day: { in: number; out: number; errors: number };
}
