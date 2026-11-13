import { readBytes, safeFetch } from '../../tools/builtin/web.js';
import { bytesText } from '../../core/i18n.js';

export interface FetchResult {
  status: number;
  contentType: string;
  url: string;
  body: Buffer;
  /** Selected response headers (lower-case names): etag, last-modified, rate-limit and retry headers. */
  headers?: Record<string, string>;
}

export interface FetchOptions {
  maxBytes: number;
  accept?: string;
  /** Extra request headers (e.g. If-None-Match). An Authorization header is only sent to the original host. */
  headers?: Record<string, string>;
  /** Non-2xx statuses returned as a result instead of thrown (e.g. 304, 404, 403, 429). */
  okStatus?: number[];
  timeoutMs?: number;
  /** 'manual' returns the first 3xx response (with its `location` header) instead of following it. */
  redirect?: 'follow' | 'manual';
}

export type Fetcher = (url: string, opts: FetchOptions) => Promise<FetchResult>;

const KEEP_HEADERS = ['etag', 'last-modified', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'cache-control'];

/**
 * Download through safeFetch (SSRF check on every redirect hop, credentials never follow a redirect to another
 * origin), with a hard byte cap and a timeout.
 */
export const defaultFetcher: Fetcher = async (url, opts) => {
  const res = await safeFetch(url, {
    headers: { 'user-agent': 'TeamBot-Marketplace/0.1 (+https://github.com)', accept: opts.accept || '*/*', ...opts.headers },
    timeoutMs: opts.timeoutMs || 30_000,
    redirect: opts.redirect,
  });
  const loc = res.headers.get('location');
  if (opts.redirect === 'manual' && loc && [301, 302, 303, 307, 308].includes(res.status)) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status, contentType: '', url: res.url, body: Buffer.alloc(0), headers: { location: new URL(loc, res.url).toString() } };
  }
  const kept: Record<string, string> = {};
  for (const h of KEEP_HEADERS) {
    const v = res.headers.get(h);
    if (v) kept[h] = v;
  }
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    if (opts.okStatus?.includes(res.status)) return { status: res.status, contentType, url: res.url, body: Buffer.alloc(0), headers: kept };
    throw new Error(`Downloaden mislukt (HTTP ${res.status}) voor ${new URL(res.url).hostname}`);
  }
  const len = Number(res.headers.get('content-length') || 0);
  const body = await readBytes(res, opts.maxBytes);
  if (!body) throw new Error(len > opts.maxBytes ? `Het bestand is te groot (${bytesText(len)}, maximaal ${bytesText(opts.maxBytes)}).` : `Het bestand is te groot (maximaal ${bytesText(opts.maxBytes)}).`);
  return { status: res.status, contentType, url: res.url, body, headers: kept };
};

export interface GithubTarget {
  kind: 'zip' | 'file';
  url: string;
  /** Sub folder inside the repository (posix, no leading slash). */
  subdir: string;
  label: string;
}

/**
 * Resolve GitHub URLs to something we can download:
 *  - github.com/o/r                    -> archive zip (default branch)
 *  - github.com/o/r/tree/<ref>/<path>  -> archive zip of <ref>, folder <path>
 *  - github.com/o/r/blob/<ref>/<path>/SKILL.md -> archive zip of <ref>, folder of that file
 *  - raw.githubusercontent.com/o/r/<ref>/<path>/SKILL.md -> archive zip of <ref>, folder of that file
 *  - raw.githubusercontent.com/... (another file) -> single file
 * Branch names containing "/" are not supported in tree/blob URLs (first segment is the ref).
 */
export function resolveGithub(raw: string): GithubTarget | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host === 'raw.githubusercontent.com') {
    // A link to the SKILL.md itself: take the whole folder (scripts and other files belong to the skill).
    const raw = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const at = raw[2] === 'refs' && (raw[3] === 'heads' || raw[3] === 'tags') ? 5 : 3;
    if (raw.length > at && /^skill\.md$/i.test(raw[raw.length - 1]) && /^[\w.-]+$/.test(raw[0]) && /^[\w.-]+$/.test(raw[1])) {
      const ref = raw[at - 1];
      const rest = raw.slice(at, -1);
      return { kind: 'zip', url: `https://github.com/${encodeURIComponent(raw[0])}/${encodeURIComponent(raw[1])}/archive/${encodeURIComponent(ref)}.zip`, subdir: rest.join('/'), label: `${raw[0]}/${raw[1]}@${ref}${rest.length ? '/' + rest.join('/') : ''}` };
    }
    return { kind: 'file', url: u.toString(), subdir: '', label: u.pathname.slice(1) };
  }
  if (host !== 'github.com' && host !== 'www.github.com') return null;
  const seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (seg.length < 2) return null;
  const owner = seg[0];
  const repo = seg[1].replace(/\.git$/, '');
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  const enc = (s: string) => encodeURIComponent(s);
  if (seg.length === 2) return { kind: 'zip', url: `https://github.com/${enc(owner)}/${enc(repo)}/archive/HEAD.zip`, subdir: '', label: `${owner}/${repo}` };
  if ((seg[2] === 'tree' || seg[2] === 'blob') && seg.length >= 4) {
    const ref = seg[3];
    let rest = seg.slice(4);
    if (seg[2] === 'blob') rest = rest.slice(0, -1); // folder of the file
    return { kind: 'zip', url: `https://github.com/${enc(owner)}/${enc(repo)}/archive/${enc(ref)}.zip`, subdir: rest.join('/'), label: `${owner}/${repo}@${ref}${rest.length ? '/' + rest.join('/') : ''}` };
  }
  return null;
}
