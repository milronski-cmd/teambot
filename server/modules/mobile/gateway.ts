import http from 'node:http';
import net from 'node:net';
import type { Ctx } from '../../core/types.js';

export type GatewayBind = 'all' | 'tailscale' | 'loopback';

export interface GatewayState {
  running: boolean;
  address: string | null;
  port: number | null;
  error: string | null;
}

/** Public routes a phone needs before it has a token. Everything else under /api/public stays local. */
const PUBLIC_OK = (p: string) => p === '/api/public/status' || p === '/api/public/pair' || p.startsWith('/api/public/mobile/');

function tokenOf(req: http.IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  const c = req.headers.cookie?.split(';').map((x) => x.trim()).find((x) => x.startsWith('tb_token='));
  return c ? decodeURIComponent(c.slice(9)) : null;
}

function refuse(res: http.ServerResponse, status: number, error: string) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error, code: 'gateway' }));
}

/**
 * Opt-in "phone gateway": a second listener (LAN / Tailscale / loopback for a tunnel) in front of the
 * loopback-only main server. It forwards only what a paired phone needs:
 *  - the static app shell (GET/HEAD), the public pairing routes,
 *  - /api/* and /ws with a *device* token. The desktop owner token and password logins never work here.
 * The main server's device policy still applies on top (default deny).
 */
export class Gateway {
  state: GatewayState = { running: false, address: null, port: null, error: null };
  private server: http.Server | null = null;
  private sockets = new Set<net.Socket>();

  /**
   * `peerAddress`: who is on the other end of a socket when that is not its TCP address (the TeamBot connection in
   * iroh.ts reaches this gateway over loopback; its phones get a stable address of their own, so rate limits and the
   * audit log tell them apart).
   */
  constructor(
    private ctx: Ctx,
    private opts: { peerAddress?(socket: net.Socket): string | undefined } = {},
  ) {}

  private peer(socket: net.Socket): string {
    return this.opts.peerAddress?.(socket) || socket.remoteAddress || '';
  }

  private upstream() {
    const h = this.ctx.config.host;
    return { host: !h || h === '0.0.0.0' || h === '::' ? '127.0.0.1' : h, port: this.ctx.config.port };
  }

  /** 'ok' = live device token; 'unknown' (→ 401, so the app signs out) = missing/revoked; 'other' (→ 403) = not a device session. */
  private tokenKind(token: string | null, method?: string, pathAndQuery?: string): 'ok' | 'unknown' | 'other' {
    // A bearer token, or a signed URL for images, downloads and the WebSocket (never the token in the URL).
    const r = this.ctx.auth.resolve(token) || (pathAndQuery ? this.ctx.auth.resolveSigned(method, pathAndQuery) : null);
    if (!r) return 'unknown';
    return r.session.kind === 'device' ? 'ok' : 'other';
  }

  /** Validate a request path. Returns the normalized path+query to forward, or an error. */
  private check(req: http.IncomingMessage): { url: URL; path: string } | { status: number; error: string } {
    const raw = req.url || '';
    if (!raw.startsWith('/') || raw.startsWith('//')) return { status: 400, error: 'Ongeldig pad' };
    let url: URL;
    try {
      url = new URL(raw, 'http://gateway.local');
    } catch {
      return { status: 400, error: 'Ongeldig pad' };
    }
    return { url, path: url.pathname + url.search };
  }

  private handle = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const c = this.check(req);
    if ('status' in c) return refuse(res, c.status, c.error);
    const p = c.url.pathname.toLowerCase();
    if (p === '/api' || p.startsWith('/api/')) {
      if (p.startsWith('/api/public/') || p === '/api/public') {
        if (!PUBLIC_OK(p)) return refuse(res, 403, 'Niet beschikbaar via de telefoon-toegang');
      } else {
        const k = this.tokenKind(tokenOf(req), req.method, c.path);
        if (k === 'unknown') return refuse(res, 401, 'Niet ingelogd');
        if (k === 'other') return refuse(res, 403, 'Via de telefoon-toegang werken alleen gekoppelde apparaten. Koppel je telefoon via Instellingen → Telefoon.');
      }
    } else if (p === '/ws' || p === '/ws/voice') {
      return refuse(res, 400, 'Alleen WebSocket');
    } else if (req.method !== 'GET' && req.method !== 'HEAD') {
      return refuse(res, 405, 'Niet toegestaan');
    }
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    for (const k of Object.keys(headers)) if (k.startsWith('x-forwarded-') || k === 'forwarded') delete headers[k];
    headers['x-forwarded-for'] = this.peer(req.socket);
    headers['x-forwarded-proto'] = 'http';
    const up = http.request({ ...this.upstream(), method: req.method, path: c.path, headers }, (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers);
      ur.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) refuse(res, 502, 'TeamBot reageert niet');
      else res.destroy();
    });
    req.pipe(up);
  };

  private upgrade = (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const c = this.check(req);
    // /ws (live events) and /ws/voice (audio of a free live call), both with a signed device URL.
    const k = 'status' in c || !['/ws', '/ws/voice'].includes(c.url.pathname.toLowerCase()) ? 'other' : this.tokenKind(null, 'GET', c.path);
    if ('status' in c || k !== 'ok') {
      socket.end(k === 'unknown' ? 'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n' : 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const { host, port } = this.upstream();
    const up = net.connect(port, host, () => {
      let raw = `${req.method} ${c.path} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i].toLowerCase();
        if (k.startsWith('x-forwarded-') || k === 'forwarded') continue;
        raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      raw += `X-Forwarded-For: ${this.peer(socket)}\r\n\r\n`;
      up.write(raw);
      if (head?.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    this.sockets.add(up);
    up.on('close', () => this.sockets.delete(up));
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
    socket.on('close', () => up.destroy());
  };

  async start(address: string, port: number): Promise<GatewayState> {
    await this.stop();
    const server = http.createServer(this.handle);
    server.on('upgrade', this.upgrade);
    server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, address, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (e: any) {
      this.state = { running: false, address, port, error: e?.code === 'EADDRINUSE' ? `Poort ${port} is al in gebruik` : e?.code === 'EADDRNOTAVAIL' ? `Adres ${address} bestaat niet (meer) op deze computer` : String(e?.message || e) };
      return this.state;
    }
    const a = server.address();
    this.server = server;
    this.state = { running: true, address, port: typeof a === 'object' && a ? a.port : port, error: null };
    return this.state;
  }

  async stop() {
    const s = this.server;
    this.server = null;
    this.state = { ...this.state, running: false };
    if (!s) return;
    for (const sock of this.sockets) sock.destroy();
    this.sockets.clear();
    await new Promise<void>((r) => s.close(() => r()));
  }
}
