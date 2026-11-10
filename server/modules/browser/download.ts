import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';

/**
 * Download a file by its URL for a bot browser (browser_download with a url, or a link the bot points at). A browser
 * cannot do this for a file on another site: `<a download>` is ignored cross-origin, so Chrome shows a picture instead
 * of downloading it and the tool used to wait 60 s for nothing. TeamBot fetches it itself, but **through the same
 * policy proxy as the bot browser** (each connection and every redirect hop is checked against the SSRF and domain
 * policy there), with the browser's cookies for that site, streamed to disk with a hard size limit, connect/idle/total
 * timeouts, progress and stop. A partial file never stays behind.
 */

export interface ProxyHop {
  port: number;
  username: string;
  password: string;
}

export type DownloadFailure = 'too_big' | 'timeout' | 'blocked' | 'http' | 'aborted' | 'network';

export class DownloadError extends Error {
  constructor(message: string, public code: DownloadFailure) {
    super(message);
  }
}

export interface DownloadOpts {
  url: string;
  proxy: ProxyHop;
  /** Folder the file is written to (already checked to be inside the bot's work folder). */
  dir: string;
  maxBytes: number;
  /** User agent, referer, … (the cookie header comes from cookiesFor, per hop). */
  headers?: Record<string, string>;
  cookiesFor?(url: string): Promise<string>;
  /** The reason the policy proxy gave when it blocked a hop (filled in by the caller's proxy client). */
  blockedReason?(): string | null;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxRedirects?: number;
  onProgress?(received: number, total: number | null): void;
}

export interface DownloadResult {
  file: string;
  name: string;
  bytes: number;
  contentType: string;
  finalUrl: string;
}

const mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);
export const formatBytesNl = mb;

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif', 'image/svg+xml': '.svg',
  'application/pdf': '.pdf', 'application/zip': '.zip', 'text/plain': '.txt', 'text/csv': '.csv', 'application/json': '.json', 'text/html': '.html',
  'audio/mpeg': '.mp3', 'video/mp4': '.mp4', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

/** File name from Content-Disposition (RFC 6266/5987) or the URL path, made safe, with an extension from the type. */
export function fileNameFor(url: string, disposition: string | undefined, contentType: string): string {
  let name = '';
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?'[^']*'([^;]+)/i.exec(disposition || '');
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition || '');
  try {
    if (star) name = decodeURIComponent(star[1].trim());
  } catch {
    name = '';
  }
  if (!name && plain) name = (plain[1] ?? plain[2] ?? '').trim();
  if (!name) {
    try {
      name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    } catch {
      name = '';
    }
  }
  name = path.basename(name.replace(/\\/g, '/')).replace(/[^\w.\- ()À-ž]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'download';
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (!/\.[a-z0-9]{1,6}$/i.test(name) && EXT_BY_TYPE[type]) name += EXT_BY_TYPE[type];
  return name;
}

function uniquePath(dir: string, name: string) {
  let dest = path.join(dir, name);
  for (let i = 1; fs.existsSync(dest) && i < 1000; i++) dest = path.join(dir, name.replace(/(\.[^.]*)?$/, ` (${i})$1`));
  return dest;
}

/** One request through the policy proxy (absolute-form for http, a CONNECT tunnel for https). */
function requestOnce(o: DownloadOpts, url: URL, headers: Record<string, string>, connectTimeoutMs: number): Promise<{ res: http.IncomingMessage; destroy(): void }> {
  const auth = 'Basic ' + Buffer.from(`${o.proxy.username}:${o.proxy.password}`).toString('base64');
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (e: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    };
    const timer = setTimeout(() => {
      fail(new DownloadError(`Geen antwoord van ${url.host} binnen ${Math.round(connectTimeoutMs / 1000)} s.`, 'timeout'));
      cleanup();
    }, connectTimeoutMs);
    let cleanup = () => {};
    const ok = (res: http.IncomingMessage, destroy: () => void) => {
      if (done) return destroy();
      done = true;
      clearTimeout(timer);
      resolve({ res, destroy });
    };
    if (url.protocol === 'http:') {
      const req = http.request({ host: '127.0.0.1', port: o.proxy.port, method: 'GET', path: url.href, headers: { ...headers, host: url.host, 'proxy-authorization': auth }, agent: false });
      cleanup = () => req.destroy();
      req.on('response', (res) => ok(res, () => req.destroy()));
      req.on('error', (e) => fail(new DownloadError(`Verbinding mislukt: ${e.message}`, 'network')));
      req.end();
      return;
    }
    const port = Number(url.port) || 443;
    const hostPort = `${url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname}:${port}`;
    const c = http.request({ host: '127.0.0.1', port: o.proxy.port, method: 'CONNECT', path: hostPort, headers: { host: hostPort, 'proxy-authorization': auth }, agent: false });
    cleanup = () => c.destroy();
    c.on('error', (e) => fail(new DownloadError(`Verbinding mislukt: ${e.message}`, 'network')));
    c.on('connect', (cres, socket) => {
      if (cres.statusCode !== 200) {
        socket.destroy();
        return fail(new DownloadError(cres.statusCode === 403 ? 'blocked' : `Proxy weigert (${cres.statusCode})`, cres.statusCode === 403 ? 'blocked' : 'network'));
      }
      const secure = tls.connect({ socket, servername: url.hostname.replace(/^\[|\]$/g, ''), ALPNProtocols: ['http/1.1'] });
      secure.on('error', (e) => fail(new DownloadError(`Beveiligde verbinding mislukt: ${e.message}`, 'network')));
      const req = https.request({ host: url.hostname, port, method: 'GET', path: url.pathname + url.search, headers: { ...headers, host: url.host }, createConnection: () => secure, agent: false });
      cleanup = () => req.destroy();
      req.on('response', (res) => ok(res, () => req.destroy()));
      req.on('error', (e) => fail(new DownloadError(`Verbinding mislukt: ${e.message}`, 'network')));
      req.end();
    });
    c.end();
  });
}

export async function downloadViaProxy(o: DownloadOpts): Promise<DownloadResult> {
  const connectTimeoutMs = o.connectTimeoutMs ?? 20_000;
  const idleTimeoutMs = o.idleTimeoutMs ?? 30_000;
  const totalTimeoutMs = o.totalTimeoutMs ?? 15 * 60_000;
  const maxRedirects = o.maxRedirects ?? 5;
  const started = Date.now();
  const blocked = (fallback: string) => new DownloadError(`Geblokkeerd door TeamBot: ${o.blockedReason?.() || fallback}`, 'blocked');
  let url = new URL(o.url);
  if (o.signal?.aborted) throw new DownloadError('Gestopt.', 'aborted');
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new DownloadError('Alleen http- en https-adressen kunnen gedownload worden.', 'blocked');
    const headers: Record<string, string> = { accept: '*/*', 'accept-encoding': 'identity', ...(o.headers || {}) };
    const cookie = await o.cookiesFor?.(url.href).catch(() => '');
    if (cookie) headers.cookie = cookie;
    let got: { res: http.IncomingMessage; destroy(): void };
    try {
      got = await requestOnce(o, url, headers, connectTimeoutMs);
    } catch (e: any) {
      if (e instanceof DownloadError && e.code === 'blocked') throw blocked(`${url.host} is niet toegestaan.`);
      throw e;
    }
    const { res } = got;
    const status = res.statusCode || 0;
    // The policy proxy answers a blocked plain-http hop with its own 403 page.
    if (status === 403 && o.blockedReason?.()) {
      got.destroy();
      throw blocked('');
    }
    if (status >= 300 && status < 400 && res.headers.location) {
      got.destroy();
      if (hop >= maxRedirects) throw new DownloadError(`Te veel doorverwijzingen (meer dan ${maxRedirects}).`, 'http');
      url = new URL(res.headers.location, url);
      continue;
    }
    if (status < 200 || status >= 300) {
      got.destroy();
      throw new DownloadError(status === 404 ? 'Bestand niet gevonden op de website (404).' : status === 401 || status === 403 ? `De website weigert de download (${status}); misschien moet je eerst inloggen.` : `De website gaf een fout (${status}).`, 'http');
    }
    const total = Number(res.headers['content-length']) || null;
    if (total && total > o.maxBytes) {
      got.destroy();
      // No "Niet gedownload." here: the tool puts that in front ("Niet gedownload: Bestand is te groot …").
      throw new DownloadError(`Bestand is te groot (${mb(total)}; limiet ${mb(o.maxBytes)}).`, 'too_big');
    }
    const contentType = String(res.headers['content-type'] || 'application/octet-stream');
    const name = fileNameFor(url.href, res.headers['content-disposition'], contentType);
    fs.mkdirSync(o.dir, { recursive: true });
    const dest = uniquePath(o.dir, name);
    const part = dest + '.deel';
    const out = fs.createWriteStream(part, { flags: 'wx' });
    let received = 0;
    let lastProgress = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        let idle: NodeJS.Timeout;
        const stop = (e: Error) => {
          clearTimeout(idle);
          clearTimeout(whole);
          o.signal?.removeEventListener('abort', onAbort);
          got.destroy();
          res.destroy();
          reject(e);
        };
        const arm = () => {
          clearTimeout(idle);
          idle = setTimeout(() => stop(new DownloadError(`De download stond ${Math.round(idleTimeoutMs / 1000)} s stil (na ${mb(received)}). Afgebroken.`, 'timeout')), idleTimeoutMs);
        };
        const whole = setTimeout(() => stop(new DownloadError(`De download duurde langer dan ${Math.round(totalTimeoutMs / 60000)} min. Afgebroken.`, 'timeout')), Math.max(1000, totalTimeoutMs - (Date.now() - started)));
        const onAbort = () => stop(new DownloadError('Gestopt.', 'aborted'));
        o.signal?.addEventListener('abort', onAbort, { once: true });
        arm();
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > o.maxBytes) return stop(new DownloadError(`Bestand is te groot (meer dan ${mb(o.maxBytes)}). Afgebroken; niets bewaard.`, 'too_big'));
          arm();
          if (!out.write(chunk)) {
            res.pause();
            out.once('drain', () => res.resume());
          }
          const now = Date.now();
          if (o.onProgress && now - lastProgress > 700) {
            lastProgress = now;
            o.onProgress(received, total);
          }
        });
        res.on('end', () => {
          clearTimeout(idle);
          clearTimeout(whole);
          o.signal?.removeEventListener('abort', onAbort);
          if (total && received < total) return reject(new DownloadError(`De verbinding viel weg na ${mb(received)} van ${mb(total)}.`, 'network'));
          out.end(() => resolve());
        });
        res.on('error', (e) => stop(new DownloadError(`Verbinding verbroken: ${e.message}`, 'network')));
        out.on('error', (e) => stop(new DownloadError(`Opslaan mislukt: ${e.message}`, 'network')));
      });
      fs.renameSync(part, dest);
    } catch (e) {
      // Close the file first (Windows keeps an open file), then remove the partial download.
      if (!out.closed) await new Promise<void>((r) => (out.once('close', () => r()), out.destroy(), setTimeout(r, 3000).unref()));
      try {
        fs.rmSync(part, { force: true });
      } catch {
        /* already gone */
      }
      throw e;
    }
    o.onProgress?.(received, total);
    return { file: dest, name: path.basename(dest), bytes: received, contentType, finalUrl: url.href };
  }
}
