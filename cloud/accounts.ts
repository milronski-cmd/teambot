import type { Db } from './db.js';
import { one } from './db.js';
import type { CloudConfig } from './config.js';
import { audit } from './audit.js';
import { hashPassword, newId, randomToken, sha256, verifyPassword } from './crypto.js';
import { addDays, type Clock, type Log } from './util.js';

export interface Account {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'operator';
  email_verified: boolean;
  stripe_customer_id: string | null;
  created_at: Date;
}

export interface Session {
  id: string;
  account_id: string;
  csrf_token: string;
  expires_at: Date;
}

/** Dutch, user-facing error (validation, limits). */
export class UserError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,}$/i;
const SESSION_DAYS = 30;
const PUBLIC_COLS = 'id, email, name, role, email_verified, stripe_customer_id, created_at';

export class Accounts {
  constructor(private d: { db: Db; cfg: CloudConfig; clock: Clock; log: Log }) {}

  async get(id: string): Promise<Account | null> {
    return one<Account>(this.d.db, `SELECT ${PUBLIC_COLS} FROM accounts WHERE id = $1`, [id]);
  }

  async byEmail(email: string): Promise<Account | null> {
    return one<Account>(this.d.db, `SELECT ${PUBLIC_COLS} FROM accounts WHERE email = $1`, [email.trim().toLowerCase()]);
  }

  async signup(input: { email: string; name?: string; password: string }, ip: string): Promise<{ account: Account; verifyToken: string | null }> {
    const email = String(input.email || '').trim().toLowerCase();
    const name = String(input.name || '').trim().slice(0, 80);
    const password = String(input.password || '');
    if (!EMAIL_RE.test(email) || email.length > 254) throw new UserError('Vul een geldig e-mailadres in.');
    if (password.length < 10) throw new UserError('Kies een wachtwoord van minstens 10 tekens.');
    if (password.length > 200) throw new UserError('Dat wachtwoord is te lang.');
    if (await this.byEmail(email)) throw new UserError('Er bestaat al een account met dit e-mailadres. Log in.', 409);
    const now = this.d.clock.now();
    const id = newId('acc_');
    const verifyToken = this.d.cfg.smtpUrl ? randomToken() : null;
    try {
      await this.d.db.query(
        `INSERT INTO accounts (id, email, name, password_hash, role, email_verified, verify_token_hash, verify_expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'user', FALSE, $5, $6, $7, $7)`,
        [id, email, name, await hashPassword(password), verifyToken ? sha256(verifyToken) : null, verifyToken ? addDays(now, 2).toISOString() : null, now.toISOString()],
      );
    } catch (e: any) {
      if (e?.code === '23505') throw new UserError('Er bestaat al een account met dit e-mailadres. Log in.', 409);
      throw e;
    }
    await audit(this.d.db, this.d.clock, { actor: 'user', actorId: id, kind: 'account.created', ip });
    return { account: (await this.get(id))!, verifyToken };
  }

  /** Check credentials; same cost whether or not the account exists. */
  async checkPassword(email: string, password: string): Promise<Account | null> {
    const row = await one<{ id: string; password_hash: string }>(this.d.db, 'SELECT id, password_hash FROM accounts WHERE email = $1', [String(email || '').trim().toLowerCase()]);
    const ok = await verifyPassword(String(password || ''), row?.password_hash);
    return ok && row ? this.get(row.id) : null;
  }

  async createSession(accountId: string, ip: string, userAgent: string): Promise<{ token: string; session: Session }> {
    const token = randomToken();
    const now = this.d.clock.now();
    const session: Session = { id: newId('ses_'), account_id: accountId, csrf_token: randomToken(24), expires_at: addDays(now, SESSION_DAYS) };
    await this.d.db.query(
      'INSERT INTO sessions (id, token_hash, account_id, csrf_token, ip, user_agent, created_at, last_seen_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)',
      [session.id, sha256(token), accountId, session.csrf_token, ip, userAgent.slice(0, 200), now.toISOString(), session.expires_at.toISOString()],
    );
    return { token, session };
  }

  async resolve(token: string | undefined | null): Promise<{ account: Account; session: Session } | null> {
    if (!token || token.length > 200) return null;
    const s = await one<Session & { revoked_at: Date | null; last_seen_at: Date }>(
      this.d.db,
      'SELECT id, account_id, csrf_token, expires_at, revoked_at, last_seen_at FROM sessions WHERE token_hash = $1',
      [sha256(token)],
    );
    const now = this.d.clock.now();
    if (!s || s.revoked_at || new Date(s.expires_at) <= now) return null;
    const account = await this.get(s.account_id);
    if (!account) return null;
    if (now.getTime() - new Date(s.last_seen_at).getTime() > 60_000) await this.d.db.query('UPDATE sessions SET last_seen_at = $2 WHERE id = $1', [s.id, now.toISOString()]);
    return { account, session: { id: s.id, account_id: s.account_id, csrf_token: s.csrf_token, expires_at: s.expires_at } };
  }

  async revokeSession(id: string) {
    await this.d.db.query('UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [id, this.d.clock.now().toISOString()]);
  }

  async verifyEmail(token: string): Promise<boolean> {
    if (!token || token.length > 200) return false;
    const row = await one<{ id: string }>(this.d.db, 'SELECT id FROM accounts WHERE verify_token_hash = $1 AND verify_expires_at > $2', [sha256(token), this.d.clock.now().toISOString()]);
    if (!row) return false;
    await this.d.db.query('UPDATE accounts SET email_verified = TRUE, verify_token_hash = NULL, verify_expires_at = NULL, updated_at = $2 WHERE id = $1', [row.id, this.d.clock.now().toISOString()]);
    await audit(this.d.db, this.d.clock, { actor: 'user', actorId: row.id, kind: 'account.email_verified' });
    return true;
  }

  async newVerifyToken(accountId: string): Promise<string> {
    const t = randomToken();
    await this.d.db.query('UPDATE accounts SET verify_token_hash = $2, verify_expires_at = $3 WHERE id = $1', [accountId, sha256(t), addDays(this.d.clock.now(), 2).toISOString()]);
    return t;
  }

  /** Operator role is granted only from the command line (needs database access), never from the web. */
  async setRole(email: string, role: 'user' | 'operator'): Promise<boolean> {
    const rows = await this.d.db.query('UPDATE accounts SET role = $2, updated_at = $3 WHERE email = $1 RETURNING id', [email.trim().toLowerCase(), role, this.d.clock.now().toISOString()]);
    if (rows.length) await audit(this.d.db, this.d.clock, { actor: 'system', actorId: rows[0].id, kind: 'account.role', data: { role } });
    return rows.length > 0;
  }

  /** Send the verification mail (only when CLOUD_SMTP_URL is set). */
  async sendVerification(account: Account, token: string) {
    if (!this.d.cfg.smtpUrl) return;
    const { default: nodemailer } = await import('nodemailer');
    const link = `${this.d.cfg.url}/verify?t=${encodeURIComponent(token)}`;
    try {
      await nodemailer.createTransport(this.d.cfg.smtpUrl).sendMail({
        from: this.d.cfg.mailFrom,
        to: account.email,
        subject: 'Bevestig je e-mailadres voor TeamBot Cloud',
        text: `Hoi${account.name ? ' ' + account.name : ''},\n\nBevestig je e-mailadres met deze link (2 dagen geldig):\n${link}\n\nHeb je geen account aangemaakt? Dan kun je deze mail negeren.\n`,
      });
    } catch (e) {
      this.d.log.error('verificatiemail versturen mislukte', e);
    }
  }
}
