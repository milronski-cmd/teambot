/**
 * Each bot once in the chat list: the (max. 3) pinned bots are the big tiles on top and are left out of the rows below.
 * While searching there are no tiles, so every match is a row. Pure (unit-tested in tests/pinned-list.test.ts).
 */
export function splitPinned<E extends { type: string; agent?: { id: string } }, A extends { id: string }>(entries: E[], pinned: A[], q = ''): { tiles: A[]; rest: E[] } {
  const tiles = q.trim() ? [] : pinned.slice(0, 3);
  if (!tiles.length) return { tiles, rest: entries };
  const ids = new Set(tiles.map((a) => a.id));
  return { tiles, rest: entries.filter((e) => e.type !== 'bot' || !e.agent || !ids.has(e.agent.id)) };
}
