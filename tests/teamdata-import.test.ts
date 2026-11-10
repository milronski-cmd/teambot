import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startTestApp } from './helpers.js';
import { makeOpenBotFixture } from './fixtures/openbot-fixture.js';
import { createOpenBotImportModule } from '../server/modules/openbot-import/index.js';
import { adaptSkillText } from '../server/modules/openbot-import/mapping.js';
import { createFoldersModule } from '../server/modules/folders/index.js';
import { createRoutinesModule } from '../server/modules/routines/index.js';
import skills from '../server/modules/skills/index.js';
import memory from '../server/modules/memory/index.js';
import cliAgents from '../server/modules/cli-agents/index.js';
import teamdata from '../server/modules/teamdata/index.js';

/** OpenBot's shared team tables (agent-data.db) → TeamBot's team database. Synthetic data only. */

const OB_SKILL = `---
name: team-database
description: "Gedeelde teamtabellen in agent-data.db. Werkt met openbot.query_data en openbot.execute_data (skill openbot-data)."
---

# Teamdatabase

Tabellen in \`~/OpenBot/Shared/Data/agent-data.db\`. Lezen: \`openbot.query_data\`. Schrijven: \`openbot.execute_data\`.
- **Taak geven**: INSERT INTO taken (titel, eigenaar) VALUES (...) + kort \`send_message\` aan de eigenaar.
`;

/** Add OpenBot's shared team database (as its agents built it) to a fixture. */
function addTeamData(home: string, ids: { baas: string; klant: string }) {
  const file = path.join(home, 'OpenBot', 'Shared', 'Data', 'agent-data.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
CREATE TABLE openbot_metadata (table_name TEXT PRIMARY KEY, owner_agent_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE taken (
  id INTEGER PRIMARY KEY, titel TEXT NOT NULL, eigenaar TEXT NOT NULL, aangevraagd_door TEXT,
  site TEXT, status TEXT NOT NULL DEFAULT 'open',
  resultaat TEXT, bewijs TEXT, aangemaakt TEXT DEFAULT (datetime('now','localtime')), bijgewerkt TEXT);
CREATE TABLE beslissingen (
  id INTEGER PRIMARY KEY, vraag TEXT NOT NULL, uitleg TEXT, opties TEXT, gevraagd_door TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  antwoord TEXT, vervangt_id INTEGER, aangemaakt TEXT DEFAULT (datetime('now','localtime')), beslist TEXT);
CREATE TABLE logboek (
  id INTEGER PRIMARY KEY, agent TEXT NOT NULL, site TEXT, wat TEXT NOT NULL, waarom TEXT, bewijs TEXT,
  terugdraaien TEXT, tijd TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE dagtotaal (datum TEXT PRIMARY KEY, omzet REAL, orders INTEGER, opmerking TEXT);
`);
  const meta = db.prepare('INSERT INTO openbot_metadata VALUES (?, ?, ?)');
  for (const t of ['taken', 'beslissingen', 'logboek']) meta.run(t, ids.baas, '2026-11-05T23:18:41.903Z');
  meta.run('dagtotaal', ids.klant, '2026-11-06T00:24:26.771Z');
  db.prepare('INSERT INTO taken (id, titel, eigenaar, aangevraagd_door, status, resultaat, bewijs, aangemaakt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(3, 'Feed controleren', 'Klantenservice', 'Baas', 'klaar', 'Alles goed', 'https://example.com/feed', '2026-11-06 10:00:00');
  db.prepare('INSERT INTO taken (id, titel, eigenaar, status, aangemaakt) VALUES (?, ?, ?, ?, ?)').run(4, 'Merk bewijzen', 'Baas', 'wacht_op_sanne', '2026-11-06 11:00:00');
  const dec = db.prepare('INSERT INTO beslissingen (id, vraag, uitleg, opties, gevraagd_door, status, antwoord, vervangt_id, aangemaakt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  dec.run(5, 'Testcampagne starten?', 'Kost €5 per dag.', 'A) Ja; B) Later; C) Nee', 'Baas', 'open', null, null, '2026-11-06 01:00:00');
  dec.run(7, 'Retour terugbetalen?', '', '["Ja","Eerst bewijs","Nee"]', 'Klantenservice', 'open', null, 5, '2026-11-06 02:00:00');
  dec.run(9, 'Oude vraag', '', '["Ja","Nee"]', 'Baas', 'gekozen', 'Ja', null, '2026-11-05 09:00:00');
  const log = db.prepare('INSERT INTO logboek (agent, site, wat, waarom, tijd) VALUES (?, ?, ?, ?, ?)');
  for (let i = 1; i <= 4; i++) log.run(i % 2 ? 'Baas' : 'Klantenservice', 'voorbeeld.nl', `Wijziging ${i}`, 'test', `2026-11-06 0${i}:00:00`);
  db.prepare('INSERT INTO dagtotaal VALUES (?, ?, ?, ?)').run('2026-11-06', 20.9, 1, 'Stand om 17:00');
  db.close();
  return file;
}

const fakeDetect = () => async (kind: string) => (kind === 'claude-code' || kind === 'opencode' ? { installed: true, loggedIn: true, version: 'test' } : { installed: false });

test('adaptSkillText: OpenBot data tools become the team database tools, conventions stay', () => {
  const out = adaptSkillText(OB_SKILL);
  assert.doesNotMatch(out, /openbot\.(query|execute)_data|openbot-data|agent-data\.db|send_message/);
  assert.match(out, /Werkt met `team_query` en `team_execute`\."/);
  assert.match(out, /Tabellen in de teamdatabase van TeamBot \(Teamwerk\)\. Lezen: `team_query`\. Schrijven: `team_execute`\./);
  assert.match(out, /INSERT INTO taken \(titel, eigenaar\) VALUES \(\.\.\.\) \+ kort `ask_bot` aan de eigenaar/);
});

test('OpenBot import: team tables come over (ids kept, bot tables owned by the bot), skill adapted, OpenBot untouched, re-import adds only new rows', async () => {
  const fx = makeOpenBotFixture();
  fs.mkdirSync(path.join(fx.home, '.agents', 'skills', 'team-database'), { recursive: true });
  fs.writeFileSync(path.join(fx.home, '.agents', 'skills', 'team-database', 'SKILL.md'), OB_SKILL);
  const agentData = addTeamData(fx.home, fx.agents);
  const t = await startTestApp({
    modules: [cliAgents, memory, skills, createRoutinesModule(), createFoldersModule(), teamdata, createOpenBotImportModule({ paths: () => ({ dataDir: fx.dataDir, home: fx.home }), detect: fakeDetect })],
  });
  try {
    const owner = t.app.ctx.auth.owner()!;
    const svc = t.app.ctx.services.teamdata;
    const before = fx.hashes();
    const plan = await t.api('POST', '/openbot-import/preview');
    assert.ok(plan.teamData?.selected);
    assert.deepEqual(
      plan.teamData.tables.map((x: any) => [x.name, x.rows, x.standard, x.owner]),
      [
        ['beslissingen', 3, true, 'Baas'],
        ['dagtotaal', 1, false, 'Klantenservice'],
        ['logboek', 4, true, 'Baas'],
        ['taken', 2, true, 'Baas'],
      ],
    );
    const sel = {
      stagingId: plan.stagingId,
      bots: Object.fromEntries(plan.bots.map((b: any) => [b.key, { selected: true, workspace: 'new' }])),
      routines: [],
      skills: plan.skills.filter((s: any) => s.selected).map((s: any) => s.key),
      memories: 'off',
      shared: false,
      teamData: true,
    };
    const r = await t.api('POST', '/openbot-import/commit', sel);
    assert.equal(r.counts.teamRows, 10);
    assert.deepEqual(
      r.teamData.map((x: any) => [x.name, x.created, x.inserted, x.skipped, x.renumbered]),
      [
        ['beslissingen', false, 3, 0, 0],
        ['dagtotaal', true, 1, 0, 0],
        ['logboek', false, 4, 0, 0],
        ['taken', false, 2, 0, 0],
      ],
    );
    // OpenBot's files were only read.
    const after = fx.hashes();
    for (const [f, h] of Object.entries(before)) assert.equal(after[f], h, `unchanged: ${f}`);
    assert.ok(!fs.existsSync(agentData + '-wal') || before[path.relative(fx.root, agentData + '-wal')]);

    // Ids are kept (bots refer to "kaart 7"), so are replaces-links; open decisions are in Wacht op jou with their asker.
    const open = await t.api('GET', '/teamdata/decisions');
    assert.deepEqual(open.map((d: any) => [d.id, d.asker?.name, d.vervangt_id]), [[7, 'Klantenservice', 5], [5, 'Baas', null]]);
    assert.deepEqual(open.find((d: any) => d.id === 5).options.map((o: any) => o.answer), ['A) Ja', 'B) Later', 'C) Nee']);
    const tables = await svc.tables(owner.id);
    const dag = tables.find((x: any) => x.name === 'dagtotaal');
    assert.equal(dag.owner.name, 'Klantenservice');
    assert.equal(dag.owner.type, 'agent');
    assert.equal((await svc.rows(owner.id, 'SELECT omzet FROM dagtotaal'))[0].omzet, 20.9);
    assert.equal((await t.api('GET', '/teamdata/summary')).waitingTasks, 1);

    // The imported team-database skill speaks TeamBot.
    const lib = t.app.ctx.services.skills.library;
    const sk = lib.getByName(owner.id, 'team-database');
    assert.ok(sk, 'team-database skill imported');
    const md = lib.readSkillMd(sk);
    assert.match(md, /`team_query`/);
    assert.doesNotMatch(md, /openbot\.query_data|agent-data\.db/);

    // OpenBot keeps going: one new row; importing again adds only that row (nothing twice).
    const db = new DatabaseSync(agentData);
    db.prepare('INSERT INTO beslissingen (id, vraag, opties, gevraagd_door) VALUES (?, ?, ?, ?)').run(10, 'Nieuwe vraag', 'A) Ja; B) Nee', 'Baas');
    db.close();
    const plan2 = await t.api('POST', '/openbot-import/preview');
    assert.equal(plan2.teamData.tables.find((x: any) => x.name === 'beslissingen').imported, 3);
    const before2 = fx.hashes();
    const r2 = await t.api('POST', '/openbot-import/commit', { stagingId: plan2.stagingId, bots: {}, routines: [], skills: [], memories: 'off', shared: false, teamData: true });
    assert.deepEqual(
      r2.teamData.map((x: any) => [x.name, x.inserted, x.skipped]),
      [
        ['beslissingen', 1, 3],
        ['dagtotaal', 0, 1],
        ['logboek', 0, 4],
        ['taken', 0, 2],
      ],
    );
    const after2 = fx.hashes();
    for (const [f, h] of Object.entries(before2)) assert.equal(after2[f], h, `unchanged: ${f}`);
    assert.equal((await svc.rows(owner.id, 'SELECT COUNT(*) AS n FROM beslissingen'))[0].n, 4);
    assert.equal((await svc.rows(owner.id, 'SELECT COUNT(*) AS n FROM logboek'))[0].n, 4);
  } finally {
    await t.close();
    fx.cleanup();
  }
});

test('import keeps ids only where they are free; taken ids get a new number', async () => {
  const t = await startTestApp();
  try {
    const owner = t.app.ctx.auth.owner()!;
    const svc = t.app.ctx.services.teamdata;
    await svc.write(owner.id, [{ sql: 'INSERT INTO logboek (id, agent, wat) VALUES (?, ?, ?)', params: [2, 'Bouwer', 'Al in TeamBot'] }]);
    const res = await svc.importTables(owner.id, 'test', [{ name: 'logboek', sql: '', rows: [1, 2, 3].map((id) => ({ __rowid: id, id, agent: 'Baas', wat: `Bron ${id}`, onbekende_kolom: 'x' })) }], () => ({ type: 'system', id: '', name: 'TeamBot' }));
    assert.deepEqual([res[0].inserted, res[0].renumbered, res[0].error], [3, 1, undefined]);
    const rows = await svc.rows(owner.id, 'SELECT id, wat FROM logboek ORDER BY id');
    assert.deepEqual(rows.map((x: any) => [x.id, x.wat]), [[1, 'Bron 1'], [2, 'Al in TeamBot'], [3, 'Bron 3'], [4, 'Bron 2']]);
    // A bad table name or definition is reported, not run.
    const bad = await svc.importTables(owner.id, 'test', [{ name: 'x"; DROP TABLE taken; --', sql: 'CREATE TABLE x (a)', rows: [] }, { name: 'eigen', sql: 'CREATE TRIGGER eigen AFTER INSERT ON taken BEGIN DELETE FROM taken; END', rows: [] }], () => ({ type: 'system', id: '', name: 'TeamBot' }));
    assert.ok(bad.every((x: any) => x.error));
    assert.ok((await svc.tables(owner.id)).some((x: any) => x.name === 'taken'));
  } finally {
    await t.close();
  }
});

test('teams (B2): an import goes into the team asked for; undoImport takes exactly that import back', async () => {
  const t = await startTestApp();
  try {
    const owner = t.app.ctx.auth.owner()!;
    const svc = t.app.ctx.services.teamdata;
    assert.equal(svc.perTeam, true, 'importers can see that tables are stored per team');
    await t.agent({ name: 'Ada' }); // makes the default team
    const B = (await t.api('POST', '/teams', { name: 'Team B' })).id;
    const sys = () => ({ type: 'system' as const, id: '', name: 'TeamBot' });
    // Already in team B before the import: stays whatever happens.
    await svc.write(owner.id, [{ sql: 'INSERT INTO logboek (id, agent, wat) VALUES (?, ?, ?)', params: [2, 'Bouwer', 'Al in TeamBot'] }], B);
    const tables = () => [
      { name: 'logboek', sql: '', rows: [1, 2, 3].map((id) => ({ __rowid: id, id, agent: 'Baas', wat: `Bron ${id}` })) },
      { name: 'eigen', sql: 'CREATE TABLE eigen (id INTEGER PRIMARY KEY, naam TEXT)', rows: [{ id: 1, naam: 'x' }, { id: 2, naam: 'y' }] },
      { name: 'bijgevuld', sql: 'CREATE TABLE bijgevuld (naam TEXT)', rows: [{ __rowid: 1, naam: 'uit OpenBot' }] },
    ];
    const res = await svc.importTables(owner.id, 'test', tables(), sys, { teamId: B });
    assert.deepEqual(res.map((x: any) => [x.name, x.created, x.inserted, x.error]), [
      ['logboek', false, 3, undefined],
      ['eigen', true, 2, undefined],
      ['bijgevuld', true, 1, undefined],
    ]);
    // Only team B got it; the default team's database is untouched.
    assert.equal((await svc.rows(owner.id, 'SELECT COUNT(*) AS n FROM logboek'))[0].n, 0);
    assert.ok(!(await svc.tables(owner.id)).some((x: any) => x.name === 'eigen'));
    assert.deepEqual(svc.importedCounts(owner.id, 'test', { teamId: B }), { logboek: 3, eigen: 2, bijgevuld: 1 });
    assert.deepEqual(svc.importedCounts(owner.id, 'test'), {});
    await assert.rejects(svc.importTables(owner.id, 'test', tables(), sys, { teamId: 'tm_bestaat_niet' }), /Team niet gevonden/);

    // Since the import a bot wrote a log line and a row in an imported table of its own.
    await svc.write(owner.id, [{ sql: "INSERT INTO logboek (agent, wat) VALUES ('Bo', 'na de import')" }, { sql: "INSERT INTO bijgevuld (naam) VALUES ('van een bot')" }], B);
    // Undo in another team does nothing.
    assert.deepEqual(await svc.undoImport(owner.id, 'test'), []);
    const undo = await svc.undoImport(owner.id, 'test', { teamId: B });
    assert.deepEqual(
      undo.map((x: any) => [x.name, x.removed, x.dropped, x.error]).sort(),
      [
        ['bijgevuld', 1, false, undefined],
        ['eigen', 2, true, undefined],
        ['logboek', 3, false, undefined],
      ],
    );
    // Exactly the imported rows are gone (the renumbered one too); what was there before and what bots added stay.
    assert.deepEqual((await svc.rows(owner.id, 'SELECT wat FROM logboek ORDER BY id', [], false, B)).map((r: any) => r.wat), ['Al in TeamBot', 'na de import']);
    const left = (await svc.tables(owner.id, B)).map((x: any) => x.name);
    assert.ok(!left.includes('eigen'), 'the empty table the import made is gone');
    assert.ok(left.includes('bijgevuld'), 'a table with rows of a bot stays');
    assert.deepEqual((await svc.rows(owner.id, 'SELECT naam FROM bijgevuld', [], false, B)).map((r: any) => r.naam), ['van een bot']);
    assert.deepEqual(svc.importedCounts(owner.id, 'test', { teamId: B }), {});
    assert.ok((await t.api('GET', `/teamdata/audit?team=${B}`)).some((x: any) => /UNDO IMPORT test → logboek/.test(x.sql)));

    // Importing again adds the rows anew; undo of one table touches only that table.
    const again = await svc.importTables(owner.id, 'test', tables(), sys, { teamId: B });
    assert.equal(again.find((x: any) => x.name === 'logboek').inserted, 3);
    const one = await svc.undoImport(owner.id, 'test', { teamId: B, tables: ['eigen'] });
    assert.deepEqual(one.map((x: any) => [x.name, x.removed, x.dropped]), [['eigen', 2, true]]);
    assert.deepEqual(svc.importedCounts(owner.id, 'test', { teamId: B }), { logboek: 3, bijgevuld: 1 });
  } finally {
    await t.close();
  }
});
