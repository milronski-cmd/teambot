import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

/**
 * The article of a web page, without menus, cookie banners, sidebars and footers: Mozilla's Readability (Apache-2.0,
 * the "reader view" of Firefox) on a light DOM (linkedom, ISC). Used when a bot reads a page (web_fetch, specialists).
 * Null when the page has no clear article (a home page, a search form): the caller then keeps the whole page.
 */

const MAX_HTML = 3_000_000;
/** Less text than this is no article (a login page, an index). */
const MIN_TEXT = 200;

export interface Article {
  title: string;
  /** Clean HTML of the article (turn it into markdown with turndown). */
  html: string;
  text: string;
  byline: string | null;
}

export function readableArticle(html: string): Article | null {
  if (!html || html.length > MAX_HTML) return null;
  try {
    const { document } = parseHTML(html);
    const r = new Readability(document as any, { charThreshold: MIN_TEXT, maxElemsToParse: 60_000, keepClasses: false }).parse();
    const text = String(r?.textContent || '').replace(/\s+/g, ' ').trim();
    if (!r || !r.content || text.length < MIN_TEXT) return null;
    return { title: String(r.title || '').trim(), html: r.content, text, byline: r.byline ? String(r.byline).trim() : null };
  } catch {
    return null;
  }
}

/** Relative links and images in markdown made absolute against the page address. */
export function absoluteLinks(md: string, base?: string): string {
  if (!base) return md;
  return md.replace(/(\]\()([^)\s]+)(\s+"[^"]*")?\)/g, (m, open, href, title = '') => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return m;
    try {
      return `${open}${new URL(href, base).toString()}${title})`;
    } catch {
      return m;
    }
  });
}
