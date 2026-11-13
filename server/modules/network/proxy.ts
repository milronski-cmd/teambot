import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { createRequire } from 'node:module';
import { isLoopbackHost } from '../../core/util.js';
import { SocksClient, type SocksProxy } from 'socks';
import type { socksDispatcher as SocksDispatcherFn } from 'fetch-socks';

/**
 * The owner's proxy for TeamBot's outgoing traffic (process-wide): an HTTP(S) proxy, or a SOCKS proxy (socks5://,
 * socks4://; names are resolved by the proxy, so no DNS lookups leak past it).
 *
 * How it is applied (no restart needed):
 *  - global `fetch` (AI providers, web tools, marketplace, MCP over HTTP, Telegram, Slack REST …): a small router is
 *    installed as undici's global dispatcher. Per request it picks "direct" (the original dispatcher) or "via proxy"
 *    (HTTP: Node's own EnvHttpProxyAgent, created with `http.setGlobalProxyFromEnv`; SOCKS: an undici Agent with a
 *    SOCKS connector from `fetch-socks`, MIT). The decision uses our own no-proxy rules (names, domains, IP ranges in
 *    CIDR) and always keeps loopback direct.
 *  - `http.request` / `https.request` without an explicit agent: HTTP: Node's proxy-aware global agents (same call),
 *    with the no-proxy list translated to Node's NO_PROXY syntax (CIDR becomes an IP range). SOCKS: global agents that
 *    open their connections through the proxy (`socksAgents`), with the same no-proxy rules.
 *  - the bots' browser: TeamBot's own policy proxy (browser/proxy.ts) stays the first hop and chains to this proxy
 *    with CONNECT or a SOCKS connect (see `openTunnel`), so the SSRF and domain checks keep working.
 * Credentials live only in memory here (they come from the encrypted secrets store) and never reach a log line.
 */

export interface ProxyConfig {
  /** http(s)://host:port or socks5://host:port (socks4://), without credentials. */
  url: string;
  noProxy: string[];
  /** Also chain the bots' browser through this proxy. */
  browser: boolean;
  username?: string;
  password?: string;
}

type Rule = { kind: 'all' } | { kind: 'host'; host: string; port?: number } | { kind: 'net'; list: net.BlockList; v6: boolean; port?: number };

export interface UpstreamProxy {
  url: URL;
  host: string;
  port: number;
  /** host:port for messages. */
  label: string;
  /** Value of the Proxy-Authorization header (HTTP proxies only), or null. */
  auth: string | null;
  /** SOCKS version for a SOCKS proxy, null for an HTTP(S) proxy. */
  socks: 4 | 5 | null;
  username: string | null;
  password: string | null;
  rules: Rule[];
  noProxy: string[];
  browser: boolean;
}

const S1 = Symbol.for('undici.globalDispatcher.1');
const S2 = Symbol.for('undici.globalDispatcher.2');
const g = globalThis as any;

let current: UpstreamProxy | null = null;
let originals: { s1: any; s2: any } | null = null;
let restoreNode: (() => void) | null = null;

// ---------- parsing ----------

/** Validate a proxy address typed by the owner; returns the normalised URL (scheme://host:port). */
export function parseProxyUrl(raw: string): URL {
  let s = String(raw || '').trim();
  if (!s) throw new Error('Vul het adres van de proxy in, bijvoorbeeld http://proxy.bedrijf.nl:8080');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error('Dit is geen geldig proxy-adres. Voorbeeld: http://proxy.bedrijf.nl:8080');
  }
  // socks:// and socks5h:// are SOCKS5 (the proxy always resolves the name); socks4a:// is SOCKS4 with names.
  const proto = ({ 'socks:': 'socks5:', 'socks5h:': 'socks5:', 'socks4a:': 'socks4:' } as Record<string, string>)[u.protocol] || u.protocol;
  if (!['http:', 'https:', 'socks5:', 'socks4:'].includes(proto)) throw new Error('Alleen http://, https:// en socks5:// (of socks4://) proxy’s worden ondersteund.');
  if (!u.hostname) throw new Error('Het proxy-adres heeft geen naam of IP-adres.');
  if (u.username || u.password) throw new Error('Zet de gebruikersnaam en het wachtwoord in de aparte velden, niet in het adres.');
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) throw new Error('Een proxy-adres heeft geen pad; alleen naam en poort, bijvoorbeeld http://proxy:3128');
  // new URL() keeps no default port for a scheme it does not know (socks), so the host stays as typed.
  return new URL(`${proto}//${u.host}`);
}

/** SOCKS version of a parsed proxy URL, null for HTTP(S). */
const socksVersion = (u: URL): 4 | 5 | null => (u.protocol === 'socks5:' ? 5 : u.protocol === 'socks4:' ? 4 : null);

const cleanHost = (h: string) => h.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();

/** Parse the "niet via de proxy" list (comma, space or newline separated). Unknown entries are returned as invalid. */
export function parseNoProxy(input: string | string[] | undefined | null): { entries: string[]; rules: Rule[]; invalid: string[] } {
  const items = (Array.isArray(input) ? input : String(input || '').split(/[\s,;]+/)).map((x) => String(x || '').trim()).filter(Boolean);
  const entries: string[] = [];
  const rules: Rule[] = [];
  const invalid: string[] = [];
  for (const raw of items.slice(0, 200)) {
    const s = raw.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/$/, '');
    if (s === '*') {
      rules.push({ kind: 'all' });
      entries.push('*');
      continue;
    }
    // CIDR / IP (optionally with port for a bare IPv4)
    const cidr = s.match(/^\[?([0-9a-f:.]+?)\]?(?:\/(\d{1,3}))?$/i);
    if (cidr && net.isIP(cidr[1])) {
      const ip = cidr[1];
      const v6 = net.isIPv6(ip);
      const bits = cidr[2] === undefined ? (v6 ? 128 : 32) : Number(cidr[2]);
      if (bits > (v6 ? 128 : 32)) {
        invalid.push(raw);
        continue;
      }
      const list = new net.BlockList();
      try {
        list.addSubnet(ip, bits, v6 ? 'ipv6' : 'ipv4');
      } catch {
        invalid.push(raw);
        continue;
      }
      rules.push({ kind: 'net', list, v6 });
      entries.push(cidr[2] === undefined ? ip : `${ip}/${bits}`);
      continue;
    }
    const v4port = s.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/);
    if (v4port && net.isIPv4(v4port[1])) {
      const list = new net.BlockList();
      list.addAddress(v4port[1], 'ipv4');
      rules.push({ kind: 'net', list, v6: false, port: Number(v4port[2]) });
      entries.push(s);
      continue;
    }
    const hp = s.match(/^(\*\.|\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d{1,5}))?$/i);
    if (hp) {
      rules.push({ kind: 'host', host: hp[2], port: hp[3] ? Number(hp[3]) : undefined });
      entries.push(`${hp[1] ? '.' : ''}${hp[2]}${hp[3] ? ':' + hp[3] : ''}`);
      continue;
    }
    invalid.push(raw);
  }
  return { entries: [...new Set(entries)], rules, invalid };
}

/** Unwrap ::ffff:a.b.c.d to the IPv4 address. */
function unmapped(ip: string): string {
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1] : ip;
}

/** localhost, *.localhost, 127.0.0.0/8 and ::1 are always reached directly (core/util). */
export { isLoopbackHost };

export function matchesNoProxy(rules: Rule[], host: string, port?: number): boolean {
  const h = unmapped(cleanHost(host));
  const ipKind = net.isIP(h);
  for (const r of rules) {
    if (r.kind === 'all') return true;
    if (r.port && port && r.port !== port) continue;
    if (r.kind === 'net') {
      if (!ipKind) continue;
      if (r.v6 !== (ipKind === 6)) continue;
      if (r.list.check(h, r.v6 ? 'ipv6' : 'ipv4')) return true;
      continue;
    }
    if (ipKind) {
      if (h === r.host) return true;
      continue;
    }
    if (h === r.host || h.endsWith('.' + r.host)) return true;
  }
  return false;
}

/** A name that only an intranet would know (no dot, .local, .internal, …): never handed to the proxy unresolved. */
export function looksLocalName(host: string): boolean {
  const h = cleanHost(host);
  if (!h.includes('.')) return true;
  return /\.(local|localhost|internal|intranet|lan|home|home\.arpa|corp|private|localdomain)$/.test(h);
}

// ---------- the active proxy ----------

export function makeUpstream(cfg: ProxyConfig): UpstreamProxy {
  const url = parseProxyUrl(cfg.url);
  const { rules, entries } = parseNoProxy(cfg.noProxy);
  const username = cfg.username ? String(cfg.username) : null;
  const password = cfg.password ? String(cfg.password) : null;
  const socks = socksVersion(url);
  const auth = !socks && (username || password) ? 'Basic ' + Buffer.from(`${username || ''}:${password || ''}`).toString('base64') : null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port) || (socks ? 1080 : url.protocol === 'https:' ? 443 : 80);
  return { url, host, port, label: `${url.hostname}:${port}`, auth, socks, username, password, rules, noProxy: entries, browser: cfg.browser !== false };
}

// ---------- SOCKS ----------

let socksLib: { socksDispatcher: typeof SocksDispatcherFn; Dispatcher1Wrapper: new (d: any) => any } | null = null;

/**
 * fetch-socks and its undici, loaded only when a SOCKS proxy is switched on: loading undici installs its own global
 * dispatcher in an empty slot, and without a SOCKS proxy fetch must keep Node's own. Slots that were set stay as they were.
 */
function loadSocksLib() {
  if (socksLib) return socksLib;
  const before = { s1: g[S1], s2: g[S2] };
  const req = createRequire(import.meta.url);
  const fetchSocks = req('fetch-socks');
  const undici = createRequire(req.resolve('fetch-socks'))('undici');
  if (before.s1 !== undefined) g[S1] = before.s1;
  if (before.s2 !== undefined) g[S2] = before.s2;
  socksLib = { socksDispatcher: fetchSocks.socksDispatcher, Dispatcher1Wrapper: undici.Dispatcher1Wrapper };
  return socksLib;
}

function socksProxyOf(p: UpstreamProxy): SocksProxy {
  return { host: p.host, port: p.port, type: p.socks === 4 ? 4 : 5, userId: p.username || undefined, password: p.password || undefined };
}

/** A raw connection to host:port through the SOCKS proxy `p` (the proxy resolves the name). */
async function socksSocket(p: UpstreamProxy, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  try {
    const r = await SocksClient.createConnection({ proxy: socksProxyOf(p), command: 'connect', destination: { host: host.replace(/^\[|\]$/g, ''), port }, timeout: timeoutMs });
    return r.socket;
  } catch (e: any) {
    throw proxyErrorFrom(e, p, host);
  }
}

/**
 * http/https Agents whose connections go through the SOCKS proxy `p`. `always`: every connection (forwarding for the
 * browser chain and the connection test); otherwise our no-proxy rules decide per host, like for fetch.
 */
export function socksAgents(p: UpstreamProxy, o: { always?: boolean; keepAlive?: boolean } = {}): { http: http.Agent; https: https.Agent } {
  const via = (proto: string, host: string, port: number) => o.always || !!upstreamFor(`${proto}//${net.isIPv6(host) ? `[${host}]` : host}:${port}`, { proxy: p });
  class SocksHttp extends http.Agent {
    createConnection(opts: any, cb: any): any {
      const port = Number(opts.port) || 80;
      if (!via('http:', String(opts.host), port)) return (http.Agent.prototype as any).createConnection.call(this, opts, cb);
      socksSocket(p, String(opts.host), port, 15_000).then((s) => cb(null, s), (e) => cb(e));
      return undefined;
    }
  }
  class SocksHttps extends https.Agent {
    createConnection(opts: any, cb: any): any {
      const port = Number(opts.port) || 443;
      const host = String(opts.host);
      if (!via('https:', host, port)) return (https.Agent.prototype as any).createConnection.call(this, opts, cb);
      socksSocket(p, host, port, 15_000).then(
        (s) => cb(null, tls.connect({ ...opts, socket: s, servername: opts.servername || (net.isIP(host) ? undefined : host) })),
        (e) => cb(e),
      );
      return undefined;
    }
  }
  const keepAlive = o.keepAlive ?? false;
  return { http: new SocksHttp({ keepAlive }), https: new SocksHttps({ keepAlive }) };
}

export function currentProxy(): UpstreamProxy | null {
  return current;
}

/** The proxy a request to `target` goes through, or null for a direct connection. */
export function upstreamFor(target: string | URL, o: { browser?: boolean; proxy?: UpstreamProxy | null } = {}): UpstreamProxy | null {
  const p = o.proxy === undefined ? current : o.proxy;
  if (!p) return null;
  if (o.browser && !p.browser) return null;
  let u: URL;
  try {
    u = typeof target === 'string' ? new URL(target) : target;
  } catch {
    return null;
  }
  const host = cleanHost(u.hostname);
  if (!host || isLoopbackHost(host)) return null;
  const port = Number(u.port) || (u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80);
  if (matchesNoProxy(p.rules, host, port)) return null;
  return p;
}

/** Built-in proxy support of this Node version (`http.setGlobalProxyFromEnv`, Node 24.14+/25.4+). */
export function proxySupport(): { ok: boolean; node: string; reason?: string } {
  const ok = typeof (http as any).setGlobalProxyFromEnv === 'function';
  return ok ? { ok, node: process.versions.node } : { ok, node: process.versions.node, reason: `Deze Node-versie (${process.versions.node}) kan geen proxy instellen voor uitgaand verkeer. Werk Node bij naar versie 24 of nieuwer.` };
}

function credUrl(p: UpstreamProxy): string {
  const u = new URL(p.url.href);
  if (p.username || p.password) {
    u.username = encodeURIComponent(p.username || '');
    u.password = encodeURIComponent(p.password || '');
  }
  return u.href.replace(/\/$/, '');
}

/** NO_PROXY for Node's own http(s) agents: names as-is, CIDR as an a-b range (Node supports ranges, not CIDR). */
export function toNodeNoProxy(p: UpstreamProxy): string {
  const out = ['localhost', '.localhost', '127.0.0.1-127.255.255.255', '::1'];
  for (const e of p.noProxy) {
    if (e === '*') out.push('*');
    else if (/\/\d+$/.test(e) && net.isIPv4(e.split('/')[0])) {
      const [ip, bits] = e.split('/');
      const n = ip.split('.').reduce((a, x) => a * 256 + Number(x), 0);
      const size = 2 ** (32 - Number(bits));
      const start = Math.floor(n / size) * size;
      const toIp = (v: number) => [24, 16, 8, 0].map((s) => Math.floor(v / 2 ** s) % 256).join('.');
      out.push(`${toIp(start)}-${toIp(start + size - 1)}`);
    } else if (!e.includes('/')) out.push(e);
  }
  return out.join(',');
}

function router(direct: any, proxied: any, pick: (origin: any) => boolean) {
  const r: any = {
    dispatch(opts: any, handler: any) {
      let via = false;
      try {
        via = pick(opts?.origin);
      } catch {
        via = false;
      }
      return (via ? proxied : direct).dispatch(opts, handler);
    },
    close: (...a: any[]) => Promise.resolve(typeof a[a.length - 1] === 'function' ? a[a.length - 1]() : undefined),
    destroy: (...a: any[]) => Promise.resolve(typeof a[a.length - 1] === 'function' ? a[a.length - 1]() : undefined),
  };
  // Anything else undici asks of a dispatcher (event listeners, WebSocket/EventSource options …) goes to the direct one.
  return new Proxy(r, {
    get(t, k) {
      if (k in t) return t[k];
      const v = direct?.[k];
      return typeof v === 'function' ? v.bind(direct) : v;
    },
  });
}

/**
 * Make `p` the proxy for everything new (fetch, http(s) without own agent, browser chain); null = direct again.
 * Takes effect immediately; connections that are already open keep their route until they close.
 */
export function applyProxy(p: UpstreamProxy | null): { applied: boolean; reason?: string } {
  if (!p) {
    if (current || restoreNode) {
      try {
        restoreNode?.();
      } catch {
        /* ignore */
      }
      if (originals) {
        g[S1] = originals.s1;
        if (originals.s2 !== undefined) g[S2] = originals.s2;
      }
      restoreNode = null;
      originals = null;
    }
    current = null;
    return { applied: true };
  }
  const sup = proxySupport();
  if (!sup.ok) {
    current = null;
    return { applied: false, reason: sup.reason };
  }
  // A SOCKS proxy is set up differently (own agents, not Node's env proxy): start from a clean, direct state.
  if (current && (current.socks || p.socks)) applyProxy(null);
  const set = (http as any).setGlobalProxyFromEnv as (env: Record<string, string>) => () => void;
  if (!originals) {
    // undici creates its global dispatchers lazily (in a fresh process, e.g. Electron's main at startup, both slots
    // are still empty, and touching fetch does not fill them). A set + restore leaves direct Agents behind.
    if (g[S1] === undefined || g[S2] === undefined) set({ HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' })();
    originals = { s1: g[S1], s2: g[S2] };
  }
  const pick = (origin: any) => !!origin && !!upstreamFor(String(origin), { proxy: p });
  if (p.socks) {
    // 1) fetch: one undici Agent with a SOCKS connector behind the router; the legacy slot (undici 7 fetch in
    //    Electron's Node 24, undici 6/7 libraries) gets it through undici's own v1 wrapper.
    const lib = loadSocksLib();
    const agent = lib.socksDispatcher(socksProxyOf(p), { connect: { timeout: 15_000 } });
    if (originals.s1) g[S1] = router(originals.s1, new lib.Dispatcher1Wrapper(agent), pick);
    if (originals.s2) g[S2] = router(originals.s2, agent, pick);
    // 2) http(s).request without an own agent
    const prev = { http: http.globalAgent, https: https.globalAgent };
    const agents = socksAgents(p, { keepAlive: true });
    http.globalAgent = agents.http;
    https.globalAgent = agents.https;
    restoreNode = () => {
      http.globalAgent = prev.http;
      https.globalAgent = prev.https;
      agents.http.destroy();
      agents.https.destroy();
      void agent.close().catch(() => {});
    };
    current = p;
    return { applied: true };
  }
  const u = credUrl(p);
  // 1) dispatchers that send everything to the proxy (the router decides what goes there)
  const restore = set({ HTTP_PROXY: u, HTTPS_PROXY: u, NO_PROXY: '' });
  if (!restoreNode) restoreNode = restore;
  const p1 = g[S1];
  const p2 = g[S2];
  // 2) Node's own http(s) global agents with the no-proxy list
  set({ HTTP_PROXY: u, HTTPS_PROXY: u, NO_PROXY: toNodeNoProxy(p) });
  // 3) the router on undici's global dispatcher slots (".2" = undici 8 in Node 26, ".1" = undici 7 / legacy)
  const d1 = originals.s1;
  const d2 = originals.s2;
  if (p1 && d1) g[S1] = router(d1, p1, pick);
  if (p2 && d2) g[S2] = router(d2, p2, pick);
  // never leave a slot with Node's own NO_PROXY handling (no CIDR, no loopback range for fetch)
  if ((p1 && !d1) || (p2 && !d2)) {
    applyProxy(null);
    return { applied: false, reason: 'De proxy kon niet veilig worden ingesteld in deze Node-versie.' };
  }
  current = p;
  return { applied: true };
}

// ---------- CONNECT tunnels (browser chain, connection test) ----------

export type ProxyErrorCode = 'refused' | 'notfound' | 'timeout' | 'auth-required' | 'auth-failed' | 'forbidden' | 'upstream' | 'tls' | 'protocol' | 'other';

export class ProxyError extends Error {
  constructor(
    public code: ProxyErrorCode,
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

/** Plain-language error for a failed connection to/through the proxy. Never contains credentials. */
export function proxyErrorFrom(e: any, p: UpstreamProxy, target?: string): ProxyError {
  if (e instanceof ProxyError) return e;
  const msg = String(e?.message || e || '');
  // the socks library keeps only the message of a socket error ("connect ECONNREFUSED …")
  const code = String(e?.code || e?.cause?.code || msg.match(/\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EPIPE)\b/)?.[1] || '');
  if (p.socks && !code) {
    if (/authentication|auth/i.test(msg)) return p.username || p.password ? new ProxyError('auth-failed', 'De SOCKS-proxy weigert de gebruikersnaam of het wachtwoord.') : new ProxyError('auth-required', 'De SOCKS-proxy vraagt om een gebruikersnaam en wachtwoord. Vul ze in onder "Inloggen bij de proxy".');
    if (/NotAllowed|Rejected/i.test(msg)) return new ProxyError('forbidden', `De SOCKS-proxy staat ${target || 'dit adres'} niet toe.`);
    if (/Unreachable|ConnectionRefused|TTLExpired|Failure/i.test(msg)) return new ProxyError('upstream', `De SOCKS-proxy kon ${target || 'het adres'} niet bereiken.`);
    if (/timed out/i.test(msg)) return new ProxyError('timeout', `Geen antwoord van de proxy (${p.label}) op tijd.`);
    if (/Socket closed|Negotiation|Invalid|not supported/i.test(msg)) return new ProxyError('protocol', `De proxy (${p.label}) antwoordt niet als een SOCKS-proxy. Klopt het adres, en is het socks5:// of socks4://?`);
  }
  if (code === 'ECONNREFUSED') return new ProxyError('refused', `De proxy (${p.label}) weigert de verbinding. Klopt het adres en de poort, en draait de proxy?`);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new ProxyError('notfound', `De naam van de proxy (${p.url.hostname}) is niet te vinden. Controleer het adres.`);
  if (code === 'ETIMEDOUT' || (code === 'ECONNRESET' && /timeout/i.test(msg)) || /time-?out/i.test(msg)) return new ProxyError('timeout', `Geen antwoord van de proxy (${p.label}) op tijd.`);
  if (/CERT|SSL|TLS|self[- ]signed|certificate/i.test(code + ' ' + msg))
    return new ProxyError('tls', `De beveiligde verbinding${target ? ` met ${target}` : ''} lukt niet: het certificaat wordt niet vertrouwd. Onderschept je proxy het verkeer met een eigen certificaat? Dat ondersteunt TeamBot nog niet.`);
  if (code === 'ECONNRESET' || code === 'EPIPE') return new ProxyError('other', `De proxy (${p.label}) verbrak de verbinding.`);
  return new ProxyError('other', `Verbinding via de proxy mislukt: ${msg.replace(/\/\/[^@/\s]*@/g, '//').slice(0, 200)}`);
}

function statusError(status: number, p: UpstreamProxy, target: string): ProxyError {
  if (status === 407) return p.auth ? new ProxyError('auth-failed', `De proxy weigert de gebruikersnaam of het wachtwoord (407).`, 407) : new ProxyError('auth-required', `De proxy vraagt om een gebruikersnaam en wachtwoord (407). Vul ze in onder "Inloggen bij de proxy".`, 407);
  if (status === 403) return new ProxyError('forbidden', `De proxy staat ${target} niet toe (403).`, 403);
  if (status === 502 || status === 503 || status === 504) return new ProxyError('upstream', `De proxy kon ${target} niet bereiken (${status}).`, status);
  return new ProxyError('protocol', `De proxy antwoordde met ${status} in plaats van een verbinding.`, status);
}

function connectToProxy(p: UpstreamProxy, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const { host, port } = p;
    const sock: net.Socket = p.url.protocol === 'https:' ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host }) : net.connect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new ProxyError('timeout', `Geen antwoord van de proxy (${p.label}) binnen ${Math.round(timeoutMs / 1000)} seconden.`));
    }, timeoutMs);
    sock.once(p.url.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      reject(proxyErrorFrom(e, p));
    });
  });
}

/** Open a tunnel (CONNECT, or a SOCKS connect) to host:port through `p`. The returned socket carries the raw stream. */
export async function openTunnel(p: UpstreamProxy, host: string, port: number, o: { timeoutMs?: number } = {}): Promise<net.Socket> {
  const timeoutMs = o.timeoutMs ?? 15_000;
  if (p.socks) return socksSocket(p, host, port, timeoutMs);
  const sock = await connectToProxy(p, timeoutMs);
  const target = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new ProxyError('timeout', `Geen antwoord van de proxy (${p.label}) binnen ${Math.round(timeoutMs / 1000)} seconden.`)), timeoutMs);
    const fail = (e: ProxyError) => {
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.destroy();
      reject(e);
    };
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buf.length > 16_384) fail(new ProxyError('protocol', 'De proxy stuurde een ongeldig antwoord.'));
        return;
      }
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', onErr);
      const status = Number(buf.subarray(0, end).toString('latin1').match(/^HTTP\/1\.[01] (\d{3})/)?.[1] || 0);
      if (status !== 200) {
        sock.destroy();
        return reject(status ? statusError(status, p, host) : new ProxyError('protocol', 'De proxy stuurde een ongeldig antwoord.'));
      }
      const rest = buf.subarray(end + 4);
      if (rest.length) sock.unshift(rest);
      resolve(sock);
    };
    const onErr = (e: any) => fail(proxyErrorFrom(e, p, host));
    sock.on('data', onData);
    sock.once('error', onErr);
    sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${p.auth ? `Proxy-Authorization: ${p.auth}\r\n` : ''}\r\n`);
  });
}

const forwardAgents = new WeakMap<UpstreamProxy, http.Agent>();

/**
 * Options for http(s).request of a plain-http URL through the proxy: absolute-form request line to an HTTP proxy, or
 * a normal request over a SOCKS connection.
 */
export function forwardOptions(p: UpstreamProxy, target: URL, headers: http.OutgoingHttpHeaders = {}): http.RequestOptions & { secure: boolean } {
  if (p.socks) {
    let agent = forwardAgents.get(p);
    if (!agent) forwardAgents.set(p, (agent = socksAgents(p, { always: true }).http));
    return { host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port) || 80, path: target.pathname + target.search, headers: { ...headers, host: target.host }, agent, secure: false };
  }
  return {
    host: p.host,
    port: p.port,
    path: target.href,
    headers: { ...headers, host: target.host, ...(p.auth ? { 'proxy-authorization': p.auth } : {}) },
    agent: false,
    secure: p.url.protocol === 'https:',
  };
}

// ---------- "Verbinding testen" ----------

export interface ProxyTestResult {
  ok: boolean;
  message: string;
  status?: number;
  ms: number;
  code?: ProxyErrorCode;
}

/** Fetch `target` through `p` (always via the proxy, also for names on the no-proxy list) and say how it went. */
export async function testProxy(p: UpstreamProxy, target: string, o: { timeoutMs?: number } = {}): Promise<ProxyTestResult> {
  const t0 = Date.now();
  const timeoutMs = o.timeoutMs ?? 12_000;
  let u: URL;
  try {
    u = new URL(target);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('x');
  } catch {
    return { ok: false, message: 'Het testadres is geen geldige http(s)-link.', ms: 0, code: 'other' };
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const done = (res: http.IncomingMessage) => {
        res.resume();
        resolve(res.statusCode || 0);
      };
      let req: http.ClientRequest;
      if (u.protocol === 'https:') {
        const port = Number(u.port) || 443;
        openTunnel(p, host, port, { timeoutMs })
          .then((sock) => {
            const tlsSock = tls.connect({ socket: sock, servername: net.isIP(host) ? undefined : host });
            tlsSock.once('error', (e) => reject(proxyErrorFrom(e, p, host)));
            req = https.request({ host, port, path: u.pathname + u.search, method: 'GET', headers: { 'user-agent': 'TeamBot proxytest', accept: '*/*' }, createConnection: () => tlsSock, agent: false } as any, done);
            req.setTimeout(timeoutMs, () => req.destroy(new ProxyError('timeout', `Geen antwoord van ${host} binnen ${Math.round(timeoutMs / 1000)} seconden.`)));
            req.on('error', (e) => reject(proxyErrorFrom(e, p, host)));
            req.end();
          })
          .catch(reject);
        return;
      }
      const fo = forwardOptions(p, u, { 'user-agent': 'TeamBot proxytest', accept: '*/*' });
      req = (fo.secure ? https : http).request({ ...fo, method: 'GET', servername: fo.secure && !net.isIP(String(fo.host)) ? String(fo.host) : undefined } as any, (res) => {
        if (res.statusCode === 407) {
          res.resume();
          return reject(statusError(407, p, host));
        }
        done(res);
      });
      req.setTimeout(timeoutMs, () => req.destroy(new ProxyError('timeout', `Geen antwoord van de proxy (${p.label}) binnen ${Math.round(timeoutMs / 1000)} seconden.`)));
      req.on('error', (e) => reject(proxyErrorFrom(e, p, host)));
      req.end();
    });
    const ms = Date.now() - t0;
    if (!p.socks && !u.protocol.startsWith('https') && (status === 502 || status === 503 || status === 504)) {
      const e = statusError(status, p, host);
      return { ok: false, message: e.message, status, ms, code: e.code };
    }
    return { ok: true, message: `Gelukt: ${host} bereikt via de proxy in ${ms} ms (HTTP ${status}).`, status, ms };
  } catch (e: any) {
    const pe = proxyErrorFrom(e, p, host);
    return { ok: false, message: pe.message, status: pe.status, ms: Date.now() - t0, code: pe.code };
  }
}
