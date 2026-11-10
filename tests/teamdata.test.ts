import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startTestApp } from './helpers.js';
import { answers, msgs, settle, sleep, team, until } from './team-mock.js';
import { analyse, isLogAppend, normParams, SqlRefused } from '../server/modules/teamdata/sql.js';
import { parseOptions } from '../server/modules/teamdata/schema.js';
import { columnsFromSql, type TeamData } from '../server/modules/teamdata/service.js';

/** Team database: statement rules, options parsing, bot tools, ownership, isolation, decisions that wake the bot. */

const svcOf = (t: any): TeamData => t.app.ctx.services.teamdata;
const toolResults = (t: any, threadId: string, name: string) => msgs(t, threadId).filter((m: any) => m.role === 'tool' && m.parts?.toolResult?.name === name);

test('analyse: one statement, reads vs writes, refusals with a reason', () => {
  assert.equal(analyse('SELECT * FROM taken WHERE status = ?').kind, 'read');
  assert.equal(analyse('select 1;').kind, 'read');
  assert.equal(analyse("WITH x AS (SELECT 1) SELECT * FROM x").kind, 'read');
  const w = analyse('WITH x AS (SELECT 1 AS a) INSERT INTO logboek (agent, wat) SELECT ?, ? FROM x');
  assert.deepEqual([w.kind, w.verb, w.table], ['write', 'INSERT', 'logboek']);
  assert.deepEqual(pick(analyse('INSERT OR REPLACE INTO "mijn tabel" (a) VALUES (?)')), ['write', 'INSERT', 'mijn tabel', false]);
  assert.deepEqual(pick(analyse('UPDATE taken SET status = ? WHERE id = ?')), ['write', 'UPDATE', 'taken', false]);
  assert.deepEqual(pick(analyse('DELETE FROM logboek')), ['write', 'DELETE', 'logboek', true]);
  assert.deepEqual(pick(analyse('CREATE TABLE IF NOT EXISTS main.dagtotaal (datum TEXT PRIMARY KEY)')), ['ddl', 'CREATE', 'dagtotaal', false]);
  assert.equal(analyse('CREATE UNIQUE INDEX IF NOT EXISTS i ON dagtotaal(datum)').table, 'dagtotaal');
  assert.equal(analyse('DROP TABLE IF EXISTS dagtotaal').table, 'dagtotaal');
  assert.equal(analyse('ALTER TABLE dagtotaal ADD COLUMN x TEXT').verb, 'ALTER');
  // A semicolon inside a string or comment is not a second statement.
  assert.equal(analyse("INSERT INTO logboek (agent, wat) VALUES ('a', 'x; DROP TABLE taken') -- ; nog iets").kind, 'write');
  for (const [sql, re] of [
    ['SELECT 1; SELECT 2', /Eén statement/],
    ["SELECT 1; DROP TABLE taken", /Eén statement/],
    ['PRAGMA table_info(taken)', /team_tables/],
    ['BEGIN', /Transacties/],
    ["ATTACH DATABASE 'c:/x.db' AS x", /koppelen/],
    ["VACUUM INTO 'x.db'", /Onderhoud/],
    ['CREATE TRIGGER t AFTER INSERT ON taken BEGIN DELETE FROM taken; END', /Triggers/],
    ['CREATE TEMP TABLE x (a)', /Tijdelijke/],
    ["CREATE VIRTUAL TABLE x USING fts5(a)", /Virtuele/],
    ["SELECT 'open", /Niet afgesloten/],
    ['GRANT ALL', /Onbekend/],
    ['', /Geef een SQL/],
  ] as const)
    assert.throws(() => analyse(sql), (e: any) => e instanceof SqlRefused && re.test(e.message), sql);
  assert.deepEqual(normParams(['a', 1, true, null, { x: 1 }]), ['a', 1, 1, null, '{"x":1}']);
  assert.deepEqual(normParams('["a", 2]'), ['a', 2]);
  assert.deepEqual(normParams({ ':naam': 'Baas' }), { naam: 'Baas' });
  assert.throws(() => normParams(['x'.repeat(100_001)]), /te lang/);
});

function pick(a: any) {
  return [a.kind, a.verb, a.table, a.allRows];
}

test('parseOptions: the ways bots write options', () => {
  const texts = (raw: string) => parseOptions(raw).map((o) => o.text);
  assert.deepEqual(texts('["Ja, doen", "Later deze week", "Niet doen"]'), ['Ja, doen', 'Later deze week', 'Niet doen']);
  const j = parseOptions('["1. Eerste weg", "2. Tweede weg"]');
  assert.deepEqual(j.map((o) => [o.key, o.text, o.answer]), [['1', 'Eerste weg', '1. Eerste weg'], ['2', 'Tweede weg', '2. Tweede weg']]);
  assert.deepEqual(texts('A) Ja, proberen op één account (max €29 p/m); B) Eerst het probleem oplossen; C) Nee'), ['Ja, proberen op één account (max €29 p/m)', 'Eerst het probleem oplossen', 'Nee']);
  assert.deepEqual(texts('1) Concept nu uit (advies: de klant wacht al 5 dagen). 2) Concept uit mét aanbod (€ 51,90). 3) Direct terugbetalen.'), ['Concept nu uit (advies: de klant wacht al 5 dagen)', 'Concept uit mét aanbod (€ 51,90)', 'Direct terugbetalen']);
  assert.deepEqual(texts('1. Terugbetalen zodra er bewijs is (aanbevolen). 2. Nu al terugbetalen.'), ['Terugbetalen zodra er bewijs is (aanbevolen)', 'Nu al terugbetalen']);
  // "ca. €28" and a reference "(1)" inside an option are not labels.
  assert.deepEqual(texts('A) Lite: ca. €28 per maand, zie (1) hieronder. B) Gratis plan; te weinig. C) Zelf koppelen'), ['Lite: ca. €28 per maand, zie (1) hieronder', 'Gratis plan; te weinig', 'Zelf koppelen']);
  assert.equal(parseOptions('A) Gedaan; B) Later; C) Niet doen')[1].answer, 'B) Later');
  assert.deepEqual(texts('Ja\nNee\nLater'), ['Ja', 'Nee', 'Later']);
  assert.deepEqual(parseOptions('Graag even bellen'), []);
  assert.deepEqual(parseOptions(null), []);
  assert.deepEqual(columnsFromSql("CREATE TABLE x (\n id INTEGER PRIMARY KEY, naam TEXT, -- uitleg\n n INT DEFAULT (1), UNIQUE(naam))"), ['id', 'naam', 'n']);
});

test('team tools: standard tables, read and write, row cap, ownership, isolation from TeamBot itself', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const baas = await m.bot('Baas');
    const ops = await m.bot('Operations');
    const owner = t.app.ctx.auth.owner()!;
    const svc = svcOf(t);
    const run = (agent: any, tool: 'team_query' | 'team_execute', sql: string, params: any[] = []) =>
      svc.run(owner.id, { type: 'agent', id: agent.id, name: agent.name }, sql, params, tool === 'team_query' ? 'query' : 'execute');

    // The standard tables are there from the start, owned by TeamBot.
    const tables = await svc.tables(owner.id);
    assert.deepEqual(tables.slice(0, 5).map((x) => x.name), ['taken', 'beslissingen', 'gebeurtenissen', 'logboek', 'experimenten']);
    assert.ok(tables.every((x) => x.standard && x.owner.name === 'TeamBot' && x.rows === 0));
    assert.ok(fs.existsSync(path.join(t.dir, 'teamdata', `${owner.id}.db`)));

    // Write and read with parameters; local time default.
    const ins = await run(ops, 'team_execute', "INSERT INTO logboek (agent, site, wat, waarom) VALUES (?, ?, ?, ?), (?, ?, ?, ?)", ['Operations', 'shop.nl', 'Prijs aangepast', 'marge', 'Operations', 'shop.nl', 'Feed ververst', 'fout']);
    assert.equal(ins.changes, 2);
    const rows = await run(baas, 'team_query', 'SELECT id, agent, wat, tijd FROM logboek WHERE site = ? ORDER BY id', ['shop.nl']);
    assert.deepEqual(rows.rows.map((r) => r.wat), ['Prijs aangepast', 'Feed ververst']);
    assert.match(rows.rows[0].tijd, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // Upsert and RETURNING work.
    const ret = await run(ops, 'team_execute', 'INSERT INTO taken (titel, eigenaar) VALUES (?, ?) RETURNING id', ['Factuur nalopen', 'Operations']);
    assert.equal(ret.rows[0].id, 1);

    // Reads are capped at 500 rows and say so.
    await svc.write(owner.id, [{ sql: "WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 700) INSERT INTO gebeurtenissen (soort, samenvatting) SELECT 'test', 'rij ' || i FROM c" }]);
    const capped = await run(baas, 'team_query', 'SELECT * FROM gebeurtenissen');
    assert.equal(capped.rows.length, 500);
    assert.equal(capped.truncated, true);

    // team_query cannot write, not even hidden in a CTE.
    await assert.rejects(run(baas, 'team_query', 'DELETE FROM logboek'), /alleen om te lezen/);
    await assert.rejects(run(baas, 'team_query', 'WITH x AS (SELECT 1) DELETE FROM logboek'), /alleen om te lezen/);

    // Own tables: Operations makes one; Baas may add rows but not drop or alter it; Operations may.
    const mk = await run(ops, 'team_execute', 'CREATE TABLE dagtotaal (datum TEXT PRIMARY KEY, omzet REAL)');
    assert.deepEqual(mk.created, ['dagtotaal']);
    assert.equal((await svc.tables(owner.id)).find((x) => x.name === 'dagtotaal')!.owner.name, 'Operations');
    await run(baas, 'team_execute', 'INSERT INTO dagtotaal (datum, omzet) VALUES (?, ?) ON CONFLICT (datum) DO UPDATE SET omzet = excluded.omzet', ['2026-11-07', 20.9]);
    await assert.rejects(run(baas, 'team_execute', 'DROP TABLE dagtotaal'), /Alleen de bot die "dagtotaal" maakte/);
    await assert.rejects(run(baas, 'team_execute', 'ALTER TABLE dagtotaal ADD COLUMN x TEXT'), /Alleen de bot die "dagtotaal" maakte/);
    await run(ops, 'team_execute', 'ALTER TABLE dagtotaal ADD COLUMN orders INTEGER');
    await run(ops, 'team_execute', 'CREATE INDEX dag_omzet ON dagtotaal(omzet)');
    // Standard tables can never be dropped or altered (rows can be changed by every bot).
    await assert.rejects(run(ops, 'team_execute', 'DROP TABLE beslissingen'), /vaste tabel "beslissingen"/);
    await assert.rejects(run(ops, 'team_execute', 'ALTER TABLE taken RENAME TO oud'), /vaste tabel "taken"/);
    await run(baas, 'team_execute', 'UPDATE taken SET status = ? WHERE id = ?', ['bezig', 1]);
    const dropped = await run(ops, 'team_execute', 'DROP TABLE dagtotaal');
    assert.deepEqual(dropped.dropped, ['dagtotaal']);

    // No way out of the team database: TeamBot's own tables, other files, extensions, PRAGMA, recursion.
    await assert.rejects(run(baas, 'team_query', 'SELECT * FROM users'), /Tabel users bestaat niet/);
    await assert.rejects(run(baas, 'team_query', 'SELECT * FROM secrets'), /bestaat niet/);
    await assert.rejects(run(baas, 'team_execute', `ATTACH DATABASE '${path.join(t.dir, 'teambot.db').replace(/\\/g, '/')}' AS tb`), /koppelen/);
    await assert.rejects(run(baas, 'team_query', "SELECT load_extension('x')"), /load_extension/);
    await assert.rejects(run(baas, 'team_query', 'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c) SELECT count(*) FROM c'), /Recursieve/);
    await assert.rejects(run(baas, 'team_query', "SELECT readfile('C:/Windows/win.ini')"), /readfile|no such function/);
    await assert.rejects(run(baas, 'team_execute', 'CREATE TABLE sqlite_x (a)'), /Ongeldige naam|reserved|sqlite_/);
    await assert.rejects(run(baas, 'team_execute', "INSERT INTO logboek (agent, wat) VALUES (?, zeroblob(2000000))", ['x']), /te groot|too big|1 MB/);

    // Every write is in the audit trail (the failed ones with the reason).
    const audit = svc.auditLog(owner.id, 200);
    assert.ok(audit.some((x: any) => x.actor_name === 'Operations' && x.verb === 'INSERT' && x.table_name === 'logboek' && x.changes === 2));
    assert.ok(audit.some((x: any) => x.actor_name === 'Baas' && x.verb === 'DROP TABLE' && /Alleen de bot/.test(x.error)));
  } finally {
    await t.close();
  }
});

test('team tools through a bot: team_tables, team_query answers "welke beslissingen staan open?"', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const baas = await m.bot('Baas');
    const owner = t.app.ctx.auth.owner()!;
    const svc = svcOf(t);
    await svc.write(owner.id, [
      { sql: 'INSERT INTO beslissingen (vraag, opties, gevraagd_door) VALUES (?, ?, ?)', params: ['Google Ads-test na 15 november?', 'A) Nee; B) Ja, klein; C) Breed', 'Ads & Shopping'] },
      { sql: 'INSERT INTO beslissingen (vraag, opties, gevraagd_door, status, antwoord) VALUES (?, ?, ?, ?, ?)', params: ['Oude vraag', '["Ja","Nee"]', 'Baas', 'gekozen', 'Ja'] },
      { sql: 'INSERT INTO beslissingen (vraag, opties, gevraagd_door) VALUES (?, ?, ?)', params: ['Leverancier kiezen voor banden?', '["Leverancier A","Leverancier B","Niet doen"]', 'Operations'] },
    ]);
    m.script(
      'Baas',
      { toolCalls: [{ name: 'team_tables', args: {} }] },
      { toolCalls: [{ name: 'team_query', args: { sql: "SELECT id, vraag, gevraagd_door FROM beslissingen WHERE status = 'open' ORDER BY id" } }] },
      { text: 'Er staan 2 beslissingen open: #1 Google Ads-test en #3 leverancier banden.' },
    );
    const th = await t.api('POST', '/threads', { agentId: baas.id });
    await t.say(th.id, 'Welke beslissingen staan open?');
    // The bot knows the team database from its system prompt.
    assert.match(m.calls.find((c) => c.bot === 'Baas')!.req.system, /## Teamdatabase/);
    assert.ok(m.calls[0].req.tools.some((x) => x.name === 'team_query') && m.calls[0].req.tools.some((x) => x.name === 'team_execute'));
    const tablesOut = toolResults(t, th.id, 'team_tables')[0].content;
    assert.match(tablesOut, /### beslissingen — 3 rijen — vaste tabel/);
    const out = toolResults(t, th.id, 'team_query')[0].content;
    assert.match(out, /^2 rijen\./); // "1 rij" / "2 rijen", not "rij(en)"
    assert.match(out, /Google Ads-test na 15 november\?/);
    assert.match(out, /Leverancier kiezen voor banden\?/);
    assert.doesNotMatch(out, /Oude vraag/);
    assert.match(answers(t, th.id).at(-1)!.content, /2 beslissingen open/);
  } finally {
    await t.close();
  }
});

test('decisions: a bot asks, the owner chooses in the inbox, the bot is woken with the answer (bundled when busy)', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ops = await m.bot('Operations');
    const owner = t.app.ctx.auth.owner()!;
    const notes: any[] = [];
    t.app.ctx.events.on('notification', (e) => notes.push(e.data));
    m.script(
      'Operations',
      {
        toolCalls: [
          {
            name: 'team_execute',
            args: { sql: 'INSERT INTO beslissingen (vraag, uitleg, opties, gevraagd_door) VALUES (?, ?, ?, ?), (?, ?, ?, ?)', params: ['Accu terugbetalen?', 'Klant wacht 5 dagen.', '["Nu terugbetalen","Eerst bewijs","Niet doen"]', 'Operations', 'Contract tekenen?', '', 'A) Geen van beide; B) Alleen Triglobal; C) Beide', 'Operations'] },
          },
        ],
      },
      { text: 'Ik heb twee beslissingen klaargezet.' },
    );
    const th = await t.api('POST', '/threads', { agentId: ops.id });
    await t.say(th.id, 'Zet de open punten klaar voor Sanne.');
    assert.ok(notes.some((n) => n.kind === 'decision' && /Operations vraagt je om 2 beslissingen/.test(n.title) && n.link === '#/inbox'));

    const open = await t.api('GET', '/teamdata/decisions');
    assert.equal(open.length, 2);
    const acc = open.find((d: any) => d.vraag === 'Accu terugbetalen?');
    assert.deepEqual(acc.options.map((o: any) => o.text), ['Nu terugbetalen', 'Eerst bewijs', 'Niet doen']);
    assert.equal(acc.asker.name, 'Operations');
    assert.equal((await t.api('GET', '/teamdata/summary')).openDecisions, 2);

    // The owner picks option 2 with a note: written back and sent to Operations' own chat as a new turn.
    m.script('Operations', { text: 'Top, ik vraag eerst het bewijs op.' }, { text: 'Genoteerd: geen contracten.', delayMs: 50 });
    const r = await t.api('POST', `/teamdata/decisions/${acc.id}/answer`, { choice: 1, note: 'vóór vrijdag' });
    assert.equal(r.decision.status, 'gekozen');
    assert.equal(r.decision.antwoord, 'Eerst bewijs — vóór vrijdag');
    assert.match(r.decision.beslist, /^\d{4}-\d{2}-\d{2} /);
    assert.equal(r.woke.name, 'Operations');
    assert.equal(r.woke.mode, 'sent');
    const chat = t.app.ctx.chat.threadForAgent(owner.id, ops.id);
    assert.equal(chat.id, th.id);
    // While Operations works on that answer, the next choice waits in the queue (never mid-turn).
    const contract = open.find((d: any) => d.vraag === 'Contract tekenen?');
    assert.deepEqual(contract.options.map((o: any) => o.answer), ['A) Geen van beide', 'B) Alleen Triglobal', 'C) Beide']);
    const r2 = await t.api('POST', `/teamdata/decisions/${contract.id}/answer`, { choice: 0 });
    assert.ok(['queued', 'sent'].includes(r2.woke.mode));
    await settle(t);
    const userMsgs = msgs(t, th.id).filter((x: any) => x.role === 'user' && x.parts?.kind === 'team_decision');
    assert.equal(userMsgs.length, 2);
    assert.match(userMsgs[0].content, new RegExp(`^Beslissing #${acc.id}: Accu terugbetalen\\?\\nMijn keuze: Eerst bewijs — vóór vrijdag`));
    assert.match(userMsgs[0].content, /status gekozen/);
    assert.match(userMsgs[1].content, /Mijn keuze: A\) Geen van beide/);
    assert.equal(answers(t, th.id).at(-1)!.content, 'Genoteerd: geen contracten.');

    // Deciding twice is refused (e.g. phone and pc at the same time).
    await assert.rejects(t.api('POST', `/teamdata/decisions/${acc.id}/answer`, { choice: 0 }), /409/);
    assert.equal((await t.api('GET', '/teamdata/decisions')).length, 0);
    const closed = await t.api('GET', '/teamdata/decisions?status=closed');
    assert.equal(closed.length, 2);
  } finally {
    await t.close();
  }
});

test('decisions: answers for a busy bot are bundled into one waiting message; unknown askers are reported', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const baas = await m.bot('Baas');
    const owner = t.app.ctx.auth.owner()!;
    const svc = svcOf(t);
    // Rows written outside TeamBot's tools (e.g. imported): the asking bot is found by its name.
    await svc.write(owner.id, [
      { sql: 'INSERT INTO beslissingen (vraag, opties, gevraagd_door) VALUES (?, ?, ?)', params: ['Eén', 'A) Ja; B) Nee', ' baas '] },
      { sql: 'INSERT INTO beslissingen (vraag, opties, gevraagd_door) VALUES (?, ?, ?)', params: ['Twee', 'A) Ja; B) Nee', 'Baas'] },
      { sql: 'INSERT INTO beslissingen (vraag, opties, gevraagd_door) VALUES (?, ?, ?)', params: ['Drie', 'A) Ja; B) Nee', 'Baas'] },
      { sql: 'INSERT INTO beslissingen (vraag, opties, gevraagd_door) VALUES (?, ?, ?)', params: ['Van een oud teamlid', '', 'Content Kwaliteit'] },
    ]);
    // Baas is busy with a long turn.
    m.script('Baas', { text: 'Bezig met het weekrapport.', delayMs: 700 }, { text: 'Drie keuzes verwerkt.' });
    const th = await t.api('POST', '/threads', { agentId: baas.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Maak het weekrapport.' });
    await until(() => t.app.ctx.store.one("SELECT id FROM runs WHERE thread_id = ? AND status = 'running'", th.id));
    const a = await t.api('POST', '/teamdata/decisions/1/answer', { choice: 0 });
    const b = await t.api('POST', '/teamdata/decisions/2/answer', { choice: 1 });
    const c = await t.api('POST', '/teamdata/decisions/3/answer', { answer: 'Eerst even bellen' });
    assert.deepEqual([a.woke.mode, b.woke.mode, c.woke.mode], ['queued', 'queued', 'queued']);
    const q = t.app.ctx.services.queue.items(th.id);
    assert.equal(q.length, 1, 'one waiting message for all three answers');
    assert.match(q[0].content, /#1: Eén\nMijn keuze: A\) Ja[\s\S]*#2: Twee\nMijn keuze: B\) Nee[\s\S]*#3: Drie\nMijn keuze: Eerst even bellen/);
    await settle(t);
    assert.equal(msgs(t, th.id).filter((x: any) => x.parts?.kind === 'team_decision').length, 1);
    assert.equal(answers(t, th.id).at(-1)!.content, 'Drie keuzes verwerkt.');
    // Nobody to wake: saved, with a clear notice.
    const d = await t.api('POST', '/teamdata/decisions/4/answer', { expire: true, note: 'niet meer nodig' });
    assert.equal(d.decision.status, 'vervallen');
    assert.equal(d.decision.antwoord, 'Vervallen: niet meer nodig');
    assert.equal(d.woke, null);
    assert.match(d.notice, /geen bot met de naam “Content Kwaliteit”/);
    await assert.rejects(t.api('POST', '/teamdata/decisions/99/answer', { choice: 0 }), /404/);
  } finally {
    await t.close();
  }
});

test('owner views: tasks, log search and paging, events, experiments, tables browser', async () => {
  const t = await startTestApp();
  try {
    const owner = t.app.ctx.auth.owner()!;
    const svc = svcOf(t);
    await svc.write(owner.id, [
      { sql: 'INSERT INTO taken (titel, eigenaar, aangevraagd_door, site, status, resultaat, bewijs) VALUES (?, ?, ?, ?, ?, ?, ?)', params: ['Bing opschonen', 'SEO & Content', 'Kennis & Kansen', 'raamwinkel.nl', 'klaar', '26 URL’s verklaard', 'https://example.com/bewijs'] },
      { sql: 'INSERT INTO taken (titel, eigenaar, status) VALUES (?, ?, ?)', params: ['Merk bewijzen', 'Bouwer Sites', 'wacht_op_sanne'] },
      { sql: "WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 120) INSERT INTO logboek (agent, site, wat, waarom) SELECT CASE WHEN i % 2 = 0 THEN 'Bouwer' ELSE 'SEO & Content' END, CASE WHEN i % 3 = 0 THEN 'shop.nl' ELSE 'blog.nl' END, 'Wijziging ' || i, CASE WHEN i = 7 THEN 'robots-meta voor Discover' ELSE 'onderhoud' END FROM c" },
      { sql: 'INSERT INTO gebeurtenissen (soort, dossier, bron, samenvatting, verwerkt) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)', params: ['klantbericht', 'Klanten/Piotr', 'Klantenservice', 'Vraagt naar retour', 0, 'testresultaat', 'Sites/shop', 'Ads & Shopping', 'Feed goedgekeurd', 1] },
      { sql: 'INSERT INTO experimenten (vak, hypothese, status, meetdatum, eigenaar) VALUES (?, ?, ?, ?, ?)', params: ['SEO', 'Backlinks helpen', 'loopt', '2026-12-21', 'SEO & Content'] },
    ]);
    const s = await t.api('GET', '/teamdata/summary');
    assert.deepEqual([s.tasks.klaar, s.waitingTasks, s.unprocessedEvents, s.experiments.loopt], [1, 1, 1, 1]);
    const tasks = await t.api('GET', '/teamdata/tasks');
    assert.equal(tasks.length, 2);
    const moved = await t.api('PATCH', `/teamdata/tasks/${tasks.find((x: any) => x.titel === 'Merk bewijzen').id}`, { status: 'open' });
    assert.equal(moved.status, 'open');
    assert.ok(moved.bijgewerkt);
    await assert.rejects(t.api('PATCH', '/teamdata/tasks/1', { status: "klaar'; DROP TABLE taken; --" }), /400/);

    const first = await t.api('GET', '/teamdata/log?limit=50');
    assert.equal(first.rows.length, 50);
    assert.equal(first.rows[0].wat, 'Wijziging 120');
    assert.equal(first.total, 120);
    assert.deepEqual(first.agents.map((x: any) => x.v).sort(), ['Bouwer', 'SEO & Content']);
    const second = await t.api('GET', `/teamdata/log?limit=50&before=${first.next}`);
    assert.equal(second.rows[0].wat, 'Wijziging 70');
    const found = await t.api('GET', '/teamdata/log?q=' + encodeURIComponent('discover robots'));
    assert.deepEqual(found.rows.map((x: any) => x.wat), ['Wijziging 7']);
    const bySite = await t.api('GET', '/teamdata/log?site=shop.nl&agent=Bouwer');
    assert.ok(bySite.rows.length === 20 && bySite.rows.every((x: any) => x.site === 'shop.nl' && x.agent === 'Bouwer'));
    // Search terms are data: % and _ match literally.
    assert.equal((await t.api('GET', '/teamdata/log?q=%25')).rows.length, 0);

    const ev = await t.api('GET', '/teamdata/events?verwerkt=0');
    assert.deepEqual(ev.rows.map((x: any) => x.samenvatting), ['Vraagt naar retour']);
    assert.equal(ev.soorten.length, 2);
    assert.equal((await t.api('GET', '/teamdata/experiments'))[0].hypothese, 'Backlinks helpen');

    const tables = await t.api('GET', '/teamdata/tables');
    assert.equal(tables.find((x: any) => x.name === 'logboek').rows, 120);
    const page = await t.api('GET', '/teamdata/tables/logboek?limit=10&offset=10');
    assert.equal(page.rows.length, 10);
    assert.equal(page.rows[0].wat, 'Wijziging 110');
    await assert.rejects(t.api('GET', '/teamdata/tables/users'), /404/);
    const empty = await t.api('GET', '/teamdata/tables/experimenten');
    assert.ok(empty.columns.includes('hypothese'));
  } finally {
    await t.close();
  }
});

test('approval cards and steps describe team database actions in words, without the SQL', async () => {
  const t = await startTestApp();
  try {
    const exec = t.app.ctx.tools.get('team_execute')!;
    const query = t.app.ctx.tools.get('team_query')!;
    // Round-2 acceptance: a card read "Teamdatabase toevoegen aan logboek — INSERT INTO logboek (agent, site, …) VALUES (?,?,…)".
    assert.equal(exec.summarize!({ sql: 'INSERT INTO logboek (agent, site, wat, waarom, bewijs, terugdraaien) VALUES (?,?,?,?,?,?)' }), 'Teamdatabase toevoegen aan logboek');
    assert.equal(exec.summarize!({ sql: 'DELETE FROM taken' }), 'Teamdatabase verwijderen uit taken (alle rijen)');
    assert.doesNotMatch(query.summarize!({ sql: 'SELECT * FROM beslissingen WHERE status = ?' }), /SELECT|WHERE/);
  } finally {
    await t.close();
  }
});

test('Vraagt toestemming: a change in the team folder gives one card; the logbook line after it needs none (B-46)', async () => {
  const t = await startTestApp();
  try {
    assert.equal(isLogAppend('INSERT INTO logboek (agent, wat) VALUES (?, ?)'), true);
    assert.equal(isLogAppend('insert into main.logboek (agent, wat) values (?, ?), (?, ?);'), true);
    assert.equal(isLogAppend("INSERT INTO logboek (agent, wat, waarom) VALUES ('Ada', 'update prijzen; select alles', 'delete oud')"), true, 'words inside text are data');
    for (const sql of [
      'INSERT INTO logboek (agent, wat) SELECT naam, email FROM klanten',
      'INSERT INTO logboek (agent, wat) VALUES ((SELECT group_concat(email) FROM klanten), ?)',
      'INSERT OR REPLACE INTO logboek (id, agent, wat) VALUES (1, ?, ?)',
      'INSERT INTO logboek (id, agent, wat) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET wat = excluded.wat',
      'WITH x AS (SELECT 1) INSERT INTO logboek (agent, wat) VALUES (?, ?)',
      'INSERT INTO taken (titel) VALUES (?)',
      'UPDATE logboek SET wat = ? WHERE id = 1',
      'DELETE FROM logboek WHERE id = 1',
      'INSERT INTO logboek (agent, wat) VALUES (?, ?); DELETE FROM taken',
      'INSERT INTO logboek_kopie (agent, wat) VALUES (?, ?)',
    ])
      assert.equal(isLogAppend(sql), false, sql);

    const m = await team(t);
    const ada = await m.bot('Ada', { access_mode: 'ask' });
    const owner = t.app.ctx.auth.owner()!;
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-teammap-'));
    await t.api('PUT', '/folders/team', { path: base, create: true });
    const file = path.join(base, 'prijzen.md');
    const log = { sql: 'INSERT INTO logboek (agent, site, wat, waarom, bewijs, terugdraaien) VALUES (?, ?, ?, ?, ?, ?)', params: ['Ada', 'fietsshop', 'Prijslijst bijgewerkt', 'gevraagd door Sanne', 'prijzen.md', 'oude versie terugzetten'] };
    m.script(
      'Ada',
      { toolCalls: [{ name: 'write_file', args: { path: file, content: '# Prijzen\nFiets: 120 euro\n' } }] },
      { toolCalls: [{ name: 'team_execute', args: log }] },
      { toolCalls: [{ name: 'team_execute', args: { sql: 'UPDATE logboek SET wat = ? WHERE agent = ?', params: ['anders', 'Ada'] } }] },
      { text: 'De prijslijst staat in de teammap en in het logboek.' },
    );
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'zet de prijs van de fiets in de teammap' });
    // One card for the file in the team folder.
    const first = await until(async () => (await t.api('GET', '/approvals')).find((a: any) => a.tool === 'write_file'));
    await t.api('POST', `/approvals/${first.id}`, { decision: 'approve' });
    // The logbook line needs no card; an UPDATE of the logbook does (that changes what was written).
    const second = await until(async () => (await t.api('GET', '/approvals')).find((a: any) => a.tool === 'team_execute'));
    assert.match(second.summary, /wijzigen in logboek/);
    const rows = await svcOf(t).run(owner.id, { type: 'system', id: null as any, name: 'TeamBot' }, 'SELECT agent, wat FROM logboek', [], 'query');
    assert.deepEqual(rows.rows, [{ agent: 'Ada', wat: 'Prijslijst bijgewerkt' }], 'the line was written before the second card');
    await t.api('POST', `/approvals/${second.id}`, { decision: 'deny' });
    await settle(t);
    assert.equal(fs.readFileSync(file, 'utf8'), '# Prijzen\nFiets: 120 euro\n');
    const all = t.app.ctx.store.all<any>('SELECT tool, status FROM approvals ORDER BY created_at');
    assert.deepEqual(all.map((a) => `${a.tool}:${a.status}`), ['write_file:approved', 'team_execute:denied'], 'no card for the logbook line');
    // The audit trail stays honest: the security log has the call (allowed, no human asked) and the team database
    // log says who wrote the line.
    const calls = t.app.ctx.store.all<any>("SELECT data FROM audit WHERE kind = 'tool.call' ORDER BY id").map((r) => JSON.parse(r.data)).filter((d) => d.tool === 'team_execute');
    assert.equal(calls[0].asked, undefined);
    assert.equal(calls[0].denied, false);
    assert.match(calls[0].summary, /toevoegen aan logboek/);
    const tdlog = t.app.ctx.store.all<any>("SELECT actor_type, actor_name, verb, table_name FROM teamdata_audit WHERE table_name = 'logboek' AND error IS NULL ORDER BY id");
    assert.deepEqual({ ...tdlog[0] }, { actor_type: 'agent', actor_name: 'Ada', verb: 'INSERT', table_name: 'logboek' });
    // The bot is told that a logbook line needs no separate approval.
    assert.match(m.calls[0].req.system, /logregel vraagt .* geen aparte toestemming/);

    // Read-only bots still cannot write a logbook line.
    const lezer = await m.bot('Lezer', { access_mode: 'readonly' });
    m.script('Lezer', { toolCalls: [{ name: 'team_execute', args: log }] }, { text: 'Kon niet.' });
    const th2 = await t.api('POST', '/threads', { agentId: lezer.id });
    await t.say(th2.id, 'log iets');
    assert.match(toolResults(t, th2.id, 'team_execute')[0]?.content || 'Onbekende tool', /Geweigerd|Onbekende tool/);
    fs.rmSync(base, { recursive: true, force: true });
  } finally {
    await t.close();
  }
});

test('daily copy of the team database works although bots may not attach databases', async () => {
  const t = await startTestApp();
  try {
    const owner = t.app.ctx.auth.owner()!;
    const svc = svcOf(t);
    await svc.write(owner.id, [{ sql: "INSERT INTO logboek (agent, wat) VALUES ('Operations', 'kopie-test')" }]);
    const dest = await svc.backup(owner.id);
    assert.ok(dest && fs.existsSync(dest), 'the copy exists');
    const { DatabaseSync } = await import('node:sqlite');
    const copy = new DatabaseSync(dest!, { readOnly: true });
    try {
      assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM logboek WHERE wat = 'kopie-test'").get() as any).n, 1);
    } finally {
      copy.close();
    }
    // Bots still cannot attach or copy databases themselves.
    await assert.rejects(svc.run(owner.id, { type: 'agent', id: 'x', name: 'x' }, "ATTACH DATABASE 'x.db' AS x", [], 'execute'), /koppelen/);
    // A second call on the same day keeps the one copy.
    assert.equal(await svc.backup(owner.id), null);
  } finally {
    await t.close();
  }
});

test('a statement that runs too long is stopped without freezing TeamBot', async () => {
  const t = await startTestApp();
  try {
    const owner = t.app.ctx.auth.owner()!;
    const svc = svcOf(t);
    await svc.write(owner.id, [{ sql: "WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 500) INSERT INTO logboek (agent, wat) SELECT 'x', 'y' || i FROM c" }]);
    let ticks = 0;
    const iv = setInterval(() => ticks++, 20);
    const t0 = Date.now();
    await assert.rejects(
      svc.worker.call({ op: 'run', file: svc.file(owner.id), mode: 'query', sql: 'SELECT count(*) AS n FROM logboek a, logboek b, logboek c', params: [], maxRows: 10, maxChars: 1000, actor: 'agent:x', owners: {} }, 250),
      /duurde te lang/,
    );
    clearInterval(iv);
    assert.ok(Date.now() - t0 < 2000);
    assert.ok(ticks >= 5, 'the main thread kept running while the query ran');
    // The next statement runs on a fresh worker right away.
    const r = await svc.run(owner.id, { type: 'agent', id: 'x', name: 'x' }, 'SELECT COUNT(*) AS n FROM logboek', [], 'query');
    assert.equal(r.rows[0].n, 500);
    // (Windows keeps the file locked until the abandoned worker has finished.)
    await until(() => svc.worker.stuckCount === 0, 60_000);
    await sleep(10);
  } finally {
    await t.close();
  }
});
