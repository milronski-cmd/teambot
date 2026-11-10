/**
 * The languages TeamBot speaks (interface, dates and numbers, server texts, bot answers). Shared by the UI and the
 * server; no DOM here. The list lives in ui/src/i18n/languages.json so `npm run i18n:add -- <code>` can extend it;
 * each language except the source (Dutch) has a dictionary ui/src/i18n/<code>.json.
 */
import list from '../ui/src/i18n/languages.json' with { type: 'json' };

export interface Language {
  /** ISO 639-1 code, also the dictionary file name and the value of the `language` user setting. */
  code: string;
  /** Name in the language itself ("Deutsch"), shown in language pickers. */
  name: string;
  /** English name, for the translation prompt ("German"). */
  english: string;
  /** BCP 47 locale for Intl (dates, numbers, plurals). Arabic uses Latin digits (-u-nu-latn), like the rest of the app. */
  locale: string;
  dir: 'ltr' | 'rtl';
  /** The language the source texts are written in (no dictionary). */
  source?: boolean;
}

export const LANGUAGES: Language[] = list as Language[];
export const SOURCE_LANG = 'nl';
/** First-run fallback when none of the system languages is available. */
export const FALLBACK_LANG = 'en';

export function language(code: string | null | undefined): Language | undefined {
  return code ? LANGUAGES.find((l) => l.code === code) : undefined;
}

export const isLanguage = (code: unknown): code is string => typeof code === 'string' && LANGUAGES.some((l) => l.code === code);

/**
 * The best interface language for a list of system/browser languages ("de-AT", "pt-BR", "nb-NO" …): the first one
 * TeamBot has (by its primary subtag), else English.
 */
export function matchLanguage(prefs: readonly string[] | null | undefined, fallback = FALLBACK_LANG): string {
  for (const p of prefs || []) {
    const base = String(p || '')
      .toLowerCase()
      .split(/[-_]/)[0];
    if (isLanguage(base)) return base;
  }
  return fallback;
}

/** Locale for Intl; unknown codes fall back to the source language's. */
export const localeOf = (code: string | null | undefined): string => language(code)?.locale || language(SOURCE_LANG)!.locale;

/** Name of language `code` written in language `inLang` ("Duits" in Dutch, "German" in English); falls back to its own name. */
export function languageName(code: string, inLang: string = SOURCE_LANG): string {
  try {
    const n = new Intl.DisplayNames([inLang], { type: 'language' }).of(code);
    if (n && n !== code) return n;
  } catch {
    /* old ICU */
  }
  return language(code)?.name || code;
}
