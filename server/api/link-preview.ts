import type { Ctx, Migration } from '../core/types.js';
import { ah, bad, user } from '../core/http.js';
import { now } from '../core/db.js';
import { safeFetch } from '../tools/builtin/web.js';

/** Link previews in chat (§21.2 P0). Fetched by the server with SSRF checks on every redirect, cached for a day. */
export const linkPreviewMigrations: Migration[] = [
  {
    id: 'core-link-previews-001',
    sql: `CREATE TABLE link_previews (url TEXT PRIMARY KEY, data TEXT NOT NULL, fetched_at TEXT NOT NULL);`,
  },
];

const UA = 'Mozilla/5.0 (compatible; TeamBot-LinkPreview/1.0; +https://github.com/teambot)';
const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();

export function parsePreview(html: string, url: string) {
  const meta = (names: string[]) => {
    for (const n of names) {
      const re = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*>`, 'i');
      const tag = html.match(re)?.[0];
      const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
      if (content) return decode(content);
    }
    return '';
  };
  const title = meta(['og:title', 'twitter:title']) || decode(html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1] || '');
  const description = meta(['og:description', 'twitter:description', 'description']).slice(0, 300);
  let image = meta(['og:image', 'twitter:image']);
  try {
    image = image ? new URL(image, url).toString() : '';
  } catch {
    image = '';
  }
  if (!/^https:\/\//i.test(image)) image = '';
  const site = meta(['og:site_name']) || new URL(url).hostname.replace(/^www\./, '');
  return { url, title: title.slice(0, 200), description, image, site };
}

async function readLimited(res: Response, max = 512_000): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString('utf8');
}

export function linkPreviewRoutes(ctx: Ctx) {
  ctx.api.get(
    '/link-preview',
    ah(async (req) => {
      user(req);
      const url = String(req.query.url || '').slice(0, 2000);
      if (!/^https?:\/\//i.test(url)) throw bad('Ongeldige URL');
      const cached = ctx.store.one<any>('SELECT * FROM link_previews WHERE url = ?', url);
      if (cached && Date.now() - Date.parse(cached.fetched_at) < 864e5) return JSON.parse(cached.data);
      let data: any = { url, title: '', description: '', image: '', site: '' };
      try {
        const res = await safeFetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(8000) });
        if (res.ok && /html/i.test(res.headers.get('content-type') || '')) data = parsePreview(await readLimited(res), res.url || url);
        else res.body?.cancel().catch(() => {});
      } catch (e: any) {
        data.error = /privé|Lokale|SSRF/i.test(e?.message || '') ? 'geblokkeerd' : 'niet bereikbaar';
      }
      ctx.store.exec('INSERT OR REPLACE INTO link_previews (url, data, fetched_at) VALUES (?, ?, ?)', url, JSON.stringify(data), now());
      return data;
    }),
  );
}
