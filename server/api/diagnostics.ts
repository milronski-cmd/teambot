import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Ctx } from '../core/types.js';
import { ah, requireRole } from '../core/http.js';
import { redact } from '../core/secrets.js';

/** The last lines of a log file, redacted (empty when there is no such file). */
function tail(file: string, lines: number): string[] {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const len = Math.min(st.size, 400_000);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n').slice(-lines).map((l) => redact(l).slice(0, 2000));
  } catch {
    return [];
  }
}

/**
 * Opt-in, redacted error reporting (§21.11 P0): TeamBot sends nothing by itself. An admin can download a diagnostics
 * file to share when asking for help. It never contains message contents, prompts, files or secret values.
 */
export function diagnosticsRoutes(ctx: Ctx) {
  ctx.api.get(
    '/admin/diagnostics',
    ah(async (req, res) => {
      requireRole(req, 'admin');
      const logTail = tail(path.join(ctx.config.dataDir, 'logs', 'server.log'), 600);
      const count = (sql: string) => ctx.store.one<any>(sql)?.n ?? 0;
      const out = {
        format: 'teambot.diagnostics/v1',
        created_at: new Date().toISOString(),
        app: { name: ctx.config.appName, version: ctx.config.version, mode: ctx.config.mode },
        runtime: { platform: process.platform, arch: process.arch, release: os.release(), node: process.versions.node, electron: process.versions.electron || null, memoryMb: Math.round(process.memoryUsage().rss / 1e6), uptimeS: Math.round(process.uptime()) },
        modules: ctx.modules.map((m) => ({ id: m.id, label: m.label })),
        // Modules that could not start (server/app.ts) and what the desktop shell caught (desktop/boot.ts).
        startupProblems: ctx.services.startupProblems ?? [],
        desktopLog: tail(path.join(ctx.config.dataDir, 'logs', 'desktop.log'), 100),
        migrations: ctx.store.all<any>('SELECT id FROM _migrations ORDER BY rowid').map((r) => r.id),
        counts: {
          users: count('SELECT COUNT(*) n FROM users'),
          agents: count('SELECT COUNT(*) n FROM agents'),
          threads: count('SELECT COUNT(*) n FROM threads'),
          messages: count('SELECT COUNT(*) n FROM messages'),
          runsActive: count("SELECT COUNT(*) n FROM runs WHERE status IN ('queued','running','waiting')"),
        },
        providers: ctx.store.all<any>('SELECT kind, enabled, shared FROM providers').map((p) => ({ kind: p.kind, enabled: !!p.enabled, shared: !!p.shared })),
        recentRunErrors: ctx.store
          .all<any>("SELECT r.created_at, r.status, r.error, p.kind FROM runs r LEFT JOIN agents a ON a.id = r.agent_id LEFT JOIN providers p ON p.id = a.provider_id WHERE r.status IN ('error','interrupted') ORDER BY r.created_at DESC LIMIT 50")
          .map((r) => ({ at: r.created_at, status: r.status, provider: r.kind, error: redact(String(r.error || '')).slice(0, 500) })),
        // The stall meter (server/modules/health): responsiveness, memory and handles of the last day, numbers only.
        health: ctx.services.health?.diagnostics?.() ?? null,
        log: logTail,
        note: 'Bevat geen berichten, prompts, bestanden of sleutelwaarden. Controleer het bestand gerust voordat je het deelt.',
      };
      res.setHeader('content-disposition', `attachment; filename="teambot-diagnose-${new Date().toISOString().slice(0, 10)}.json"`);
      res.json(out);
    }),
  );
}
