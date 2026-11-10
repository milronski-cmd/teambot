/**
 * Ctrl+K finds tasks (0.4.5): the task board (room_tasks) and the team database (`taken`), word by word ("Offerte
 * Jansen" finds "Offerte voor Jansen afmaken"), with a link that opens the task on #/tasks, per team, and on a paired
 * phone. Praktijktest 0.4.4: "Offerte Jansen" did not find the task.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

test('Ctrl+K finds board tasks and team-database tasks, also on the phone and per team', async () => {
  const t = await startTestApp();
  try {
    const owner = t.app.ctx.auth.owner()!;
    const kees = await t.agent({ name: 'Kees' });
    // Two teams; Kees works in team B (a task he does belongs to his team).
    const teams = await t.api('GET', '/teams');
    const A = teams[0].id;
    const B = (await t.api('POST', '/teams', { name: 'Team B' })).id;
    await t.api('PUT', `/teams/${B}/bots/${kees.id}`, {});

    const task = await t.api('POST', '/rooms/tasks', { title: 'Offerte voor Jansen afmaken', description: 'Twee fietsen en een slot' });
    await t.api('PATCH', `/rooms/tasks/${task.id}`, { ownerType: 'agent', ownerId: kees.id, status: 'doing' });
    await t.api('POST', '/rooms/tasks', { title: 'Factuur Pietersen' });

    const q = async (s: string, team = '') => (await t.api('GET', `/search/all?q=${encodeURIComponent(s)}${team ? `&team=${team}` : ''}`)).hits as any[];

    // Every word, in any order; not the whole text in one piece.
    const hits = (await q('Offerte Jansen')).filter((h) => h.kind === 'task');
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.equal(hits[0].title, 'Offerte voor Jansen afmaken');
    assert.equal(hits[0].href, `#/tasks?open=${encodeURIComponent(`b:${task.id}`)}`);
    assert.match(hits[0].subtitle, /Bezig · Kees/);
    assert.equal(hits[0].agentId, kees.id);
    assert.ok((await q('fietsen slot')).some((h) => h.kind === 'task' && h.id === task.id), 'the description counts too');
    assert.ok(!(await q('Offerte Pietersen')).some((h) => h.kind === 'task'), 'all words must match');

    // Teams: a task of Kees (team B) belongs to team B; the owner's own task to every team.
    assert.equal(hits[0].teamId, B);
    assert.ok((await q('offerte jansen', B)).some((h) => h.kind === 'task' && h.id === task.id));
    assert.ok(!(await q('offerte jansen', A)).some((h) => h.kind === 'task' && h.id === task.id), 'not in the other team');
    assert.ok((await q('pietersen', A)).some((h) => h.kind === 'task'), "the owner's own task shows in every team");
    assert.ok((await q('pietersen', B)).some((h) => h.kind === 'task'));

    // The team database (the bots' own list): the other half of the task page.
    const td = t.app.ctx.services.teamdata;
    await td.write(owner.id, [{ sql: "INSERT INTO taken (titel, eigenaar, status) VALUES ('Website Jansen bijwerken', 'Kees', 'wacht_op_eigenaar')" }]);
    const team = (await q('jansen website')).filter((h) => h.kind === 'task');
    assert.equal(team.length, 1, JSON.stringify(team));
    assert.match(team[0].href, /^#\/tasks\?open=t%3A\d+$/);
    assert.match(team[0].subtitle, /Te controleren · Kees/);
    assert.equal((await q('jansen')).filter((h) => h.kind === 'task').length, 2, 'board and team database together');

    // On a paired phone (the Taken page works there).
    const tokP = t.app.ctx.auth.createSession(owner.id, 'device', 'Telefoon').token;
    const phone = async (s: string) => ((await fetch(`${t.app.url}/api/search/all?q=${encodeURIComponent(s)}`, { headers: { authorization: `Bearer ${tokP}` } }).then((r) => r.json())) as any).hits as any[];
    assert.ok((await phone('offerte jansen')).some((h) => h.kind === 'task' && h.id === task.id));
    assert.ok((await phone('website jansen')).some((h) => h.kind === 'task' && h.id.startsWith('t:')));

    // Another user finds none of it.
    const other = t.app.ctx.auth.createUser({ name: 'Ander', email: 'ander-taken@example.com', password: 'wachtwoord1' });
    const tokB = t.app.ctx.auth.createSession(other.id, 'web', 'B').token;
    const rB = (await fetch(`${t.app.url}/api/search/all?q=jansen`, { headers: { authorization: `Bearer ${tokB}` } }).then((r) => r.json())) as any;
    assert.ok(!rB.hits.some((h: any) => h.kind === 'task'));
  } finally {
    await t.close();
  }
});
