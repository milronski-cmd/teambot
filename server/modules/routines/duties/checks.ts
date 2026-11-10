import type { Fetcher, FetchResult } from '../triggers.js';
import type { CheckResult, Finding } from './types.js';

/**
 * What TeamBot measures itself, without a model: the team's websites. Real numbers (status code, response time,
 * number of pages in the sitemap, pages that fail), each finding with the address and what was measured. A check that
 * finds nothing costs no tokens and makes no noise.
 */

const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 15_000;
/** At most this many pages of a sitemap are opened per check (spread over the sitemap, so every part gets its turn). */
export const SAMPLE_PAGES = 12;
export const SLOW_MS = 5000;

export function cleanSiteUrl(raw: unknown): string | null {
  let s = String(raw ?? '').trim();
  if (!s || s.length > 300) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.') && u.hostname !== 'localhost' && !/^[\d.]+$/.test(u.hostname)) return null;
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const tag = (html: string, re: RegExp) => (html.match(re)?.[1] || '').replace(/\s+/g, ' ').trim();
const attr = (el: string, name: string) => el.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] || '';

export interface PageFacts {
  title: string;
  description: string;
  noindex: boolean;
  canonical: string;
}

export function pageFacts(html: string, robotsHeader = ''): PageFacts {
  const head = html.slice(0, 200_000);
  const metas = head.match(/<meta\b[^>]*>/gi) || [];
  const meta = (name: string) => {
    const el = metas.find((m) => new RegExp(`name\\s*=\\s*["']${name}["']`, 'i').test(m));
    return el ? attr(el, 'content') : '';
  };
  const link = (head.match(/<link\b[^>]*>/gi) || []).find((l) => /rel\s*=\s*["']canonical["']/i.test(l));
  return {
    title: tag(head, /<title[^>]*>([\s\S]*?)<\/title>/i),
    description: meta('description').trim(),
    noindex: /noindex/i.test(meta('robots')) || /noindex/i.test(meta('googlebot')) || /noindex/i.test(robotsHeader),
    canonical: link ? attr(link, 'href') : '',
  };
}

/** Does robots.txt close the whole site for every crawler ("User-agent: *" with "Disallow: /")? */
export function robotsBlocksAll(txt: string): boolean {
  let star = false;
  let blocked = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === 'user-agent') star = v === '*';
    else if (star && k === 'disallow' && v === '/') blocked = true;
    else if (star && k === 'allow' && v === '/') blocked = false;
  }
  return blocked;
}

export function sitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
}

/** `n` items spread evenly over the list, starting at a place that moves with `turn` (each run looks at other pages). */
export function sample<T>(list: T[], n: number, turn = 0): T[] {
  if (list.length <= n) return list;
  const step = list.length / n;
  const start = turn % Math.max(1, Math.floor(step));
  return Array.from({ length: n }, (_, i) => list[Math.min(list.length - 1, Math.floor(start + i * step))]);
}

export interface SiteCheckOptions {
  allowPrivate?: boolean;
  /** uptime = only "does it answer, and how fast"; full = also indexability, title, sitemap and a sample of its pages. */
  depth: 'uptime' | 'full';
  /** Moves the sample through the sitemap. */
  turn?: number;
  now?: () => number;
}

async function get(fetcher: Fetcher, url: string, o: SiteCheckOptions): Promise<{ res: FetchResult | null; ms: number; error: string }> {
  const t0 = Date.now();
  try {
    const res = await fetcher(url, { allowPrivate: !!o.allowPrivate, maxBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS });
    return { res, ms: Date.now() - t0, error: '' };
  } catch (e: any) {
    return { res: null, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 200) };
  }
}

/** Check the team's websites. Never throws: a site that cannot be reached is a finding. */
export async function checkSites(fetcher: Fetcher, sites: string[], o: SiteCheckOptions): Promise<CheckResult> {
  const findings: Finding[] = [];
  const numbers: Record<string, number> = { websites: sites.length, paginas: 0, fouten: 0 };
  const when = new Date((o.now || Date.now)()).toISOString().slice(0, 16).replace('T', ' ');
  const add = (site: string, key: string, title: string, evidence: string, doneWhen: string) => findings.push({ key: `${host(site)}:${key}`, title, evidence: `${evidence} (gemeten ${when} UTC)`, doneWhen, site: host(site) });

  for (const site of sites) {
    const h = host(site);
    const home = await get(fetcher, site, o);
    numbers.paginas++;
    if (!home.res) {
      add(site, 'onbereikbaar', `${h} is niet bereikbaar`, `${site} gaf geen antwoord: ${home.error}`, `${site} antwoordt met status 200`);
      continue;
    }
    numbers[`${h} status`] = home.res.status;
    numbers[`${h} ms`] = home.ms;
    if (home.res.status >= 400) {
      add(site, 'status', `${h} geeft fout ${home.res.status}`, `${site} antwoordde met status ${home.res.status} in ${home.ms} ms`, `${site} antwoordt met status 200`);
      continue;
    }
    if (home.ms > SLOW_MS) add(site, 'traag', `${h} is traag`, `${site} antwoordde pas na ${home.ms} ms (grens ${SLOW_MS} ms)`, `${site} antwoordt binnen ${SLOW_MS} ms`);
    if (o.depth === 'uptime') continue;

    const facts = pageFacts(home.res.text, home.res.robots);
    if (facts.noindex) add(site, 'noindex', `${h}: de startpagina staat op noindex`, `${site} heeft “noindex” in de robots-meta of de X-Robots-Tag: Google neemt de pagina niet op`, `de startpagina van ${h} heeft geen noindex meer`);
    if (!facts.title) add(site, 'titel', `${h}: de startpagina heeft geen titel`, `${site} heeft geen <title>`, `de startpagina van ${h} heeft een titel`);
    if (!facts.description) add(site, 'beschrijving', `${h}: de startpagina heeft geen beschrijving`, `${site} heeft geen meta description`, `de startpagina van ${h} heeft een meta description`);

    const origin = new URL(home.res.url || site).origin;
    const robots = await get(fetcher, `${origin}/robots.txt`, o);
    let sitemap = `${origin}/sitemap.xml`;
    if (robots.res && robots.res.status < 400) {
      if (robotsBlocksAll(robots.res.text)) add(site, 'robots', `${h}: robots.txt sluit de hele website af`, `${origin}/robots.txt bevat “Disallow: /” voor alle zoekmachines`, `robots.txt van ${h} laat zoekmachines toe`);
      const declared = robots.res.text.match(/^\s*sitemap\s*:\s*(\S+)/im)?.[1];
      if (declared) sitemap = declared;
    }
    const sm = await get(fetcher, sitemap, o);
    if (!sm.res || sm.res.status >= 400) {
      add(site, 'sitemap', `${h} heeft geen werkende sitemap`, `${sitemap} gaf ${sm.res ? `status ${sm.res.status}` : sm.error}`, `${sitemap} antwoordt met status 200 en bevat de pagina’s van de website`);
      continue;
    }
    // A sitemap index: open the first child sitemap for the sample.
    let urls = sitemapUrls(sm.res.text);
    if (/<sitemapindex/i.test(sm.res.text) && urls.length) {
      const child = await get(fetcher, urls[0], o);
      urls = child.res && child.res.status < 400 ? sitemapUrls(child.res.text) : [];
    }
    numbers[`${h} pagina's in sitemap`] = urls.length;
    if (!urls.length) {
      add(site, 'sitemap-leeg', `${h}: de sitemap is leeg`, `${sitemap} bevat geen pagina’s`, `de sitemap van ${h} bevat de pagina’s van de website`);
      continue;
    }
    const broken: string[] = [];
    const hidden: string[] = [];
    for (const u of sample(urls.filter((x) => x.replace(/\/$/, '') !== site), SAMPLE_PAGES, o.turn || 0)) {
      const p = await get(fetcher, u, o);
      numbers.paginas++;
      if (!p.res || p.res.status >= 400) broken.push(`${u} (${p.res ? p.res.status : 'geen antwoord'})`);
      else if (pageFacts(p.res.text, p.res.robots).noindex) hidden.push(u);
    }
    if (broken.length) add(site, 'kapot', `${h}: ${broken.length === 1 ? '1 pagina uit de sitemap geeft een fout' : `${broken.length} pagina’s uit de sitemap geven een fout`}`, broken.slice(0, 8).join('; '), `elke pagina in de sitemap van ${h} antwoordt met status 200`);
    if (hidden.length) add(site, 'sitemap-noindex', `${h}: ${hidden.length === 1 ? '1 pagina in de sitemap staat op noindex' : `${hidden.length} pagina’s in de sitemap staan op noindex`}`, hidden.slice(0, 8).join('; '), `geen pagina in de sitemap van ${h} staat op noindex`);
  }
  numbers.fouten = findings.length;
  const pages = numbers.paginas === 1 ? '1 pagina' : `${numbers.paginas} pagina’s`;
  const line = `${sites.length === 1 ? '1 website' : `${sites.length} websites`}, ${pages} gecontroleerd`;
  return { line, numbers, findings };
}

/** One address: does it answer with the expected status, in time, and does the page say what it should? */
export async function checkUrl(fetcher: Fetcher, m: { url: string; status?: number; contains?: string; maxMs?: number }, allowPrivate: boolean): Promise<{ line: string; numbers: Record<string, number>; wrong: string | null }> {
  const r = await get(fetcher, m.url, { depth: 'uptime', allowPrivate });
  if (!r.res) return { line: `${m.url} gaf geen antwoord`, numbers: {}, wrong: `${m.url} gaf geen antwoord: ${r.error}` };
  const numbers = { status: r.res.status, ms: r.ms };
  const line = `${m.url}: status ${r.res.status} in ${r.ms} ms`;
  const want = m.status || 0;
  if (want ? r.res.status !== want : r.res.status >= 400) return { line, numbers, wrong: `${m.url} antwoordde met status ${r.res.status}${want ? ` (verwacht ${want})` : ''}` };
  if (m.maxMs && r.ms > m.maxMs) return { line, numbers, wrong: `${m.url} antwoordde pas na ${r.ms} ms (grens ${m.maxMs} ms)` };
  if (m.contains && !r.res.text.toLowerCase().includes(m.contains.toLowerCase())) return { line, numbers, wrong: `Op ${m.url} staat “${m.contains}” niet` };
  return { line, numbers, wrong: null };
}

export function compare(v: number, op: string, x: number): boolean {
  return op === '<' ? v < x : op === '<=' ? v <= x : op === '>' ? v > x : op === '>=' ? v >= x : op === '=' ? v === x : v !== x;
}

/** One value out of an answer: "rows[0].clicks", "items.length", "" = the answer itself (a list counts as its length). */
export function pick(data: any, path: string): any {
  let cur = data;
  for (const part of path.split(/[.[\]]+/).filter(Boolean)) {
    if (cur === null || cur === undefined) return null;
    cur = part === 'length' && Array.isArray(cur) ? cur.length : cur[part];
  }
  return Array.isArray(cur) ? cur.length : cur;
}
