import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { Upstream } from './provisioner/types.js';

/**
 * Small reverse proxy on node:http for HTTP and WebSocket upgrades. It is the only path from the internet to an
 * instance, so it normalises everything an instance may trust:
 * - X-Forwarded-For/Proto/Host and Forwarded are overwritten (never appended from client input);
 * - control-plane cookies (tbc_*) are removed from requests and from instance responses;
 * - Set-Cookie from instances loses any Domain attribute (host-only: a workspace cannot set cookies for the apex or
 *   for other workspaces);
 * - hop-by-hop headers are dropped.
 */

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const FORWARDING = new Set(['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-prefix', 'x-forwarded-server', 'x-real-ip', 'x-original-url', 'x-rewrite-url', 'x-original-host', 'true-client-ip', 'cf-connecting-ip']);

/** Control-plane cookies (session, CSRF, claim) — never forwarded to or accepted from instances. */
export const CONTROL_COOKIE = /^(__Host-|__Secure-)?tbc_/i;

const agent = new http.Agent({ keepAlive: true, maxSockets: 512, timeout: 60_000 });

function isLoopback(ip: string | undefined) {
  if (!ip) return false;
  const a = ip.replace(/^::ffff:/i, '');
  return a === '::1' || /^127\./.test(a);
}

/** Is this peer allowed to tell us the client address (CLOUD_TRUST_PROXY)? */
export function trusted(ip: string | undefined, trust: string[]): boolean {
  if (!ip) return false;
  const a = ip.replace(/^::ffff:/i, '');
  return trust.some((t) => (t === 'loopback' ? isLoopback(a) : t === a));
}

/** Client address: the socket peer, or — only behind a trusted proxy — the right-most untrusted X-Forwarded-For entry. */
export function clientAddress(req: http.IncomingMessage, trust: string[]): string {
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/i, '');
  if (!trusted(peer, trust)) return peer;
  const xff = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => net.isIP(s.replace(/^::ffff:/i, '')));
  for (let i = xff.length - 1; i >= 0; i--) {
    const a = xff[i].replace(/^::ffff:/i, '');
    if (!trusted(a, trust)) return a;
  }
  return xff[0]?.replace(/^::ffff:/i, '') || peer;
}

/** Scheme the client used: from a trusted proxy's X-Forwarded-Proto, else the configured default. */
export function clientProto(req: http.IncomingMessage, trust: string[], fallback: 'http' | 'https'): 'http' | 'https' {
  if (trusted(req.socket.remoteAddress, trust)) {
    const p = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (p === 'http' || p === 'https') return p;
  }
  return fallback;
}

export function stripControlCookies(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const kept = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !CONTROL_COOKIE.test(c.split('=')[0].trim()));
  return kept.length ? kept.join('; ') : undefined;
}

/** Make an instance's Set-Cookie host-only and drop anything that looks like a control-plane cookie. */
export function rewriteSetCookie(values: string[] | undefined): string[] | undefined {
  if (!values?.length) return undefined;
  const out = values
    .filter((v) => !CONTROL_COOKIE.test(v.split('=')[0].trim()))
    .map((v) =>
      v
        .split(';')
        .filter((part, i) => i === 0 || !/^\s*domain\s*=/i.test(part))
        .join(';'),
    );
  return out.length ? out : undefined;
}

export interface ForwardInfo {
  clientIp: string;
  proto: 'http' | 'https';
  host: string;
}

/** Headers sent to the instance. */
export function requestHeaders(req: http.IncomingMessage, fwd: ForwardInfo, upgrade = false): http.OutgoingHttpHeaders {
  const connectionTokens = String(req.headers.connection || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (v === undefined || FORWARDING.has(key) || key === 'cookie' || key === 'host' || key.startsWith('x-cloud-') || key === 'x-teambot-setup-token') continue;
    if (HOP_BY_HOP.has(key) || connectionTokens.includes(key)) continue;
    out[key] = v;
  }
  const cookie = stripControlCookies(req.headers.cookie);
  if (cookie) out.cookie = cookie;
  out.host = fwd.host;
  out['x-forwarded-for'] = fwd.clientIp;
  out['x-forwarded-proto'] = fwd.proto;
  out['x-forwarded-host'] = fwd.host;
  if (upgrade) {
    out.connection = 'Upgrade';
    out.upgrade = String(req.headers.upgrade || 'websocket');
  }
  return out;
}

/** Headers sent back to the client. */
export function responseHeaders(headers: http.IncomingHttpHeaders, extraSetCookie: string[] = []): http.OutgoingHttpHeaders {
  const connectionTokens = String(headers.connection || '')
    .split(',')
    .map((s) => s.trim().toLowerCase());
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || HOP_BY_HOP.has(k) || connectionTokens.includes(k) || k === 'set-cookie') continue;
    out[k] = v;
  }
  const cookies = [...(rewriteSetCookie(headers['set-cookie']) || []), ...extraSetCookie];
  if (cookies.length) out['set-cookie'] = cookies;
  return out;
}

export interface ProxyOpts {
  headers: http.OutgoingHttpHeaders;
  maxBodyBytes: number;
  /** Called with the instance's status code before the response is streamed. */
  onResponse?(status: number): void;
  extraSetCookie?: string[];
  onError(res: http.ServerResponse, status: number): void;
}

export function proxyHttp(req: http.IncomingMessage, res: http.ServerResponse, target: Upstream, o: ProxyOpts) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > o.maxBodyBytes) return o.onError(res, 413);
  const preq = http.request({ host: target.host, port: target.port, method: req.method, path: req.url, headers: o.headers, agent });
  let done = false;
  preq.on('response', (pres) => {
    o.onResponse?.(pres.statusCode || 502);
    res.writeHead(pres.statusCode || 502, pres.statusMessage, responseHeaders(pres.headers, o.extraSetCookie));
    pres.pipe(res);
    pres.on('end', () => (done = true));
  });
  preq.on('error', () => {
    if (!res.headersSent) o.onError(res, 502);
    else res.destroy();
  });
  // A client that goes away (e.g. closes an event stream) must not keep the upstream request open.
  res.on('close', () => {
    if (!done) preq.destroy();
  });
  let seen = 0;
  req.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > o.maxBodyBytes) {
      req.unpipe(preq);
      preq.destroy();
      if (!res.headersSent) o.onError(res, 413);
      req.resume();
    }
  });
  req.pipe(preq);
}

function writeHead(socket: Duplex, status: number, message: string, rawHeaders: string[]) {
  let head = `HTTP/1.1 ${status} ${message}\r\n`;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const k = rawHeaders[i];
    const v = rawHeaders[i + 1];
    if (/^set-cookie$/i.test(k)) {
      const rewritten = rewriteSetCookie([v]);
      if (rewritten) head += `${k}: ${rewritten[0]}\r\n`;
      continue;
    }
    head += `${k}: ${v}\r\n`;
  }
  socket.write(head + '\r\n');
}

/** Proxy a WebSocket (or other) upgrade. Non-101 answers (e.g. 401) are relayed as-is. */
export function proxyUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, target: Upstream, headers: http.OutgoingHttpHeaders) {
  const fail = (status = 502, msg = 'Bad Gateway') => {
    if (socket.writable) socket.end(`HTTP/1.1 ${status} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    else socket.destroy();
  };
  socket.on('error', () => socket.destroy());
  const preq = http.request({ host: target.host, port: target.port, method: req.method, path: req.url, headers });
  preq.setTimeout(15_000, () => preq.destroy());
  preq.on('upgrade', (pres, psock, phead) => {
    psock.on('error', () => socket.destroy());
    socket.on('close', () => psock.destroy());
    psock.on('close', () => socket.destroy());
    if ('setNoDelay' in socket) (socket as net.Socket).setNoDelay(true);
    psock.setNoDelay(true);
    preq.setTimeout(0);
    writeHead(socket, 101, pres.statusMessage || 'Switching Protocols', pres.rawHeaders);
    if (phead?.length) socket.write(phead);
    if (head?.length) psock.write(head);
    psock.pipe(socket);
    socket.pipe(psock);
  });
  preq.on('response', (pres) => {
    const raw: string[] = [];
    for (let i = 0; i < pres.rawHeaders.length; i += 2) if (!HOP_BY_HOP.has(pres.rawHeaders[i].toLowerCase())) raw.push(pres.rawHeaders[i], pres.rawHeaders[i + 1]);
    raw.push('Connection', 'close');
    writeHead(socket, pres.statusCode || 502, pres.statusMessage || '', raw);
    pres.pipe(socket);
  });
  preq.on('error', () => fail());
  preq.end();
}
