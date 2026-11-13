/**
 * Dictionary translation without the DOM, shared by the interface (lib/i18n.ts walks the page) and the server
 * (server/core/i18n.ts: pushes, desktop notifications, channel messages).
 *
 * A dictionary maps the Dutch source text to the target text. Keys with {0} {1} … are patterns: "{0} berichten"
 * matches "12 berichten". A value may choose a plural form for a placeholder with ICU syntax:
 *   "{0, plural, one {# wiadomość} few {# wiadomości} many {# wiadomości} other {# wiadomości}}"
 * The category comes from Intl.PluralRules for the language (zero/one/two/few/many/other, and =N for an exact number);
 * a missing category falls back to `other`. `#` is the captured number.
 */

export type Dict = Record<string, string>;

interface Pattern {
  re: RegExp;
  tpl: string;
  first: string;
  /** Length of the fixed text (without placeholders): longer is more specific. */
  fixed: number;
  /** Separators of a composed text the pattern itself contains ("—", "·"). */
  seps: string;
}

/** Placeholders of a text: "{0}", "{1}" … (also the ones inside a plural block), sorted, for checks. */
export function placeholders(s: string): string[] {
  return [...new Set((s.match(/\{(\d+)[},]/g) || []).map((m) => `{${m.slice(1, -1)}}`))].sort();
}

/** Number in a captured text ("1.234", "1,5", "12 %") for plural selection; NaN when there is none. */
export function numberIn(s: string): number {
  const m = String(s).match(/-?\d[\d.,   ]*/);
  if (!m) return NaN;
  let t = m[0].replace(/[   ]/g, '');
  // "1.234" / "1,234" (thousands) vs "1,5" / "1.5" (decimals): a separator followed by exactly three digits at the
  // end is a thousands separator.
  t = t.replace(/[.,](?=\d{3}(?:\D|$))/g, '');
  return Number(t.replace(',', '.'));
}

/** Find the end of a {...} block starting at `open` (index of "{"), counting nested braces. */
function blockEnd(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Fill a template: {N} → values[N]; {N, plural, one {…} other {…}} → the form for values[N] (# = the value).
 * `rules` is Intl.PluralRules for the target language.
 */
export function fill(tpl: string, values: string[], rules: Intl.PluralRules): string {
  let out = '';
  let i = 0;
  while (i < tpl.length) {
    const c = tpl[i];
    if (c === '{') {
      const m = /^\{(\d+)\s*,\s*plural\s*,/.exec(tpl.slice(i));
      if (m) {
        const end = blockEnd(tpl, i);
        if (end > 0) {
          // The chosen form may hold other placeholders too ("… stil ({1})"): fill those as well.
          out += fill(pluralForm(tpl.slice(i + m[0].length, end), values[Number(m[1])] ?? '', rules), values, rules);
          i = end + 1;
          continue;
        }
      }
      const p = /^\{(\d+)\}/.exec(tpl.slice(i));
      if (p) {
        out += values[Number(p[1])] ?? '';
        i += p[0].length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

const sourceRules = new Intl.PluralRules('nl-NL');
/** A Dutch source template filled in Dutch (no dictionary): {N} and ICU plural blocks with the Dutch forms. */
export const fillSource = (tpl: string, values: (string | number)[]): string => fill(tpl, values.map((v) => String(v ?? '')), sourceRules);

function pluralForm(body: string, value: string, rules: Intl.PluralRules): string {
  const forms = new Map<string, string>();
  const re = /\s*(=\d+|zero|one|two|few|many|other)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const open = m.index + m[0].length - 1;
    const end = blockEnd(body, open);
    if (end < 0) break;
    forms.set(m[1], body.slice(open + 1, end));
    re.lastIndex = end + 1;
  }
  const n = numberIn(value);
  let pick: string | undefined;
  if (!Number.isNaN(n)) pick = forms.get(`=${n}`) ?? forms.get(rules.select(n));
  return (pick ?? forms.get('other') ?? '').replace(/#/g, value);
}

/**
 * The regular expression for a pattern key. A placeholder between spaces needs text ("{0} berichten"); one glued to
 * the text or placeholder next to it is an optional part that may be empty, as the code that builds such texts leaves
 * it out ("hebt de routine {0} gemaakt{1}" with no " (elke dag)" after it, "Context {0} vol{1}").
 */
export function patternSource(k: string): string {
  const parts = k.split(/(\{\d+\})/);
  let src = '^';
  parts.forEach((p, i) => {
    if (i % 2 === 0) {
      src += p.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
      return;
    }
    const before = parts[i - 1];
    const after = parts[i + 1];
    const prev = before ? before[before.length - 1] : i > 1 ? '}' : '';
    const next = after ? after[0] : i < parts.length - 2 ? '{' : '';
    src += (prev && prev !== ' ') || (next && next !== ' ') ? '(.*?)' : '(.+?)';
  });
  return src + '$';
}

/** Separators around a text fragment in the page (" · handmatig", "— nog downloaden", ". Bots met …"). */
const EDGES = /^([\s·•—–|,;:.)]*)(.*?)([\s·•—–|,;:(]*)$/s;

/** A dollar amount in the source notation: "US$ 0,50", "US$ 1.234,5678", "US$ -2,00" (Dutch, as the server writes it). */
const SOURCE_USD = /US\$[\s ](-?)(\d{1,3}(?:\.\d{3})*)(?:,(\d+))?(?!\d|[.,]\d)/g;

/**
 * Dollar amounts of a server text in the reader's notation. The server writes amounts in the source notation
 * ("US$ 0,50", server/core/i18n.ts usdText) and stores the text; translating it puts every amount in the notation of
 * the language it is read in ("US$0.50", "0,50 $"), with the same number of decimals. So a stored notice follows the
 * reader instead of the language of the moment it was written (acceptance round 5, C-17: "Your daily limit of
 * US$ 0,50"). Only a value that holds nothing but amounts and signs ("US$ 0,50", "≈ US$ 0,24") is changed; null
 * when there is none.
 */
export function localizeUsd(s: string, locale: string): string | null {
  if (!s.includes('US$')) return null;
  SOURCE_USD.lastIndex = 0;
  if (/[A-Za-zÀ-ÿ]/.test(s.replace(SOURCE_USD, ''))) return null;
  let changed = false;
  const out = s.replace(SOURCE_USD, (all, minus: string, int: string, dec?: string) => {
    const n = Number(`${minus}${int.replace(/\./g, '')}.${dec || '0'}`);
    if (!Number.isFinite(n)) return all;
    const d = dec?.length ?? 0;
    changed = true;
    return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
  });
  return changed ? out : null;
}

/**
 * The end of a sentence inside a captured value ("… 13:19. Bots met …"), so a placeholder never swallows the next
 * sentence. A day number with a full stop before a month is a date, not a sentence end: German writes "7. Nov. 2026",
 * and every template with such a date stayed Dutch in German (acceptance round 5, C-15: the memory page).
 */
const SENTENCE_END = /(?<!(?:^|[\s(])\d{1,2})[.!?]\s+\p{Lu}/u;

/**
 * TeamBot's own words with someone else's in them, stored so every reader gets them in his own language: a Dutch
 * template and the values that go in it (a name, a chat title, a routine's name), which are shown as written. The
 * screen shows it with components/Words.tsx; the dictionary has the template.
 */
export interface Words {
  text: string;
  values?: WordsValue[];
}

/**
 * A value in TeamBot's words: someone's own words (text, shown as written), a number, or TeamBot's words again with
 * their own values ("Klik op {0}" with "de knop “{0}”" and the button's name), which are translated too.
 */
export type WordsValue = string | number | Words;

export const isWords = (v: unknown): v is Words => !!v && typeof v === 'object' && typeof (v as Words).text === 'string';

/**
 * TeamBot's words with someone's own words in them, as stored: a Dutch template and its values. The one way a step,
 * a note or a line is made with a name, a path or what a bot wrote in it ("Taak aan {0}: {1}", bot, task). A missing
 * value is empty text; anything else that is not a number or words becomes text.
 */
export function words(text: string, ...values: unknown[]): Words {
  return values.length ? { text, values: values.map((v) => (v == null ? '' : typeof v === 'number' || isWords(v) ? v : String(v))) } : { text };
}

/** Words as one Dutch text: what the bot reads, the log and an export (the template filled in, nested words too). */
export function fillWords(w: Words | string): string {
  if (typeof w === 'string') return w;
  return fillSource(w.text, (w.values || []).map((v) => (isWords(v) ? fillWords(v) : v)));
}

/** Every text value of words changed by `fn` (secrets out, a long value cut), nested words too; templates stay. */
export function mapOwnWords(w: Words, fn: (s: string) => string): Words {
  return w.values?.length ? { text: w.text, values: w.values.map((v) => (typeof v === 'string' ? fn(v) : isWords(v) ? mapOwnWords(v, fn) : v)) } : { text: w.text };
}

/** One piece of a sentence with someone's own words in it: TeamBot's text, or `{ own }`, a value kept as written. */
export type Piece = string | { own: string };

/**
 * A source template whose values are someone's own words (a chat title, a routine's name, what a bot wrote), in
 * pieces: the template in the reader's language, every text value exactly as written. A value is never translated,
 * also not when it is a Dutch word of the dictionary or fits a pattern (a chat title "Elke werkdag om 9:00 zoek je…"
 * became "Every werkdag at 9:00 zoek je…"). A number is nobody's words: it stays a number, so it chooses the plural
 * form. `format` fills a template (the Translator's, or fillSource in Dutch); the text values reach it as markers
 * without letters, which no dictionary entry or pattern changes. A value that is TeamBot's words again is put in
 * the same way: its template translated, its own values as written.
 */
export function ownPieces(tpl: string, values: WordsValue[], format: (tpl: string, values: (string | number)[]) => string): Piece[] {
  const marked = values.map((v, i) => (typeof v === 'number' ? v : `⟦${'•'.repeat(i + 1)}⟧`));
  const out: Piece[] = [];
  for (const part of format(tpl, marked).split(/(⟦•+⟧)/)) {
    const m = /^⟦(•+)⟧$/.exec(part);
    const v = m ? values[m[1].length - 1] : undefined;
    if (isWords(v)) out.push(...ownPieces(v.text, v.values || [], format));
    else if (m) out.push({ own: String(v ?? '') });
    else if (part) out.push(part);
  }
  return out;
}

/** One language's dictionary, compiled. */
export class Translator {
  private exact = new Map<string, string>();
  private patterns: Pattern[] = [];
  /** Patterns with little fixed text ("voor {0}", "met {0}"): only for known fragments of a composed text. */
  private fragments: Pattern[] = [];
  private cache = new Map<string, string>();
  readonly rules: Intl.PluralRules;
  /** Texts that are never translated (names the user chose, such as bot names). */
  readonly keep = new Set<string>();

  constructor(
    private dict: Dict,
    readonly locale: string,
  ) {
    this.rules = new Intl.PluralRules(locale);
    for (const [k, v] of Object.entries(dict)) {
      if (typeof v !== 'string' || !v) continue;
      if (/\{\d+\}/.test(k)) {
        // "{0} voor {1}" or "om {0}" would replace one word in the middle of any Dutch sentence: skip patterns with
        // little fixed text unless they start with a capitalised word ("Versie {0}", "Fout {0}").
        const letters = k.replace(/\{\d+\}/g, '').replace(/[^A-Za-zÀ-ÿ]/g, '').length;
        const short = letters < 6 && !/^[A-ZÀ-Ý]/.test(k);
        const src = patternSource(k);
        const order = [...k.matchAll(/\{(\d+)\}/g)].map((x) => Number(x[1]));
        try {
          // Captures come in source order; the template refers to them by number.
          const tpl = order.every((n, i) => n === i) ? v : v.replace(/\{(\d+)([},])/g, (_, n, end) => `{${order.indexOf(Number(n))}${end}`);
          (short ? this.fragments : this.patterns).push({ re: new RegExp(src, 's'), tpl, first: k.replace(/\{\d+\}.*$/s, '').slice(0, 3), fixed: k.replace(/\{\d+\}/g, '').length, seps: (k.includes(' — ') ? '—' : '') + (k.includes(' · ') ? '·' : '') });
        } catch {
          /* skip broken pattern */
        }
      } else this.exact.set(k, v);
    }
    // More fixed text first: the most specific pattern wins ("{0}: {1}% van je limiet gebruikt" before
    // "{0} gebruikt", "Limieten van {0} opnieuw opvragen" before "Limieten van {0}").
    const specific = (a: Pattern, b: Pattern) => b.fixed - a.fixed || b.first.length - a.first.length;
    this.patterns.sort(specific);
    this.fragments.sort(specific);
  }

  get size() {
    return this.exact.size + this.patterns.length;
  }

  has(s: string): boolean {
    return this.exact.has(s.replace(/\s+/g, ' ').trim());
  }

  /**
   * A source template with its values: "{0} is klaar" + ["Ada"] → "Ada ist fertig". Uses the dictionary entry for
   * the template itself (so plural forms work); without one, the filled Dutch text is translated as a whole.
   */
  format(tpl: string, values: (string | number)[] = []): string {
    // An amount the server wrote in the source notation (usdText) is shown in the reader's.
    const vals = values.map((v) => localizeUsd(String(v ?? ''), this.locale) ?? String(v ?? ''));
    const own = this.dict[tpl.replace(/\s+/g, ' ').trim()];
    if (own) return fill(own, vals, this.rules);
    return this.translate(fill(tpl, vals, this.rules));
  }

  translate(s: string, depth = 0): string {
    const t = s.replace(/\s+/g, ' ').trim();
    if (!t || !/[A-Za-zÀ-ÿ]/.test(t) || depth > 3 || this.keep.has(t)) return s;
    const r = this.find(t, depth);
    if (!r) return s;
    const lead = s.match(/^\s*/)![0];
    const trail = s.match(/\s*$/)![0];
    return lead + r + trail;
  }

  /**
   * An interface label (a section heading, a menu item, a field label): its own dictionary entry also when a bot has
   * that name. Name protection (`keep`) is for the names themselves; a bot called "Lokaal" kept the heading "Lokaal"
   * on AI-providers Dutch (acceptance round 5, C-15).
   */
  label(s: string): string {
    const r = this.exact.get(s.replace(/\s+/g, ' ').trim());
    return r === undefined ? this.translate(s) : s.match(/^\s*/)![0] + r + s.match(/\s*$/)![0];
  }

  /**
   * A known fragment of a composed sentence (" voor https://x.nl", " met 3 skills", ": een bestand schrijven"): like
   * translate, and also with the short patterns ("voor {0}") that would be too eager on whole page texts. Spaces
   * around it stay.
   */
  fragment(s: string, depth = 0): string {
    const out = this.translate(s);
    if (out !== s || depth > 3) return out;
    const t = s.replace(/\s+/g, ' ').trim();
    if (!t || this.keep.has(t)) return s;
    for (const p of this.fragments) {
      if (p.first && !t.startsWith(p.first)) continue;
      const m = t.match(p.re);
      if (!m) continue;
      const vals = m.slice(1).map((part) => localizeUsd(part, this.locale) ?? (part.length < t.length ? this.fragment(part, depth + 1) : part));
      return s.match(/^\s*/)![0] + fill(p.tpl, vals, this.rules) + s.match(/\s*$/)![0];
    }
    return s;
  }

  /**
   * Translate a finished text in which these names (the user's bots, people) stay exactly as they are, also when a
   * name is a Dutch word in the dictionary (a bot called "Onderzoeker"). Without `keep` (the page's own list), for
   * the server, which translates texts of many users with one dictionary.
   */
  translateKeeping(s: string, names: Iterable<string>): string {
    const found = [...new Set(names)].filter((n) => n && n.trim().length > 1 && s.includes(n)).sort((a, b) => b.length - a.length);
    if (!found.length) return this.translate(s);
    // Each name becomes a marker without letters (never translated, carried through patterns), then comes back.
    const mark = (i: number) => `⟦${'•'.repeat(i + 1)}⟧`;
    let masked = s;
    found.forEach((n, i) => (masked = masked.split(n).join(mark(i))));
    let out = this.translate(masked);
    found.forEach((n, i) => (out = out.split(mark(i)).join(n)));
    return out;
  }

  /** The translation of a normalised text, or '' when the dictionary has nothing for it. */
  private find(t: string, depth: number): string {
    if (this.keep.has(t)) return t;
    let r = this.cache.get(t);
    if (r === undefined) {
      r = this.exact.get(t);
      if (r === undefined) {
        for (const p of this.patterns) {
          if (p.first && !t.startsWith(p.first)) continue;
          const m = t.match(p.re);
          // A placeholder never swallows the next sentence ("Weer beschikbaar rond {0}." on "… 13:19. Bots met …"), nor
          // a part of a composed text ("{0} downloaden" on "MLS (Duits) — nog downloaden") unless the pattern has it.
          if (m && !m.slice(1).some((part) => SENTENCE_END.test(part) || (part.includes(' — ') && !p.seps.includes('—')) || (part.includes(' · ') && !p.seps.includes('·')))) {
            // Captured parts are translated too (shorter strings, depth-limited), e.g. "{0} om {1}" with a weekday;
            // an amount in the reader's notation.
            const vals = m.slice(1).map((part) => localizeUsd(part, this.locale) ?? (part.length < t.length ? this.translate(part, depth + 1) : part));
            r = fill(p.tpl, vals, this.rules);
            break;
          }
        }
      }
      // Several sentences in one text ("Weer beschikbaar rond 13:19. Bots met een reserve-engine schakelen vanzelf
      // over."): every sentence translated, or on.
      if (r === undefined && depth < 2) {
        const sentences = t.split(/(?<=[.!?])\s+(?=[\p{Lu}"“(])/u);
        if (sentences.length > 1) {
          // A sentence that is a label with a full stop ("Week · alle modellen.") is the label's translation + ".".
          const one = (x: string) => this.find(x, depth + 1) || (/[^.]\.$/.test(x) && (this.find(x.slice(0, -1), depth + 1) || '').replace(/(.)$/, '$1.')) || '';
          const tr = sentences.map(one);
          if (tr.every(Boolean)) r = tr.join(' ');
        }
      }
      // A known text with a detail in brackets after it ("Niet bereikbaar (bad port)"): the text translated, the
      // detail as well when known.
      if (r === undefined && depth < 3) {
        const m = /^(.*\S)\s+\(([^()]+)\)$/.exec(t);
        if (m && /[A-Za-zÀ-ÿ]/.test(m[1])) {
          const head = this.find(m[1], depth + 1);
          if (head) r = `${head} (${this.find(m[2], depth + 1) || m[2]})`;
        }
      }
      // Composed texts ("Docker (container): Docker is niet gevonden.", "A · B"): translate the parts separately.
      if (r === undefined && depth < 2 && /: | · | — /.test(t)) {
        const segs = t.split(/(: | · | — )/);
        const tr = segs.map((x, i) => (i % 2 ? x : (localizeUsd(x, this.locale) ?? this.translate(x, depth + 1))));
        if (tr.some((x, i) => x !== segs[i])) r = tr.join('');
      }
      // A list of known labels ("Netwerk en proxy, Spraak, Kanalen"): every item translated, or the list stays as is.
      if (r === undefined && depth < 2 && t.includes(', ')) {
        // An item that starts with an acronym ("CLI-agents", "SSO & SCIM") may stay as it is.
        const items = t.split(', ').map((x) => (/[A-Za-zÀ-ÿ]/.test(x) ? this.find(x, depth + 1) || (/^\p{Lu}{2,}/u.test(x) ? x : '') : x));
        if (items.every(Boolean)) r = items.join(this.locale.startsWith('ar') ? '، ' : ', ');
      }
      // A place in the screens ("Instellingen › Meer mogelijkheden › Spraak", shared/places.ts): every step is a title
      // of its own, so every step translated, or the place stays as is.
      if (r === undefined && depth < 3 && t.includes(' › ')) {
        const steps = t.split(' › ').map((x) => this.find(x, depth + 1));
        if (steps.every(Boolean)) r = steps.join(' › ');
      }
      // A fragment with a separator in front or behind (" · handmatig", ". Bots met …"): the text without it.
      if (r === undefined && depth < 3) {
        const m = EDGES.exec(t);
        if (m && (m[1] || m[3]) && /[A-Za-zÀ-ÿ]/.test(m[2])) {
          const inner = this.find(m[2], depth + 1);
          if (inner) r = m[1] + inner + m[3];
        }
      }
      // Nothing but an amount ("US$ 5,00", "≈ US$ 0,24"): in the reader's notation.
      if (r === undefined) r = localizeUsd(t, this.locale) ?? '';
      if (this.cache.size > 5000) this.cache.clear();
      this.cache.set(t, r);
    }
    return r;
  }

  /** Forget cached results (after `keep` changed). */
  reset() {
    this.cache.clear();
  }
}
