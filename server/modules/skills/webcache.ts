import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Logger } from '../../core/types.js';
import type { Fetcher } from './fetch.js';

/**
 * Disk cache for marketplace data from the internet (MCP Registry, skills.sh, GitHub). Every entry has a TTL;
 * a fresh entry is served without any network traffic, an expired one is revalidated (If-None-Match where the
 * server supports it) and kept as a stale fallback when the network fails, a host is rate limited, or TeamBot runs
 * offline. Hosts that answer with a rate-limit status are left alone until their reset time.
 */

export class WebError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: 'not-found' | 'rate-limited' | 'offline' | 'network' | 'too-large' | 'bad-response',
    /** Rate limited: when the source may be asked again (ms since 1970). */
    public until: number | null = null,
  ) {
    super(message);
  }
}

export interface CacheHit<T> {
  data: T;
  /** When the data was last fetched or revalidated (ISO). */
  fetchedAt: string;
  /** Served from cache past its TTL (network failed, rate limited or offline). */
  stale: boolean;
  /** Network error that made us fall back to the cache. */
  error: string | null;
}

export interface CacheOptions {
  ttlMs: number;
  maxBytes?: number;
  accept?: string;
  headers?: Record<string, string>;
  /** Revalidate even if the entry is still fresh. */
  force?: boolean;
  /** Give up on this source after this long (default: the downloader's 30 s). */
  timeoutMs?: number;
  /**
   * The rate limit this request counts for, when one host has several (GitHub: searching has its own limit per minute,
   * next to the hourly limit of the rest of its API). Default: the host.
   */
  limitKey?: string;
}

interface Meta {
  key: string;
  url: string;
  kind: 'json' | 'buffer' | 'redirect';
  fetchedAt: number;
  etag?: string;
  size: number;
}

const MAX_JSON = 8 * 1024 * 1024;
const MAX_TOTAL = 400 * 1024 * 1024;

export function isOffline() {
  return process.env.TEAMBOT_OFFLINE === '1' || process.env.TEAMBOT_MARKET_OFFLINE === '1';
}

/**
 * How long the first view of the marketplace waits for a source that is not in the cache yet. Everything that is
 * cached is shown at once (and checked in the background); slower sources keep downloading and the page asks again.
 */
export const FIRST_VIEW_BUDGET_MS = 1200;

/** `p`, or 'pending' when it takes longer than `ms` (the work itself goes on). */
export async function withBudget<T>(p: Promise<T>, ms: number): Promise<T | 'pending'> {
  if (ms <= 0) return Promise.race([p, Promise.resolve('pending' as const)]);
  let t: NodeJS.Timeout;
  return Promise.race([p.finally(() => clearTimeout(t)), new Promise<'pending'>((r) => (t = setTimeout(() => r('pending'), ms)))]);
}

/**
 * One deadline shared by all sources of a list request. `wait(p)` gives `p` or 'pending' at the deadline; with
 * `early` (a page asking again while sources load) the wait also ends shortly after the first slow source arrives,
 * so its cards show right away instead of at the deadline.
 */
export function sharedDeadline(ms: number, early = false) {
  const end = Date.now() + ms;
  let release!: () => void;
  const stop = new Promise<'pending'>((r) => (release = () => r('pending')));
  const timer = setTimeout(release, Math.max(0, ms));
  let soon: NodeJS.Timeout | null = null;
  return {
    left: () => Math.max(0, end - Date.now()),
    wait<T>(p: Promise<T>): Promise<T | 'pending'> {
      if (early) p.then(() => (soon ??= setTimeout(release, 60)), () => {});
      return Promise.race([p, stop]);
    },
    done() {
      clearTimeout(timer);
      if (soon) clearTimeout(soon);
    },
  };
}

/** The `budget` query parameter of a marketplace list (ms, max 20 s), or the first-view default. */
export function budgetParam(v: unknown): number {
  const n = typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.min(20_000, n) : FIRST_VIEW_BUDGET_MS;
}

export class WebCache {
  private inflight = new Map<string, Promise<CacheHit<any>>>();
  private blockedUntil = new Map<string, number>();
  private writes = 0;

  constructor(
    private dir: string,
    private fetcher: () => Fetcher,
    private log?: Logger,
  ) {}

  private paths(key: string) {
    const h = crypto.createHash('sha256').update(key).digest('hex').slice(0, 40);
    const base = path.join(this.dir, h.slice(0, 2), h);
    return { meta: base + '.meta.json', data: base + '.data' };
  }

  private readMeta(key: string): Meta | null {
    try {
      const m = JSON.parse(fs.readFileSync(this.paths(key).meta, 'utf8')) as Meta;
      return m && m.key === key ? m : null;
    } catch {
      return null;
    }
  }

  private readData(key: string, kind: Meta['kind']): any {
    const b = fs.readFileSync(this.paths(key).data);
    if (kind === 'buffer') return b;
    if (kind === 'redirect') return b.toString('utf8');
    return JSON.parse(b.toString('utf8'));
  }

  private write(key: string, url: string, kind: Meta['kind'], body: Buffer, etag?: string) {
    const p = this.paths(key);
    fs.mkdirSync(path.dirname(p.meta), { recursive: true });
    const tmp = `${p.data}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, p.data);
    const meta: Meta = { key, url, kind, fetchedAt: Date.now(), etag, size: body.length };
    fs.writeFileSync(p.meta, JSON.stringify(meta));
    if (++this.writes % 25 === 0) this.prune();
  }

  private touch(key: string, m: Meta) {
    try {
      fs.writeFileSync(this.paths(key).meta, JSON.stringify({ ...m, fetchedAt: Date.now() }));
    } catch {
      /* best effort */
    }
  }

  /** Cached value without any network access (null when absent or unreadable). */
  peek<T>(key: string): CacheHit<T> | null {
    const m = this.readMeta(key);
    if (!m) return null;
    try {
      return { data: this.readData(key, m.kind), fetchedAt: new Date(m.fetchedAt).toISOString(), stale: false, error: null };
    } catch {
      return null;
    }
  }

  /** The entry exists and is younger than its TTL (so asking for it costs no network). */
  fresh(key: string, ttlMs: number): boolean {
    const m = this.readMeta(key);
    return !!m && Date.now() - m.fetchedAt < ttlMs;
  }

  /** Store a derived value (e.g. a parsed index) under its own key. */
  put(key: string, value: unknown) {
    try {
      this.write(key, 'derived:' + key, 'json', Buffer.from(JSON.stringify(value)));
    } catch (e: any) {
      this.log?.warn('[market] cache write failed', e?.message);
    }
  }

  /** Remove entries (e.g. old archives of a repository). */
  drop(key: string) {
    const p = this.paths(key);
    fs.rmSync(p.meta, { force: true });
    fs.rmSync(p.data, { force: true });
  }

  /** Rate-limit state of a host or `limitKey` (ms epoch until which it is left alone), for diagnostics and the UI. */
  blockedHost(host: string): number | null {
    const t = this.blockedUntil.get(host);
    return t && t > Date.now() ? t : null;
  }

  json<T = any>(key: string, url: string, o: CacheOptions): Promise<CacheHit<T>> {
    return this.get(key, url, 'json', { accept: 'application/json', ...o });
  }
  buffer(key: string, url: string, o: CacheOptions): Promise<CacheHit<Buffer>> {
    return this.get(key, url, 'buffer', o);
  }
  /** The target of a redirect (e.g. GitHub's archive URL → the commit it resolves to). */
  redirect(key: string, url: string, o: CacheOptions): Promise<CacheHit<string>> {
    return this.get(key, url, 'redirect', o);
  }

  private get<T>(key: string, url: string, kind: Meta['kind'], o: CacheOptions): Promise<CacheHit<T>> {
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.load<T>(key, url, kind, o).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async load<T>(key: string, url: string, kind: Meta['kind'], o: CacheOptions): Promise<CacheHit<T>> {
    const m = this.readMeta(key);
    let cached: T | undefined;
    if (m) {
      try {
        cached = this.readData(key, m.kind);
      } catch {
        cached = undefined;
      }
    }
    const have = cached !== undefined && m;
    const hit = (stale: boolean, error: string | null): CacheHit<T> => ({ data: cached as T, fetchedAt: new Date(m!.fetchedAt).toISOString(), stale, error });
    if (have && !o.force && Date.now() - m!.fetchedAt < o.ttlMs) return hit(false, null);
    const host = new URL(url).host;
    if (isOffline()) {
      if (have) return hit(true, 'Offline: laatst opgehaalde gegevens.');
      throw new WebError('TeamBot werkt offline en dit staat nog niet in de cache.', 503, 'offline');
    }
    const bucket = o.limitKey || host;
    const until = this.blockedUntil.get(bucket);
    if (until && until > Date.now()) {
      const msg = `Limiet bereikt bij ${host}; opnieuw na ${new Date(until).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}.`;
      if (have) return hit(true, msg);
      throw new WebError(msg, 429, 'rate-limited', until);
    }
    const headers: Record<string, string> = { ...(o.headers || {}) };
    if (have && m!.etag && kind !== 'redirect') headers['if-none-match'] = m!.etag;
    let res;
    try {
      res = await this.fetcher()(url, {
        maxBytes: o.maxBytes ?? (kind === 'json' ? MAX_JSON : 25 * 1024 * 1024),
        accept: o.accept,
        headers,
        okStatus: [304, 403, 404, 410, 422, 429],
        redirect: kind === 'redirect' ? 'manual' : 'follow',
        ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
      });
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 300);
      if (have) return hit(true, msg);
      throw new WebError(msg, /te groot/i.test(msg) ? 413 : 502, /te groot/i.test(msg) ? 'too-large' : 'network');
    }
    const h = res.headers || {};
    this.noteRateLimit(bucket, res.status, h);
    if (res.status === 304 && have) {
      this.touch(key, m!);
      return { ...hit(false, null), fetchedAt: new Date().toISOString() };
    }
    if (res.status === 429 || (res.status === 403 && h['x-ratelimit-remaining'] === '0')) {
      const msg = `Limiet bereikt bij ${host}. Probeer het later opnieuw${host === 'api.github.com' ? ' of stel een GitHub-token in (Marktplaats › Bronnen)' : ''}.`;
      if (have) return hit(true, msg);
      throw new WebError(msg, 429, 'rate-limited', this.blockedHost(bucket));
    }
    if (res.status === 404 || res.status === 410) throw new WebError(`Niet gevonden bij ${host}.`, 404, 'not-found');
    if (res.status >= 400) {
      const msg = `${host} antwoordde met HTTP ${res.status}.`;
      if (have) return hit(true, msg);
      throw new WebError(msg, 502, 'bad-response');
    }
    let value: any;
    let body = res.body;
    if (kind === 'redirect') {
      value = h.location || '';
      if (!value) throw new WebError(`${host} gaf geen doorverwijzing.`, 502, 'bad-response');
      body = Buffer.from(value, 'utf8');
    } else if (kind === 'json') {
      try {
        value = JSON.parse(res.body.toString('utf8'));
      } catch {
        if (have) return hit(true, `${host} gaf geen geldige JSON.`);
        throw new WebError(`${host} gaf geen geldige JSON.`, 502, 'bad-response');
      }
    } else value = res.body;
    try {
      this.write(key, url, kind, body, h.etag);
    } catch (e: any) {
      this.log?.warn('[market] cache write failed', e?.message);
    }
    return { data: value as T, fetchedAt: new Date().toISOString(), stale: false, error: null };
  }

  private noteRateLimit(host: string, status: number, h: Record<string, string>) {
    const remaining = h['x-ratelimit-remaining'];
    const reset = Number(h['x-ratelimit-reset']);
    const retry = Number(h['retry-after']);
    let until = 0;
    if (status === 429 || (status === 403 && remaining === '0') || remaining === '0') {
      if (retry > 0) until = Date.now() + retry * 1000;
      // GitHub sends an epoch; others send seconds until reset.
      else if (reset > 1e9) until = reset * 1000;
      else if (reset > 0) until = Date.now() + reset * 1000;
      else until = Date.now() + 60_000;
    }
    if (until) this.blockedUntil.set(host, Math.min(until, Date.now() + 2 * 3600_000));
  }

  /** Keep the cache under MAX_TOTAL bytes by removing the least recently fetched entries. */
  prune(max = MAX_TOTAL) {
    try {
      const items: { meta: string; data: string; at: number; size: number }[] = [];
      for (const d of fs.readdirSync(this.dir)) {
        const sub = path.join(this.dir, d);
        if (!fs.statSync(sub).isDirectory()) continue;
        for (const f of fs.readdirSync(sub)) {
          if (!f.endsWith('.meta.json')) continue;
          const meta = path.join(sub, f);
          const data = meta.replace(/\.meta\.json$/, '.data');
          try {
            const m = JSON.parse(fs.readFileSync(meta, 'utf8')) as Meta;
            items.push({ meta, data, at: m.fetchedAt, size: m.size || 0 });
          } catch {
            fs.rmSync(meta, { force: true });
          }
        }
      }
      let total = items.reduce((a, i) => a + i.size, 0);
      if (total <= max) return;
      for (const i of items.sort((a, b) => a.at - b.at)) {
        if (total <= max * 0.8) break;
        fs.rmSync(i.meta, { force: true });
        fs.rmSync(i.data, { force: true });
        total -= i.size;
      }
    } catch (e: any) {
      this.log?.warn('[market] cache prune failed', e?.message);
    }
  }
}
