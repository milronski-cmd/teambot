import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { isInside as inside } from '../../tools/builtin/files.js';
import { TYPES } from './snapshot.js';

/**
 * The web server for published sites: a separate listener (own port = own origin), so a site can never read
 * TeamBot's login (the token lives in the app origin's localStorage) and the app's API is simply not there.
 * Every response also carries a CSP sandbox without allow-same-origin: the page gets an opaque origin, so it has no
 * cookies or storage at all and requests it makes carry no credentials. Only GET/HEAD of files in the site's own
 * snapshot, after strict path checks; who may connect depends on the site's reach (this computer, LAN, tailnet).
 */

export type Reach = 'local' | 'lan' | 'tailnet';

export interface ServedSite {
  id: string;
  token: string;
  reach: Reach;
  entry: string;
  /** Snapshot folder, or null when the site is not online (stopped, expired, unknown). */
  dir: string | null;
}

export const SITE_CSP = [
  'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads',
  "default-src 'self' https: data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' https: data: blob:",
  "font-src 'self' https: data:",
  "media-src 'self' https: data: blob:",
  // never http: — TeamBot itself (http://127.0.0.1:4747, a LAN address) is not reachable from a site
  "connect-src 'self' https:",
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

const BASE_HEADERS: Record<string, string> = {
  'Content-Security-Policy': SITE_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-cache',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // the sandboxed page has an opaque origin; its own module scripts / fetch('data.json') need this (no credentials)
  'Access-Control-Allow-Origin': '*',
};

const v4 = (ip: string) => ip.replace(/^::ffff:/i, '');
const inRange = (ip: string, list: [string, number][]) => {
  const b = new net.BlockList();
  for (const [a, p] of list) b.addSubnet(a, p, net.isIPv6(a) ? 'ipv6' : 'ipv4');
  return net.isIPv4(ip) ? b.check(ip, 'ipv4') : net.isIPv6(ip) ? b.check(ip, 'ipv6') : false;
};
export function isLoopbackIp(ip: string): boolean {
  const a = v4(ip);
  return (net.isIPv4(a) && a.startsWith('127.')) || a === '::1';
}

/** May a client at `remote` see a site with this reach? Loopback (the computer itself) may always. */
export function allowedFrom(reach: Reach, remote: string | undefined): boolean {
  const ip = v4(String(remote || ''));
  if (!net.isIP(ip)) return false;
  if (isLoopbackIp(ip)) return true;
  if (reach === 'lan')
    return inRange(ip, [
      ['10.0.0.0', 8],
      ['172.16.0.0', 12],
      ['192.168.0.0', 16],
      ['169.254.0.0', 16],
      ['fc00::', 7],
      ['fe80::', 10],
    ]);
  if (reach === 'tailnet')
    return inRange(ip, [
      ['100.64.0.0', 10],
      ['fd7a:115c:a1e0::', 48],
    ]);
  return false;
}

const page = (title: string, text: string) =>
  `<!doctype html><html lang="nl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1.25rem;color:#222;line-height:1.5"><h1 style="font-size:1.35rem">${title}</h1><p>${text}</p></body></html>`;

const REACH_TEXT: Record<Reach, string> = {
  local: 'Deze site is alleen te openen op de computer waarop TeamBot draait.',
  lan: 'Deze site is alleen te openen op het eigen netwerk van de eigenaar.',
  tailnet: 'Deze site is alleen te openen via het tailnet (Tailscale) van de eigenaar.',
};

/** Split /s/<token>/<rest> into clean path segments; null when anything looks off (traversal, dotfiles, ADS, …). */
export function parseSitePath(pathname: string): { token: string; segments: string[]; dirSlash: boolean } | null {
  const m = pathname.match(/^\/s\/([A-Za-z0-9_-]{16,64})(\/.*)?$/);
  if (!m) return null;
  const rest = m[2] ?? '';
  const raw = rest.split('/').slice(1);
  const segments: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    let s: string;
    try {
      s = decodeURIComponent(raw[i]);
    } catch {
      return null;
    }
    if (s === '' && i === raw.length - 1) continue; // trailing slash
    if (!s || s === '.' || s === '..' || s.startsWith('.') || /[\\/:*?"<>|\0]/.test(s) || /[\x00-\x1f]/.test(s)) return null;
    segments.push(s);
  }
  return { token: m[1], segments, dirSlash: rest === '' ? false : rest.endsWith('/') };
}

export class SitesServer {
  private server: http.Server | null = null;
  private sockets = new Set<net.Socket>();
  host = '';
  port = 0;

  constructor(
    private o: {
      lookup(token: string): ServedSite | null;
      onView?(site: ServedSite): void;
      log?: { warn(...a: any[]): void };
    },
  ) {}

  get listening() {
    return !!this.server;
  }

  /** Listen on host:port (re-binds when the host changes). Falls back to a free port when `port` is taken and `fallback` is set. */
  async listen(host: string, port: number, fallback = true): Promise<{ host: string; port: number }> {
    if (this.server && this.host === host && (this.port === port || !port)) return { host, port: this.port };
    await this.close();
    const server = http.createServer((req, res) => this.handle(req, res));
    server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    server.on('clientError', (_e, s) => s.destroy());
    const tryListen = (p: number) =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    try {
      await tryListen(port);
    } catch (e: any) {
      if (!(fallback && e?.code === 'EADDRINUSE' && port)) throw e;
      await tryListen(0);
    }
    this.server = server;
    this.host = host;
    this.port = (server.address() as net.AddressInfo).port;
    return { host, port: this.port };
  }

  async close() {
    const s = this.server;
    this.server = null;
    for (const sock of this.sockets) sock.destroy();
    this.sockets.clear();
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  private send(res: http.ServerResponse, status: number, title: string, text: string, extra: Record<string, string> = {}) {
    const body = page(title, text);
    res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(Buffer.byteLength(body)), ...extra });
    res.end(res.req?.method === 'HEAD' ? undefined : body);
  }

  handle(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      this.serve(req, res);
    } catch (e) {
      this.o.log?.warn('[sites] verzoek mislukt', e);
      if (!res.headersSent) this.send(res, 500, 'Er ging iets mis', 'Deze pagina kon niet worden geladen.');
      else res.destroy();
    }
  }

  private serve(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.send(res, 405, 'Niet toegestaan', 'Een gepubliceerde site kan alleen bekeken worden.', { Allow: 'GET, HEAD' });
    // a site may not install a service worker (it would outlive "stoppen")
    if (req.headers['service-worker']) return this.send(res, 403, 'Niet toegestaan', 'Service workers zijn uitgeschakeld voor gepubliceerde sites.');
    let pathname: string;
    try {
      pathname = new URL(req.url || '/', 'http://x').pathname;
    } catch {
      return this.send(res, 400, 'Ongeldige link', 'Deze link klopt niet.');
    }
    const parsed = parseSitePath(pathname);
    const notFound = () => this.send(res, 404, 'Niet gevonden', 'Deze site bestaat niet (meer), of de link is niet compleet. Vraag de eigenaar om een nieuwe link.');
    if (!parsed) return notFound();
    const site = this.o.lookup(parsed.token);
    if (!site || !site.dir) return notFound();
    if (!allowedFrom(site.reach, req.socket.remoteAddress)) return this.send(res, 403, 'Niet bereikbaar vanaf hier', REACH_TEXT[site.reach]);
    if (pathname === `/s/${parsed.token}`) {
      res.writeHead(301, { ...BASE_HEADERS, Location: `/s/${parsed.token}/` });
      return res.end();
    }
    let segments = parsed.segments;
    if (!segments.length) segments = site.entry.split('/');
    const root = site.dir;
    let file = path.join(root, ...segments);
    if (!inside(file, root)) return notFound();
    let st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (st?.isDirectory()) {
      if (!parsed.dirSlash) {
        res.writeHead(301, { ...BASE_HEADERS, Location: `/s/${parsed.token}/${segments.map(encodeURIComponent).join('/')}/` });
        return res.end();
      }
      file = path.join(file, 'index.html');
      st = fs.lstatSync(file, { throwIfNoEntry: false });
    }
    if (!st || !st.isFile() || st.isSymbolicLink()) return notFound();
    const type = TYPES[path.extname(file).toLowerCase()];
    if (!type) return notFound();
    const headers: Record<string, string> = { ...BASE_HEADERS, 'Content-Type': type, 'Content-Length': String(st.size), 'Last-Modified': st.mtime.toUTCString() };
    if (type === 'application/zip' || type === 'application/pdf') headers['Content-Disposition'] = 'inline';
    if (req.headers['if-modified-since'] && Date.parse(String(req.headers['if-modified-since'])) >= Math.floor(st.mtimeMs / 1000) * 1000) {
      res.writeHead(304, BASE_HEADERS);
      return res.end();
    }
    if (type.startsWith('text/html')) this.o.onView?.(site);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
}
