import type http from 'node:http';
import type { Duplex } from 'node:stream';
import type { CloudConfig } from './config.js';
import type { RouteInfo, WorkspaceService } from './workspaces.js';
import { clientAddress, clientProto, proxyHttp, proxyUpgrade, requestHeaders, trusted, type ForwardInfo } from './proxy.js';
import { html, simplePage } from './web/html.js';
import { isValidSlug, type Log } from './util.js';

/**
 * The single public entry point. `<CLOUD_DOMAIN>` → control plane; `<slug>.<CLOUD_DOMAIN>` → that workspace's
 * instance (HTTP + WebSocket). The target is chosen only from the Host header's first label, after validating it as a
 * slug; nothing else in the request (paths, X-Forwarded-Host, absolute URLs) can select another workspace.
 */

export type HostKind = { kind: 'control' } | { kind: 'workspace'; slug: string } | { kind: 'other' } | { kind: 'bad' };

export function classifyHost(hostHeader: string | undefined, domain: string): HostKind {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h || h.length > 255) return { kind: 'bad' };
  const m = /^([a-z0-9.-]+?)\.?(?::(\d{1,5}))?$/.exec(h);
  if (!m) return { kind: 'bad' };
  const host = m[1];
  if (host === domain) return { kind: 'control' };
  const suffix = '.' + domain;
  if (!host.endsWith(suffix)) return { kind: 'other' };
  const label = host.slice(0, -suffix.length);
  // Exactly one label: "x.a.<domain>" never routes to "a".
  if (!label || label.includes('.') || !isValidSlug(label)) return { kind: 'other' };
  return { kind: 'workspace', slug: label };
}

/**
 * Normalise a request path the way any router might interpret it (decode, backslashes, duplicate slashes, dot
 * segments, case, trailing slash). Used for deny checks so that no spelling of a blocked path slips through.
 */
export function normalizePath(url: string): string | null {
  let p = url.split('?')[0].split('#')[0];
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(p);
    } catch {
      return null;
    }
    if (next === p) break;
    p = next;
  }
  p = p.replace(/\\/g, '/').toLowerCase();
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

const SETUP_PATH = '/api/public/setup';
const CLAIM_PATH = '/_cloud/claim';

function cookieValue(req: http.IncomingMessage, name: string): string | null {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function createRouter(d: { cfg: CloudConfig; workspaces: WorkspaceService; control: http.RequestListener; log: Log }) {
  const { cfg } = d;
  const claimCookie = cfg.cookieSecure ? '__Host-tbc_claim' : 'tbc_claim';

  const securityHeaders = (res: http.ServerResponse) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
  };

  /** Friendly answer from the router itself: HTML for browsers, JSON for API clients. */
  const answer = (req: http.IncomingMessage, res: http.ServerResponse, status: number, title: string, text: string, extra?: ReturnType<typeof html>) => {
    if (res.headersSent) return res.destroy();
    securityHeaders(res);
    const wantsHtml = String(req.headers.accept || '').includes('text/html');
    if (!wantsHtml) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: `${title}. ${text}` }));
    }
    if (status === 503) res.setHeader('Retry-After', '10');
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(simplePage(title, html`<h1>${title}</h1><p>${text}</p>${extra || ''}`, cfg.url));
  };

  const unknown = (req: http.IncomingMessage, res: http.ServerResponse) =>
    answer(req, res, 404, 'Deze TeamBot bestaat niet (meer)', 'Controleer het adres. Heb je een workspace? Je vindt het juiste adres in je dashboard.', html`<p><a class="btn" href="${cfg.url}/dashboard">Naar je dashboard</a></p>`);

  /** Answers for every non-routable state. Returns true when it answered. */
  const gate = (req: http.IncomingMessage, res: http.ServerResponse, route: RouteInfo | null): boolean => {
    // Dedicated workspaces run on the customer's own address; our subdomain neither proxies nor reveals it.
    if (!route || route.dedicated || route.status === 'deleted' || route.status === 'deleting') {
      unknown(req, res);
      return true;
    }
    if (route.status === 'suspended') {
      answer(
        req,
        res,
        503,
        'Deze TeamBot is gepauzeerd',
        'Gepauzeerd — betaling/beheer. Je gegevens blijven bewaard. Ben je de eigenaar? Regel je abonnement in je dashboard; daarna start je TeamBot vanzelf weer.',
        html`<p><a class="btn primary" href="${cfg.url}/dashboard">Naar je dashboard</a></p>`,
      );
      return true;
    }
    if (route.status === 'provisioning') {
      answer(req, res, 503, 'Je TeamBot wordt klaargezet', 'Dat duurt meestal een paar seconden. Ververs de pagina zo.');
      return true;
    }
    if (!route.upstream) {
      answer(req, res, 503, 'Je TeamBot start op', 'Probeer het over een paar seconden opnieuw.');
      return true;
    }
    return false;
  };

  const forward = (req: http.IncomingMessage): ForwardInfo => ({
    clientIp: clientAddress(req, cfg.trustProxy),
    proto: clientProto(req, cfg.trustProxy, cfg.scheme),
    host: String(req.headers.host || ''),
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      // Only origin-form targets ("/path"); absolute-form ("http://other/...") could disagree with Host.
      if (!req.url || req.url[0] !== '/') return answer(req, res, 400, 'Ongeldig verzoek', 'Dit adres wordt niet ondersteund.');
      const kind = classifyHost(req.headers.host, cfg.domain);
      if (kind.kind === 'control') return d.control(req, res);
      if (kind.kind === 'bad') return answer(req, res, 400, 'Ongeldig verzoek', 'Er ontbreekt een geldig adres (Host).');
      if (kind.kind === 'other') {
        if (req.url === '/healthz') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end('{"ok":true}');
        }
        // Caddy on-demand TLS: only issue certificates for the apex and existing workspaces. Internal callers only.
        if (req.url.startsWith('/_tls/ask?') && trusted(req.socket.remoteAddress, cfg.tlsAskFrom)) {
          const want = classifyHost(new URL(req.url, 'http://x').searchParams.get('domain') || '', cfg.domain);
          const route = want.kind === 'workspace' ? await d.workspaces.route(want.slug) : null;
          const ok = want.kind === 'control' || (!!route && !route.dedicated && route.status !== 'deleted' && route.status !== 'deleting');
          res.writeHead(ok ? 200 : 404, { 'content-type': 'text/plain' });
          return res.end(ok ? 'ok' : 'nee');
        }
        return unknown(req, res);
      }
      const route = await d.workspaces.route(kind.slug);
      if (gate(req, res, route)) return;
      const path = normalizePath(req.url);
      if (path === null) return answer(req, res, 400, 'Ongeldig verzoek', 'Het adres is niet goed gecodeerd.');

      if (path === CLAIM_PATH) {
        // One-time link from the dashboard → short-lived, host-only cookie → TeamBot's own first-run setup page.
        const t = new URL(req.url, 'http://x').searchParams.get('t');
        securityHeaders(res);
        if (!d.workspaces.validClaim(route!, t)) {
          return answer(req, res, 403, 'Deze link werkt niet (meer)', 'Hij is al gebruikt of verlopen. Maak een nieuwe aan via je dashboard.', html`<p><a class="btn" href="${cfg.url}/dashboard">Naar je dashboard</a></p>`);
        }
        const attrs = `Path=/; Max-Age=1800; HttpOnly; SameSite=Strict${cfg.cookieSecure ? '; Secure' : ''}`;
        res.writeHead(303, { location: '/', 'set-cookie': `${claimCookie}=${encodeURIComponent(t!)}; ${attrs}` });
        return res.end();
      }

      let onResponse: ((status: number) => void) | undefined;
      let extraSetCookie: string[] | undefined;
      if (path === SETUP_PATH || path.startsWith(SETUP_PATH + '/')) {
        // TeamBot's first-run owner setup is open to whoever comes first. Only the workspace owner, holding a valid
        // claim from the control plane, may pass; after a successful setup the path stays closed for good.
        if (route!.ownerClaimed || !d.workspaces.validClaim(route!, cookieValue(req, claimCookie))) {
          return answer(req, res, 403, 'Eigenaar-account aanmaken kan alleen via je dashboard', 'Open je TeamBot Cloud-dashboard en kies "Eigenaar-account aanmaken".');
        }
        onResponse = (status) => {
          if (status >= 200 && status < 300) d.workspaces.markClaimed(route!.id, forward(req).clientIp).catch((e) => d.log.error('claim vastleggen mislukte', e));
        };
        extraSetCookie = [`${claimCookie}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${cfg.cookieSecure ? '; Secure' : ''}`];
      }

      const headers = requestHeaders(req, forward(req));
      // Only a valid owner claim gets the setup token the instance requires (TEAMBOT_SETUP_TOKEN).
      if (onResponse) headers['x-teambot-setup-token'] = d.workspaces.setupToken(route!.id);
      proxyHttp(req, res, route!.upstream!, {
        headers,
        maxBodyBytes: cfg.proxyMaxBodyBytes,
        onResponse,
        extraSetCookie,
        onError: (r, status) =>
          status === 413
            ? answer(req, r, 413, 'Te groot', 'Dit bestand of verzoek is te groot.')
            : answer(req, r, 502, 'Je TeamBot reageert even niet', 'Probeer het over een paar seconden opnieuw. Blijft dit zo, kijk dan op de statuspagina.'),
      });
    } catch (e) {
      d.log.error('router-fout', e);
      if (!res.headersSent) answer(req, res, 500, 'Er ging iets mis', 'Probeer het zo opnieuw.');
      else res.destroy();
    }
  }

  async function upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const reject = (status: number, msg: string) => {
      if (socket.writable) socket.end(`HTTP/1.1 ${status} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      else socket.destroy();
    };
    socket.on('error', () => socket.destroy());
    try {
      if (!req.url || req.url[0] !== '/') return reject(400, 'Bad Request');
      const kind = classifyHost(req.headers.host, cfg.domain);
      if (kind.kind !== 'workspace') return reject(404, 'Not Found');
      const route = await d.workspaces.route(kind.slug);
      if (!route || route.dedicated || route.status === 'deleted' || route.status === 'deleting') return reject(404, 'Not Found');
      if (route.status !== 'active' || !route.upstream) return reject(503, 'Service Unavailable');
      const path = normalizePath(req.url);
      if (path === null || path === CLAIM_PATH || path === SETUP_PATH || path.startsWith(SETUP_PATH + '/')) return reject(403, 'Forbidden');
      proxyUpgrade(req, socket, head, route.upstream, requestHeaders(req, forward(req), true));
    } catch (e) {
      d.log.error('router-fout (websocket)', e);
      reject(500, 'Internal Server Error');
    }
  }

  return { handle, upgrade };
}
