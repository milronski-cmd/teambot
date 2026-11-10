import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { checkUrl, defaultResolver, type Resolver, type UrlPolicy } from './policy.js';
import { forwardOptions, looksLocalName, openTunnel, upstreamFor, type UpstreamProxy } from '../network/proxy.js';

/**
 * Local policy-enforcing forward proxy for the bot browsers. Every request of a bot browser
 * (navigations, redirect hops, sub-resources, fetch/XHR, WebSockets, downloads) passes through
 * here, so private/loopback addresses and denied domains are blocked at connection level.
 * We connect to the address we resolved and checked ourselves, which also defeats DNS rebinding.
 * Each browser session gets its own credentials; requests without them get 407.
 *
 * The owner's proxy (Instellingen › Netwerk en proxy, "ook de browser"): this proxy stays the first hop and makes
 * every check above, then chains to the owner's proxy — CONNECT host:port for https/WebSockets, an absolute-form
 * request for plain http — with the owner's proxy login added here (Chromium never sees it). Hosts on the no-proxy
 * list and loopback go direct. A public-looking name that local DNS cannot resolve is left to the owner's proxy (in
 * such networks only the proxy can look names up); a name that resolves to a private address stays blocked.
 *
 * A browser profile can have its own proxy (Computers › Browserprofielen › Proxy, 0.4.4): then that session chains to
 * the profile's proxy instead of the owner's, in exactly the same way (checks first, login added here, loopback
 * direct). Other profiles and the rest of TeamBot are not affected.
 */

interface ProxyClient {
  policy: () => UrlPolicy;
  onBlock: (url: string, reason: string) => void;
  /**
   * The browser profile's own proxy (Computers › Browserprofielen › Proxy): used instead of the owner's proxy for this
   * session only, with the same checks first. null/undefined = the owner's proxy (when it is on for the browser).
   */
  upstream?: () => UpstreamProxy | null;
}

const LOGIN_REFUSED = {
  owner: 'De proxy van de eigenaar weigert de inloggegevens. Controleer ze in Instellingen › Netwerk en proxy.',
  profile: 'De proxy van dit browserprofiel weigert de inloggegevens. Controleer ze bij Computers › Browserprofielen › Proxy.',
};

export class PolicyProxy {
  private server: http.Server | null = null;
  private starting: Promise<number> | null = null;
  private clients = new Map<string, ProxyClient>();
  private sockets = new Set<net.Socket>();
  port = 0;

  constructor(private resolver?: Resolver) {}

  register(c: ProxyClient): { username: string; password: string } {
    const username = 'tb' + crypto.randomBytes(6).toString('hex');
    const password = crypto.randomBytes(18).toString('base64url');
    this.clients.set(Buffer.from(`${username}:${password}`).toString('base64'), c);
    return { username, password };
  }

  unregister(username: string) {
    for (const k of [...this.clients.keys()]) if (Buffer.from(k, 'base64').toString().startsWith(username + ':')) this.clients.delete(k);
  }

  private client(req: http.IncomingMessage): ProxyClient | null {
    const h = req.headers['proxy-authorization'];
    if (!h || !h.startsWith('Basic ')) return null;
    return this.clients.get(h.slice(6).trim()) || null;
  }

  /** Resolve + check a host, returning the address we will connect to (or the owner's proxy to go through). */
  private async decide(c: ProxyClient, url: string): Promise<{ ok: true; address: string | null; via: UpstreamProxy | null; own: boolean } | { ok: false; reason: string }> {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    const resolver = this.resolver || defaultResolver;
    const mine = c.upstream?.() || null;
    const via = mine ? upstreamFor(url, { proxy: mine }) : upstreamFor(url, { browser: true });
    const own = !!mine && via === mine;
    let addrs: string[] | null = net.isIP(host) ? [host] : null;
    let dnsFailed = false;
    const lookup = async (h: string) => {
      try {
        return (addrs = await resolver(h));
      } catch (e) {
        dnsFailed = true;
        throw e;
      }
    };
    const r = await checkUrl(url, c.policy(), { navigation: false, resolver: lookup });
    if (!r.ok) {
      if (dnsFailed && via && !looksLocalName(host)) return { ok: true, address: null, via, own };
      return { ok: false, reason: r.reason || 'Geblokkeerd' };
    }
    // allowPrivate skips DNS inside checkUrl; still connect to a concrete, resolved address
    if (!addrs) {
      try {
        addrs = await resolver(host);
      } catch (e) {
        if (via) return { ok: true, address: null, via, own };
        throw e;
      }
    }
    const list: string[] = addrs || [];
    if (!list.length) return { ok: false, reason: `Kan ${host} niet opzoeken` };
    return { ok: true, address: list[0], via, own };
  }

  start(): Promise<number> {
    if (this.server) return Promise.resolve(this.port);
    if (this.starting) return this.starting;
    const server = http.createServer((req, res) => this.onRequest(req, res));
    server.on('connect', (req, sock: net.Socket, head) => this.onConnect(req, sock, head));
    server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    this.starting = new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        this.port = (server.address() as net.AddressInfo).port;
        resolve(this.port);
      });
    });
    return this.starting;
  }

  async stop() {
    const s = this.server;
    this.server = null;
    this.starting = null;
    for (const sock of this.sockets) sock.destroy();
    this.sockets.clear();
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  private deny407(res: http.ServerResponse) {
    res.writeHead(407, { 'proxy-authenticate': 'Basic realm="teambot"', 'content-type': 'text/plain' });
    res.end('Proxy authentication required');
  }

  private blockedPage(res: http.ServerResponse, reason: string) {
    res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><title>Geblokkeerd door TeamBot</title><body style="font-family:sans-serif;padding:2em"><h1>Geblokkeerd door TeamBot</h1><p>${escapeHtml(reason)}</p></body>`);
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const c = this.client(req);
    if (!c) return this.deny407(res);
    let url: URL;
    try {
      url = new URL(req.url || '');
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400);
      return res.end();
    }
    let d: Awaited<ReturnType<PolicyProxy['decide']>>;
    try {
      d = await this.decide(c, url.href);
    } catch (e: any) {
      d = { ok: false, reason: `Kan ${url.hostname} niet opzoeken` };
    }
    if (!d.ok) {
      c.onBlock(url.href, d.reason);
      return this.blockedPage(res, d.reason);
    }
    const { via, address, own } = d;
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const onResponse = (r: http.IncomingMessage) => {
      if (via && r.statusCode === 407) {
        // the owner's (or the profile's) proxy wants a (different) login: never let Chromium ask for it
        r.resume();
        const why = own ? LOGIN_REFUSED.profile : LOGIN_REFUSED.owner;
        c.onBlock(url.href, `${why.split('.')[0]} (407)`);
        return this.blockedPage(res, why);
      }
      const h = { ...r.headers };
      delete h['proxy-authenticate'];
      res.writeHead(r.statusCode || 502, h);
      r.pipe(res);
    };
    // agent: false — never Node's (possibly proxy-aware) global agent; the route is decided here
    const up = via
      ? (() => {
          const fo = forwardOptions(via, url, headers);
          return (fo.secure ? https : http).request({ ...fo, method: req.method }, onResponse);
        })()
      : http.request({ host: address!, port: Number(url.port) || 80, path: url.pathname + url.search, method: req.method, headers, setHost: false, agent: false }, onResponse);
    up.setTimeout(60_000, () => up.destroy(new Error('timeout')));
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end();
    });
    req.pipe(up);
  }

  private async onConnect(req: http.IncomingMessage, sock: net.Socket, head: Buffer) {
    sock.on('error', () => {});
    const c = this.client(req);
    if (!c) {
      sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="teambot"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const [host, portStr] = splitHostPort(req.url || '');
    const port = Number(portStr) || 443;
    const scheme = port === 80 ? 'http' : 'https';
    let d: Awaited<ReturnType<PolicyProxy['decide']>>;
    try {
      d = await this.decide(c, `${scheme}://${host.includes(':') ? `[${host}]` : host}:${port}/`);
    } catch {
      d = { ok: false, reason: `Kan ${host} niet opzoeken` };
    }
    if (!d.ok) {
      c.onBlock(`${scheme}://${host}:${port}`, d.reason);
      sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const pipe = (up: net.Socket) => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    };
    const { via, address } = d;
    if (via) {
      let up: net.Socket;
      try {
        up = await openTunnel(via, host, port);
      } catch (e: any) {
        c.onBlock(`${scheme}://${host}:${port}`, `Via de proxy niet bereikbaar: ${String(e?.message || e)}`);
        sock.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      if (sock.destroyed) return void up.destroy();
      pipe(up);
      up.setTimeout(120_000, () => up.destroy());
      up.on('error', () => sock.destroy());
      sock.on('close', () => up.destroy());
      return;
    }
    const up = net.connect({ host: address!, port }, () => pipe(up));
    up.setTimeout(120_000, () => up.destroy());
    up.on('error', () => sock.destroy());
    sock.on('close', () => up.destroy());
  }
}

function splitHostPort(s: string): [string, string] {
  const m = s.match(/^\[([^\]]+)\]:(\d+)$/) || s.match(/^([^:]+):(\d+)$/);
  return m ? [m[1], m[2]] : [s, ''];
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
