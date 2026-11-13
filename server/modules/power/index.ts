import type { Ctx, Module } from '../../core/types.js';
import { ah, bad, requireRole, user } from '../../core/http.js';

/**
 * "Houd de pc wakker terwijl routines of taken lopen" (A-76). On by default (a routine must not stall because the pc fell asleep); the owner can switch it off. While it is on and something runs — a
 * task or chat turn, a routine run (also one waiting for its next attempt), or a routine that starts within the next
 * half hour — the desktop app keeps the computer out of sleep (Electron powerSaveBlocker "prevent-app-suspension";
 * the screen may still turn off). The server decides when and why; the desktop shell attaches the real blocker.
 * Without a desktop shell (server, browser) the option is shown but cannot be switched on: honest, not a fake toggle.
 */

export interface PowerBlocker {
  /** Start or stop keeping the computer awake; `reason` is shown in the tray. */
  set(active: boolean, reason: string | null): void;
}
export interface PowerState {
  /** A desktop shell that can keep the computer awake is attached. */
  available: boolean;
  enabled: boolean;
  /** Keeping the computer awake right now. */
  active: boolean;
  /** Why it would be kept awake now (also when the option is off), in words. */
  reason: string | null;
}

const KEY = 'keepAwake';
/** A routine that starts within this window keeps the computer awake until it has run. */
export const SOON_MS = 30 * 60_000;
const TICK_MS = 30_000;

const clock = (iso: string, tz?: string) => {
  try {
    return new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  } catch {
    return new Date(iso).toISOString().slice(11, 16);
  }
};

/** Why the computer should stay awake now, for the owner's TeamBot (null = nothing runs or is about to). */
export function awakeReason(ctx: Ctx, now = Date.now()): string | null {
  const runs = Number(ctx.store.one<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running')")?.n || 0);
  if (runs) return runs === 1 ? '1 taak loopt' : `${runs} taken lopen`;
  const rr = (() => {
    try {
      return Number(ctx.store.one<{ n: number }>("SELECT COUNT(*) AS n FROM routine_runs WHERE status IN ('pending','running','retrying')")?.n || 0);
    } catch {
      return 0; // routines module off
    }
  })();
  if (rr) return rr === 1 ? 'een routine loopt' : `${rr} routines lopen`;
  try {
    const next = ctx.store.one<{ name: string; next_run_at: string; timezone: string }>(
      "SELECT name, next_run_at, timezone FROM routines WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 1",
      new Date(now + SOON_MS).toISOString(),
    );
    if (next) return `routine “${next.name}” start om ${clock(next.next_run_at, next.timezone)}`;
  } catch {
    /* routines module off */
  }
  return null;
}

export function createPowerModule(o: { tickMs?: number } = {}): Module {
  let blocker: PowerBlocker | null = null;
  let last: PowerState | null = null;
  // One module object serves every TeamBot in this process (tests start several): the clock and the listener belong
  // to each TeamBot, so closing one never leaves its clock reading a closed database or stops another's.
  const running = new Map<Ctx, { timer: NodeJS.Timeout; pending: NodeJS.Timeout | null; off: () => void }>();

  const ownerId = (ctx: Ctx) => ctx.auth.owner()?.id || null;
  const state = (ctx: Ctx): PowerState => {
    const owner = ownerId(ctx);
    const enabled = !!owner && ctx.store.getSetting<boolean>(owner, KEY, true) !== false;
    const reason = awakeReason(ctx);
    return { available: !!blocker, enabled, active: !!blocker && enabled && !!reason, reason };
  };
  const evaluate = (ctx: Ctx) => {
    const s = state(ctx);
    const changed = !last || last.active !== s.active || last.reason !== s.reason || last.enabled !== s.enabled || last.available !== s.available;
    if (blocker && (!last || last.active !== s.active || (s.active && last.reason !== s.reason))) {
      try {
        blocker.set(s.active, s.active ? s.reason : null);
      } catch (e) {
        ctx.log.warn('[power] wakker houden lukte niet', e);
      }
    }
    last = s;
    const owner = ownerId(ctx);
    if (changed && owner) ctx.events.emit(owner, 'power.state', s);
    return s;
  };
  // Runs and routines change often: look again shortly after, at most a few times a second.
  const soon = (ctx: Ctx) => {
    const r = running.get(ctx);
    if (!r || r.pending) return;
    r.pending = setTimeout(() => {
      r.pending = null;
      evaluate(ctx);
    }, 150);
    r.pending.unref?.();
  };

  return {
    id: 'power',
    label: 'Pc wakker houden',
    init(ctx) {
      ctx.services.power = {
        /** The desktop shell attaches its blocker (Electron powerSaveBlocker); returns a detach function. */
        attach(b: PowerBlocker) {
          blocker = b;
          last = null;
          evaluate(ctx);
          return () => {
            if (blocker === b) {
              try {
                b.set(false, null);
              } catch {
                /* shell gone */
              }
              blocker = null;
              last = null;
            }
          };
        },
        state: () => state(ctx),
        evaluate: () => evaluate(ctx),
      };
      ctx.api.get(
        '/power',
        ah(async () => state(ctx)),
      );
      ctx.api.put(
        '/power',
        ah(async (req) => {
          const u = user(req);
          requireRole(req, 'admin');
          if (typeof req.body?.enabled !== 'boolean') throw bad('Geef enabled: true of false');
          const owner = ownerId(ctx) || u.id;
          ctx.store.setSetting(owner, KEY, req.body.enabled);
          ctx.audit(u.id, 'power.keep_awake', { enabled: req.body.enabled });
          return evaluate(ctx);
        }),
      );
    },
    start(ctx) {
      const off = ctx.events.subscribe((e: any) => {
        if (/^(run|routine)\./.test(String(e?.type || ''))) soon(ctx);
      });
      const timer = setInterval(() => evaluate(ctx), o.tickMs ?? TICK_MS);
      timer.unref?.();
      running.set(ctx, { timer, pending: null, off });
      evaluate(ctx);
    },
    stop(ctx) {
      const r = running.get(ctx);
      if (r) {
        clearInterval(r.timer);
        if (r.pending) clearTimeout(r.pending);
        r.off();
        running.delete(ctx);
      }
      try {
        blocker?.set(false, null);
      } catch {
        /* ignore */
      }
    },
  };
}

const mod: Module = createPowerModule();
export default mod;
