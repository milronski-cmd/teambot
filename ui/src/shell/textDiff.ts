/**
 * Readable text comparison for bot history (BOT-10) and edited messages: lines first (LCS), then words inside a
 * changed line, so a small edit in long instructions shows as a few marked words instead of two walls of text.
 * Pure, no React (tests/text-diff.test.ts).
 */

export type Piece = { kind: 'same' | 'del' | 'ins'; text: string };
export type DiffLine =
  | { kind: 'same'; text: string }
  | { kind: 'del'; text: string }
  | { kind: 'ins'; text: string }
  /** One line edited in place: the words that were removed and added. */
  | { kind: 'change'; pieces: Piece[] }
  /** A run of unchanged lines folded away. */
  | { kind: 'skip'; count: number };

/** Longest-common-subsequence alignment of two token lists (small inputs only; callers cap the size). */
type Step = { kind: Piece['kind']; i: number; j: number };

function lcs<T>(a: T[], b: T[]): Step[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Step[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) out.push({ kind: 'same', i: i++, j: j++ });
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: 'del', i: i++, j });
    else out.push({ kind: 'ins', i, j: j++ });
  }
  while (i < n) out.push({ kind: 'del', i: i++, j });
  while (j < m) out.push({ kind: 'ins', i, j: j++ });
  return out;
}

/** Word-level pieces for one line (whitespace stays attached, so joining the pieces gives the text back). */
export function wordDiff(a: string, b: string): Piece[] {
  const ta = a.match(/\s+|[^\s]+/g) || [];
  const tb = b.match(/\s+|[^\s]+/g) || [];
  if (ta.length * tb.length > 250_000) return [{ kind: 'del', text: a }, { kind: 'ins', text: b }];
  const out: Piece[] = [];
  const push = (kind: Piece['kind'], text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  for (const s of lcs(ta, tb)) push(s.kind, s.kind === 'ins' ? tb[s.j] : ta[s.i]);
  return out.filter((p) => p.text.length > 0);
}

/**
 * Line diff of two texts. Unchanged runs longer than `context * 2` lines are folded into a `skip`. An edited line
 * (one deleted line followed by one added line) becomes a `change` with word pieces.
 */
export function lineDiff(a: string, b: string, context = 2): DiffLine[] {
  const la = (a || '').split('\n');
  const lb = (b || '').split('\n');
  if (la.length * lb.length > 4_000_000) return [...la.map((text) => ({ kind: 'del' as const, text })), ...lb.map((text) => ({ kind: 'ins' as const, text }))];
  const steps = lcs(la, lb);
  const raw: DiffLine[] = [];
  for (let k = 0; k < steps.length; k++) {
    const s = steps[k];
    if (s.kind === 'same') {
      raw.push({ kind: 'same', text: la[s.i] });
      continue;
    }
    // Collect a block of deletions and insertions, then pair them up line by line.
    const dels: string[] = [];
    const ins: string[] = [];
    while (k < steps.length && steps[k].kind !== 'same') {
      if (steps[k].kind === 'del') dels.push(la[steps[k].i]);
      else ins.push(lb[steps[k].j]);
      k++;
    }
    k--;
    const pairs = Math.min(dels.length, ins.length);
    for (let p = 0; p < pairs; p++) raw.push({ kind: 'change', pieces: wordDiff(dels[p], ins[p]) });
    for (const text of dels.slice(pairs)) raw.push({ kind: 'del', text });
    for (const text of ins.slice(pairs)) raw.push({ kind: 'ins', text });
  }
  // Fold long unchanged runs, keeping `context` lines around each change (nothing changed: nothing to fold).
  if (raw.every((l) => l.kind === 'same')) return raw;
  const out: DiffLine[] = [];
  for (let k = 0; k < raw.length; ) {
    if (raw[k].kind !== 'same') {
      out.push(raw[k++]);
      continue;
    }
    let e = k;
    while (e < raw.length && raw[e].kind === 'same') e++;
    const run = raw.slice(k, e);
    const head = k === 0 ? 0 : context;
    const tail = e === raw.length ? 0 : context;
    if (run.length > head + tail + 1) {
      out.push(...run.slice(0, head), { kind: 'skip', count: run.length - head - tail }, ...run.slice(run.length - tail));
    } else out.push(...run);
    k = e;
  }
  return out;
}

/** How much changed, in words ("3 woorden weg, 5 erbij"), for a one-line summary. */
export function diffStats(lines: DiffLine[]): { removed: number; added: number } {
  const words = (s: string) => (s.match(/[^\s]+/g) || []).length;
  let removed = 0;
  let added = 0;
  for (const l of lines) {
    if (l.kind === 'del') removed += words(l.text);
    else if (l.kind === 'ins') added += words(l.text);
    else if (l.kind === 'change') for (const p of l.pieces) p.kind === 'del' ? (removed += words(p.text)) : p.kind === 'ins' ? (added += words(p.text)) : 0;
  }
  return { removed, added };
}
