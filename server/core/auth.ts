import { sha256 as sha } from './util.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response, NextFunction, Router } from 'express';
import type { Store } from './store.js';
import type { Config } from './config.js';
import type { User, Role } from './types.js';
import { newId, now } from './db.js';
import { ah, bad, HttpError, requireRole, user, str } from './http.js';

const token = () => crypto.randomBytes(32).toString('base64url');

function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
function verifyPassword(pw: string, stored: string | null): boolean {
  if (!stored) return false;
  const [alg, salt, key] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const k = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(k, Buffer.from(key, 'base64'));
}

/** Minimum length of a password someone chooses (0.4: 12, was 8; the lockouts below cover guessing). */
export const MIN_PASSWORD = 12;
/** Base words that guessing lists try first, also with digits or symbols around them ("Welkom2026!"). */
const WEAK_BASES = new Set(['password', 'passwort', 'wachtwoord', 'welkom', 'welcome', 'qwerty', 'azerty', 'letmein', 'admin', 'administrator', 'changeme', 'teambot', 'iloveyou', 'secret', 'geheim', 'abc', 'test']);
const RUNS = ['01234567890123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnm', 'azertyuiopqsdfghjklmwxcvbn', '1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p'];

/**
 * Why a new password is too weak, in plain words, or null when it is fine. Length first (minimum 12), then the
 * trivial cases: few different characters ("aaaaaaaaaaaa"), a keyboard or number run ("123456789012"), a word from the
 * top of every guessing list with only digits or symbols around it, or the e-mail address or name itself.
 */
export function passwordProblem(pw: unknown, who: { email?: string | null; name?: string | null } = {}): string | null {
  const p = typeof pw === 'string' ? pw : '';
  if (p.trim().length < MIN_PASSWORD) return 'Kies een wachtwoord van minstens 12 tekens. Een paar woorden achter elkaar is makkelijk te onthouden.';
  if (p.length > 1000) return 'Dit wachtwoord is te lang (maximaal 1000 tekens).';
  const low = p.toLowerCase();
  if (new Set(low).size < 4) return 'Dit wachtwoord is te makkelijk te raden: gebruik meer verschillende tekens.';
  if (RUNS.some((r) => r.includes(low) || [...r].reverse().join('').includes(low))) return 'Dit wachtwoord is een rij tekens van het toetsenbord of een reeks cijfers en is te makkelijk te raden.';
  const core = low.replace(/^[\d\W_]+|[\d\W_]+$/g, '');
  const email = String(who.email || '').trim().toLowerCase();
  const name = String(who.name || '').trim().toLowerCase();
  if (WEAK_BASES.has(core)) return 'Dit wachtwoord staat op de lijstjes die aanvallers als eerste proberen. Kies iets dat niet zo voor de hand ligt.';
  if ((email && (low === email || core === email.split('@')[0])) || (name && low.replace(/\s+/g, '') === name.replace(/\s+/g, ''))) return 'Gebruik niet je naam of e-mailadres als wachtwoord.';
  return null;
}

/**
 * A request from this computer itself: a direct loopback connection that no proxy forwarded (no X-Forwarded-*,
 * Forwarded or Via header) and that addresses TeamBot by a loopback name. Behind Tailscale Serve, a tunnel or a
 * reverse proxy on the same machine this is false, even though the connection comes from 127.0.0.1.
 */
export function isLocalRequest(req: Request): boolean {
  const a = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (!(a === '::1' || a.startsWith('127.'))) return false;
  const h = req.headers;
  if (h['x-forwarded-for'] || h['x-forwarded-host'] || h['x-forwarded-proto'] || h['x-real-ip'] || h.forwarded || h.via) return false;
  const host = String(h.host || '').toLowerCase().replace(/:\d+$/, '');
  return host === 'localhost' || host === '[::1]' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host) || host.endsWith('.localhost');
}

/** Readable one-time codes without ambiguous characters (0/O, 1/I/L). */
export function humanCode(len = 8): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export interface SessionInfo {
  id: string;
  user_id: string;
  kind: string;
  name: string;
}

/**
 * Per-request policy that runs after a token was resolved (e.g. the mobile
 * module's route allowlist for paired devices). Throw an HttpError to deny;
 * return true when the policy answered the request itself.
 */
export type AuthPolicy = (req: Request, res: Response, who: { user: User; session: SessionInfo }) => boolean | void;

/**
 * Check that runs before a password login or a password signup is accepted (e.g. a server that requires SSO).
 * `account` is the existing account for a login (null when the e-mail is unknown) or the role and e-mail a signup
 * would get. Throw an HttpError to refuse.
 */
export type PasswordPolicy = (account: { id: string | null; role: Role; email: string | null } | null, how: 'login' | 'signup') => void;

export class Auth {
  private loginAttempts = new Map<string, { n: number; until: number }>();
  /**
   * Failure counters on top of the per e-mail+address throttle (0.4): per address over all e-mails (password
   * spraying), per account over all addresses (a botnet on one account), and one global counter for pairing codes.
   */
  private failWindows = new Map<string, { n: number; reset: number; until: number }>();
  static readonly LOCKS = {
    account: { max: 10, windowMs: 15 * 60_000, lockMs: 15 * 60_000 },
    address: { max: 30, windowMs: 15 * 60_000, lockMs: 15 * 60_000 },
    pairing: { max: 30, windowMs: 5 * 60_000, lockMs: 5 * 60_000 },
  };
  /** Pairing codes made with POST /pairing are valid this long (seconds), and only once. */
  static readonly PAIR_CODE_TTL = 300;
  /**
   * One-time code that a fresh server (no owner yet, no TEAMBOT_SETUP_TOKEN) asks for when the owner account is made
   * from anything but this computer itself. app.ts prints it at startup (onSetupCode); cleared after the setup.
   */
  setupCode: string | null = null;
  onSetupCode?: (code: string) => void;
  /** Request policies, evaluated in order for every authenticated /api request. */
  readonly policies: AuthPolicy[] = [];
  /** Password login/signup policies, evaluated in order (see PasswordPolicy). */
  readonly passwordPolicies: PasswordPolicy[] = [];
  private revokeListeners = new Set<(sessionIds: string[]) => void>();

  constructor(private store: Store, private config: Config) {}

  userCount(): number {
    return this.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0;
  }

  owner(): User | null {
    const r = this.store.one<{ id: string }>("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1");
    return r ? this.store.user(r.id) : null;
  }

  /** Seat limit of this installation (TEAMBOT_MAX_USERS, set by the managed cloud per plan). 0 = unlimited. */
  maxUsers(): number {
    return Math.max(0, Math.floor(Number(process.env.TEAMBOT_MAX_USERS) || 0));
  }

  createUser(data: { email?: string | null; name: string; password?: string; role?: Role }): User {
    const max = this.maxUsers();
    if (max && data.role !== 'owner') {
      const active = this.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE disabled = 0')?.n ?? 0;
      if (active >= max) throw new HttpError(403, max === 1 ? 'Deze installatie heeft maximaal 1 gebruiker. Blokkeer of verwijder eerst iemand, of kies een groter abonnement.' : `Deze installatie heeft maximaal ${max} gebruikers. Blokkeer of verwijder eerst iemand, of kies een groter abonnement.`, 'seat_limit');
    }
    const email = data.email ? data.email.trim().toLowerCase() : null;
    if (email && this.store.one('SELECT id FROM users WHERE email = ?', email)) throw bad('Dit e-mailadres is al in gebruik');
    const u = {
      id: newId('usr_'),
      email,
      name: data.name.trim() || 'Gebruiker',
      password_hash: data.password ? hashPassword(data.password) : null,
      role: data.role || 'member',
      disabled: false,
      settings: {},
      created_at: now(),
    };
    this.store.insert('users', u);
    return this.store.user(u.id)!;
  }

  setPassword(userId: string, pw: string) {
    const u = this.store.user(userId);
    const problem = passwordProblem(pw, { email: u?.email, name: u?.name });
    if (problem) throw bad(problem);
    this.store.update('users', userId, { password_hash: hashPassword(pw) });
  }

  /** The setup code of a fresh server, made on first use (see setupCode). */
  ensureSetupCode(): string {
    if (!this.setupCode) {
      this.setupCode = 'tbsetup_' + crypto.randomBytes(18).toString('base64url');
      try {
        this.onSetupCode?.(this.setupCode);
      } catch {
        /* printing must not block the setup */
      }
    }
    return this.setupCode;
  }

  /** Revoke every live session of a user except one (after a password change); open WebSockets close at once. */
  revokeOtherSessions(userId: string, keepSessionId: string | null): number {
    const ids = this.store.all<{ id: string }>('SELECT id FROM sessions WHERE user_id = ? AND revoked = 0 AND id != ?', userId, keepSessionId || '').map((r) => r.id);
    for (const id of ids) this.store.exec('UPDATE sessions SET revoked = 1 WHERE id = ?', id);
    this.notifyRevoked(ids);
    return ids.length;
  }

  /** Remaining lock (ms) of a failure window, 0 when free. */
  private lockedFor(key: string): number {
    const w = this.failWindows.get(key);
    return w && w.until > Date.now() ? w.until - Date.now() : 0;
  }
  /** Count one failure; returns true when this failure started a lock. */
  private countFailure(key: string, lim: { max: number; windowMs: number; lockMs: number }): boolean {
    const t = Date.now();
    let w = this.failWindows.get(key);
    if (!w || (w.reset <= t && w.until <= t)) w = { n: 0, reset: t + lim.windowMs, until: 0 };
    w.n++;
    let locked = false;
    if (w.n >= lim.max && w.until <= t) {
      w.until = t + lim.lockMs;
      w.n = 0;
      w.reset = w.until;
      locked = true;
    }
    this.failWindows.set(key, w);
    if (this.failWindows.size > 20_000) for (const [k, v] of this.failWindows) if (v.reset <= t && v.until <= t) this.failWindows.delete(k);
    return locked;
  }
  private auditAuth(userId: string, kind: string, data: Record<string, unknown>) {
    try {
      this.store.insert('audit', { user_id: userId, agent_id: null, kind, data: JSON.stringify(data), created_at: now() });
    } catch {
      /* the audit table is part of the core schema; never block a login on it */
    }
  }

  createSession(userId: string, kind = 'web', name = '', ttlDays = 90): { token: string; id: string } {
    const t = token();
    const id = newId('ses_');
    const expires = ttlDays > 0 ? new Date(Date.now() + ttlDays * 864e5).toISOString() : null;
    this.store.insert('sessions', { id, token_hash: sha(t), user_id: userId, kind, name, created_at: now(), last_seen: now(), expires_at: expires, revoked: 0 });
    return { token: t, id };
  }

  /** Resolve a bearer token to its user + session. */
  resolve(tok: string | undefined | null): { user: User; session: SessionInfo } | null {
    if (!tok) return null;
    return this.sessionRow(this.store.one<any>('SELECT * FROM sessions WHERE token_hash = ?', sha(tok)));
  }

  // ---------- signed URLs ----------
  // Images, downloads, live streams and the WebSocket cannot send an Authorization header. Their URLs never carry the
  // session token: the app signs each path itself with a per-session URL key (HMAC-SHA256 over the exact path and
  // query, plus the session id and an expiry of at most SIGNED_MAX_TTL). A URL that ends up in the browser history, a
  // download list or a proxy log opens only that one file or stream, only with GET/HEAD and only for a short while, and
  // stops working as soon as the session is revoked.
  static readonly SIGNED_MAX_TTL = 3600;
  private urlSecretBuf: Buffer | null = null;
  private urlSecret(): Buffer {
    if (this.urlSecretBuf) return this.urlSecretBuf;
    const file = path.join(this.config.dataDir, 'url-signing.key');
    let b: Buffer | null = null;
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(raw)) b = Buffer.from(raw, 'hex');
    } catch {
      /* first start */
    }
    if (!b) {
      b = crypto.randomBytes(32);
      try {
        fs.writeFileSync(file, b.toString('hex'), { mode: 0o600 });
      } catch {
        /* read-only data dir: keys then last until the restart */
      }
    }
    return (this.urlSecretBuf = b);
  }

  /** The key a client uses to sign URLs for its own session (handed out only with the bearer token). */
  urlKey(sessionId: string): Buffer {
    return crypto.createHmac('sha256', this.urlSecret()).update('teambot-url-key:' + sessionId).digest();
  }

  /** Sign a path+query (server side, e.g. tests and links the server itself hands out). */
  signUrl(sessionId: string, pathAndQuery: string, ttlSec = 900): string {
    const exp = Math.floor(Date.now() / 1000) + Math.max(1, Math.min(Auth.SIGNED_MAX_TTL, ttlSec));
    const base = `${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}tbs=${encodeURIComponent(sessionId)}&tbe=${exp}`;
    return `${base}&tbsig=${crypto.createHmac('sha256', this.urlKey(sessionId)).update(base).digest('base64url')}`;
  }

  /**
   * Resolve a signed URL (`…&tbs=<session>&tbe=<expiry>&tbsig=<hmac>`, the signature last) for a GET/HEAD request.
   * `rawUrl` is the path and query exactly as requested. Returns null when it is not signed, altered, expired or
   * belongs to a revoked session.
   */
  resolveSigned(method: string | undefined, rawUrl: string | undefined): { user: User; session: SessionInfo } | null {
    if (!rawUrl || (method !== 'GET' && method !== 'HEAD')) return null;
    const i = rawUrl.lastIndexOf('&tbsig=');
    if (i < 0) return null;
    const base = rawUrl.slice(0, i);
    const sig = rawUrl.slice(i + 7);
    if (!/^[A-Za-z0-9_-]{43}$/.test(sig)) return null;
    let q: URLSearchParams;
    try {
      q = new URL(base, 'http://x').searchParams;
    } catch {
      return null;
    }
    const sid = q.get('tbs') || '';
    const exp = Number(q.get('tbe'));
    const nowSec = Date.now() / 1000;
    if (!/^ses_[A-Za-z0-9_-]{1,64}$/.test(sid) || !Number.isFinite(exp) || exp < nowSec || exp > nowSec + Auth.SIGNED_MAX_TTL + 60) return null;
    const want = crypto.createHmac('sha256', this.urlKey(sid)).update(base).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    return this.sessionRow(this.store.one<any>('SELECT * FROM sessions WHERE id = ?', sid));
  }

  private sessionRow(s: any): { user: User; session: SessionInfo } | null {
    if (!s || s.revoked) return null;
    if (s.expires_at && s.expires_at < now()) return null;
    const u = this.store.user(s.user_id);
    if (!u || u.disabled) return null;
    if (!s.last_seen || Date.now() - Date.parse(s.last_seen) > 60_000) this.store.exec('UPDATE sessions SET last_seen = ? WHERE id = ?', now(), s.id);
    return { user: u, session: { id: s.id, user_id: s.user_id, kind: s.kind, name: s.name } };
  }

  revokeSession(id: string) {
    this.store.exec('UPDATE sessions SET revoked = 1 WHERE id = ?', id);
    this.notifyRevoked([id]);
  }

  /** Revoke every session of a user (blocked/deactivated account); open WebSockets are closed right away. */
  revokeUserSessions(userId: string): number {
    const ids = this.store.all<{ id: string }>('SELECT id FROM sessions WHERE user_id = ? AND revoked = 0', userId).map((r) => r.id);
    this.store.exec('UPDATE sessions SET revoked = 1 WHERE user_id = ?', userId);
    this.notifyRevoked(ids);
    return ids.length;
  }

  /** Get told when sessions are revoked (e.g. to close their WebSockets right away). */
  onRevoke(fn: (sessionIds: string[]) => void): () => void {
    this.revokeListeners.add(fn);
    return () => this.revokeListeners.delete(fn);
  }
  private notifyRevoked(ids: string[]) {
    if (!ids.length) return;
    for (const l of this.revokeListeners) {
      try {
        l(ids);
      } catch {
        /* listener errors must not block revocation */
      }
    }
  }

  /** Bearer header or cookie. Never `?token=` in the URL: links use signed URLs (see resolveSigned). */
  tokenFromRequest(req: Request): string | null {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) return h.slice(7);
    const cookie = req.headers.cookie?.split(';').map((c) => c.trim()).find((c) => c.startsWith('tb_token='));
    return cookie ? decodeURIComponent(cookie.slice(9)) : null;
  }

  middleware = (req: Request, res: Response, next: NextFunction) => {
    const byToken = this.resolve(this.tokenFromRequest(req));
    const signed = byToken ? null : this.resolveSigned(req.method, req.originalUrl);
    const r = byToken || signed;
    if (!r) return next(new HttpError(401, 'Niet ingelogd'));
    (req as any).user = r.user;
    (req as any).session = r.session;
    (req as any).signedUrl = !!signed;
    try {
      for (const p of this.policies) if (p(req, res, r)) return;
    } catch (e) {
      return next(e);
    }
    next();
  };

  /**
   * Desktop mode: make sure an owner exists and expose a long-lived local token
   * in the data dir so the desktop shell can sign in without a password.
   */
  ensureLocalOwner(): string {
    let o = this.owner();
    if (!o) o = this.createUser({ name: 'Eigenaar', role: 'owner' });
    const file = path.join(this.config.dataDir, 'local-token');
    if (fs.existsSync(file)) {
      const t = fs.readFileSync(file, 'utf8').trim();
      if (this.resolve(t)) return t;
    }
    const { token: t } = this.createSession(o.id, 'desktop', 'Deze computer', 0);
    fs.writeFileSync(file, t, { mode: 0o600 });
    return t;
  }

  private throttle(key: string) {
    const a = this.loginAttempts.get(key);
    if (a && a.until > Date.now()) throw new HttpError(429, 'Te veel pogingen, probeer het over een minuut opnieuw');
  }
  private fail(key: string) {
    const a = this.loginAttempts.get(key) || { n: 0, until: 0 };
    a.n++;
    if (a.n >= 5) (a.until = Date.now() + 60_000), (a.n = 0);
    this.loginAttempts.set(key, a);
  }

  routes(publicApi: Router, api: Router) {
    publicApi.get(
      '/status',
      ah(async (req) => {
        const needsSetup = this.userCount() === 0;
        return {
          app: this.config.appName,
          version: this.config.version,
          mode: this.config.mode,
          needsSetup,
          allowSignup: this.config.allowSignup,
          // How a fresh server is claimed: 'link' = the one-time link of the managed cloud (TEAMBOT_SETUP_TOKEN),
          // 'console' = the code TeamBot printed at startup (any request that is not from this computer itself).
          setupCode: !needsSetup ? null : process.env.TEAMBOT_SETUP_TOKEN ? 'link' : this.config.mode === 'server' && !isLocalRequest(req) ? 'console' : null,
        };
      }),
    );

    publicApi.post(
      '/setup',
      ah(async (req) => {
        if (this.userCount() > 0) throw bad('Setup is al gedaan');
        const got = String(req.headers['x-teambot-setup-token'] || req.body?.setupToken || '');
        const same = (want: string) => {
          const a = crypto.createHash('sha256').update(got).digest();
          const b = crypto.createHash('sha256').update(want).digest();
          return !!got && crypto.timingSafeEqual(a, b);
        };
        // Managed cloud / unattended installs: the first owner can only be created with the setup token.
        const want = process.env.TEAMBOT_SETUP_TOKEN || '';
        if (want) {
          if (!same(want)) throw new HttpError(403, 'Deze installatie wordt ingericht via een eenmalige link. Gebruik de link uit je dashboard.', 'setup_token');
        } else if (this.config.mode === 'server' && !isLocalRequest(req)) {
          // A fresh server reachable through the network (or a proxy, tunnel or Tailscale): only whoever can see the
          // server's own output may claim it, never the first visitor.
          const throttleKey = 'setup|' + req.ip;
          this.throttle(throttleKey);
          if (!same(this.ensureSetupCode())) {
            this.fail(throttleKey);
            throw new HttpError(403, 'Deze server is via het netwerk bereikbaar. Vul de eenmalige code in die TeamBot bij het starten liet zien (in het venster van de server, of bij Docker met: docker compose logs teambot).', 'setup_code');
          }
        }
        const { name, email, password } = req.body || {};
        const problem = passwordProblem(password, { email, name });
        if (problem) throw bad(problem);
        const u = this.createUser({ name: str(name, 100) || 'Eigenaar', email: str(email, 200) || null, password, role: 'owner' });
        this.setupCode = null;
        const s = this.createSession(u.id, 'web', String(req.headers['user-agent'] || '').slice(0, 80));
        return { token: s.token, user: u };
      }),
    );

    publicApi.post(
      '/login',
      ah(async (req) => {
        const { email, password } = req.body || {};
        const mail = String(email || '').trim().toLowerCase();
        const key = mail + '|' + req.ip;
        this.throttle(key);
        const addrKey = 'ip|' + req.ip;
        const acctKey = 'acct|' + mail;
        if (this.lockedFor(addrKey)) throw new HttpError(429, 'Te veel mislukte inlogpogingen vanaf dit adres. Probeer het over een kwartier opnieuw.', 'rate_limited');
        if (this.lockedFor(acctKey)) throw new HttpError(429, 'Te veel mislukte inlogpogingen voor dit account. Probeer het over een kwartier opnieuw.', 'account_locked');
        const row = this.store.one<any>('SELECT * FROM users WHERE email = ?', mail);
        for (const p of this.passwordPolicies) p(row ? { id: row.id, role: row.role, email: row.email } : null, 'login');
        if (!row || row.disabled || !verifyPassword(String(password || ''), row.password_hash)) {
          this.fail(key);
          this.countFailure(addrKey, Auth.LOCKS.address);
          // Counted for unknown e-mails too, so a lock never tells whether an account exists.
          const locked = this.countFailure(acctKey, Auth.LOCKS.account);
          if (row) {
            this.auditAuth(row.id, 'auth.login.failed', { ip: req.ip || null });
            if (locked) this.auditAuth(row.id, 'auth.login.locked', { ip: req.ip || null, minutes: Auth.LOCKS.account.lockMs / 60_000 });
          }
          throw new HttpError(401, 'Onjuist e-mailadres of wachtwoord');
        }
        const s = this.createSession(row.id, 'web', String(req.headers['user-agent'] || '').slice(0, 80));
        return { token: s.token, user: this.store.user(row.id) };
      }),
    );

    publicApi.post(
      '/signup',
      ah(async (req) => {
        const { name, email, password, invite } = req.body || {};
        let role: Role = 'member';
        let inviteCode: string | null = null;
        if (invite) {
          const inv = this.store.one<any>('SELECT * FROM invites WHERE code = ?', String(invite).trim().toUpperCase());
          if (!inv || inv.uses_left <= 0 || (inv.expires_at && inv.expires_at < now())) throw bad('Uitnodiging ongeldig of verlopen');
          inviteCode = inv.code;
          role = inv.role === 'admin' ? 'admin' : 'member';
        } else if (!this.config.allowSignup) throw bad('Je hebt een uitnodigingscode nodig');
        for (const p of this.passwordPolicies) p({ id: null, role, email: str(email, 200).trim().toLowerCase() || null }, 'signup');
        if (!email || !password) throw bad('E-mail en wachtwoord zijn verplicht');
        const problem = passwordProblem(password, { email, name });
        if (problem) throw bad(problem);
        const u = this.createUser({ name: str(name, 100) || String(email).split('@')[0], email: str(email, 200), password, role });
        // Use up the invite only once the account exists (a refused signup keeps the invite usable).
        if (inviteCode) this.store.exec('UPDATE invites SET uses_left = uses_left - 1 WHERE code = ? AND uses_left > 0', inviteCode);
        const s = this.createSession(u.id, 'web', String(req.headers['user-agent'] || '').slice(0, 80));
        return { token: s.token, user: u };
      }),
    );

    // Device pairing: phone scans QR with a short-lived code, gets its own revocable token.
    publicApi.post(
      '/pair',
      ah(async (req) => {
        const code = String(req.body?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
        const key = 'pair|' + req.ip;
        this.throttle(key);
        // Codes are short (about 40 bits): besides 5 per address per minute, at most 30 wrong codes per 5 minutes in
        // total, from all addresses together; after that only the QR code pairs.
        if (this.lockedFor('pair|*')) throw new HttpError(429, 'Koppelen met een code is even geblokkeerd na te veel foute pogingen. Scan de QR-code of probeer het over een paar minuten opnieuw.', 'rate_limited');
        const pc = code ? this.store.one<any>('SELECT * FROM pair_codes WHERE code = ?', code) : null;
        // Consume atomically: two requests with the same code can never both pair a device.
        const used = pc && !pc.used && pc.expires_at >= now() ? this.store.exec('UPDATE pair_codes SET used = 1 WHERE code = ? AND used = 0', code) : null;
        if (!pc || !used || Number(used.changes) !== 1) {
          this.fail(key);
          this.countFailure('pair|*', Auth.LOCKS.pairing);
          throw bad('Koppelcode ongeldig of verlopen');
        }
        const name = str(req.body?.deviceName, 80) || 'Telefoon';
        const s = this.createSession(pc.user_id, 'device', name, 365);
        return { token: s.token, user: this.store.user(pc.user_id) };
      }),
    );

    api.get('/me', ah(async (req) => ({ user: user(req), session: (req as any).session, mode: this.config.mode })));

    /** The URL key of this session, for signing image/download/stream links in the app. Only with the real token. */
    api.get(
      '/auth/url-key',
      ah(async (req, res) => {
        if ((req as any).signedUrl) throw new HttpError(403, 'Alleen met je eigen sessie');
        res.setHeader('Cache-Control', 'no-store');
        const sid = (req as any).session.id as string;
        return { sid, key: this.urlKey(sid).toString('base64url'), now: Date.now(), maxTtl: Auth.SIGNED_MAX_TTL };
      }),
    );

    api.patch(
      '/me',
      ah(async (req) => {
        const u = user(req);
        const { name, email, password, settings, currentPassword } = req.body || {};
        const patch: any = {};
        if (name !== undefined) patch.name = str(name, 100);
        if (email !== undefined) patch.email = str(email, 200).toLowerCase() || null;
        if (settings && typeof settings === 'object') patch.settings = { ...u.settings, ...settings };
        // A stolen session must not be enough to take the account over: changing the password or the e-mail address
        // (the login name) of an account that has a password needs that password again.
        const hash = this.store.one<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = ?', u.id)?.password_hash || null;
        const emailChanges = patch.email !== undefined && patch.email !== (u.email || null);
        if (hash && (password || emailChanges)) {
          const key = 'reauth|' + u.id;
          this.throttle(key);
          if (!verifyPassword(String(currentPassword || ''), hash)) {
            this.fail(key);
            throw new HttpError(403, 'Vul je huidige wachtwoord in om je wachtwoord of e-mailadres te wijzigen.', 'current_password');
          }
        }
        if (password) {
          const problem = passwordProblem(password, { email: patch.email ?? u.email, name: patch.name ?? u.name });
          if (problem) throw bad(problem);
        }
        this.store.update('users', u.id, patch);
        if (password) {
          this.setPassword(u.id, String(password));
          // A changed password signs out every other browser and phone (whoever knew the old one loses access).
          if (hash) {
            const n = this.revokeOtherSessions(u.id, (req as any).session?.id || null);
            this.auditAuth(u.id, 'auth.password.changed', { otherSessionsSignedOut: n });
          }
        }
        return { user: this.store.user(u.id) };
      }),
    );

    api.post(
      '/auth/logout',
      ah(async (req) => {
        this.revokeSession((req as any).session.id);
        return { ok: true };
      }),
    );

    api.get(
      '/sessions',
      ah(async (req) => {
        const u = user(req);
        return this.store.all('SELECT id, kind, name, created_at, last_seen, expires_at FROM sessions WHERE user_id = ? AND revoked = 0 ORDER BY last_seen DESC', u.id);
      }),
    );
    api.delete(
      '/sessions/:id',
      ah(async (req) => {
        const u = user(req);
        const s = this.store.one<{ id: string }>('SELECT id FROM sessions WHERE id = ? AND user_id = ?', req.params.id, u.id);
        if (s) this.revokeSession(s.id);
        return { ok: true };
      }),
    );

    api.post(
      '/pairing',
      ah(async (req) => {
        const u = user(req);
        const code = humanCode(8);
        const expires = new Date(Date.now() + Auth.PAIR_CODE_TTL * 1000).toISOString();
        this.store.insert('pair_codes', { code, user_id: u.id, expires_at: expires, used: 0, created_at: now() });
        return { code, expires_at: expires };
      }),
    );

    // ---- admin: users & invites ----
    api.get(
      '/admin/users',
      ah(async (req) => {
        requireRole(req, 'admin');
        return this.store.users();
      }),
    );
    api.patch(
      '/admin/users/:id',
      ah(async (req) => {
        const me = requireRole(req, 'admin');
        const target = this.store.user(req.params.id as string);
        if (!target) throw bad('Onbekende gebruiker');
        if (target.role === 'owner' && me.role !== 'owner') throw bad('Alleen de eigenaar kan dit');
        const { role, disabled, password } = req.body || {};
        const patch: any = {};
        if (role && ['admin', 'member'].includes(role) && target.role !== 'owner') patch.role = role;
        if (disabled !== undefined && target.role !== 'owner') patch.disabled = !!disabled;
        if (password) {
          const problem = passwordProblem(password, { email: target.email, name: target.name });
          if (problem) throw bad(problem);
        }
        this.store.update('users', target.id, patch);
        if (password) {
          this.setPassword(target.id, String(password));
          // A password set by an admin signs the account out everywhere.
          if (!patch.disabled) this.revokeOtherSessions(target.id, target.id === me.id ? (req as any).session?.id || null : null);
          this.auditAuth(target.id, 'auth.password.reset', { by: me.id });
        }
        if (patch.disabled) this.revokeUserSessions(target.id);
        return this.store.user(target.id);
      }),
    );
    api.get(
      '/admin/invites',
      ah(async (req) => {
        requireRole(req, 'admin');
        return this.store.all('SELECT * FROM invites ORDER BY created_at DESC');
      }),
    );
    api.post(
      '/admin/invites',
      ah(async (req) => {
        const me = requireRole(req, 'admin');
        const code = humanCode(10);
        const uses = Math.max(1, Math.min(100, Number(req.body?.uses || 1)));
        const days = Math.max(1, Math.min(365, Number(req.body?.days || 14)));
        const role = req.body?.role === 'admin' && me.role === 'owner' ? 'admin' : 'member';
        this.store.insert('invites', { code, created_by: me.id, role, uses_left: uses, note: str(req.body?.note, 200), expires_at: new Date(Date.now() + days * 864e5).toISOString(), created_at: now() });
        return this.store.one('SELECT * FROM invites WHERE code = ?', code);
      }),
    );
    api.delete(
      '/admin/invites/:code',
      ah(async (req) => {
        requireRole(req, 'admin');
        this.store.exec('DELETE FROM invites WHERE code = ?', req.params.code);
        return { ok: true };
      }),
    );
  }
}
