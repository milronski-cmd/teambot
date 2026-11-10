import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chainLoop, chainLoopText, chainOptionLabel, chainWarning } from '../ui/src/modules/routines/chain.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('"Daarna starten" shows whether the next routine is on and warns when the chain would skip it', () => {
  assert.equal(chainOptionLabel({ name: 'Weekrapport', status: 'active' }), 'Weekrapport');
  assert.equal(chainOptionLabel({ name: 'Weekrapport (kopie)', status: 'paused' }), 'Weekrapport (kopie) (gepauzeerd, start niet)');
  assert.equal(chainOptionLabel({ name: 'Voorstel', status: 'draft' }), 'Voorstel (concept, start niet)');
  assert.equal(chainOptionLabel({ name: 'Kapot', status: 'paused', paused_reason: 'Automatisch gepauzeerd na 3 fouten' }), 'Kapot (automatisch gepauzeerd, start niet)');
  assert.equal(chainWarning({ name: 'Weekrapport', status: 'active' }), null);
  assert.equal(chainWarning(null), null);
  assert.match(chainWarning({ name: 'Weekrapport (kopie)', status: 'paused' })!, /staat op pauze\. De keten slaat hem over tot je hem aanzet/);
});

test('a new routine opens on its settings (schedule and task), not on Triggers', () => {
  const src = fs.readFileSync(path.join(here, '..', 'ui', 'src', 'modules', 'routines', 'Pages.tsx'), 'utf8');
  const at = src.indexOf("api.post<RoutineView>('/routines', d)");
  assert.ok(at > 0);
  const create = src.slice(at, at + 400);
  assert.match(create, /\?tab=settings/);
  assert.doesNotMatch(create, /\?tab=triggers/);
});

test('"Daarna starten" refuses a choice that comes back to this routine (A → B → A), with the loop named', () => {
  const all = [
    { id: 'a', name: 'A', status: 'active', options: { then: { routineId: 'b' } } },
    { id: 'b', name: 'B', status: 'active', options: { then: { routineId: 'c' } } },
    { id: 'c', name: 'C', status: 'active', options: { then: null } },
    { id: 'x', name: 'X', status: 'active', options: { then: { routineId: 'y' } } },
    { id: 'y', name: 'Y', status: 'active', options: { then: { routineId: 'x' } } },
  ];
  // C → A would close A → B → C → A.
  assert.deepEqual(chainLoop(all, 'c', 'C', 'a'), ['C', 'A', 'B', 'C']);
  assert.equal(chainLoopText(chainLoop(all, 'c', 'C', 'a') || []), 'Dit maakt een kring: C → A → B → C.');
  assert.deepEqual(chainLoop(all, 'b', 'B', 'a'), ['B', 'A', 'B']);
  // A → C is fine (C starts nothing); a new routine (no id yet) can never be part of a loop.
  assert.equal(chainLoop(all, 'a', 'A', 'c'), null);
  assert.equal(chainLoop(all, undefined, 'Nieuw', 'a'), null);
  // An old loop elsewhere (X <-> Y) does not hang the check and does not block an unrelated choice.
  assert.equal(chainLoop(all, 'c', 'C', 'x'), null);
  assert.equal(chainOptionLabel({ name: 'A', status: 'active' }, ['C', 'A', 'B', 'C']), 'A (maakt een kring, kan niet)');
});
