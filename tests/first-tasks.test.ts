// A brand-new bot's empty chat suggests three first tasks that fit its role (ui/src/shell/firstTasks.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstTasks } from '../ui/src/shell/firstTasks.js';

test('three suggestions that fit the role; the role goes before the description and the name', () => {
  assert.match(firstTasks({ name: 'Ada', role: 'Onderzoeker' })[0], /nieuws/);
  assert.match(firstTasks({ name: 'Bas', role: 'Tekstschrijver' })[0], /welkomstmail/);
  assert.match(firstTasks({ name: 'Cor', role: 'Software-ontwikkelaar' })[0], /werkmap/);
  assert.match(firstTasks({ name: 'Baas', role: 'Hoofdbot: verdeelt het werk over de teams' })[0], /team/);
  assert.match(firstTasks({ name: 'Boekhouder', role: '' })[0], /factuur/, 'no role: the name tells');
  assert.match(firstTasks({ name: 'Schrijver', role: 'Onderzoeker', description: 'Schrijft teksten' })[0], /nieuws/, 'the role wins');
});

test('a bot without a recognisable role gets three general suggestions; always three whole sentences', () => {
  const general = firstTasks({ name: 'Mila' });
  assert.equal(general.length, 3);
  assert.match(general[0], /wat je voor mij kunt doen/);
  for (const bot of [{ name: 'Mila' }, { role: 'Onderzoeker' }, { role: 'Planner' }, { role: 'Verkoper' }, { role: 'Boekhouder' }]) {
    const tasks = firstTasks(bot);
    assert.equal(new Set(tasks).size, 3);
    for (const task of tasks) assert.ok(task.length > 15 && task.length < 70 && !/[.…]$/.test(task), task);
  }
});
