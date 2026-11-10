/**
 * Numbers written out in words, for local voices that cannot read digits (character-based voices: their alphabet
 * has no digits, so "om 10 uur" would come out as "om uur"). Portuguese (Brazilian forms, like the interface) and
 * Polish. Cardinal numbers in the basic form, decimals, clock times, percentages and a few currencies; long digit
 * strings (phone numbers, codes) are read digit by digit. Grammatical case (Polish "o dziesiątej") is not inflected:
 * the aim is that nothing is skipped and everything is understandable.
 */

interface Lang {
  words(n: number): string;
  decimal: string;
  percent: string;
  /** Clock time "10:30"; `before`: the word in front of it (lower case), for languages where it changes the form. */
  time(h: number, m: number, before?: string): string;
  /** Currency word for an amount: [symbol regex source, (n) => word]. */
  currencies: [string, (n: number) => string][];
}

// ---------- Portuguese (Brazil) ----------

const PT_UNITS = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const PT_TENS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const PT_HUNDREDS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

function ptBelow1000(n: number): string {
  if (n === 100) return 'cem';
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(PT_HUNDREDS[h]);
  if (r) parts.push(r < 20 ? PT_UNITS[r] : PT_TENS[Math.floor(r / 10)] + (r % 10 ? ' e ' + PT_UNITS[r % 10] : ''));
  return parts.join(' e ');
}

function ptWords(n: number): string {
  if (n === 0) return 'zero';
  if (n < 1000) return ptBelow1000(n);
  const groups: { v: number; one: string; many: string }[] = [
    { v: Math.floor(n / 1e9) % 1000, one: 'bilhão', many: 'bilhões' },
    { v: Math.floor(n / 1e6) % 1000, one: 'milhão', many: 'milhões' },
    { v: Math.floor(n / 1e3) % 1000, one: 'mil', many: 'mil' },
  ];
  const parts: string[] = [];
  for (const g of groups) {
    if (!g.v) continue;
    if (g.one === 'mil') parts.push(g.v === 1 ? 'mil' : `${ptBelow1000(g.v)} mil`);
    else parts.push(`${ptBelow1000(g.v)} ${g.v === 1 ? g.one : g.many}`);
  }
  const rest = n % 1000;
  if (!rest) return parts.join(' ');
  // "mil e vinte", "mil e quinhentos", but "mil duzentos e trinta".
  return parts.join(' ') + (rest < 100 || rest % 100 === 0 ? ' e ' : ' ') + ptBelow1000(rest);
}

/** Hours are feminine in Portuguese: "uma hora", "duas e meia", "vinte e uma horas". */
const ptHour = (h: number) => ptWords(h).replace(/\bum$/, 'uma').replace(/\bdois$/, 'duas');

const PT: Lang = {
  words: ptWords,
  decimal: 'vírgula',
  percent: 'por cento',
  time: (h, m) => (m ? `${ptHour(h)} e ${ptWords(m)}` : `${ptHour(h)} ${h === 1 ? 'hora' : 'horas'}`),
  currencies: [
    ['R\\$', (n) => (n === 1 ? 'real' : 'reais')],
    ['€', (n) => (n === 1 ? 'euro' : 'euros')],
    ['US\\$|\\$', (n) => (n === 1 ? 'dólar' : 'dólares')],
  ],
};

// ---------- Polish ----------

const PL_UNITS = ['zero', 'jeden', 'dwa', 'trzy', 'cztery', 'pięć', 'sześć', 'siedem', 'osiem', 'dziewięć', 'dziesięć', 'jedenaście', 'dwanaście', 'trzynaście', 'czternaście', 'piętnaście', 'szesnaście', 'siedemnaście', 'osiemnaście', 'dziewiętnaście'];
const PL_TENS = ['', '', 'dwadzieścia', 'trzydzieści', 'czterdzieści', 'pięćdziesiąt', 'sześćdziesiąt', 'siedemdziesiąt', 'osiemdziesiąt', 'dziewięćdziesiąt'];
const PL_HUNDREDS = ['', 'sto', 'dwieście', 'trzysta', 'czterysta', 'pięćset', 'sześćset', 'siedemset', 'osiemset', 'dziewięćset'];
/** Hours as Polish say them ("pierwsza", "dziesiąta"), 0-24. */
const PL_HOURS = ['zero', 'pierwsza', 'druga', 'trzecia', 'czwarta', 'piąta', 'szósta', 'siódma', 'ósma', 'dziewiąta', 'dziesiąta', 'jedenasta', 'dwunasta', 'trzynasta', 'czternasta', 'piętnasta', 'szesnasta', 'siedemnasta', 'osiemnasta', 'dziewiętnasta', 'dwudziesta', 'dwudziesta pierwsza', 'dwudziesta druga', 'dwudziesta trzecia', 'dwudziesta czwarta'];

/** Polish plural form: 0 = one (1), 1 = few (2-4, not 12-14), 2 = many. */
export const plForm = (n: number) => (n === 1 ? 0 : n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14) ? 1 : 2);

function plBelow1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(PL_HUNDREDS[h]);
  if (r) parts.push(r < 20 ? PL_UNITS[r] : PL_TENS[Math.floor(r / 10)] + (r % 10 ? ' ' + PL_UNITS[r % 10] : ''));
  return parts.join(' ');
}

function plWords(n: number): string {
  if (n < 1000) return n === 0 ? 'zero' : plBelow1000(n);
  const groups: { v: number; forms: [string, string, string] }[] = [
    { v: Math.floor(n / 1e9) % 1000, forms: ['miliard', 'miliardy', 'miliardów'] },
    { v: Math.floor(n / 1e6) % 1000, forms: ['milion', 'miliony', 'milionów'] },
    { v: Math.floor(n / 1e3) % 1000, forms: ['tysiąc', 'tysiące', 'tysięcy'] },
  ];
  const parts: string[] = [];
  for (const g of groups) if (g.v) parts.push(g.v === 1 ? g.forms[0] : `${plBelow1000(g.v)} ${g.forms[plForm(g.v)]}`);
  if (n % 1000) parts.push(plBelow1000(n % 1000));
  return parts.join(' ');
}

/** "o dziesiątej", "od dziewiątej do siedemnastej": after these words the hour ends in -ej. */
const PL_EJ = new Set(['o', 'od', 'do', 'po']);
const plEj = (hour: string) =>
  hour
    .split(' ')
    .map((w) => w.replace(/ga$/, 'giej').replace(/ia$/, 'iej').replace(/a$/, 'ej'))
    .join(' ');

const PL: Lang = {
  words: plWords,
  decimal: 'przecinek',
  percent: 'procent',
  time: (h, m, before) => {
    const hour = PL_HOURS[h] ?? plWords(h);
    return `${before && PL_EJ.has(before) ? plEj(hour) : hour}${m ? ' ' + plWords(m) : ''}`;
  },
  currencies: [
    ['zł', (n) => ['złoty', 'złote', 'złotych'][plForm(n)]],
    ['€', () => 'euro'],
    ['US\\$|\\$', (n) => ['dolar', 'dolary', 'dolarów'][plForm(n)]],
  ],
};

const LANGS: Record<string, Lang> = { pt: PT, pl: PL };

/** Languages numbers can be written out for. */
export const NUMBER_WORD_LANGS = Object.keys(LANGS);

const MAX = 999_999_999_999;

/** "1.250" (pt) / "1 250" (pl) → 1250; null when it is not a plain number we can say. */
function parseInt10(s: string): number | null {
  const d = s.replace(/[.   ]/g, '');
  if (!/^\d+$/.test(d)) return null;
  // A leading zero (codes, phone numbers) or a very long number: digit by digit.
  if ((d.length > 1 && d.startsWith('0')) || d.length > 12) return null;
  const n = Number(d);
  return n <= MAX ? n : null;
}

const digitByDigit = (L: Lang, s: string) =>
  s
    .replace(/\D/g, '')
    .split('')
    .map((c) => L.words(Number(c)))
    .join(' ');

/** Write the numbers in `text` out in words for language `lang` (other languages: unchanged). */
export function spellNumbers(text: string, lang: string): string {
  const L = LANGS[String(lang || '').toLowerCase().split(/[-_]/)[0]];
  if (!L || !/\d/.test(text)) return text;
  let out = text;
  // Dates: 7.11.2026, 07/11/2026, 2026-11-07 — each part as a number (not "seven comma eleven").
  out = out.replace(/(?<![\d.,/-])(\d{1,4})([./-])(\d{1,2})\2(\d{1,4})(?![\d.,/-]\d)/g, (_, a, _s, b, c) => [a, b, c].map((x) => L.words(Number(x))).join(' '));
  // Clock times: 10:30, 9:05 (not 1:2:3 or 10:300), with the word in front (Polish "o 10:30" → "o dziesiątej …").
  out = out.replace(/(?:(?<!\p{L})(\p{L}+)(\s+))?(?<![\d:])([01]?\d|2[0-4]):([0-5]\d)(?![\d:])/gu, (_, w, sp, h, m) => (w ? w + sp : '') + L.time(Number(h), Number(m), w?.toLowerCase()));
  // Amounts with a currency sign before or after: R$ 10, 10 €, $5, 25 zł.
  for (const [sym, word] of L.currencies) {
    const num = '(\\d{1,3}(?:[.\\u00a0\\u202f ]\\d{3})+|\\d+)(?:,(\\d{1,2}))?';
    out = out.replace(new RegExp(`(?:${sym})\\s?${num}`, 'gu'), (m, a, c) => money(L, a, c, word) ?? m);
    out = out.replace(new RegExp(`${num}\\s?(?:${sym})(?![\\p{L}])`, 'gu'), (m, a, c) => money(L, a, c, word) ?? m);
  }
  // Percentages: 15%, 2,5 %.
  out = out.replace(/(\d+(?:,\d+)?)\s?%/g, (_, n) => `${n} ${L.percent}`);
  // Numbers with thousands separators and/or decimals ("1.250,5", "3,75", English "3.5"), then plain digits.
  out = out.replace(/\d{1,3}(?:[.   ]\d{3})+(?:,\d+)?(?!\d)|\d+,\d+|\d+\.\d{1,2}(?!\d)|\d+/g, (m) => numberWords(L, m));
  return out.replace(/[ \t]{2,}/g, ' ');
}

function numberWords(L: Lang, m: string): string {
  // English-style decimal point ("3.5"): a dot followed by one or two digits.
  const en = /^(\d+)\.(\d{1,2})$/.exec(m);
  const [int, frac] = en ? [en[1], en[2]] : m.split(',');
  const n = parseInt10(int);
  const whole = n === null ? digitByDigit(L, int) : L.words(n);
  if (frac === undefined) return whole;
  // Decimals: "3,05" → three comma zero five; "3,5" → three comma five.
  const f = frac.length <= 2 && !frac.startsWith('0') ? L.words(Number(frac)) : digitByDigit(L, frac);
  return `${whole} ${L.decimal} ${f}`;
}

function money(L: Lang, amount: string, cents: string | undefined, word: (n: number) => string): string | null {
  const n = parseInt10(amount);
  if (n === null) return null;
  const base = `${L.words(n)} ${word(n)}`;
  return cents && Number(cents) ? `${base} ${L.words(Number(cents.padEnd(2, '0')))}` : base;
}
