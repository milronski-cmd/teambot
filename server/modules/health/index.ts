import path from 'node:path';
import type { Ctx, Module } from '../../core/types.js';
import { ah, requireRole, str } from '../../core/http.js';
import { StallMeter, type MeterOptions } from './meter.js';
import { healthVerdict, lastHour } from './verdict.js';
import { HeartbeatWriter, markStopped, readFinding, WATCH_SETTING, watchNotify } from './heartbeat.js';
import { watchdogTask } from './task.js';

/**
 * Status van TeamBot (0.4.3, parity 17.1). The stall meter (meter.ts) runs inside the server from the start;
 * this module shows it:
 *  GET /api/health           the colour of the line and its reasons, now / last hour / since the start (owner, admin)
 *  GET /api/health/history   the samples (one a minute, two days), for the soak test and support
 *  ctx.services.health       snapshot(), history(), diagnostics() — the diagnostics file includes the last day
 *  PUT /api/health/watchdog  { notify } — the watchdog outside the app (heartbeat.ts, build/watchdog.ps1) tells you or not
 * Instellingen › Algemeen › Status van TeamBot is ui/src/modules/health.
 */

export function healthSnapshot(ctx: Ctx, m: StallMeter) {
  const live = m.live();
  const samples = m.history();
  const totals = m.sinceStart();
  const { level, reasons } = healthVerdict({ stalls: m.stalls(), samples, live, totals });
  return {
    level,
    reasons,
    startedAt: totals.startedAt,
    uptimeS: Math.round(process.uptime()),
    sampleEverySeconds: Math.round(m.sampleMs / 1000),
    keptHours: Math.round((m.maxSamples * m.sampleMs) / 3_600_000),
    now: { loop: live.loop, cpu: live.cpu, busy: live.busy, mem: live.mem, handles: live.handles, handleKinds: live.handleKinds, runs: live.runs, windowS: live.windowS },
    lastHour: lastHour(samples, live),
    sinceStart: totals,
    version: ctx.config.version,
  };
}

export function createHealthModule(o: MeterOptions & { persist?: boolean } = {}): Module {
  // One meter per running app (tests start several apps with the same module list).
  const meterOf = (ctx: Ctx): StallMeter | null => ctx.services.health?.meter?.() ?? null;
  return {
    id: 'health',
    label: 'Status van TeamBot',
    init(ctx) {
      const heart = new HeartbeatWriter(ctx);
      const meter = new StallMeter({
        ...o,
        file: o.persist === false ? null : (o.file ?? path.join(ctx.config.dataDir, 'health', 'samples.jsonl')),
        activeRuns: () => Number(ctx.store.one<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running','waiting')")?.n || 0),
      });
      ctx.services.health = {
        meter: () => meter,
        heartbeat: () => heart,
        /** "Bewust gestopt" for the watchdog (desktop before-quit and session-end); synchronous. */
        markStopped: (reason: 'quit' | 'update' | 'restart' | 'shutdown') => markStopped(ctx.config.dataDir, reason),
        snapshot: () => healthSnapshot(ctx, meter),
        history: (after?: string) => meter.history(after),
        /** For the diagnostics file: the summary, the last day of samples and the last stalls (no content, no names). */
        diagnostics: () => {
          const day = new Date(Date.now() - 24 * 3_600_000).toISOString();
          return { ...healthSnapshot(ctx, meter), samples: meter.history(day), stalls: meter.stalls().slice(-100) };
        },
      };
      ctx.api.get(
        '/health',
        ah(async (req) => {
          requireRole(req, 'admin');
          return { ...healthSnapshot(ctx, meter), watchdog: { notify: watchNotify(ctx), finding: readFinding(ctx), task: await watchdogTask(ctx) } };
        }),
      );
      ctx.api.put(
        '/health/watchdog',
        ah(async (req) => {
          const u = requireRole(req, 'owner');
          ctx.store.setSetting(u.id, WATCH_SETTING, req.body?.notify !== false);
          heart.beat();
          ctx.audit(u.id, 'health.watchdog', { notify: req.body?.notify !== false });
          return { notify: watchNotify(ctx) };
        }),
      );
      ctx.api.get(
        '/health/history',
        ah(async (req) => {
          requireRole(req, 'admin');
          const after = str(req.query.after, 40) || undefined;
          const limit = Math.max(1, Math.min(5000, Number(req.query.limit) || 5000));
          return { samples: meter.history(after).slice(0, limit), stalls: meter.stalls(after), sinceStart: meter.sinceStart() };
        }),
      );
    },
    start(ctx) {
      meterOf(ctx)?.start();
      if (o.persist !== false) ctx.services.health?.heartbeat?.()?.start();
    },
    async stop(ctx) {
      if (o.persist !== false) ctx.services.health?.heartbeat?.()?.stop();
      await meterOf(ctx)?.stop();
    },
  };
}

const mod: Module = createHealthModule();
export default mod;
