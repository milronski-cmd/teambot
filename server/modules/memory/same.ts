/**
 * The one rule for "is this the same?" and "does this take the place of that?": one function, one threshold. Every
 * write into memory goes through it: a line for a dossier's text against the lines that are there, a fact with its own
 * source against the facts of its dossier, and what goes to the archive when a text is rewritten.
 *
 * - same: the old line already says it (the same words; every word of the new line is in the old one).
 * - replaces: both lines are about the same thing and the new one says something else or more: the same subject with
 *   one value at a time ("woonplaats"), or nearly the same words with another value. The newer line takes the place of
 *   the older one; the older one goes to the archive of its dossier, never away.
 * - other: two different things; both stay.
 */
import { canonicalKey, containment, guessKey, normalize, tokens } from './text.js';

/** Two lines are about the same thing when this share of the shorter one's words is in the longer one. */
export const SAME = 0.8;

export type Verdict = 'same' | 'replaces' | 'other';

/** A line without its list mark or heading marks, normalised. */
export const lineKey = (l: string) => normalize(String(l ?? '').replace(/^[\s>*#-]+/, ''));

const NEGATION = /(?:^| )(?:niet|geen|nooit|niets|niks|zonder|not|no|never|none|without)(?: |$)/;

/** A subject that has one value at a time (a name, where someone lives): a new value takes the place of the old one. */
export function subjectOf(line: string, key?: string | null): string | null {
  return canonicalKey(key || guessKey(String(line ?? '').replace(/^[\s>*#-]+/, '')).key);
}

/** Words written with a capital inside the sentence (names), as search words. */
function names(line: string): Set<string> {
  const out = new Set<string>();
  const text = String(line ?? '').replace(/^[\s>*#-]+/, '');
  for (const m of text.matchAll(/(?<=[\p{L}\p{N},;:)] )\p{Lu}[\p{L}\p{N}'’-]+/gu)) for (const t of tokens(m[0])) out.add(t);
  return out;
}

/** What a new line does to an old one. `keys`: the subject of either line when the writer knows it. */
export function compare(neu: string, old: string, keys: { neu?: string | null; old?: string | null } = {}): Verdict {
  const a = lineKey(neu);
  const b = lineKey(old);
  if (!a || !b) return 'other';
  if (a === b) return 'same';
  // (An amount is one word: "7,25" against "6,95" is one difference, not two.)
  const words = (s: string) => tokens(s.replace(/(\d)[.,](?=\d)/g, '$1'));
  const ta = words(neu);
  const tb = words(old);
  const yesNo = NEGATION.test(a) === NEGATION.test(b);
  if (ta.length >= 2 && containment(ta, tb) === 1 && yesNo) return 'same';
  const subject = subjectOf(neu, keys.neu);
  if (subject && subject === subjectOf(old, keys.old)) return 'replaces';
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  // About the same thing: nearly all words of the shorter line are in the longer one (a short line: all of them).
  const share = containment(small, big);
  if (small.length < 2 || share < SAME || (small.length < 3 && share < 1)) return 'other';
  // Two different names in otherwise the same sentence ("de factuur van Jansen …" / "… van Pietersen …"): two things.
  const na = [...names(neu)].filter((n) => !tb.includes(n));
  const nb = [...names(old)].filter((n) => !ta.includes(n));
  if (na.length && nb.length) return 'other';
  return 'replaces';
}

/** The line of `lines` a new line says the same as, else the one it takes the place of (the closest), else nothing. */
export function findIn(neu: string, lines: string[], key?: string | null): { verdict: Verdict; index: number } {
  let replace = -1;
  let best = 0;
  const tn = tokens(neu);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!lineKey(l) || /^#{1,6}\s/.test(l.trim())) continue;
    const v = compare(neu, l, { neu: key });
    if (v === 'same') return { verdict: 'same', index: i };
    if (v === 'replaces') {
      const overlap = containment(tn, tokens(l)) + 0.001;
      if (overlap > best) (best = overlap), (replace = i);
    }
  }
  return replace >= 0 ? { verdict: 'replaces', index: replace } : { verdict: 'other', index: -1 };
}
