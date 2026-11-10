/**
 * "Daarna starten" (a routine chain): the picker shows whether the next routine is on, and warns when it is not —
 * a paused or draft routine is skipped by the chain (the run history says "staat niet aan"). Pure, so
 * tests/routine-chain.test.ts can check it.
 */

export interface ChainTarget {
  name: string;
  status: 'draft' | 'active' | 'paused' | 'completed' | string;
  paused_reason?: string | null;
}

/** A routine with its own "Daarna starten" choice (for loop detection). */
export interface ChainNode extends ChainTarget {
  id: string;
  options?: { then?: { routineId: string } | null } | null;
}

/**
 * The names along the loop when `selfId` would start `nextId` (A → B → A), or null. Same rule as the server
 * (routines/engine.ts chainLoop): the chain from the next routine may never come back to this one.
 */
export function chainLoop(all: ChainNode[], selfId: string | undefined, selfName: string, nextId: string): string[] | null {
  if (!selfId) return null;
  const byId = new Map(all.map((r) => [r.id, r]));
  const next = byId.get(nextId);
  if (!next) return null;
  if (nextId === selfId) return [selfName, selfName];
  const path = [selfName || 'deze routine', next.name];
  const seen = new Set([next.id]);
  let cur: ChainNode | undefined = next;
  while (cur?.options?.then?.routineId && path.length <= 50) {
    const id: string = cur.options.then.routineId;
    if (id === selfId) return [...path, path[0]];
    if (seen.has(id)) return null;
    seen.add(id);
    cur = byId.get(id);
    if (!cur) return null;
    path.push(cur.name);
  }
  return null;
}

/** The text for a loop the owner cannot choose. */
export function chainLoopText(loop: string[]): string {
  return `Dit maakt een kring: ${loop.join(' → ')}.`;
}

/** The chain starts an active or a finished (one-off) routine; draft and paused ones are skipped (routines/engine.ts). */
const starts = (r: ChainTarget) => r.status === 'active' || r.status === 'completed';

function state(r: ChainTarget): string {
  if (r.status === 'draft') return 'concept';
  if (r.paused_reason?.startsWith('Automatisch')) return 'automatisch gepauzeerd';
  return 'gepauzeerd';
}

export function chainOptionLabel(r: ChainTarget, loop?: string[] | null): string {
  if (loop) return `${r.name} (maakt een kring, kan niet)`;
  return starts(r) ? r.name : `${r.name} (${state(r)}, start niet)`;
}

/** Null when the chain will start it; otherwise what the owner should know. */
export function chainWarning(r: ChainTarget | null | undefined): string | null {
  if (!r || starts(r)) return null;
  const how = r.status === 'draft' ? 'is nog een concept' : 'staat op pauze';
  return `“${r.name}” ${how}. De keten slaat hem over tot je hem aanzet.`;
}
