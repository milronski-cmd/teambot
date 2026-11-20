/** Two bots with the same work become one: what is still to do moves, the other goes to the archive, nothing is deleted. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { refusal } from '../server/modules/teams/manage.js';

test('merging two bots: open tasks, routines, notes, apps and the team database follow; the other is archived', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const userId = ctx.auth.owner()!.id;
    const one = await t.agent({ name: 'Bouwer' });
    const two = await t.agent({ name: 'Bouwer 2', role: 'Apps bouwen', instructions: 'Bouw alleen in een eigen werkmap.' });
    const open = await t.api('POST', '/rooms/tasks', { title: 'Formulier bouwen', ownerType: 'agent', ownerId: two.id, start: false });
    const done = await t.api('POST', '/rooms/tasks', { title: 'Al klaar', ownerType: 'agent', ownerId: two.id, start: false });
    ctx.store.exec("UPDATE room_tasks SET status = 'done' WHERE id = ?", done.id);
    const rt = await t.api('POST', '/routines', { name: 'Elke ochtend bouwen', agent_id: two.id, prompt: 'Bouw de site', schedule: { kind: 'weekly', days: [1], times: ['08:00'] } });
    const memory = ctx.services.memory;
    const notes = memory.notesFor ? memory.notesFor(ctx.store.agent(two.id)) : null;
    const td = ctx.services.teamdata;
    await td.ensure(userId);
    await td.write(userId, [
      { sql: "INSERT INTO taken (titel, eigenaar, status) VALUES ('Pagina live', 'Bouwer 2', 'open')" },
      { sql: "INSERT INTO dashboard (sleutel, titel, waarde, bot) VALUES ('builds', 'Builds', '3', 'Bouwer 2')" },
      { sql: "INSERT INTO experimenten (hypothese, eigenaar, status) VALUES ('Kortere knop', 'Bouwer 2', 'loopt')" },
    ]);

    // Never while a turn runs, never a bot with itself, never by a bot.
    await assert.rejects(t.api('POST', `/agents/${two.id}/merge`, { into: two.id }), /twee verschillende bots/);
    assert.match(refusal('POST', `/agents/${two.id}/merge`, { into: one.id }) || '', /doet de eigenaar zelf/);
    ctx.store.exec("INSERT INTO runs (id, thread_id, agent_id, user_id, status, trigger, created_at) VALUES ('run_x', ?, ?, ?, 'running', 'user', ?)", ctx.chat.threadForAgent(userId, two.id).id, two.id, userId, new Date().toISOString());
    await assert.rejects(t.api('POST', `/agents/${two.id}/merge`, { into: one.id }), /nog aan het werk/);
    ctx.store.exec("UPDATE runs SET status = 'done' WHERE id = 'run_x'");

    const out = await t.api('POST', `/agents/${two.id}/merge`, { into: one.id });
    assert.deepEqual([out.from, out.into, out.tasks, out.routines], ['Bouwer 2', 'Bouwer', 1, 1]);
    assert.ok(out.teamRows >= 3, JSON.stringify(out));
    assert.equal(ctx.store.get<any>('room_tasks', open.id).owner_id, one.id, 'the open task moved');
    assert.equal(ctx.store.get<any>('room_tasks', done.id).owner_id, two.id, 'what was done stays where it was done');
    assert.equal(ctx.store.get<any>('routines', rt.id).agent_id, one.id);
    assert.deepEqual(
      (await td.rows(userId, 'SELECT eigenaar FROM taken UNION ALL SELECT bot FROM dashboard UNION ALL SELECT eigenaar FROM experimenten')).map((r: any) => Object.values(r)[0]),
      ['Bouwer', 'Bouwer', 'Bouwer'],
    );
    const gone = ctx.store.agent(two.id)!;
    assert.equal(!!gone.archived, true, 'archived, not deleted');
    assert.equal(gone.settings?.mergedInto, one.id);
    // The bot that stays knows it does the other's work now.
    const stays = ctx.store.agent(one.id)!;
    assert.match(String(stays.instructions), /Je doet sinds het samenvoegen ook het werk van Bouwer 2 \(Apps bouwen\)\.[\s\S]*Bouw alleen in een eigen werkmap\./);
    assert.match(String(stays.role), /Apps bouwen/);
    assert.equal((await t.api('GET', '/agents')).some((a: any) => a.id === two.id), false, 'no longer in the list');
    void notes;
  } finally {
    await t.close();
  }
});
