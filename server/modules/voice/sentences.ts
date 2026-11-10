import { speakable } from './audio.js';
import { tr } from '../../core/i18n.js';

/**
 * Streaming markdown → speakable sentences, for reading a bot's answer aloud while it is still being written.
 * Text arrives in small deltas; a sentence is released as soon as it is complete (end punctuation followed by
 * whitespace, or the end of a line), so the voice can start after the first sentence. Code blocks are skipped (one
 * short note instead), list numbers and common abbreviations do not end a sentence, and a run-on sentence is cut at
 * a comma once it gets long.
 */

const ABBREV = new Set(
  [
    'bijv', 'bv', 'bijvoorbeeld', 'o.a', 'd.w.z', 'm.a.w', 'nl', 'ca', 'dhr', 'mevr', 'mr', 'mrs', 'ms', 'dr', 'prof', 'ir', 'ing', 'drs', 'nr', 'blz', 'e.d',
    'i.p.v', 'z.s.m', 'o.b.v', 't.o.v', 'a.s', 'vs', 'e.g', 'i.e', 'st', 'jr', 'sr', 'evt', 'incl', 'excl', 'max', 'min', 'resp', 'ong', 'mln', 'mld', 'm.b.t', 'n.a.v',
    'v.d', 'i.v.m', 'o.m', 'p', 'pag', 'tel', 'vgl', 'zgn', 'jl', 'aug', 'sept', 'okt', 'nov', 'dec', 'jan', 'feb', 'apr', 'jun', 'jul',
  ].map((s) => s.toLowerCase()),
);

const CODE_NOTE = '(codevoorbeeld overgeslagen)';
const SOFT_MAX = 220;
const FIRST_SOFT_MAX = 110;
const HARD_MAX = 320;

/** Does the period at `i` (in `s`) end a sentence? */
function endsSentence(s: string, i: number): boolean {
  if (s[i] !== '.') return true; // ! ? … always end
  const lineStart = s.lastIndexOf('\n', i - 1) + 1;
  const before = s.slice(lineStart, i);
  if (/^\s*\d{1,3}$/.test(before)) return false; // "1. Eerste punt"
  const word = /([\p{L}.]+)$/u.exec(before)?.[1]?.toLowerCase() || '';
  if (!word) return true;
  if (ABBREV.has(word) || ABBREV.has(word.replace(/\.$/, ''))) return false;
  if (/^\p{Lu}$/u.test(before.slice(-1)) && word.length === 1) return false; // initial: "J. de Vries"
  if (/^(\p{L}\.)+\p{L}$/u.test(word)) return false; // "o.a", "d.w.z" not in the list
  return true;
}

/** Clean one piece for the voice; '' when nothing speakable is left. */
export function speakPiece(raw: string, lang = 'nl'): string {
  let t = speakable(raw, lang);
  // Markers whose partner fell into another piece.
  t = t.replace(/\*\*|__|~~|`+/g, '').replace(/(^|\s)[*_](?=\S)|(?<=\S)[*_](?=\s|$)/g, '$1');
  t = t.replace(/^\s*[#>]+\s*/g, '').replace(/\s+/g, ' ').replace(/\s+,/g, ',').replace(/,{2,}/g, ',').trim();
  t = t.replace(/^[.,;:]+\s*/, '');
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}

export class SpeechSplitter {
  private buf = '';
  private inFence = false;
  private noted = false;
  /** Characters of speakable text released so far. */
  released = 0;

  /** `lang`: the user's language, for the note that replaces a code block. */
  constructor(private lang = 'nl') {}

  /** Feed a delta; returns the sentences that are complete now. */
  push(delta: string): string[] {
    this.buf += delta;
    return this.drain(false);
  }

  /** The text is complete: release the rest. */
  end(): string[] {
    const out = this.drain(true);
    this.buf = '';
    return out;
  }

  private emit(out: string[], raw: string) {
    const s = speakPiece(raw, this.lang);
    if (!s) return;
    out.push(s);
    this.released += s.length;
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      if (this.inFence) {
        const close = this.buf.indexOf('```');
        if (close < 0) {
          // Still inside the code block: keep only what could be the start of the closing fence.
          this.buf = this.buf.slice(-2);
          if (final) this.buf = '';
          return out;
        }
        this.inFence = false;
        const nl = this.buf.indexOf('\n', close + 3);
        this.buf = nl >= 0 ? this.buf.slice(nl + 1) : this.buf.slice(close + 3);
        continue;
      }
      const fence = this.buf.indexOf('```');
      const text = fence >= 0 ? this.buf.slice(0, fence) : this.buf;
      const cut = this.cutPoint(text, final || fence >= 0);
      if (cut > 0) {
        this.emit(out, text.slice(0, cut));
        this.buf = this.buf.slice(cut);
        continue;
      }
      if (fence >= 0) {
        // Everything before the fence is out; skip the code block itself.
        this.buf = this.buf.slice(fence + 3);
        this.inFence = true;
        if (!this.noted) {
          this.noted = true;
          out.push(tr(this.lang, CODE_NOTE));
        }
        continue;
      }
      return out;
    }
  }

  /** Length of the first complete piece in `s` (0 = none yet). `complete` = no more text will follow `s`. */
  private cutPoint(s: string, complete: boolean): number {
    if (!s.trim()) return complete ? s.length : 0;
    // A lone backtick pair at the very end could become a fence: wait.
    if (!complete && /`{1,2}$/.test(s)) s = s.replace(/`{1,2}$/, '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\n') {
        if (s.slice(0, i).trim()) return i + 1;
        continue;
      }
      if (c === '.' || c === '!' || c === '?' || c === '…') {
        let j = i + 1;
        while (j < s.length && /[.!?…"'”’)\]*_]/.test(s[j])) j++;
        if (j >= s.length) {
          if (complete) return s.length;
          return 0; // need the next character to know
        }
        if (/\s/.test(s[j]) && endsSentence(s, i)) return j;
        i = j - 1;
      }
    }
    if (complete) return s.length;
    // Long run-on sentence: cut after a comma/semicolon/dash, else at a space. The very first piece is cut sooner,
    // so the voice can start while the bot is still writing a long opening sentence.
    const first = this.released === 0;
    const soft = first ? FIRST_SOFT_MAX : SOFT_MAX;
    const minAt = first ? 40 : 60;
    if (s.length > soft) {
      const window = s.slice(0, HARD_MAX);
      const m = [...window.matchAll(/[,;:–—]\s/g)].filter((x) => x.index! > minAt).pop();
      if (m) return m.index! + m[0].length;
      if (s.length > HARD_MAX) {
        const sp = window.lastIndexOf(' ');
        return sp > minAt ? sp + 1 : HARD_MAX;
      }
    }
    return 0;
  }
}

/** Whole text at once (tests, non-streaming callers): the same pieces the streaming path would produce. */
export function splitForSpeech(md: string, deltaSize = 0): string[] {
  const s = new SpeechSplitter();
  const out: string[] = [];
  if (deltaSize > 0) for (let i = 0; i < md.length; i += deltaSize) out.push(...s.push(md.slice(i, i + deltaSize)));
  else out.push(...s.push(md));
  out.push(...s.end());
  return out;
}
