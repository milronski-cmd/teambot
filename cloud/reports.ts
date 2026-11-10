import type { Db } from './db.js';
import { one } from './db.js';
import type { CloudConfig } from './config.js';
import { audit } from './audit.js';
import { newId } from './crypto.js';
import { UserError } from './accounts.js';
import { planById, type CreditTier, type Plan } from './billing/plans.js';
import type { BillingService } from './billing/service.js';
import { StripeError } from './billing/stripe.js';
import type { AlertService } from './alerts.js';
import type { ActorRef, Workspace, WorkspaceService } from './workspaces.js';
import { MONTH_RE, monthOf, monthRange, type Clock, type Log } from './util.js';

/**
 * Monthly SLA reports (CLD-05). A report covers one calendar month in CLOUD_TZ and is computed from the per-day
 * health buckets (local days, so month boundaries are exact also around DST). Reports are immutable: a regeneration
 * by an operator adds a new version (with a reason, audited); the database refuses UPDATE/DELETE on sla_reports.
 * A missed target creates a *pending* credit; nothing is credited without an operator's approval.
 */

export type ReportResult = 'met' | 'not_met' | 'no_target' | 'no_data';

export interface SlaReport {
  format: 1;
  workspace: { id: string; slug: string; name: string; deployment: 'shared' | 'dedicated' };
  month: string;
  period: { start: string; end: string; timeZone: string };
  plan: { id: string; name: string; slaTarget: number | null; monthlyPriceCents: number | null; currency: string; credits: CreditTier[] };
  measurement: {
    checks: number;
    ok: number;
    failed: number;
    /** Floored to 3 decimals for display; the result uses exact integer arithmetic. */
    uptimePct: number | null;
    /** Checks during announced maintenance (>= notice hours ahead): not counted. */
    excludedChecks: number;
    intervalSec: number;
    /** failed × interval; approximate. */
    estimatedDowntimeMinutes: number;
  };
  maintenance: { title: string; scope: 'platform' | 'workspace'; start: string; end: string; minutes: number; excluded: boolean }[];
  incidents: { id: string; title: string; scope: 'platform' | 'workspace'; start: string; end: string | null; minutes: number; ongoing: boolean }[];
  result: ReportResult;
  credit: { pct: number; amountCents: number; currency: string; rule: string } | null;
  generatedAt: string;
  generatedBy: 'system' | 'operator';
}

export interface ReportRow {
  id: string;
  workspace_id: string;
  month: string;
  version: number;
  data: SlaReport;
  generated_at: Date;
  generated_by: string | null;
  reason: string | null;
}

export type CreditStatus = 'pending' | 'applied' | 'to_settle' | 'settled' | 'rejected';

export interface CreditRow {
  id: string;
  report_id: string;
  workspace_id: string;
  month: string;
  pct: number;
  amount_cents: number;
  currency: string;
  status: CreditStatus;
  method: string | null;
  external_ref: string | null;
  note: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
}

/** Percent as an exact integer in thousandths of a percent (99.9 → 99900), so thresholds compare without float error. */
const milli = (pct: number) => Math.round(pct * 1000);

/**
 * Target met? Which credit tier applies? `ok`/`checks` are compared as integers: uptime = ok/checks·100 and a tier
 * applies when uptime is strictly below its threshold. Exactly on a threshold = not below. The most severe matching
 * tier (lowest threshold) wins. Credits only when the target is missed.
 */
export function evaluate(plan: Pick<Plan, 'slaTarget' | 'credits'>, ok: number, checks: number): { result: ReportResult; tier: CreditTier | null } {
  if (plan.slaTarget === null || plan.slaTarget === undefined) return { result: 'no_target', tier: null };
  if (!checks) return { result: 'no_data', tier: null };
  const below = (pct: number) => ok * 100_000 < milli(pct) * checks;
  if (!below(plan.slaTarget)) return { result: 'met', tier: null };
  let tier: CreditTier | null = null;
  for (const t of [...(plan.credits || [])].sort((a, b) => b.below - a.below)) if (below(t.below)) tier = t;
  return { result: 'not_met', tier };
}

const pctLabel = (n: number) => `${String(n).replace('.', ',')}%`;

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  // Spreadsheet formula injection: never start a cell with = + - @ (or tab/CR).
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HEADER = ['type', 'workspace', 'month', 'title', 'start', 'end', 'minutes', 'excluded', 'uptime_pct', 'target_pct', 'checks', 'ok', 'excluded_checks', 'result', 'credit_pct', 'credit_amount', 'currency', 'credit_status'];

const csvLine = (row: unknown[]) => row.map(csvCell).join(',');

function summaryRow(r: SlaReport, credit: CreditRow | null): unknown[] {
  const m = r.measurement;
  return [
    'summary', r.workspace.slug, r.month, r.workspace.name, r.period.start, r.period.end, '', '', m.uptimePct ?? '', r.plan.slaTarget ?? '', m.checks, m.ok, m.excludedChecks, r.result,
    r.credit?.pct ?? '', r.credit ? (r.credit.amountCents / 100).toFixed(2) : '', r.credit?.currency ?? r.plan.currency, credit?.status ?? '',
  ];
}

/** Summary rows of many reports (operator export of one month). */
export function reportsSummaryCsv(items: { data: SlaReport; credit: CreditRow | null }[]): string {
  return [CSV_HEADER, ...items.map((i) => summaryRow(i.data, i.credit))].map(csvLine).join('\r\n') + '\r\n';
}

/** One CSV per report: a summary row, then one row per maintenance window and incident (RFC 4180, comma-separated). */
export function reportCsv(r: SlaReport, credit: CreditRow | null): string {
  const rows: unknown[][] = [CSV_HEADER, summaryRow(r, credit)];
  for (const w of r.maintenance) rows.push(['maintenance', r.workspace.slug, r.month, w.title, w.start, w.end, w.minutes, w.excluded ? 'yes' : 'no', '', '', '', '', '', '', '', '', '', '']);
  for (const i of r.incidents) rows.push(['incident', r.workspace.slug, r.month, i.title, i.start, i.end ?? '', i.minutes, '', '', '', '', '', '', '', '', '', '', '']);
  return rows.map(csvLine).join('\r\n') + '\r\n';
}

export class ReportService {
  private approving = new Set<string>();

  constructor(private d: { db: Db; cfg: CloudConfig; plans: Plan[]; clock: Clock; log: Log; workspaces: WorkspaceService; billing: BillingService; alerts?: AlertService }) {}

  private minutes(a: Date, b: Date) {
    return Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));
  }

  /** Compute (not store) the report of one workspace for one month. */
  async compute(ws: Workspace, month: string, by: 'system' | 'operator'): Promise<SlaReport> {
    const tz = this.d.cfg.timeZone;
    const { start, end, firstDay, nextFirstDay } = monthRange(month, tz);
    const agg = (await this.d.db.query<{ checks: number; ok: number; excluded: number }>(
      `SELECT COALESCE(SUM(checks), 0)::int AS checks, COALESCE(SUM(ok), 0)::int AS ok, COALESCE(SUM(excluded), 0)::int AS excluded
       FROM workspace_health_daily WHERE workspace_id = $1 AND day >= $2 AND day < $3`,
      [ws.id, firstDay, nextFirstDay],
    ))[0];
    const plan = planById(this.d.plans, ws.plan);
    const { result, tier } = evaluate(plan, agg.ok, agg.checks);
    const price = plan.monthlyPriceCents ?? null;
    const currency = plan.currency || 'eur';
    const credit = tier && price ? { pct: tier.pct, amountCents: Math.round((price * tier.pct) / 100), currency, rule: `< ${pctLabel(tier.below)}` } : null;
    const clip = (a: Date, b: Date) => [new Date(Math.max(a.getTime(), start.getTime())), new Date(Math.min(b.getTime(), end.getTime()))] as const;

    const windows = await this.d.db.query<{ title: string; workspace_id: string | null; starts_at: Date; ends_at: Date; canceled_at: Date | null; excluded: boolean }>(
      `SELECT title, workspace_id, starts_at, ends_at, canceled_at, excluded FROM maintenance
       WHERE starts_at < $1 AND ends_at > $2 AND (workspace_id IS NULL OR workspace_id = $3) AND (canceled_at IS NULL OR canceled_at > starts_at)
       ORDER BY starts_at`,
      [end.toISOString(), start.toISOString(), ws.id],
    );
    const maintenance = windows.map((w) => {
      const effEnd = w.canceled_at && new Date(w.canceled_at) < new Date(w.ends_at) ? new Date(w.canceled_at) : new Date(w.ends_at);
      const [a, b] = clip(new Date(w.starts_at), effEnd);
      return { title: w.title, scope: (w.workspace_id ? 'workspace' : 'platform') as 'platform' | 'workspace', start: a.toISOString(), end: b.toISOString(), minutes: this.minutes(a, b), excluded: w.excluded };
    });

    const incs = await this.d.db.query<{ id: string; title: string; workspace_id: string | null; created_at: Date; resolved_at: Date | null }>(
      `SELECT id, title, workspace_id, created_at, resolved_at FROM incidents
       WHERE (workspace_id = $1 OR (workspace_id IS NULL AND $4 = 'shared')) AND created_at < $2 AND (resolved_at IS NULL OR resolved_at > $3)
       ORDER BY created_at`,
      [ws.id, end.toISOString(), start.toISOString(), ws.deployment],
    );
    const now = this.d.clock.now();
    const incidents = incs.map((i) => {
      const resolved = i.resolved_at ? new Date(i.resolved_at) : null;
      const [a, b] = clip(new Date(i.created_at), resolved && resolved < end ? resolved : now < end ? now : end);
      return {
        id: i.id,
        title: i.title,
        scope: (i.workspace_id ? 'workspace' : 'platform') as 'platform' | 'workspace',
        start: new Date(i.created_at).toISOString(),
        end: resolved ? resolved.toISOString() : null,
        minutes: this.minutes(a, b),
        ongoing: !resolved || resolved >= end,
      };
    });

    const intervalSec = Math.round((this.d.cfg.healthIntervalMs || 30_000) / 1000);
    return {
      format: 1,
      workspace: { id: ws.id, slug: ws.slug, name: ws.name, deployment: ws.deployment },
      month,
      period: { start: start.toISOString(), end: end.toISOString(), timeZone: tz },
      plan: { id: plan.id, name: plan.name, slaTarget: plan.slaTarget ?? null, monthlyPriceCents: price, currency, credits: plan.credits || [] },
      measurement: {
        checks: agg.checks,
        ok: agg.ok,
        failed: agg.checks - agg.ok,
        uptimePct: agg.checks ? Math.floor((agg.ok * 100_000) / agg.checks) / 1000 : null,
        excludedChecks: agg.excluded,
        intervalSec,
        estimatedDowntimeMinutes: Math.round(((agg.checks - agg.ok) * intervalSec) / 60),
      },
      maintenance,
      incidents,
      result,
      credit,
      generatedAt: now.toISOString(),
      generatedBy: by,
    };
  }

  /** Latest version of a month's report. */
  async current(workspaceId: string, month: string): Promise<ReportRow | null> {
    return one<ReportRow>(this.d.db, 'SELECT * FROM sla_reports WHERE workspace_id = $1 AND month = $2 ORDER BY version DESC LIMIT 1', [workspaceId, month]);
  }

  async byId(id: string): Promise<ReportRow | null> {
    return one<ReportRow>(this.d.db, 'SELECT * FROM sla_reports WHERE id = $1', [id]);
  }

  async credit(reportId: string): Promise<CreditRow | null> {
    return one<CreditRow>(this.d.db, 'SELECT * FROM sla_credits WHERE report_id = $1', [reportId]);
  }

  /** Latest version per month for one workspace, newest month first, with its credit. */
  async listForWorkspace(workspaceId: string): Promise<(ReportRow & { credit_status: CreditStatus | null })[]> {
    return this.d.db.query(
      `SELECT DISTINCT ON (r.month) r.*, c.status AS credit_status FROM sla_reports r LEFT JOIN sla_credits c ON c.report_id = r.id
       WHERE r.workspace_id = $1 ORDER BY r.month DESC, r.version DESC`,
      [workspaceId],
    );
  }

  /** Latest version per workspace for one month (operator). */
  async listMonth(month: string): Promise<(ReportRow & { slug: string; name: string; credit: CreditRow | null })[]> {
    const rows = await this.d.db.query<ReportRow & { slug: string; name: string }>(
      `SELECT DISTINCT ON (r.workspace_id) r.*, w.slug, w.name FROM sla_reports r JOIN workspaces w ON w.id = r.workspace_id
       WHERE r.month = $1 ORDER BY r.workspace_id, r.version DESC`,
      [month],
    );
    const out = [];
    for (const r of rows) out.push({ ...r, credit: await this.credit(r.id) });
    return out.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /**
   * Store a report. The system makes version 1 once; an operator can make a new version with a reason (audited),
   * unless a credit for the month was already approved.
   */
  async generate(workspaceId: string, month: string, ref: ActorRef, reason?: string): Promise<ReportRow> {
    if (!MONTH_RE.test(month)) throw new UserError('Ongeldige maand.');
    const ws = await this.d.workspaces.get(workspaceId);
    if (!ws || ws.status === 'deleted') throw new UserError('Onbekende workspace.');
    const { end } = monthRange(month, this.d.cfg.timeZone);
    if (this.d.clock.now() < end) throw new UserError('Een maandrapport kan pas na het einde van de maand worden gemaakt.');
    const prev = await this.current(workspaceId, month);
    if (prev) {
      if (ref.actor !== 'operator') throw new UserError('Dit rapport bestaat al en is onveranderlijk.');
      if (!String(reason || '').trim()) throw new UserError('Geef een reden voor het opnieuw maken.');
      const c = await this.credit(prev.id);
      if (c && c.status !== 'pending' && c.status !== 'rejected') throw new UserError('Voor deze maand is al een credit goedgekeurd; het rapport blijft zoals het is.');
    }
    const by = ref.actor === 'operator' ? 'operator' : 'system';
    const data = await this.compute(ws, month, by);
    const row: ReportRow = {
      id: newId('rep_'),
      workspace_id: ws.id,
      month,
      version: (prev?.version ?? 0) + 1,
      data,
      generated_at: this.d.clock.now(),
      generated_by: ref.actorId ?? by,
      reason: reason ? String(reason).slice(0, 500) : null,
    };
    await this.d.db.tx(async (q) => {
      await q.query('INSERT INTO sla_reports (id, workspace_id, month, version, data, generated_at, generated_by, reason) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)', [
        row.id,
        row.workspace_id,
        month,
        row.version,
        JSON.stringify(data),
        row.generated_at.toISOString(),
        row.generated_by,
        row.reason,
      ]);
      if (prev) {
        await q.query(
          "UPDATE sla_credits SET status = 'rejected', note = $2, decided_by = $3, decided_at = $4 WHERE report_id = $1 AND status = 'pending'",
          [prev.id, `Vervangen door versie ${row.version}`, ref.actorId ?? null, row.generated_at.toISOString()],
        );
      }
      if (data.credit && data.credit.amountCents > 0) {
        await q.query(
          "INSERT INTO sla_credits (id, report_id, workspace_id, month, pct, amount_cents, currency, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)",
          [newId('crd_'), row.id, ws.id, month, data.credit.pct, data.credit.amountCents, data.credit.currency, row.generated_at.toISOString()],
        );
      }
      await audit(q, this.d.clock, { ...ref, kind: prev ? 'sla.report_regenerated' : 'sla.report_generated', workspaceId: ws.id, data: { month, version: row.version, result: data.result, reason: row.reason } });
    });
    this.d.alerts?.notify(ws, 'report.ready', { month, version: row.version, uptimePct: data.measurement.uptimePct, result: data.result, url: `${this.d.cfg.url}/workspaces/${ws.id}/reports/${month}` });
    return row;
  }

  /** After a month ends: version 1 for every workspace that existed in it and has no report yet. */
  async generateDue(month = monthOf(this.d.clock.now(), this.d.cfg.timeZone, -1), ref: ActorRef = { actor: 'system' }): Promise<number> {
    const { end } = monthRange(month, this.d.cfg.timeZone);
    if (this.d.clock.now() < end) return 0;
    const rows = await this.d.db.query<{ id: string }>(
      `SELECT w.id FROM workspaces w WHERE w.status <> 'deleted' AND w.created_at < $1
       AND NOT EXISTS (SELECT 1 FROM sla_reports r WHERE r.workspace_id = w.id AND r.month = $2)`,
      [end.toISOString(), month],
    );
    let n = 0;
    for (const r of rows) {
      try {
        await this.generate(r.id, month, ref);
        n++;
      } catch (e) {
        this.d.log.error(`maandrapport ${month} voor ${r.id} mislukte`, e);
      }
    }
    return n;
  }

  // ---------- credits: never without an operator ----------

  private async pendingCredit(reportId: string): Promise<{ credit: CreditRow; report: ReportRow }> {
    const report = await this.byId(reportId);
    const credit = report ? await this.credit(report.id) : null;
    if (!report || !credit) throw new UserError('Geen credit bij dit rapport.');
    if (credit.status !== 'pending') throw new UserError('Over deze credit is al besloten.');
    const latest = await this.current(report.workspace_id, report.month);
    if (latest?.id !== report.id) throw new UserError('Er is een nieuwere versie van dit rapport.');
    return { credit, report };
  }

  /** Approve: Stripe customer → balance credit on the next invoice; otherwise "te verrekenen" (manual). */
  async approveCredit(reportId: string, ref: ActorRef): Promise<CreditRow> {
    if (this.approving.has(reportId)) throw new UserError('Deze credit wordt al verwerkt.');
    this.approving.add(reportId);
    try {
      const { credit, report } = await this.pendingCredit(reportId);
      const sub = await this.d.billing.subscription(report.workspace_id);
      const nowIso = this.d.clock.now().toISOString();
      if (sub?.provider === 'stripe' && sub.external_customer_id) {
        if (!this.d.billing.stripe) throw new UserError('Stripe staat uit; deze klant betaalt via Stripe. Zet Stripe aan of wijs af.');
        let tx: { id: string };
        try {
          tx = await this.d.billing.stripe.createBalanceCredit({
            customerId: sub.external_customer_id,
            amountCents: credit.amount_cents,
            currency: credit.currency,
            description: `TeamBot Cloud servicecredit ${report.month} (${report.data.workspace.slug}): ${credit.pct}%`,
            reportId: report.id,
          });
        } catch (e) {
          throw new UserError(e instanceof StripeError ? e.message : 'Stripe gaf een fout; probeer het opnieuw.', 502);
        }
        await this.d.db.query("UPDATE sla_credits SET status = 'applied', method = 'stripe', external_ref = $2, decided_by = $3, decided_at = $4 WHERE id = $1 AND status = 'pending'", [
          credit.id,
          tx.id,
          ref.actorId ?? null,
          nowIso,
        ]);
      } else {
        await this.d.db.query(
          "UPDATE sla_credits SET status = 'to_settle', method = 'manual', note = 'te verrekenen', decided_by = $2, decided_at = $3 WHERE id = $1 AND status = 'pending'",
          [credit.id, ref.actorId ?? null, nowIso],
        );
      }
      await audit(this.d.db, this.d.clock, { ...ref, kind: 'sla.credit_approved', workspaceId: report.workspace_id, data: { month: report.month, pct: credit.pct, amount: credit.amount_cents } });
      return (await this.credit(report.id))!;
    } finally {
      this.approving.delete(reportId);
    }
  }

  async rejectCredit(reportId: string, note: string, ref: ActorRef) {
    const { credit, report } = await this.pendingCredit(reportId);
    if (!String(note || '').trim()) throw new UserError('Geef een reden voor het afwijzen.');
    await this.d.db.query("UPDATE sla_credits SET status = 'rejected', note = $2, decided_by = $3, decided_at = $4 WHERE id = $1 AND status = 'pending'", [
      credit.id,
      String(note).slice(0, 500),
      ref.actorId ?? null,
      this.d.clock.now().toISOString(),
    ]);
    await audit(this.d.db, this.d.clock, { ...ref, kind: 'sla.credit_rejected', workspaceId: report.workspace_id, data: { month: report.month } });
  }

  /** Manual billing: the credit was deducted on an invoice. */
  async settleCredit(reportId: string, ref: ActorRef) {
    const report = await this.byId(reportId);
    const credit = report ? await this.credit(report.id) : null;
    if (!report || !credit || credit.status !== 'to_settle') throw new UserError('Deze credit staat niet op "te verrekenen".');
    await this.d.db.query("UPDATE sla_credits SET status = 'settled', note = 'verrekend', decided_by = $2, decided_at = $3 WHERE id = $1", [
      credit.id,
      ref.actorId ?? null,
      this.d.clock.now().toISOString(),
    ]);
    await audit(this.d.db, this.d.clock, { ...ref, kind: 'sla.credit_settled', workspaceId: report.workspace_id, data: { month: report.month } });
  }
}
