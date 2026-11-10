/**
 * Memory per team (0.4 B, wave 2): the update from 0.3 files all memory under "Mijn team" with the same visibility as
 * before; dedup and quotas are per team, forgetting is global (every copy, every team); "vakkennis meenemen" copies
 * only dossiers and shared knowledge; a specialist's knowledge base lands in its bot's team; a bot that moves no longer
 * reads its old team's memory. The walls themselves are probed in tests/teams-isolation.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import { fileUnderTeams } from '../server/modules/memory/teams.js';

const svcOf = (t: TestApp) => t.app.ctx.services.memory.svc;

async function tool(t: TestApp, agentId: string, name: string, args: any) {
  const th = await t.api('POST', '/threads', { agentId });
  t.script.push({ toolCalls: [{ name, args }] }, { text: 'ok' });
  const msgs = await t.say(th.id, 'doe het');
  return String(msgs.find((m: any) => m.role === 'tool')?.content || '');
}

/** Owner with team A (Ada) and team B (Bo); memory on, patterns only. */
async function twoTeams() {
  const t = await startTestApp();
  await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
  const ada = await t.agent({ name: 'Ada' });
  const [def] = await t.api('GET', '/teams');
  const A = await t.api('PATCH', `/teams/${def.id}`, { name: 'Team A' });
  const B = await t.api('POST', '/teams', { name: 'Team B' });
  const bo = await t.agent({ name: 'Bo', settings: { homeTeam: B.id } });
  return { t, ada, bo, A, B, owner: t.app.ctx.auth.owner()!.id };
}

test('update from 0.3: old memory goes into “Mijn team”, every bot sees what it saw before, nothing more', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const ada = await t.agent({ name: 'Ada' });
    const eva = await t.agent({ name: 'Eva' });
    const svc = svcOf(t);
    const store = t.app.ctx.store;
    // Memory as 0.3 left it: nothing has a team.
    await t.api('POST', '/memory/items', { content: 'Onze webshop verkoopt fietsen', scope: 'shared' });
    await t.api('POST', '/memory/items', { content: 'Ik heet Sanne', scope: 'about_you' });
    await t.api('POST', '/memory/items', { content: 'Ada schrijft de nieuwsbrief', scope: 'agent', agentId: ada.id });
    const d = (await t.api('POST', '/memory/dossiers', { title: 'Project Fiets' })).dossier;
    store.exec('UPDATE memory_items SET team_id = NULL');
    store.exec('UPDATE memory_dossiers SET team_id = NULL');
    store.exec('UPDATE memory_episodes SET team_id = NULL');
    const before = (bot: any) => {
      const r = svc.readerFor(store.agent(bot.id)!, null);
      return { items: svc.searchItems(r, 'fietsen Sanne nieuwsbrief', { limit: 50 }).map((h: any) => h.row.id).sort(), dossiers: svc.readableDossiers(r).sort() };
    };
    const adaBefore = before(ada);
    const evaBefore = before(eva);
    // NULL already counts as the default team (read before filing) …
    assert.equal(adaBefore.items.length, 3);
    assert.equal(evaBefore.items.length, 2, 'Eva never saw Ada’s own notes');
    assert.deepEqual(adaBefore.dossiers, [d.id]);
    // … and filing puts everything under a real team, with exactly the same visibility.
    const [team] = await t.api('GET', '/teams');
    assert.ok(fileUnderTeams(svc) >= 3);
    assert.equal(store.one<any>("SELECT COUNT(*) AS n FROM memory_items WHERE scope IN ('agent','shared') AND team_id IS NULL")?.n, 0);
    assert.equal(store.one<any>("SELECT team_id FROM memory_items WHERE scope = 'shared'")?.team_id, team.id);
    assert.equal(store.one<any>("SELECT team_id FROM memory_items WHERE scope = 'about_you'")?.team_id, null, '“Over jou” stays personal');
    assert.equal(store.one<any>('SELECT team_id FROM memory_dossiers WHERE id = ?', d.id)?.team_id, team.id);
    assert.deepEqual(before(ada), adaBefore);
    assert.deepEqual(before(eva), evaBefore);
    // A second team: its bot sees "Over jou" (personal, as before) but nothing of "Mijn team".
    const B = await t.api('POST', '/teams', { name: 'Thuis' });
    const bo = await t.agent({ name: 'Bo', settings: { homeTeam: B.id } });
    const r = svc.readerFor(store.agent(bo.id)!, null);
    assert.deepEqual(svc.searchItems(r, 'fietsen Sanne nieuwsbrief', { limit: 50 }).map((h: any) => svc.contentOf(h.row)), ['Ik heet Sanne']);
    assert.deepEqual(svc.readableDossiers(r), []);
  } finally {
    await t.close();
  }
});

test('dedup and quotas per team; “onthoud voor alle teams” is for every team', async () => {
  const { t, ada, bo, A, B } = await twoTeams();
  try {
    const store = t.app.ctx.store;
    // The same fact in two teams is two memories (dedup within a team) …
    const a1 = await t.api('POST', '/memory/items', { content: 'De koffie staat in de keuken', scope: 'shared', teamId: A.id });
    const b1 = await t.api('POST', '/memory/items', { content: 'De koffie staat in de keuken', scope: 'shared', teamId: B.id });
    assert.equal(a1.action, 'inserted');
    assert.equal(b1.action, 'inserted');
    // … and in the same team a duplicate.
    assert.equal((await t.api('POST', '/memory/items', { content: 'De koffie staat in de keuken', scope: 'shared', teamId: A.id })).action, 'duplicate');
    // A bot's shared knowledge goes to its own team (its own bucket).
    await tool(t, bo.id, 'memory_remember', { content: 'Het magazijn van B gaat om acht uur open', scope: 'shared' });
    assert.equal(store.one<any>("SELECT team_id FROM memory_items WHERE content LIKE 'Het magazijn%'")?.team_id, B.id);

    // Quota per team: team A full, team B still has room.
    await t.api('PUT', '/memory/settings', { quotas: { shared: { items: 10, bytes: 512_000 } } });
    for (let i = 0; i < 9; i++) await t.api('POST', '/memory/items', { content: `Feit ${i} van team A over onderdeel ${i * 31}`, scope: 'shared', teamId: A.id });
    await assert.rejects(() => t.api('POST', '/memory/items', { content: 'Nog een feit van team A over de kantine', scope: 'shared', teamId: A.id }), /Gedeeld in team “Team A”.*vol/);
    assert.equal((await t.api('POST', '/memory/items', { content: 'Nog een feit van team B over de kantine', scope: 'shared', teamId: B.id })).action, 'inserted');
    const storage = await t.api('GET', '/memory/storage');
    assert.deepEqual(storage.sharedByTeam.map((x: any) => [x.name, x.items]), [['Team A', 10], ['Team B', 3], ['Alle teams', 0]]);

    // "Onthoud voor alle teams dat …" in the owner's own words: shared with every team.
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    t.script.push({ text: 'Genoteerd.' });
    await t.say(th.id, 'Onthoud voor alle teams dat we op 24 december dicht zijn');
    const row = store.one<any>("SELECT * FROM memory_items WHERE content LIKE '%24 december%'");
    assert.equal(row?.scope, 'shared');
    assert.equal(row?.team_id, '*');
    const svc = svcOf(t);
    assert.ok(svc.searchItems(svc.readerFor(store.agent(bo.id)!, null), '24 december').length, 'team B reads it too');
  } finally {
    await t.close();
  }
});

test('forgetting is global: every copy in every team goes, and nothing can store it again', async () => {
  const { t, ada, bo, A, B } = await twoTeams();
  try {
    const store = t.app.ctx.store;
    const svc = svcOf(t);
    const fact = 'Het alarmnummer van de loods is 0612';
    const a = (await t.api('POST', '/memory/items', { content: fact, scope: 'shared', teamId: A.id })).item;
    // The same fact in team B (learned separately) and in a copy made with "vakkennis meenemen".
    const b = (await t.api('POST', '/memory/items', { content: fact, scope: 'shared', teamId: B.id })).item;
    const d = (await t.api('POST', '/memory/dossiers', { title: 'Loods', teamId: A.id })).dossier;
    const rec = (await t.api('POST', `/memory/dossiers/${d.id}/records`, { kind: 'decision', title: 'De loods gaat om zes uur dicht' })).record;
    const C = await t.api('POST', '/teams', { name: 'Team C' });
    const copy = await t.api('POST', '/memory/teams/copy', { fromTeamId: A.id, toTeamId: C.id });
    assert.equal(copy.dossiers, 1);
    const copied = store.one<any>("SELECT * FROM memory_items WHERE copy_of = ? AND scope = 'shared'", a.id);
    assert.ok(copied && copied.team_id === C.id);
    // The owner forgets it in team A: gone in A, B and C.
    await t.api('POST', `/memory/items/${a.id}/forget`, { alsoSource: false });
    for (const id of [a.id, b.id, copied.id]) assert.equal(store.one<any>('SELECT status FROM memory_items WHERE id = ?', id)?.status, 'forgotten');
    assert.equal(store.one<any>("SELECT COUNT(*) AS n FROM memory_fts WHERE text LIKE '%alarmnummer%'")?.n, 0);
    // Not even B's bot can store it again in team B.
    const out = await tool(t, bo.id, 'memory_remember', { content: fact });
    assert.match(out, /eerder op verzoek vergeten/);
    // A decision forgotten in A's dossier is forgotten in the copy too.
    await t.api('POST', `/memory/records/${rec.id}/forget`, {});
    assert.equal(store.one<any>("SELECT COUNT(*) AS n FROM memory_records WHERE (id = ? OR copy_of = ?) AND status != 'forgotten'", rec.id, rec.id)?.n, 0);
    // A bot that forgets its own note on its own initiative only forgets that note.
    await t.api('POST', '/memory/items', { content: 'De sleutel ligt onder de mat bij Ada', scope: 'agent', agentId: ada.id });
    const mine = store.one<any>("SELECT id, ref FROM memory_items WHERE content = 'De sleutel ligt onder de mat bij Ada' AND scope = 'agent'");
    const shared = (await t.api('POST', '/memory/items', { content: 'De sleutel ligt onder de mat bij Ada', scope: 'shared', teamId: B.id })).item;
    await tool(t, ada.id, 'memory_forget', { id: `m:${mine.ref}` });
    assert.equal(store.one<any>('SELECT status FROM memory_items WHERE id = ?', mine.id)?.status, 'forgotten');
    assert.equal(store.one<any>('SELECT status FROM memory_items WHERE id = ?', shared.id)?.status, 'active', 'team B’s copy stays: Ada cannot write in team B');
    void svc;
  } finally {
    await t.close();
  }
});

test('“vakkennis meenemen” copies only dossiers and shared knowledge, never personal memory; off by default', async () => {
  const { t, ada, A, B } = await twoTeams();
  try {
    const store = t.app.ctx.store;
    const svc = svcOf(t);
    // Team A's knowledge …
    const d = (await t.api('POST', '/memory/dossiers', { title: 'Vakkennis fietsen', summary: 'Alles over fietsonderhoud', teamId: A.id })).dossier;
    await t.api('POST', `/memory/dossiers/${d.id}/records`, { kind: 'decision', title: 'We gebruiken alleen kettingolie van merk X' });
    await t.api('POST', `/memory/dossiers/${d.id}/sources`, { kind: 'note', title: 'Handleiding', text: 'Een ketting smeer je elke 300 kilometer met een dun laagje olie.' });
    await t.api('POST', '/memory/items', { content: 'Remblokken vervang je na 2000 kilometer', scope: 'dossier', dossierId: d.id });
    await t.api('POST', '/memory/items', { content: 'Een band plak je met een plakset', scope: 'shared', teamId: A.id });
    await t.api('POST', '/memory/items', { content: 'Regel van team A: controleer elke bestelling twee keer', scope: 'shared', teamId: A.id, type: 'instruction', pinned: true });
    // … and what never goes: "Over jou", a bot's notes, a summary, personal/sensitive knowledge, knowledge for all teams.
    await t.api('POST', '/memory/items', { content: 'Ik ben allergisch voor noten', scope: 'about_you' });
    await t.api('POST', '/memory/items', { content: 'Ada houdt van korte zinnen', scope: 'agent', agentId: ada.id });
    await t.api('POST', '/memory/items', { content: 'De pincode van de kluis bewaart Sanne thuis', scope: 'shared', teamId: A.id, sensitivity: 'personal' });
    await t.api('POST', '/memory/items', { content: 'Iedereen is welkom op vrijdag', scope: 'shared', teamId: '*' });
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    t.script.push({ text: 'Goed.' });
    await t.say(th.id, 'We bespreken de fietsenvoorraad');
    assert.ok(store.one('SELECT 1 FROM memory_episodes WHERE thread_id = ?', th.id));
    const count = (sql: string, ...p: any[]) => store.one<any>(sql, ...p)?.n ?? 0;
    const itemsB = () => count("SELECT COUNT(*) AS n FROM memory_items WHERE team_id = ? AND status = 'active'", B.id);

    // Duplicating without the option: nothing of memory.
    const none = t.app.ctx.services.teams.copyTeamData(store.agent(ada.id)!.user_id, A.id, B.id, {});
    assert.equal(none.memory, undefined);
    assert.equal(itemsB(), 0);
    assert.equal(count('SELECT COUNT(*) AS n FROM memory_dossiers WHERE team_id = ?', B.id), 0);

    // With "vakkennis meenemen".
    const r = t.app.ctx.services.teams.copyTeamData(store.agent(ada.id)!.user_id, A.id, B.id, { knowledge: true }).memory;
    assert.equal(r.dossiers, 1);
    assert.equal(r.records, 1);
    assert.equal(r.sources, 1);
    assert.equal(r.items, 3, 'the dossier note, the shared fact and the team rule');
    assert.equal(r.skipped.personal, 1);
    const nd = store.one<any>('SELECT * FROM memory_dossiers WHERE team_id = ? AND copy_of = ?', B.id, d.id);
    assert.ok(nd, 'a copy of the dossier in team B');
    const contents = store.all<any>("SELECT content FROM memory_items WHERE status = 'active' AND (team_id = ? OR dossier_id = ?)", B.id, nd.id).map((x) => x.content).sort();
    assert.deepEqual(contents, ['Een band plak je met een plakset', 'Regel van team A: controleer elke bestelling twee keer', 'Remblokken vervang je na 2000 kilometer']);
    for (const never of ['allergisch', 'korte zinnen', 'pincode', 'welkom op vrijdag']) assert.equal(count("SELECT COUNT(*) AS n FROM memory_items WHERE content LIKE ? AND status = 'active'", `%${never}%`), 1, `${never}: only the original`);
    assert.equal(count('SELECT COUNT(*) AS n FROM memory_episodes'), 1, 'conversation summaries never go');
    // The copy is the new team's own: its bots find the document, and the team rule applies to them.
    const bo = await t.agent({ name: 'Bo', settings: { homeTeam: B.id } });
    const out = await tool(t, bo.id, 'dossier_get', { dossier: 'Vakkennis fietsen', query: 'ketting smeren' });
    assert.match(out, /300 kilometer/);
    assert.match(t.requests.at(-1)!.system, /Regel van team A: controleer elke bestelling twee keer/);
    // Copying again: what is there already is not copied twice.
    const again = await t.api('POST', '/memory/teams/copy', { fromTeamId: A.id, toTeamId: B.id });
    assert.equal(again.dossiers, 0);
    assert.equal(again.items, 0);
    assert.ok(again.skipped.existing >= 2);
    assert.match(again.message, /stonden er al/);
    await assert.rejects(() => t.api('POST', '/memory/teams/copy', { fromTeamId: A.id, toTeamId: A.id }), /twee verschillende teams/);
    void svc;
  } finally {
    await t.close();
  }
});

test('a specialist’s knowledge base inherits its bot’s team; a module writing for a bot keeps its walls', async () => {
  const { t, ada, bo, B } = await twoTeams();
  try {
    const mem = t.app.ctx.services.memory;
    const owner = t.app.ctx.auth.owner()!.id;
    const kb = mem.dossiers.create(owner, { title: 'Kennisbank SEO', kind: 'topic', agentId: bo.id }).dossier;
    assert.equal(kb.team_id, B.id, 'in Bo’s team');
    assert.deepEqual(kb.agent_ids, [bo.id], 'first for Bo only');
    // The learning round writes in it for Bo …
    const ev = mem.dossiers.addEvent(owner, kb.id, { title: 'Google wijzigde de richtlijnen' }, bo.id);
    assert.equal(ev.existed, false);
    assert.equal(mem.remember(owner, { content: 'Titels van 60 tekens werken het best', scope: 'dossier', dossierId: kb.id, agentId: bo.id, createdBy: 'agent' }).action, 'inserted');
    // … but never for a bot of another team.
    assert.throws(() => mem.dossiers.addEvent(owner, kb.id, { title: 'Ada schrijft hier niet' }, ada.id), /Team B/);
    assert.equal(mem.remember(owner, { content: 'Ada schrijft hier ook niet', scope: 'dossier', dossierId: kb.id, agentId: ada.id, createdBy: 'agent' }).action, 'invalid');
    // A bot that creates a dossier itself: in its own team.
    await tool(t, bo.id, 'dossier_create', { title: 'Zoekwoorden' });
    assert.equal(t.app.ctx.store.one<any>("SELECT team_id FROM memory_dossiers WHERE title = 'Zoekwoorden'")?.team_id, B.id);
  } finally {
    await t.close();
  }
});

test('a bot that moves to another team no longer reads its old team’s memory; its new notes are in the new team', async () => {
  const { t, ada, A, B } = await twoTeams();
  try {
    const store = t.app.ctx.store;
    const svc = svcOf(t);
    await t.api('POST', '/memory/items', { content: 'Ada kent de klanten van team A', scope: 'agent', agentId: ada.id });
    await t.api('POST', '/memory/items', { content: 'Team A bezorgt op dinsdag', scope: 'shared', teamId: A.id });
    const see = () => svc.searchItems(svc.readerFor(store.agent(ada.id)!, null), 'klanten bezorgt dinsdag', { limit: 20 }).map((h: any) => svc.contentOf(h.row)).sort();
    assert.deepEqual(see(), ['Ada kent de klanten van team A', 'Team A bezorgt op dinsdag']);
    await t.api('PUT', `/teams/${B.id}/bots/${ada.id}`);
    assert.deepEqual(see(), [], 'walls follow the team, not the bot');
    // With meekijken in her old team she reads it again, but writes only in team B.
    await t.api('PUT', `/teams/${A.id}/access/${ada.id}`, { level: 'read' });
    assert.equal(see().length, 2);
    await tool(t, ada.id, 'memory_remember', { content: 'Ada werkt nu voor team B' });
    assert.equal(store.one<any>("SELECT team_id FROM memory_items WHERE content = 'Ada werkt nu voor team B'")?.team_id, B.id);
    const old = store.one<any>("SELECT ref FROM memory_items WHERE content = 'Ada kent de klanten van team A'");
    assert.match(await tool(t, ada.id, 'memory_update', { id: `m:${old.ref}`, content: 'Ada kende de klanten van team A' }), /alleen meelezen/);
    // The owner moves the old note along (a deliberate choice).
    const id = store.one<any>("SELECT id FROM memory_items WHERE content = 'Ada kent de klanten van team A'").id;
    await t.api('PATCH', `/memory/items/${id}`, { teamId: B.id });
    assert.equal(store.one<any>('SELECT team_id FROM memory_items WHERE id = ?', id)?.team_id, B.id);
    // One team = no team words: the owner's view only tags teams with two or more.
    const item = (await t.api('GET', `/memory/items/${id}`)).item;
    assert.equal(item.team?.name, 'Team B');
  } finally {
    await t.close();
  }
});
