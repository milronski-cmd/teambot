import crypto from 'node:crypto';
import fs from 'node:fs';
import http2 from 'node:http2';
import type { Ctx } from '../../core/types.js';
import { now } from '../../core/db.js';
import { redact } from '../../core/secrets.js';
import type { PushMessage, SendResult } from './push.js';

/**
 * Apple Push Notification service for the native iOS companion (token-based auth, HTTP/2).
 * Needs the app maker's Apple key (never the user's): a .p8 key + key id + team id + bundle id, given via env:
 *   TEAMBOT_APNS_KEY_FILE, TEAMBOT_APNS_KEY_ID, TEAMBOT_APNS_TEAM_ID, TEAMBOT_APNS_TOPIC
 * Without them this stays off and the UI says so, without asking the user for anything. Not verified against Apple
 * from this repo.
 */
export class Apns {
  private key: crypto.KeyObject | null = null;
  private reason = '';
  private jwt: { token: string; at: number } | null = null;
  keyId = process.env.TEAMBOT_APNS_KEY_ID || '';
  teamId = process.env.TEAMBOT_APNS_TEAM_ID || '';
  topic = process.env.TEAMBOT_APNS_TOPIC || 'app.teambot.companion';
  /** Override for tests (h2c) — default chooses Apple's sandbox or production host per device. */
  host = process.env.TEAMBOT_APNS_HOST || '';

  constructor(private ctx: Ctx) {
    const file = process.env.TEAMBOT_APNS_KEY_FILE;
    if (!file || !this.keyId || !this.teamId) {
      // The key belongs with the app (whoever ships it), never with the user: say what is true and ask nothing.
      this.reason = 'nog niet actief. De sleutel van Apple hiervoor hoort bij de app, niet bij jou: je hoeft niets te doen.';
      return;
    }
    try {
      this.key = crypto.createPrivateKey(fs.readFileSync(file, 'utf8'));
    } catch {
      this.reason = 'APNs-sleutelbestand kon niet worden gelezen';
    }
  }

  /** For tests: configure in-process. */
  configure(o: { keyPem: string; keyId: string; teamId: string; topic?: string; host?: string }) {
    this.key = crypto.createPrivateKey(o.keyPem);
    this.keyId = o.keyId;
    this.teamId = o.teamId;
    if (o.topic) this.topic = o.topic;
    if (o.host !== undefined) this.host = o.host;
    this.jwt = null;
    this.reason = '';
  }

  configured() {
    return !!this.key;
  }
  status() {
    return { configured: this.configured(), detail: this.configured() ? `Actief voor ${this.topic}` : this.reason };
  }

  private bearer(): string {
    if (this.jwt && Date.now() - this.jwt.at < 30 * 60_000) return this.jwt.token;
    const enc = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const data = `${enc({ alg: 'ES256', kid: this.keyId })}.${enc({ iss: this.teamId, iat: Math.floor(Date.now() / 1000) })}`;
    const sig = crypto.sign('sha256', Buffer.from(data), { key: this.key!, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    this.jwt = { token: `${data}.${sig}`, at: Date.now() };
    return this.jwt.token;
  }

  setDeviceToken(sessionId: string, token: unknown, env: unknown) {
    const t = String(token || '').toLowerCase();
    if (!/^[0-9a-f]{32,200}$/.test(t)) throw new Error('Ongeldig APNs-token');
    this.ctx.store.exec('UPDATE mobile_devices SET apns_enc = ?, apns_env = ? WHERE session_id = ?', this.ctx.secrets.encrypt(t), env === 'production' ? 'production' : 'sandbox', sessionId);
  }

  targets(userId: string) {
    return this.ctx.store.all<any>(
      `SELECT d.session_id, d.name, d.apns_enc, d.apns_env FROM mobile_devices d JOIN sessions s ON s.id = d.session_id
       WHERE d.user_id = ? AND d.apns_enc IS NOT NULL AND s.revoked = 0 AND (s.expires_at IS NULL OR s.expires_at > ?)`,
      userId,
      now(),
    );
  }

  private post(origin: string, token: string, headers: Record<string, string>, body: string): Promise<{ status: number; reason: string }> {
    return new Promise((resolve) => {
      const client = http2.connect(origin);
      const done = (v: { status: number; reason: string }) => {
        client.close();
        resolve(v);
      };
      client.on('error', (e) => done({ status: 0, reason: String(e.message) }));
      const req = client.request({ ':method': 'POST', ':path': `/3/device/${token}`, ...headers });
      req.setTimeout(15_000, () => {
        req.close();
        done({ status: 0, reason: 'time-out' });
      });
      let status = 0;
      let data = '';
      req.on('response', (h) => (status = Number(h[':status']) || 0));
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        let reason = '';
        try {
          reason = JSON.parse(data || '{}').reason || '';
        } catch {
          /* ignore */
        }
        done({ status, reason });
      });
      req.on('error', (e) => done({ status: 0, reason: String(e.message) }));
      req.end(body);
    });
  }

  async sendToUser(userId: string, msg: PushMessage, opts: { urgency?: string; ttl?: number; sessionId?: string }): Promise<SendResult[]> {
    const out: SendResult[] = [];
    for (const d of this.targets(userId)) {
      if (opts.sessionId && d.session_id !== opts.sessionId) continue;
      const origin = this.host || (d.apns_env === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com');
      try {
        const token = this.ctx.secrets.decrypt(d.apns_enc);
        const r = await this.post(
          origin,
          token,
          {
            authorization: `bearer ${this.bearer()}`,
            'apns-topic': this.topic,
            'apns-push-type': 'alert',
            'apns-priority': opts.urgency === 'high' ? '10' : '5',
            'apns-expiration': String(Math.floor(Date.now() / 1000) + (opts.ttl ?? 3600)),
            'apns-collapse-id': msg.tag.slice(0, 64),
          },
          JSON.stringify({ aps: { alert: { title: msg.title, body: msg.body }, sound: 'default', 'thread-id': msg.tag.slice(0, 64) }, link: msg.link, kind: msg.kind }),
        );
        if (r.status === 200) out.push({ id: d.session_id, label: d.name, ok: true, status: 200, channel: 'apns' });
        else {
          if (r.status === 410 || r.reason === 'BadDeviceToken' || r.reason === 'Unregistered') this.ctx.store.exec('UPDATE mobile_devices SET apns_enc = NULL WHERE session_id = ?', d.session_id);
          out.push({ id: d.session_id, label: d.name, ok: false, status: r.status, error: `APNs: ${r.reason || 'HTTP ' + r.status}`, channel: 'apns' });
        }
      } catch (e: any) {
        out.push({ id: d.session_id, label: d.name, ok: false, error: redact(String(e?.message || e)).slice(0, 200), channel: 'apns' });
      }
    }
    return out;
  }
}
