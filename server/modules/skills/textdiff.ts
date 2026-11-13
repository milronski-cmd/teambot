/**
 * Line diff (Myers, O((N+M)·D)) for the update view of catalogue skills: what changes in each file before the owner
 * approves an update. Output is a list of hunks with a few lines of context, capped so a huge rewrite stays readable.
 */
import { diffLines, splitLines } from '../browser/diff.js';

export interface DiffLine {
  /** ' ' unchanged, '-' removed, '+' added. */
  op: ' ' | '-' | '+';
  text: string;
  /** Line number in the old file (removed/unchanged) or the new file (added). */
  oldNo?: number;
  newNo?: number;
}

export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface TextDiff {
  added: number;
  removed: number;
  hunks: Hunk[];
  /** Hunks or lines were left out (see `added`/`removed` for the full count). */
  truncated: boolean;
  /** Too different to diff line by line within the limits; only the counts are known. */
  tooLarge?: boolean;
}

/** Edit script between two line arrays (the Myers diff of browser/diff.ts), with line numbers; null when too different. */
function editScript(a: string[], b: string[]): DiffLine[] | null {
  const ops = diffLines(a, b);
  if (!ops) return null;
  let oldNo = 0;
  let newNo = 0;
  return ops.map((o): DiffLine => (o.t === ' ' ? { op: ' ', text: o.s, oldNo: ++oldNo, newNo: ++newNo } : o.t === '-' ? { op: '-', text: o.s, oldNo: ++oldNo } : { op: '+', text: o.s, newNo: ++newNo }));
}

export function diffText(oldText: string, newText: string, o: { context?: number; maxLines?: number } = {}): TextDiff {
  const context = o.context ?? 3;
  const maxLines = o.maxLines ?? 400;
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const script = editScript(a, b);
  if (!script) return { added: b.length, removed: a.length, hunks: [], truncated: true, tooLarge: true };
  const added = script.filter((l) => l.op === '+').length;
  const removed = script.filter((l) => l.op === '-').length;
  // Changes closer together than twice the context share one hunk.
  const changed = script.flatMap((l, idx) => (l.op === ' ' ? [] : [idx]));
  const groups: [number, number][] = [];
  for (const idx of changed) {
    const g = groups[groups.length - 1];
    if (g && idx - g[1] <= context * 2) g[1] = idx;
    else groups.push([idx, idx]);
  }
  const hunks: Hunk[] = [];
  let shown = 0;
  let truncated = false;
  for (const [first, last] of groups) {
    const lines = script.slice(Math.max(0, first - context), Math.min(script.length, last + context + 1));
    if (shown + lines.length > maxLines) {
      truncated = true;
      const room = maxLines - shown;
      if (room > 0) hunks.push(hunkOf(lines.slice(0, room)));
      break;
    }
    shown += lines.length;
    hunks.push(hunkOf(lines));
  }
  return { added, removed, hunks, truncated };
}

function hunkOf(lines: DiffLine[]): Hunk {
  const firstOld = lines.find((l) => l.oldNo !== undefined)?.oldNo ?? 0;
  const firstNew = lines.find((l) => l.newNo !== undefined)?.newNo ?? 0;
  return { oldStart: firstOld, newStart: firstNew, lines };
}
