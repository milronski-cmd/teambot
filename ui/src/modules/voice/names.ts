/**
 * Who is addressed at the start of a spoken sentence in a group call ("Onderzoeker, hoe laat is het in Berlijn?").
 * Speech-to-text often gets a name slightly wrong ("Onderzoeken", "Assistant", "Brom"), so besides an exact match there
 * is a close match: same sound (a simple Dutch phonetic key) or a small spelling difference. A clear close match is
 * used directly; an unsure one (or two bots that sound alike) is asked first: "Bedoel je Onderzoeker?".
 * Pure, unit-tested in tests/voice-names.test.ts.
 */

export type NameMatch =
  | { kind: 'everyone'; rest: string }
  | { kind: 'exact' | 'close'; name: string; heard: string; rest: string }
  | { kind: 'unsure'; candidates: string[]; heard: string; rest: string }
  | { kind: 'none'; rest: string };

const GREETING = /^(?:(?:hé|he|hey|hee|hoi|hallo|hai|oké|oke|ok|zeg|dag)[\s,!.]+)+/i;
const EVERYONE = /^(?:iedereen|allemaal|jullie allemaal|allen)\b[\s,:!.?]*/i;

/** Lowercase, without accents or punctuation; words separated by one space. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A rough Dutch sound key: letters that sound alike become one, double letters one, common endings dropped. */
export function phoneticKey(s: string): string {
  let x = normalizeName(s).replace(/ /g, '');
  x = x
    .replace(/sch/g, 's')
    .replace(/ch/g, 'g')
    .replace(/ph/g, 'f')
    .replace(/th/g, 't')
    .replace(/ij|ei|ey|y/g, 'ei')
    .replace(/ou|au/g, 'au')
    .replace(/oe/g, 'u')
    .replace(/ck|q|c(?=[aouklr])/g, 'k')
    .replace(/c/g, 's')
    .replace(/v/g, 'f')
    .replace(/z/g, 's')
    .replace(/w/g, 'v')
    .replace(/dt|d(?=$)/g, 't')
    .replace(/(.)\1+/g, '$1');
  return x;
}

/** "Onderzoeker", "Onderzoeken", "Onderzoekster": the same long stem with a different ending (null = no such stem). */
function endingStem(key: string): string | null {
  const st = key.replace(/(ster|ers|er|en|e)$/, '');
  return st !== key && st.length >= 5 ? st : null;
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** How sure we are that `heard` is `name`: 3 = exact, 2 = clearly the same, 1 = maybe, 0 = no. */
export function nameScore(heard: string, name: string): 0 | 1 | 2 | 3 {
  const a = normalizeName(heard);
  const b = normalizeName(name);
  if (!a || !b) return 0;
  if (a === b) return 3;
  const len = b.replace(/ /g, '').length;
  if (len < 4) return 0; // short names ("Bo", "Ali"): only exact, too many lookalike words
  const d = editDistance(a, b);
  const pa = phoneticKey(a);
  const pb = phoneticKey(b);
  if (pa === pb) return 2;
  const sa = endingStem(pa);
  if (sa && sa === endingStem(pb)) return 2;
  if (len >= 6 && d <= 1) return 2;
  if (len >= 6 && d <= 2 && d / Math.max(a.length, b.length) <= 0.25) return 1;
  if (d <= 1) return 1;
  if (pb.length >= 4 && editDistance(pa, pb) <= 1) return 1;
  return 0;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Who the sentence is for, and the rest of the sentence after the name. */
export function matchSpokenName(text: string, names: string[]): NameMatch {
  const t = text.trim().replace(GREETING, '');
  if (EVERYONE.test(t)) return { kind: 'everyone', rest: t.replace(EVERYONE, '') };
  // Exact, longest name first ("Juf Ans" before "Juf").
  for (const n of [...names].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`^${escapeRe(n)}(?=$|[\\s,:!.?])[\\s,:!.?]*`, 'i');
    if (re.test(t)) return { kind: 'exact', name: n, heard: n, rest: t.replace(re, '') };
  }
  // Close: compare the first words (as many as the name has, one more or one less) with each name.
  const words = t.split(/\s+/).filter(Boolean);
  const scored: { name: string; score: number; used: number }[] = [];
  for (const n of names) {
    const nw = Math.max(1, n.trim().split(/\s+/).length);
    let best = { score: 0, used: 0 };
    for (const k of new Set([nw, nw + 1, nw - 1].filter((x) => x >= 1 && x <= words.length))) {
      const heard = words.slice(0, k).join(' ').replace(/[,:!.?]+$/, '');
      const sc = nameScore(heard, n);
      if (sc > best.score) best = { score: sc, used: k };
    }
    if (best.score > 0) scored.push({ name: n, ...best });
  }
  if (!scored.length) return { kind: 'none', rest: t };
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  const heard = words.slice(0, top.used).join(' ').replace(/[,:!.?]+$/, '');
  const rest = words.slice(top.used).join(' ').replace(/^[,:!.?]+\s*/, '');
  const sameTop = scored.filter((s) => s.score === top.score);
  if (top.score >= 2 && sameTop.length === 1) return { kind: 'close', name: top.name, heard, rest };
  return { kind: 'unsure', candidates: scored.filter((s) => s.score >= Math.min(top.score, 1)).map((s) => s.name).slice(0, 3), heard, rest };
}

/** The message for the group chat: "@Name rest" (quotes around a name with a space), "@iedereen rest", or as said. */
export function addressed(name: string | 'iedereen' | null, rest: string, original: string): string {
  if (!name) return original.trim();
  const tag = name === 'iedereen' ? '@iedereen' : `@${name.includes(' ') ? `"${name}"` : name}`;
  return `${tag} ${rest}`.trim();
}

/** An answer to "Bedoel je …?": yes, no, or one of the names. */
export function confirmAnswer(text: string, candidates: string[]): { kind: 'yes' } | { kind: 'no' } | { kind: 'name'; name: string } | null {
  const t = normalizeName(text.replace(GREETING, ''));
  if (/^(ja|jawel|jazeker|klopt|precies|correct|yes|graag|ja graag|ja klopt)\b/.test(t)) return { kind: 'yes' };
  if (/^(nee|neen|nope|no|niet|nee dank)\b/.test(t)) return { kind: 'no' };
  for (const n of candidates) if (nameScore(t.split(' ').slice(0, n.split(/\s+/).length).join(' '), n) >= 2) return { kind: 'name', name: n };
  return null;
}
