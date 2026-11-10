import { hmacHex, safeEqual } from '../crypto.js';

/**
 * Minimal Stripe adapter over plain fetch (no SDK): Checkout, Customer Portal, cancel, and webhook signature
 * verification. Only the documented REST API is used; the secret key never appears in errors or logs.
 */

export type SignatureCheck = { ok: true; timestamp: number } | { ok: false; reason: string };

/**
 * Verify a `Stripe-Signature` header (`t=<unix>,v1=<hex>[,v1=...]`): HMAC-SHA256 over `${t}.${rawBody}` with the
 * endpoint secret, constant-time compared against every v1 signature, and |now - t| within the tolerance window.
 */
export function verifyStripeSignature(
  payload: Buffer | string,
  header: string | undefined | null,
  secret: string,
  opts: { toleranceSec?: number; nowSec?: number } = {},
): SignatureCheck {
  if (!secret) return { ok: false, reason: 'geen webhook-secret ingesteld' };
  if (!header || header.length > 4096) return { ok: false, reason: 'handtekening ontbreekt' };
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) sigs.push(v.toLowerCase());
  }
  if (t === null || !sigs.length) return { ok: false, reason: 'handtekening onleesbaar' };
  const tolerance = opts.toleranceSec ?? 300;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > tolerance) return { ok: false, reason: 'tijdstempel buiten het toegestane venster' };
  const expected = hmacHex(secret, Buffer.concat([Buffer.from(`${t}.`), Buffer.isBuffer(payload) ? payload : Buffer.from(payload)]));
  // Check every signature (no early exit) so timing does not reveal which one matched.
  let match = false;
  for (const s of sigs) match = safeEqual(s, expected) || match;
  return match ? { ok: true, timestamp: t } : { ok: false, reason: 'handtekening klopt niet' };
}

/** Build a Stripe-Signature header (tests, local tooling). */
export function signStripePayload(payload: string | Buffer, secret: string, timestampSec: number): string {
  const sig = hmacHex(secret, Buffer.concat([Buffer.from(`${timestampSec}.`), Buffer.isBuffer(payload) ? payload : Buffer.from(payload)]));
  return `t=${timestampSec},v1=${sig}`;
}

/** Stripe's form encoding: nested objects become a[b][c]=v, arrays a[0][b]=v. */
export function formEncode(obj: Record<string, unknown>, prefix = '', out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' && item !== null ? formEncode(item as Record<string, unknown>, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof v === 'object') formEncode(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export class StripeError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export class StripeClient {
  constructor(private opts: { secretKey: string; apiBase?: string; fetchImpl?: typeof fetch }) {}

  private async call<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const base = (this.opts.apiBase || 'https://api.stripe.com').replace(/\/$/, '');
    const body = params && method !== 'GET' ? formEncode(params).toString() : undefined;
    const headers: Record<string, string> = { authorization: `Bearer ${this.opts.secretKey}` };
    if (body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    let res: Response;
    try {
      res = await (this.opts.fetchImpl || fetch)(`${base}${path}`, { method, headers, body, signal: AbortSignal.timeout(20_000), redirect: 'error' });
    } catch {
      throw new StripeError('Stripe is niet bereikbaar. Probeer het zo opnieuw.', 502);
    }
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new StripeError(`Stripe weigerde het verzoek: ${String(j?.error?.message || res.status).slice(0, 200)}`, res.status);
    return j as T;
  }

  createCheckoutSession(p: { priceId: string; workspaceId: string; plan: string; customerId?: string | null; email: string; successUrl: string; cancelUrl: string }) {
    return this.call<{ id: string; url: string }>(
      'POST',
      '/v1/checkout/sessions',
      {
        mode: 'subscription',
        line_items: [{ price: p.priceId, quantity: 1 }],
        success_url: p.successUrl,
        cancel_url: p.cancelUrl,
        client_reference_id: p.workspaceId,
        ...(p.customerId ? { customer: p.customerId } : { customer_email: p.email }),
        metadata: { workspace_id: p.workspaceId, plan: p.plan },
        subscription_data: { metadata: { workspace_id: p.workspaceId, plan: p.plan } },
      },
      `checkout-${p.workspaceId}-${p.plan}-${Math.floor(Date.now() / 60_000)}`,
    );
  }

  createPortalSession(p: { customerId: string; returnUrl: string }) {
    return this.call<{ url: string }>('POST', '/v1/billing_portal/sessions', { customer: p.customerId, return_url: p.returnUrl });
  }

  /**
   * Service credit: a negative customer balance transaction, which Stripe deducts from the next invoice(s).
   * Idempotent per SLA report, so a retry never credits twice.
   */
  createBalanceCredit(p: { customerId: string; amountCents: number; currency: string; description: string; reportId: string }) {
    if (!/^cus_[A-Za-z0-9]+$/.test(p.customerId)) throw new StripeError('Ongeldige klant', 400);
    if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) throw new StripeError('Ongeldig bedrag', 400);
    return this.call<{ id: string; amount: number }>(
      'POST',
      `/v1/customers/${p.customerId}/balance_transactions`,
      { amount: -p.amountCents, currency: p.currency.toLowerCase(), description: p.description.slice(0, 350), metadata: { sla_report_id: p.reportId } },
      `sla-credit-${p.reportId}`,
    );
  }

  cancelSubscription(subscriptionId: string) {
    if (!/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) throw new StripeError('Ongeldig abonnement', 400);
    return this.call('DELETE', `/v1/subscriptions/${subscriptionId}`);
  }
}

/** Map a Stripe subscription status to ours. */
export function mapStripeStatus(s: string): string {
  switch (s) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'unpaid':
      return 'unpaid';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    case 'paused':
      return 'paused';
    default:
      return 'incomplete';
  }
}
