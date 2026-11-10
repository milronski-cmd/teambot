/**
 * Own order of the bots in the chat list (sidebar and the phone's Chats): `sort` = position from 1 (POST /agents/order).
 * Bots that were never placed (sort 0, e.g. just made) come after the placed ones, oldest first. Pure
 * (tests/bot-order.test.ts).
 */

export type BotOrderMode = 'recent' | 'manual';

export function compareManual(a: { sort?: number; created_at: string; name: string }, b: { sort?: number; created_at: string; name: string }): number {
  const sa = a.sort && a.sort > 0 ? a.sort : Number.POSITIVE_INFINITY;
  const sb = b.sort && b.sort > 0 ? b.sort : Number.POSITIVE_INFINITY;
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.created_at.localeCompare(b.created_at) || a.name.localeCompare(b.name);
}

/** Move the item at `from` to position `to` (both clamped), returning a new list. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return list;
  const out = list.slice();
  const [it] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, it);
  return out;
}

/** Index where a dragged row lands, from the pointer's y and the rows' vertical midpoints (top to bottom). */
export function dropIndex(y: number, mids: number[]): number {
  let i = 0;
  while (i < mids.length && y > mids[i]) i++;
  return i;
}
