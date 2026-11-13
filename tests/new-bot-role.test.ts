/**
 * A role is not a description (new-user check, 12 nov: a bot made with "Nieuwe bot" greeted "Hoi, ik ben Pen.
 * Schrijver", because the role was also written into the description and the chat greets with the description as a
 * sentence). A new bot gets an example's own sentence or none; bots that 0.4.4 made that way lose that copy once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { fromRole, STARTERS } from '../ui/src/pages/newbot/starters.js';
import { migrate } from '../server/core/db.js';
import { coreMigrations } from '../server/core/migrations.js';

test('"Nieuwe bot": a role the owner typed is the role only; an example brings its own sentence and rules', () => {
  assert.deepEqual(fromRole(' Schrijver '), { role: 'Schrijver', description: '', instructions: '' });
  const ex = STARTERS[0];
  assert.deepEqual(fromRole(ex.role), { role: ex.role, description: ex.description, instructions: ex.instructions });
  assert.notEqual(fromRole(ex.role).description, ex.role);
});

test('bots made with the role as description lose that copy once; a description of its own stays', async () => {
  const t = await startTestApp();
  try {
    const pen = await t.api('POST', '/agents', { name: 'Pen', role: 'Schrijver', description: 'Schrijver' });
    const ida = await t.api('POST', '/agents', { name: 'Ida', role: 'Onderzoeker', description: 'Zoekt dingen grondig uit.' });
    const db = t.app.ctx.db;
    db.prepare("DELETE FROM _migrations WHERE id = 'core-role-not-description-001'").run();
    migrate(db, coreMigrations);
    const row = (id: string) => t.app.ctx.store.agent(id)!;
    assert.deepEqual([row(pen.id).role, row(pen.id).description], ['Schrijver', '']);
    assert.equal(row(ida.id).description, 'Zoekt dingen grondig uit.');
  } finally {
    await t.close();
  }
});
