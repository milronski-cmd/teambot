import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareManual, dropIndex, moveItem } from '../ui/src/shell/botOrder.js';

test('manual bot order: placed bots by position, never-placed ones after them (oldest first)', () => {
  const bots = [
    { name: 'Nieuw', sort: 0, created_at: '2026-11-07T10:00:00Z' },
    { name: 'Twee', sort: 2, created_at: '2026-01-01T00:00:00Z' },
    { name: 'Oud', sort: 0, created_at: '2026-02-01T00:00:00Z' },
    { name: 'Een', sort: 1, created_at: '2026-03-01T00:00:00Z' },
  ];
  assert.deepEqual([...bots].sort(compareManual).map((b) => b.name), ['Een', 'Twee', 'Oud', 'Nieuw']);
});

test('moveItem and dropIndex', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 1, 99), ['a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 5, 0), ['a', 'b']);
  // rows with midpoints at 10, 30, 50: a pointer at 35 lands before the third row
  assert.equal(dropIndex(35, [10, 30, 50]), 2);
  assert.equal(dropIndex(0, [10, 30, 50]), 0);
  assert.equal(dropIndex(99, [10, 30, 50]), 3);
});
