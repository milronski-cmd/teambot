import type { Request } from 'express';
import type { Ctx } from '../../core/types.js';
import { ah, bad, HttpError, requireRole } from '../../core/http.js';
import type { AppUpdatePhase, AppUpdateView, AutoMode, OffReason, WaitReason } from '../../../shared/appUpdate.js';

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

/**
 * A routine that starts within this window holds the update back (installing takes a minute or two). Not longer than
 * that: with ten minutes a team with a round every half hour and a few reminders had almost no moment left to install
 * (live, 21 Nov 2026: an update waited behind "start zo" of a meter, a reminder and a round, one after the other). A
 * routine that falls in the minute of the restart runs right after it.
 */
export const ROUTINE_SOON_MS = 3 * 60_000;
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

/** How long TeamBot starts no new work of its own so a downloaded update can install, and how long before it tries again. */
export const ROOM_FOR_UPDATE_MS = 45 * 60_000;
export const ROOM_AGAIN_MS = 3 * 3600_000;
let roomSince = 0;

/**
 * A downloaded update installs only when no task runs. A team that works day and night never has such a moment: live
 * (20 Nov 2026) an update waited a whole night behind bots that kept finding work. So while an update is ready and
 * only work is in its way (the owner asked for "Nu bijwerken", or bijwerken is automatic and nobody is using TeamBot),
 * TeamBot starts no new work of its own for a while: what runs finishes, the update installs, and the work goes on
 * after the restart. Bounded: after ROOM_FOR_UPDATE_MS without success the work goes on and it tries again later.
 * What the owner asks, planned routines and work bots give each other are never held.
 */
export function makingRoomForUpdate(ctx: Ctx, now = Date.now()): boolean {
  const svc: AppUpdateService | undefined = ctx.services.appUpdate;
  let i: ReturnType<AppUpdateService['info']>;
  try {
    if (!svc) return false;
    i = svc.info();
  } catch {
    return false;
  }
  const wanted = i.state.phase === 'ready' && (i.soon || i.config.auto === 'on');
  const waits = i.waitingFor || [];
  // (Without "Nu bijwerken" the owner must be away: someone at the computer or just chatting is not interrupted.)
  const onlyWork = waits.length > 0 && waits.every((w) => w.kind === 'runs' || w.kind === 'routines' || w.kind === 'routine-soon' || (i.soon && w.kind === 'chatting'));
  if (!wanted || !onlyWork) {
    if (roomSince && now - roomSince > ROOM_FOR_UPDATE_MS + ROOM_AGAIN_MS) roomSince = 0;
    return false;
  }
  if (!roomSince || now - roomSince > ROOM_FOR_UPDATE_MS + ROOM_AGAIN_MS) {
    roomSince = now;
    ctx.log.info('[app-update] update staat klaar en alleen lopend werk houdt hem tegen: even geen nieuw eigen werk starten');
  }
  return now - roomSince <= ROOM_FOR_UPDATE_MS;
}
/** For tests. */
export function resetRoomForUpdate() {
  roomSince = 0;
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
      if ((req as any).session?.id === 'bot') throw new HttpError(403, 'Het updatekanaal stel je in op je computer.', 'mobile_denied');
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
