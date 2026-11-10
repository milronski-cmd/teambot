import type { Request } from 'express';
import type { Ctx } from '../../core/types.js';
import { ah, bad, HttpError, requireRole } from '../../core/http.js';

/**
 * Automatic updates of TeamBot itself, as the server sees them (parity 16.2). No Electron here.
 *  - `updateBlockers`: the server's half of "never in the middle of a task" — what runs or is about to start in this
 *    TeamBot. The desktop shell combines it with the owner's presence (desktop/update-idle.ts installDecision) before
 *    it installs a downloaded update by itself.
 *  - `/api/app-update` (registerAppUpdate): the status for Instellingen › Back-ups, on the computer and on the phone,
 *    "Nu controleren", "Nu bijwerken", Automatisch bijwerken (aan / alleen melden / uit) and, on the computer only
 *    (server/modules/mobile/policy.ts COMPUTER_ONLY), the update channel. The desktop shell (desktop/main.ts) provides
 *    `ctx.services.appUpdate` around its UpdateFlow; without it (a server, `npm run dev:server`) the page says calmly
 *    how this TeamBot gets new versions.
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

/** A routine that starts within this window holds the update back (installing takes a minute or two). */
export const ROUTINE_SOON_MS = 10 * 60_000;
/** A message from a person within this window counts as "still using TeamBot". */
export const CHAT_RECENT_MS = 15 * 60_000;

const count = (ctx: Ctx, sql: string, ...args: unknown[]) => {
  try {
    return Number(ctx.store.one<{ n: number }>(sql, ...args)?.n || 0);
  } catch {
    return 0; // that module is off
  }
};

/** What runs or is about to start in this TeamBot (all users, all teams): an update waits for all of it. */
export function updateBlockers(ctx: Ctx, now = Date.now()): WaitReason[] {
  const out: WaitReason[] = [];
  const runs = count(ctx, "SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running')");
  if (runs) out.push({ kind: 'runs', count: runs });
  const rr = count(ctx, "SELECT COUNT(*) AS n FROM routine_runs WHERE status IN ('pending','running','retrying')");
  if (rr) out.push({ kind: 'routines', count: rr });
  try {
    const next = ctx.store.one<{ name: string; next_run_at: string }>(
      "SELECT name, next_run_at FROM routines WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 1",
      new Date(now + ROUTINE_SOON_MS).toISOString(),
    );
    if (next) out.push({ kind: 'routine-soon', name: next.name, at: next.next_run_at });
  } catch {
    /* routines module off */
  }
  const job = ctx.services.backups?.service?.job;
  if (job && (job.phase === 'database' || job.phase === 'files')) out.push({ kind: 'backup' });
  // Only the newest messages (rowid order): cheap on a big database, and a person's last message is among them.
  try {
    const last = ctx.store.one<{ at: string | null }>(
      "SELECT MAX(created_at) AS at FROM messages WHERE author_type = 'user' AND rowid > (SELECT COALESCE(MAX(rowid), 0) - 500 FROM messages)",
    )?.at;
    if (last && now - Date.parse(last) < CHAT_RECENT_MS) out.push({ kind: 'chatting', at: last });
  } catch {
    /* no messages table (never) */
  }
  return out;
}

// ---------------------------------------------------------------- /api/app-update

/** The UpdateFlow state (desktop/update-flow.ts UpdateState), mirrored without importing the desktop shell. */
export type AppUpdatePhase =
  | { phase: 'off'; reason: string }
  | { phase: 'idle'; checkedAt?: string }
  | { phase: 'checking' }
  | { phase: 'available'; version: string; notes?: string }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string };

/** What desktop/main.ts puts in `ctx.services.appUpdate` (a thin wrapper around its UpdateFlow). */
export interface AppUpdateService {
  info(): {
    config: { feedUrl: string; channelText: string; source: 'env' | 'saved' | 'built-in' | 'none'; error: string; auto: AutoMode; packaged: boolean; lastCheckAt: string };
    state: AppUpdatePhase;
    waitingFor: WaitReason[];
    soon: boolean;
    skipped: string | null;
  };
  check(): Promise<unknown>;
  download(): Promise<unknown>;
  installNow(): Promise<unknown>;
  save(patch: { channel?: string; auto?: AutoMode }): unknown;
}

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

export function appUpdateView(ctx: Ctx): AppUpdateView {
  const svc: AppUpdateService | undefined = ctx.services.appUpdate;
  const version = ctx.config.version;
  if (!svc) {
    const off: OffReason = ctx.config.mode === 'desktop' ? 'dev' : 'server';
    return { version, managed: false, auto: 'off', channel: { text: '', input: '', source: 'none' }, state: { phase: 'off', reason: off }, off, waitingFor: [], soon: false, skipped: null };
  }
  const i = svc.info();
  const c = i.config;
  const off: OffReason | undefined = i.state.phase !== 'off' ? undefined : !c.packaged ? 'unpackaged' : c.error ? 'channel' : c.source === 'none' ? 'no-channel' : 'channel';
  return {
    version,
    managed: true,
    auto: c.auto,
    channel: { text: c.channelText, input: c.feedUrl, source: c.source, ...(c.error ? { error: c.error } : {}) },
    state: i.state,
    off,
    waitingFor: i.waitingFor || [],
    soon: !!i.soon,
    skipped: i.skipped || null,
    lastCheckAt: c.lastCheckAt || undefined,
  };
}

const MODES: AutoMode[] = ['on', 'notify', 'off'];

/** The routes; called from the backups module's init. */
export function registerAppUpdate(ctx: Ctx) {
  const owner = (req: Request) => {
    const u = requireRole(req, 'admin');
    if (u.role !== 'owner') throw new HttpError(403, 'Alleen de eigenaar werkt TeamBot bij');
    return u;
  };
  const service = (): AppUpdateService => {
    const svc: AppUpdateService | undefined = ctx.services.appUpdate;
    if (!svc) throw new HttpError(409, ctx.config.mode === 'desktop' ? 'Bijwerken kan alleen in de TeamBot-app.' : 'Deze TeamBot draait als server en werkt zichzelf niet bij.');
    return svc;
  };

  /** Status for Instellingen › Back-ups (computer and phone): version, channel, what happens and what it waits for. */
  ctx.api.get(
    '/app-update',
    ah(async (req) => {
      requireRole(req, 'admin');
      return appUpdateView(ctx);
    }),
  );

  /** "Nu controleren". */
  ctx.api.post(
    '/app-update/check',
    ah(async (req) => {
      owner(req);
      await service().check();
      return appUpdateView(ctx);
    }),
  );

  /** Download only (installs when nothing runs, or at the next quit). Answers at once; progress via app-update.changed. */
  ctx.api.post(
    '/app-update/download',
    ah(async (req) => {
      owner(req);
      service()
        .download()
        .catch((e) => ctx.log.error('[app-update] downloaden', e?.message || e));
      return appUpdateView(ctx);
    }),
  );

  /** "Nu bijwerken": find, download and install as soon as no task runs (a backup first). Answers at once. */
  ctx.api.post(
    '/app-update/install',
    ah(async (req) => {
      const u = owner(req);
      const svc = service();
      ctx.audit(u.id, 'app.update_now', { from: ctx.config.version });
      svc.installNow().catch((e) => ctx.log.error('[app-update] nu bijwerken', e?.message || e));
      return appUpdateView(ctx);
    }),
  );

  /** Automatisch bijwerken: aan / alleen melden / uit (also from the phone). */
  ctx.api.put(
    '/app-update/settings',
    ah(async (req) => {
      const u = owner(req);
      const auto = req.body?.auto;
      if (!MODES.includes(auto)) throw bad('Kies aan, alleen melden of uit');
      service().save({ auto });
      ctx.audit(u.id, 'app.update_settings', { auto });
      return appUpdateView(ctx);
    }),
  );

  /** The update channel (Geavanceerd). Computer-only: on a lost phone it would point TeamBot at someone else's server. */
  ctx.api.put(
    '/app-update/channel',
    ah(async (req) => {
      const u = owner(req);
      if ((req as any).session?.kind === 'device') throw new HttpError(403, 'Het updatekanaal stel je in op je computer.', 'mobile_denied');
      const channel = typeof req.body?.channel === 'string' ? req.body.channel.trim().slice(0, 500) : null;
      if (channel === null) throw bad('Geef het adres van het updatekanaal');
      const svc = service();
      try {
        svc.save({ channel });
      } catch (e: any) {
        throw bad(String(e?.message || e));
      }
      const v = appUpdateView(ctx);
      ctx.audit(u.id, 'app.update_channel', { channel: v.channel.text || null });
      return v;
    }),
  );
}
