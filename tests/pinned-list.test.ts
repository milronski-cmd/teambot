import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitPinned } from '../ui/src/shell/pinned.js';

/** Chat list: a pinned bot is a tile on top and not again a row below (checklist A-09: "een bot staat maar één keer"). */
test('pinned bots are tiles only; max. 3 tiles; searching shows every match as a row', () => {
  const bot = (id: string) => ({ type: 'bot', agent: { id } });
  const room = { type: 'room', room: { id: 'r1' } } as any;
  const entries = [bot('a'), bot('b'), room, bot('c'), bot('d'), bot('e')];
  const pinned = [{ id: 'b' }, { id: 'd' }, { id: 'e' }, { id: 'a' }];
  const { tiles, rest } = splitPinned(entries, pinned);
  assert.deepEqual(tiles.map((t) => t.id), ['b', 'd', 'e']);
  // The 4th pinned bot ('a') has no tile, so it stays a row; rooms stay.
  assert.deepEqual(rest.map((e: any) => e.agent?.id || e.room.id), ['a', 'r1', 'c']);
  const all = [...tiles.map((t) => t.id), ...rest.filter((e: any) => e.type === 'bot').map((e: any) => e.agent.id)];
  assert.equal(new Set(all).size, all.length, 'every bot once');
  const searching = splitPinned(entries, pinned, 'b');
  assert.deepEqual(searching.tiles, []);
  assert.equal(searching.rest.length, entries.length);
});
