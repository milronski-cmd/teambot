import type { Db } from './db.js';
import type { CloudConfig } from './config.js';
import { audit } from './audit.js';
import { newId } from './crypto.js';
import { UserError } from './accounts.js';
import type { ActorRef, Workspace, WorkspaceService } from './workspaces.js';
import { addDays, calendarDays, localDay, type Clock, type Log } from './util.js';
import type { AlertService } from './alerts.js';

/**
 * Uptime and maintenance (CLD-05, SLA). Every sweep checks each active workspace once (shared via the provisioner,
 * dedicated via its public /healthz) and records the result per workspace per day. Checks during announced
 * maintenance are not counted; consecutive failures open an incident (visible to the owner and the operator, never
 * on the public status page) that resolves itself when the instance answers again.
 */

export interface Incident {
  id: string;
  title: string;
  body: string;
  impact: 'minor' | 'major';
  status: 'open' | 'resolved';
  updates: { at: string; text: string }[];
  workspace_id: string | null;
  auto: boolean;
  created_at: Date;
  resolved_at: Date | null;
}

export interface Maintenance {
  id: string;
  title: string;
  body: string;
  workspace_id: string | null;
  starts_at: Date;
  ends_at: Date;
  /** Announced with enough notice: excluded from uptime. Short-notice (emergency) maintenance still counts. */
  excluded: boolean;
  created_at: Date;
  canceled_at: Date | null;
}

export interface Uptime {
  days: number;
  checks: number;
  ok: number;
  /** null when there were no counted checks. */
  pct: number | null;
  daily: { day: string; checks: number; pct: number | null }[];
}

const MAX_WINDOW_HOURS = 24;

export class MonitoringService {
  private sweeps = 0;

  constructor(private d: { db: Db; cfg: CloudConfig; clock: Clock; log: Log; workspaces: WorkspaceService; alerts?: AlertService }) {}

  /** Windows (not canceled) that cover `at`. A canceled window ends at its cancel time. */
  private async windowsAt(at: Date): Promise<Maintenance[]> {
    return this.d.db.query<Maintenance>(
      'SELECT * FROM maintenance WHERE starts_at <= $1 AND ends_at > $1 AND (canceled_at IS NULL OR canceled_at > $1)',
      [at.toISOString()],
    );
  }

  /** One round of health checks. Called every CLOUD_HEALTH_INTERVAL_MS. */
  async sweep(): Promise<{ checked: number; ok: number; excluded: number }> {
    const now = this.d.clock.now();
    const nowIso = now.toISOString();
    // Local calendar day in CLOUD_TZ: monthly reports then have exact month boundaries (also around DST).
    const day = localDay(now, this.d.cfg.timeZone);
    const rows = await this.d.db.query<Workspace>("SELECT * FROM workspaces WHERE status = 'active'");
    const windows = await this.windowsAt(now);
    const measureUsage = this.sweeps++ % 10 === 0;
    let sharedChecks = 0;
    let sharedOk = 0;
    let okCount = 0;
    let excluded = 0;
    for (const ws of rows) {
      const r = await this.d.workspaces.checkHealth(ws, measureUsage);
      if (r.ok) okCount++;
      const inMaintenance = windows.some((w) => w.excluded && (!w.workspace_id || w.workspace_id === ws.id));
      const streak = r.ok ? 0 : inMaintenance ? ws.health_fail_streak : ws.health_fail_streak + 1;
      await this.d.db.query(
        `UPDATE workspaces SET health = $2, health_checked_at = $3, health_detail = $4, health_fail_streak = $5${r.usage !== undefined ? ', storage_bytes = $6' : ''}
         WHERE id = $1 AND status = 'active'`,
        r.usage !== undefined ? [ws.id, r.ok ? 'healthy' : 'unhealthy', nowIso, r.detail, streak, r.usage] : [ws.id, r.ok ? 'healthy' : 'unhealthy', nowIso, r.detail, streak],
      );
      if (r.ok) await this.resolveAuto(ws, nowIso);
      if (inMaintenance) {
        excluded++;
        // Announced maintenance: not counted, no incident; only remembered for the monthly report.
        await this.d.db.query(
          `INSERT INTO workspace_health_daily (workspace_id, day, checks, ok, excluded) VALUES ($1, $2, 0, 0, 1)
           ON CONFLICT (workspace_id, day) DO UPDATE SET excluded = workspace_health_daily.excluded + 1`,
          [ws.id, day],
        );
        continue;
      }
      await this.d.db.query(
        `INSERT INTO workspace_health_daily (workspace_id, day, checks, ok) VALUES ($1, $2, 1, $3)
         ON CONFLICT (workspace_id, day) DO UPDATE SET checks = workspace_health_daily.checks + 1, ok = workspace_health_daily.ok + EXCLUDED.ok`,
        [ws.id, day, r.ok ? 1 : 0],
      );
      if (ws.deployment === 'shared') {
        sharedChecks++;
        if (r.ok) sharedOk++;
      }
      if (!r.ok && streak >= this.d.cfg.incidentAfterFailures) await this.openAuto(ws, r.detail, nowIso);
    }
    // Platform figure on the public status page: shared workspaces only (dedicated servers run at the customer).
    await this.d.db.query(
      'INSERT INTO health_daily (day, checks, ok) VALUES ($1, $2, $3) ON CONFLICT (day) DO UPDATE SET checks = health_daily.checks + EXCLUDED.checks, ok = health_daily.ok + EXCLUDED.ok',
      [day, sharedChecks, sharedOk],
    );
    return { checked: rows.length, ok: okCount, excluded };
  }

  private async openAuto(ws: Workspace, detail: string | null, nowIso: string) {
    const open = await this.d.db.query('SELECT id FROM incidents WHERE workspace_id = $1 AND auto = TRUE AND status = $2', [ws.id, 'open']);
    if (open.length) return;
    const id = newId('inc_');
    const what = ws.deployment === 'dedicated' ? 'Je dedicated TeamBot' : 'Je TeamBot';
    await this.d.db.query(
      `INSERT INTO incidents (id, title, body, impact, status, workspace_id, auto, created_at, updated_at) VALUES ($1, $2, $3, 'major', 'open', $4, TRUE, $5, $5)`,
      [id, 'Niet bereikbaar', `${what} reageerde ${this.d.cfg.incidentAfterFailures} controles op rij niet${detail ? ` (${detail})` : ''}. We houden het in de gaten.`, ws.id, nowIso],
    );
    await audit(this.d.db, this.d.clock, { actor: 'system', kind: 'incident.auto_opened', workspaceId: ws.id, data: { id, detail } });
    this.d.log.warn(`storing geopend voor ${ws.slug}: ${detail || 'reageert niet'}`);
    this.d.alerts?.notify(ws, 'incident.opened', { incident: id, detail, since: nowIso });
  }

  private async resolveAuto(ws: Workspace, nowIso: string) {
    const rows = await this.d.db.query<{ id: string }>(
      `UPDATE incidents SET status = 'resolved', resolved_at = $2, updated_at = $2, updates = updates || $3::jsonb
       WHERE workspace_id = $1 AND auto = TRUE AND status = 'open' RETURNING id`,
      [ws.id, nowIso, JSON.stringify([{ at: nowIso, text: 'Weer bereikbaar.' }])],
    );
    for (const r of rows) {
      await audit(this.d.db, this.d.clock, { actor: 'system', kind: 'incident.auto_resolved', workspaceId: ws.id, data: { id: r.id } });
      this.d.alerts?.notify(ws, 'incident.resolved', { incident: r.id, resolved: nowIso });
    }
  }

  /** Uptime of one workspace over the last `days` days (today included). */
  async uptime(workspaceId: string, days: number): Promise<Uptime> {
    const list = calendarDays(localDay(this.d.clock.now(), this.d.cfg.timeZone), days);
    const rows = await this.d.db.query<{ day: string; checks: number; ok: number }>('SELECT day, checks, ok FROM workspace_health_daily WHERE workspace_id = $1 AND day >= $2', [
      workspaceId,
      list[0],
    ]);
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const daily: Uptime['daily'] = [];
    let checks = 0;
    let ok = 0;
    for (const day of list) {
      const r = byDay.get(day);
      if (r) (checks += r.checks), (ok += r.ok);
      daily.push({ day, checks: r?.checks ?? 0, pct: r && r.checks > 0 ? (r.ok / r.checks) * 100 : null });
    }
    return { days, checks, ok, pct: checks ? (ok / checks) * 100 : null, daily };
  }

  async incidentsFor(workspaceId: string, days = 90): Promise<Incident[]> {
    return this.d.db.query<Incident>('SELECT * FROM incidents WHERE workspace_id = $1 AND (status = $2 OR created_at >= $3) ORDER BY created_at DESC', [
      workspaceId,
      'open',
      addDays(this.d.clock.now(), -days).toISOString(),
    ]);
  }

  /** Open incidents of single workspaces (operator console). */
  async openWorkspaceIncidents(): Promise<(Incident & { slug: string })[]> {
    return this.d.db.query(
      "SELECT i.*, w.slug FROM incidents i JOIN workspaces w ON w.id = i.workspace_id WHERE i.workspace_id IS NOT NULL AND i.status = 'open' ORDER BY i.created_at DESC",
    );
  }

  // ---------- maintenance ----------

  /**
   * Announce a maintenance window (whole platform, or one workspace). It must not start in the past (no erasing
   * downtime afterwards). With less than CLOUD_MAINTENANCE_NOTICE_HOURS notice it is shown but still counts.
   */
  async announce(input: { title: string; body?: string; startsAt: Date | null; endsAt: Date | null; workspaceId?: string | null }, ref: ActorRef): Promise<Maintenance> {
    const title = String(input.title || '').trim().slice(0, 120);
    if (!title) throw new UserError('Geef het onderhoud een titel.');
    const { startsAt, endsAt } = input;
    if (!startsAt || !endsAt || !Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) throw new UserError('Vul een geldige begin- en eindtijd in.');
    const now = this.d.clock.now();
    if (startsAt.getTime() < now.getTime() - 60_000) throw new UserError('Onderhoud kan niet in het verleden beginnen.');
    if (endsAt <= startsAt) throw new UserError('De eindtijd moet na de begintijd liggen.');
    if (endsAt.getTime() - startsAt.getTime() > MAX_WINDOW_HOURS * 3600_000) throw new UserError(`Een onderhoudsvenster duurt maximaal ${MAX_WINDOW_HOURS} uur.`);
    let workspaceId: string | null = input.workspaceId || null;
    if (workspaceId) {
      const ws = await this.d.workspaces.get(workspaceId);
      if (!ws || ws.status === 'deleted') throw new UserError('Onbekende workspace.');
      workspaceId = ws.id;
    }
    const excluded = startsAt.getTime() - now.getTime() >= this.d.cfg.maintenanceNoticeHours * 3600_000;
    const row: Maintenance = { id: newId('mnt_'), title, body: String(input.body || '').slice(0, 2000), workspace_id: workspaceId, starts_at: startsAt, ends_at: endsAt, excluded, created_at: now, canceled_at: null };
    await this.d.db.query(
      'INSERT INTO maintenance (id, title, body, workspace_id, starts_at, ends_at, excluded, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [row.id, title, row.body, workspaceId, startsAt.toISOString(), endsAt.toISOString(), excluded, ref.actorId ?? null, now.toISOString()],
    );
    await audit(this.d.db, this.d.clock, { ...ref, kind: 'maintenance.announced', workspaceId, data: { id: row.id, title, excluded, starts: startsAt.toISOString(), ends: endsAt.toISOString() } });
    return row;
  }

  async cancel(id: string, ref: ActorRef) {
    const rows = await this.d.db.query<{ workspace_id: string | null }>(
      'UPDATE maintenance SET canceled_at = $2 WHERE id = $1 AND canceled_at IS NULL AND ends_at > $2 RETURNING workspace_id',
      [id, this.d.clock.now().toISOString()],
    );
    if (rows.length) await audit(this.d.db, this.d.clock, { ...ref, kind: 'maintenance.canceled', workspaceId: rows[0].workspace_id, data: { id } });
  }

  /**
   * Ongoing and upcoming windows. scope 'public' = platform-wide only (status page); a workspace id = platform-wide
   * plus that workspace's own; 'all' = everything (operator).
   */
  async upcoming(scope: 'public' | 'all' | { workspaceId: string }, aheadDays = 30): Promise<Maintenance[]> {
    const now = this.d.clock.now().toISOString();
    const until = addDays(this.d.clock.now(), aheadDays).toISOString();
    const where =
      scope === 'public' ? 'AND workspace_id IS NULL' : scope === 'all' ? '' : 'AND (workspace_id IS NULL OR workspace_id = $3)';
    const params = typeof scope === 'object' ? [now, until, scope.workspaceId] : [now, until];
    return this.d.db.query<Maintenance>(
      `SELECT * FROM maintenance WHERE canceled_at IS NULL AND ends_at > $1 AND starts_at < $2 ${where} ORDER BY starts_at`,
      params,
    );
  }
}
