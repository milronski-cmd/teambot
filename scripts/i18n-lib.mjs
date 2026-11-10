// Shared helpers for the translation scripts and checks: the language list, dictionary files and validation.
import fs from 'node:fs';
import path from 'node:path';

export const root = process.cwd();
export const DICT_DIR = path.join(root, 'ui', 'src', 'i18n');
export const LANG_FILE = path.join(DICT_DIR, 'languages.json');
export const STRINGS_FILE = path.join(root, 'i18n', 'strings.json');
export const GLOSSARY_FILE = path.join(root, 'i18n', 'glossary.json');

export const languages = () => JSON.parse(fs.readFileSync(LANG_FILE, 'utf8'));
export const targets = () => languages().filter((l) => !l.source);
export const sourceStrings = () => JSON.parse(fs.readFileSync(STRINGS_FILE, 'utf8'));
export const dictFile = (code) => path.join(DICT_DIR, `${code}.json`);
export function readDict(code) {
  const f = dictFile(code);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
}
/** Sorted, one entry per line (stable diffs). */
export function writeDict(code, dict) {
  const sorted = Object.fromEntries(Object.keys(dict).sort().map((k) => [k, dict[k]]));
  fs.writeFileSync(dictFile(code), JSON.stringify(sorted, null, 1) + '\n');
}
export function writeLanguages(list) {
  fs.writeFileSync(LANG_FILE, '[\n' + list.map((l) => ' ' + JSON.stringify(l).replace(/":/g, '": ').replace(/,"/g, ', "').replace(/^\{/, '{ ').replace(/\}$/, ' }')).join(',\n') + '\n]\n');
}

/** "{0}", "{1}" … used in a text (also inside an ICU plural block), sorted. */
export function placeholders(s) {
  return [...new Set((String(s).match(/\{(\d+)[},]/g) || []).map((m) => `{${m.slice(1, -1)}}`))].sort().join(',');
}

const count = (s, re) => (String(s).match(re) || []).length;
const HTML_TAGS = new Set(['a', 'b', 'i', 'u', 's', 'em', 'strong', 'small', 'code', 'kbd', 'pre', 'span', 'div', 'p', 'br', 'hr', 'ul', 'ol', 'li', 'mark', 'sub', 'sup', 'img', 'h1', 'h2', 'h3', 'h4', 'table', 'tr', 'td', 'th', 'blockquote']);

/** Is an ICU plural block well formed ({0, plural, one {…} other {…}} with `other`)? */
function pluralOk(v) {
  const re = /\{(\d+)\s*,\s*plural\s*,/g;
  let m;
  while ((m = re.exec(v))) {
    let depth = 0;
    let end = -1;
    for (let i = m.index; i < v.length; i++) {
      if (v[i] === '{') depth++;
      else if (v[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) return false;
    const body = v.slice(m.index + m[0].length, end);
    if (!/\bother\s*\{/.test(body)) return false;
    // Keywords outside the forms: collapse the forms ({…}, also nested ones) first.
    let outer = body;
    for (let prev = ''; prev !== outer; ) (prev = outer), (outer = outer.replace(/\{[^{}]*\}/g, '§'));
    if (!/^(\s*(=\d+|zero|one|two|few|many|other)\s*§)+\s*$/.test(outer)) return false;
  }
  return depth0(v);
}
function depth0(v) {
  let d = 0;
  for (const c of String(v)) {
    if (c === '{') d++;
    else if (c === '}' && --d < 0) return false;
  }
  return d === 0;
}

/**
 * Problems with one translation (empty list = fine): placeholders, ICU plurals, markup (backticks, bold, tags,
 * links, line breaks), leading/trailing spaces.
 */
export function problems(src, dst) {
  const out = [];
  if (typeof dst !== 'string' || !dst.trim()) return ['leeg'];
  if (placeholders(src) !== placeholders(dst)) out.push(`placeholders ${placeholders(src)} ≠ ${placeholders(dst)}`);
  if (!pluralOk(dst)) out.push('plural/accolades');
  if (count(src, /`/g) !== count(dst, /`/g)) out.push('backticks');
  if (count(src, /\*\*/g) !== count(dst, /\*\*/g)) out.push('vet (**)');
  // HTML tags only: "<naam>" in "downloads/<naam>" is a placeholder word, and may be translated ("<name>").
  const tags = (s) =>
    (String(s).match(/<\/?[a-z][\w-]*[^>]*>/gi) || [])
      .map((t) => t.replace(/\s.*$/, '').toLowerCase())
      .filter((t) => HTML_TAGS.has(t.replace(/[</>]/g, '')))
      .sort()
      .join(',');
  if (tags(src) !== tags(dst)) out.push('tags');
  // A link has a host ("http://proxy:3128"); a bare "http://" in a sentence ("http://- und https://-Proxys") is not one.
  const urls = (s) => (String(s).match(/https?:\/\/[\w[][^\s)"'<>]*/g) || []).sort().join(',');
  if (urls(src) !== urls(dst)) out.push('links');
  if (count(src, /\n/g) !== count(dst, /\n/g)) out.push('regels');
  if (/^\s/.test(src) !== /^\s/.test(dst) || /\s$/.test(src) !== /\s$/.test(dst)) out.push('spaties');
  return out;
}

/**
 * Menu paths in translations ("Bot › Computer & bestanden › Eigen server (SSH)") must name the labels as the
 * interface shows them in that language. A model sometimes copies the Dutch labels; this replaces such a copied
 * label with its translation from the same dictionary. Strict, so names in other products stay ("Bot › Reset Token"
 * in Discord): only a whole path item that is a Dutch interface label, also a path item in the source, copied
 * unchanged. The first item may end a sentence ("… dans Instellingen"), the last may start one ("Spraak.",
 * "Computer & bestanden (…)"). Returns the number of changed translations.
 */
export function fixMenuPaths(dict, en = readDict('en')) {
  // A Dutch label: its English translation is a different word ("Instellingen" → "Settings"). Labels of other
  // products are English in the source too ("Settings" in GitHub, "Reset Token" in Discord) and stay as they are.
  const dutch = (s) => typeof en[s] === 'string' && en[s].toLowerCase() !== s.toLowerCase();
  const label = (s) => typeof dict[s] === 'string' && dict[s] && dict[s] !== s && /^[A-ZÀ-Ý]/.test(s) && s.split(' ').length <= 5 && dutch(s);
  // First item: the label it ends with, when the text before it is ordinary sentence text.
  const tailLabel = (seg) => {
    const words = seg.split(' ');
    for (let n = Math.min(5, words.length); n >= 1; n--) {
      const tail = words.slice(-n).join(' ').replace(/^\(/, '');
      const before = words.slice(0, -n).join(' ');
      // Lowercase (or caseless: Arabic) text before the label; never another capitalised name ("Google Auth …").
      if (label(tail) && (!before || /[\p{Ll}\p{Lo}\d,:;(]$/u.test(before))) return tail;
    }
    return '';
  };
  // Last item: the label it starts with, when the rest is punctuation or a lowercase continuation.
  const headLabel = (seg) => {
    const words = seg.split(' ');
    for (let n = Math.min(5, words.length); n >= 1; n--) {
      const head = words.slice(0, n).join(' ').replace(/[.,;:)]+$/, '');
      const rest = seg.slice(head.length);
      if (label(head) && /^[.,;:)]*(\s+[\p{Ll}\p{Lo}\d(“"'«]|$)/u.test(rest)) return head;
    }
    return '';
  };
  const items = (path) => {
    const segs = path.split(' › ');
    const last = segs.length - 1;
    return segs.map((seg, i) => (i === 0 ? tailLabel(seg) : i === last ? headLabel(seg) : label(seg) ? seg : ''));
  };
  let changed = 0;
  for (const [k, v] of Object.entries(dict)) {
    if (typeof v !== 'string' || !v.includes(' › ') || !k.includes(' › ')) continue;
    const src = new Set(items(k).filter(Boolean));
    const segs = v.split(' › ');
    const found = items(v);
    const out = segs.map((seg, i) => {
      const l = found[i];
      if (!l || !src.has(l)) return seg;
      const at = i === 0 ? seg.lastIndexOf(l) : seg.indexOf(l);
      return seg.slice(0, at) + dict[l] + seg.slice(at + l.length);
    });
    const nv = out.join(' › ');
    if (nv !== v) {
      dict[k] = nv;
      changed++;
    }
  }
  return changed;
}

/**
 * Plural categories an ICU plural block in `v` lacks for `locale` (Intl.PluralRules): Polish/Ukrainian need
 * one/few/many, Arabic one/few/many (zero/two may fall back to other). The "many" of French, Spanish, Italian and
 * Portuguese is only for millions ("1 million de …") and may fall back too. [] when fine or without a plural block.
 */
export function missingPlurals(locale, v) {
  if (!/\{\d+\s*,\s*plural\s*,/.test(String(v))) return [];
  const optional = new Set(['zero', 'two', 'other', ...(/^(fr|es|it|pt|ca)\b/.test(locale) ? ['many'] : [])]);
  const need = new Intl.PluralRules(locale).resolvedOptions().pluralCategories.filter((c) => !optional.has(c));
  const out = new Set();
  for (const m of String(v).matchAll(/\{\d+\s*,\s*plural\s*,/g)) {
    // The forms of this block: keywords at depth 1 inside it.
    let depth = 0;
    const used = new Set();
    let i = m.index;
    for (; i < v.length; i++) {
      if (v[i] === '{') {
        if (depth === 1) {
          const kw = /(zero|one|two|few|many|other|=\d+)\s*$/.exec(v.slice(Math.max(m.index, i - 12), i));
          if (kw) used.add(kw[1]);
        }
        depth++;
      } else if (v[i] === '}' && --depth === 0) break;
    }
    for (const c of need) if (!used.has(c)) out.add(c);
  }
  return [...out];
}

/** Strongly Dutch words (not ordinary words in the target languages). */
const NL_WORDS = ['het', 'een', 'niet', 'geen', 'wordt', 'worden', 'kunt', 'jouw', 'bericht', 'berichten', 'gesprek', 'gesprekken', 'instellingen', 'opslaan', 'annuleren', 'verwijderen', 'toevoegen', 'nieuwe', 'bewerken', 'zoeken', 'alles', 'nog', 'ook', 'maar', 'deze', 'kies', 'klik', 'hier', 'naar', 'voor', 'bij', 'wat', 'je', 'van', 'en', 'de', 'met', 'zijn', 'jij', 'wacht', 'gekoppeld', 'koppelen', 'sleutel', 'werkmap', 'eigen', 'altijd'];
/** Words of NL_WORDS that are also common in a target language. */
const SHARED = { de: ['hier', 'wacht', 'alles', 'eigen'], fr: ['je', 'de', 'en'], es: ['de', 'en', 'van'], pt: ['de', 'en'], it: ['nog'], tr: ['de', 'en'], en: [], pl: ['je'], uk: [], ar: [] };
export function dutchWords(lang) {
  const shared = new Set(SHARED[lang] || []);
  return new RegExp(`(?<![\\p{L}\\d])(${NL_WORDS.filter((w) => !shared.has(w)).join('|')})(?![\\p{L}\\d])`, 'iu');
}

/** Dutch words that mark a text as a sentence or label to translate (the same list the extractor uses). */
const DUTCH_TEXT = /(?<![\p{L}\d])(de|het|een|en|van|voor|niet|geen|met|op|je|jouw|wordt|worden|is|zijn|naar|bij|nog|alle|alles|alleen|kies|maak|opslaan|verwijderen|toevoegen|bewerken|instellingen|gesprek|bericht|berichten|groep|sleutel|terug|annuleren|klaar|fout|bezig|leeg|nieuwe?|koppel|koppelen|stoppen|starten|vragen|toestaan|weigeren|meer|over|wat|wie|waar|hoe|als|dan|ook|zoals|om|uit|aan|of|dit|deze|die|dat|kan|mag|moet|gebruik|gebruikt|bekijk|open|sluiten|zoeken|vandaag|gisteren|uur|dag|dagen|wacht|wachten|taak|taken|vraag)(?![\p{L}\d])|[ëïĳ]/iu;

/**
 * A text that stays as it is in every language: brand and product names ("Goose", "Gmail (Google)", "Claude Code:
 * {0}", "Amazon Bedrock"), keyboard keys ("Ctrl K", "Scroll Lock"), licences ("MIT (upstash/context7)"), example
 * names ("J. de Vries"). Every word is capitalised or technical, and none is a Dutch word. A translator may keep it
 * unchanged (also in Latin script for Ukrainian and Arabic); the checks never call it untranslated.
 */
export function nameLike(src) {
  let t = String(src)
    .replace(/\{\d+\}/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\w.-]+\/[\w./-]+/g, ' ') // paths and repositories ("upstash/context7")
    .replace(/(^|\s)[/@$][\w.-]+/g, ' ') // commands and handles ("/invite @bot")
    .replace(/<[a-z][\w-]*>/g, ' ') // placeholder words ("Bearer <token>")
    .replace(/\b[a-z]+[-_]…?(?=\s|$)/g, ' ') // token prefixes ("xoxb-…", "tbmcp_")
    .replace(/\b(https?|winget|npm|npx|pip|brew|curl|git|ssh|localhost|wifi|cmd)\b/g, ' '); // lowercase tool names
  // Dutch name particles between names ("J. de Vries", "Van der Berg", a business "Catering De Keuken") belong to the name.
  t = t.replace(/(?<=\p{Lu}[\p{L}.]*\s)(de|De|van|der|den|ter|ten)(?=\s+(?:(?:de|van|der|den|ter|ten)\s+)*\p{Lu})/gu, 'X');
  // A handle after a person's first and last name ("Jesse Vincent (obra)"), unless it is a Dutch word ("(aanbevolen)").
  t = t.replace(/(?<=^\p{Lu}\p{Ll}+\s\p{Lu}\p{Ll}+\s)\(([a-z][a-z0-9-]{1,38})\)$/u, (m) => (DUTCH_TEXT.test(m) || dutchWords('en').test(m) ? m : ' '));
  if (DUTCH_TEXT.test(t)) return false;
  const words = t.match(/\p{L}[\p{L}\d'’_.-]*/gu) || [];
  if (!words.length) return true;
  return words.every((w) => /^[\p{Lu}\d]/u.test(w) || /[\d_]/.test(w) || /\p{Lu}/u.test(w.slice(1)));
}

/** Latin-script terms a language keeps on purpose (glossary values such as "skill" in Arabic, "TeamBot"). */
let latinTermsCache = null;
function latinTerms(lang) {
  if (!latinTermsCache) {
    latinTermsCache = {};
    try {
      const all = JSON.parse(fs.readFileSync(GLOSSARY_FILE, 'utf8'));
      for (const [code, terms] of Object.entries(all)) latinTermsCache[code] = Object.values(terms).filter((v) => typeof v === 'string' && /^[A-Za-z][A-Za-z\s-]*$/.test(v));
    } catch {
      /* no glossary yet */
    }
  }
  return latinTermsCache[lang] || [];
}

/**
 * Script check: Ukrainian should be Cyrillic, Arabic Arabic script (a Latin-only value is suspicious). Not wrong:
 * product names and other name-like texts kept as they are (`src` given), and the language's own Latin glossary terms.
 */
export function wrongScript(lang, v, src) {
  if (lang !== 'uk' && lang !== 'ar') return false;
  // A lowercase product or project name kept as it is ("mollie", "arxiv", "kepano"): one word, unchanged.
  if (src !== undefined && v === src && /^[a-z][a-z0-9.-]*$/.test(String(src))) return false;
  // ICU plural syntax ("{0, plural, one {…} other {…}}") is not text: drop the keywords, keep the forms.
  let letters = String(v)
    .replace(/\{\d+\s*,\s*plural\s*,/g, ' ')
    .replace(/(=\d+|\b(zero|one|two|few|many|other))\s*\{/g, ' ')
    .replace(/\{[^{}]*\}|https?:\/\/\S+|`[^`]*`|\b[A-Z][\w.-]*[A-Z0-9]\w*\b/g, '');
  for (const term of latinTerms(lang)) letters = letters.replace(new RegExp(`(?<![A-Za-z])${term.replace(/[-\s]+/g, '[-\\s]+')}s?(?![A-Za-z])`, 'gi'), ' ');
  const own = lang === 'uk' ? /[Ѐ-ӿ]/ : /[؀-ۿ]/;
  if (!/[A-Za-z]{4,}/.test(letters) || own.test(letters)) return false;
  // Every Latin word also in a name-like source: a product name kept as is ("Amazon Bedrock", "Claude Code: {0}").
  if (src !== undefined && nameLike(src)) {
    const have = new Set((String(src).match(/[A-Za-z][\w.'’-]*/g) || []).map((w) => w.toLowerCase()));
    if ((String(v).match(/[A-Za-z][\w.'’-]*/g) || []).every((w) => have.has(w.toLowerCase()))) return false;
  }
  return true;
}

/** Placeholders (also whole plural blocks), links, code, e-mail addresses and paths taken out of a text. */
const noCode = (s) =>
  String(s)
    .replace(/\{\d+\s*,\s*plural\s*,(?:[^{}]|\{[^{}]*\})*\}/g, ' ')
    .replace(/\{\d+\}/g, ' ')
    // A literal output marker with a variable name ("[verborgen: $NAAM]") is code, the same in every language.
    .replace(/\[[^\]]*\$[A-Z][A-Z0-9_]*\]/g, ' ')
    .replace(/https?:\/\/\S+|`[^`]*`|\S+@\S+\.\S+|\S*[\\/]\S*/g, ' ')
    // Ids with digits, colons or underscores ("qwen3.6-uncensored-snel:latest", "gpt-5.4-mini") are names.
    .replace(/\S*\p{L}\S*?[\d:_]\S+|\S*[\d_]\S*?\p{L}\S*/gu, (w) => (/^[\d.,:]+\p{L}{0,3}[.,;)]?$/u.test(w) ? w : ' '));
/** Lowercase words of a text (letters only, at least `min`). */
const wordsOf = (s, min = 3) => noCode(s).toLowerCase().match(new RegExp(`\\p{L}{${min},}`, 'gu')) || [];
/** A text as lowercase words separated by one space (for phrase matching): "Geen extra kosten." → "geen extra kosten". */
const phraseOf = (s) => (String(s).toLowerCase().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).join(' ');

/**
 * A detector for Dutch left in the interface of `lang`: detect(text) → '' when fine, else why it is Dutch.
 *  - 'kapot': a placeholder or plural block shown as is ("{0}", "plural,");
 *  - 'onvertaald': a known source text the dictionary translates, shown as it is;
 *  - 'bevat "…"': a Dutch source text of two or more words inside the text ("haiku (geen extra kosten)");
 *  - 'woord "…"': a word of the Dutch source texts that this language's own translations never use
 *    ("abonnement" in English; German uses "Abonnement" too, so not there), or a strongly Dutch word (dutchWords).
 * Names (`keep`: bots, people, example data) are taken out first. `sources`/`dict` default to the files.
 */
/** Lowercase words of the Dutch source texts (names are capitalised and left out). */
function sourceWords(sources) {
  const out = new Set();
  for (const s of sources) if (!nameLike(s)) for (const w of noCode(s).match(/(?<![\p{L}\d])\p{Ll}{3,}(?![\p{L}\d])/gu) || []) out.add(w);
  return out;
}

/**
 * Translations that kept Dutch from their source: a run of two or more words copied from the source text with a word
 * in it that neither this language nor English uses anywhere else ("Alle routines staan op pauze ; niet uitgevoerd",
 * "Controle mislukt : {0}"). Returns the source texts. (A fully untranslated text is caught by `v === s` already.)
 */
export function copiedDutch(lang, dict = readDict(lang), sources = sourceStrings(), en = lang === 'en' ? dict : readDict('en')) {
  const test = copiedDutchTest(lang, dict, sources, en);
  return sources.filter((s) => typeof dict[s] === 'string' && test(s, dict[s]));
}

/** copiedDutch as a test for one translation: (source, translation) → true when it kept Dutch from the source. */
export function copiedDutchTest(lang, dict = readDict(lang), sources = sourceStrings(), en = lang === 'en' ? dict : readDict('en')) {
  // How many translations use a word: English ("streaming", "webm": technical words the Dutch source uses too) and
  // this language ("alle", "als", "Tabellen" are German as well).
  const tally = (d) => {
    const m = new Map();
    for (const [k, v] of Object.entries(d)) if (typeof v === 'string' && v !== k) for (const w of new Set(wordsOf(v, 2))) m.set(w, (m.get(w) || 0) + 1);
    return m;
  };
  const inEn = tally(en);
  const inOwn = lang === 'en' ? inEn : tally(dict);
  const words = sourceWords(sources);
  // Dutch-only: a source word English never uses (in English itself: only in this one text), and this language
  // hardly (a few translations with Dutch left in them).
  const dutchOnly = (w) => w.length > 2 && words.has(w) && (inEn.get(w) || 0) <= (lang === 'en' ? 1 : 0) && (inOwn.get(w) || 0) <= 3;
  return (s, v) => {
    if (typeof v !== 'string' || v === s || nameLike(s)) return false;
    // A proper name with a particle inside a sentence ("de Schijf van Vijf") is kept by a good translation.
    const src = phraseOf(noCode(s).replace(/\p{Lu}\p{Ll}+(?:\s+(?:van|de|der|den|het|ter|ten)\s+\p{Lu}\p{Ll}+)+/gu, ' ')).split(' ');
    const dst = ` ${phraseOf(noCode(v))} `;
    for (let i = 0; i + 1 < src.length; i++) if (dutchOnly(src[i]) && dutchOnly(src[i + 1]) && dst.includes(` ${src[i]} ${src[i + 1]} `)) return true;
    return false;
  };
}

export function dutchDetector(lang, o = {}) {
  const sources = o.sources || sourceStrings();
  const dict = o.dict || readDict(lang);
  const en = o.en || (lang === 'en' ? dict : readDict('en'));
  const strong = dutchWords(lang);
  const keep = [...new Set((o.keep || []).filter(Boolean))].sort((a, b) => b.length - a.length);
  const sourceSet = new Set(sources);
  // Words the language uses: the words of its translations and of the English ones (technical words such as
  // "streaming" or "webm" that the Dutch source uses too). Translations that copied Dutch are no evidence.
  const own = new Set((o.ownWords || []).map((w) => w.toLowerCase()));
  // The language's own month and weekday names from Intl ("mag" is May in Italian, not Dutch).
  try {
    const locale = (languages().find((l) => l.code === lang) || {}).locale || lang;
    for (const style of ['long', 'short']) {
      const mf = new Intl.DateTimeFormat(locale, { month: style, timeZone: 'UTC' });
      const wf = new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' });
      for (let i = 0; i < 12; i++) for (const w of wordsOf(mf.format(new Date(Date.UTC(2024, i, 15))), 2)) own.add(w);
      for (let i = 0; i < 7; i++) for (const w of wordsOf(wf.format(new Date(Date.UTC(2024, 0, 7 + i))), 2)) own.add(w);
    }
  } catch {
    /* no language list (unit tests with their own dictionaries) */
  }
  for (const d of lang === 'en' ? [dict] : [dict, en]) {
    const copied = new Set(copiedDutch(d === en ? 'en' : lang, d, sources, en));
    for (const [k, v] of Object.entries(d)) {
      if (typeof v !== 'string' || copied.has(k)) continue;
      if (v === k && !nameLike(k) && strong.test(k)) continue; // an untranslated Dutch text is no evidence
      for (const w of wordsOf(v, 2)) own.add(w);
      // Words inside plural forms ("{0, plural, one {# Ding über dich} …}") are the language's own words too.
      for (const m of v.matchAll(/(?:zero|one|two|few|many|other|=\d+)\s*\{([^{}]*)\}/g)) for (const w of wordsOf(m[1], 2)) own.add(w);
    }
  }
  // Dutch words: lowercase words of the source texts that the language never uses.
  const dutch = new Set([...sourceWords(sources)].filter((w) => !own.has(w)));
  // Short phrases the translations themselves contain ("Claude Code", "Google Drive") are no Dutch evidence.
  const ownPhrases = new Set();
  for (const [k, v] of Object.entries(dict)) {
    if (typeof v !== 'string' || v === k) continue;
    const ws = phraseOf(v).split(' ');
    for (let i = 0; i < ws.length; i++) for (let n = 2; n <= 4 && i + n <= ws.length; n++) ownPhrases.add(ws.slice(i, i + n).join(' '));
  }
  // Dutch phrases: source texts of 2+ words (without placeholders) that the dictionary translates differently.
  const phrases = new Set();
  let longest = 2;
  for (const s of sources) {
    if (/\{\d/.test(s)) continue;
    const v = dict[s];
    if (typeof v !== 'string' || v === s || nameLike(s)) continue;
    const p = phraseOf(s);
    const n = p.split(' ').length;
    if (n < 2 || (n <= 4 && ownPhrases.has(p)) || p === phraseOf(v)) continue;
    // Two words of which neither is Dutch ("Live demo", "API key") prove nothing.
    if (n === 2 && !p.split(' ').some((w) => dutch.has(w) || strong.test(w))) continue;
    phrases.add(p);
    longest = Math.max(longest, n);
  }
  return function detect(text) {
    let t = String(text).replace(/\s+/g, ' ').trim();
    if (!t) return '';
    if (/\{\d+\}|\{\d+\s*,\s*plural|\bplural\s*,|\b(one|other|few|many)\s*\{/.test(t)) return 'kapot';
    if (keep.includes(t)) return '';
    // A single word the language itself uses ("of" in English, "Abonnement" in German) is not untranslated.
    if (sourceSet.has(t) && typeof dict[t] === 'string' && dict[t] !== t && !nameLike(t) && !(/^\p{L}+$/u.test(t) && own.has(t.toLowerCase()))) return 'onvertaald';
    for (const k of keep) t = t.split(k).join(' · ');
    const ws = phraseOf(t).split(' ').filter(Boolean);
    for (let i = 0; i < ws.length; i++)
      for (let n = Math.min(longest, ws.length - i); n >= 2; n--) {
        const p = ws.slice(i, i + n).join(' ');
        if (phrases.has(p)) return `bevat "${p}"`;
      }
    if (nameLike(t)) return '';
    for (const w of wordsOf(t)) if (dutch.has(w)) return `woord "${w}"`;
    // Strongly Dutch words ("het", "een", "niet") count unless the language uses them too ("die", "je", "Bericht").
    for (const m of noCode(t).matchAll(new RegExp(strong.source, 'giu'))) if (!own.has(m[0].toLowerCase())) return `woord "${m[0]}"`;
    return '';
  };
}
