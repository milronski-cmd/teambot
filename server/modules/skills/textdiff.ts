/**
 * Line diff (Myers, O((N+M)·D)) for the update view of catalogue skills: what changes in each file before the owner
 * approves an update. Output is a list of hunks with a few lines of context, capped so a huge rewrite stays readable.
 */

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

const MAX_D = 4000;

/** Edit script between two line arrays. */
function editScript(a: string[], b: string[]): DiffLine[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= Math.min(max, MAX_D); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  if (!found) return null;
  // Walk back through the trace.
  const out: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]) ? k + 1 : k - 1;
    const prevX = vv[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ op: ' ', text: a[x - 1], oldNo: x, newNo: y });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) out.push({ op: '+', text: b[y - 1], newNo: y });
      else out.push({ op: '-', text: a[x - 1], oldNo: x });
    }
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}

const splitLines = (s: string) => {
  const t = s.replace(/\r\n/g, '\n');
  const lines = t.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

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
