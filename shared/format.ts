/**
 * Dates, times, numbers, money and plural forms in the interface language, via Intl. Every function takes an
 * optional locale (tests, server texts); by default the interface locale, which lib/i18n.ts binds on load
 * (bindLocale). No DOM here, so the server and the tests can use it too.
 */
import { fillSource } from './i18n-core.js';

type Tpl = (tpl: string, ...values: (string | number)[]) => string;
const hooks: { locale: () => string; t: Tpl; fragment: (s: string) => string; known: (s: string) => string } = {
  locale: () => 'nl-NL',
  t: (s, ...values) => (values.length || /\{\d+\s*,\s*plural\s*,/.test(s) ? fillSource(s, values) : s),
  fragment: (s) => s,
  known: (s) => s,
};
/** lib/i18n.ts: the interface locale and the dictionary for the few words Intl does not have ("zojuist"). */
export function bindLocale(locale: () => string, translate: Tpl, fragment?: (s: string) => string, known?: (s: string) => string) {
  hooks.locale = locale;
  hooks.t = translate;
  if (fragment) hooks.fragment = fragment;
  if (known) hooks.known = known;
}
/** The interface locale ("nl-NL", "en-GB" …) for modules without the DOM. */
export const interfaceLocale = (): string => hooks.locale();
/** A piece of a composed sentence (" voor 3 bots", ": een bestand schrijven") in the interface language. */
export const tFragment = (s: string): string => hooks.fragment(s);
/**
 * A stored or catalogue text that may be one of TeamBot's own source texts (a team's starting rule, the description
 * of a catalogue entry): its translation when the dictionary has exactly this text, else the text as it is. Never a
 * pattern or a part of it, so the owner's own rule or a skill's own description stays exactly as written.
 */
export const tKnown = (s: string): string => hooks.known(s);
const uiLocale = () => hooks.locale();
const t = (s: string) => hooks.t(s);
/**
 * lib/i18n's t() for modules without the DOM (pure helpers that the unit tests and the server load): a Dutch template
 * with values in the interface language; in Dutch (tests) the source filled in. Import it as `t` so the extractor sees
 * the template.
 */
export const tText: Tpl = (tpl, ...values) => hooks.t(tpl, ...values);

const cache = new Map<string, any>();
function cached<T>(key: string, make: () => T): T {
  let v = cache.get(key);
  if (!v) {
    v = make();
    if (cache.size > 200) cache.clear();
    cache.set(key, v);
  }
  return v;
}
const dtf = (locale: string, o: Intl.DateTimeFormatOptions) => cached(`d|${locale}|${JSON.stringify(o)}`, () => new Intl.DateTimeFormat(locale, o));
const nf = (locale: string, o: Intl.NumberFormatOptions) => cached(`n|${locale}|${JSON.stringify(o)}`, () => new Intl.NumberFormat(locale, o));
const toDate = (d: Date | string | number) => (d instanceof Date ? d : new Date(d));

/** 7 nov 2026 / 7 Nov 2026 / 7. Nov. 2026 (year only when it is not this year, unless `year` is given). */
export function formatDate(d: Date | string | number, o: Intl.DateTimeFormatOptions = {}, locale = uiLocale()): string {
  const date = toDate(d);
  if (isNaN(date.getTime())) return '';
  const opts: Intl.DateTimeFormatOptions = Object.keys(o).length ? o : { day: 'numeric', month: 'short', ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) };
  return dtf(locale, opts).format(date);
}

/** 14:05 (or 2:05 pm where the locale uses a 12-hour clock). */
export function formatTime(d: Date | string | number, locale = uiLocale()): string {
  const date = toDate(d);
  return isNaN(date.getTime()) ? '' : dtf(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
}

/** Date and time, medium date + short time. */
export function formatDateTime(d: Date | string | number, o: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }, locale = uiLocale()): string {
  const date = toDate(d);
  return isNaN(date.getTime()) ? '' : dtf(locale, o).format(date);
}

export function formatNumber(n: number, o: Intl.NumberFormatOptions = {}, locale = uiLocale()): string {
  return Number.isFinite(n) ? nf(locale, o).format(n) : '';
}

/** Money: $1.23 / 1,23 $ / 1,23 US$ — currency USD unless given. */
export function formatMoney(n: number, currency = 'USD', o: Intl.NumberFormatOptions = {}, locale = uiLocale()): string {
  return Number.isFinite(n) ? nf(locale, { style: 'currency', currency, ...o }).format(n) : '';
}

/**
 * Dollars as TeamBot shows costs and prices: "US$ 0,00" (nl), "0,30 $" (de), "US$0.30" (en). Two decimals; amounts
 * under a cent keep up to four ("US$ 0,0123") so they never read as zero. `max`/`min` set the decimals (a price per
 * minute: { max: 3 }).
 */
export function formatUsd(usd: number, o: { min?: number; max?: number } = {}, locale = uiLocale()): string {
  if (!Number.isFinite(usd)) return '';
  const max = o.max ?? (usd !== 0 && Math.abs(usd) < 0.01 ? 4 : 2);
  return formatMoney(usd, 'USD', { minimumFractionDigits: Math.min(o.min ?? 2, max), maximumFractionDigits: max }, locale);
}

/** A range of dollars: "US$ 0,02–0,05" (nl), "0,02–0,05 $" (de), "US$0.02–US$0.05" (en). */
export function formatUsdRange(low: number, high: number, o: { min?: number; max?: number } = {}, locale = uiLocale()): string {
  if (!Number.isFinite(low) || !Number.isFinite(high)) return '';
  const max = o.max ?? 2;
  const f = nf(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: Math.min(o.min ?? 2, max), maximumFractionDigits: max });
  return typeof f.formatRange === 'function' ? f.formatRange(low, high) : `${f.format(low)}–${f.format(high)}`;
}

/** A share of 0–100 as a percentage: "4,3%" (nl), "4.3%" (en), "4,3 %" (de); one decimal below 10, else whole. */
export function formatPercent(pct: number, locale = uiLocale()): string {
  if (!Number.isFinite(pct)) return '';
  const digits = Math.abs(pct) < 10 && pct % 1 ? 1 : 0;
  return nf(locale, { style: 'percent', minimumFractionDigits: 0, maximumFractionDigits: digits }).format(pct / 100);
}

/** A large count, short: "188,3K" (nl), "188.3k" (en), "1,2 Mio." (de); below 1000 the plain number. */
export function formatCompact(n: number, locale = uiLocale()): string {
  return Number.isFinite(n) ? nf(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n) : '';
}

/** A token count for a context window or model size: "128K" / "1,05 mln." — compact, like formatCompact. */
export const formatTokens = (n: number, locale = uiLocale()): string => formatCompact(n, locale);

/** Seconds with one decimal from milliseconds: "2,0 s" (nl), "2.0s" (en), "2,0 Sek." (de). */
export function formatSeconds(ms: number, locale = uiLocale()): string {
  return Number.isFinite(ms) ? nf(locale, { style: 'unit', unit: 'second', unitDisplay: 'narrow', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(ms / 1000) : '';
}

/** 1.5 MB / 1,5 MB (binary units, one decimal from MB). */
export function formatBytes(bytes: number, locale = uiLocale()): string {
  if (!Number.isFinite(bytes)) return '';
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return nf(locale, { style: 'unit', unit: units[i], unitDisplay: 'short', maximumFractionDigits: i >= 2 ? 1 : 0 }).format(v);
}

/**
 * Plural form for a count: plural(3, { one: '# bericht', other: '# berichten' }) → "3 berichten". Categories as in
 * Intl.PluralRules for the locale (zero/one/two/few/many/other); a missing one falls back to `other`. `#` is the
 * formatted number.
 */
export function plural(n: number, forms: Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }, locale = uiLocale()): string {
  const cat = cached(`p|${locale}`, () => new Intl.PluralRules(locale)).select(n) as Intl.LDMLPluralRule;
  return (forms[cat] ?? forms.other).replace(/#/g, formatNumber(n, {}, locale));
}

/**
 * A list in words: "a, b en c" (nl), "a, b and c" (en), "a, b und c" (de); `or` for "a, b of c". The one place that
 * joins a list for people: a hand-made " en " stayed Dutch in every other language. Translate the items first.
 */
export function formatList(items: string[], locale = uiLocale(), o: { or?: boolean } = {}): string {
  const type = o.or ? 'disjunction' : 'conjunction';
  try {
    return cached(`l|${locale}|${type}`, () => new Intl.ListFormat(locale, { type })).format(items);
  } catch {
    return items.join(', ');
  }
}

/** Seconds/minutes/hours/days ago or ahead, in words ("5 minuten geleden", "vor 5 Minuten", "gisteren"). */
export function relativeTime(d: Date | string | number, o: { now?: number; style?: Intl.RelativeTimeFormatStyle } = {}, locale = uiLocale()): string {
  const date = toDate(d);
  if (isNaN(date.getTime())) return '';
  const diff = (date.getTime() - (o.now ?? Date.now())) / 1000;
  const abs = Math.abs(diff);
  const rtf = cached(`r|${locale}|${o.style || 'long'}`, () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: o.style || 'long' }));
  if (abs < 45) return rtf.format(0, 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / (86400 * 7)), 'week');
  if (abs < 86400 * 365) return rtf.format(Math.round(diff / (86400 * 30)), 'month');
  return rtf.format(Math.round(diff / (86400 * 365)), 'year');
}

/** A duration as a compact unit ("5 min", "3 uur", "2 d" / "5 mins", "3 hr", "2 days"). */
export function formatDuration(value: number, unit: 'second' | 'minute' | 'hour' | 'day', locale = uiLocale()): string {
  return nf(locale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 0 }).format(value);
}

/**
 * Compact age for lists: under a minute "zojuist" (from the dictionary), then
 * "5 min" / "3 uur" / "2 dagen" in the locale, from a week on the date.
 */
export function shortAgo(d: Date | string | number, now = Date.now(), locale = uiLocale()): string {
  const date = toDate(d);
  if (isNaN(date.getTime())) return '';
  const s = (now - date.getTime()) / 1000;
  if (s < 60) return t('zojuist');
  if (s < 3600) return formatDuration(Math.floor(s / 60), 'minute', locale);
  if (s < 86400) return formatDuration(Math.floor(s / 3600), 'hour', locale);
  if (s < 86400 * 7) return formatDuration(Math.floor(s / 86400), 'day', locale);
  return dtf(locale, { day: 'numeric', month: 'short' }).format(date);
}

/** Chat-list time: today → 14:05, yesterday → "gisteren"/"gestern", this week → weekday, else → 3 nov. */
export function listTimeIn(d: Date | string | number, now = Date.now(), locale = uiLocale()): string {
  const date = toDate(d);
  if (isNaN(date.getTime())) return '';
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return formatTime(date, locale);
  if (date.toDateString() === new Date(now - 864e5).toDateString()) return yesterdayWord(locale);
  if (now - date.getTime() < 6 * 864e5) return dtf(locale, { weekday: 'short' }).format(date);
  return dtf(locale, { day: 'numeric', month: 'short' }).format(date);
}

/** "gisteren"/"yesterday"/"gestern" (the day before today in words). */
export const yesterdayWord = (locale = uiLocale()) => cached(`r|${locale}|long`, () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'long' })).format(-1, 'day');

/**
 * The first letter in upper case, for a date or text that starts a heading ("zaterdag 7 november" → "Zaterdag 7
 * november"). Never CSS `capitalize`: that makes every word upper case ("Zaterdag 7 November"), wrong in Dutch.
 */
export const capFirst = (s: string, locale = uiLocale()): string => (s ? s.charAt(0).toLocaleUpperCase(locale) + s.slice(1) : s);
