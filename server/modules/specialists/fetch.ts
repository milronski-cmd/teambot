/**
 * Polite fetching for learning rounds: the SSRF guard of the web tools on every redirect hop (`safeFetch`), a
 * size limit while reading, a time limit, ETag / Last-Modified, robots.txt, an honest user agent and a pause between
 * two requests to the same host. Plus a small RSS 2.0 / Atom parser (no dependency) and HTML → readable text.
 */
import crypto from 'node:crypto';
import { htmlToMarkdown, pageToMarkdown, readBytes, safeFetch } from '../../tools/builtin/web.js';

export const USER_AGENT = 'TeamBot-Specialist/0.4 (leerronde van een eigen AI-assistent; volgt robots.txt)';
export const MAX_BYTES = 2_000_000;
const ROBOTS_BYTES = 64_000;

export interface Fetched {
  status: number;
  url: string;
  contentType: string;
  text: string;
  etag?: string;
  lastModified?: string;
  notModified?: boolean;
}

export type FetchFn = (url: string, o: { allowPrivate: boolean; maxBytes?: number; timeoutMs?: number; etag?: string; lastModified?: string; signal?: AbortSignal }) => Promise<Fetched>;

export const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);

/** GET through safeFetch (SSRF guard on every redirect hop), with a byte limit and a time limit. */
export const politeFetch: FetchFn = async (url, o) => {
  const maxBytes = o.maxBytes ?? MAX_BYTES;
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'text/html, application/xhtml+xml, application/rss+xml, application/atom+xml, application/xml;q=0.9, text/plain;q=0.8, */*;q=0.3' };
  if (o.etag) headers['if-none-match'] = o.etag;
  if (o.lastModified) headers['if-modified-since'] = o.lastModified;
  const res = await safeFetch(url, { allowPrivate: o.allowPrivate, headers, signal: o.signal, timeoutMs: o.timeoutMs ?? 20_000 });
  if (res.status === 304) {
    res.body?.cancel().catch(() => {});
    return { status: 304, url: res.url, contentType: '', text: '', notModified: true, etag: o.etag, lastModified: o.lastModified };
  }
  const body = await readBytes(res, maxBytes);
  if (!body) throw new Error(`De pagina is te groot (meer dan ${Math.round(maxBytes / 1_000_000)} MB).`);
  return {
    status: res.status,
    url: res.url,
    contentType: res.headers.get('content-type') || '',
    text: body.toString('utf8'),
    etag: res.headers.get('etag') || undefined,
    lastModified: res.headers.get('last-modified') || undefined,
  };
};

// ---------------------------------------------------------------------------- robots.txt

export interface RobotsRules {
  allow: string[];
  disallow: string[];
}

/** The rules for our agent: a group for "teambot" wins over the group for "*". */
export function parseRobots(txt: string): RobotsRules {
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], allow: [], disallow: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'disallow' && val) cur.disallow.push(val);
    if (key === 'allow' && val) cur.allow.push(val);
  }
  const mine = groups.find((g) => g.agents.some((a) => !!a && a !== '*' && a.startsWith('teambot'))) || groups.find((g) => g.agents.includes('*'));
  return { allow: mine?.allow || [], disallow: mine?.disallow || [] };
}

function ruleMatch(rule: string, p: string): number {
  // '*' wildcards and a closing '$'; returns the length of the rule when it matches, else -1.
  const re = new RegExp('^' + rule.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$|\$$/, '$'));
  return re.test(p) ? rule.length : -1;
}

/** May we fetch this path? The longest matching rule wins; Allow wins a tie. */
export function robotsAllows(rules: RobotsRules, pathAndQuery: string): boolean {
  let best = -1;
  let allowed = true;
  for (const r of rules.disallow) {
    const l = ruleMatch(r, pathAndQuery);
    if (l > best) {
      best = l;
      allowed = false;
    }
  }
  for (const r of rules.allow) {
    const l = ruleMatch(r, pathAndQuery);
    if (l >= best && l >= 0) {
      best = l;
      allowed = true;
    }
  }
  return allowed;
}

/**
 * One politeness context per learning round: robots.txt once per host, and a pause between two requests to the same
 * host. `hostDelayMs` is 2 s by default (tests use 0).
 */
export class Politeness {
  private robots = new Map<string, Promise<RobotsRules | null>>();
  private last = new Map<string, number>();
  constructor(
    private fetchFn: FetchFn,
    private o: { allowPrivate: boolean; hostDelayMs: number; signal?: AbortSignal },
  ) {}

  private async rules(u: URL): Promise<RobotsRules | null> {
    const key = u.origin;
    let p = this.robots.get(key);
    if (!p) {
      p = (async () => {
        try {
          await this.wait(u);
          const r = await this.fetchFn(`${u.origin}/robots.txt`, { allowPrivate: this.o.allowPrivate, maxBytes: ROBOTS_BYTES, timeoutMs: 10_000, signal: this.o.signal });
          if (r.status >= 400 || !r.text) return null;
          return parseRobots(r.text);
        } catch {
          return null; // no robots.txt (or not reachable): no rules
        }
      })();
      this.robots.set(key, p);
    }
    return p;
  }

  private async wait(u: URL) {
    const at = this.last.get(u.host) || 0;
    const ms = at + this.o.hostDelayMs - Date.now();
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    this.last.set(u.host, Date.now());
  }

  /** Fetch one URL politely. Throws a Dutch reason when robots.txt forbids it. */
  async get(url: string, extra: { etag?: string; lastModified?: string } = {}): Promise<Fetched> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error('Dit is geen geldig webadres.');
    }
    const rules = await this.rules(u);
    if (rules && !robotsAllows(rules, u.pathname + u.search)) throw new RobotsError('De website vraagt in robots.txt om deze pagina niet automatisch op te halen; TeamBot slaat hem over.');
    await this.wait(u);
    return this.fetchFn(url, { allowPrivate: this.o.allowPrivate, etag: extra.etag, lastModified: extra.lastModified, signal: this.o.signal });
  }
}

export class RobotsError extends Error {}

// ---------------------------------------------------------------------------- content

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Readable text of an HTML page or a plain/markdown document. */
export function readable(body: string, contentType: string): { title: string; text: string } {
  const isHtml = /html|xml/i.test(contentType) || /^\s*<(!doctype|html|head|body)/i.test(body);
  const title = decodeEntities(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim();
  if (!isHtml) return { title, text: body.replace(/\r/g, '').trim() };
  let text = '';
  try {
    text = pageToMarkdown(body);
  } catch {
    text = decodeEntities(body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
  }
  // Images and bare links add nothing for facts.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text };
}

/** HTML snippet (feed description) → plain text. */
export function stripHtml(s: string): string {
  const d = decodeEntities(String(s || ''));
  if (!/<[a-z!/]/i.test(d)) return d.replace(/\s+/g, ' ').trim();
  try {
    return htmlToMarkdown(d).replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1').trim();
  } catch {
    return d.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

export interface FeedEntry {
  id: string;
  title: string;
  link: string;
  published: string | null;
  text: string;
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].trim() : '';
}

function isoDate(s: string): string | null {
  if (!s) return null;
  const d = new Date(decodeEntities(s).trim());
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Is this an RSS or Atom document? */
export function isFeed(body: string, contentType = ''): boolean {
  return /rss|atom/i.test(contentType) || /<(rss|feed|rdf:RDF)[\s>]/i.test(body.slice(0, 2000));
}

/** RSS 2.0 / RSS 1.0 / Atom → entries (newest first as in the document), at most 100. */
export function parseFeed(xml: string): { title: string; entries: FeedEntry[] } {
  const body = String(xml || '');
  const atom = /<feed[\s>]/i.test(body.slice(0, 3000));
  const head = body.split(/<(item|entry)[\s>]/i)[0] || '';
  const title = stripHtml(tag(head, 'title'));
  const blocks = body.match(atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) || [];
  const entries: FeedEntry[] = [];
  for (const b of blocks.slice(0, 100)) {
    let link = '';
    if (atom) {
      const links = [...b.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
      const alt = links.find((a) => /rel=["']alternate["']/i.test(a)) || links.find((a) => !/rel=/i.test(a)) || links[0] || '';
      link = decodeEntities(alt.match(/href=["']([^"']+)["']/i)?.[1] || '');
    } else link = decodeEntities(tag(b, 'link')).trim();
    const id = decodeEntities(atom ? tag(b, 'id') : tag(b, 'guid')).trim() || link || sha(b);
    const t = stripHtml(tag(b, 'title'));
    const content = tag(b, 'content:encoded') || tag(b, 'content') || tag(b, 'description') || tag(b, 'summary');
    const published = isoDate(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    entries.push({ id: id.slice(0, 500), title: t.slice(0, 300), link: link.slice(0, 1000), published, text: stripHtml(content).slice(0, 20_000) });
  }
  return { title: title.slice(0, 200), entries };
}

/** Same-site links of a documentation page below its folder (for "Documentatie": the page plus a few sub-pages). */
export function docLinks(html: string, base: string, max = 40): string[] {
  let b: URL;
  try {
    b = new URL(base);
  } catch {
    return [];
  }
  const folder = b.pathname.endsWith('/') ? b.pathname : b.pathname.replace(/[^/]*$/, '');
  const out: string[] = [];
  for (const m of String(html || '').matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(decodeEntities(m[1]), b);
      if (u.origin !== b.origin || !u.pathname.startsWith(folder)) continue;
      if (/\.(png|jpe?g|gif|svg|webp|pdf|zip|gz|mp4|mp3|css|js|ico|woff2?)$/i.test(u.pathname)) continue;
      u.hash = '';
      const s = u.toString();
      if (s === b.toString() || out.includes(s)) continue;
      out.push(s);
      if (out.length >= max) break;
    } catch {
      /* ignore bad links */
    }
  }
  return out;
}
