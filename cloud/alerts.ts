import type { Db } from './db.js';
import { one } from './db.js';
import type { CloudConfig } from './config.js';
import { audit } from './audit.js';
import { decrypt, encrypt, hmacHex, newId, randomToken } from './crypto.js';
import { UserError } from './accounts.js';
import { postWebhook, UrlError, validateWebhookUrl, type Resolver } from './health.js';
import { RateLimiter, type Clock, type Log } from './util.js';
import type { ActorRef } from './workspaces.js';

/**
 * Outbound alerts to a workspace owner (CLD-05): optional e-mail (CLOUD_SMTP_URL) and/or a signed webhook, on
 * incident opened/resolved and when a monthly SLA report is ready. Rate-limited per account and channel; every
 * attempt is logged in `alerts` (status sent / failed / rate_limited / skipped).
 *
 * Webhook body: JSON {id, type, created, workspace:{id,slug,name}, data}. Headers: X-TeamBot-Event,
 * X-TeamBot-Delivery and X-TeamBot-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>.
 */

export type AlertType = 'incident.opened' | 'incident.resolved' | 'report.ready' | 'test';
export type Mailer = (msg: { to: string; subject: string; text: string }) => Promise<void>;

export interface AlertSettings {
  email: boolean;
  webhookUrl: string | null;
  /** E-mail can be sent from this installation. */
  emailAvailable: boolean;
}

export interface AlertWorkspace {
  id: string;
  slug: string;
  name: string;
  owner_id: string;
}

export function signAlert(secret: string, body: string, t: number): string {
  return `t=${t},v1=${hmacHex(secret, `${t}.${body}`)}`;
}

const SUBJECT: Record<AlertType, string> = {
  'incident.opened': 'niet bereikbaar',
  'incident.resolved': 'weer bereikbaar',
  'report.ready': 'SLA-rapport staat klaar',
  test: 'testmelding',
};

export class AlertService {
  private limiter: RateLimiter;
  private inflight = new Set<Promise<unknown>>();
  private mailer: Mailer | null;

  constructor(private d: { db: Db; cfg: CloudConfig; clock: Clock; log: Log; mailer?: Mailer; resolve?: Resolver }) {
    this.limiter = new RateLimiter(d.cfg.alerts.limitPerHour, 3600_000);
    this.mailer =
      d.mailer ||
      (d.cfg.smtpUrl
        ? async (m) => {
            const { default: nodemailer } = await import('nodemailer');
            await nodemailer.createTransport(d.cfg.smtpUrl!).sendMail({ from: d.cfg.mailFrom, ...m });
          }
        : null);
  }

  get emailAvailable() {
    return !!this.mailer;
  }

  async settings(accountId: string): Promise<AlertSettings> {
    const a = await one<{ alert_email: boolean; alert_webhook_url: string | null }>(this.d.db, 'SELECT alert_email, alert_webhook_url FROM accounts WHERE id = $1', [accountId]);
    return { email: !!a?.alert_email, webhookUrl: a?.alert_webhook_url || null, emailAvailable: this.emailAvailable };
  }

  /** Save settings. Returns the webhook signing secret when a new one was made (shown once). */
  async saveSettings(accountId: string, input: { email: boolean; webhookUrl: string }, ref: ActorRef): Promise<{ secret: string | null }> {
    if (input.email && !this.emailAvailable) throw new UserError('E-mailmeldingen zijn op deze installatie niet ingesteld. Gebruik een webhook.');
    let url: string | null = null;
    if (String(input.webhookUrl || '').trim()) {
      try {
        url = await validateWebhookUrl(input.webhookUrl, { allowPrivate: this.d.cfg.dedicated.allowPrivate, cloudDomain: this.d.cfg.domain, resolve: this.d.resolve });
      } catch (e) {
        if (e instanceof UrlError) throw new UserError(e.message);
        throw e;
      }
    }
    const cur = await one<{ alert_webhook_url: string | null; alert_webhook_secret_enc: string | null }>(this.d.db, 'SELECT alert_webhook_url, alert_webhook_secret_enc FROM accounts WHERE id = $1', [accountId]);
    let secret: string | null = null;
    let secretEnc = cur?.alert_webhook_secret_enc ?? null;
    if (!url) secretEnc = null;
    else if (!secretEnc) {
      secret = `whsec_${randomToken(24)}`;
      secretEnc = encrypt(this.d.cfg.secretKey, secret, `alert:${accountId}`);
    }
    await this.d.db.query('UPDATE accounts SET alert_email = $2, alert_webhook_url = $3, alert_webhook_secret_enc = $4, updated_at = $5 WHERE id = $1', [
      accountId,
      !!input.email,
      url,
      secretEnc,
      this.d.clock.now().toISOString(),
    ]);
    await audit(this.d.db, this.d.clock, { ...ref, kind: 'alerts.settings', data: { email: !!input.email, webhook: url ? new URL(url).host : null } });
    return { secret };
  }

  async rotateSecret(accountId: string, ref: ActorRef): Promise<string> {
    const cur = await this.settings(accountId);
    if (!cur.webhookUrl) throw new UserError('Stel eerst een webhook-adres in.');
    const secret = `whsec_${randomToken(24)}`;
    await this.d.db.query('UPDATE accounts SET alert_webhook_secret_enc = $2 WHERE id = $1', [accountId, encrypt(this.d.cfg.secretKey, secret, `alert:${accountId}`)]);
    await audit(this.d.db, this.d.clock, { ...ref, kind: 'alerts.secret_rotated' });
    return secret;
  }

  async recent(accountId: string, n = 10) {
    return this.d.db.query<{ channel: string; type: string; status: string; detail: string | null; created_at: Date }>(
      'SELECT channel, type, status, detail, created_at FROM alerts WHERE account_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
      [accountId, n],
    );
  }

  /** Fire-and-forget: alerts never slow down health checks or report generation. */
  notify(ws: AlertWorkspace, type: AlertType, data: Record<string, unknown>) {
    const p = this.deliver(ws, type, data).catch((e) => this.d.log.error('melding versturen mislukte', e));
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p));
  }

  /** Wait for alerts in flight (tests, shutdown). */
  async idle() {
    await Promise.allSettled([...this.inflight]);
  }

  private async log(accountId: string, workspaceId: string | null, channel: string, type: string, status: string, detail: string | null) {
    await this.d.db.query('INSERT INTO alerts (id, account_id, workspace_id, channel, type, status, detail, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
      newId('alr_'),
      accountId,
      workspaceId || null,
      channel,
      type,
      status,
      detail ? detail.slice(0, 300) : null,
      this.d.clock.now().toISOString(),
    ]);
  }

  async deliver(ws: AlertWorkspace, type: AlertType, data: Record<string, unknown>): Promise<void> {
    const acc = await one<{ id: string; email: string; alert_email: boolean; alert_webhook_url: string | null; alert_webhook_secret_enc: string | null }>(
      this.d.db,
      'SELECT id, email, alert_email, alert_webhook_url, alert_webhook_secret_enc FROM accounts WHERE id = $1',
      [ws.owner_id],
    );
    if (!acc) return;
    const created = Math.floor(this.d.clock.now().getTime() / 1000);
    const id = newId('evt_');
    if (acc.alert_webhook_url && acc.alert_webhook_secret_enc) {
      if (!this.limiter.hit(`${acc.id}|webhook`)) await this.log(acc.id, ws.id, 'webhook', type, 'rate_limited', 'te veel meldingen dit uur');
      else {
        const body = JSON.stringify({ id, type, created, workspace: { id: ws.id, slug: ws.slug, name: ws.name }, data });
        let secret: string;
        try {
          secret = decrypt(this.d.cfg.secretKey, acc.alert_webhook_secret_enc, `alert:${acc.id}`);
        } catch {
          await this.log(acc.id, ws.id, 'webhook', type, 'failed', 'geheim onleesbaar');
          secret = '';
        }
        if (secret) {
          const r = await postWebhook(
            acc.alert_webhook_url,
            body,
            { 'x-teambot-event': type, 'x-teambot-delivery': id, 'x-teambot-signature': signAlert(secret, body, created) },
            { allowPrivate: this.d.cfg.dedicated.allowPrivate, timeoutMs: this.d.cfg.alerts.timeoutMs, resolve: this.d.resolve },
          );
          await this.log(acc.id, ws.id, 'webhook', type, r.ok ? 'sent' : 'failed', r.ok ? `HTTP ${r.status}` : r.error || null);
        }
      }
    }
    if (acc.alert_email) {
      if (!this.mailer) await this.log(acc.id, ws.id, 'email', type, 'skipped', 'geen SMTP ingesteld');
      else if (!this.limiter.hit(`${acc.id}|email`)) await this.log(acc.id, ws.id, 'email', type, 'rate_limited', 'te veel meldingen dit uur');
      else {
        try {
          await this.mailer({ to: acc.email, subject: `[TeamBot Cloud] ${ws.name}: ${SUBJECT[type]}`, text: this.mailText(ws, type, data) });
          await this.log(acc.id, ws.id, 'email', type, 'sent', null);
        } catch (e: any) {
          await this.log(acc.id, ws.id, 'email', type, 'failed', String(e?.message || e).slice(0, 120));
        }
      }
    }
  }

  private mailText(ws: AlertWorkspace, type: AlertType, data: Record<string, unknown>): string {
    const link = `${this.d.cfg.url}/workspaces/${ws.id}`;
    switch (type) {
      case 'incident.opened':
        return `Je TeamBot "${ws.name}" reageert niet${data.detail ? ` (${data.detail})` : ''}. We houden het in de gaten en melden het als hij weer bereikbaar is.\n\nBeschikbaarheid en storingen: ${link}#beschikbaarheid\n`;
      case 'incident.resolved':
        return `Je TeamBot "${ws.name}" is weer bereikbaar.\n\n${link}#beschikbaarheid\n`;
      case 'report.ready':
        return `Het SLA-rapport van ${data.month} voor "${ws.name}" staat klaar: beschikbaarheid ${data.uptimePct ?? 'onbekend'}%.\n\n${link}#rapporten\n`;
      default:
        return `Dit is een testmelding voor "${ws.name}". Je meldingen werken.\n`;
    }
  }
}
