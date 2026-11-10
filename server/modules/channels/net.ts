import { RedirectError, assertPublicUrl, readBytes, safeFetch } from '../../tools/builtin/web.js';
import { ChannelError } from './types.js';

const UA = 'TeamBot-Channels/0.1 (+https://github.com/teambot)';

/**
 * A network failure in plain words ("de server weigert de verbinding op poort 9") instead of a system code
 * ("connect ECONNREFUSED 127.0.0.1:9"); null when the error is not about the connection itself.
 */
export function netReason(e: any): string | null {
  const code = String(e?.code || e?.cause?.code || '');
  const msg = `${e?.message || ''} ${e?.cause?.message || ''}`;
  const has = (re: RegExp) => re.test(code) || re.test(msg);
  const port = Number(e?.port || e?.cause?.port) || Number(msg.match(/(?:\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:]+\]|[\w.-]+):(\d{1,5})\b/i)?.[1]) || 0;
  if (has(/ECONNREFUSED/)) return port ? `de server weigert de verbinding op poort ${port}` : 'de server weigert de verbinding';
  if (has(/ENOTFOUND|EAI_AGAIN|getaddrinfo/)) return 'de server is niet gevonden (klopt het adres, en is er internet?)';
  if (has(/EHOSTUNREACH|ENETUNREACH|ENETDOWN/)) return 'de server is vanaf deze computer niet bereikbaar';
  if (has(/ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|timed? ?out|Time-out/i)) return 'de server reageert niet (time-out)';
  if (has(/ECONNRESET|socket hang up|EPIPE/i)) return 'de server verbrak de verbinding';
  if (has(/CERT_|certificate|self[- ]signed|ERR_TLS|ERR_SSL|wrong version number|SSL routines|EPROTO/i)) return 'de beveiligde verbinding (TLS) lukt niet';
  return null;
}

/** fetch with a timeout that also honours an outer abort signal. */
export async function fetchT(url: string, init: RequestInit & { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error('Time-out')), init.timeoutMs ?? 30_000);
  const outer = init.signal;
  const onAbort = () => ac.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) ac.abort(outer.reason);
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, headers: { 'user-agent': UA, ...(init.headers as any) }, signal: ac.signal });
  } finally {
    clearTimeout(t);
    outer?.removeEventListener('abort', onAbort);
  }
}

/** Download a file with a hard size cap (streams, aborts when the cap is exceeded). */
export async function fetchBuffer(url: string, o: { headers?: Record<string, string>; maxBytes: number; timeoutMs?: number; signal?: AbortSignal }): Promise<Buffer> {
  // Through safeFetch: every redirect hop is checked against private addresses (unless the first URL itself is a
  // private, admin-configured API server) and the platform token never travels to another origin.
  const allowPrivate = await assertPublicUrl(url).then(
    () => false,
    () => true, // the caller already validated this host (platform host or admin-only API base)
  );
  const res = await safeFetch(url, {
    allowPrivate,
    headers: o.headers,
    // The time limit is for the answer of each hop, not for reading a large file.
    fetch: (u, init) => fetchT(u.href, { ...init, timeoutMs: o.timeoutMs ?? 60_000, signal: o.signal }),
    onRedirect: (from, to) => {
      if (to.protocol !== 'https:' && to.protocol !== from.protocol) throw new ChannelError('Doorverwijzing naar een onveilig adres geweigerd');
    },
  }).catch((e) => {
    throw e instanceof RedirectError ? new ChannelError(e.to ? `Doorverwijzing naar ${e.to.hostname} geweigerd` : e.message) : e;
  });
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new ChannelError(`Download mislukt (${res.status})`);
  }
  const body = await readBytes(res, o.maxBytes);
  if (!body) throw new ChannelError('Bestand is te groot');
  return body;
}

/** Only allow attachment downloads from the platform's own hosts (never send tokens elsewhere). */
export function assertHost(url: string, allowed: (host: string) => boolean): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ChannelError('Ongeldige bestands-URL');
  }
  if (u.protocol !== 'https:' || !allowed(u.hostname.toLowerCase())) throw new ChannelError(`Bestand van onverwachte host geweigerd: ${u.hostname}`);
  return u;
}

/**
 * Validate an API base override (self-hosted Telegram Bot API server, test servers).
 * Only owners/admins may point a channel at a private address; everybody else gets the SSRF guard.
 */
export async function checkApiBase(raw: string, role: string, fallback: string): Promise<string> {
  const v = String(raw || '').trim().replace(/\/+$/, '');
  if (!v || v === fallback) return fallback;
  const privileged = role === 'owner' || role === 'admin';
  await assertPublicUrl(v, privileged);
  return v;
}
