/**
 * Which language speech is in. Shared by the server (local voices, speech providers) and the page (browser speech);
 * no DOM and no imports here, so both sides can use it.
 *
 * - Dictation language setting: 'auto-app' (default: detect, with the interface language as hint), 'auto' (detect
 *   without a hint), 'auto-<code>' (detect, hint <code>; 'auto-nl' is the old default) or a fixed language code.
 * - Scripts: a voice can only read its own writing system (the guess of a text's language itself is server side,
 *   server/modules/voice/textlang.ts, because its word lists must stay out of the interface-text extractor).
 * - Recommendations: which local speech model / voice fits a language, on any list with the catalog's shape, and
 *   which voice reads a text in a given language.
 */

/** Interface languages, also the languages a local voice or dictation hint can be for. */
export const SPEECH_LANGS = ['nl', 'en', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'tr', 'uk', 'ar'] as const;

/** BCP 47 locale for the browser's speech recognition and voices (Portuguese = Brazil, like the interface). */
const LOCALES: Record<string, string> = {
  nl: 'nl-NL',
  en: 'en-GB',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
  it: 'it-IT',
  pt: 'pt-BR',
  pl: 'pl-PL',
  tr: 'tr-TR',
  uk: 'uk-UA',
  ar: 'ar-SA',
  ru: 'ru-RU',
};

/** 'de' → 'de-DE'; a locale ('pt-PT') stays as it is. */
export function speechLocale(code: string): string {
  const c = String(code || '').trim();
  if (!c) return LOCALES.nl;
  if (c.includes('-')) return c;
  return LOCALES[c.toLowerCase()] || c.toLowerCase();
}

/** Primary language of a locale or voice language ("pt-BR" → "pt", "nl_NL" → "nl"). */
export const baseLang = (code: string | null | undefined) =>
  String(code || '')
    .toLowerCase()
    .split(/[-_]/)[0];

export const AUTO_APP = 'auto-app';

export interface SttHint {
  /** Recognise in exactly this language (null = the engine detects it). */
  fixed: string | null;
  /** Likely languages, most likely first (a hint for engines that take one). */
  prefer: string[];
}

/** What the dictation language setting means for a user whose interface is in `appLang`. */
export function sttHint(setting: string | null | undefined, appLang: string): SttHint {
  const s = String(setting || AUTO_APP);
  if (s === 'auto') return { fixed: null, prefer: [] };
  const pref = s === AUTO_APP ? appLang : s.startsWith('auto-') ? s.slice(5) : null;
  if (pref !== null) {
    const p = baseLang(pref) || 'nl';
    // English is common in between (names of programs, quotes): a second hint, as Dutch users always had.
    return { fixed: null, prefer: p === 'en' ? ['en'] : [p, 'en'] };
  }
  return { fixed: s, prefer: [s] };
}

/** The setting with 'auto-app' filled in ('auto-de' for a German interface); other values stay. */
export const resolveSttLanguage = (setting: string | null | undefined, appLang: string) => {
  const s = String(setting || AUTO_APP);
  return s === AUTO_APP ? `auto-${baseLang(appLang) || 'nl'}` : s;
};

/** Is this an automatic setting ('auto', 'auto-app', 'auto-xx')? */
export const isAutoLanguage = (setting: string | null | undefined) => !setting || setting === 'auto' || setting.startsWith('auto-');

/** The one language to use where an engine cannot detect it (browser speech recognition): fixed, else the hint. */
export function sttSingleLanguage(setting: string | null | undefined, appLang: string): string {
  const h = sttHint(setting, appLang);
  return h.fixed || h.prefer[0] || baseLang(appLang) || 'nl';
}

/**
 * The language the automatic local speech model is chosen for: a fixed dictation language, else the hint of an
 * automatic setting ('auto-tr' → Turkish), else the interface language. Parakeet does not know Turkish or Arabic, so
 * dictating Turkish with a Dutch interface needs Whisper.
 */
export const sttModelLanguage = (setting: string | null | undefined, appLang: string) => baseLang(sttSingleLanguage(setting, appLang)) || 'nl';

/**
 * The language a bot always speaks, as the server decides it (server/agent/language.ts botLanguage): the bot's own
 * choice (bot editor › Taal), else the owner's choice for all bots; null = automatic (the language you use). Its
 * voice and, in a call, the speech recognition follow it.
 */
export function botSpeechLanguage(own: unknown, userChoice: unknown): string | null {
  const known = (v: unknown): v is string => typeof v === 'string' && (SPEECH_LANGS as readonly string[]).includes(v);
  if (own === 'auto') return null;
  if (known(own)) return own;
  return known(userChoice) ? userChoice : null;
}

// ---------- text language ----------

/** Writing system per language; a voice can only read its own script. */
const SCRIPT: Record<string, 'latin' | 'cyrillic' | 'arabic'> = { uk: 'cyrillic', ru: 'cyrillic', ar: 'arabic' };
export const scriptOf = (lang: string | null | undefined) => SCRIPT[baseLang(lang)] || 'latin';

// ---------- recommendations ----------

/** The parts of a local model entry (server catalog or the page's model list) these helpers need. */
export interface SpeechModelInfo {
  id: string;
  kind: string;
  /** Languages it handles ('*' = many). */
  languages: string[];
  /** Voices: the language it speaks. */
  lang?: string | null;
  recommended?: boolean;
  /** Languages this model is the recommended choice for (overrides the generic order). */
  recommendedFor?: string[] | null;
}

const handles = (m: SpeechModelInfo, lang: string) => m.languages.includes(lang);

/**
 * Speech recognition models for a language, best first: the one recommended for it, then models that list the
 * language (recommended first), then multilingual ones ('*').
 */
export function sttModelsFor<T extends SpeechModelInfo>(lang: string, models: readonly T[]): T[] {
  const l = baseLang(lang);
  const stt = models.filter((m) => m.kind === 'stt');
  const rank = (m: T) => (m.recommendedFor?.includes(l) ? 0 : handles(m, l) ? (m.recommended ? 1 : 2) : m.languages.includes('*') ? 3 : 9);
  return stt
    .filter((m) => rank(m) < 9)
    .map((m, i) => ({ m, i, r: rank(m) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.m);
}

/** The recommended speech recognition model for a language. */
export const recommendedStt = <T extends SpeechModelInfo>(lang: string, models: readonly T[]): T | undefined => sttModelsFor(lang, models)[0];

/** Local voices that speak a language, the recommended one first (catalog order otherwise). */
export function voicesFor<T extends SpeechModelInfo>(lang: string, models: readonly T[]): T[] {
  const l = baseLang(lang);
  const v = models.filter((m) => m.kind === 'tts-voice' && baseLang(m.lang) === l);
  return [...v.filter((m) => m.recommended), ...v.filter((m) => !m.recommended)];
}

/** The recommended local voice for a language (undefined: no free local voice for it yet). */
export const recommendedVoice = <T extends SpeechModelInfo>(lang: string, models: readonly T[]): T | undefined => voicesFor(lang, models)[0];

/** Pick for an automatic choice: the best one that is already installed, else the best one (to download). */
export function preferInstalled<T extends SpeechModelInfo>(list: readonly T[], installed: (id: string) => boolean): T | undefined {
  return list.find((m) => installed(m.id)) || list[0];
}

/**
 * The voice that reads a text: the main voice, unless the text is in another language and a usable voice for that
 * language exists. `switching: false` (a bot with its own voice) keeps the main voice except for text in a script
 * it cannot read (Arabic, Cyrillic). `english`: the user's English voice ('' = read English with the main voice).
 */
export function chooseVoice<T extends SpeechModelInfo>(o: {
  main: T;
  textLang: string | null;
  models: readonly T[];
  usable(id: string): boolean;
  switching: boolean;
  english?: string;
}): T {
  const { main, textLang, models, usable } = o;
  if (!textLang) return main;
  const l = baseLang(textLang);
  const mainLang = baseLang(main.lang);
  if (l === mainLang) return main;
  const otherScript = scriptOf(l) !== scriptOf(mainLang);
  if (!o.switching && !otherScript) return main;
  if (l === 'en' && o.english === '' && !otherScript) return main;
  const byId = (id?: string) => (id ? models.find((m) => m.id === id) : undefined);
  const candidates = [...(l === 'en' && o.english ? [byId(o.english)] : []), ...voicesFor(l, models)].filter((m): m is T => !!m && m.kind === 'tts-voice' && m.id !== main.id);
  const hit = candidates.find((m) => usable(m.id));
  if (hit) return hit;
  if (otherScript) {
    // No voice for this language, but one that can at least read its letters (Russian text, Ukrainian voice).
    const same = models.find((m) => m.kind === 'tts-voice' && m.id !== main.id && scriptOf(m.lang) === scriptOf(l) && usable(m.id));
    if (same) return same;
  }
  return main;
}
