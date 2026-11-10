import { randomToken as token, sha256 } from '../../core/util.js';

export { sha256 };
import crypto from 'node:crypto';

/** Constant-time string comparison (false for different lengths). */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

export const hmacHex = (secret: string, data: string | Buffer) => crypto.createHmac('sha256', secret).update(data).digest('hex');
export const randomToken = (bytes = 24) => token(bytes);

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Slack request signing (Events API / interactivity over HTTP):
 * signature = "v0=" + HMAC-SHA256(signing secret, "v0:" + timestamp + ":" + raw body),
 * and the timestamp must be within 5 minutes to stop replays.
 */
export function verifySlackSignature(o: { secret: string; timestamp: string | undefined; signature: string | undefined; body: Buffer | string; nowMs?: number; toleranceSec?: number }): VerifyResult {
  if (!o.secret) return { ok: false, reason: 'geen signing secret ingesteld' };
  if (!o.timestamp || !o.signature) return { ok: false, reason: 'handtekening ontbreekt' };
  const ts = Number(o.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'ongeldige tijdstempel' };
  const now = (o.nowMs ?? Date.now()) / 1000;
  if (Math.abs(now - ts) > (o.toleranceSec ?? 300)) return { ok: false, reason: 'verlopen tijdstempel (mogelijke replay)' };
  const base = Buffer.concat([Buffer.from(`v0:${o.timestamp}:`), Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body)]);
  const expected = 'v0=' + hmacHex(o.secret, base);
  return safeEqual(expected, o.signature) ? { ok: true } : { ok: false, reason: 'ongeldige handtekening' };
}

/** Meta (WhatsApp Cloud API) webhooks: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body). */
export function verifyMetaSignature(o: { appSecret: string; signature: string | undefined; body: Buffer | string }): VerifyResult {
  if (!o.appSecret) return { ok: false, reason: 'geen app secret ingesteld' };
  if (!o.signature) return { ok: false, reason: 'handtekening ontbreekt' };
  const expected = 'sha256=' + hmacHex(o.appSecret, o.body);
  return safeEqual(expected, o.signature) ? { ok: true } : { ok: false, reason: 'ongeldige handtekening' };
}

/**
 * Generic TeamBot webhook signing (in and out):
 * X-TeamBot-Timestamp: unix seconds, X-TeamBot-Signature: "sha256=" + HMAC-SHA256(secret, timestamp + "." + raw body).
 */
export function signWebhook(secret: string, body: string, nowMs = Date.now()) {
  const timestamp = String(Math.floor(nowMs / 1000));
  return { timestamp, signature: 'sha256=' + hmacHex(secret, `${timestamp}.${body}`) };
}

export function verifyWebhookSignature(o: { secret: string; timestamp: string | undefined; signature: string | undefined; body: Buffer | string; nowMs?: number; toleranceSec?: number }): VerifyResult {
  if (!o.secret) return { ok: false, reason: 'geen geheim ingesteld' };
  if (!o.timestamp || !o.signature) return { ok: false, reason: 'handtekening ontbreekt' };
  const ts = Number(o.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'ongeldige tijdstempel' };
  if (Math.abs((o.nowMs ?? Date.now()) / 1000 - ts) > (o.toleranceSec ?? 300)) return { ok: false, reason: 'verlopen tijdstempel (mogelijke replay)' };
  const body = Buffer.isBuffer(o.body) ? o.body.toString('utf8') : o.body;
  const expected = 'sha256=' + hmacHex(o.secret, `${o.timestamp}.${body}`);
  return safeEqual(expected, o.signature) ? { ok: true } : { ok: false, reason: 'ongeldige handtekening' };
}

/** Token bucket per key. `take` returns false when the key is over its budget. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private capacity: number, private perMs: number) {}
  take(key: string, n = 1): boolean {
    const t = Date.now();
    const b = this.buckets.get(key) || { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / this.perMs) * this.capacity);
    b.at = t;
    if (this.buckets.size > 10_000) this.buckets.clear();
    if (b.tokens < n) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= n;
    this.buckets.set(key, b);
    return true;
  }
}

/** Remove a known secret value from any text (error messages may echo URLs with tokens). */
export function scrub(text: string, secrets: (string | null | undefined)[]): string {
  let t = text;
  for (const s of secrets) if (s && s.length >= 6) t = t.split(s).join('…[verborgen]');
  return t;
}
