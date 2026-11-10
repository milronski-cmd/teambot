/**
 * The card under a routine proposal said "elke MO" when a model used English day codes (praktijktest 0.4.4). The card
 * now reads every code the server reads (server/modules/routines/schedule.ts parseDay) and shows Dutch words.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayName, dayNumber, everyText } from '../ui/src/modules/routines/days.js';
import { parseDay } from '../server/modules/routines/schedule.js';

test('day codes in Dutch words: MO/TU, Mon/Tue, Monday, ma/di, numbers', () => {
  assert.equal(everyText(['MO']), 'elke maandag');
  assert.equal(everyText(['Mon', 'Wed', 'Fri']), 'elke maandag, woensdag, vrijdag');
  assert.equal(everyText(['TU', 'th']), 'elke dinsdag, donderdag');
  assert.equal(everyText(['ma', 'di', 'wo', 'do', 'vr']), 'elke werkdag');
  assert.equal(everyText(['MO', 'TU', 'WE', 'TH', 'FR']), 'elke werkdag');
  assert.equal(everyText(['SA', 'SU']), 'elk weekend');
  assert.equal(everyText([1, 2, 3, 4, 5, 6, 0]), 'elke dag');
  assert.equal(everyText([]), 'elke dag');
  assert.equal(everyText(['Sunday', 'Monday']), 'elke maandag, zondag', 'Monday first');
  assert.equal(dayName('Thu.'), 'donderdag');
  assert.equal(dayName(7), 'zondag');
  assert.equal(dayName('xx'), 'xx', 'an unknown code stays as it is');
});

test('the card reads the same codes as the server', () => {
  const codes = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'maandag', 'zondag', 'ma', 'zo', 'di', 'wo', 'do', 'vr', 'za', 'Monday', 'saturday', '0', '7', 3];
  for (const c of codes) assert.equal(dayNumber(c), parseDay(c), String(c));
});
