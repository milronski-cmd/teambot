/**
 * Sources for a specialist, so it keeps itself current without the owner configuring anything. For ANY field (tax
 * law, beekeeping, TikTok …): the specialist looks for its own primary sources — a web search, then a quick check
 * that each candidate answers and is the kind of place that publishes the facts itself (see `primaryScore` and
 * service.ts › discoverSources). The list below are only presets in that same mechanism: fields where the official
 * places are known beforehand (each address checked to answer, 9 November 2026). Every source, found or preset, is
 * marked "voorgesteld"; the owner can remove or replace any of them.
 */
import type { SourceKind } from './service.js';

export interface DefaultSource {
  kind: SourceKind;
  target: string;
  label: string;
}

interface Specialism {
  id: string;
  /** What the bot's name, role or field must mention. */
  match: RegExp;
  /** One sentence for a bot that has no field yet. */
  field: string;
  sources: DefaultSource[];
  /** What to search the web for when looking for changes (the month and year are added). */
  news: string;
}

export const SPECIALISMS: Specialism[] = [
  {
    id: 'merchant',
    match: /merchant ?cent(?:er|re)|productfeeds?|google shopping|shopping-?feed/i,
    field: 'Productfeeds en Google Merchant Center',
    sources: [
      { kind: 'web', target: 'https://support.google.com/merchants/answer/7052112?hl=nl', label: 'Merchant Center: specificatie productgegevens' },
      { kind: 'feed', target: 'https://blog.google/products/ads-commerce/rss/', label: 'Google Ads & Commerce blog' },
    ],
    news: 'Google Merchant Center update productgegevens beleid',
  },
  {
    id: 'google-ads',
    match: /google ads|adwords|\bsea\b|zoekadvertenties|performance max|\bpmax\b/i,
    field: 'Online adverteren met Google Ads',
    sources: [
      { kind: 'web', target: 'https://support.google.com/google-ads/announcements/9048695?hl=nl', label: 'Google Ads: nieuwe functies en aankondigingen' },
      { kind: 'feed', target: 'https://blog.google/products/ads-commerce/rss/', label: 'Google Ads & Commerce blog' },
      { kind: 'feed', target: 'https://ads-developers.googleblog.com/feeds/posts/default', label: 'Google Ads Developer Blog' },
    ],
    news: 'Google Ads update wijziging',
  },
  {
    id: 'seo',
    match: /\bseo\b|zoekmachine-?optimalisatie|search engine optimi[sz]ation|organisch(?:e)? (?:verkeer|vindbaarheid)/i,
    field: 'Zoekmachineoptimalisatie (SEO)',
    sources: [
      { kind: 'feed', target: 'https://developers.google.com/static/search/blog/feed.xml', label: 'Google Search Central Blog' },
      { kind: 'feed', target: 'https://status.search.google.com/en/feed.atom', label: 'Google Search Status (updates van het algoritme)' },
      { kind: 'web', target: 'https://developers.google.com/search/updates/ranking', label: 'Google: lijst van ranking-updates' },
      { kind: 'docs', target: 'https://developers.google.com/search/docs/essentials', label: 'Google Search Essentials' },
    ],
    news: 'Google Search core update SEO',
  },
  {
    id: 'meta-ads',
    match: /meta ads|facebook ads|instagram ads|facebook-?advertenties|social ads|adverteren (?:op|met) (?:meta|facebook|instagram)/i,
    field: 'Adverteren op Meta (Facebook en Instagram)',
    sources: [
      { kind: 'web', target: 'https://www.facebook.com/business/news', label: 'Meta for Business: nieuws' },
      { kind: 'feed', target: 'https://developers.facebook.com/blog/feed/', label: 'Meta for Developers Blog' },
    ],
    news: 'Meta Ads update advertentiebeleid',
  },
  {
    id: 'analytics',
    match: /google analytics|\bga4\b|webstatistieken|web analytics/i,
    field: 'Webstatistieken met Google Analytics 4',
    sources: [{ kind: 'web', target: 'https://support.google.com/analytics/answer/9164320?hl=nl', label: 'Google Analytics: wat is er nieuw' }],
    news: 'Google Analytics 4 update nieuw',
  },
  {
    id: 'shopify',
    match: /shopify/i,
    field: 'Webwinkels op Shopify',
    sources: [
      { kind: 'feed', target: 'https://changelog.shopify.com/feed', label: 'Shopify Changelog' },
      { kind: 'feed', target: 'https://shopify.dev/changelog/feed.xml', label: 'Shopify Developer Changelog' },
    ],
    news: 'Shopify update changelog',
  },
  {
    id: 'wordpress',
    match: /wordpress|woocommerce/i,
    field: 'Websites en webwinkels op WordPress en WooCommerce',
    sources: [
      { kind: 'feed', target: 'https://wordpress.org/news/feed/', label: 'WordPress News' },
      { kind: 'feed', target: 'https://developer.woocommerce.com/feed/', label: 'WooCommerce Developer Blog' },
    ],
    news: 'WordPress WooCommerce release update',
  },
  {
    id: 'webperf',
    match: /core web vitals|websnelheid|web ?performance|pagespeed/i,
    field: 'Websnelheid en Core Web Vitals',
    sources: [
      { kind: 'feed', target: 'https://web.dev/feed.xml', label: 'web.dev' },
      { kind: 'feed', target: 'https://developer.chrome.com/static/blog/feed.xml', label: 'Chrome for Developers' },
    ],
    news: 'Core Web Vitals update',
  },
  {
    id: 'privacy',
    match: /\bavg\b|\bgdpr\b|privacy(?:wet|regels)?|gegevensbescherming/i,
    field: 'Privacy en de AVG',
    sources: [{ kind: 'feed', target: 'https://www.autoriteitpersoonsgegevens.nl/rss.xml', label: 'Autoriteit Persoonsgegevens: actueel' }],
    news: 'AVG privacy nieuwe regels Autoriteit Persoonsgegevens',
  },
];

/** The specialism a text (a bot's name, role or field) names, or null. The first match wins (most specific first). */
export function specialismOf(text: string): Specialism | null {
  const s = String(text || '');
  return SPECIALISMS.find((x) => x.match.test(s)) || null;
}

/** Default sources for a field: those of every specialism it names (a "SEO en Google Ads" bot gets both), deduplicated. */
export function defaultSourcesFor(text: string, max = 6): DefaultSource[] {
  const out: DefaultSource[] = [];
  for (const sp of SPECIALISMS) {
    if (!sp.match.test(String(text || ''))) continue;
    for (const s of sp.sources) if (!out.some((o) => o.target === s.target)) out.push(s);
  }
  return out.slice(0, max);
}

/** What to search for to find what changed in this field this month ("Google Search core update SEO november 2026"). */
export function newsQuery(field: string, d = new Date()): string {
  const month = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'][d.getMonth()];
  const sp = specialismOf(field);
  return `${sp ? sp.news : `${String(field || '').slice(0, 80)} nieuw wijziging`} ${month} ${d.getFullYear()}`;
}

/** A bot's name or role says it is a specialist in something ("Belastingadviseur", "TikTok-specialist", "Imker-expert"). */
const SPECIALIST_WORD = /(specialist|expert|adviseur|advisor|consultant|deskundige|(?<!ver)kenner|strateeg|strategist|analist|analyst)(?:e|en|s)?\b/i;

/**
 * The field of a bot that was never set up, from its name and role — for any subject, not a fixed list: a preset's
 * field when one matches, else the bot's role (or its name without the word "specialist"/"expert" …). Null when
 * nothing says the bot is a specialist.
 */
export function fieldOf(name: string, role: string): string | null {
  // What the bot IS: its name and the head of its role, not everything its role mentions. Live (11 Nov 2026) a
  // "Contentschrijver: SEO-pagina's, gidsen …" became an SEO specialist because the word stood somewhere in the role.
  const text = `${name} ${roleHead(role)}`;
  const preset = specialismOf(text);
  if (preset) return preset.field;
  if (!SPECIALIST_WORD.test(text)) return null;
  const strip = (x: string) => x.replace(new RegExp(SPECIALIST_WORD.source, 'gi'), ' ').replace(/[-–_/|·]+/g, ' ').replace(/\s+/g, ' ').trim();
  const field = strip(role).length >= 3 ? role.trim() : strip(name);
  return field.length >= 3 ? field.slice(0, 300) : null;
}

/** The part of a role that names what the bot is: up to the first ":", ";", "," or " - " ("SEO-specialist: technische SEO, …" → "SEO-specialist"). */
export function roleHead(role: string): string {
  return String(role || '').split(/[:;,]|\s[-–—]\s/)[0].trim();
}

/** Words that say nothing about a subject (Dutch and English function words, and general words every page uses). */
const FILLER = new Set(
  (
    'aan alle alleen alles als and are bij dan dat de den der des deze die dit door een en for from geen het hun in is its met naar niet nog of om onder onze ook op over per te ' +
    'the their tot uit van veel voor wat wel wie with zijn wordt worden zoals zonder about all your our this that how what ' +
    'nieuw nieuwe nieuwste nieuws eigen andere goed goede groot grote klein kleine online algemeen algemene zaken dingen werk ' +
    'beheerder assistent medewerker manager bedrijf bedrijven plan plannen informatie officieel officiele website websites pagina paginas site sites ' +
    'wijziging wijzigingen scoort maakt helpt beheert schrijft zoekt new news guide page pages home blog'
  ).split(/\s+/),
);
const IS_SPECIALIST_WORD = new RegExp(`^${SPECIALIST_WORD.source}$`, 'i');

const plainWords = (s: string) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * The words that carry what a specialist's work is about (from its field, and where the caller wants from its role and
 * description): without function words, numbers and the words for "a specialist" themselves.
 */
export function subjectWords(...texts: (string | null | undefined)[]): string[] {
  return [...new Set(texts.flatMap((t) => plainWords(t || '')).filter((w) => w.length >= 3 && !FILLER.has(w) && !/^\d+$/.test(w) && !IS_SPECIALIST_WORD.test(w)))];
}

/** Does text word `x` name subject word `w`? The same word; a longer form of it ("webshop", "webshops"); for long words the same first six letters ("strategie", "strategisch"). */
const names = (x: string, w: string) => x === w || (w.length >= 6 ? x.startsWith(w.slice(0, 6)) : w.length >= 4 && x.startsWith(w));

/**
 * THE relevance check of the specialists: how many of the subject words a page names, in its title, in the readable
 * part of its link (host name and path) or inside its site name ("bijenhouders.nl" names "bijen"). `about` is a field
 * as text, or words from `subjectWords`. That a place is official says nothing about its subject: a government page
 * that comes up in a search is not a source for a bot whose work it does not name.
 */
export function topicHits(url: string, title: string, about: string | string[]): number {
  const words = typeof about === 'string' ? subjectWords(about) : about;
  if (!words.length) return 0;
  let host = '';
  let path = '';
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase().replace(/^www\./, '');
    path = decodeURIComponent(u.pathname);
  } catch {
    /* a file or a bare title: only the title counts */
  }
  const flat = host.replace(/[^a-z0-9]/g, '');
  const text = plainWords(`${title || ''} ${host.replace(/\.[a-z.]{2,6}$/, '')} ${path}`);
  return words.filter((w) => (w.length >= 4 && flat.includes(w.slice(0, 6))) || text.some((x) => names(x, w))).length;
}

/** Is this page about the field (or about these subject words)? See `topicHits`. */
export const onTopic = (url: string, title: string, about: string | string[]): boolean => topicHits(url, title, about) > 0;

/** What a specialist searches for to find its own sources. */
export function sourceQueries(field: string): string[] {
  const f = String(field || '').slice(0, 80);
  return [`${f} officiële informatie`, `${f} nieuws en wijzigingen`];
}

/** Places that talk about a subject rather than publish the facts themselves: never a source by themselves. */
const NOT_PRIMARY = /(^|\.)(reddit|quora|facebook|instagram|pinterest|youtube|youtu|tiktok|x|twitter|linkedin|medium|tumblr|wikipedia|wikihow|fandom|stackexchange|stackoverflow|amazon|bol|marktplaats|ebay|aliexpress)\.[a-z.]+$/i;
const OFFICIAL = /(\.gov(\.[a-z]{2})?$|\.overheid\.nl$|rijksoverheid\.nl$|europa\.eu$|\.edu$|\.ac\.[a-z]{2}$|^(docs|developers?|support|help|status|learn|kennisbank|nieuws|news|blog)\.)/i;

/**
 * How likely a search result is a primary source for this field (0 = no): a page that is about the field (`onTopic`:
 * a page about something else is never a source, however official), and then an official place (government, the
 * maker's own documentation, help or news pages) or a site whose own name carries the subject; never a forum, a social
 * network, a shop or an encyclopedia. A site about the platform itself is primary for that platform ("TikTok" →
 * tiktok.com), so the block list yields to a name match.
 */
export function primaryScore(url: string, title: string, field: string): number {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 0;
  }
  const words = String(field || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
  const flat = host.replace(/[^a-z0-9]/g, '');
  const inHost = words.some((w) => flat.includes(w.normalize('NFKD').replace(/[^a-z0-9]/g, '')));
  if (NOT_PRIMARY.test(host) && !inHost) return 0;
  if (!onTopic(url, title, field)) return 0;
  const inTitle = words.filter((w) => String(title || '').toLowerCase().includes(w)).length;
  return 1 + (OFFICIAL.test(host) ? 3 : 0) + (inHost ? 3 : 0) + Math.min(2, inTitle) + (/offici[eë]le?|official|vereniging|bond|autoriteit|instituut|institute|association/i.test(title || '') ? 1 : 0);
}
