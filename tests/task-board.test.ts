import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { COLUMNS, TEAM_STATUS_FOR, byPlace, claimOf, columnOfTeamStatus, doneWhenOf, evidenceOf, fromBoardTask, fromTeamRow, matches, mergeTasks } from '../ui/src/pages/tasks/model.js';

/** One task board for the owner (#/tasks) over TeamBot's own board (room_tasks) and the team database (taken). */

test('the five columns, and where the statuses of the team database land', () => {
  assert.deepEqual(
    COLUMNS.map((c) => c.label),
    ['Te doen', 'Bezig', 'Te controleren', 'Klaar', 'Geblokkeerd'],
  );
  const cases: [string, string][] = [
    ['open', 'todo'],
    ['', 'todo'],
    ['bezig', 'doing'],
    ['wacht_op_eigenaar', 'review'],
    ['wacht_op_sanne', 'review'],
    ['klaar', 'done'],
    ['geblokkeerd', 'blocked'],
    ['geannuleerd', 'stopped'],
    ['vervallen', 'stopped'],
  ];
  for (const [s, col] of cases) assert.equal(columnOfTeamStatus(s), col, s);
  // Moving a card writes back a status that lands in the same column again.
  for (const c of COLUMNS) assert.equal(columnOfTeamStatus(TEAM_STATUS_FOR[c.id]), c.id);
});

test('fields a newer server adds ("klaar als", evidence, claim, check) are shown when they are there', () => {
  const plain = fromBoardTask({ id: 'task_1', title: 'Offerte', status: 'review', ownerName: 'Bo', owner_type: 'agent', owner_id: 'agt_bo', created_at: '2026-11-09T10:00:00.000Z', updated_at: '2026-11-09T11:00:00.000Z' });
  assert.equal(plain.doneWhen, '');
  assert.deepEqual(plain.evidence, []);
  assert.equal(plain.claimedBy, '');
  // Names vary per implementation: camelCase or snake_case, a list, JSON in a text column, or an id of a bot.
  const rich = { id: 'task_2', title: 'Site', status: 'done', done_when: 'De pagina staat online', evidence: JSON.stringify([{ kind: 'link', url: 'https://example.com/pagina' }, 'screenshot.png']), claimed_by: 'agt_bo', checkResult: { verdict: 'Goedgekeurd' } };
  const t = fromBoardTask(rich, { agentName: (id) => (id === 'agt_bo' ? 'Bo' : undefined) });
  assert.equal(t.doneWhen, 'De pagina staat online');
  assert.deepEqual(t.evidence, [
    { label: 'link', text: 'https://example.com/pagina' },
    { label: '', text: 'screenshot.png' },
  ]);
  assert.equal(t.claimedBy, 'Bo');
  assert.equal(t.check, 'Goedgekeurd');
  assert.equal(doneWhenOf({ klaarAls: ['Getest', 'Gemeld'] }), 'Getest\nGemeld');
  assert.deepEqual(evidenceOf({ bewijs: 'https://example.com/bewijs' }), [{ label: '', text: 'https://example.com/bewijs' }]);
  assert.equal(claimOf({ claimedBy: { name: 'Ada' } }), 'Ada');
  // Belangrijk (engine-chain, D2): only TeamBot's own board has it.
  assert.equal(plain.important, false);
  assert.equal(fromBoardTask({ ...rich, important: true }).important, true);
  assert.equal(fromTeamRow({ id: 1, titel: 'X', status: 'open', important: true }).important, false);
});

test('a board task with the quality record of package C1: klaar als, claim, evidence and the second look come from it', () => {
  const quality = {
    doneWhen: 'Offerte als PDF in de groepsmap',
    doneWhenBy: 'user',
    skipCheck: false,
    claim: { agentId: 'agt_bo', name: 'Bo', at: '2026-11-09T10:00:00.000Z' },
    outcome: 'done',
    outcomeReason: '',
    reportedBy: null,
    evidence: [{ type: 'file', value: 'offerte.pdf', ok: true, note: '' }, { type: 'link', value: 'https://example.com/x', ok: null, note: 'niet geopend' }],
    check: { state: 'review', label: 'Te controleren', reason: 'Het bedrag ontbreekt', engine: 'mock', at: null },
    open: true,
  };
  const t = fromBoardTask({ id: 'task_9', title: 'Offerte', status: 'review', owner_type: 'agent', owner_id: 'agt_bo', ownerName: 'Bo', quality });
  assert.equal(t.doneWhen, 'Offerte als PDF in de groepsmap');
  assert.equal(t.claimedBy, 'Bo');
  assert.deepEqual(t.evidence, [
    { label: 'bestand', text: 'offerte.pdf' },
    { label: 'link', text: 'https://example.com/x (niet geopend)' },
  ]);
  assert.equal(t.check, 'Te controleren: Het bedrag ontbreekt');
  assert.equal(t.waitsForYou, true, 'the second look waits for the owner');
  assert.equal(t.quality, quality, 'the record goes to the quality block as it is');
  assert.ok(matches(t, 'groepsmap'), 'klaar als is searchable');
  // A record without anything yet changes nothing.
  const empty = fromBoardTask({ id: 'task_10', title: 'Leeg', status: 'todo', quality: { ...quality, doneWhen: '', claim: null, evidence: [], check: { state: 'none', label: '', reason: '', engine: '', at: null }, open: false } });
  assert.equal(empty.waitsForYou, false);
  assert.equal(empty.check, '');
  // The team database: "kon_niet" (the bot honestly could not) waits for the owner.
  assert.equal(columnOfTeamStatus('kon_niet'), 'review');
  assert.equal(fromTeamRow({ id: 2, titel: 'Y', status: 'kon_niet' }).waitsForYou, true);
});

test('a team-database row: owner, site, result and evidence; "wacht_op_…" waits for you; own columns stay visible', () => {
  const r = fromTeamRow({ id: 7, titel: 'Bing opschonen', eigenaar: 'SEO & Content', aangevraagd_door: 'Operations', site: 'voorbeeld.nl', status: 'wacht_op_sanne', resultaat: 'Besluit nodig', bewijs: 'https://example.com/b', aangemaakt: '2026-11-06 23:06:03', bijgewerkt: null, prioriteit: 'hoog' });
  assert.equal(r.key, 't:7');
  assert.equal(r.column, 'review');
  assert.equal(r.waitsForYou, true);
  assert.equal(r.owner, 'SEO & Content');
  assert.deepEqual(r.evidence, [{ label: '', text: 'https://example.com/b' }]);
  assert.deepEqual(r.extra, [['prioriteit', 'hoog']]);
  assert.equal(r.updated, '2026-11-06 23:06:03');
  assert.ok(matches(r, 'bing voorbeeld'));
  assert.ok(!matches(r, 'bing amazon'));
});

test('the board and the team database together: one list, newest first, each card in its column', async () => {
  const t = await startTestApp();
  try {
    const owner = t.app.ctx.auth.owner()!;
    const bot = await t.agent({ name: 'Bo', tool_groups: ['team'] });
    // A bot sets a task for the owner on TeamBot's board (task_create), and a task in the team database (team_execute).
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    t.script.push({ toolCalls: [{ name: 'task_create', args: { title: 'Prijzen controleren', owner: owner.name, status: 'review' } }] }, { text: 'Gezet.' });
    await t.say(th.id, 'Zet een taak voor mij klaar.');
    await t.app.ctx.services.teamdata.write(owner.id, [{ sql: 'INSERT INTO taken (titel, eigenaar, status, resultaat, bewijs) VALUES (?, ?, ?, ?, ?)', params: ['Nieuwsbrief', 'Bo', 'klaar', 'Verstuurd', 'https://example.com/mail'] }]);
    await t.api('POST', '/rooms/tasks', { title: 'Mijn eigen taak' });

    const board = await t.api('GET', '/rooms/tasks');
    const team = await t.api('GET', '/teamdata/tasks');
    const all = mergeTasks(board, team, { meId: owner.id });
    assert.equal(all.length, 3);
    const p = byPlace(all);
    assert.deepEqual(p.review.map((x) => x.title), ['Prijzen controleren']);
    assert.equal(p.review[0].waitsForYou, true, 'a task for the owner waits for him');
    assert.deepEqual(p.done.map((x) => [x.title, x.source, x.evidence.length]), [['Nieuwsbrief', 'team', 1]]);
    assert.deepEqual(p.todo.map((x) => x.title), ['Mijn eigen taak']);

    // The notification for a task for you opens the one board.
    const told = t.app.ctx.store.one<{ link: string }>("SELECT link FROM notifications WHERE user_id = ? AND title LIKE '%aak voor jou: %'", owner.id);
    assert.equal(told?.link, '#/tasks');

    // Moving a team-database card writes its own word for the column; the card stays where it was put.
    const row = team[0];
    const moved = await t.api('PATCH', `/teamdata/tasks/${row.id}`, { status: TEAM_STATUS_FOR.blocked });
    assert.equal(fromTeamRow(moved).column, 'blocked');
  } finally {
    await t.close();
  }
});
