import { fromBase64Url, signUrlBase, toBase64Url } from './sign';

const TOKEN_KEY = 'tb_token';
const URL_KEY = 'tb_urlkey';

let token: string | null = null;
try {
  token = localStorage.getItem(TOKEN_KEY);
} catch {
  token = null;
}

/**
 * Signed URLs: images, downloads, audio, live streams and the WebSocket cannot send the Authorization header, so their
 * URLs are signed per path with this session's URL key (HMAC, valid ~15 minutes, GET only). The session token itself
 * never goes into a URL (browser history, download list, proxy logs). `skew` = server clock - our clock.
 */
interface UrlKey {
  sid: string;
  key: Uint8Array;
  skew: number;
}
let urlKey: UrlKey | null = null;
try {
  const j = token ? JSON.parse(localStorage.getItem(URL_KEY) || 'null') : null;
  if (j && typeof j.sid === 'string' && typeof j.key === 'string') urlKey = { sid: j.sid, key: fromBase64Url(j.key), skew: Number(j.skew) || 0 };
} catch {
  urlKey = null;
}
const signedCache = new Map<string, { url: string; exp: number }>();
const SIGNED_TTL = 900;

// Desktop shell / pairing links pass the token in the URL hash once: #token=...
(function pickupHashToken() {
  const m = location.hash.match(/[#&]token=([^&]+)/);
  if (m) {
    setToken(decodeURIComponent(m[1]));
    history.replaceState(null, '', location.pathname + location.search + '#/');
  }
})();

export function getToken() {
  return token;
}
export function setToken(t: string | null) {
  if (t !== token) setUrlKey(null);
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode */
  }
}

function setUrlKey(k: UrlKey | null) {
  urlKey = k;
  signedCache.clear();
  try {
    if (k) localStorage.setItem(URL_KEY, JSON.stringify({ sid: k.sid, key: toBase64Url(k.key), skew: k.skew }));
    else localStorage.removeItem(URL_KEY);
  } catch {
    /* private mode: the key then lives until the page reloads */
  }
}

export class ApiError extends Error {
  /** `code`: the server's reason in one word, when it gives one (for example "limit" when an engine is at its limit). */
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

/** Shown instead of the browser's "Failed to fetch" when the TeamBot server cannot be reached (status 0). */
export const UNREACHABLE = 'TeamBot is niet bereikbaar. Staat je computer aan en zit je op hetzelfde netwerk?';

type Opts = { method?: string; body?: any; raw?: BodyInit; headers?: Record<string, string>; signal?: AbortSignal };

export async function request<T = any>(path: string, o: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { ...(o.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  let body: BodyInit | undefined = o.raw;
  if (o.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(o.body);
  }
  const res = await fetch('/api' + path, { method: o.method || (body ? 'POST' : 'GET'), headers, body, signal: o.signal }).catch((e) => {
    // The browser's own "Failed to fetch" / "NetworkError…" means TeamBot itself is not reachable: say that in words.
    if (e?.name === 'AbortError') throw e;
    throw new ApiError(UNREACHABLE, 0);
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (res.status === 401 && !path.startsWith('/public')) emit('auth.lost', {});
  if (!res.ok) throw new ApiError((data && (data as any).error) || res.statusText || `Fout ${res.status}`, res.status, (data && typeof (data as any).code === 'string' && (data as any).code) || undefined);
  return data as T;
}

/** The raw bytes of a GET endpoint (token in the header, not in a URL), e.g. a pdf for the preview. */
export async function getBytes(path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch('/api' + path, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal }).catch((e) => {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError(UNREACHABLE, 0);
  });
  if (!res.ok) {
    const j: any = await res.json().catch(() => ({}));
    if (res.status === 401) emit('auth.lost', {});
    throw new ApiError(j?.error || res.statusText || `Fout ${res.status}`, res.status);
  }
  return res.arrayBuffer();
}

export const api = {
  get: <T = any>(p: string) => request<T>(p),
  post: <T = any>(p: string, body: any = {}) => request<T>(p, { method: 'POST', body }),
  put: <T = any>(p: string, body: any = {}) => request<T>(p, { method: 'PUT', body }),
  patch: <T = any>(p: string, body: any = {}) => request<T>(p, { method: 'PATCH', body }),
  del: <T = any>(p: string) => request<T>(p, { method: 'DELETE' }),
};

let urlKeyLoading: Promise<void> | null = null;

/**
 * Fetch (or refresh) this session's URL key. Resolves right away when a key from an earlier visit is stored (it is
 * refreshed in the background, which also corrects for a wrong clock on this device).
 */
export function ensureUrlKey(): Promise<void> {
  if (!token) return Promise.resolve();
  if (!urlKeyLoading) {
    const t0 = Date.now();
    urlKeyLoading = request<{ sid: string; key: string; now: number }>('/auth/url-key')
      .then((r) => {
        const skew = Number(r.now) ? Number(r.now) - (t0 + Date.now()) / 2 : 0;
        const same = !!urlKey && urlKey.sid === r.sid && toBase64Url(urlKey.key) === r.key;
        if (same && Math.abs(urlKey!.skew - skew) < 30_000) return;
        setUrlKey({ sid: r.sid, key: fromBase64Url(r.key), skew });
      })
      .catch(() => {
        /* keep the stored key; links that fail are signed again once the key is back */
      })
      .finally(() => (urlKeyLoading = null));
  }
  return urlKey ? Promise.resolve() : urlKeyLoading;
}

const serverNowSec = () => (Date.now() + (urlKey?.skew || 0)) / 1000;

/**
 * Sign a same-origin path (`/api/...` or `/ws`) for use in a URL. The same path gives the same URL for ~13 minutes, so
 * re-renders don't reload images or restart streams.
 */
export function signedPath(p: string): string {
  if (!urlKey) return p;
  const nowSec = serverNowSec();
  const hit = signedCache.get(p);
  if (hit && hit.exp - nowSec > 120) return hit.url;
  const exp = Math.floor(nowSec) + SIGNED_TTL;
  // Normalised exactly like the browser will send it (the server checks the signature over the raw path and query).
  const u = new URL(p, location.origin);
  const base = `${u.pathname}${u.search}${u.search ? '&' : '?'}tbs=${encodeURIComponent(urlKey.sid)}&tbe=${exp}`;
  const url = `${base}&tbsig=${signUrlBase(urlKey.key, base)}`;
  if (signedCache.size > 3000) signedCache.clear();
  signedCache.set(p, { url, exp });
  return url;
}

/** URL for viewing/downloading an attachment (signed, so <img>/<a> work without the token in the URL). */
export function fileUrl(id: string, download = false) {
  return signedPath(`/api/attachments/${id}${download ? '?download=1' : ''}`);
}

/** Signed URL for any GET endpoint (downloads, exports, images, streams). */
export function authUrl(path: string) {
  return signedPath('/api' + path);
}

/** A POST that must still go out while the page closes (instead of sendBeacon, which cannot send the token). */
export function postOnUnload(path: string) {
  try {
    void fetch('/api' + path, { method: 'POST', keepalive: true, headers: token ? { authorization: `Bearer ${token}` } : {} }).catch(() => {});
  } catch {
    /* page is going away */
  }
}

/** A signed URL that has expired (or was signed with an older key) signed again; null when nothing would change. */
export function resignUrl(raw: string): string | null {
  if (!urlKey) return null;
  let u: URL;
  try {
    u = new URL(raw, location.origin);
  } catch {
    return null;
  }
  if (u.origin !== location.origin) return null;
  const rel = u.pathname + u.search;
  const m = rel.match(/^(.*?)[?&]tbs=[^&]*&tbe=\d+&tbsig=[^&]*$/);
  const path = m ? m[1] : rel.startsWith('/api/') && !rel.startsWith('/api/public/') ? rel : null;
  if (!path) return null;
  const fresh = signedPath(path);
  return fresh === rel ? null : fresh;
}

// Links and media rendered long ago: sign again right before a click, and once more when an image or audio fails
// because its signature ran out (a still-valid URL is never retried, so real errors don't loop).
if (typeof document !== 'undefined') {
  const nearExpiry = (raw: string) => {
    const exp = Number(/[?&]tbe=(\d+)/.exec(raw)?.[1]);
    return !exp || exp - serverNowSec() < 60;
  };
  const onActivate = (e: Event) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    const raw = a?.getAttribute('href');
    if (!a || !raw || !raw.includes('tbsig=') || !nearExpiry(raw)) return;
    const fresh = resignUrl(raw);
    if (fresh) a.setAttribute('href', fresh);
  };
  document.addEventListener('click', onActivate, true);
  document.addEventListener('auxclick', onActivate, true);
  document.addEventListener(
    'error',
    (e) => {
      const el = e.target as HTMLElement | null;
      if (!(el instanceof HTMLImageElement) && !(el instanceof HTMLMediaElement)) return;
      const raw = el.getAttribute('src');
      if (!raw) return;
      const last = Number(el.dataset.tbResigned || 0);
      if (Date.now() - last < 30_000) return;
      const fresh = resignUrl(raw);
      if (!fresh) return;
      el.dataset.tbResigned = String(Date.now());
      if (el instanceof HTMLMediaElement) {
        const at = el.currentTime;
        const playing = !el.paused;
        el.src = fresh;
        el.load();
        try {
          el.currentTime = at;
        } catch {
          /* not seekable yet */
        }
        if (playing) el.play().catch(() => {});
      } else el.setAttribute('src', fresh);
    },
    true,
  );
}

export async function upload(file: Blob, name: string, threadId?: string): Promise<{ id: string; name: string; mime: string; size: number }> {
  const q = new URLSearchParams({ name });
  if (threadId) q.set('threadId', threadId);
  return request(`/attachments?${q}`, { method: 'POST', raw: file, headers: { 'content-type': 'application/octet-stream' } });
}

// ---------------- live events ----------------

type Handler = (data: any, type: string) => void;
const handlers = new Map<string, Set<Handler>>();
let ws: WebSocket | null = null;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let wsWanted = false;
export let wsConnected = false;

export function on(type: string, h: Handler): () => void {
  let s = handlers.get(type);
  if (!s) handlers.set(type, (s = new Set()));
  s.add(h);
  return () => s!.delete(h);
}

export function emit(type: string, data: any) {
  for (const h of handlers.get(type) || []) h(data, type);
  for (const h of handlers.get('*') || []) h(data, type);
}

export function connectWs() {
  wsWanted = true;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (!token) return;
  if (!urlKey) {
    void ensureUrlKey().then(() => {
      if (wsWanted && urlKey) connectWs();
      else if (wsWanted) retryLater();
    });
    return;
  }
  // Signed /ws URL: the session token never goes into the URL.
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${signedPath('/ws')}`;
  let opened = false;
  ws = new WebSocket(url);
  ws.onopen = () => {
    opened = true;
    retry = 0;
    wsConnected = true;
    emit('ws.status', { connected: true });
  };
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      emit(m.type, m.data);
    } catch {
      /* ignore */
    }
  };
  ws.onclose = () => {
    wsConnected = false;
    emit('ws.status', { connected: false });
    ws = null;
    if (!wsWanted) return;
    // Never got in: the URL key may be outdated (e.g. a restored data folder), so fetch it again before retrying.
    if (!opened) void ensureUrlKey();
    retryLater();
  };
}

function retryLater() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connectWs();
  }, Math.min(15000, 500 * 2 ** retry++));
}

/** Back in the app, or the network is back: connect now instead of waiting out the back-off (up to 15 s). */
function reconnectNow() {
  if (!wsWanted || document.visibilityState === 'hidden') return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  retry = 0;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  connectWs();
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', reconnectNow);
  window.addEventListener('online', reconnectNow);
}

export function disconnectWs() {
  wsWanted = false;
  ws?.close();
}
