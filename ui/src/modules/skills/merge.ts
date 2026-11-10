/**
 * Merge a newer answer of a marketplace list into the cards already on screen without moving them: cards keep their
 * place (with the newer data), new cards go at the end. Only a complete answer (nothing loading any more, nothing cut
 * off by the server's limit) may remove cards that are gone; before that, a card missing from a partial answer stays.
 * Pure (no React), so it is unit-tested.
 */
export function mergeStable<I>(prev: I[], next: I[], idOf: (i: I) => string, complete: boolean): I[] {
  const fresh = new Map(next.map((i) => [idOf(i), i]));
  const out: I[] = [];
  const have = new Set<string>();
  for (const p of prev) {
    const id = idOf(p);
    const n = fresh.get(id);
    if (n === undefined && complete) continue;
    out.push(n ?? p);
    have.add(id);
  }
  for (const n of next) if (!have.has(idOf(n))) out.push(n);
  return out;
}

/** The answer is final: no source still loading or being checked, and the server did not cut the list short. */
export function isComplete(d: { pending?: string[]; refreshing?: string[]; total?: number; items: unknown[] }): boolean {
  return !d.pending?.length && !d.refreshing?.length && (d.total === undefined || d.total <= d.items.length);
}

/** Text for the small "bijwerken…" indicator next to a filling list ('' when nothing is loading). */
export function refreshLabel(d: { pending?: string[]; refreshing?: string[] } | null, progress?: { ready: number; total: number; noun: string }): string {
  if (!d || (!d.pending?.length && !d.refreshing?.length)) return '';
  if (d.pending?.length && progress && progress.total > 1) return `Bijwerken… ${Math.min(progress.ready, progress.total)} van ${progress.total} ${progress.noun} binnen`;
  return 'Bijwerken…';
}
