/** Small shared helpers for the cloud service: clock, logger, rate limiter, slugs, dates. */

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/** Injectable clock for tests (trial end, grace period, retention). */
export class FakeClock implements Clock {
  private t: number;
  constructor(start: Date | string = '2026-01-01T09:00:00Z') {
    this.t = new Date(start).getTime();
  }
  now() {
    return new Date(this.t);
  }
  set(d: Date | string) {
    this.t = new Date(d).getTime();
  }
  advanceDays(days: number) {
    this.t += days * 864e5;
  }
}

export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 864e5);
export const iso = (d: Date) => d.toISOString();

// ---------- logging (secrets never reach the log) ----------

export interface Log {
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|rk)_(live|test)_[A-Za-z0-9]+/g,
  /\bwhsec_[A-Za-z0-9]+/g,
  /postgres(ql)?:\/\/[^\s"']+/gi,
  /([?&](t|token)=)[^&\s"']+/gi,
];

export function redact(s: string, extra: string[] = []): string {
  let out = s;
  for (const v of extra) if (v && v.length >= 8) out = out.split(v).join('[geheim]');
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, p1) => (typeof p1 === 'string' && p1.endsWith('=') ? `${p1}[geheim]` : '[geheim]'));
  return out;
}

export function makeLog(quiet: boolean, secrets: string[] = []): Log {
  const fmt = (a: unknown[]) =>
    redact(a.map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : JSON.stringify(x))).join(' '), secrets);
  const line = (level: string, a: unknown[]) => `${new Date().toISOString()} ${level} [cloud] ${fmt(a)}`;
  return {
    info: (...a) => !quiet && console.log(line('INFO', a)),
    warn: (...a) => !quiet && console.warn(line('WARN', a)),
    error: (...a) => !quiet && console.error(line('ERROR', a)),
  };
}

// ---------- rate limiting ----------

/** Fixed-window counter per key (in memory; one control-plane process). */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private limit: number, private windowMs: number) {}

  /** Count one attempt; false when the key is over its limit. */
  hit(key: string, now = Date.now()): boolean {
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    const h = this.hits.get(key);
    if (!h || h.reset <= now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return true;
    }
    h.n++;
    return h.n <= this.limit;
  }

  blocked(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    return !!h && h.reset > now && h.n >= this.limit;
  }

  reset(key: string) {
    this.hits.delete(key);
  }
}

// ---------- workspace slugs ----------

/** Names that must never become a workspace host (infrastructure, confusing or phishing-prone). */
export const RESERVED_SLUGS = new Set([
  'www', 'api', 'status', 'admin', 'cloud', 'app', 'apps', 'mail', 'email', 'smtp', 'imap', 'pop', 'ftp', 'ns1', 'ns2',
  'dns', 'mx', 'cdn', 'static', 'assets', 'media', 'files', 'dashboard', 'operator', 'beheer', 'billing', 'betalen',
  'stripe', 'webhook', 'webhooks', 'hooks', 'login', 'signup', 'auth', 'oauth', 'sso', 'account', 'accounts', 'teambot',
  'help', 'hulp', 'support', 'docs', 'blog', 'root', 'system', 'internal', 'intern', 'localhost', 'test', 'demo',
  'security', 'abuse', 'postmaster', 'hostmaster', 'webmaster', 'router', 'proxy', 'gateway', 'control', 'console',
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/;

/** Returns a Dutch error message, or null when the slug is valid. */
export function slugError(slug: string): string | null {
  if (typeof slug !== 'string' || !slug) return 'Kies een adres.';
  if (slug.length < 3 || slug.length > 30) return 'Het adres moet 3 tot 30 tekens lang zijn.';
  if (!SLUG_RE.test(slug)) return 'Gebruik alleen kleine letters, cijfers en streepjes (niet aan het begin of eind).';
  if (slug.includes('--')) return 'Gebruik geen twee streepjes achter elkaar.';
  if (RESERVED_SLUGS.has(slug)) return 'Dit adres is gereserveerd. Kies een ander.';
  return null;
}

export const isValidSlug = (s: string) => slugError(s) === null;

/** Suggest a slug from a name ("Team Zuid!" → "team-zuid"). */
export function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
}

// ---------- dates in Dutch ----------

export function formatDate(d: Date | string | null | undefined, timeZone: string, withTime = false): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString('nl-NL', {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

// ---------- local wall time (datetime-local inputs) <-> UTC ----------

function tzOffsetMs(t: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t));
  const get = (k: string) => Number(parts.find((p) => p.type === k)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(t / 1000) * 1000;
}

/** "2026-11-20T22:00" in the given time zone → Date (UTC). Null when the input is not that format. */
export function zonedTimeToUtc(local: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local || '').trim());
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (!Number.isFinite(wall)) return null;
  let t = wall - tzOffsetMs(wall, timeZone);
  t = wall - tzOffsetMs(t, timeZone); // second pass for DST boundaries
  return new Date(t);
}

/** Calendar date ("YYYY-MM-DD") of an instant in the given time zone. Uptime is bucketed per local day. */
export function localDay(d: Date, timeZone: string): string {
  return new Date(d.getTime() + tzOffsetMs(d.getTime(), timeZone)).toISOString().slice(0, 10);
}

/** The `n` calendar days ending with `lastDay` (inclusive, oldest first). Pure calendar arithmetic, DST-proof. */
export function calendarDays(lastDay: string, n: number): string[] {
  const [y, m, d] = lastDay.split('-').map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  return out;
}

export const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Start (inclusive) and end (exclusive) instants of a calendar month ("YYYY-MM") in the given time zone. */
export function monthRange(month: string, timeZone: string): { start: Date; end: Date; firstDay: string; nextFirstDay: string } {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error(`Ongeldige maand: ${month}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const firstDay = `${month}-01`;
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  const nextFirstDay = `${next}-01`;
  return { start: zonedTimeToUtc(`${firstDay}T00:00`, timeZone)!, end: zonedTimeToUtc(`${nextFirstDay}T00:00`, timeZone)!, firstDay, nextFirstDay };
}

/** Calendar month ("YYYY-MM") that contains `d` in the given time zone, optionally shifted by whole months. */
export function monthOf(d: Date, timeZone: string, shift = 0): string {
  const [y, m] = localDay(d, timeZone).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + shift, 1));
  return t.toISOString().slice(0, 7);
}

/** Date → "YYYY-MM-DDTHH:mm" in the given time zone (value for a datetime-local input). */
export function toLocalInput(d: Date, timeZone: string): string {
  return new Date(d.getTime() + tzOffsetMs(d.getTime(), timeZone)).toISOString().slice(0, 16);
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (v < 1024 * 1024) return `${Math.max(1, Math.round(v / 1024))} kB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
  return `${(v / 1024 ** 3).toFixed(2).replace('.', ',')} GB`;
}
