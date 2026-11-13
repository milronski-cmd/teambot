import { sha256 as sha } from '../../core/util.js';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import type { Ctx, User } from '../../core/types.js';
import { humanCode, type SessionInfo } from '../../core/auth.js';
import { HttpError, bad, notFound, str } from '../../core/http.js';
import { now } from '../../core/db.js';
import { Limiter } from '../../core/util.js';

export const TICKET_TTL_SEC = 300;
/** `baseUrl` for a QR code that only works through the TeamBot connection (iroh). */
export const IROH_BASE = 'iroh';
/** The pairing link in such a QR code (opens the iPhone app). */
export const IROH_PAIR_URL = 'teambot://pair';

export type Platform = 'ios' | 'android' | 'other';
export type Client = 'pwa' | 'browser' | 'ios-app';

export function platformFromUA(ua: string): Platform {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}
function defaultName(p: Platform) {
  return p === 'ios' ? 'iPhone' : p === 'android' ? 'Android-telefoon' : 'Telefoon';
}

/**
 * A device name that is not in the list yet: "iPhone", then "iPhone 2", "iPhone 3", … (the pairing page fills in the
 * same default for every phone, so two phones — or a new one next to a revoked one — were both called "Telefoon").
 */
export function uniqueDeviceName(name: string, taken: string[]): string {
  const want = name.trim().slice(0, 60) || 'Telefoon';
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  if (!used.has(want.toLowerCase())) return want;
  const root = want.replace(/\s+\d{1,3}$/, '').slice(0, 55) || 'Telefoon';
  for (let n = 2; n < 1000; n++) {
    const c = `${root} ${n}`;
    if (!used.has(c.toLowerCase())) return c;
  }
  return want;
}

/** Only the origin of a server: http(s)://host[:port], no path/credentials. */
export function normalizeBaseUrl(raw: unknown): string {
  let u: URL;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw bad('Ongeldig adres. Voorbeeld: http://192.168.1.20:4748');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw bad('Het adres moet met http:// of https:// beginnen');
  if (u.username || u.password) throw bad('Zet geen gebruikersnaam of wachtwoord in het adres');
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) throw bad('Gebruik alleen het adres van de server, zonder pad');
  return u.origin;
}

export function normalizeCode(raw: unknown): string {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
}
export const formatCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;

export interface DeviceView {
  id: string;
  name: string;
  platform: Platform | 'other';
  client: string;
  created_at: string;
  last_seen: string | null;
  status: 'active' | 'revoked';
  revoked_at: string | null;
  push: boolean;
  apns: boolean;
  current: boolean;
}

/**
 * One-time pairing tickets and the device list.
 *  - QR: 256-bit secret in the URL fragment (never sent in a GET, not logged), valid 5 minutes, one use.
 *  - Code: 8 characters for typing (shell login tab "Koppelen" via core /api/public/pair, or our pairing page).
 *    The code is mirrored in the core `pair_codes` table; whichever path redeems first consumes both,
 *    so one ticket can never pair two devices.
 *  - A device is a session of kind "device" (own revocable token) plus metadata in `mobile_devices`.
 */
export class Pairing {
  attempts = new Limiter(20, 5 * 60_000);
  fails = new Limiter(5, 5 * 60_000);
  globalCodeFails = new Limiter(30, 5 * 60_000);
  creates = new Limiter(15, 10 * 60_000);
  private known = new Set<string>();

  /** `irohLink`: the TeamBot connection of this computer (iroh.ts) when it is on; its key goes into every QR code. */
  constructor(
    private ctx: Ctx,
    private enabled: () => boolean,
    private irohLink: () => { id: string; relay: string | null } | null = () => null,
  ) {}

  async createTicket(user: User, baseUrl: unknown) {
    if (!this.enabled()) throw new HttpError(503, 'Koppelen is uitgeschakeld: de beveiligingslaag voor telefoons is niet actief');
    // 'iroh': only through the TeamBot connection (no wifi or Tailscale address needed). The QR code then holds a
    // teambot:// link that only the iPhone app opens.
    const link = this.irohLink();
    const viaIroh = baseUrl === IROH_BASE;
    if (viaIroh && !link) throw bad('De TeamBot-verbinding staat niet aan. Zet hem aan onder Bereikbaarheid.');
    const base = viaIroh ? IROH_PAIR_URL : normalizeBaseUrl(baseUrl);
    if (!this.creates.hit(user.id)) throw new HttpError(429, 'Te veel koppelcodes aangevraagd. Probeer het over een paar minuten opnieuw.');
    const { store } = this.ctx;
    this.cleanup();
    // Only one open ticket per user: a new QR makes the previous one useless.
    for (const old of store.all<{ id: string; code: string }>('SELECT id, code FROM mobile_pair_tickets WHERE user_id = ? AND used_at IS NULL AND cancelled = 0', user.id)) {
      store.exec('UPDATE pair_codes SET used = 1 WHERE code = ?', old.code);
      store.exec('UPDATE mobile_pair_tickets SET cancelled = 1 WHERE id = ?', old.id);
    }
    const secret = crypto.randomBytes(32).toString('base64url');
    let code = humanCode(8);
    while (store.one('SELECT code FROM pair_codes WHERE code = ?', code)) code = humanCode(8);
    const id = 'pt_' + crypto.randomBytes(9).toString('base64url');
    const created = now();
    const expires = new Date(Date.now() + TICKET_TTL_SEC * 1000).toISOString();
    store.tx(() => {
      store.insert('pair_codes', { code, user_id: user.id, expires_at: expires, used: 0, created_at: created });
      store.insert('mobile_pair_tickets', { id, user_id: user.id, secret_hash: sha(secret), code, base_url: base, expires_at: expires, used_at: null, cancelled: 0, session_id: null, created_at: created });
    });
    // Extra keys in the fragment: n = the computer's iroh key (the phone pins it), r = an own relay. Older apps and the
    // pairing page only read t.
    const extra = link ? `&n=${link.id}${link.relay ? `&r=${encodeURIComponent(link.relay)}` : ''}` : '';
    const url = viaIroh ? `${IROH_PAIR_URL}#t=${secret}${extra}` : `${base}/api/public/mobile/pair#t=${secret}${extra}`;
    const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#000000', light: '#ffffff' } });
    this.ctx.audit(user.id, 'mobile.pair.created', { ticket: id, base });
    return {
      id,
      url,
      code: formatCode(code),
      qr: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'),
      base_url: base,
      expires_at: expires,
      ttl: TICKET_TTL_SEC,
      shellLink: viaIroh ? null : `${base}/#/?pair=${code}`,
      /** How the phone can reach this computer with this code: only the TeamBot connection, the address, or both. */
      via: viaIroh ? 'iroh' : link ? 'both' : 'address',
    };
  }

  ticketStatus(userId: string, id: string) {
    const t = this.ctx.store.one<any>('SELECT * FROM mobile_pair_tickets WHERE id = ? AND user_id = ?', id, userId);
    if (!t) throw notFound('Koppelcode niet gevonden');
    const pc = this.ctx.store.one<any>('SELECT used FROM pair_codes WHERE code = ?', t.code);
    if (t.used_at || (pc?.used && !t.cancelled)) {
      const dev = t.session_id ? this.devices(userId, '').find((d) => d.id === t.session_id) : null;
      return { status: 'used', device: dev || null };
    }
    if (t.cancelled) return { status: 'cancelled' };
    if (t.expires_at <= now()) return { status: 'expired' };
    return { status: 'waiting', expires_at: t.expires_at };
  }

  cancel(userId: string, id: string) {
    const t = this.ctx.store.one<any>('SELECT * FROM mobile_pair_tickets WHERE id = ? AND user_id = ?', id, userId);
    if (!t) return;
    this.ctx.store.exec('UPDATE mobile_pair_tickets SET cancelled = 1 WHERE id = ? AND used_at IS NULL', id);
    this.ctx.store.exec('UPDATE pair_codes SET used = 1 WHERE code = ?', t.code);
  }

  /** Redeem a ticket (public route). Same error for unknown/used/expired: no oracle. */
  claim(body: any, ip: string, ua: string) {
    const { store, auth } = this.ctx;
    if (!this.enabled()) throw new HttpError(503, 'Koppelen is uitgeschakeld');
    const secret = typeof body?.secret === 'string' ? body.secret.trim().slice(0, 100) : '';
    const code = secret ? '' : normalizeCode(body?.code);
    if (!secret && !code) throw bad('Koppelcode ontbreekt');
    const tooMany = () => new HttpError(429, 'Te veel koppelpogingen. Wacht een paar minuten en probeer het opnieuw.', 'rate_limited');
    if (this.fails.blocked(ip) || !this.attempts.hit(ip)) throw tooMany();
    if (code && this.globalCodeFails.blocked('code')) throw new HttpError(429, 'Koppelen met een code is even geblokkeerd na te veel foute pogingen. Scan de QR-code of probeer het later opnieuw.', 'rate_limited');
    const fail = () => {
      this.fails.hit(ip);
      if (code) this.globalCodeFails.hit('code');
      return bad('Koppelcode ongeldig, al gebruikt of verlopen. Vraag op je computer een nieuwe code aan.');
    };
    const t = now();
    const row = secret
      ? store.one<any>('SELECT * FROM mobile_pair_tickets WHERE secret_hash = ?', sha(secret))
      : store.one<any>('SELECT * FROM mobile_pair_tickets WHERE code = ? ORDER BY created_at DESC LIMIT 1', code);
    if (!row || row.used_at || row.cancelled || row.expires_at <= t) throw fail();
    const u = store.user(row.user_id);
    if (!u || u.disabled) throw fail();
    const platform: Platform = ['ios', 'android', 'other'].includes(body?.platform) ? body.platform : platformFromUA(ua);
    const client: Client = ['pwa', 'browser', 'ios-app'].includes(body?.client) ? body.client : 'browser';
    const name = uniqueDeviceName(
      str(body?.name, 60).trim() || defaultName(platform),
      this.devices(u.id, '').map((d) => d.name),
    );
    const out = store.tx(() => {
      // Consume both representations atomically; if the code was already redeemed via core /api/public/pair, stop.
      const a = store.exec('UPDATE pair_codes SET used = 1 WHERE code = ? AND used = 0', row.code);
      const b = store.exec('UPDATE mobile_pair_tickets SET used_at = ? WHERE id = ? AND used_at IS NULL AND cancelled = 0', t, row.id);
      if (Number(a.changes) !== 1 || Number(b.changes) !== 1) return null;
      const s = auth.createSession(u.id, 'device', name, 365);
      store.insert('mobile_devices', { session_id: s.id, user_id: u.id, name, platform, client, user_agent: str(ua, 200), created_at: t, revoked_at: null });
      store.exec('UPDATE mobile_pair_tickets SET session_id = ? WHERE id = ?', s.id, row.id);
      return s;
    });
    if (!out) throw fail();
    this.known.add(out.id);
    this.ctx.audit(u.id, 'mobile.device.paired', { device: out.id, name, platform, client, via: secret ? 'qr' : 'code' });
    const device = this.devices(u.id, out.id).find((d) => d.id === out.id)!;
    this.ctx.events.emit(u.id, 'mobile.paired', { ticket: row.id, device: { ...device, current: false } });
    this.ctx.events.emit(u.id, 'mobile.devices.updated', {});
    return { token: out.token, device: { id: device.id, name: device.name, platform: device.platform }, user: { id: u.id, name: u.name } };
  }

  /**
   * Called for every request of a device session. Devices paired through the core
   * code route get their metadata row on first use, and the open ticket learns its device.
   */
  seen(session: SessionInfo, ua: string) {
    if (this.known.has(session.id)) return;
    const { store } = this.ctx;
    if (!store.one('SELECT session_id FROM mobile_devices WHERE session_id = ?', session.id)) {
      const platform = platformFromUA(ua);
      // Paired through the core code route: the name it got ("Telefoon" by default) may already be taken.
      const taken = this.devices(session.user_id, '').filter((d) => d.id !== session.id).map((d) => d.name);
      const name = uniqueDeviceName(session.name && session.name !== 'Telefoon' ? session.name : defaultName(platform), taken);
      store.insert('mobile_devices', { session_id: session.id, user_id: session.user_id, name, platform, client: 'browser', user_agent: str(ua, 200), created_at: now(), revoked_at: null });
      if (name !== session.name) store.exec('UPDATE sessions SET name = ? WHERE id = ?', name, session.id);
      const ses = store.one<any>('SELECT created_at FROM sessions WHERE id = ?', session.id);
      const t = store.one<any>(
        `SELECT t.id FROM mobile_pair_tickets t JOIN pair_codes p ON p.code = t.code
         WHERE t.user_id = ? AND t.used_at IS NULL AND t.cancelled = 0 AND p.used = 1 AND t.created_at <= ? ORDER BY t.created_at DESC LIMIT 1`,
        session.user_id,
        ses?.created_at || now(),
      );
      if (t) {
        store.exec('UPDATE mobile_pair_tickets SET used_at = ?, session_id = ? WHERE id = ?', now(), session.id, t.id);
        this.ctx.audit(session.user_id, 'mobile.device.paired', { device: session.id, name: session.name, platform, client: 'browser', via: 'code' });
        const device = this.devices(session.user_id, '').find((d) => d.id === session.id);
        this.ctx.events.emit(session.user_id, 'mobile.paired', { ticket: t.id, device });
      }
      this.ctx.events.emit(session.user_id, 'mobile.devices.updated', {});
    }
    this.known.add(session.id);
  }

  devices(userId: string, currentSessionId: string): DeviceView[] {
    const t = now();
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    return this.ctx.store
      .all<any>(
        `SELECT s.id, s.name AS sname, s.created_at, s.last_seen, s.expires_at, s.revoked,
                d.name, d.platform, d.client, d.revoked_at, d.apns_enc IS NOT NULL AS apns,
                (SELECT COUNT(*) FROM mobile_push_subs p WHERE p.session_id = s.id) AS push
         FROM sessions s LEFT JOIN mobile_devices d ON d.session_id = s.id
         WHERE s.user_id = ? AND s.kind = 'device'
           AND ((s.revoked = 0 AND (s.expires_at IS NULL OR s.expires_at > ?)) OR (d.revoked_at IS NOT NULL AND d.revoked_at > ?))
         ORDER BY s.revoked, COALESCE(s.last_seen, s.created_at) DESC`,
        userId,
        t,
        since,
      )
      .map((r) => ({
        id: r.id,
        name: r.name || r.sname || 'Telefoon',
        platform: r.platform || 'other',
        client: r.client || 'browser',
        created_at: r.created_at,
        last_seen: r.last_seen,
        status: r.revoked ? 'revoked' : 'active',
        revoked_at: r.revoked_at || null,
        push: Number(r.push) > 0,
        apns: !!r.apns,
        current: r.id === currentSessionId,
      }));
  }

  revoke(userId: string, sessionId: string) {
    const s = this.ctx.store.one<any>('SELECT id, kind, revoked FROM sessions WHERE id = ? AND user_id = ?', sessionId, userId);
    if (!s || s.kind !== 'device') throw notFound('Apparaat niet gevonden');
    if (!s.revoked) this.ctx.auth.revokeSession(s.id); // → onRevoke: WebSockets closed, push subscriptions removed
    this.ctx.audit(userId, 'mobile.device.revoked', { device: s.id });
    this.ctx.events.emit(userId, 'mobile.devices.updated', {});
    return { ok: true };
  }

  rename(userId: string, sessionId: string, name: unknown) {
    const n = str(name, 60).trim();
    if (!n) throw bad('Naam is leeg');
    const s = this.ctx.store.one<any>("SELECT id FROM sessions WHERE id = ? AND user_id = ? AND kind = 'device'", sessionId, userId);
    if (!s) throw notFound('Apparaat niet gevonden');
    this.ctx.store.exec('UPDATE sessions SET name = ? WHERE id = ?', n, s.id);
    this.ctx.store.exec('UPDATE mobile_devices SET name = ? WHERE session_id = ?', n, s.id);
    this.ctx.events.emit(userId, 'mobile.devices.updated', {});
    return { ok: true };
  }

  /** Bookkeeping when sessions get revoked anywhere (device revoke, logout, admin disable). */
  onRevoked(ids: string[]) {
    const t = now();
    for (const id of ids) {
      this.ctx.store.exec('UPDATE mobile_devices SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL', t, id);
      this.ctx.store.exec('DELETE FROM mobile_push_subs WHERE session_id = ?', id);
      this.known.delete(id);
    }
  }

  cleanup() {
    const old = new Date(Date.now() - 864e5).toISOString();
    this.ctx.store.exec('DELETE FROM mobile_pair_tickets WHERE created_at < ?', old);
  }
}
