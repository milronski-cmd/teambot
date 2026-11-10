import type { Db, Queryable } from '../db.js';
import { one } from '../db.js';
import type { CloudConfig } from '../config.js';
import { audit } from '../audit.js';
import { UserError, type Account } from '../accounts.js';
import type { Workspace, WorkspaceService, ActorRef } from '../workspaces.js';
import { addDays, type Clock, type Log } from '../util.js';
import { planById, type Plan } from './plans.js';
import { StripeClient, StripeError, mapStripeStatus, verifyStripeSignature } from './stripe.js';

export interface Subscription {
  id: string;
  workspace_id: string;
  provider: 'manual' | 'stripe';
  external_customer_id: string | null;
  external_subscription_id: string | null;
  plan: string;
  status: string;
  current_period_end: Date | null;
  cancel_at: Date | null;
  canceled_at: Date | null;
  payment_failed_at: Date | null;
  last_event_at: Date | null;
  updated_at: Date;
}

export type Decision = { action: 'none' } | { action: 'suspend'; reason: string } | { action: 'resume' } | { action: 'delete' };

/** Pauses that billing may lift again by itself. An operator hold ('operator') is never lifted automatically. */
export const BILLING_REASONS = new Set(['trial_ended', 'payment_failed', 'canceled']);

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'unpaid', 'paused', 'canceled'] as const;

/** What is wrong with the subscription right now (reason), or null when the workspace may run. */
export function billingProblem(ws: Pick<Workspace, 'trial_ends_at'>, sub: Pick<Subscription, 'status' | 'payment_failed_at' | 'updated_at'>, now: Date, graceDays: number): string | null {
  switch (sub.status) {
    case 'trialing':
      return ws.trial_ends_at && now >= new Date(ws.trial_ends_at) ? 'trial_ended' : null;
    case 'active':
      return null;
    case 'past_due':
    case 'unpaid':
    case 'incomplete': {
      const since = new Date(sub.payment_failed_at || sub.updated_at);
      return now >= addDays(since, graceDays) ? 'payment_failed' : null;
    }
    case 'paused':
      return 'payment_failed';
    case 'canceled':
      return 'canceled';
    default:
      return null;
  }
}

/** Pure state machine: what should happen to this workspace now? */
export function decide(ws: Pick<Workspace, 'status' | 'status_reason' | 'trial_ends_at' | 'delete_after'>, sub: Subscription | null, now: Date, graceDays: number): Decision {
  if (ws.status === 'deleted') return { action: 'none' };
  if (ws.status === 'deleting') return { action: 'delete' }; // finish an interrupted delete
  if (ws.delete_after && now >= new Date(ws.delete_after)) return { action: 'delete' };
  if (ws.status === 'provisioning' || !sub) return { action: 'none' };
  const problem = billingProblem(ws, sub, now, graceDays);
  if (ws.status === 'active' && problem) return { action: 'suspend', reason: problem };
  if (ws.status === 'suspended' && !problem && BILLING_REASONS.has(ws.status_reason || '')) return { action: 'resume' };
  return { action: 'none' };
}

export class BillingService {
  readonly stripe: StripeClient | null;

  constructor(private d: { db: Db; cfg: CloudConfig; plans: Plan[]; clock: Clock; log: Log; workspaces: WorkspaceService; fetchImpl?: typeof fetch }) {
    this.stripe = d.cfg.stripe.secretKey ? new StripeClient({ secretKey: d.cfg.stripe.secretKey, apiBase: d.cfg.stripe.apiBase, fetchImpl: d.fetchImpl }) : null;
  }

  /** "stripe" when STRIPE_SECRET_KEY is set, otherwise "manual" (the operator sets plan and status). */
  get mode(): 'stripe' | 'manual' {
    return this.stripe ? 'stripe' : 'manual';
  }

  async subscription(workspaceId: string): Promise<Subscription | null> {
    return one<Subscription>(this.d.db, 'SELECT * FROM subscriptions WHERE workspace_id = $1', [workspaceId]);
  }

  private planForPrice(priceId: string | undefined): string | null {
    if (!priceId) return null;
    for (const [plan, price] of Object.entries(this.d.cfg.stripe.prices)) if (price === priceId) return plan;
    return null;
  }

  // ---------- Stripe webhook ----------

  async handleWebhook(raw: Buffer, signature: string | undefined, ip: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const secret = this.d.cfg.stripe.webhookSecret;
    if (!secret) return { status: 404, body: { error: 'Stripe staat uit' } };
    const check = verifyStripeSignature(raw, signature, secret, { toleranceSec: this.d.cfg.stripe.toleranceSec, nowSec: Math.floor(this.d.clock.now().getTime() / 1000) });
    if (!check.ok) {
      this.d.log.warn(`stripe-webhook geweigerd van ${ip}: ${check.reason}`);
      return { status: 400, body: { error: 'Ongeldige handtekening' } };
    }
    let event: any;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return { status: 400, body: { error: 'Ongeldige JSON' } };
    }
    if (typeof event?.id !== 'string' || !/^evt_[A-Za-z0-9_]{1,200}$/.test(event.id) || typeof event.type !== 'string') return { status: 400, body: { error: 'Onbekend event' } };
    const result = await this.d.db.tx(async (q) => {
      const inserted = await q.query(
        'INSERT INTO billing_events (id, provider, type, event_created_at, received_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING RETURNING id',
        [event.id, 'stripe', event.type.slice(0, 100), Number.isFinite(event.created) ? new Date(event.created * 1000).toISOString() : null, this.d.clock.now().toISOString()],
      );
      if (!inserted.length) return { duplicate: true as const };
      const r = await this.apply(q, event);
      await q.query('UPDATE billing_events SET workspace_id = $2, outcome = $3 WHERE id = $1', [event.id, r.workspaceId, r.outcome]);
      if (r.workspaceId) await audit(q, this.d.clock, { actor: 'stripe', kind: `billing.${event.type}`, workspaceId: r.workspaceId, data: { event: event.id, outcome: r.outcome } });
      return { duplicate: false as const, ...r };
    });
    if (result.duplicate) return { status: 200, body: { received: true, duplicate: true } };
    if (result.workspaceId) {
      // Side effects (plan limits, stop/start) after the commit; the periodic job retries anything that fails here.
      try {
        if (result.plan) await this.d.workspaces.setPlan(result.workspaceId, result.plan);
        await this.enforce(result.workspaceId);
      } catch (e) {
        this.d.log.error('afhandelen na webhook mislukte (wordt opnieuw geprobeerd)', e);
      }
    }
    return { status: 200, body: { received: true } };
  }

  private async findSub(q: Queryable, workspaceId: unknown, subscriptionId: unknown): Promise<Subscription | null> {
    if (typeof subscriptionId === 'string' && subscriptionId) {
      const s = await one<Subscription>(q, 'SELECT * FROM subscriptions WHERE external_subscription_id = $1', [subscriptionId]);
      if (s) return s;
    }
    if (typeof workspaceId === 'string' && workspaceId) return one<Subscription>(q, 'SELECT * FROM subscriptions WHERE workspace_id = $1', [workspaceId]);
    return null;
  }

  /** Apply one verified Stripe event inside the webhook transaction. */
  private async apply(q: Queryable, event: any): Promise<{ workspaceId: string | null; outcome: string; plan?: string }> {
    const obj = event?.data?.object || {};
    const now = this.d.clock.now();
    const nowIso = now.toISOString();
    const created = Number.isFinite(event.created) ? new Date(event.created * 1000) : now;
    const toDate = (s: unknown) => (typeof s === 'number' && Number.isFinite(s) ? new Date(s * 1000).toISOString() : null);
    const live = async (wsId: string) => one<Workspace>(q, "SELECT * FROM workspaces WHERE id = $1 AND status <> 'deleted'", [wsId]);

    switch (event.type) {
      case 'checkout.session.completed': {
        if (obj.mode && obj.mode !== 'subscription') return { workspaceId: null, outcome: 'ignored' };
        const wsId = String(obj.client_reference_id || obj.metadata?.workspace_id || '');
        const ws = wsId ? await live(wsId) : null;
        if (!ws) return { workspaceId: null, outcome: 'unknown-workspace' };
        const requested = this.d.plans.find((p) => p.id === obj.metadata?.plan && p.paid);
        const plan = requested?.id || (planById(this.d.plans, ws.plan).paid ? ws.plan : this.d.plans.find((p) => p.paid)?.id || ws.plan);
        await q.query(
          `UPDATE subscriptions SET provider = 'stripe', external_customer_id = $2, external_subscription_id = $3, status = 'active', plan = $4,
             payment_failed_at = NULL, canceled_at = NULL, cancel_at = NULL, last_event_at = $5, updated_at = $6 WHERE workspace_id = $1`,
          [ws.id, typeof obj.customer === 'string' ? obj.customer : null, typeof obj.subscription === 'string' ? obj.subscription : null, plan, created.toISOString(), nowIso],
        );
        await q.query('UPDATE workspaces SET delete_after = NULL, updated_at = $2 WHERE id = $1', [ws.id, nowIso]);
        if (typeof obj.customer === 'string') await q.query('UPDATE accounts SET stripe_customer_id = $2 WHERE id = $1 AND stripe_customer_id IS NULL', [ws.owner_id, obj.customer]);
        return { workspaceId: ws.id, outcome: 'active', plan };
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = await this.findSub(q, obj.metadata?.workspace_id, obj.id);
        if (!sub || !(await live(sub.workspace_id))) return { workspaceId: null, outcome: 'unknown-workspace' };
        if (sub.last_event_at && created < new Date(sub.last_event_at)) return { workspaceId: sub.workspace_id, outcome: 'stale' };
        const status = event.type === 'customer.subscription.deleted' ? 'canceled' : mapStripeStatus(String(obj.status || ''));
        const item = obj.items?.data?.[0];
        const plan = this.planForPrice(item?.price?.id) || sub.plan;
        await q.query(
          `UPDATE subscriptions SET provider = 'stripe',
             external_subscription_id = COALESCE(external_subscription_id, $2), external_customer_id = COALESCE(external_customer_id, $3),
             status = $4, plan = $5, current_period_end = $6, cancel_at = $7,
             canceled_at = CASE WHEN $4 = 'canceled' THEN COALESCE(canceled_at, $8::timestamptz) ELSE NULL END,
             payment_failed_at = CASE WHEN $4 IN ('past_due', 'unpaid') THEN COALESCE(payment_failed_at, $8::timestamptz) WHEN $4 = 'active' THEN NULL ELSE payment_failed_at END,
             last_event_at = $9, updated_at = $8
           WHERE id = $1`,
          [
            sub.id,
            typeof obj.id === 'string' ? obj.id : null,
            typeof obj.customer === 'string' ? obj.customer : null,
            status,
            plan,
            toDate(obj.current_period_end ?? item?.current_period_end),
            toDate(obj.cancel_at),
            nowIso,
            created.toISOString(),
          ],
        );
        if (status === 'canceled') {
          await q.query('UPDATE workspaces SET delete_after = COALESCE(delete_after, $2), updated_at = $3 WHERE id = $1', [sub.workspace_id, addDays(now, this.d.cfg.retentionDays).toISOString(), nowIso]);
        } else if (status === 'active') {
          await q.query('UPDATE workspaces SET delete_after = NULL, updated_at = $2 WHERE id = $1', [sub.workspace_id, nowIso]);
        }
        return { workspaceId: sub.workspace_id, outcome: status, plan: plan !== sub.plan ? plan : undefined };
      }
      case 'invoice.payment_failed':
      case 'invoice.paid': {
        const details = obj.parent?.subscription_details || obj.subscription_details || {};
        const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id || details.subscription;
        const sub = await this.findSub(q, details.metadata?.workspace_id, subId);
        if (!sub || !(await live(sub.workspace_id))) return { workspaceId: null, outcome: 'unknown-workspace' };
        if (sub.status === 'canceled') return { workspaceId: sub.workspace_id, outcome: 'ignored-canceled' };
        if (event.type === 'invoice.payment_failed') {
          await q.query("UPDATE subscriptions SET status = 'past_due', payment_failed_at = COALESCE(payment_failed_at, $2), updated_at = $2 WHERE id = $1", [sub.id, nowIso]);
          return { workspaceId: sub.workspace_id, outcome: 'past_due' };
        }
        await q.query("UPDATE subscriptions SET status = 'active', payment_failed_at = NULL, updated_at = $2 WHERE id = $1", [sub.id, nowIso]);
        await q.query('UPDATE workspaces SET delete_after = NULL WHERE id = $1', [sub.workspace_id]);
        return { workspaceId: sub.workspace_id, outcome: 'active' };
      }
      default:
        return { workspaceId: null, outcome: 'ignored' };
    }
  }

  // ---------- enforcement ----------

  /** Bring one workspace (or all) in line with its subscription: suspend, resume or delete after retention. */
  async enforce(workspaceId?: string): Promise<{ id: string; action: string }[]> {
    const rows = await this.d.db.query<Workspace>(
      workspaceId ? 'SELECT * FROM workspaces WHERE id = $1' : "SELECT * FROM workspaces WHERE status <> 'deleted'",
      workspaceId ? [workspaceId] : [],
    );
    const done: { id: string; action: string }[] = [];
    const sys: ActorRef = { actor: 'system' };
    for (const ws of rows) {
      const sub = await this.subscription(ws.id);
      const d = decide(ws, sub, this.d.clock.now(), this.d.cfg.graceDays);
      try {
        if (d.action === 'suspend') await this.d.workspaces.suspend(ws.id, d.reason, sys);
        else if (d.action === 'resume') await this.d.workspaces.resume(ws.id, sys);
        else if (d.action === 'delete') await this.d.workspaces.remove(ws.id, sys);
        if (d.action !== 'none') done.push({ id: ws.id, action: d.action });
      } catch (e) {
        this.d.log.error(`handhaven van ${ws.slug} (${d.action}) mislukte`, e);
      }
    }
    if (!workspaceId) await this.d.workspaces.cleanupExports();
    return done;
  }

  // ---------- customer actions ----------

  async checkoutUrl(ws: Workspace, account: Account, planId: string): Promise<string> {
    if (!this.stripe) throw new UserError('Online betalen staat uit. De beheerder zet je abonnement voor je klaar.');
    // Shared workspaces choose among the shared paid plans; a dedicated workspace only among dedicated plans.
    const plan = this.d.plans.find((p) => p.id === planId && p.paid && (p.deployment === 'dedicated') === (ws.deployment === 'dedicated'));
    if (!plan) throw new UserError('Kies een abonnement.');
    const price = this.d.cfg.stripe.prices[plan.id];
    if (!price) throw new UserError('Dit abonnement is nog niet te koop. Kies een ander of neem contact op.');
    const sub = await this.subscription(ws.id);
    if (sub?.provider === 'stripe' && sub.external_subscription_id && sub.status !== 'canceled') throw new UserError('Je hebt al een abonnement. Wijzig het via "Abonnement beheren".');
    const base = `${this.d.cfg.url}/workspaces/${ws.id}`;
    try {
      const s = await this.stripe.createCheckoutSession({
        priceId: price,
        workspaceId: ws.id,
        plan: plan.id,
        customerId: account.stripe_customer_id,
        email: account.email,
        successUrl: `${base}?m=betaald`,
        cancelUrl: `${base}?m=betaling-afgebroken`,
      });
      const u = new URL(s.url);
      if (u.protocol !== 'https:' && this.d.cfg.stripe.apiBase === 'https://api.stripe.com') throw new UserError('Onverwacht antwoord van Stripe.');
      await audit(this.d.db, this.d.clock, { actor: 'user', actorId: account.id, kind: 'billing.checkout_started', workspaceId: ws.id, data: { plan: plan.id } });
      return u.toString();
    } catch (e) {
      if (e instanceof StripeError) throw new UserError(e.message, 502);
      throw e;
    }
  }

  async portalUrl(ws: Workspace, account: Account): Promise<string> {
    if (!this.stripe) throw new UserError('Online betalen staat uit. Neem contact op met de beheerder om je abonnement te wijzigen.');
    const sub = await this.subscription(ws.id);
    const customer = sub?.external_customer_id || account.stripe_customer_id;
    if (!customer) throw new UserError('Je hebt nog geen betaalgegevens. Kies eerst een abonnement.');
    try {
      const s = await this.stripe.createPortalSession({ customerId: customer, returnUrl: `${this.d.cfg.url}/workspaces/${ws.id}` });
      return new URL(s.url).toString();
    } catch (e) {
      if (e instanceof StripeError) throw new UserError(e.message, 502);
      throw e;
    }
  }

  /** Before deleting: stop a running Stripe subscription so the customer is never billed for a deleted workspace. */
  async cancelBeforeDelete(ws: Workspace, ref: ActorRef) {
    const sub = await this.subscription(ws.id);
    if (!sub || sub.status === 'canceled') return;
    if (sub.provider === 'stripe' && sub.external_subscription_id) {
      if (!this.stripe) throw new UserError('Je Stripe-abonnement kan nu niet worden opgezegd (Stripe staat uit). Neem contact op met de beheerder.');
      try {
        await this.stripe.cancelSubscription(sub.external_subscription_id);
      } catch (e) {
        throw new UserError(e instanceof StripeError ? `Opzeggen bij Stripe mislukte: ${e.message}` : 'Opzeggen bij Stripe mislukte. Probeer het later opnieuw.', 502);
      }
    }
    const now = this.d.clock.now().toISOString();
    await this.d.db.query("UPDATE subscriptions SET status = 'canceled', canceled_at = COALESCE(canceled_at, $2), updated_at = $2 WHERE id = $1", [sub.id, now]);
    await audit(this.d.db, this.d.clock, { ...ref, kind: 'billing.canceled_for_delete', workspaceId: ws.id });
  }

  /** Manual mode (or a manual subscription): the operator sets plan and status. */
  async manualSet(workspaceId: string, input: { plan?: string; status?: string }, ref: ActorRef) {
    const sub = await this.subscription(workspaceId);
    if (!sub) throw new UserError('Geen abonnement gevonden.');
    if (sub.provider !== 'manual') throw new UserError('Dit abonnement loopt via Stripe; wijzig het daar.');
    const plan = input.plan ? this.d.plans.find((p) => p.id === input.plan) : null;
    if (input.plan && !plan) throw new UserError('Onbekend abonnement.');
    const ws = await this.d.workspaces.get(workspaceId);
    if (plan && ws && (plan.deployment === 'dedicated') !== (ws.deployment === 'dedicated')) {
      throw new UserError(ws.deployment === 'dedicated' ? 'Een dedicated omgeving houdt een dedicated abonnement.' : 'Een dedicated abonnement hoort bij een dedicated omgeving.');
    }
    const status = input.status && (SUBSCRIPTION_STATUSES as readonly string[]).includes(input.status) ? input.status : null;
    if (input.status && !status) throw new UserError('Onbekende status.');
    const now = this.d.clock.now();
    const nowIso = now.toISOString();
    await this.d.db.tx(async (q) => {
      if (status) {
        await q.query(
          `UPDATE subscriptions SET status = $2,
             payment_failed_at = CASE WHEN $2 IN ('past_due', 'unpaid') THEN COALESCE(payment_failed_at, $3::timestamptz) ELSE NULL END,
             canceled_at = CASE WHEN $2 = 'canceled' THEN COALESCE(canceled_at, $3::timestamptz) ELSE NULL END, updated_at = $3 WHERE id = $1`,
          [sub.id, status, nowIso],
        );
        if (status === 'canceled') await q.query('UPDATE workspaces SET delete_after = COALESCE(delete_after, $2) WHERE id = $1', [workspaceId, addDays(now, this.d.cfg.retentionDays).toISOString()]);
        else await q.query('UPDATE workspaces SET delete_after = NULL WHERE id = $1', [workspaceId]);
      }
      if (plan) await q.query('UPDATE subscriptions SET plan = $2, updated_at = $3 WHERE id = $1', [sub.id, plan.id, nowIso]);
      await audit(q, this.d.clock, { ...ref, kind: 'billing.manual_set', workspaceId, data: { plan: plan?.id, status } });
    });
    if (plan) await this.d.workspaces.setPlan(workspaceId, plan.id);
    await this.enforce(workspaceId);
  }
}
