import { sha256 as sha } from '../../core/util.js';
import type { Ctx, Run } from '../../core/types.js';
import type { TBEvent } from '../../core/events.js';
import { bad, str } from '../../core/http.js';
import { newId, now } from '../../core/db.js';
import { redact } from '../../core/secrets.js';
import { Limiter } from './limiter.js';
import { tr, trUserText, userLanguage } from '../../core/i18n.js';
import { assertPushEndpoint, b64u, encryptPayload, generateVapidKeys, vapidAuthorization, type VapidKeys } from './webpush.js';
import type { Apns } from './apns.js';
import { phoneGets, type Presence } from './presence.js';

const VAPID_SECRET = 'mobile:vapid';

export interface PushPrefs {
  /** Questions and approvals: always pushed (they block work). */
  approvals: boolean;
  /** notify_user and other notifications: only when you are not online. */
  agent: boolean;
  /** A task finished or failed: only when you are not online. */
  runDone: boolean;
  /** Show message content on the lock screen. */
  preview: boolean;
  /** Also to the phone while you sit at the pc (0.4.4, P8). Off: the phone only gets alerts when you are away. */
  alwaysPhone: boolean;
}
export const DEFAULT_PREFS: PushPrefs = { approvals: true, agent: true, runDone: true, preview: true, alwaysPhone: false };
/** An approval held back while you were at the pc is still pushed when you walk away within this time. */
const HOLD_MS = 30 * 60_000;

export interface PushMessage {
  title: string;
  body: string;
  link: string;
  tag: string;
  kind: string;
  /** No sound (the owner switched sounds off in Meldingen). */
  silent?: boolean;
}

export type Transport = (url: string, init: { method: string; headers: Record<string, string>; body: Buffer }) => Promise<{ status: number }>;

const defaultTransport: Transport = async (url, init) => {
  const r = await fetch(url, { method: init.method, headers: init.headers, body: new Uint8Array(init.body), redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  await r.arrayBuffer().catch(() => undefined);
  return { status: r.status };
};

/** Apple's push service (Safari, iPhone/iPad home-screen apps). */
export function isApplePush(endpoint: string): boolean {
  try {
    const h = new URL(endpoint).hostname.toLowerCase();
    return h === 'push.apple.com' || h.endsWith('.push.apple.com');
  } catch {
    return false;
  }
}

/** Only in-app hash routes may be opened from a notification (no open redirects). */
export function safeLink(link: unknown): string {
  const s = String(link || '');
  return /^#\/[\w\-/?=&.%:]*$/.test(s) && s.length < 300 ? s : '#/';
}

export interface SendResult {
  id: string;
  label: string;
  ok: boolean;
  status?: number;
  error?: string;
  channel: 'webpush' | 'apns';
}

export class PushService {
  transport: Transport = defaultTransport;
  private perUser = new Limiter(30, 60_000);
  private handledRuns = new Set<string>();
  /** Approvals and questions whose push went out, by id → user (PARITEIT 15.1, web): closed again once decided. */
  private pushedApprovals = new Map<string, string>();
  private keysCache: VapidKeys | null = null;
  /** Approvals not pushed because you were at the pc (per user): pushed after all when you go away and they still wait. */
  private held = new Map<string, { approvalId: string; msg: PushMessage; at: number }[]>();
  /** Where the owner is (desktop app reports); null = unknown, the old rule applies. */
  presence: Presence | null = null;

  constructor(private ctx: Ctx, private apns: Apns) {}

  // ---------- VAPID (server-wide, encrypted in ctx.secrets; the private key never leaves the server) ----------

  private keys(): VapidKeys {
    if (this.keysCache) return this.keysCache;
    const raw = this.ctx.secrets.getByName('', VAPID_SECRET);
    let k: VapidKeys | null = null;
    try {
      k = raw ? JSON.parse(raw) : null;
    } catch {
      k = null;
    }
    if (!k?.publicKey || !k?.privateKey) {
      k = generateVapidKeys();
      this.ctx.secrets.set('', VAPID_SECRET, JSON.stringify(k));
      this.ctx.log.info('[mobile] VAPID-sleutels aangemaakt voor pushmeldingen');
    }
    this.keysCache = k;
    return k;
  }
  publicKey(): string {
    return this.keys().publicKey;
  }
  subject(): string {
    if (process.env.TEAMBOT_VAPID_SUBJECT) return process.env.TEAMBOT_VAPID_SUBJECT;
    const email = this.ctx.auth.owner()?.email;
    if (email) return `mailto:${email}`;
    if (/^https:\/\//.test(this.ctx.config.publicUrl)) return this.ctx.config.publicUrl;
    return 'mailto:teambot@example.com';
  }

  // ---------- preferences ----------

  prefs(userId: string): PushPrefs {
    return { ...DEFAULT_PREFS, ...(this.ctx.store.getSetting<Partial<PushPrefs>>(userId, 'mobilePush', {}) || {}) };
  }
  setPrefs(userId: string, patch: any): PushPrefs {
    const cur = this.prefs(userId);
    for (const k of Object.keys(DEFAULT_PREFS) as (keyof PushPrefs)[]) if (typeof patch?.[k] === 'boolean') cur[k] = patch[k];
    this.ctx.store.setSetting(userId, 'mobilePush', cur);
    return cur;
  }

  // ---------- subscriptions (one per browser endpoint; owned by exactly one user + session) ----------

  subscribe(userId: string, sessionId: string, body: any) {
    const sub = body?.subscription || body;
    const endpoint = str(sub?.endpoint, 2000);
    try {
      assertPushEndpoint(endpoint);
    } catch (e: any) {
      throw bad(e.message);
    }
    const p256dh = str(sub?.keys?.p256dh, 200);
    const auth = str(sub?.keys?.auth, 100);
    const pk = b64u.dec(p256dh);
    if (pk.length !== 65 || pk[0] !== 4 || b64u.dec(auth).length !== 16) throw bad('Ongeldige pushsleutels');
    const dev = this.ctx.store.one<any>('SELECT name FROM mobile_devices WHERE session_id = ?', sessionId);
    const ses = this.ctx.store.one<any>('SELECT name, kind FROM sessions WHERE id = ?', sessionId);
    const label = str(body?.label, 80) || dev?.name || ses?.name || (ses?.kind === 'desktop' ? 'Deze computer' : 'Browser');
    const data_enc = this.ctx.secrets.encrypt(JSON.stringify({ endpoint, keys: { p256dh, auth } }));
    const hash = sha(endpoint);
    const existing = this.ctx.store.one<any>('SELECT id FROM mobile_push_subs WHERE endpoint_hash = ?', hash);
    if (existing) {
      // Same browser, possibly another account signed in now: it belongs to the latest subscriber only.
      this.ctx.store.exec('UPDATE mobile_push_subs SET user_id = ?, session_id = ?, data_enc = ?, label = ?, failures = 0, last_error = NULL WHERE id = ?', userId, sessionId, data_enc, label, existing.id);
      return { id: existing.id as string };
    }
    const id = newId('psh_');
    this.ctx.store.insert('mobile_push_subs', { id, user_id: userId, session_id: sessionId, endpoint_hash: hash, data_enc, label, created_at: now(), last_ok: null, last_error: null, failures: 0 });
    this.ctx.audit(userId, 'mobile.push.subscribed', { id, label });
    return { id };
  }

  unsubscribe(userId: string, sessionId: string, endpoint?: unknown) {
    if (endpoint) this.ctx.store.exec('DELETE FROM mobile_push_subs WHERE endpoint_hash = ? AND user_id = ?', sha(String(endpoint)), userId);
    else this.ctx.store.exec('DELETE FROM mobile_push_subs WHERE session_id = ? AND user_id = ?', sessionId, userId);
    return { ok: true };
  }

  list(userId: string, sessionId: string) {
    return this.ctx.store
      .all<any>('SELECT id, session_id, label, created_at, last_ok, last_error FROM mobile_push_subs WHERE user_id = ? ORDER BY created_at DESC', userId)
      .map((r) => ({ id: r.id, label: r.label, created_at: r.created_at, last_ok: r.last_ok, last_error: r.last_error, current: r.session_id === sessionId }));
  }

  // ---------- sending ----------

  private targets(userId: string, sessionId?: string) {
    const t = now();
    return this.ctx.store.all<any>(
      `SELECT p.* FROM mobile_push_subs p JOIN sessions s ON s.id = p.session_id
       WHERE p.user_id = ? AND s.user_id = p.user_id AND s.revoked = 0 AND (s.expires_at IS NULL OR s.expires_at > ?) ${sessionId ? 'AND p.session_id = ?' : ''}`,
      ...(sessionId ? [userId, t, sessionId] : [userId, t]),
    );
  }

  hasTargets(userId: string): boolean {
    return this.targets(userId).length > 0 || (this.apns.configured() && this.apns.targets(userId).length > 0);
  }

  async send(userId: string, msg: PushMessage, opts: { urgency?: 'high' | 'normal' | 'low'; ttl?: number; sessionId?: string; force?: boolean; closeOnly?: boolean } = {}): Promise<SendResult[]> {
    if (!opts.force && !this.perUser.hit(userId)) return [];
    const payload = Buffer.from(JSON.stringify({ ...msg, link: safeLink(msg.link), ts: now() }));
    const results: SendResult[] = [];
    const keys = this.keys();
    const subject = this.subject();
    for (const row of this.targets(userId, opts.sessionId)) {
      let endpoint = '';
      try {
        const sub = JSON.parse(this.ctx.secrets.decrypt(row.data_enc));
        endpoint = sub.endpoint;
        assertPushEndpoint(endpoint);
        // Apple revokes push for a site whose push shows nothing: there the app closes it when it is opened.
        if (opts.closeOnly && isApplePush(endpoint)) continue;
        const body = encryptPayload(payload, sub.keys.p256dh, sub.keys.auth);
        const r = await this.transport(endpoint, {
          method: 'POST',
          headers: {
            'content-encoding': 'aes128gcm',
            'content-type': 'application/octet-stream',
            ttl: String(opts.ttl ?? 3600),
            urgency: opts.urgency || 'normal',
            authorization: vapidAuthorization(endpoint, keys, subject),
          },
          body,
        });
        if (r.status >= 200 && r.status < 300) {
          this.ctx.store.exec('UPDATE mobile_push_subs SET last_ok = ?, failures = 0, last_error = NULL WHERE id = ?', now(), row.id);
          results.push({ id: row.id, label: row.label, ok: true, status: r.status, channel: 'webpush' });
        } else if (r.status === 404 || r.status === 410) {
          this.ctx.store.exec('DELETE FROM mobile_push_subs WHERE id = ?', row.id);
          results.push({ id: row.id, label: row.label, ok: false, status: r.status, error: 'Abonnement bestaat niet meer bij de pushdienst (verwijderd)', channel: 'webpush' });
        } else {
          const error = r.status === 403 || r.status === 400 ? `Pushdienst weigert (HTTP ${r.status}); controleer TEAMBOT_VAPID_SUBJECT` : `Pushdienst gaf HTTP ${r.status}`;
          this.ctx.store.exec('UPDATE mobile_push_subs SET last_error = ?, failures = failures + 1 WHERE id = ?', error, row.id);
          results.push({ id: row.id, label: row.label, ok: false, status: r.status, error, channel: 'webpush' });
        }
      } catch (e: any) {
        const error = redact(String(e?.message || e)).slice(0, 200);
        this.ctx.store.exec('UPDATE mobile_push_subs SET last_error = ?, failures = failures + 1 WHERE id = ?', error, row.id);
        results.push({ id: row.id, label: row.label, ok: false, error, channel: 'webpush' });
      }
    }
    if (this.apns.configured() && !opts.closeOnly) results.push(...(await this.apns.sendToUser(userId, { ...msg, link: safeLink(msg.link) }, opts)));
    return results;
  }

  // ---------- events → pushes ----------

  private online(userId: string): boolean {
    try {
      return !!this.ctx.services.onlineUsers?.()?.has(userId);
    } catch {
      return false;
    }
  }

  onEvent = (e: TBEvent) => {
    if (!e.userId || e.userId === '*') return;
    if (e.type === 'approval.updated') return this.onApprovalUpdated(e.userId, e.data);
    if (e.type !== 'notification' && e.type !== 'run.updated') return;
    if (!this.hasTargets(e.userId)) return;
    const job = e.type === 'notification' ? this.fromNotification(e.userId, e.data) : this.fromRun(e.userId, e.data);
    if (!job) return;
    if (job.msg.kind === 'approval' && typeof e.data?.approvalId === 'string') {
      if (this.pushedApprovals.size > 2000) this.pushedApprovals.clear();
      this.pushedApprovals.set(str(e.data.approvalId, 40), e.userId);
    }
    this.send(e.userId, job.msg, job.opts).catch((err) => this.ctx.log.warn('[mobile] push mislukt', redact(String(err?.message || err))));
  };

  /**
   * PARITEIT 15.1 (web): a pushed approval or question that is decided anywhere (another window, the desktop app, the
   * phone itself) gets a close push with the same tag, so the phone's or browser's notification goes away instead of
   * offering something that is already done. The service worker closes it and shows nothing; an older service worker
   * replaces it with a quiet "Al afgehandeld" (same tag). Not to Apple endpoints: see `send`.
   */
  private onApprovalUpdated(userId: string, a: any) {
    const id = typeof a?.id === 'string' ? str(a.id, 40) : '';
    if (!id || typeof a?.status !== 'string' || a.status === 'pending' || this.pushedApprovals.get(id) !== userId) return;
    this.pushedApprovals.delete(id);
    const msg: PushMessage = { title: 'TeamBot', body: tr(userLanguage(this.ctx.store, userId), 'Al afgehandeld'), link: '#/', tag: `apr-${id}`, kind: 'close', silent: true };
    this.send(userId, msg, { urgency: 'normal', ttl: 4 * 3600, force: true, closeOnly: true }).catch((err) => this.ctx.log.warn('[mobile] push mislukt', redact(String(err?.message || err))));
  }

  /** Where the owner is, for the phone: at the pc only the Windows notification (presence.ts). */
  private where(userId: string) {
    return this.presence?.where(userId) ?? 'unknown';
  }

  /** You walked away from the pc: approvals held back meanwhile go to the phone after all, if they still wait. */
  releaseHeld(userId: string) {
    const list = this.held.get(userId) || [];
    this.held.delete(userId);
    const cut = Date.now() - HOLD_MS;
    for (const h of list) {
      if (h.at < cut) continue;
      const apr = this.ctx.store.one<any>('SELECT status FROM approvals WHERE id = ? AND user_id = ?', h.approvalId, userId);
      if (apr?.status !== 'pending') continue;
      // Pushed after all: closed again once it is decided elsewhere, like any pushed approval.
      this.pushedApprovals.set(h.approvalId, userId);
      this.send(userId, h.msg, { urgency: 'high', ttl: 4 * 3600 }).catch((err) => this.ctx.log.warn('[mobile] push mislukt', redact(String(err?.message || err))));
    }
  }

  private fromNotification(userId: string, d: any) {
    const p = this.prefs(userId);
    const isApproval = d?.kind === 'approval';
    if (isApproval ? !p.approvals : !p.agent) return null;
    // Approvals/questions go out even when you are online elsewhere: they block the bot. The push only opens the app.
    // At the pc (desktop app reports input in the last 30 s, screen not locked) only Windows shows it, unless
    // "Altijd ook op de telefoon" is on; an approval held back that way goes out when you walk away.
    const where = this.where(userId);
    const toPhone = phoneGets({ where, alwaysPhone: p.alwaysPhone, approval: isApproval, online: this.online(userId) });
    if (!toPhone && !(isApproval && where === 'pc' && !p.alwaysPhone)) return null;
    // Meldingen: a bot set to "alleen belangrijk" or "niets" is not pushed either.
    const nt = this.ctx.services.notifications;
    if (nt && !nt.shouldAlert(userId, d)) return null;
    // The phone shows this as is: in the user's language (the app translates its own pages, not the lock screen).
    const lang = userLanguage(this.ctx.store, userId);
    const msg: PushMessage = {
      // Finished Dutch texts: translated, with the names of bots and people kept as they are.
      title: p.preview ? trUserText(this.ctx.store, userId, str(d?.title, 120)) || 'TeamBot' : 'TeamBot',
      body: p.preview ? trUserText(this.ctx.store, userId, str(d?.body, 240)) : isApproval ? tr(lang, 'Een bot wacht op je antwoord') : tr(lang, 'Je hebt een nieuwe melding'),
      link: safeLink(d?.link),
      tag: isApproval ? `apr-${str(d?.approvalId, 40)}` : `n-${safeLink(d?.link)}`,
      kind: isApproval ? 'approval' : str(d?.kind, 20) || 'agent',
      ...(nt && !nt.sound(userId) ? { silent: true } : {}),
    };
    if (!toPhone) {
      if (typeof d?.approvalId === 'string') {
        const list = (this.held.get(userId) || []).filter((h) => h.at >= Date.now() - HOLD_MS).slice(-49);
        list.push({ approvalId: d.approvalId, msg, at: Date.now() });
        this.held.set(userId, list);
      }
      return null;
    }
    return { msg, opts: { urgency: isApproval ? ('high' as const) : ('normal' as const), ttl: 4 * 3600 } };
  }

  private fromRun(userId: string, r: Run) {
    if (!r || (r.status !== 'done' && r.status !== 'error')) return null;
    // Paused important work (engine-chain): its own notification is pushed, not "er ging iets mis".
    if (r.meta?.paused) return null;
    const key = `${r.id}:${userId}`;
    if (this.handledRuns.has(key)) return null;
    this.handledRuns.add(key);
    if (this.handledRuns.size > 5000) this.handledRuns.clear();
    const p = this.prefs(userId);
    if (!p.runDone || !phoneGets({ where: this.where(userId), alwaysPhone: p.alwaysPhone, approval: false, online: this.online(userId) })) return null;
    const thread = this.ctx.store.thread(r.thread_id);
    if (!thread || thread.kind === 'delegation') return null;
    const nt = this.ctx.services.notifications;
    if (nt && !nt.shouldAlert(userId, { kind: 'run', agentId: r.agent_id, level: r.status === 'error' ? 'error' : undefined })) return null;
    const agent = this.ctx.store.agent(r.agent_id);
    const name = agent?.name || 'Bot';
    const last = this.ctx.store.one<any>("SELECT content FROM messages WHERE run_id = ? AND role = 'assistant' AND deleted = 0 ORDER BY seq DESC LIMIT 1", r.id);
    const lang = userLanguage(this.ctx.store, userId);
    const msg: PushMessage = {
      title: p.preview ? (r.status === 'done' ? tr(lang, '{0} is klaar', name) : r.meta?.budget?.cap ? tr(lang, '{0} heeft zijn eigen limiet bereikt', name) : r.meta?.budget ? tr(lang, '{0} heeft de daglimiet bereikt', name) : tr(lang, '{0}: er ging iets mis', name)) : 'TeamBot',
      body: p.preview
        ? (r.status === 'error' ? trUserText(this.ctx.store, userId, str(r.error, 160)) : str(last?.content, 160)) || (r.status === 'done' ? tr(lang, 'Taak afgerond') : tr(lang, 'Taak mislukt'))
        : r.status === 'done'
          ? tr(lang, 'Een taak is klaar')
          : tr(lang, 'Een taak is mislukt'),
      link: `#/t/${r.thread_id}`,
      tag: `run-${r.thread_id}`,
      kind: 'run',
      ...(nt && !nt.sound(userId) ? { silent: true } : {}),
    };
    return { msg, opts: { urgency: 'normal' as const, ttl: 3600 } };
  }

  cleanup() {
    this.ctx.store.exec(
      `DELETE FROM mobile_push_subs WHERE session_id NOT IN (SELECT id FROM sessions WHERE revoked = 0 AND (expires_at IS NULL OR expires_at > ?)) OR failures >= 20`,
      now(),
    );
  }
}
