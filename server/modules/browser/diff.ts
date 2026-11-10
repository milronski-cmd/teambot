/** Line-based diff (Myers O(ND)) producing unified hunks. Own implementation, no dependency. */

export type Op = { t: ' ' | '-' | '+'; s: string };

export function diffLines(a: string[], b: string[], maxD = 4000): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  outer: for (let d = 0; d <= max; d++) {
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
        break outer;
      }
    }
  }
  if (!found) return null; // too different: caller shows a summary instead
  // backtrack
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : vv[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: ' ', s: a[x - 1] });
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) ops.push({ t: '+', s: b[y - 1] });
    else ops.push({ t: '-', s: a[x - 1] });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ t: ' ', s: a[x - 1] });
    x--;
    y--;
  }
  return ops.reverse();
}

export interface DiffResult {
  added: number;
  removed: number;
  unified: string;
  tooLarge?: boolean;
}

export function splitLines(s: string): string[] {
  if (!s) return [];
  const l = s.split(/\r?\n/);
  if (l[l.length - 1] === '') l.pop();
  return l;
}

/** Unified diff with `context` lines around changes, bounded in size. */
export function unifiedDiff(oldText: string, newText: string, o: { context?: number; maxChars?: number; oldName?: string; newName?: string } = {}): DiffResult {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ctxN = o.context ?? 3;
  if (a.length + b.length > 40_000) return { added: b.length, removed: a.length, unified: '', tooLarge: true };
  const ops = diffLines(a, b);
  if (!ops) return { added: b.length, removed: a.length, unified: '', tooLarge: true };
  let added = 0;
  let removed = 0;
  for (const op of ops) if (op.t === '+') added++;
  else if (op.t === '-') removed++;
  const out: string[] = [`--- ${o.oldName || 'origineel'}`, `+++ ${o.newName || 'nieuw'}`];
  let i = 0;
  let ai = 0;
  let bi = 0;
  const pos: { a: number; b: number }[] = [];
  for (const op of ops) {
    pos.push({ a: ai, b: bi });
    if (op.t !== '+') ai++;
    if (op.t !== '-') bi++;
  }
  while (i < ops.length) {
    if (ops[i].t === ' ') {
      i++;
      continue;
    }
    const start = Math.max(0, i - ctxN);
    let end = i;
    let lastChange = i;
    while (end < ops.length && (ops[end].t !== ' ' || end - lastChange <= ctxN * 2)) {
      if (ops[end].t !== ' ') lastChange = end;
      end++;
    }
    end = Math.min(ops.length, lastChange + ctxN + 1);
    const hunk = ops.slice(start, end);
    const aCount = hunk.filter((h) => h.t !== '+').length;
    const bCount = hunk.filter((h) => h.t !== '-').length;
    out.push(`@@ -${pos[start].a + 1},${aCount} +${pos[start].b + 1},${bCount} @@`);
    for (const h of hunk) out.push(h.t + h.s);
    i = end;
  }
  let unified = out.join('\n');
  const max = o.maxChars ?? 60_000;
  if (unified.length > max) unified = unified.slice(0, max) + '\n… (diff afgekapt)';
  return { added, removed, unified };
}
