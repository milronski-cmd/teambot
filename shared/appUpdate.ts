/**
 * Automatic updates of TeamBot itself: what /api/app-update says (server/modules/backups/app-update.ts) and the page
 * under Instellingen › Back-ups shows; the desktop shell (desktop/update-idle.ts) uses the same reasons to wait.
 * Types only.
 */

export type AutoMode = 'on' | 'notify' | 'off';

/** Why a downloaded update waits (the page and the tray put it in words). */
export type WaitReason =
  /** Bots at work: chat turns and tasks (queued or running). */
  | { kind: 'runs'; count: number }
  /** Routine runs in progress or waiting for their next attempt. */
  | { kind: 'routines'; count: number }
  /** A routine starts within the next few minutes. */
  | { kind: 'routine-soon'; name: string; at: string }
  /** A backup is being made. */
  | { kind: 'backup' }
  /** Someone wrote to a bot a moment ago (on the computer or the phone): they may still be busy with it. */
  | { kind: 'chatting'; at: string }
  /** The keyboard or mouse of this computer was used a moment ago. */
  | { kind: 'user' }
  /** TeamBot cannot tell right now (still starting). */
  | { kind: 'unknown' };

/** The UpdateFlow state (desktop/update-flow.ts UpdateState), mirrored without importing the desktop shell. */
export type AppUpdatePhase =
  | { phase: 'off'; reason: string }
  | { phase: 'idle'; checkedAt?: string }
  | { phase: 'checking' }
  | { phase: 'available'; version: string; notes?: string }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string };

/**
 * Why this TeamBot does not update itself right now (the page has a calm sentence for each):
 *  no-channel  the installed app, no update channel yet: new versions come with the next installer;
 *  unpackaged  started from the source code (`npm run desktop:dev`);
 *  channel     the channel that was typed does not work (the text says why);
 *  server      TeamBot runs as a server (Docker, npm): updated with its package, not by itself;
 *  dev         a local development server without the desktop app.
 */
export type OffReason = 'no-channel' | 'unpackaged' | 'channel' | 'server' | 'dev';

export interface AppUpdateView {
  version: string;
  /** This TeamBot updates itself (the Windows/macOS/Linux app). */
  managed: boolean;
  auto: AutoMode;
  channel: { text: string; input: string; source: 'env' | 'saved' | 'built-in' | 'none'; error?: string };
  state: AppUpdatePhase;
  off?: OffReason;
  waitingFor: WaitReason[];
  soon: boolean;
  skipped: string | null;
  lastCheckAt?: string;
}
