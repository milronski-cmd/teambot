/**
 * Server texts in the user's language. Most server texts reach the owner through the interface, which translates
 * the page itself (ui/src/lib/i18n.ts). Texts that leave TeamBot without passing the page — phone pushes, desktop
 * notifications, messages in chat apps — are translated here with the same dictionaries (ui/src/i18n/<code>.json,
 * copied to dist/i18n by the build).
 *
 *   tr(lang, 'Je bot {0} is klaar', name)    a source template with values (plural forms work)
 *   tr(lang, text)                             a finished Dutch text (exact entry, pattern or its parts)
 *   userLanguage(store, userId)                the interface language the user chose ('nl' until they choose)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Translator, fill } from '../../shared/i18n-core.js';
import { isLanguage, localeOf, SOURCE_LANG } from '../../shared/languages.js';
import { formatBytes, formatUsd } from '../../shared/format.js';

interface SettingsStore {
  getSetting<T = any>(userId: string, key: string, def: T): T;
}

/** The interface language of a user (the `language` setting); Dutch for users who never chose one. */
export function userLanguage(store: SettingsStore | null | undefined, userId: string | null | undefined): string {
  if (!store || !userId) return SOURCE_LANG;
  try {
    const v = store.getSetting<string>(userId, 'language', '');
    return isLanguage(v) ? v : SOURCE_LANG;
  } catch {
    return SOURCE_LANG;
  }
}

/** Locale for Intl (dates and numbers in server texts) of a user. */
export const userLocale = (store: SettingsStore | null | undefined, userId: string | null | undefined) => localeOf(userLanguage(store, userId));

/**
 * Dollars in a server text: always in the source notation ("US$ 0,30"), as a value the translator recognises. Such a
 * text is often stored (an error in the chat, a routine's limit, a notice) and read later, maybe by someone with
 * another language; the page (and trUser/trUserText for pushes and chat apps) puts the amount in the reader's notation
 * when it is shown: "US$0.30" (en), "0,30 $" (de). Acceptance round 5, C-17: "Your daily limit of US$ 0,50".
 */
export const usdText = (n: number, o: { min?: number; max?: number } = {}) => formatUsd(n, o, localeOf(SOURCE_LANG));

/**
 * "1 bestand" / "3 bestanden": a Dutch count for texts only the bots read (prompts, tool results). Interface texts use
 * a whole sentence per form instead (`n === 1 ? '1 bestand overgeslagen' : `${n} bestanden overgeslagen``), so every
 * language can translate each form.
 */
export const nlCount = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * A size in a server text, in the source notation ("1,5 MB", "13 kB", "38 byte") through format.ts formatBytes, never
 * by hand: `${(n / 1048576).toFixed(1)} MB` gave "1.5 MB" in a Dutch sentence (acceptance round 6: "13.3 KB").
 */
export const bytesText = (n: number) => formatBytes(n, localeOf(SOURCE_LANG));

let dirCache: string | null | undefined;
function dictDir(): string | null {
  if (dirCache !== undefined) return dirCache;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.TEAMBOT_I18N_DIR || '',
    path.join(here, '..', 'i18n'), // dist/server/main.js → dist/i18n
    path.join(here, '..', '..', 'ui', 'src', 'i18n'), // server/core/i18n.ts (dev) or dist/server (repo checkout)
    path.join(here, '..', '..', 'dist', 'i18n'),
    path.join(process.cwd(), 'ui', 'src', 'i18n'),
  ].filter(Boolean);
  dirCache = candidates.find((d) => fs.existsSync(path.join(d, 'languages.json'))) || null;
  return dirCache;
}

const translators = new Map<string, Translator | null>();

/** The compiled dictionary of a language (null for the source language or when the dictionary is missing). */
export function translatorFor(lang: string): Translator | null {
  if (lang === SOURCE_LANG || !isLanguage(lang)) return null;
  if (translators.has(lang)) return translators.get(lang)!;
  let t: Translator | null = null;
  const dir = dictDir();
  try {
    if (dir) t = new Translator(JSON.parse(fs.readFileSync(path.join(dir, `${lang}.json`), 'utf8')), localeOf(lang));
  } catch {
    t = null;
  }
  translators.set(lang, t);
  return t;
}

const plainRules = new Intl.PluralRules('nl-NL');

/** Translate a Dutch source text (or template with values) into `lang`. */
export function tr(lang: string, text: string, ...values: (string | number)[]): string {
  const t = translatorFor(lang);
  if (!t) return values.length ? fill(text, values.map(String), plainRules) : text;
  return values.length ? t.format(text, values) : t.translate(text);
}

/** `tr` in the language of a user. */
export function trUser(store: SettingsStore | null | undefined, userId: string | null | undefined, text: string, ...values: (string | number)[]): string {
  return tr(userLanguage(store, userId), text, ...values);
}

interface NamesStore extends SettingsStore {
  all<T = any>(sql: string, ...params: any[]): T[];
}

/** Names that stay as they are in a user's texts: their bots and the people on this installation. */
function namesFor(store: NamesStore, userId: string): string[] {
  try {
    const bots = store.all<{ name: string }>('SELECT name FROM agents WHERE user_id = ?', userId);
    const people = store.all<{ name: string }>('SELECT name FROM users');
    return [...bots, ...people].map((r) => String(r.name || '')).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * A finished Dutch text (a notification title, an approval summary, an error) in a user's language, with the names
 * of their bots and of people kept as they are ("Onderzoeker is klaar" → "Onderzoeker ist fertig", never "Forscher").
 */
export function trUserText(store: NamesStore | null | undefined, userId: string | null | undefined, text: string): string {
  const t = translatorFor(userLanguage(store, userId));
  if (!t || !text) return text;
  return store && userId ? t.translateKeeping(text, namesFor(store, userId)) : t.translate(text);
}

/** For tests: drop loaded dictionaries. */
export function resetTranslators() {
  translators.clear();
  dirCache = undefined;
}
