import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Outbound health checks of dedicated instances (CLD-05). These requests leave the control plane towards an address
 * an operator typed in, so they are an SSRF surface. Defences:
 * - https only and public addresses only (unless the explicit development flag CLOUD_DEDICATED_DEV=1);
 * - every DNS answer is checked and the connection is made to exactly the checked address (no DNS rebinding);
 * - only GET <origin>/healthz, no credentials or cookies, small response limit, hard timeout;
 * - redirects are followed only within the same origin; a redirect to another host is a failed check.
 */

const BLOCK = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCK.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['2001::', 32], ['2002::', 16], ['100::', 64],
] as const) BLOCK.addSubnet(a, p, 'ipv6');

/** ::ffff:a.b.c.d, ::ffff:7f00:1, ::a.b.c.d and 64:ff9b::x (NAT64) carry an IPv4 address that must be checked. */
function embeddedV4(ip: string): string | null {
  const l = ip.toLowerCase();
  const m = l.match(/^(?:::ffff:|::ffff:0:|::|64:ff9b::)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (m) return m[1];
  const h = l.match(/^(?:::ffff:|::ffff:0:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (h) {
    const hi = parseInt(h[1], 16);
    const lo = parseInt(h[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True only for plainly public internet addresses. Unknown formats count as private (fail closed). */
export function isPublicAddress(ip: string): boolean {
  const a = ip.replace(/^\[|\]$/g, '');
  const v4 = net.isIPv4(a) ? a : embeddedV4(a);
  if (v4) return net.isIPv4(v4) && !BLOCK.check(v4, 'ipv4');
  if (net.isIPv6(a)) return !BLOCK.check(a, 'ipv6');
  return false;
}

export type Resolver = (host: string) => Promise<string[]>;
const systemResolver: Resolver = async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((r) => r.address);

export class UrlError extends Error {}

/**
 * Validate the address of a dedicated instance and return its origin (e.g. https://teambot.klant.nl).
 * Throws UrlError with a Dutch message.
 */
export async function validateInstanceUrl(raw: string, o: { allowPrivate: boolean; cloudDomain: string; resolve?: Resolver }): Promise<string> {
  let u: URL;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw new UrlError('Dat is geen geldig adres. Gebruik bijvoorbeeld https://teambot.jouwbedrijf.nl');
  }
  if (u.protocol !== 'https:' && !(o.allowPrivate && u.protocol === 'http:')) throw new UrlError('Alleen https-adressen zijn toegestaan.');
  if (u.username || u.password) throw new UrlError('Zet geen gebruikersnaam of wachtwoord in het adres.');
  if (u.search || u.hash || (u.pathname && u.pathname !== '/')) throw new UrlError('Gebruik alleen het basisadres, zonder pad of parameters.');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const domain = o.cloudDomain.toLowerCase();
  if (host === domain || host.endsWith('.' + domain)) throw new UrlError('Dit adres hoort bij TeamBot Cloud zelf, niet bij een eigen server.');
  if (!o.allowPrivate) {
    if (net.isIP(host)) {
      if (!isPublicAddress(host)) throw new UrlError('Dit adres is niet publiek bereikbaar (privé-, lokaal of gereserveerd netwerk).');
    } else {
      if (!host.includes('.') || /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/.test(host)) throw new UrlError('Gebruik een publieke domeinnaam.');
      let addrs: string[];
      try {
        addrs = await (o.resolve || systemResolver)(host);
      } catch {
        throw new UrlError('Deze domeinnaam bestaat (nog) niet. Controleer de DNS-instelling.');
      }
      if (!addrs.length || addrs.some((a) => !isPublicAddress(a))) throw new UrlError('Deze domeinnaam wijst naar een privé- of lokaal netwerk.');
    }
  }
  return u.origin;
}

/**
 * Validate an owner's alert webhook (CLD-05). Like an instance address, but a path and query are allowed (most webhook
 * receivers need them). https only, no credentials, public DNS answers only, not our own domain.
 */
export async function validateWebhookUrl(raw: string, o: { allowPrivate: boolean; cloudDomain: string; resolve?: Resolver }): Promise<string> {
  let u: URL;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw new UrlError('Dat is geen geldig adres. Gebruik bijvoorbeeld https://hooks.jouwbedrijf.nl/teambot');
  }
  if (u.toString().length > 500) throw new UrlError('Dit adres is te lang.');
  if (u.protocol !== 'https:' && !(o.allowPrivate && u.protocol === 'http:')) throw new UrlError('Alleen https-adressen zijn toegestaan.');
  if (u.username || u.password) throw new UrlError('Zet geen gebruikersnaam of wachtwoord in het adres.');
  u.hash = '';
  await validateInstanceUrl(u.origin, o);
  return u.toString();
}

/** Resolve-and-check lookup for node:http(s): every answer must be public; connects to exactly the checked address. */
function pinnedLookup(o: { allowPrivate: boolean; resolve?: Resolver }) {
  return (hostname: string, opts: any, cb: (...a: any[]) => void) => {
    (o.resolve || systemResolver)(hostname).then(
      (addrs) => {
        if (!addrs.length) return cb(new Error('geen DNS-antwoord'));
        if (!o.allowPrivate && addrs.some((a) => !isPublicAddress(a))) return cb(new Error('privé-adres geweigerd'));
        const list = addrs.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 }));
        if (opts?.all) cb(null, list);
        else cb(null, list[0].address, list[0].family);
      },
      (e) => cb(e),
    );
  };
}

/**
 * POST a small JSON body to an owner's webhook. SSRF guards as for health checks; redirects are never followed (a
 * redirect is a failed delivery); the response body is ignored. Never throws.
 */
export async function postWebhook(url: string, body: string, headers: Record<string, string>, o: CheckOptions): Promise<{ ok: boolean; status?: number; error?: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: 'ongeldig adres' };
  }
  if (u.protocol !== 'https:' && !(o.allowPrivate && u.protocol === 'http:')) return { ok: false, error: 'alleen https' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !o.allowPrivate && !isPublicAddress(host)) return { ok: false, error: 'privé-adres geweigerd' };
  return new Promise((resolve) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'POST',
      lookup: pinnedLookup(o) as any,
      agent: false,
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), 'user-agent': 'TeamBot-Cloud-Alerts/1', ...headers },
    });
    const timer = setTimeout(() => req.destroy(new Error('time-out')), o.timeoutMs);
    req.on('response', (res) => {
      clearTimeout(timer);
      res.resume();
      const status = res.statusCode || 0;
      resolve(status >= 200 && status < 300 ? { ok: true, status } : { ok: false, status, error: status >= 300 && status < 400 ? 'doorverwijzing niet gevolgd' : `HTTP ${status}` });
    });
    req.on('error', (e: any) => {
      clearTimeout(timer);
      const m = String(e?.message || e);
      resolve({ ok: false, error: /time-out/.test(m) ? 'geen antwoord binnen de tijd' : /privé/.test(m) ? m : `niet bereikbaar (${String(e?.code || m).slice(0, 60)})` });
    });
    req.end(body);
  });
}

export interface CheckResult {
  ok: boolean;
  status?: number;
  /** Dutch reason when not ok. */
  error?: string;
  ms: number;
}

export interface CheckOptions {
  allowPrivate: boolean;
  timeoutMs: number;
  maxRedirects?: number;
  resolve?: Resolver;
}

const MAX_BODY = 4096;

function getOnce(url: URL, o: CheckOptions): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    if (url.protocol !== 'https:' && !(o.allowPrivate && url.protocol === 'http:')) return reject(new Error('alleen https'));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !o.allowPrivate && !isPublicAddress(host)) return reject(new Error('privé-adres geweigerd'));
    // Resolve, check every answer, and connect to exactly the checked address.
    const lookup = pinnedLookup(o);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'GET',
      lookup: lookup as any,
      agent: false,
      headers: { 'user-agent': 'TeamBot-Cloud-Health/1', accept: 'application/json' },
    });
    const timer = setTimeout(() => req.destroy(new Error('time-out')), o.timeoutMs);
    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => {
        body += d;
        if (body.length > MAX_BODY) res.destroy();
      });
      const done = () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode || 0, location: typeof res.headers.location === 'string' ? res.headers.location : undefined, body: body.slice(0, MAX_BODY) });
      };
      res.on('end', done);
      res.on('close', done);
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
}

/** GET <origin>/healthz of a dedicated instance. Never throws. */
export async function checkInstance(origin: string, o: CheckOptions): Promise<CheckResult> {
  const start = Date.now();
  const ms = () => Date.now() - start;
  let url: URL;
  try {
    url = new URL('/healthz', origin);
  } catch {
    return { ok: false, error: 'ongeldig adres', ms: 0 };
  }
  const first = url.origin;
  for (let hop = 0; hop <= (o.maxRedirects ?? 3); hop++) {
    let r: { status: number; location?: string; body: string };
    try {
      r = await getOnce(url, o);
    } catch (e: any) {
      const m = String(e?.message || e);
      return { ok: false, error: /time-out/.test(m) ? 'geen antwoord binnen de tijd' : /privé|https/.test(m) ? m : `niet bereikbaar (${String(e?.code || m).slice(0, 60)})`, ms: ms() };
    }
    if (r.status >= 300 && r.status < 400 && r.location) {
      let next: URL;
      try {
        next = new URL(r.location, url);
      } catch {
        return { ok: false, status: r.status, error: 'ongeldige doorverwijzing', ms: ms() };
      }
      if (next.origin !== first) return { ok: false, status: r.status, error: 'doorverwijzing naar een ander adres geweigerd', ms: ms() };
      url = next;
      continue;
    }
    if (r.status !== 200) return { ok: false, status: r.status, error: `HTTP ${r.status}`, ms: ms() };
    let j: any = null;
    try {
      j = JSON.parse(r.body);
    } catch {
      /* not JSON */
    }
    return j?.ok === true ? { ok: true, status: 200, ms: ms() } : { ok: false, status: 200, error: 'antwoord is geen TeamBot-gezondheidscontrole', ms: ms() };
  }
  return { ok: false, error: 'te veel doorverwijzingen', ms: ms() };
}
